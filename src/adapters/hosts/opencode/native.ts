// Pinned native v1 routes. No SDK, process spawn, provider authentication mutation or implicit server start.
import path from 'node:path';
import { BosunError, type BosunErrorCode } from '../../../core/errors.ts';
import { requirePublicInput } from '../../../core/policy.ts';
import { screenPublicText } from '../../../core/secret-screen.ts';
import type { Env } from '../../../core/domain/inference.ts';
import type { RunEvent, RunSpec } from '../../../core/ports/runner.ts';
import { protocolBase } from '../../../platform/http-json.ts';
import { decodeMessages, decodeSession, type ModelSelection } from './protocol.ts';

export type OpenCodeRunnerSettings = {
  url: string; username?: string; passwordEnv?: string; env?: Env; agent?: string;
  requestTimeoutMs?: number; runTimeoutMs?: number; abortTimeoutMs?: number; pollIntervalMs?: number;
};
type Rule = { permission: string; pattern: string; action: 'allow' | 'deny' };
const READ_TOOLS = ['read', 'glob', 'grep', 'list'] as const;
const EDIT_TOOLS = ['edit', 'write', 'apply_patch'] as const;
const MAX_RESULT = 65536;
export const object = (value: unknown): Record<string, any> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null;
export const own = (value: unknown, key: string): unknown => {
  try {
    const d = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, key) : undefined;
    if (d && !Object.hasOwn(d, 'value')) throw failure('invalid');
    if (d) return d.value;
  } catch { throw failure('invalid'); }
  return undefined;
};
export const failure = (code: BosunErrorCode, unknown = false) => new BosunError(code,
  code === 'unsupported' ? 'OpenCode selection unsupported' : code === 'invalid' ? 'Invalid OpenCode request'
    : code === 'cancelled' ? 'OpenCode run cancelled' : code === 'timeout' ? 'OpenCode run timed out' : 'OpenCode run unavailable',
  unknown ? { details: { outcome: 'unknown' } } : undefined);
export const string = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
export const limit = (value: unknown, fallback: number, max: number): number => {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || Number(result) < 1 || Number(result) > max) throw failure('invalid');
  return Number(result);
};
export function openCodeSelection(model: unknown, effort: unknown): ModelSelection {
  if (!string(model, 400)) throw failure('invalid');
  const slash = model.indexOf('/');
  if (slash < 1 || slash === model.length - 1 || slash > 200 || model.length - slash - 1 > 200
    || !/^[a-zA-Z0-9._-]+$/.test(model.slice(0, slash))) throw failure('invalid');
  if (effort !== undefined && !string(effort, 80)) throw failure('invalid');
  // Split only the first slash. Provider model IDs may contain further slashes and colons.
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1), variant: effort === undefined ? 'default' : effort as string };
}
export function openCodePermissions(access: 'read' | 'edit'): Rule[] {
  return [{ permission: '*', pattern: '*', action: 'deny' },
    ...READ_TOOLS.map((permission) => ({ permission, pattern: '*', action: 'allow' as const })),
    // Resource tools use read permission; native filesystem reads do not use mcp: patterns.
    { permission: 'read', pattern: 'mcp:*', action: 'deny' },
    ...(access === 'edit' ? [{ permission: 'edit', pattern: '*', action: 'allow' as const }] : [])];
}
export function sameRules(value: unknown, rules: Rule[]): boolean {
  return Array.isArray(value) && value.length === rules.length && value.every((raw, i) => {
    const rule = object(raw); return !!rule && rule.permission === rules[i].permission && rule.pattern === rules[i].pattern && rule.action === rules[i].action;
  });
}
export const sameModel = (a: ModelSelection | undefined, b: ModelSelection) => a?.providerID === b.providerID && a.modelID === b.modelID && a.variant === b.variant;

