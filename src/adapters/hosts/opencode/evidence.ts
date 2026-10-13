import { BosunError } from '../../../core/errors.ts';
import { requirePublicInput } from '../../../core/policy.ts';
import { screenPublicText } from '../../../core/secret-screen.ts';
import type {
  ManagedSession,
  SessionEvidenceWindow,
  SessionEvidenceReference,
} from '../../../core/domain/session.ts';
import type { SummaryEvidence } from '../../../core/domain/summary.ts';
import { SUMMARY_LIMITS } from '../../../core/domain/summary.ts';
import { own, object, string } from './v2-native.ts';

export const OPENCODE_EVIDENCE_LIMITS = Object.freeze({
  sourceBytes: 16 * 1024 * 1024,
  messages: 128,
  events: 8192,
  windowBytes: 128 * 1024,
  chunkBytes: 6144,
});
const invalid = () => new BosunError('unverified', 'OpenCode evidence window unavailable');
const cursorPattern = /^e_([0-9]{8})_([a-f0-9]{64})$/;
export function evidenceCursor(input: {
  privacy: 'public';
  afterCursor: string | null;
}): string | null {
  requirePublicInput(input);
  if (Reflect.ownKeys(input).some((key) => key !== 'privacy' && key !== 'afterCursor'))
    throw invalid();
  const after = own(input, 'afterCursor');
  if (after !== null && (typeof after !== 'string' || !cursorPattern.test(after))) throw invalid();
  return after as string | null;
}
// Rows have passed the driver's owned-session/model/part/history checks. Never
// read reasoning, tool inputs/outputs, filenames/URLs, signed metadata or native
// snapshot/patch payloads. Retain native references instead of transferring them.
export function captureOpenCodeEvidence(
  session: ManagedSession,
  rows: readonly Record<string, any>[],
  afterCursor: string | null,
  hash: (text: string) => string,
  binding: { cwd: string; association: string; seed?: { key: string; text: string; hash: string } },
): SessionEvidenceWindow {
  if (rows.length > OPENCODE_EVIDENCE_LIMITS.messages) throw invalid();
  const digest = (text: string) => {
    const result = hash(text);
    if (!/^[a-f0-9]{64}$/.test(result)) throw invalid();
    return result;
  };
  const sourceBindingHash = digest(
    JSON.stringify({ session, cwd: binding.cwd, association: binding.association,
      seed: binding.seed ? { key: binding.seed.key, hash: binding.seed.hash } : undefined }),
  );
  let chain = sourceBindingHash;
  let total = 0,
    bytes = 0,
    windowBytes = 0,
    found = afterCursor === null,
    full = false;
  const evidence: SummaryEvidence[] = [],
    references: SessionEvidenceReference[] = [];
  let completedEventCursor = afterCursor;
  function emit(
    messageId: string,
    partId: string,
    kind: SessionEvidenceReference['kind'],
    text: string,
    chunk: number,
  ) {
    if (++total > OPENCODE_EVIDENCE_LIMITS.events) throw invalid();
    bytes += Buffer.byteLength(text);
    if (bytes > OPENCODE_EVIDENCE_LIMITS.sourceBytes) throw invalid();
    const sha256 = digest(text);
    const id =
      'oc_' + digest(JSON.stringify([session, messageId, partId, kind, chunk])).slice(0, 64);
    chain = digest(chain + '\n' + JSON.stringify({ id, sha256 }));
    const cursor = 'e_' + String(total).padStart(8, '0') + '_' + chain;
    if (!found) {
      if (cursor === afterCursor) found = true;
      return;
    }
    if (
      !full &&
      evidence.length < SUMMARY_LIMITS.events &&
      windowBytes + Buffer.byteLength(text) <= OPENCODE_EVIDENCE_LIMITS.windowBytes
    ) {
      evidence.push({ privacy: 'public', id, cursor, text });
      references.push({ evidenceId: id, messageId, partId, kind, chunk, sha256 });
      completedEventCursor = cursor;
      windowBytes += Buffer.byteLength(text);
    } else full = true;
  }
  function textParts(messageId: string, partId: string, kind: 'user' | 'assistant', text: unknown) {
    if (
      typeof text !== 'string' ||
      text.includes('\0') ||
      Buffer.byteLength(text) > OPENCODE_EVIDENCE_LIMITS.sourceBytes
    )
      throw invalid();
    screenPublicText(text); // Whole text first: chunks cannot split credential patterns.
    if (!text.trim()) return;
    let part = '',
      size = 0,
      chunk = 0;
    for (const char of text) {
      const n = Buffer.byteLength(char);
      if (size + n > OPENCODE_EVIDENCE_LIMITS.chunkBytes) {
        emit(messageId, partId, kind, part, chunk++);
        part = '';
        size = 0;
      }
      part += char;
      size += n;
    }
    if (part) emit(messageId, partId, kind, part, chunk);
  }
  const allowed = new Set([
    'read',
    'glob',
    'grep',
    ...(session.access === 'edit' ? ['edit', 'write', 'patch'] : []),
  ]);
  if (binding.seed) {
    if (!/^[a-z0-9][a-z0-9._-]{0,199}$/.test(binding.seed.key) || digest(binding.seed.text) !== binding.seed.hash) throw invalid();
    // This is the exact native API instruction entry, not an invented user message.
    textParts('api_' + binding.seed.key, 'value', 'user', binding.seed.text);
  }
  for (const row of rows) {
    // Explicit private/unknown classification is never upgraded by parent scope.
    if (own(row, 'privacy') !== undefined && own(row, 'privacy') !== 'public') throw invalid();
    const messageId = own(row, 'id'), type = own(row, 'type');
    if (!string(messageId, 200)) throw invalid();
    if (type === 'idle') {
      if (own(row, 'outcome') !== 'succeeded' || own(row, 'error') !== undefined) throw invalid();
      continue;
    }
    if (type === 'user') {
      textParts(messageId, 'text', 'user', own(row, 'text'));
      // Native attachments are never duplicated into model payloads.
      const files = own(row, 'files');
      if (files !== undefined) {
        if (!Array.isArray(files) || files.length > 256) throw invalid();
        files.forEach((_, i) => emit(messageId, 'file_' + i, 'file-reference',
          `Native file reference ${messageId}/file_${i} remains in the source; its payload was not transferred.`, 0));
      }
      continue;
    }
    if (type !== 'assistant') throw invalid();
    if (
      own(row, 'error') !== undefined ||
        object(own(row, 'time'))?.completed === undefined
    )
      throw invalid();
    const parts = own(row, 'content');
    if (!Array.isArray(parts) || parts.length > 256) throw invalid();
    for (const [index, raw] of parts.entries()) {
      const part = object(raw);
      if (!part) throw invalid();
      const privacy = own(part, 'privacy');
      if (privacy !== undefined && privacy !== 'public') throw invalid();
      const partId = 'content_' + index, type = own(part, 'type');
      if (type === 'text') {
        if (own(part, 'ignored') === true || own(part, 'synthetic') === true) throw invalid();
        textParts(messageId, partId, 'assistant', own(part, 'text'));
      } else if (type === 'tool') {
        const state = object(own(part, 'state'));
        const tool = own(part, 'name');
        if (
          !state ||
          own(state, 'status') !== 'completed' ||
          typeof tool !== 'string' ||
          !allowed.has(tool)
        )
          throw invalid();
        emit(
          messageId,
          partId,
          'tool-reference',
          `Native ${tool} tool has a completed receipt. Its payload remains in source ${messageId}/${partId}; inspect it before relying on its findings.`,
          0,
        );
      } else if (type !== 'reasoning')
        throw invalid();
    }
  }
  if (!found) throw new BosunError('conflict', 'OpenCode evidence cursor no longer matches source');
  const end =
    completedEventCursor === null ? 0 : Number(cursorPattern.exec(completedEventCursor)![1]);
  return {
    privacy: 'public',
    source: { ...session },
    coverage: 'admitted-public-text-and-native-references',
    afterCursor,
    completedEventCursor,
    snapshotHash: chain,
    sourceBindingHash,
    totalEvents: total,
    complete: end === total,
    evidence,
    references,
  };
}
