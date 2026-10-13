// OpenCode 2.0.27, source bcf23b6775c79a429b1511b255d6d88ab0248d4a.
// Metadata subset of packages/protocol/openapi.json; never accept V1 envelopes.
import crypto from 'node:crypto';
import path from 'node:path';
import { BosunError } from '../../../core/errors.ts';
import { requirePublicInput } from '../../../core/policy.ts';
import { screenPublicText } from '../../../core/secret-screen.ts';
import type { InputPrivacy } from '../../../core/domain/inference.ts';
import type { ContextSample } from '../../../core/domain/session.ts';
import type { ManagedCapability } from '../../../core/ports/host.ts';
import { OPENCODE2_VERSION } from '../../../core/domain/host-install.ts';

export const OPENCODE2_SOURCE = 'bcf23b6775c79a429b1511b255d6d88ab0248d4a';
export const OPENCODE2_MANAGED_CAPS: Readonly<Record<Exclude<ManagedCapability, 'isolatedBootstrapTurn'>, 'unverified'>> =
  Object.freeze({
    contextTelemetry: 'unverified', promptAdmission: 'unverified', toolQuiescence: 'unverified',
    freshSession: 'unverified', seedWithoutInference: 'unverified', freshReadiness: 'unverified',
  });
export type PublicContext = { privacy: InputPrivacy };
export type ModelSelection = { providerID: string; modelID: string; variant?: string };
type Tokens = { input: number; output: number; reasoning: number; cache: { read: number; write: number } };
export type SessionMetadata = {
  id: string; parentID?: string; created: number; updated: number; selection?: ModelSelection;
  reset: boolean; bindingHash: string;
};
const MESSAGE_TYPES = ['agent-switched', 'model-switched', 'location-switched', 'user', 'synthetic',
  'system', 'skill', 'shell', 'assistant', 'compaction', 'idle'] as const;
type MessageType = typeof MESSAGE_TYPES[number];
export type MessageMetadata = {
  id: string; sessionID: string; type: MessageType; created: number; completed?: number;
  selection?: ModelSelection; tokens?: Tokens; pendingTools: number; failed: boolean;
  outcome?: 'succeeded' | 'failed' | 'interrupted';
};
const invalid = (): never => { throw new BosunError('invalid', 'Invalid OpenCode 2 protocol response'); };
const unsupported = (): never => { throw new BosunError('unsupported', 'OpenCode 2 metadata unsupported'); };
const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const text = (value: unknown, max = 200): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
function id(value: unknown, prefix: 'ses_' | 'msg_'): string {
  if (!text(value) || !value.startsWith(prefix) || !/^[A-Za-z0-9_-]+$/.test(value)) return invalid();
  return value;
}
function selection(value: unknown, native = false): ModelSelection {
  const model = object(value), modelID = native ? model?.id : model?.modelID;
  if (!model || !text(model.providerID) || !text(modelID) ||
    (model.variant !== undefined && !text(model.variant))) return invalid();
  return { providerID: model.providerID, modelID,
    ...(model.variant !== undefined ? { variant: model.variant as string } : {}) };
}
const sameSelection = (a: ModelSelection | undefined, b: ModelSelection) =>
  a?.providerID === b.providerID && a.modelID === b.modelID && a.variant === b.variant;
