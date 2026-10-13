import { BosunError } from '../../../core/errors.ts';
import { quotaData, quotaBinding, quotaTime, quotaUnixMs, type QuotaBinding, type QuotaObservation, type QuotaWindow } from '../../../core/domain/quota.ts';
import type { QuotaObservationEntry } from '../../../core/use-cases/quota.ts';

// account/rateLimits/read and its sparse updated notification, native v0.161.0 schema.
// Backend display/credits/reset purchases and dollar values are deliberately not consumed.
const field = (value: unknown, key: string) => { if (!value || typeof value !== 'object' || Object.getOwnPropertyDescriptor(value, key) === undefined) return undefined; return quotaData(value, key); };
const invalid = () => new BosunError('invalid', 'Invalid Codex quota observation');
function window(value: unknown, id: QuotaWindow['id']): QuotaWindow | null {
  if (value == null) return null;
  const used = quotaData(value, 'usedPercent'); const seconds = field(value, 'resetsAt');
  const minutes = field(value, 'windowDurationMins');
  if (typeof used !== 'number' || !Number.isSafeInteger(used) || used < 0 || used > 2147483647
    || minutes != null && (!Number.isSafeInteger(minutes) || Number(minutes) < 1 || Number(minutes) > 525600)) throw invalid();
  return { id, durationMinutes: minutes == null ? null : Number(minutes), remainingPercent: Math.max(0, 100 - used), resetsAt: seconds == null ? null : quotaUnixMs(seconds) };
}
export function decodeCodexQuota(value: unknown, binding: QuotaBinding, observedAt: number, kind: 'snapshot' | 'update' = 'snapshot'): QuotaObservation {
  const b = quotaBinding(binding); quotaTime(observedAt);
  if (b.source !== 'codex-app-server' || b.unit !== 'work-codex') throw invalid();
  const account = field(value, 'accountId'); if (account != null && account !== b.accountId) throw invalid();
  const buckets = field(value, 'rateLimitsByLimitId');
  let limits = buckets == null ? quotaData(value, 'rateLimits') : field(buckets, b.bucketId);
  if (!limits || typeof limits !== 'object') throw invalid();
  const bucket = field(limits, 'limitId'); const model = field(limits, 'normalModelSlug');
  if (bucket != null && bucket !== b.bucketId || model != null && (model !== b.model || b.scope !== 'model')) throw invalid();
  const windows = [window(field(limits, 'primary'), 'primary'), window(field(limits, 'secondary'), 'secondary')].filter((w): w is QuotaWindow => w !== null);
  const individual = field(limits, 'individualLimit');
  if (individual != null) {
    const remaining = quotaData(individual, 'remainingPercent'); const seconds = quotaData(individual, 'resetsAt');
    if (!Number.isSafeInteger(remaining) || Number(remaining) < 0 || Number(remaining) > 100) throw invalid();
    windows.push({ id: 'spend', durationMinutes: null, remainingPercent: Number(remaining), resetsAt: quotaUnixMs(seconds) });
  }
  const ordinary = field(value, 'ordinaryUsageAllowed'); const reached = field(limits, 'rateLimitReachedType'); const spend = field(limits, 'spendControlReached');
  if (ordinary != null && typeof ordinary !== 'boolean' || spend != null && typeof spend !== 'boolean') throw invalid();
  const denied = reached != null || spend === true || ordinary === false;
  return { ...b, observedAt, complete: kind === 'snapshot' && account === b.accountId && windows.some(w => w.id === 'primary') && windows.some(w => w.id === 'secondary'),
    ordinaryUsageAllowed: denied ? false : kind === 'snapshot' && ordinary === true ? true : null, windows };
}
export function decodeCodexQuotaBatch(value: unknown, active: { accountId: string; model: string }, observedAt: number, kind: 'snapshot' | 'update' = 'snapshot'): QuotaObservationEntry[] {
  const generic = quotaData(value, 'rateLimits'); const genericId = field(generic, 'limitId') ?? 'codex';
  const binding: QuotaBinding = { source: 'codex-app-server', unit: 'work-codex', accountId: active.accountId, bucketId: genericId as string, model: active.model, scope: 'pool' };
  // Decode the generic pool from its own field even when a multi-bucket dictionary is present.
  const poolValue = { rateLimits: generic, accountId: field(value, 'accountId'), ordinaryUsageAllowed: field(value, 'ordinaryUsageAllowed') };
  const result: QuotaObservationEntry[] = [{ binding: quotaBinding(binding), observation: decodeCodexQuota(poolValue, binding, observedAt, kind) }];
  const buckets = field(value, 'rateLimitsByLimitId');
  if (buckets != null) {
    if (typeof buckets !== 'object' || Array.isArray(buckets) || Object.keys(buckets).length > 64) throw invalid();
    for (const key of Object.keys(buckets)) {
      const bucket = field(buckets, key); if (field(bucket, 'normalModelSlug') !== active.model) continue;
      const restricted: QuotaBinding = { ...binding, bucketId: key, scope: 'model' };
      result.push({ binding: quotaBinding(restricted), observation: decodeCodexQuota(value, restricted, observedAt, kind) });
      if (result.length > 16) throw invalid();
    }
  }
  return result;
}
