import { BosunError } from '../errors.ts';

export type QuotaSourceId = 'codex-app-server' | 'claude-statusline' | 'opencode';
export type QuotaUnit = 'work-codex' | 'claude-subscription' | 'api' | 'local';
export type QuotaBinding = { source: QuotaSourceId; unit: QuotaUnit; accountId: string; bucketId: string; model: string; scope: 'pool' | 'model' };
export type QuotaWindowId = 'primary' | 'secondary' | 'short' | 'weekly' | 'spend';
export type QuotaWindow = { id: QuotaWindowId; durationMinutes: number | null; remainingPercent: number | null; resetsAt: number | null };
// Only a declared supported source supplies this type. No public JSON ingress grants its authority.
export type QuotaObservation = QuotaBinding & { observedAt: number; complete: boolean; ordinaryUsageAllowed: boolean | null; windows: QuotaWindow[] };
export type QuotaIdentity = { key: string; poolKey: string; source: QuotaSourceId; unit: QuotaUnit; model: string | null };
export type QuotaState = QuotaIdentity & { version: number; observedAt: number; completeAt: number | null; accessBlocked: boolean;
  windows: (QuotaWindow & { observedAt: number; blocked: boolean })[] };
export type QuotaDecision = 'available' | 'blocked' | 'unknown';
export const QUOTA_LIMITS = Object.freeze({ states: 128, batch: 16, windows: 3, freshnessMs: 300000, refreshCacheMs: 5000, readTimeoutMs: 5000, recordBytes: 4096 });
const invalid = () => new BosunError('invalid', 'Invalid quota observation');
const unavailable = () => new BosunError('unavailable', 'Quota unavailable');
const SOURCES = ['codex-app-server', 'claude-statusline', 'opencode']; const UNITS = ['work-codex', 'claude-subscription', 'api', 'local'];
const WINDOWS = ['primary', 'secondary', 'short', 'weekly', 'spend'];
const validUnit = (source: unknown, unit: unknown) => source === 'codex-app-server' ? unit === 'work-codex'
  : source === 'claude-statusline' ? unit === 'claude-subscription' || unit === 'api' : source === 'opencode' ? unit === 'api' || unit === 'local' : false;
