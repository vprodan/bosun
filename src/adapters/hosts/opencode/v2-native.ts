// OpenCode 2 native runner boundary using the pinned schema. No SDK, spawn, discovery or auth mutation.
import crypto from 'node:crypto';
import path from 'node:path';
import { BosunError, type BosunErrorCode } from '../../../core/errors.ts';
import { requirePublicInput } from '../../../core/policy.ts';
import { screenPublicText } from '../../../core/secret-screen.ts';
import type { Env } from '../../../core/domain/inference.ts';
import type { RunEvent, RunSpec } from '../../../core/ports/runner.ts';
import { JOB_LIMITS } from '../../../core/domain/job.ts';
import { protocolBase } from '../../../platform/http-json.ts';
import { decodeMessagePage, decodeSession, type ModelSelection } from './v2-protocol.ts';

export type OpenCodeRunnerSettings = {
  url: string; username?: string; passwordEnv?: string; env?: Env; agent?: string;
  requestTimeoutMs?: number; runTimeoutMs?: number; abortTimeoutMs?: number; pollIntervalMs?: number;
};
type Rule = { action: string; resource: string; effect: 'allow' | 'deny' };
const READ_TOOLS = ['read', 'glob', 'grep'] as const;
const EDIT_TOOLS = ['edit', 'write', 'patch'] as const;
const MAX_RESULT = 65536;
export const object = (value: unknown): Record<string, any> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null;
export const failure = (code: BosunErrorCode, unknown = false) => new BosunError(code,
  code === 'unsupported' ? 'OpenCode 2 selection unsupported' : code === 'invalid' ? 'Invalid OpenCode 2 request'
    : code === 'cancelled' ? 'OpenCode 2 run cancelled' : code === 'timeout' ? 'OpenCode 2 run timed out' : 'OpenCode 2 run unavailable',
  unknown ? { details: { outcome: 'unknown' } } : undefined);
export const own = (value: unknown, key: string): unknown => {
  try {
    const descriptor = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, key) : undefined;
    if (descriptor && !Object.hasOwn(descriptor, 'value')) throw failure('invalid');
    return descriptor?.value;
  } catch { throw failure('invalid'); }
};
export const string = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
export const limit = (value: unknown, fallback: number, max: number): number => {
  const result = value ?? fallback;
  if (!integer(result) || result < 1 || result > max) throw failure('invalid');
  return result;
};
export const hash = (value: unknown) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function openCodeSelection(model: unknown, effort: unknown): ModelSelection {
  if (!string(model, 400)) throw failure('invalid');
  const slash = model.indexOf('/');
  if (slash < 1 || slash === model.length - 1 || slash > 200 || model.length - slash - 1 > 200 ||
    !/^[a-zA-Z0-9._-]+$/.test(model.slice(0, slash))) throw failure('invalid');
  if (effort !== undefined && !string(effort, 80)) throw failure('invalid');
  // Split only the first slash; native model IDs may contain further slashes/colons.
  // The pinned resolver treats default as its explicit no-variant sentinel.
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1), variant: effort === undefined ? 'default' : effort };
}
export function openCodePermissions(access: 'read' | 'edit'): Rule[] {
  return [{ action: '*', resource: '*', effect: 'deny' },
    ...READ_TOOLS.map((action) => ({ action, resource: '*', effect: 'allow' as const })),
    ...(access === 'edit' ? [{ action: 'edit', resource: '*', effect: 'allow' as const }] : [])];
  // Deny-all also excludes execute/Code Mode, MCP/resource tools, shell,
  // subagents, questions, skills, network and external-directory permissions.
}
export const sameModel = (a: ModelSelection | undefined, b: ModelSelection) =>
  a?.providerID === b.providerID && a.modelID === b.modelID && a.variant === b.variant;
