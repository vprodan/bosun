// Native v1.18.34 routes/schema, not the stale generated SDK or separate v2 documentation.
// See test/fixtures/native-protocol-provenance.md for pinned primary source paths.
import { BosunError } from '../../../core/errors.ts';
import { publicInput, requirePublicInput } from '../../../core/policy.ts';
import type { InputPrivacy } from '../../../core/domain/inference.ts';
import type { ContextSample } from '../../../core/domain/session.ts';
import type { ManagedCapability } from '../../../core/ports/host.ts';

export const OPENCODE_VERSION = '1.18.34';
export const OPENCODE_MANAGED_CAPS: Readonly<Record<Exclude<ManagedCapability, 'isolatedBootstrapTurn'>, 'unverified'>> =
  Object.freeze({
    contextTelemetry: 'unverified',
    promptAdmission: 'unverified',
    toolQuiescence: 'unverified',
    freshSession: 'unverified',
    seedWithoutInference: 'unverified',
    freshReadiness: 'unverified',
  });
export type PublicContext = { privacy: InputPrivacy };
export type ModelSelection = { providerID: string; modelID: string; variant?: string };
export type SessionMetadata = {
  id: string;
  parentID?: string;
  created: number;
  updated: number;
  selection?: ModelSelection;
};
type Tokens = {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
};
type MessageMetadata = {
  id: string;
  sessionID: string;
  role: 'user' | 'assistant';
  created: number;
  completed?: number;
  parentID?: string;
  selection: ModelSelection;
  tokens?: Tokens;
  steps: Tokens[];
  summary: boolean;
  failed: boolean;
};
const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const invalid = (): never => {
  throw new BosunError('invalid', 'Invalid OpenCode v1 protocol response');
};
const number = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const text = (value: unknown, max = 200): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  !/[\x00-\x1f]/.test(value);
function id(value: unknown, prefix: string): string {
  if (!text(value) || !value.startsWith(prefix) || !/^[A-Za-z0-9_-]+$/.test(value))
    return invalid();
  return value;
}
function selection(value: unknown, session = false): ModelSelection {
  const model = object(value);
  const modelID = session ? model?.id : model?.modelID;
  if (
    !model ||
    !text(model.providerID) ||
    !text(modelID) ||
    (model.variant !== undefined && !text(model.variant))
  )
    return invalid();
  return {
    providerID: model.providerID,
    modelID,
    ...(model.variant !== undefined ? { variant: model.variant as string } : {}),
  };
}
const sameSelection = (a: ModelSelection, b: ModelSelection) =>
  a.providerID === b.providerID && a.modelID === b.modelID && a.variant === b.variant;
