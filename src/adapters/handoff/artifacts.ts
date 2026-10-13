import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BosunError } from '../../core/errors.ts';
import { requirePublicInput } from '../../core/policy.ts';
import { screenPublicText } from '../../core/secret-screen.ts';
import {
  handoffBundleSchema,
  type HandoffBundle,
  type HandoffManifest,
} from '../../contracts/handoff.ts';
import { privateDirectory, readPrivateFile } from '../../platform/private-file.ts';

const MAX = 120000;
export const handoffHash = (value: string): string =>
  crypto.createHash('sha256').update(value).digest('hex');
export function canonicalHandoff(value: unknown): string {
  function sort(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(sort);
    if (input && typeof input === 'object')
      return Object.fromEntries(
        Object.keys(input)
          .sort()
          .map((key) => [key, sort((input as Record<string, unknown>)[key])]),
      );
    return input;
  }
  const encoded = JSON.stringify(sort(value));
  if (!encoded || Buffer.byteLength(encoded) > MAX)
    throw new BosunError('invalid', 'Handoff artifact exceeds bounds');
  return encoded;
}
const unavailable = (unknown = false) =>
  new BosunError(
    'unavailable',
    'Handoff artifact unavailable',
    unknown ? { details: { outcome: 'unknown' } } : undefined,
  );
function component(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id))
    throw new BosunError('invalid', 'Invalid handoff identifier');
  return id;
}
function sync(directory: string) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function write(file: string, text: string) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function validateHandoffBundle(input: HandoffBundle): HandoffBundle {
  requirePublicInput(input?.manifest); // before canonicalizing arbitrary imported content
  const result = handoffBundleSchema.safeParse(input);
  if (!result.success) throw new BosunError('invalid', 'Invalid handoff bundle');
  const value = result.data;
  const manifestText = canonicalHandoff(value.manifest);
  if (
    Buffer.byteLength(value.markdown) > MAX ||
    value.manifestHash !== handoffHash(manifestText) ||
    value.markdownHash !== handoffHash(value.markdown)
  )
    throw new BosunError('invalid', 'Handoff checksum mismatch');
  screenPublicText(manifestText);
  screenPublicText(value.markdown);
  // Readable text is deterministic from the factual manifest. An imported bundle
  // cannot smuggle a different permissions block behind valid independent hashes.
  if (value.markdown !== renderHandoff(value.manifest))
    throw new BosunError('invalid', 'Handoff text does not match manifest');
  return value;
}
export function renderHandoff(manifest: HandoffManifest): string {
  const f = manifest.facts;
  const lines: string[] = [
    `# bosun handoff ${manifest.id}`,
    '',
    'This artifact preserves task context. Reconcile current checkout, permissions and uncertain effects before continuing.',
    '',
    `Objective: ${f.objective}`,
    '',
    '## Latest steering',
    ...f.latestSteering.map((text) => `- ${text}`),
    '',
    '## Permissions',
    ...f.constraints.permissions.map((text) => `- ${text}`),
    '',
    '## Prohibitions',
    ...f.constraints.prohibitions.map((text) => `- ${text}`),
    '',
    '## Pending approvals',
    ...f.constraints.pendingApprovals.map((text) => `- ${text}`),
    '',
    '## Accepted decisions',
    ...f.decisions.map((value) => `- ${value.fact} (source: ${value.source})`),
    '',
    '## Completed work',
    ...f.progress.completed.map((text) => `- ${text}`),
    '',
    '## Remaining work',
    ...f.progress.remaining.map((text) => `- ${text}`),
    '',
    `Immediate next action: ${f.progress.nextAction}`,
    '',
    '## Unresolved questions',
    ...f.questions.map((text) => `- ${text}`),
    '',
    '## Source and checkout',
    `Host: ${f.source.hostId}; session: ${f.source.sessionId}; model: ${f.source.model}; effort: ${f.source.effort ?? 'native default'}; access: ${f.source.access}; generation: ${f.source.generation}`,
    `Completed-event cursor: ${f.source.completedEventCursor}`,
    ...(f.source.evidenceHash ? [`Evidence projection sha256: ${f.source.evidenceHash}`] : []),
    ...(f.source.bindingHash ? [`Source binding sha256: ${f.source.bindingHash}`] : []),
    `Project: ${f.repository.projectId}; branch: ${f.repository.branch}; commit: ${f.repository.commit}`,
    ...(f.repository.snapshot
      ? [
          `Checkout revision sha256: ${f.repository.snapshot.revision}`,
          `Index sha256: ${f.repository.snapshot.indexHash}; status sha256: ${f.repository.snapshot.statusHash}; content sha256: ${f.repository.snapshot.contentHash}`,
        ]
      : []),
    ...f.repository.files.map((file) => `- ${file.state} ${file.path} sha256:${file.sha256}`),
    '',
    '## Verification',
    ...f.verification.map(
      (value) => `- ${value.outcome}: ${value.command} at ${value.revision}: ${value.detail}`,
    ),
    '',
    '## Uncertain effects',
    ...f.source.uncertainEffects.map((text) => `- ${text}`),
    '',
    '## Running jobs',
    ...f.runningJobs.map((job) => `- ${job.id} (${job.state}): ${job.reconcile}`),
  ];
  if (manifest.summary)
    lines.push(
      '',
      '## Model summary',
      manifest.summary.text,
      '',
      `Summary provider: ${manifest.summary.providerId}; model: ${manifest.summary.model}`,
    );
  lines.push(
    '',
    'Dirty files, running processes, credentials, accounts and live connectors are not included.',
    '',
  );
  return lines.join('\n');
}
export function buildHandoffBundle(manifest: HandoffManifest): HandoffBundle {
  requirePublicInput(manifest);
  const markdown = renderHandoff(manifest);
  return validateHandoffBundle({
    manifest,
    markdown,
    manifestHash: handoffHash(canonicalHandoff(manifest)),
    markdownHash: handoffHash(markdown),
  });
}