export function quotaData(value: unknown, key: string): unknown {
  try { const d = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, key) : undefined;
    if (d && Object.hasOwn(d, 'value')) return d.value; } catch {}
  throw invalid();
}
function label(value: unknown, max = 200): string {
  if (typeof value !== 'string' || !value.length || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw invalid(); return value;
}
export function quotaTime(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 8_640_000_000_000_000) throw invalid(); return Number(value);
}
export function quotaUnixMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw invalid(); return quotaTime(value * 1000);
}
function duration(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 525600) throw invalid(); return Number(value);
}
export function quotaBinding(value: QuotaBinding): QuotaBinding {
  const source = quotaData(value, 'source'); const unit = quotaData(value, 'unit'); const scope = quotaData(value, 'scope');
  if (!SOURCES.includes(source as string) || !UNITS.includes(unit as string) || scope !== 'pool' && scope !== 'model'
    || !validUnit(source, unit)) throw invalid();
  return { source: source as QuotaSourceId, unit: unit as QuotaUnit, scope, accountId: label(quotaData(value, 'accountId')),
    bucketId: label(quotaData(value, 'bucketId'), 80), model: label(quotaData(value, 'model')) };
}
export function quotaIdentity(binding: QuotaBinding, hash: (text: string) => string): QuotaIdentity {
  const b = quotaBinding(binding);
  const digest = (text: string) => { let result: string; try { result = hash(text); } catch { throw unavailable(); }
    if (typeof result !== 'string' || !/^[a-f0-9]{64}$/.test(result)) throw unavailable(); return result; };
  const poolKey = digest(JSON.stringify(['quota-pool', b.unit, b.accountId]));
  return { poolKey, key: digest(JSON.stringify(['quota-bucket', poolKey, b.bucketId, b.scope === 'model' ? b.model : null])),
    source: b.source, unit: b.unit, model: b.scope === 'model' ? b.model : null };
}
export function quotaObservation(value: QuotaObservation, binding: QuotaBinding, now: number): QuotaObservation {
  quotaTime(now); const expected = quotaBinding(binding); const got = quotaBinding(value);
  if (Object.keys(expected).some(key => got[key as keyof QuotaBinding] !== expected[key as keyof QuotaBinding])) throw invalid();
  const observedAt = quotaTime(quotaData(value, 'observedAt')); const complete = quotaData(value, 'complete'); const allowed = quotaData(value, 'ordinaryUsageAllowed');
  const input = quotaData(value, 'windows');
  if (observedAt > now || typeof complete !== 'boolean' || allowed !== null && typeof allowed !== 'boolean'
    || !Array.isArray(input) || input.length > QUOTA_LIMITS.windows) throw invalid();
  const windows = input.map((raw) => {
    const id = quotaData(raw, 'id'); const remaining = quotaData(raw, 'remainingPercent'); const reset = quotaData(raw, 'resetsAt'); const minutes = duration(quotaData(raw, 'durationMinutes'));
    if (!WINDOWS.includes(id as string) || remaining !== null && (typeof remaining !== 'number' || !Number.isFinite(remaining) || remaining < 0 || remaining > 100)) throw invalid();
    return { id: id as QuotaWindowId, durationMinutes: minutes, remainingPercent: remaining as number | null, resetsAt: reset === null ? null : quotaTime(reset) };
  });
  if (new Set(windows.map(w => w.id)).size !== windows.length) throw invalid();
  return { ...expected, observedAt, complete, ordinaryUsageAllowed: allowed as boolean | null, windows };
}
export function mergeQuota(prior: QuotaState | null, identity: QuotaIdentity, observation: QuotaObservation, now: number): QuotaState {
  quotaTime(now);
  if (prior && (prior.key !== identity.key || prior.poolKey !== identity.poolKey || prior.source !== identity.source || prior.unit !== identity.unit || prior.model !== identity.model)) throw invalid();
  // Equal timestamps are duplicates, never new recovery evidence. Older rolling updates cannot erase newer state.
  if (prior && observation.observedAt <= prior.observedAt) return prior;
  const fresh = observation.observedAt <= now && now - observation.observedAt <= QUOTA_LIMITS.freshnessMs;
  const old = prior?.windows ?? [];
  const complete = fresh && observation.complete && observation.ordinaryUsageAllowed === true && observation.windows.length > 0
    && observation.windows.every(w => w.remainingPercent !== null && w.durationMinutes !== null && w.resetsAt !== null && w.resetsAt > now)
    && old.every(w => observation.windows.some(next => next.id === w.id && next.remainingPercent !== null));
  const windows = old.map(w => ({ ...w }));
  for (const incoming of observation.windows) {
    const index = windows.findIndex(w => w.id === incoming.id); const previous = index < 0 ? undefined : windows[index];
    const low = incoming.remainingPercent !== null && incoming.remainingPercent < 10;
    const blocked = low || !!previous?.blocked && !complete;
    const merged = { id: incoming.id, remainingPercent: incoming.remainingPercent ?? previous?.remainingPercent ?? null,
      durationMinutes: incoming.durationMinutes ?? previous?.durationMinutes ?? null,
      resetsAt: incoming.resetsAt ?? previous?.resetsAt ?? null,
      observedAt: incoming.remainingPercent === null ? previous?.observedAt ?? observation.observedAt : observation.observedAt, blocked };
    if (index < 0) windows.push(merged); else windows[index] = merged;
  }
  return { ...identity, version: (prior?.version ?? 0) + 1, observedAt: observation.observedAt,
    completeAt: complete ? observation.observedAt : prior?.completeAt ?? null,
    accessBlocked: observation.ordinaryUsageAllowed === false || !!prior?.accessBlocked && !complete,
    windows: windows.sort((a, b) => WINDOWS.indexOf(a.id) - WINDOWS.indexOf(b.id)) };
}
export function quotaDecision(states: readonly QuotaState[], now: number): QuotaDecision {
  quotaTime(now);
  if (states.some(s => s.accessBlocked || s.windows.some(w => w.blocked))) return 'blocked';
  if (!states.length || states.some(s => s.completeAt === null || s.completeAt > now || now - s.completeAt > QUOTA_LIMITS.freshnessMs
    || !s.windows.length || s.windows.some(w => w.remainingPercent === null || w.durationMinutes === null || w.observedAt > now || now - w.observedAt > QUOTA_LIMITS.freshnessMs
      || w.resetsAt === null || w.resetsAt <= now))) return 'unknown';
  return 'available';
}
export function storedQuotaState(value: QuotaState): QuotaState {
  const key = quotaData(value, 'key'); const poolKey = quotaData(value, 'poolKey'); const source = quotaData(value, 'source'); const unit = quotaData(value, 'unit');
  const model = quotaData(value, 'model'); const version = quotaData(value, 'version'); const observedAt = quotaTime(quotaData(value, 'observedAt'));
  const completeAt = quotaData(value, 'completeAt'); const accessBlocked = quotaData(value, 'accessBlocked'); const input = quotaData(value, 'windows');
  if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key) || typeof poolKey !== 'string' || !/^[a-f0-9]{64}$/.test(poolKey)
    || !SOURCES.includes(source as string) || !UNITS.includes(unit as string) || !validUnit(source, unit)
    || !Number.isSafeInteger(version) || Number(version) < 1 || typeof accessBlocked !== 'boolean'
    || !Array.isArray(input) || input.length > QUOTA_LIMITS.windows) throw invalid();
  const completion = completeAt === null ? null : quotaTime(completeAt); if (completion !== null && completion > observedAt) throw invalid();
  const windows = input.map(raw => {
    const id = quotaData(raw, 'id'); const remaining = quotaData(raw, 'remainingPercent'); const reset = quotaData(raw, 'resetsAt'); const minutes = duration(quotaData(raw, 'durationMinutes'));
    const at = quotaTime(quotaData(raw, 'observedAt')); const blocked = quotaData(raw, 'blocked');
    if (!WINDOWS.includes(id as string) || typeof blocked !== 'boolean' || at > observedAt
      || remaining !== null && (typeof remaining !== 'number' || !Number.isFinite(remaining) || remaining < 0 || remaining > 100)
      || remaining !== null && Number(remaining) < 10 && !blocked) throw invalid();
    return { id: id as QuotaWindowId, durationMinutes: minutes, remainingPercent: remaining as number | null, resetsAt: reset === null ? null : quotaTime(reset), observedAt: at, blocked };
  });
  if (new Set(windows.map(w => w.id)).size !== windows.length) throw invalid();
  return { key, poolKey, source: source as QuotaSourceId, unit: unit as QuotaUnit, model: model === null ? null : label(model), version: Number(version), observedAt,
    completeAt: completion, accessBlocked, windows };
}
export function quotaStatus(states: readonly QuotaState[], now: number) {
  return { state: quotaDecision(states, now), buckets: states.map(state => ({ key: state.key, poolKey: state.poolKey, source: state.source, unit: state.unit, model: state.model,
    state: quotaDecision([state], now), observedAt: state.observedAt, completeAt: state.completeAt,
    windows: state.windows.map(w => ({ id: w.id, durationMinutes: w.durationMinutes, remainingPercent: w.remainingPercent, resetsAt: w.resetsAt, blocked: w.blocked })) })) };
}
