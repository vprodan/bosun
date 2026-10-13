import { BosunError } from '../errors.ts';
import { workspaceText } from './workspace.ts';
import { data, utf8Bytes } from './job.ts';
import { HOSTS } from './config.ts';
import type { HostId } from './config.ts';

export const REVIEW_LIMITS = Object.freeze({
  files: 1024,
  fileBytes: 1048576,
  sourceBytes: 33554432,
  promptBytes: 24576,
  records: 1024,
  snapshotBytes: 524288,
});
export type ReviewFile = Readonly<{
  path: string;
  tracked: boolean;
  index: string | null;
  indexMode: string | null;
  kind: 'file' | 'symlink' | 'missing';
  sha256: string | null;
  bytes: number;
  mode: number;
}>;
export type ReviewSnapshot = Readonly<{
  schema: 1;
  projectId: string;
  root: string;
  repository: string;
  branch: string;
  base: string;
  head: string;
  indexHash: string;
  statusHash: string;
  contentHash: string;
  revision: string;
  files: readonly ReviewFile[];
}>;
const sha = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function reviewPath(value: unknown): string {
  const path = workspaceText(value, 512);
  if (
    path.startsWith('/') ||
    path.includes('\\') ||
    path.split('/').some((part) => !part || part === '.' || part === '..') ||
    path.startsWith(':') ||
    path.split('/').includes('.git')
  )
    throw new BosunError('invalid', 'Invalid review path');
  // Source classification precedes payload. Explicitly public input does not
  // promote known credential stores into review material.
  if (
    path
      .split('/')
      .some((part) =>
        /^\.env(?:\.|$)|^(?:credentials|secrets)(?:\.(?:json|ya?ml|toml)|$)|^\.(?:claude|codex|aws|ssh|npmrc|netrc)$/.test(
          part,
        ),
      )
  )
    throw new BosunError('private_input', 'Review source withheld');
  return path;
}
export function reviewPaths(input: unknown): readonly string[] | null {
  if (input === undefined || input === null) return null;
  if (!Array.isArray(input) || input.length < 1 || input.length > 64)
    throw new BosunError('invalid', 'Invalid review batch');
  const paths: string[] = [];
  for (let i = 0; i < input.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(i));
    if (!descriptor || !Object.hasOwn(descriptor, 'value'))
      throw new BosunError('invalid', 'Invalid review batch');
    paths.push(reviewPath(descriptor.value));
  }
  return Object.freeze([...new Set(paths)].sort());
}
export function reviewSnapshot(input: ReviewSnapshot): ReviewSnapshot {
  const fields = [
    'schema',
    'projectId',
    'root',
    'repository',
    'branch',
    'base',
    'head',
    'indexHash',
    'statusHash',
    'contentHash',
    'revision',
    'files',
  ];
  const value = Object.fromEntries(fields.map((key) => [key, data(input, key)]));
  if (
    value.schema !== 1 ||
    typeof value.projectId !== 'string' ||
    !/^p_[a-f0-9]{16}$/.test(value.projectId) ||
    !Array.isArray(value.files) ||
    value.files.length > REVIEW_LIMITS.files
  )
    throw new BosunError('invalid', 'Invalid review snapshot');
  for (const key of ['root', 'repository', 'branch']) workspaceText(value[key]);
  if (!(value.root as string).startsWith('/') || !(value.repository as string).startsWith('/'))
    throw new BosunError('invalid', 'Invalid review snapshot');
  for (const key of ['base', 'head'])
    if (
      typeof value[key] !== 'string' ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value[key] as string)
    )
      throw new BosunError('invalid', 'Invalid review snapshot');
  for (const key of ['indexHash', 'statusHash', 'contentHash', 'revision'])
    if (!sha(value[key])) throw new BosunError('invalid', 'Invalid review hash');
  let previous = '';
  let bytes = 0;
  const files = value.files.map((input: unknown) => {
    const file = Object.fromEntries(
      ['path', 'tracked', 'index', 'indexMode', 'kind', 'sha256', 'bytes', 'mode'].map((key) => [
        key,
        data(input, key),
      ]),
    );
    const path = reviewPath(file.path);
    if (
      path <= previous ||
      typeof file.tracked !== 'boolean' ||
      typeof file.kind !== 'string' ||
      !['file', 'symlink', 'missing'].includes(file.kind) ||
      (file.kind === 'missing' ? file.sha256 !== null : !sha(file.sha256))
    )
      throw new BosunError('invalid', 'Invalid review file');
    previous = path;
    if (
      file.tracked
        ? typeof file.index !== 'string' ||
          !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(file.index) ||
          typeof file.indexMode !== 'string' ||
          !['100644', '100755', '120000'].includes(file.indexMode)
        : file.index !== null || file.indexMode !== null
    )
      throw new BosunError('invalid', 'Invalid review index');
    if (
      !Number.isSafeInteger(file.bytes) ||
      Number(file.bytes) < 0 ||
      Number(file.bytes) > REVIEW_LIMITS.fileBytes ||
      !Number.isSafeInteger(file.mode) ||
      Number(file.mode) < 0 ||
      Number(file.mode) > 0o7777
    )
      throw new BosunError('invalid', 'Invalid review file size');
    bytes += Number(file.bytes);
    if (bytes > REVIEW_LIMITS.sourceBytes) throw new BosunError('invalid', 'Review source limit');
    return Object.freeze(file) as ReviewFile;
  });
  const accepted = { ...value, files: Object.freeze(files) } as ReviewSnapshot;
  if (utf8Bytes(JSON.stringify(accepted)) > REVIEW_LIMITS.snapshotBytes)
    throw new BosunError('invalid', 'Review snapshot limit');
  return Object.freeze(accepted);
}
export type ReviewRecord = Readonly<{
  id: string;
  requestId: string;
  projectId: string;
  version: number;
  createdAt: number;
  baseRef: string;
  paths: readonly string[] | null;
  requestHash: string;
  runnerId: string;
  model: string;
  effort: string | null;
  sourceHost: HostId | null;
  jobId: string | null;
  snapshot: ReviewSnapshot;
}>;
export type ReviewStorage = {
  findRequest(scope: import('./job.ts').JobScope, requestId: string): ReviewRecord | null;
  get(scope: import('./job.ts').JobScope, id: string): ReviewRecord;
  reserve(
    scope: import('./job.ts').JobScope,
    record: ReviewRecord,
  ): { record: ReviewRecord; duplicate: boolean };
};
export function reviewRecord(input: ReviewRecord): ReviewRecord {
  const value = Object.fromEntries(
    [
      'id',
      'requestId',
      'projectId',
      'version',
      'createdAt',
      'baseRef',
      'paths',
      'requestHash',
      'runnerId',
      'model',
      'effort',
      'sourceHost',
      'jobId',
      'snapshot',
    ].map((key) => [key, data(input, key)]),
  );
  for (const key of ['id', 'requestId', 'projectId', 'baseRef', 'runnerId', 'model'])
    workspaceText(value[key], 200);
  if (
    !/^rev_[a-f0-9]{32}$/.test(value.id as string) ||
    !/^[a-zA-Z0-9_-]{1,80}$/.test(value.requestId as string) ||
    !HOSTS.includes(value.runnerId as HostId) ||
    !Number.isSafeInteger(value.version) ||
    Number(value.version) < 1 ||
    !Number.isSafeInteger(value.createdAt) ||
    Number(value.createdAt) < 0
  )
    throw new BosunError('invalid', 'Invalid review record');
  if (value.effort !== null) workspaceText(value.effort, 80);
  if (
    (value.sourceHost !== null &&
      !HOSTS.includes(value.sourceHost as HostId)) ||
    (value.jobId !== null &&
      (typeof value.jobId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value.jobId)))
  )
    throw new BosunError('invalid', 'Invalid review linkage');
  const snapshot = reviewSnapshot(value.snapshot as ReviewSnapshot);
  if (snapshot.projectId !== value.projectId)
    throw new BosunError('invalid', 'Invalid review scope');
  const paths = reviewPaths(value.paths);
  if (!sha(value.requestHash)) throw new BosunError('invalid', 'Invalid review request hash');
  return Object.freeze({ ...value, snapshot, paths }) as ReviewRecord;
}
