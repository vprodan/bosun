import { BosunError } from '../errors.ts';
import { data, jobId, jobScope, type JobSnapshot, type JobScope } from './job.ts';

export const NOTIFICATION_LIMITS = Object.freeze({ receipts: 4096, maxReceipts: 16384, pending: 64, batch: 16, timeoutMs: 1500 });
export type NotificationState = 'held' | 'failed' | 'ready' | 'done';
export type NotificationPayload = Readonly<{ jobRef: string; state: NotificationState }>;
export type NotificationPhase = 'pending' | 'submitting' | 'submitted' | 'held' | 'unknown';
export type NotificationReason = 'sink_missing' | 'platform_unsupported' | 'command_missing' | 'delivery_unknown' | 'cancelled' | 'interrupted' | 'capacity' | 'storage_held';
export type NotificationDelivery = { phase: 'submitted' | 'held' | 'unknown'; reason: NotificationReason | null; ui: 'unverified' };
export type NotificationReceipt = NotificationPayload & { id: string; projectId: string | null; jobId: string; version: number; phase: NotificationPhase; reason: NotificationReason | null; ui: 'unverified' };
export type NotificationSink = { availability(): { available: true } | { available: false; reason: 'platform_unsupported' | 'command_missing' };
  deliver(payload: NotificationPayload, signal: AbortSignal): Promise<NotificationDelivery> };
export type NotificationEvent = Pick<JobSnapshot, 'id' | 'projectId' | 'state' | 'version'>;
export type NotificationStorage = {
  reserve(job: Readonly<NotificationEvent>, jobRef: string, at: number): { receipt: NotificationReceipt | null; duplicate: boolean; capacityHeld: boolean };
  next(): NotificationReceipt | null;
  start(id: string, at: number): NotificationReceipt;
  finish(id: string, delivery: NotificationDelivery, at: number): NotificationReceipt;
  recover(at: number): number;
  status(scope: JobScope): { pending: number; submitting: number; submitted: number; held: number; unknown: number; remaining: number; pendingRemaining: number; lastReason: NotificationReason | null };
};
export function notificationState(state: JobSnapshot['state']): NotificationState | null {
  return state === 'queued' ? 'ready' : state === 'held' || state === 'failed' ? state : state === 'succeeded' ? 'done' : null;
}
export function notificationJob(input: unknown): Pick<JobSnapshot, 'id' | 'projectId' | 'state' | 'version'> {
  const id = jobId(data(input, 'id')); const projectId = data(input, 'projectId'); const state = data(input, 'state'); const version = data(input, 'version');
  const scope = jobScope({ projectId } as JobScope);
  if (!['queued', 'held', 'running', 'succeeded', 'failed', 'cancelled', 'unknown'].includes(state as string) || !Number.isSafeInteger(version) || Number(version) < 1) throw new BosunError('invalid', 'Invalid notification event');
  return { id, projectId: scope.projectId, state: state as JobSnapshot['state'], version: Number(version) };
}
export function notificationPayload(input: unknown): NotificationPayload {
  const jobRef = data(input, 'jobRef'); const state = data(input, 'state');
  if (typeof jobRef !== 'string' || !/^job_[a-f0-9]{24}$/.test(jobRef) || !['held', 'failed', 'ready', 'done'].includes(state as string)
    || Object.keys(input as object).length !== 2) throw new BosunError('invalid', 'Invalid notification payload');
  return Object.freeze({ jobRef, state: state as NotificationState });
}
export function notificationDelivery(input: unknown): NotificationDelivery {
  try {
    const phase = data(input, 'phase'); const reason = data(input, 'reason'); const ui = data(input, 'ui');
    if (!['submitted', 'held', 'unknown'].includes(phase as string) || ui !== 'unverified' || reason !== null && !['sink_missing', 'platform_unsupported', 'command_missing', 'delivery_unknown', 'cancelled', 'interrupted', 'capacity', 'storage_held'].includes(reason as string)
      || phase === 'submitted' && reason !== null) throw 0;
    return { phase, reason, ui } as NotificationDelivery;
  } catch { return { phase: 'unknown', reason: 'delivery_unknown', ui: 'unverified' }; }
}
