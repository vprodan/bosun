import { BosunError } from '../errors.ts';
import { data, jobId, jobTime, utf8Bytes, type JobScope, type JobSnapshot } from './job.ts';
import { screenPublicText } from '../secret-screen.ts';

export const WORKSPACE_LIMITS = Object.freeze({
  records: 64,
  outputBytes: 131072,
  timeoutMs: 10000,
});
export type WorkspaceRecord = Readonly<{
  id: string;
  requestId: string;
  projectId: string;
  repository: string;
  from: string;
  path: string;
  branch: string;
  base: string;
  name: string;
  state: 'creating' | 'ready' | 'unknown';
  version: number;
  createdAt: number;
  updatedAt: number;
}>;
export type WorkspaceRepository = Readonly<{
  root: string;
  common: string;
  head: string;
  projectId: string;
}>;
export type WorkspaceInspection = Readonly<{
  state: 'present' | 'missing' | 'changed';
  head: string | null;
  branch: string | null;
  dirty: boolean;
  locked: boolean;
  prunable: boolean;
  merged: boolean;
  revision: string;
}>;
export type WorkspaceStorage = {
  jobWorkspace(scope: JobScope, jobId: string): string | null;
  byPath(scope: JobScope, path: string): WorkspaceRecord | null;
  findRequest(scope: JobScope, requestId: string): WorkspaceRecord | null;
  get(scope: JobScope, id: string): WorkspaceRecord;
  list(scope: JobScope): WorkspaceRecord[];
  reserve(
    scope: JobScope,
    record: WorkspaceRecord,
  ): { record: WorkspaceRecord; duplicate: boolean };
  finish(
    scope: JobScope,
    id: string,
    version: number,
    state: 'ready' | 'unknown',
    at: number,
  ): WorkspaceRecord;
  jobs(scope: JobScope, path: string): JobSnapshot[];
};
export function workspaceText(value: unknown, max = 4096): string {
  if (
    typeof value !== 'string' ||
    !value ||
    /[\x00-\x1f\x7f]/.test(value) ||
    utf8Bytes(value) > max
  )
    throw new BosunError('invalid', 'Invalid workspace metadata');
  screenPublicText(value);
  return value;
}
export function workspaceRecord(input: WorkspaceRecord): WorkspaceRecord {
  const value = Object.fromEntries(
    [
      'id',
      'requestId',
      'projectId',
      'repository',
      'from',
      'path',
      'branch',
      'base',
      'name',
      'state',
      'version',
      'createdAt',
      'updatedAt',
    ].map((key) => [key, data(input, key)]),
  );
  for (const key of [
    'id',
    'requestId',
    'projectId',
    'repository',
    'from',
    'path',
    'branch',
    'base',
    'name',
  ])
    workspaceText(value[key]);
  jobId(value.id);
  jobId(value.requestId);
  if (
    !/^w_[a-f0-9]{32}$/.test(value.id as string) ||
    !/^p_[a-f0-9]{16}$/.test(value.projectId as string) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/.test(value.name as string) ||
    !['repository', 'from', 'path'].every((key) => (value[key] as string).startsWith('/')) ||
    value.branch !== `bosun/${value.id}` ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.base as string) ||
    !['creating', 'ready', 'unknown'].includes(value.state as string) ||
    !Number.isSafeInteger(value.version) ||
    Number(value.version) < 1
  )
    throw new BosunError('invalid', 'Invalid workspace record');
  jobTime(value.createdAt as number);
  jobTime(value.updatedAt as number);
  return Object.freeze(value) as WorkspaceRecord;
}
