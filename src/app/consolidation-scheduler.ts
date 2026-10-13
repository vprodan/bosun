import { BosunError } from '../core/errors.ts';
import { CONSOLIDATION_LIMITS } from '../core/domain/consolidation.ts';

// Scheduling only enqueues bounded work in the existing executor. It owns no runner or source recovery loop.
export function createConsolidationScheduler(options: { enabled: boolean; intervalMs: number; idle(): boolean; poll(signal: AbortSignal): Promise<void> }) {
  if (typeof options.enabled !== 'boolean' || !Number.isSafeInteger(options.intervalMs) || options.intervalMs < CONSOLIDATION_LIMITS.minPollMs || options.intervalMs > 86400000) throw new BosunError('invalid', 'Invalid consolidation schedule');
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined; let pending: Promise<void> | undefined; let stopped = false;
  const arm = () => { if (!stopped && options.enabled) { timer = setTimeout(() => { timer = undefined; void tick(); }, options.intervalMs); timer.unref(); } };
  const tick = async () => {
    if (stopped || !options.enabled || pending) return;
    if (timer) clearTimeout(timer); timer = undefined;
    if (!options.idle()) { arm(); return; }
    pending = Promise.resolve().then(() => options.poll(controller.signal));
    try { await pending; } catch { /* Finite held state belongs to the existing source/job ledger; never resubmit unknown work here. */ }
    finally { pending = undefined; arm(); }
  };
  arm();
  return { tick, async close() { stopped = true; if (timer) clearTimeout(timer); timer = undefined; controller.abort(); try { await pending; } catch {} } };
}
