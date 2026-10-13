import { createHash } from 'node:crypto';
import type { ManagedSession, SessionEvidenceWindow, SessionEvidenceReference } from '../../../core/domain/session.ts';
import type { SummaryEvidence } from '../../../core/domain/summary.ts';
import { SUMMARY_LIMITS } from '../../../core/domain/summary.ts';
import { screenPublicText } from '../../../core/secret-screen.ts';
import { object, identifier, text, OMP_LIMITS, ompFailure } from './protocol.ts';
import { OMP_ADMISSION_ENTRY, OMP_BRIDGE_ENTRY, OMP_SEED_ENTRY } from './managed-bridge.ts';

export type OmpHistory = { entries: Record<string, unknown>[]; leafId: string | null };
export type OmpPublicSource = {
  seedHash: string | null; turns: ReadonlyMap<string, string>;
  controls: ReadonlyMap<string, string>; binding: string;
};
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export function decodeOmpHistory(value: unknown): OmpHistory {
  if (!object(value) || !Array.isArray(value.entries) || value.entries.length > OMP_LIMITS.entries
    || value.leafId !== null && !identifier(value.leafId)) throw ompFailure('unavailable', true);
  const ids = new Set<string>();
  const entries = value.entries.map(entry => {
    if (!object(entry) || !identifier(entry.id) || !identifier(entry.type, 80) || ids.has(entry.id))
      throw ompFailure('unavailable', true);
    ids.add(entry.id);
    return entry;
  });
  if (value.leafId !== null && !ids.has(value.leafId as string)) throw ompFailure('unavailable', true);
  return { entries, leafId: value.leafId as string | null };
}
export function ompMessageText(message: Record<string, unknown>): string {
  if (typeof message.content === 'string') {
    if (!text(message.content, OMP_LIMITS.textBytes)) throw ompFailure('unavailable', true);
    return message.content;
  }
  if (!Array.isArray(message.content) || message.content.length > 256) throw ompFailure('unavailable', true);
  let result = '';
  for (const part of message.content) {
    if (!object(part) || typeof part.type !== 'string') throw ompFailure('unavailable', true);
    if (part.type !== 'text') {
      if (message.role === 'user') throw ompFailure('unavailable', true);
      continue;
    }
    if (!text(part.text, OMP_LIMITS.textBytes)) throw ompFailure('unavailable', true);
    result += part.text;
    if (Buffer.byteLength(result) > OMP_LIMITS.textBytes) throw ompFailure('unavailable', true);
  }
  return result;
}
export function admittedOmpEntries(history: OmpHistory, source: OmpPublicSource): Record<string, unknown>[] {
  const admitted: Record<string, unknown>[] = [];
  let pendingUser: string | undefined;
  let seeds = 0;
  const turns = new Set<string>();
  const controls = new Set<string>();
  for (const entry of history.entries) {
    if (entry.type === 'custom') {
      if (entry.customType === OMP_BRIDGE_ENTRY) {
        if (!object(entry.data) || entry.data.privacy !== 'public' || !identifier(entry.data.id)
          || controls.has(entry.data.id) || source.controls.get(entry.data.id) !== digest(JSON.stringify(entry.data)))
          throw ompFailure('unavailable', true);
        controls.add(entry.data.id); continue;
      }
      if (entry.customType !== OMP_ADMISSION_ENTRY || !object(entry.data) || entry.data.privacy !== 'public'
        || !identifier(entry.data.turnId) || !identifier(entry.data.hash) || pendingUser
        || Object.keys(entry.data).some(key => !['privacy', 'turnId', 'hash'].includes(key))
        || turns.has(entry.data.turnId) || source.turns.get(entry.data.turnId) !== entry.data.hash)
        throw ompFailure('unavailable', true);
      turns.add(entry.data.turnId); pendingUser = entry.data.hash;
      continue;
    }
    if (entry.type === 'custom_message') {
      if (++seeds !== 1 || entry.customType !== OMP_SEED_ENTRY || entry.display !== false
        || !object(entry.details) || entry.details.privacy !== 'public' || entry.details.hash !== source.seedHash
        || Object.keys(entry.details).some(key => !['privacy', 'hash'].includes(key))
        || typeof entry.content !== 'string' || digest(entry.content) !== source.seedHash)
        throw ompFailure('unavailable', true);
      screenPublicText(entry.content); admitted.push(entry); continue;
    }
    if (entry.type === 'message') {
      if (!object(entry.message) || !['user', 'assistant', 'toolResult'].includes(String(entry.message.role)))
        throw ompFailure('unavailable', true);
      if (entry.message.role === 'user') {
        const body = ompMessageText(entry.message);
        if (!pendingUser || digest(body) !== pendingUser) throw ompFailure('unavailable', true);
        screenPublicText(body); pendingUser = undefined;
      } else if (entry.message.role === 'assistant') screenPublicText(ompMessageText(entry.message));
      admitted.push(entry); continue;
    }
    if (!['model_change', 'thinking_level_change'].includes(String(entry.type)))
      throw ompFailure('unavailable', true);
  }
  if (pendingUser || source.seedHash !== null && seeds !== 1 || turns.size !== source.turns.size
    || controls.size !== source.controls.size || admitted.length > SUMMARY_LIMITS.events)
    throw ompFailure('unavailable', true);
  return admitted;
}
export function captureOmpEvidence(session: ManagedSession, history: OmpHistory, source: OmpPublicSource,
  afterCursor: string | null): SessionEvidenceWindow {
  const entries = admittedOmpEntries(history, source);
  const cursorIndex = afterCursor === null ? -1 : entries.findIndex(entry => entry.id === afterCursor);
  if (afterCursor !== null && cursorIndex < 0) throw ompFailure('invalid');
  const evidence: SummaryEvidence[] = [];
  const references: SessionEvidenceReference[] = [];
  for (const entry of entries.slice(cursorIndex + 1)) {
    const message = entry.type === 'custom_message' ? { role: 'user', content: entry.content } : entry.message;
    if (!object(message)) throw ompFailure('unavailable', true);
    const messageId = String(entry.id), kind = message.role === 'user' ? 'user' : 'assistant';
    if (message.role === 'toolResult') {
      if (!identifier(message.toolCallId)) throw ompFailure('unavailable', true);
      references.push({ evidenceId: 'omp_' + digest(messageId).slice(0, 24), messageId, partId: message.toolCallId,
        chunk: 0, kind: 'tool-reference', sha256: digest(JSON.stringify([messageId, message.toolCallId])) });
      continue;
    }
    const parts = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
    if (!Array.isArray(parts)) throw ompFailure('unavailable', true);
    for (const [position, part] of parts.entries()) {
      if (!object(part)) throw ompFailure('unavailable', true);
      if (part.type !== 'text') {
        if (part.type === 'toolCall' && identifier(part.id)) references.push({ evidenceId: 'omp_' + digest(messageId + ':' + position).slice(0, 24),
          messageId, partId: 'content.' + position, chunk: 0, kind: 'tool-reference', sha256: digest(JSON.stringify([messageId, position, part.id])) });
        continue;
      }
      if (typeof part.text !== 'string') throw ompFailure('unavailable', true);
      for (let offset = 0, chunk = 0; offset < part.text.length; chunk++) {
        let end = Math.min(offset + 2000, part.text.length);
        const last = part.text.charCodeAt(end - 1);
        if (end < part.text.length && last >= 0xd800 && last <= 0xdbff) end--;
        const body = part.text.slice(offset, end), id = 'omp_' + digest(messageId + ':' + position + ':' + chunk).slice(0, 24);
        evidence.push({ privacy: 'public', id, cursor: messageId, text: body });
        references.push({ evidenceId: id, messageId, partId: 'content.' + position, chunk, kind, sha256: digest(body) });
        offset = end;
      }
    }
  }
  if (evidence.length > SUMMARY_LIMITS.events || Buffer.byteLength(JSON.stringify(evidence)) > OMP_LIMITS.sourceBytes)
    throw ompFailure('unavailable', true);
  const completedEventCursor = entries.length ? String(entries.at(-1)!.id) : null;
  return { privacy: 'public', source: { ...session }, coverage: 'admitted-public-text-and-native-references', afterCursor,
    completedEventCursor, snapshotHash: digest(JSON.stringify(entries)), sourceBindingHash: source.binding,
    totalEvents: entries.length, complete: true, evidence, references };
}
