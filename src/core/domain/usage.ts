import { BosunError } from '../errors.ts';
type JobState = 'queued' | 'held' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';

export type UsageSelection = Readonly<{ runnerId: string; model: string; effort: string | null }>;
export type BillingQualification = Readonly<{
  kind: 'subscription' | 'api' | 'local' | 'unknown';
  vendor: 'openai' | 'anthropic' | 'ollama' | 'other' | null;
  qualification: 'verified' | 'unverified';
  // Optional observed, opaque account/pool identity. Never a username or auth value.
  poolKey?: string;
}>;
export type NativeUsage = { tokensIn: number | null; tokensOut: number | null };
export type JobUsage = UsageSelection & BillingQualification & NativeUsage & {
  jobId: string; generation: number; state: JobState; startedAt: number; finishedAt: number | null;
  cachedTokens: null; reasoningTokens: null; usageEvents: number;
  usageQualification: 'unavailable' | 'reported' | 'partial' | 'ambiguous';
};
export type JobMetadataEvent = {
  event: 'job.state' | 'job.usage' | 'job.storage_hold'; state?: JobState; reason?: string | null;
  generation?: number; tokensIn?: number | null; tokensOut?: number | null; outcome?: 'unknown';
};
export type DailyUsage = UsageSelection & BillingQualification & {
  day: number; pool: string; attempts: number; reportedAttempts: number; partialAttempts: number; ambiguousAttempts: number; unavailableAttempts: number;
  tokensIn: number | null; tokensOut: number | null; cachedTokens: null; reasoningTokens: null;
  knownTokensIn: number; knownTokensOut: number; missingInputAttempts: number; missingOutputAttempts: number;
};
export const UNKNOWN_BILLING: BillingQualification = Object.freeze({ kind: 'unknown', vendor: null, qualification: 'unverified' });
const own = (value: unknown, key: string): unknown => {
  const property = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, key) : undefined;
  return property && 'value' in property ? property.value : undefined;
};
export function billingQualification(value: unknown): BillingQualification {
  try {
    const kind = own(value, 'kind'); const vendor = own(value, 'vendor'); const qualification = own(value, 'qualification');
    if (!['subscription', 'api', 'local', 'unknown'].includes(kind as string)
      || vendor !== null && !['openai', 'anthropic', 'ollama', 'other'].includes(vendor as string)
      || !['verified', 'unverified'].includes(qualification as string)) return UNKNOWN_BILLING;
    if (qualification !== 'verified') return UNKNOWN_BILLING;
    const poolKey = own(value, 'poolKey'); if (poolKey !== undefined && (typeof poolKey !== 'string' || !/^[a-f0-9]{64}$/.test(poolKey))) return UNKNOWN_BILLING;
    return Object.freeze({ kind, vendor, qualification, ...(poolKey === undefined ? {} : { poolKey }) }) as BillingQualification;
  } catch { return UNKNOWN_BILLING; }
}
export function nativeUsage(value: unknown): NativeUsage {
  try {
    const count = (key: string): number | null => {
      const property = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, key) : undefined;
      if (!property) return null;
      if (!('value' in property)) throw 0;
      const result = property.value;
      if (result === undefined || result === null) return null;
      if (!Number.isSafeInteger(result) || result < 0) throw 0;
      return result;
    };
    return { tokensIn: count('tokensIn'), tokensOut: count('tokensOut') };
  } catch { throw new BosunError('invalid', 'Invalid native usage'); }
}
