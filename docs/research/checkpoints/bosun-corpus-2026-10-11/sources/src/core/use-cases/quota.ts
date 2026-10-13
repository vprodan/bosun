import { BosunError } from '../errors.ts';
import { quotaBinding, quotaIdentity, quotaObservation, quotaStatus, quotaTime, QUOTA_LIMITS,
  type QuotaBinding, type QuotaIdentity, type QuotaObservation, type QuotaState } from '../domain/quota.ts';
import type { Admission, AdmissionMetadata } from '../domain/job.ts';

export type QuotaStorage = {
  quotaStates(poolKey?: string, model?: string): QuotaState[];
  quotaStatesFor(selection: QuotaSelection): QuotaState[];
  observeQuotas(entries: readonly { identity: QuotaIdentity; observation: QuotaObservation }[], now: number, selection: QuotaSelection): QuotaState[];
};
export type QuotaSelection = Readonly<{ runnerId: string; model: string }>;
export type QuotaObservationEntry = { binding: QuotaBinding; observation: QuotaObservation | null };
export type SupportedQuotaSource = { read(selection: QuotaSelection, signal: AbortSignal): Promise<readonly QuotaObservationEntry[] | null> };
// The application bounds/coalesces selected IO. Core receives no process, host or credential globals.
export function createQuotaService(deps: { storage: QuotaStorage; now(): number; hash(text: string): string;
  observe: SupportedQuotaSource['read'] }) {
  let closed = false;
  const available = () => { if (closed) throw new BosunError('unavailable', 'Quota unavailable'); };
  const now = () => { try { return quotaTime(deps.now()); } catch { throw new BosunError('unavailable', 'Quota clock unavailable'); } };
  const validate = (selection: QuotaSelection) => {
    if (typeof selection.runnerId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(selection.runnerId)
      || typeof selection.model !== 'string' || !selection.model.length || selection.model.length > 200 || /[\x00-\x1f\x7f]/.test(selection.model)) throw new BosunError('invalid', 'Invalid quota selection');
    return Object.freeze({ runnerId: selection.runnerId, model: selection.model });
  };
  async function refresh(selection: QuotaSelection, signal: AbortSignal) {
    available(); const chosen = validate(selection); now();
    let result: Awaited<ReturnType<typeof deps.observe>>;
    try { result = await deps.observe(chosen, signal); } catch { result = null; }
    available();
    if (signal.aborted) throw new BosunError('cancelled', 'Quota request cancelled');
    if (!result || !result.length) {
      const status = quotaStatus(deps.storage.quotaStatesFor(chosen), now());
      return { ...status, state: status.state === 'blocked' ? 'blocked' as const : 'unknown' as const };
    }
    if (!Array.isArray(result) || result.length > QUOTA_LIMITS.batch) throw new BosunError('invalid', 'Invalid quota batch');
    const current = now(); const bindings = result.map(entry => quotaBinding(entry.binding)); const anchor = bindings[0];
    if (!bindings.some(b => b.scope === 'pool') || bindings.some(b => b.model !== chosen.model || b.accountId !== anchor.accountId || b.unit !== anchor.unit || b.source !== anchor.source)) throw new BosunError('invalid', 'Quota binding does not match');
    const identities = bindings.map(b => quotaIdentity(b, deps.hash));
    if (new Set(identities.map(i => i.key)).size !== identities.length) throw new BosunError('invalid', 'Duplicate quota bucket');
    const entries = result.flatMap((entry, i) => entry.observation ? [{ identity: identities[i], observation: quotaObservation(entry.observation, bindings[i], current) }] : []);
    // Validate all account/model/window bindings before the one atomic native transaction.
    if (entries.length) deps.storage.observeQuotas(entries, current, chosen);
    const states = deps.storage.quotaStates(identities[0].poolKey, chosen.model);
    const status = quotaStatus(states, current);
    // A failed/missing selected observation cannot turn a cached healthy snapshot into a fresh success.
    if (result.some(entry => !entry.observation) && status.state !== 'blocked') return { ...status, state: 'unknown' as const };
    return status;
  }
  return {
    status() { available(); return quotaStatus(deps.storage.quotaStates(), now()); },
    close() { closed = true; },
    refresh,
    async admit(job: Readonly<{ runnerId: string }>, signal: AbortSignal, metadata: Readonly<AdmissionMetadata>): Promise<Admission> {
      let status: Awaited<ReturnType<typeof refresh>>;
      try { status = await refresh({ runnerId: job.runnerId, model: metadata.model }, signal); }
      catch (e) { if (e instanceof BosunError && e.details?.outcome === 'unknown') throw e;
        if (e instanceof BosunError && e.code === 'invalid') return { allowed: false, reason: 'admission_unavailable' }; throw e; }
      if (status.state === 'blocked') return { allowed: false, reason: 'quota' };
      if (status.state === 'available' || metadata.allowUnknownQuota === true) return { allowed: true };
      return { allowed: false, reason: 'admission_unavailable' };
    },
  };
}
