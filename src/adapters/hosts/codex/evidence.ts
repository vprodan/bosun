import { BosunError } from '../../../core/errors.ts';
import { screenPublicText } from '../../../core/secret-screen.ts';
import type {
  ManagedSession,
  SessionEvidenceWindow,
  SessionEvidenceReference,
} from '../../../core/domain/session.ts';
import type { SummaryEvidence } from '../../../core/domain/summary.ts';

const failure = () => new BosunError('unverified', 'Codex evidence window unavailable');
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
// Only fully hydrated, idle owned turns reach this projection. Native tool
// payloads, reasoning, filenames and generated plans are never summary inputs.
export function captureCodexEvidence(
  session: ManagedSession,
  turns: Record<string, unknown>[],
  input: {
    afterCursor: string | null;
    cwd: string;
    seedHash: string;
    users: ReadonlyMap<string, { clientId: string; text: string }>;
  },
  hash: (value: string) => string,
): SessionEvidenceWindow {
  const digest = (text: string) => {
    const result = hash(text);
    if (!/^[a-f0-9]{64}$/.test(result)) throw failure();
    return result;
  };
  const sourceBindingHash = digest(
    JSON.stringify({ session, cwd: input.cwd, seedHash: input.seedHash }),
  );
  let chain = sourceBindingHash,
    total = 0,
    size = 0,
    windowSize = 0,
    found = input.afterCursor === null,
    full = false;
  let completedEventCursor = input.afterCursor;
  const evidence: SummaryEvidence[] = [],
    references: SessionEvidenceReference[] = [];
  const users = new Set<string>(),
    ids = new Set<string>();
  function emit(
    turnId: string,
    partId: string,
    kind: SessionEvidenceReference['kind'],
    body: string,
    chunk: number,
  ) {
    if (++total > 8192 || (size += Buffer.byteLength(body)) > 1024 * 1024) throw failure();
    const sha256 = digest(body),
      id = 'cx_' + digest(JSON.stringify([session, turnId, partId, kind, chunk]));
    chain = digest(chain + '\n' + JSON.stringify({ id, sha256 }));
    const cursor = 'e_' + String(total).padStart(8, '0') + '_' + chain;
    if (!found) {
      if (cursor === input.afterCursor) found = true;
      return;
    }
    if (!full && evidence.length < 100 && windowSize + Buffer.byteLength(body) <= 128 * 1024) {
      evidence.push({ privacy: 'public', id, cursor, text: body });
      references.push({ evidenceId: id, messageId: turnId, partId, kind, chunk, sha256 });
      completedEventCursor = cursor;
      windowSize += Buffer.byteLength(body);
    } else full = true;
  }
  function chunks(turnId: string, partId: string, kind: 'user' | 'assistant', value: unknown) {
    if (typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value) > 65536)
      throw failure();
    screenPublicText(value);
    let body = '',
      bytes = 0,
      chunk = 0;
    for (const character of value) {
      const n = Buffer.byteLength(character);
      if (bytes + n > 6144) {
        emit(turnId, partId, kind, body, chunk++);
        body = '';
        bytes = 0;
      }
      body += character;
      bytes += n;
    }
    if (body) emit(turnId, partId, kind, body, chunk);
  }
  for (const turn of turns) {
    if (turn.status !== 'completed' || !Array.isArray(turn.items) || typeof turn.id !== 'string')
      throw failure();
    for (const raw of turn.items) {
      if (!object(raw) || typeof raw.id !== 'string' || ids.has(raw.id)) throw failure();
      ids.add(raw.id);
      if (raw.type === 'userMessage') {
        if (
          typeof raw.clientId !== 'string' ||
          users.has(raw.clientId) ||
          !Array.isArray(raw.content) ||
          raw.content.length !== 1 ||
          !object(raw.content[0]) ||
          raw.content[0].type !== 'text'
        )
          throw failure();
        const admitted = input.users.get(raw.clientId);
        if (!admitted || raw.content[0].text !== admitted.text) throw failure();
        users.add(raw.clientId);
        chunks(turn.id, raw.id, 'user', admitted.text);
      } else if (raw.type === 'agentMessage') chunks(turn.id, raw.id, 'assistant', raw.text);
      else if (
        ['commandExecution', 'mcpToolCall', 'dynamicToolCall', 'fileChange'].includes(
          String(raw.type),
        )
      ) {
        if (raw.status !== 'completed') throw failure();
        const kind = raw.type === 'fileChange' ? 'file-reference' : 'tool-reference';
        emit(
          turn.id,
          raw.id,
          kind,
          `Native ${raw.type} has a completed receipt. Payload remains in source ${turn.id}/${raw.id}; inspect it before relying on its findings.`,
          0,
        );
      } else if (raw.type !== 'reasoning' && raw.type !== 'plan') throw failure();
    }
  }
  if (users.size !== input.users.size || !found) throw failure();
  const end = completedEventCursor === null ? 0 : Number(completedEventCursor.slice(2, 10));
  return {
    privacy: 'public',
    source: { ...session },
    coverage: 'admitted-public-text-and-native-references',
    afterCursor: input.afterCursor,
    completedEventCursor,
    sourceBindingHash,
    snapshotHash: chain,
    totalEvents: total,
    complete: end === total,
    evidence,
    references,
  };
}
