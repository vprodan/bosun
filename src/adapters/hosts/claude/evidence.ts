import { BosunError } from '../../../core/errors.ts';
import { requirePublicInput } from '../../../core/policy.ts';
import { screenPublicText } from '../../../core/secret-screen.ts';
import type { ManagedSession, SessionEvidenceReference, SessionEvidenceWindow } from '../../../core/domain/session.ts';
import { SUMMARY_LIMITS, type SummaryEvidence } from '../../../core/domain/summary.ts';
import { readClaudeTranscript, type ClaudeTranscriptBinding } from './transcript.ts';

const unavailable = () => new BosunError('unverified', 'Claude evidence window unavailable');
const cursorPattern = /^e_([0-9]{8})_([a-f0-9]{64})$/;
export type ClaudeEvidenceInput = {
  privacy: 'public'; afterCursor: string | null;
  seed: { privacy: 'public'; uuid: string; text: string };
  users: ReadonlyMap<string, { privacy: 'public'; text: string }>;
  // Trusted driver's completed native frame UUIDs, never caller/echo/export claims.
  completedAssistants: ReadonlySet<string>;
};

// Candidate public text projection only. Unknown tool/file/metadata histories
// are rejected by the retained reader, rather than silently omitted. Completion
// claims still require a qualified driver's fenced/idle native turn receipts;
// this function establishes no capability, quiescence or readiness by itself.
export function captureClaudeEvidence(
  session: ManagedSession,
  binding: ClaudeTranscriptBinding,
  input: ClaudeEvidenceInput,
  hash: (text: string) => string,
): SessionEvidenceWindow {
  requirePublicInput(input); requirePublicInput(input.seed);
  if (typeof input.seed.uuid !== 'string' || typeof input.seed.text !== 'string'
    || !input.seed.text.trim() || input.seed.text.includes('\0') || Buffer.byteLength(input.seed.text) > 16384
    || !(input.users instanceof Map) || input.users.size > 127
    || !(input.completedAssistants instanceof Set) || input.completedAssistants.size > 127) throw unavailable();
  for (const admitted of input.users.values()) requirePublicInput(admitted);
  if (input.afterCursor !== null && (typeof input.afterCursor !== 'string' || !cursorPattern.test(input.afterCursor))) throw unavailable();
  if (session.hostId !== 'claude' || session.sessionId !== binding.id
    || !['read', 'edit'].includes(session.access) || !Number.isSafeInteger(session.generation)
    || session.generation < 0) throw unavailable();
  for (const value of [session.ownerId, session.model]) {
    if (typeof value !== 'string' || !value || value.includes('\0') || Buffer.byteLength(value) > 256) throw unavailable();
    screenPublicText(value);
  }
  screenPublicText(input.seed.text);
  const digest = (value: string) => {
    const result = hash(value); if (!/^[a-f0-9]{64}$/.test(result)) throw unavailable(); return result;
  };
  const snapshot = readClaudeTranscript(binding), [seed] = snapshot.messages;
  if (seed.uuid !== input.seed.uuid || seed.role !== 'user' || seed.text !== input.seed.text
    || input.users.has(seed.uuid)) throw unavailable();
  const sourceBindingHash = digest(JSON.stringify({ session, cwd: binding.cwd,
    projectKey: binding.projectKey, fileDev: binding.dev.toString(), fileIno: binding.ino.toString(),
    seedUuid: seed.uuid, seedHash: digest(seed.text) }));
  let chain = sourceBindingHash, total = 0, windowBytes = 0, full = false,
    found = input.afterCursor === null, completedEventCursor = input.afterCursor;
  const evidence: SummaryEvidence[] = [], references: SessionEvidenceReference[] = [];
  const users = new Set<string>(), assistants = new Set<string>();
  function emit(messageId: string, kind: 'user' | 'assistant', body: string, chunk: number) {
    if (++total > 8192) throw unavailable();
    const sha256 = digest(body), partId = messageId + '_text';
    const id = 'cl_' + digest(JSON.stringify([session, messageId, partId, kind, chunk]));
    chain = digest(chain + '\n' + JSON.stringify({ id, sha256 }));
    const cursor = 'e_' + String(total).padStart(8, '0') + '_' + chain;
    if (!found) { if (cursor === input.afterCursor) found = true; return; }
    if (!full && evidence.length < SUMMARY_LIMITS.events && windowBytes + Buffer.byteLength(body) <= 128 * 1024) {
      evidence.push({ privacy: 'public', id, cursor, text: body });
      references.push({ evidenceId: id, messageId, partId, kind, chunk, sha256 });
      completedEventCursor = cursor; windowBytes += Buffer.byteLength(body);
    } else full = true;
  }
  for (const message of snapshot.messages.slice(1)) {
    if (message.role === 'user') {
      const admitted = input.users.get(message.uuid);
      requirePublicInput(admitted);
      if (!admitted || admitted.text !== message.text || users.has(message.uuid)) throw unavailable();
      users.add(message.uuid);
    } else {
      if (message.model !== session.model || !input.completedAssistants.has(message.uuid)) throw unavailable();
      assistants.add(message.uuid);
    }
    screenPublicText(message.text); // Complete text first, even beyond this window/cursor.
    if (!message.text.trim()) continue;
    let body = '', bytes = 0, chunk = 0;
    for (const character of message.text) {
      const size = Buffer.byteLength(character);
      if (bytes + size > 6144) { emit(message.uuid, message.role, body, chunk++); body = ''; bytes = 0; }
      body += character; bytes += size;
    }
    if (body) emit(message.uuid, message.role, body, chunk);
  }
  if (users.size !== input.users.size || assistants.size !== input.completedAssistants.size) throw unavailable();
  if (!found) throw new BosunError('conflict', 'Claude evidence cursor no longer matches source');
  const end = completedEventCursor === null ? 0 : Number(cursorPattern.exec(completedEventCursor)![1]);
  return { privacy: 'public', source: { ...session }, coverage: 'admitted-public-text-and-native-references',
    afterCursor: input.afterCursor, completedEventCursor, sourceBindingHash, snapshotHash: chain,
    totalEvents: total, complete: end === total, evidence, references };
}
