import { BosunError } from '../core/errors.ts';
import type { JobEvent } from '../core/domain/job.ts';
import { rpcRequest, type RpcRequest } from './rpc.ts';

export const JOB_STREAM_LIMITS = Object.freeze({ subscribers: 16, batch: 100, frameBytes: 2048, batchBytes: 65536,
  pollMs: 100, heartbeatMs: 5000, stallMs: 5000, lifetimeMs: 60000 });
const own = (value: unknown, key: string): unknown => {
  const descriptor = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, key) : undefined;
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
};
export function projectJobEvent(value: unknown): JobEvent {
  try {
    const seq = own(value, 'seq'); const jobId = own(value, 'jobId'); const version = own(value, 'version'); const at = own(value, 'at');
    const state = own(value, 'state'); const kind = own(value, 'kind'); const reason = own(value, 'reason');
    if (!Number.isSafeInteger(seq) || Number(seq) < 1 || !Number.isSafeInteger(version) || Number(version) < 1
      || !Number.isSafeInteger(at) || Number(at) < 0 || Number(at) > 8_640_000_000_000_000
      || typeof jobId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(jobId)
      || !['queued', 'held', 'running', 'succeeded', 'failed', 'cancelled', 'unknown'].includes(state as string)
      || !['created', 'state', 'cancel', 'text', 'tool', 'file', 'permission', 'usage'].includes(kind as string)
      || reason !== null && !['quota', 'approval', 'admission_unavailable', 'runner_unavailable', 'unsupported', 'cancel_requested',
        'interrupted', 'runner_lost', 'output_limit', 'event_limit', 'runner_failed'].includes(reason as string)) throw 0;
    return { seq: Number(seq), jobId, version: Number(version), at: Number(at), state, kind, reason } as JobEvent;
  } catch { throw new BosunError('unavailable', 'Job events unavailable'); }
}
export function jobEventsRequest(value: unknown): RpcRequest & { params: { after: number; limit: number } } {
  const request = rpcRequest(value);
  if (request.method !== 'job.events' || !request.scope || Object.keys(request.params).some(key => !['after', 'limit'].includes(key))
    || !Number.isSafeInteger(request.params.after) || Number(request.params.after) < 0
    || request.params.limit !== undefined && (!Number.isSafeInteger(request.params.limit) || Number(request.params.limit) < 1 || Number(request.params.limit) > JOB_STREAM_LIMITS.batch)) {
    throw new BosunError('invalid', 'Invalid event request');
  }
  return Object.freeze({ ...request, scope: Object.freeze({ ...request.scope }),
    params: Object.freeze({ after: Number(request.params.after), limit: Number(request.params.limit ?? 50) }) });
}
