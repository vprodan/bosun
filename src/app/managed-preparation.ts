import crypto from 'node:crypto';
import { BosunError } from '../core/errors.ts';
import type { ManagedOwnership, HandoffSeed } from '../core/use-cases/handoff.ts';
import type { ManagedSessionDriver } from '../core/ports/host.ts';
import type { JobScope } from '../core/domain/job.ts';
import type { RuntimeConfig } from '../core/domain/config.ts';
import type { Env } from '../core/domain/inference.ts';
import type { RunEvent } from '../core/ports/runner.ts';
import type { HandoffFacts, HandoffBundle } from '../contracts/handoff.ts';
import type { createHandoffArtifacts } from './handoff.ts';
import type { createSummaryService } from './summary.ts';
import { createGitReviewSource } from '../adapters/review/git.ts';

const hash = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
const unavailable = () => new BosunError('unverified', 'Managed handoff evidence unavailable');
// This callback runs inside the existing handoff job. It reuses the summary
// runner implementation inline; it never enqueues and waits on its own executor.
export async function prepareManagedHandoff(options: {
  source: ManagedOwnership;
  control: ManagedSessionDriver;
  jobId: string;
  config: RuntimeConfig;
  env: Env;
  handoffs: ReturnType<typeof createHandoffArtifacts>;
  summaries: ReturnType<typeof createSummaryService>;
  signal: AbortSignal;
  usage: (event: Extract<RunEvent, { t: 'usage' }>) => void;
}): Promise<HandoffSeed> {
  const { source, control, signal } = options;
  if (!source.authorityArtifactId || !control.capture || source.phase !== 'fenced')
    throw unavailable();
  const scope: JobScope = { projectId: source.projectId, audience: 'owner' };
  const authority = options.handoffs.get(scope, source.authorityArtifactId).manifest.facts;
  if (
    authority.repository.projectId !== source.projectId ||
    authority.source.uncertainEffects.length ||
    authority.runningJobs.length
  )
    throw unavailable();
  const git = createGitReviewSource({ env: options.env });
  const before = (await git.capture({ privacy: 'public', base: 'HEAD' }, source.cwd, signal, false))
    .snapshot;
  if (before.root !== source.cwd || before.projectId !== source.projectId) throw unavailable();
  if (
    authority.repository.files.some(
      (file) => before.files.find((current) => current.path === file.path)?.sha256 !== file.sha256,
    )
  )
    throw unavailable();
  let afterCursor: string | null = null,
    parentId: string | null = null,
    bundle: HandoffBundle | undefined,
    snapshotHash: string | undefined,
    bindingHash: string | undefined;
  for (let window = 0; window < 32; window++) {
    signal.throwIfAborted();
    const captured = await control.capture(
      source.session,
      { privacy: 'public', afterCursor },
      signal,
    );
    if (
      JSON.stringify(captured.source) !== JSON.stringify(source.session) ||
      captured.afterCursor !== afterCursor ||
      !captured.evidence.length ||
      !captured.completedEventCursor ||
      captured.coverage !== 'admitted-public-text-and-native-references'
    )
      throw unavailable();
    if (
      snapshotHash !== undefined &&
      (snapshotHash !== captured.snapshotHash || bindingHash !== captured.sourceBindingHash)
    )
      throw unavailable();
    snapshotHash = captured.snapshotHash;
    bindingHash = captured.sourceBindingHash;
    const facts: HandoffFacts = {
      ...authority,
      parentId,
      source: {
        hostId: source.session.hostId as HandoffFacts['source']['hostId'],
        sessionId: source.session.sessionId,
        model: source.session.model,
        ...(source.bootstrap?.effort ? { effort: source.bootstrap.effort } : {}),
        generation: source.session.generation,
        access: source.session.access,
        completedEventCursor: captured.completedEventCursor,
        uncertainEffects: [],
        evidenceHash: snapshotHash,
        bindingHash,
      },
      repository: {
        ...authority.repository,
        branch: before.branch,
        commit: before.head,
        snapshot: {
          revision: before.revision,
          indexHash: before.indexHash,
          statusHash: before.statusHash,
          contentHash: before.contentHash,
        },
      },
    };
    const requestId =
      'mh_' +
      hash(
        JSON.stringify([
          options.jobId,
          source.session.generation,
          afterCursor,
          captured.completedEventCursor,
        ]),
      ).slice(0, 64);
    const model = options.config.providers[options.config.handoff.provider]?.model;
    if (!model) throw unavailable();
    let result: string | undefined;
    let windowUsage: Extract<RunEvent, { t: 'usage' }> | undefined;
    for await (const event of options.summaries.runner().run({
      privacy: 'public',
      prompt: JSON.stringify({
        privacy: 'public',
        requestId,
        facts,
        afterCursor,
        evidence: captured.evidence,
      }),
      cwd: source.cwd,
      access: 'read',
      model,
      signal,
    })) {
      if (event.t === 'usage') {
        if (windowUsage) throw unavailable();
        windowUsage = event;
      }
      if (event.t === 'done') {
        if (event.code !== 0 || result !== undefined) throw unavailable();
        result = event.result;
      }
    }
    if (!result) throw unavailable();
    // Include unavailable counters so one unknown window cannot manufacture a
    // complete total from only the windows whose providers reported usage.
    options.usage(windowUsage ?? { t: 'usage' });
    const pointer = JSON.parse(result).artifact;
    if (typeof pointer?.id !== 'string') throw unavailable();
    bundle = options.handoffs.get(scope, pointer.id);
    const repeated = await control.capture(
      source.session,
      { privacy: 'public', afterCursor },
      signal,
    );
    if (JSON.stringify(repeated) !== JSON.stringify(captured)) throw unavailable();
    const current = (
      await git.capture({ privacy: 'public', base: 'HEAD' }, source.cwd, signal, false)
    ).snapshot;
    if (current.revision !== before.revision) throw unavailable();
    afterCursor = captured.completedEventCursor;
    parentId = bundle.manifest.id;
    if (captured.complete) {
      if (bundle.markdown.length > 12000 || Buffer.byteLength(bundle.markdown) > 16384)
        throw unavailable();
      return { privacy: 'public', text: bundle.markdown, hash: hash(bundle.markdown) };
    }
  }
  throw unavailable();
}