function tokens(value: unknown): Tokens {
  const t = object(value), cache = object(t?.cache);
  // Native Finite fields are conservatively restricted to safe, nonnegative counts.
  if (!t || !cache || ![t.input, t.output, t.reasoning, cache.read, cache.write].every(integer)) return invalid();
  return { input: t.input as number, output: t.output as number, reasoning: t.reasoning as number,
    cache: { read: cache.read as number, write: cache.write as number } };
}
function data(value: unknown): unknown {
  const envelope = object(value);
  if (!envelope || !Object.hasOwn(envelope, 'data')) return invalid();
  return envelope.data;
}
export function decodeServerInfo(value: unknown) {
  const info = object(value);
  if (!info || typeof info.version !== 'string') return invalid();
  if (info.version !== OPENCODE2_VERSION)
    throw new BosunError('unsupported', 'OpenCode 2 protocol version is not pinned');
  if (!integer(info.pid) || info.pid < 1 || !Array.isArray(info.urls) || info.urls.length > 32 ||
    !info.urls.every((url) => text(url, 2048)) || !text(object(info.paths)?.tmp, 4096)) return invalid();
  // URLs/paths/capabilities are neither discovery instructions nor qualified controls.
  return { hostId: 'opencode' as const, version: OPENCODE2_VERSION, pid: info.pid };
}
export function decodeSession(value: unknown, context: PublicContext): SessionMetadata {
  requirePublicInput(context);
  const session = object(data(value)), time = object(session?.time), location = object(session?.location);
  if (!session || !time || !location || !text(session.projectID) || !text(location.directory, 4096) ||
    !path.isAbsolute(location.directory) || !integer(time.created) || !integer(time.updated) || time.updated < time.created ||
    (session.agent !== undefined && !text(session.agent)) ||
    (time.idle !== undefined && !integer(time.idle)) ||
    (time.archived !== undefined && !integer(time.archived)) ||
    (session.outcome !== undefined && !['succeeded', 'failed', 'interrupted'].includes(String(session.outcome)))) return invalid();
  const sessionID = id(session.id, 'ses_');
  const parentID = session.parentID === undefined ? undefined : id(session.parentID, 'ses_');
  const chosen = session.model === undefined ? undefined : selection(session.model, true);
  // Opaque binding detects scope/model/rule drift without exposing paths, titles,
  // arbitrary metadata, provider state or cumulative billing/usage.
  const bindingHash = crypto.createHash('sha256').update(JSON.stringify([
    sessionID, parentID, session.projectID, location.directory, session.agent, chosen,
    time.created, time.updated, time.idle, time.archived, session.outcome, session.fork, session.revert, session.permissions,
  ])).digest('hex');
  return { id: sessionID, ...(parentID === undefined ? {} : { parentID }),
    created: time.created, updated: time.updated, ...(chosen ? { selection: chosen } : {}),
    reset: session.fork !== undefined || session.revert !== undefined || time.archived !== undefined, bindingHash };
}
function message(value: unknown, sessionID: string): MessageMetadata {
  const row = object(value), time = object(row?.time);
  if (!row || !time || !integer(time.created) || !MESSAGE_TYPES.includes(row.type as MessageType)) return invalid();
  const type = row.type as MessageType;
  const result: MessageMetadata = {
    id: id(row.id, 'msg_'), sessionID, type, created: time.created, pendingTools: 0, failed: row.error !== undefined,
  };
  // V2 projected messages have no native sessionID. The caller binds the exact
  // session URL; reject a conflicting extra field rather than treating it as proof.
  if (row.sessionID !== undefined && row.sessionID !== sessionID) return invalid();
  if (type === 'model-switched') result.selection = selection(row.model, true);
  if (type === 'idle') {
    if (!['succeeded', 'failed', 'interrupted'].includes(String(row.outcome))) return invalid();
    result.outcome = row.outcome as MessageMetadata['outcome'];
  }
  if (type === 'assistant') {
    if (!text(row.agent) || !Array.isArray(row.content) || row.content.length > 256 ||
      (time.completed !== undefined && (!integer(time.completed) || time.completed < time.created)) ||
      (time.streamed !== undefined && (!integer(time.streamed) || time.streamed < time.created ||
        (time.completed !== undefined && time.streamed > time.completed)))) return invalid();
    result.selection = selection(row.model, true);
    if (time.completed !== undefined) result.completed = time.completed as number;
    if (row.tokens !== undefined) result.tokens = tokens(row.tokens);
    if (row.finish !== undefined && !['stop', 'length', 'tool-calls', 'content-filter', 'error', 'unknown'].includes(String(row.finish))) return invalid();
    result.failed ||= row.finish === 'error' || row.finish === 'content-filter' || row.finish === 'length' || row.retry !== undefined;
    for (const raw of row.content) {
      const content = object(raw);
      if (!content || !['text', 'reasoning', 'tool'].includes(String(content.type))) return invalid();
      if (content.type !== 'tool') continue; // Never read text/reasoning/provider state.
      const state = object(content.state);
      if (!state || !['streaming', 'running', 'completed', 'error'].includes(String(state.status))) return invalid();
      if (state.status === 'streaming' || state.status === 'running') result.pendingTools++;
      if (state.status === 'error') result.failed = true;
    }
  }
  return result;
}
export function decodeMessagePage(value: unknown, sessionID: string, context: PublicContext) {
  requirePublicInput(context);
  id(sessionID, 'ses_');
  const envelope = object(value), rows = data(value), cursor = object(envelope?.cursor);
  if (!Array.isArray(rows) || rows.length > 128 || !cursor) return invalid();
  const readCursor = (value: unknown) => {
    if (value === undefined || value === null) return null;
    if (!text(value, 2048)) return invalid();
    return value;
  };
  const messages = rows.map((row) => message(row, sessionID));
  if (new Set(messages.map((row) => row.id)).size !== messages.length) return invalid();
  return { messages, previousCursor: readCursor(cursor.previous), nextCursor: readCursor(cursor.next) };
}
export function decodeActive(value: unknown, sessionID: string, context: PublicContext) {
  requirePublicInput(context);
  id(sessionID, 'ses_');
  const active = object(data(value));
  if (!active || Object.keys(active).length > 4096) return invalid();
  for (const [key, raw] of Object.entries(active)) {
    id(key, 'ses_');
    if (object(raw)?.type !== 'running') return invalid();
  }
  // Inactive means no foreground drain in this server process, NOT tool quiescence.
  return { running: Object.hasOwn(active, sessionID), scope: 'server-process-foreground' as const };
}
export function contextCandidate(session: SessionMetadata, messages: MessageMetadata[], options: {
  now: number; generation: number; selection: ModelSelection; resetAfter?: number; running: boolean;
}) {
  if (!integer(options.now) || !integer(options.generation) || typeof options.running !== 'boolean' ||
    (options.resetAfter !== undefined && !integer(options.resetAfter))) return invalid();
  const chosen = selection(options.selection), sessionID = id(session.id, 'ses_');
  // Native order=desc is projection sequence order, not timestamp order. Preserve
  // the page order; clock skew must not reorder inputs or control/idle markers.
  if (messages.length > 128 || messages.some((row) => row.sessionID !== sessionID)) return invalid();
  const sample: ContextSample = {
    sessionId: sessionID, turnId: '', modelId: `${chosen.providerID}/${chosen.modelID}`,
    usedTokens: null, windowTokens: null, scope: 'unknown', quality: 'unknown',
    observedAt: options.now, generation: options.generation,
  };
  const unknown = (reason: string) => ({ sample, candidateInputTokens: null, reason });
  if (!sameSelection(session.selection, chosen)) return unknown('model_changed');
  if (session.reset) return unknown('reset_or_control_changed');
  if (options.running) return unknown('turn_in_progress');
  const idle = messages[0];
  if (!idle) return unknown('no_completed_turn');
  if (idle.type !== 'idle') return unknown('turn_in_progress');
  sample.turnId = idle.id;
  if (idle.outcome !== 'succeeded' || idle.failed) return unknown('reset_or_failed_turn');
  if (idle.created > options.now || options.now - idle.created > 30_000) return unknown('stale_or_future');
  if (options.resetAfter !== undefined && idle.created <= options.resetAfter) return unknown('reset_without_new_turn');
  const previous = messages.findIndex((row, index) => index > 0 && row.type === 'idle');
  const turn = messages.slice(1, previous < 0 ? undefined : previous);
  if (turn.some((row) => row.created > idle.created || row.created > options.now)) return unknown('stale_or_future');
  if (turn.some((row) => ['compaction', 'model-switched', 'agent-switched', 'location-switched'].includes(row.type)))
    return unknown('reset_or_control_changed');
  if (turn.some((row) => row.pendingTools || (row.type === 'assistant' && row.completed === undefined)))
    return unknown('turn_in_progress');
  if (turn.some((row) => row.failed)) return unknown('reset_or_failed_turn');
  const latest = turn.find((row) => row.type === 'assistant');
  if (!latest) return unknown('missing_usage');
  if (!sameSelection(latest.selection, chosen) || turn.some((row) => row.selection && !sameSelection(row.selection, chosen)))
    return unknown('model_changed');
  if (latest.completed! > idle.created || latest.completed! > options.now ||
    options.now - latest.completed! > 30_000) return unknown('stale_or_future');
  if (options.resetAfter !== undefined && latest.created <= options.resetAfter) return unknown('reset_without_new_turn');
  if (!latest.tokens) return unknown('missing_usage');
  // V2 SessionUsage.tokens records noncached input separately. Recombine once;
  // session totals, visible output/reasoning and older assistants are not occupancy.
  const candidateInputTokens = latest.tokens.input + latest.tokens.cache.read + latest.tokens.cache.write;
  if (!integer(candidateInputTokens)) return invalid();
  return { sample, candidateInputTokens, reason: 'active_total_unverified' };
}
export function probeParameters(input: PublicContext & {
  sessionID: string; selection: ModelSelection; generation: number; resetAfter?: number;
}) {
  requirePublicInput(input);
  if (!integer(input.generation) || (input.resetAfter !== undefined && !integer(input.resetAfter))) return invalid();
  return { sessionID: id(input.sessionID, 'ses_'), selection: selection(input.selection),
    generation: input.generation, resetAfter: input.resetAfter };
}
// Pure recipes only. The probe never creates sessions, admits inputs or starts inference.
export function freshRootRequest(input: PublicContext & { selection: ModelSelection; cwd: string; agent: string }) {
  requirePublicInput(input);
  const chosen = selection(input.selection);
  if (!text(input.cwd, 4096) || !path.isAbsolute(input.cwd) || path.resolve(input.cwd) !== input.cwd || !text(input.agent)) return invalid();
  return { method: 'POST' as const, path: '/api/session', body: {
    location: { directory: input.cwd }, agent: input.agent,
    model: { id: chosen.modelID, providerID: chosen.providerID,
      ...(chosen.variant !== undefined ? { variant: chosen.variant } : {}) },
  } };
}
export function parkedSeedRequest(input: PublicContext & { sessionID: string; messageID: string; text: string }) {
  requirePublicInput(input);
  if (typeof input.text !== 'string' || !input.text.trim() || input.text.includes('\0') || Buffer.byteLength(input.text) > 16 * 1024)
    throw new BosunError('invalid', 'OpenCode 2 seed exceeds text limit or is empty');
  screenPublicText(input.text);
  return { method: 'POST' as const, path: `/api/session/${id(input.sessionID, 'ses_')}/prompt`,
    body: { id: id(input.messageID, 'msg_'), text: input.text, delivery: 'queue' as const, resume: false as const } };
}
export function decodeFreshRoot(value: unknown, input: PublicContext & { selection: ModelSelection }) {
  requirePublicInput(input);
  const result = decodeSession(value, input);
  if (result.parentID || result.reset || !sameSelection(result.selection, selection(input.selection))) return unsupported();
  return { sessionID: result.id, rootResponse: true as const, readiness: 'unverified' as const };
}
