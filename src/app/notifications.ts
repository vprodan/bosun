import crypto from 'node:crypto';
import { BosunError } from '../core/errors.ts';
import { jobScope, type JobScope } from '../core/domain/job.ts';
import { NOTIFICATION_LIMITS, notificationJob, notificationState, notificationDelivery, type NotificationSink, type NotificationReason, type NotificationDelivery } from '../core/domain/notifications.ts';
import type { openDaemonJobs } from './jobs.ts';

export function createNotificationService(options: { enabled: boolean; jobs: ReturnType<typeof openDaemonJobs>; sink?: () => NotificationSink; timeoutMs?: number }) {
  const timeoutMs = options.timeoutMs ?? NOTIFICATION_LIMITS.timeoutMs;
  if (typeof options.enabled !== 'boolean' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) throw new BosunError('invalid', 'Invalid notification policy');
  let started = false; let closing = false; let pending: Promise<void> | null = null; let control: AbortController | null = null; let again = false;
  let held: NotificationReason | null = null; let sink: NotificationSink | undefined;
  async function flush() {
    while (!closing && held !== 'storage_held') {
      const receipt = options.jobs.notifications.next(); if (!receipt) return;
      try { sink ??= options.sink?.(); } catch { sink = undefined; }
      if (!sink) { options.jobs.notifications.finish(receipt.id, { phase: 'held', reason: 'sink_missing', ui: 'unverified' }); continue; }
      let available: ReturnType<NotificationSink['availability']>;
      try { available = sink.availability(); } catch { available = { available: false, reason: 'command_missing' }; }
      if (!available.available) { options.jobs.notifications.finish(receipt.id, { phase: 'held', reason: available.reason, ui: 'unverified' }); continue; }
      control = new AbortController(); const signal = AbortSignal.any([control.signal, AbortSignal.timeout(timeoutMs)]);
      options.jobs.notifications.start(receipt.id);
      // The durable submitting receipt precedes the single callback. No storage
      // transaction spans native delivery, and no timeout releases live authority.
      let delivery: NotificationDelivery;
      try { delivery = notificationDelivery(await sink.deliver(Object.freeze({ jobRef: receipt.jobRef, state: receipt.state }), signal)); }
      catch { delivery = { phase: 'unknown' as const, reason: signal.aborted ? 'cancelled' as const : 'delivery_unknown' as const, ui: 'unverified' as const }; }
      if (signal.aborted && delivery.phase !== 'submitted') delivery = { phase: 'unknown', reason: 'cancelled', ui: 'unverified' };
      options.jobs.notifications.finish(receipt.id, delivery); control = null;
    }
  }
  const kick = () => {
    if (!options.enabled || !started || closing || held === 'storage_held') return;
    if (pending) { again = true; return; }
    pending = Promise.resolve().then(flush).catch(() => { held = 'storage_held'; control?.abort(); }).finally(() => {
      pending = null; control = null;
      if (again && !closing) { again = false; kick(); }
    });
  };
  return {
    start() {
      if (!options.enabled || started || closing) return;
      options.jobs.notifications.recover(); started = true; kick();
    },
    observe(input: unknown) {
      if (!options.enabled || closing || held === 'storage_held') return;
      try {
        const job = notificationJob(input); if (!notificationState(job.state)) return;
        const jobRef = 'job_' + crypto.createHash('sha256').update(job.id).digest('hex').slice(0, 24);
        const reserved = options.jobs.notifications.reserve(job, jobRef); if (reserved.capacityHeld) held = 'capacity';
        if (!reserved.duplicate && reserved.receipt) kick();
      } catch { held = 'storage_held'; control?.abort(); }
    },
    status(scope: JobScope) {
      const trusted = jobScope(scope); if (trusted.audience === 'model') throw new BosunError('unsupported', 'Owner operation required');
      if (!options.enabled) return { enabled: false, state: 'disabled' as const, reason: null, ui: 'unverified' as const, records: null };
      if (held === 'storage_held') return { enabled: true, state: 'held' as const, reason: held, ui: 'unverified' as const, records: null };
      const records = options.jobs.notifications.status(trusted); const pressure = !records.remaining || !records.pendingRemaining;
      return { enabled: true, state: closing ? 'closed' as const : pressure || records.unknown || records.held ? 'held' as const : 'ready' as const,
        reason: pressure ? 'capacity' as const : records.lastReason ?? held, ui: 'unverified' as const, records };
    },
    async settled() { while (pending) await pending; },
    async close() { if (!options.enabled) return; closing = true; control?.abort(); await pending; },
  };
}