export function requestConfiguration(settings: OpenCodeRunnerSettings, suppliedEnv?: Env) {
  const base = protocolBase(settings.url);
  const requestTimeout = limit(settings.requestTimeoutMs, 10000, 60000);
  const runTimeout = limit(settings.runTimeoutMs, 1800000, 86400000);
  const abortTimeout = limit(settings.abortTimeoutMs, 10000, 60000);
  const pollInterval = limit(settings.pollIntervalMs, 50, 2000);
  const headers: Record<string, string> = {};
  const username = settings.username; const passwordEnv = settings.passwordEnv;
  if (username !== undefined || passwordEnv !== undefined) {
    if (!string(username, 200) || username.includes(':') || typeof passwordEnv !== 'string' || !/^[A-Z_][A-Z0-9_]{0,127}$/.test(passwordEnv)) throw failure('invalid');
    const password = own(suppliedEnv ?? settings.env, passwordEnv);
    if (!string(password, 4096)) throw failure('unavailable');
    headers.authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  }
  return { base, requestTimeout, runTimeout, abortTimeout, pollInterval, headers };
}
export function requestSpec(spec: RunSpec, settings: OpenCodeRunnerSettings) {
  requirePublicInput(spec); // before prompt getters, URL/credentials/config, health probes or mutations
  const prompt = own(spec, 'prompt'); const cwd = own(spec, 'cwd'); const access = own(spec, 'access');
  if (typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt) > 32768 || prompt.includes('\0')
    || !string(cwd, 4096) || !path.isAbsolute(cwd) || path.resolve(cwd) !== cwd || access !== 'read' && access !== 'edit') throw failure('invalid');
  const effort = own(spec, 'effort'); const selection = openCodeSelection(own(spec, 'model'), effort);
  screenPublicText(prompt);
  if (own(spec, 'maxTurns') !== undefined || own(spec, 'mcp') !== undefined) throw failure('unsupported');
  const env = own(spec, 'env');
  if (env !== undefined && (!object(env) || Object.keys(env as object).some((key) => key !== settings.passwordEnv))) throw failure('unsupported');
  const signal = own(spec, 'signal') as AbortSignal | undefined;
  if (!signal || typeof signal.addEventListener !== 'function' || typeof signal.aborted !== 'boolean') throw failure('invalid');
  const agent = settings.agent ?? 'build'; if (!string(agent, 100) || !/^[A-Za-z0-9_-]+$/.test(agent)) throw failure('invalid');
  return { prompt, cwd, access: access as 'read' | 'edit', selection, explicitEffort: effort !== undefined, signal, agent, env: env as Env | undefined };
}
export function availableModel(value: unknown, selection: ModelSelection, explicitEffort: boolean): void {
  const catalog = object(value);
  if (!catalog || !Array.isArray(catalog.all) || catalog.all.length > 1000 || !Array.isArray(catalog.connected)
    || !catalog.connected.includes(selection.providerID)) throw failure('unsupported');
  const provider = catalog.all.find((entry) => object(entry)?.id === selection.providerID);
  const model = object(object(provider)?.models)?.[selection.modelID];
  if (!object(model) || model.id !== selection.modelID || model.providerID !== selection.providerID) throw failure('unsupported');
  const variants = object(model.variants);
  if (explicitEffort && (!variants || !Object.hasOwn(variants, selection.variant!))) throw failure('unsupported');
  // Native default sentinel prevents an agent's variant fallback. A custom default must be explicitly chosen.
  if (!explicitEffort && variants && Object.hasOwn(variants, 'default')) throw failure('unsupported');
}
export function validateSession(value: unknown, cwd: string, selected: ModelSelection, rules: Rule[], agent: string) {
  const decoded = decodeSession(value, { privacy: 'public' }); const raw = object(value)!;
  if (decoded.parentID || !sameModel(decoded.selection, selected) || raw.directory !== cwd || raw.agent !== agent || !sameRules(raw.permission, rules)) throw failure('unsupported');
  return decoded;
}
export function idle(value: unknown, sessionID: string): boolean {
  const statuses = object(value); if (!statuses || Object.keys(statuses).length > 4096) throw failure('invalid');
  const entry = statuses[sessionID];
  // v1 deletes the entry on idle. Absence is used only for a positively bound existing session.
  if (entry === undefined) return true;
  if (!object(entry) || !['idle', 'busy', 'retry'].includes(entry.type)) throw failure('invalid');
  return entry.type === 'idle';
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
export function completion(value: unknown, sessionID: string, messageID: string, selected: ModelSelection, cwd: string, access: 'read' | 'edit', agent: string): RunEvent[] {
  const raw = object(value); const info = object(raw?.info);
  const decoded = decodeMessages([value], sessionID, { privacy: 'public' })[0];
  if (decoded.role !== 'assistant' || decoded.parentID !== messageID || decoded.completed === undefined || decoded.failed
    || decoded.summary || !sameModel(decoded.selection, selected) || info?.path?.cwd !== cwd || info?.agent !== agent || info?.mode !== agent
    || info.finish !== 'stop') throw failure('unavailable', true);
  const parts = raw!.parts as Record<string, any>[];
  const events: RunEvent[] = []; let result = '';
  const allowed = new Set<string>([...READ_TOOLS, ...(access === 'edit' ? EDIT_TOOLS : [])]);
  for (const part of parts) {
    if (part.type === 'text') {
      if (typeof part.text !== 'string') throw failure('unavailable', true);
      if (part.ignored === true) continue;
      result += part.text;
      if (Buffer.byteLength(result) > MAX_RESULT) throw failure('unavailable', true);
      if (part.text) events.push({ t: 'text', text: part.text });
    } else if (part.type === 'tool') {
      if (typeof part.tool !== 'string' || !allowed.has(part.tool) || !object(part.state) || !['completed', 'error'].includes(part.state.status)) throw failure('unavailable', true);
      // Known tool names only. Provider input/output/target/title/error/path/metadata are never projected.
      events.push({ t: 'tool', name: part.tool });
    }
  }
  if (decoded.tokens) {
    const usage = decoded.steps.length ? decoded.steps : [decoded.tokens];
    let tokensIn = 0; let tokensOut = 0;
    for (const count of usage) { tokensIn += count.input + count.cache.read + count.cache.write; tokensOut += count.output; }
    if (!Number.isSafeInteger(tokensIn) || !Number.isSafeInteger(tokensOut)) throw failure('invalid', true);
    events.push({ t: 'usage', tokensIn, tokensOut });
  }
  events.push({ t: 'done', code: 0, result }); return events;
}