function sameRules(value: unknown, rules: Rule[]): boolean {
  return Array.isArray(value) && value.length === rules.length && value.every((raw, i) => {
    const rule = object(raw);
    return !!rule && Object.keys(rule).length === 3 && rule.action === rules[i].action &&
      rule.resource === rules[i].resource && rule.effect === rules[i].effect;
  });
}
export function requestConfiguration(settings: OpenCodeRunnerSettings, suppliedEnv?: Env) {
  const base = protocolBase(settings.url, true);
  const requestTimeout = limit(settings.requestTimeoutMs, 10000, 60000);
  const runTimeout = limit(settings.runTimeoutMs, 1800000, 86400000);
  const abortTimeout = limit(settings.abortTimeoutMs, 10000, 60000);
  const pollInterval = limit(settings.pollIntervalMs, 50, 2000);
  const headers: Record<string, string> = {};
  const username = settings.username, passwordEnv = settings.passwordEnv;
  if (username !== undefined || passwordEnv !== undefined) {
    if (!string(username, 200) || username.includes(':') || typeof passwordEnv !== 'string' ||
      !/^[A-Z_][A-Z0-9_]{0,127}$/.test(passwordEnv)) throw failure('invalid');
    const password = own(suppliedEnv ?? settings.env, passwordEnv);
    if (!string(password, 4096)) throw failure('unavailable');
    headers.authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  }
  return { base, requestTimeout, runTimeout, abortTimeout, pollInterval, headers };
}
export function requestSpec(spec: RunSpec, settings: OpenCodeRunnerSettings) {
  requirePublicInput(spec); // before prompt/config/credential getters and all native requests
  const prompt = own(spec, 'prompt'), cwd = own(spec, 'cwd'), access = own(spec, 'access');
  if (typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt) > 32768 || prompt.includes('\0') ||
    !string(cwd, 4096) || !path.isAbsolute(cwd) || path.resolve(cwd) !== cwd || access !== 'read' && access !== 'edit') throw failure('invalid');
  const selection = openCodeSelection(own(spec, 'model'), own(spec, 'effort'));
  screenPublicText(prompt);
  if (own(spec, 'maxTurns') !== undefined || own(spec, 'mcp') !== undefined) throw failure('unsupported');
  const env = own(spec, 'env');
  if (env !== undefined && (!object(env) || Object.keys(env as object).some((key) => key !== settings.passwordEnv))) throw failure('unsupported');
  const signal = own(spec, 'signal') as AbortSignal | undefined;
  if (!signal || typeof signal.addEventListener !== 'function' || typeof signal.aborted !== 'boolean') throw failure('invalid');
  const agent = settings.agent ?? 'build';
  if (!string(agent, 100) || !/^[A-Za-z0-9_-]+$/.test(agent)) throw failure('invalid');
  return { prompt, cwd, access: access as 'read' | 'edit', selection, signal, agent, env: env as Env | undefined };
}
export function availableModel(value: unknown, selected: ModelSelection, cwd: string): string {
  const catalog = object(value);
  if (!catalog || object(catalog.location)?.directory !== cwd || !Array.isArray(catalog.data) || catalog.data.length > 1000) throw failure('unsupported');
  const matches = catalog.data.filter((raw: unknown) => object(raw)?.id === selected.modelID && object(raw)?.providerID === selected.providerID);
  if (matches.length !== 1) throw failure('unsupported');
  const model = object(matches[0])!;
  if (!string(model.modelID, 200) || model.enabled !== true || !Array.isArray(model.variants) || model.variants.length > 128 ||
    !model.variants.every((v: unknown) => string(object(v)?.id, 80))) throw failure('unsupported');
  const variants = model.variants as Record<string, any>[];
  if (new Set(variants.map((v) => v.id)).size !== variants.length || variants.some((v) => v.id === 'default') ||
    (selected.variant !== 'default' && !variants.some((v) => v.id === selected.variant))) throw failure('unsupported');
  // Bind the selected native catalog record, including route/settings/variant
  // overlays, without projecting it or discovering/borrowing any credentials.
  return hash(model);
}
export type SessionBinding = {
  id: string; cwd: string; selection: ModelSelection; access: 'read' | 'edit'; agent: string; association: string;
};
export function validateSession(value: unknown, expected: SessionBinding) {
  const decoded = decodeSession(value, { privacy: 'public' }), raw = object(object(value)?.data)!;
  if (decoded.id !== expected.id || decoded.parentID || decoded.reset || !sameModel(decoded.selection, expected.selection) ||
    object(raw.location)?.directory !== expected.cwd || raw.agent !== expected.agent ||
    !sameRules(raw.permissions, openCodePermissions(expected.access)) || object(object(raw.metadata)?.bosun)?.association !== expected.association)
    throw failure('unsupported');
  const identityHash = hash([decoded.id, raw.projectID, decoded.created, raw.location, raw.agent,
    raw.model, raw.permissions, raw.metadata]);
  return { ...decoded, identityHash, idleAt: raw.time.idle as number | undefined, outcome: raw.outcome as string | undefined };
}
const empty = (value: unknown) => value === undefined || Array.isArray(value) && value.length === 0;
export function validateAdmission(value: unknown, sessionID: string, messageID: string, prompt: string) {
  const row = object(object(value)?.data), payload = object(row?.payload);
  if (!row || row.id !== messageID || row.sessionID !== sessionID || row.type !== 'user' || row.delivery !== 'queue' ||
    !integer(object(row.time)?.created) || !payload || payload.text !== prompt ||
    ![payload.files, payload.agents, payload.skills].every(empty)) throw failure('unavailable', true);
}
export function pendingInbox(value: unknown, sessionID: string, messageID: string, prompt: string): number {
  const rows = object(value)?.data;
  if (!Array.isArray(rows) || rows.length > 1) throw failure('unavailable', true);
  for (const row of rows) validateAdmission({ data: row }, sessionID, messageID, prompt);
  return rows.length;
}
export async function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw failure('cancelled');
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() { signal.removeEventListener('abort', abort); resolve(); }
    function abort() { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(failure('cancelled')); }
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
  });
}
export function inspectHistory(rows: readonly Record<string, any>[], binding: SessionBinding, messageID: string, prompt: string) {
  const decoded = decodeMessagePage({ data: rows, cursor: {} }, binding.id, { privacy: 'public' }).messages;
  let users = 0, assistants = 0, pendingTools = 0;
  const allowed = new Set<string>([...READ_TOOLS, ...(binding.access === 'edit' ? EDIT_TOOLS : [])]);
  for (const [index, row] of rows.entries()) {
    const info = decoded[index];
    if (row.privacy !== undefined && row.privacy !== 'public') throw failure('unavailable', true);
    if (info.type === 'user') {
      if (index !== 0 || ++users !== 1 || info.id !== messageID || row.text !== prompt ||
        ![row.files, row.agents, row.skills].every(empty)) throw failure('unavailable', true);
    } else if (info.type === 'assistant') {
      if (!users || !sameModel(info.selection, binding.selection) || row.agent !== binding.agent || info.failed) throw failure('unavailable', true);
      assistants++;
      for (const content of row.content) {
        if (content.privacy !== undefined && content.privacy !== 'public') throw failure('unavailable', true);
        if (content.type === 'tool' && (!allowed.has(content.name) || typeof content.id !== 'string')) throw failure('unavailable', true);
      }
      pendingTools += info.pendingTools;
    } else if (info.type === 'idle') {
      if (index !== rows.length - 1 || !users || info.failed) throw failure('unavailable', true);
    } else throw failure('unavailable', true); // No hidden prompt, shell, compaction or model/agent/location switch.
  }
  const terminal = decoded.at(-1)?.type === 'idle' ? decoded.at(-1)! : undefined;
  if (terminal?.outcome === 'succeeded' && (!assistants || pendingTools || decoded.some((row) => row.type === 'assistant' && row.completed === undefined)))
    throw failure('unavailable', true);
  return { decoded, terminal, pendingTools, users, assistants };
}
export function completion(rows: readonly Record<string, any>[], binding: SessionBinding, messageID: string, prompt: string): RunEvent[] {
  const history = inspectHistory(rows, binding, messageID, prompt);
  if (history.terminal?.outcome !== 'succeeded' || history.pendingTools || !history.assistants) throw failure('unavailable', true);
  const assistantRows = rows.filter((row) => row.type === 'assistant');
  if (assistantRows.at(-1)?.finish !== 'stop' || assistantRows.some((row, i) =>
    !['stop', 'tool-calls'].includes(row.finish) || (i < assistantRows.length - 1 && row.finish !== 'tool-calls'))) throw failure('unavailable', true);
  const events: RunEvent[] = []; let result = '', tokensIn = 0, tokensOut = 0;
  for (const row of assistantRows) {
    for (const content of row.content) {
      if (content.type === 'text') {
        if (typeof content.text !== 'string') throw failure('unavailable', true);
        result += content.text;
        if (Buffer.byteLength(result) > MAX_RESULT) throw failure('unavailable', true);
        if (content.text) events.push({ t: 'text', text: content.text });
      } else if (content.type === 'tool') {
        if (content.state.status !== 'completed') throw failure('unavailable', true);
        events.push({ t: 'tool', name: content.name }); // No native tool inputs/results/paths/state.
      }
      if (events.length > JOB_LIMITS.runnerEvents - 2) throw failure('unavailable', true);
    }
    if (!row.tokens) throw failure('unavailable', true);
    tokensIn += row.tokens.input + row.tokens.cache.read + row.tokens.cache.write;
    // V2 output is visible output only; reasoning is separately billable output.
    tokensOut += row.tokens.output + row.tokens.reasoning;
    if (!integer(tokensIn) || !integer(tokensOut)) throw failure('invalid', true);
  }
  events.push({ t: 'usage', tokensIn, tokensOut }, { t: 'done', code: 0, result });
  return events;
}
