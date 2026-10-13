import { BosunError } from '../errors.ts';
import { data, jobId, jobTime, jobScope, type JobScope } from './job.ts';
import { workspaceText } from './workspace.ts';

export const CARD_STATUSES = ['todo', 'in-progress', 'in-review', 'completed'] as const;
export type CardStatus = (typeof CARD_STATUSES)[number];
export const CARD_LIMITS = Object.freeze({
  records: 4096,
  recordBytes: 16384,
  pending: 4,
  timeoutMs: 10000,
  commentBytes: 1024,
  outputBytes: 131072,
});
export type CardBinding = Readonly<{
  id: string;
  root: string;
  common: string;
  projectId: string;
  hostId: 'local';
  cliVersion: string;
}>;
export type CardObservation = Readonly<{
  binding: CardBinding;
  status: string | null;
  commentHash: string;
}>;
export type CardRecord = Readonly<{
  id: string;
  requestId: string;
  projectId: string;
  binding: CardBinding;
  status: CardStatus;
  commentHash: string | null;
  requestHash: string;
  state: 'pending' | 'applied' | 'unknown' | 'not_started';
  acknowledged: boolean;
  version: number;
  createdAt: number;
  updatedAt: number;
}>;
export type CardStorage = {
  findRequest(scope: JobScope, requestId: string): CardRecord | null;
  get(scope: JobScope, id: string): CardRecord;
  reserve(scope: JobScope, record: CardRecord): { record: CardRecord; duplicate: boolean };
  finish(
    scope: JobScope,
    id: string,
    version: number,
    state: 'applied' | 'unknown' | 'not_started',
    at: number,
  ): CardRecord;
  acknowledge(scope: JobScope, id: string, version: number, at: number): CardRecord;
};
export function cardStatus(value: unknown): CardStatus {
  if (!CARD_STATUSES.includes(value as CardStatus))
    throw new BosunError('invalid', 'Invalid card status');
  return value as CardStatus;
}
export function cardBinding(input: CardBinding): CardBinding {
  const value = Object.fromEntries(
    ['id', 'root', 'common', 'projectId', 'hostId', 'cliVersion'].map((key) => [
      key,
      data(input, key),
    ]),
  );
  for (const key of ['id', 'root', 'common', 'projectId', 'cliVersion']) workspaceText(value[key]);
  if (
    value.hostId !== 'local' ||
    !/^p_[a-f0-9]{16}$/.test(value.projectId as string) ||
    !/^[^|:\s]+::\//.test(value.id as string) ||
    !(value.id as string).endsWith(`::${value.root}`) ||
    !(value.root as string).startsWith('/') ||
    !(value.common as string).startsWith('/')
  )
    throw new BosunError('invalid', 'Invalid card binding');
  return Object.freeze(value) as CardBinding;
}
export function cardRecord(input: CardRecord): CardRecord {
  const value = Object.fromEntries(
    [
      'id',
      'requestId',
      'projectId',
      'binding',
      'status',
      'commentHash',
      'requestHash',
      'state',
      'acknowledged',
      'version',
      'createdAt',
      'updatedAt',
    ].map((key) => [key, data(input, key)]),
  );
  jobId(value.id);
  jobId(value.requestId);
  cardStatus(value.status);
  const binding = cardBinding(value.binding as CardBinding);
  if (
    !/^card_[a-f0-9]{32}$/.test(value.id as string) ||
    value.projectId !== binding.projectId ||
    (value.commentHash !== null && !/^[a-f0-9]{64}$/.test(value.commentHash as string)) ||
    !/^[a-f0-9]{64}$/.test(value.requestHash as string) ||
    !['pending', 'applied', 'unknown', 'not_started'].includes(value.state as string) ||
    typeof value.acknowledged !== 'boolean' ||
    (value.acknowledged && value.state !== 'unknown') ||
    !Number.isSafeInteger(value.version) ||
    Number(value.version) < 1
  )
    throw new BosunError('invalid', 'Invalid card receipt');
  jobTime(value.createdAt as number);
  jobTime(value.updatedAt as number);
  return Object.freeze({ ...value, binding }) as CardRecord;
}
export function cardOwner(input: JobScope): JobScope {
  const scope = jobScope(input);
  if (scope.audience !== 'owner' || scope.projectId === null)
    throw new BosunError('unsupported', 'Owner card operation required');
  return scope;
}
