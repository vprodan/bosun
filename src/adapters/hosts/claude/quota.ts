import { BosunError } from '../../../core/errors.ts';
import { quotaData, quotaBinding, quotaTime, quotaUnixMs, type QuotaBinding, type QuotaObservation, type QuotaWindow } from '../../../core/domain/quota.ts';

const field = (value: unknown, key: string) => { if (!value || typeof value !== 'object' || Object.getOwnPropertyDescriptor(value, key) === undefined) return undefined; return quotaData(value, key); };
// Supported statusline fields are optional and disappear at reset. No account/prompt/transcript is discovered here.
export function decodeClaudeQuota(value: unknown, binding: QuotaBinding, observedAt: number, verifiedOrdinaryAccess: boolean | null = null): QuotaObservation {
  const b = quotaBinding(binding); quotaTime(observedAt); const invalid = () => new BosunError('invalid', 'Invalid Claude quota observation');
  if (b.source !== 'claude-statusline' || b.unit !== 'claude-subscription' && b.unit !== 'api'
    || field(field(value, 'model'), 'id') !== b.model || verifiedOrdinaryAccess !== null && typeof verifiedOrdinaryAccess !== 'boolean') throw invalid();
  const limits = field(value, 'rate_limits'); const windows: QuotaWindow[] = [];
  for (const [name, id] of [['five_hour', 'short'], ['seven_day', 'weekly'], ['spend_limit', 'spend']] as const) {
    const raw = field(limits, name); if (raw == null) continue;
    const used = quotaData(raw, 'used_percentage'); const reset = field(raw, 'resets_at');
    if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100 && id !== 'spend') throw invalid();
    windows.push({ id, durationMinutes: id === 'short' ? 300 : id === 'weekly' ? 10080 : null,
      remainingPercent: Math.max(0, 100 - used), resetsAt: reset == null ? null : quotaUnixMs(reset) });
  }
  return { ...b, observedAt, complete: windows.some(w => w.id === 'short') && windows.some(w => w.id === 'weekly'),
    ordinaryUsageAllowed: verifiedOrdinaryAccess, windows };
}