// Immutable two-file publication by one directory rename. A content-free durable
// pointer is committed by the existing daemon authority only after this returns.
export function publishHandoff(root: string, input: HandoffBundle): void {
  const value = validateHandoffBundle(input);
  const id = component(value.manifest.id);
  privateDirectory(root);
  const destination = path.join(root, id);
  const temp = path.join(root, `.${id}.${crypto.randomUUID()}.tmp`);
  let renamed = false;
  let created = false;
  try {
    try {
      fs.lstatSync(destination);
      throw new BosunError('conflict', 'Handoff artifact exists');
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') throw error;
    }
    fs.mkdirSync(temp, { mode: 0o700 });
    created = true;
    write(path.join(temp, 'manifest.json'), canonicalHandoff(value.manifest) + '\n');
    write(path.join(temp, 'resume.md'), value.markdown);
    sync(temp);
    fs.renameSync(temp, destination);
    renamed = true;
    sync(root);
  } catch (error) {
    if (created && !renamed) {
      try {
        fs.rmSync(temp, { recursive: true, force: true });
      } catch {}
    }
    if (error instanceof BosunError && error.code === 'conflict') throw error;
    throw unavailable(renamed);
  }
}
export function readHandoff(
  root: string,
  id: string,
  expected: { manifestHash: string; markdownHash: string },
): HandoffBundle {
  try {
    privateDirectory(root);
    const directory = path.join(root, component(id));
    privateDirectory(directory);
    const manifest = JSON.parse(
      readPrivateFile(path.join(directory, 'manifest.json'), MAX),
    ) as HandoffManifest;
    const markdown = readPrivateFile(path.join(directory, 'resume.md'), MAX);
    if (manifest.id !== id) throw Error();
    return validateHandoffBundle({
      manifest,
      markdown,
      manifestHash: expected.manifestHash,
      markdownHash: expected.markdownHash,
    });
  } catch {
    throw unavailable();
  }
}