function tokens(value: unknown): Tokens {
  const t = object(value);
  const cache = object(t?.cache);
  if (
    !t ||
    !cache ||
    ![t.input, t.output, t.reasoning, cache.read, cache.write].every(number) ||
    (t.total !== undefined && !number(t.total))
  )
    return invalid();
  return {
    input: t.input as number,
    output: t.output as number,
    reasoning: t.reasoning as number,
    cache: { read: cache.read as number, write: cache.write as number },
  };
}
export function decodeHealth(value: unknown): {
  hostId: 'opencode';
  version: typeof OPENCODE_VERSION;
} {
  const health = object(value);
  if (!health || health.healthy !== true || typeof health.version !== 'string') return invalid();
  if (health.version !== OPENCODE_VERSION)
    throw new BosunError('unsupported', 'OpenCode protocol version is not pinned');
  return { hostId: 'opencode', version: OPENCODE_VERSION };
}
export function decodeSession(value: unknown, context: PublicContext): SessionMetadata {
  requirePublicInput(context);
  const session = object(value);
  const time = object(session?.time);
  if (
    !session ||
    !time ||
    !number(time.created) ||
    !number(time.updated) ||
    !text(session.slug) ||
    !text(session.projectID) ||
    !text(session.directory, 4096) ||
    !text(session.title, 10_000)
  )
    return invalid();
  if (session.version !== OPENCODE_VERSION)
    throw new BosunError('unsupported', 'OpenCode session schema version is not pinned');
  return {
    id: id(session.id, 'ses'),
    ...(session.parentID !== undefined ? { parentID: id(session.parentID, 'ses') } : {}),
    created: time.created,
    updated: time.updated,
    ...(session.model !== undefined ? { selection: selection(session.model, true) } : {}),
  };
}
function message(value: unknown, expectedSession: string, parts: unknown): MessageMetadata {
  const info = object(value);
  const time = object(info?.time);
  if (
    !info ||
    !time ||
    !number(time.created) ||
    !Array.isArray(parts) ||
    parts.length > 256 ||
    info.sessionID !== expectedSession ||
    !text(info.agent)
  )
    return invalid();
  const base = { id: id(info.id, 'msg'), sessionID: expectedSession, created: time.created };
  if (info.role === 'user')
    return {
      ...base,
      role: 'user',
      selection: selection(info.model),
      steps: [],
      summary: false,
      failed: false,
    };
  if (
    info.role !== 'assistant' ||
    (time.completed !== undefined && (!number(time.completed) || time.completed < time.created)) ||
    !text(info.mode) ||
    !object(info.path) ||
    typeof info.cost !== 'number' ||
    !Number.isFinite(info.cost) ||
    info.cost < 0 ||
    (info.summary !== undefined && typeof info.summary !== 'boolean')
  )
    return invalid();
  const path = object(info.path)!;
  if (!text(path.cwd, 4096) || !text(path.root, 4096)) return invalid();
  const selected = selection({
    providerID: info.providerID,
    modelID: info.modelID,
    variant: info.variant,
  });
  const steps: Tokens[] = [];
  for (const item of parts) {
    const part = object(item);
    if (
      !part ||
      part.sessionID !== expectedSession ||
      part.messageID !== base.id ||
      !text(part.type)
    )
      return invalid();
    id(part.id, 'prt');
    if (part.type === 'step-finish') {
      if (
        !text(part.reason) ||
        typeof part.cost !== 'number' ||
        !Number.isFinite(part.cost) ||
        part.cost < 0
      )
        return invalid();
      steps.push(tokens(part.tokens));
    }
    // Text/tool/file/structured content is never projected into this metadata protocol.
  }
  return {
    ...base,
    role: 'assistant',
    completed: time.completed as number | undefined,
    parentID: id(info.parentID, 'msg'),
    selection: selected,
    tokens: tokens(info.tokens),
    steps,
    summary: info.summary === true,
    failed: info.error !== undefined,
  };
}
export function decodeMessages(
  value: unknown,
  sessionID: string,
  context: PublicContext,
): MessageMetadata[] {
  requirePublicInput(context);
  id(sessionID, 'ses');
  if (!Array.isArray(value) || value.length > 128) return invalid();
  const result = value.map((entry) => {
    const row = object(entry);
    if (!row) return invalid();
    return message(row.info, sessionID, row.parts);
  });
  if (new Set(result.map((entry) => entry.id)).size !== result.length) return invalid();
  return result;
}

export function contextCandidate(
  session: SessionMetadata,
  messages: MessageMetadata[],
  options: {
    now: number;
    generation: number;
    selection: ModelSelection;
    resetAfter?: number;
  },
): { sample: ContextSample; candidateInputTokens: number | null; reason: string } {
  if (
    !number(options.now) ||
    !number(options.generation) ||
    (options.resetAfter !== undefined && !number(options.resetAfter))
  )
    return invalid();
  const chosen = selection(options.selection);
  const sessionID = id(session.id, 'ses');
  if (messages.some((entry) => entry.sessionID !== sessionID)) return invalid();
  const sample: ContextSample = {
    sessionId: sessionID,
    turnId: '',
    modelId: `${chosen.providerID}/${chosen.modelID}`,
    usedTokens: null,
    windowTokens: null,
    scope: 'unknown',
    quality: 'unknown',
    observedAt: options.now,
    generation: options.generation,
  };
  const unknown = (reason: string) => ({ sample, candidateInputTokens: null, reason });
  if (session.selection && !sameSelection(session.selection, chosen))
    return unknown('model_changed');
  const completed = messages
    .filter((m) => m.role === 'assistant' && m.completed !== undefined)
    .sort((a, b) => b.completed! - a.completed!);
  const latest = completed[0];
  if (!latest) return unknown('no_completed_turn');
  sample.turnId = latest.id;
  if (latest.summary || latest.failed) return unknown('reset_or_failed_turn');
  if (latest.completed! > options.now || options.now - latest.completed! > 30_000)
    return unknown('stale_or_future');
  if (options.resetAfter !== undefined && latest.completed! <= options.resetAfter)
    return unknown('reset_without_new_turn');
  if (!sameSelection(latest.selection, chosen)) return unknown('model_changed');
  if (
    messages.some(
      (m) =>
        m.created > latest.completed! ||
        (m.role === 'assistant' && m.completed === undefined && m.created >= latest.created),
    )
  )
    return unknown('turn_in_progress');
  const current = latest.steps.at(-1) ?? latest.tokens;
  if (!current) return unknown('missing_usage');
  // getUsage removes cached input from `input`; recombine it once. Never use session totals, `total`, output, or older steps.
  const candidateInputTokens = current.input + current.cache.read + current.cache.write;
  if (!number(candidateInputTokens)) return invalid();
  return { sample, candidateInputTokens, reason: 'active_total_unverified' };
}

