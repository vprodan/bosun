import { BosunError } from '../errors.ts';
import { data, jobId, jobTime, utf8Bytes, type JobScope } from './job.ts';
import { cardBinding, cardOwner, type CardBinding } from './card.ts';
import { workspaceText } from './workspace.ts';

export const WATCH_LIMITS = Object.freeze({
  records: 4096,
  recordBytes: 16384,
  pending: 4,
  timeoutMs: 10000,
});
export type WatchRecord = Readonly<{
  jobId: string;
  requestId: string;
  projectId: string;
  cwd: string;
  sourceSessionId: string | null;
  binding: CardBinding;
  near: string | null;
  handle: string | null;
  state: 'pending' | 'opened' | 'unknown' | 'not_started';
  version: number;
  createdAt: number;
  updatedAt: number;
}>;
export type WatchStorage = {
  find(scope: JobScope, jobId: string): WatchRecord | null;
  reserve(scope: JobScope, record: WatchRecord): { record: WatchRecord; duplicate: boolean };
  finish(
    scope: JobScope,
    jobId: string,
    version: number,
    state: Exclude<WatchRecord['state'], 'pending'>,
    handle: string | null,
    at: number,
  ): WatchRecord;
};
export function terminalHandle(input: unknown): string {
  const handle = workspaceText(input, 200);
  if (!/^term_[a-zA-Z0-9_-]+$/.test(handle))
    throw new BosunError('invalid', 'Invalid terminal handle');
  return handle;
}
export function watchRecord(input: WatchRecord): WatchRecord {
  const value = Object.fromEntries(
    [
      'jobId',
      'requestId',
      'projectId',
      'cwd',
      'sourceSessionId',
      'binding',
      'near',
      'handle',
      'state',
      'version',
      'createdAt',
      'updatedAt',
    ].map((key) => [key, data(input, key)]),
  );
  jobId(value.jobId);
  jobId(value.requestId);
  const binding = cardBinding(value.binding as CardBinding);
  cardOwner({ projectId: value.projectId as string, audience: 'owner' });
  workspaceText(value.cwd);
  if (value.sourceSessionId !== null) workspaceText(value.sourceSessionId, 200);
  if (value.near !== null) terminalHandle(value.near);
  if (value.handle !== null) terminalHandle(value.handle);
  if (
    value.projectId !== binding.projectId ||
    !(value.cwd as string).startsWith('/') ||
    !['pending', 'opened', 'unknown', 'not_started'].includes(value.state as string) ||
    (value.state === 'opened') !== (value.handle !== null) ||
    !Number.isSafeInteger(value.version) ||
    Number(value.version) < 1 ||
    utf8Bytes(JSON.stringify(value)) > WATCH_LIMITS.recordBytes
  )
    throw new BosunError('invalid', 'Invalid watch receipt');
  jobTime(value.createdAt as number);
  jobTime(value.updatedAt as number);
  return Object.freeze({ ...value, binding }) as WatchRecord;
}