export function probeParameters(
  input: PublicContext & {
    sessionID: string;
    selection: ModelSelection;
    generation: number;
    resetAfter?: number;
  },
) {
  requirePublicInput(input);
  if (!number(input.generation) || (input.resetAfter !== undefined && !number(input.resetAfter)))
    return invalid();
  return {
    sessionID: id(input.sessionID, 'ses'),
    selection: selection(input.selection),
    generation: input.generation,
    resetAfter: input.resetAfter,
  };
}

// Pure mutation recipes only; the read-only probe does not send these requests.
export function freshRootRequest(input: PublicContext & { selection: ModelSelection }) {
  requirePublicInput(input);
  const chosen = selection(input.selection);
  return {
    method: 'POST' as const,
    path: '/session',
    body: {
      model: {
        id: chosen.modelID,
        providerID: chosen.providerID,
        ...(chosen.variant !== undefined ? { variant: chosen.variant } : {}),
      },
    },
  };
}
export function noReplyRequest(
  input: PublicContext & { sessionID: string; text: string; selection: ModelSelection },
) {
  publicInput(input);
  const chosen = selection(input.selection);
  if (!input.text.trim() || Buffer.byteLength(input.text, 'utf8') > 16 * 1024)
    throw new BosunError('invalid', 'OpenCode seed exceeds text limit or is empty');
  return {
    method: 'POST' as const,
    path: `/session/${id(input.sessionID, 'ses')}/message`,
    body: {
      model: { providerID: chosen.providerID, modelID: chosen.modelID },
      ...(chosen.variant !== undefined ? { variant: chosen.variant } : {}),
      noReply: true as const,
      parts: [{ type: 'text' as const, text: input.text }],
    },
  };
}
export function decodeFreshRoot(
  value: unknown,
  input: PublicContext & { selection: ModelSelection },
) {
  requirePublicInput(input);
  const result = decodeSession(value, input);
  if (
    result.parentID ||
    !result.selection ||
    !sameSelection(result.selection, selection(input.selection))
  ) {
    throw new BosunError('unsupported', 'OpenCode root/model selection not established');
  }
  return { sessionID: result.id, rootResponse: true as const, readiness: 'unverified' as const };
}

// One bounded /global/event SSE message frame. No network subscription/controller is implemented.
export function decodeMessageFrame(
  frame: string,
  sessionID: string,
  context: PublicContext,
): MessageMetadata | null {
  requirePublicInput(context);
  if (
    typeof frame !== 'string' ||
    Buffer.byteLength(frame, 'utf8') > 64 * 1024 ||
    !/\r?\n\r?\n$/.test(frame)
  )
    return invalid();
  const lines = frame.split(/\r?\n/);
  const event = lines.filter((line) => line.startsWith('event:'));
  if (event.length > 1 || (event.length === 1 && event[0].slice(6).trim() !== 'message'))
    return invalid();
  const data = lines
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  let envelope: Record<string, unknown> | null;
  try {
    envelope = object(JSON.parse(data));
  } catch {
    return invalid();
  }
  const payload = object(envelope?.payload);
  if (!payload) return invalid();
  if (payload.type === 'server.connected' || payload.type === 'server.heartbeat') return null;
  if (payload.type !== 'message.updated')
    throw new BosunError('unsupported', 'OpenCode event type is not supported by this prototype');
  const properties = object(payload.properties);
  if (!properties || properties.sessionID !== sessionID) return invalid();
  return message(properties.info, sessionID, []);
}
