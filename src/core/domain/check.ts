import { BosunError } from '../errors.ts';
import { data, jobId, jobTime, utf8Bytes, type JobScope } from './job.ts';
import { workspaceText } from './workspace.ts';

export const CHECK_RUNNER = 'bosun-checks';
export const CHECK_LIMITS = Object.freeze({
  records: 1024,
  perReview: 16,
  args: 64,
  argBytes: 8192,
  executableBytes: 268435456,
  outputBytes: 262144,
  timeoutMs: 60000,
  maxTimeoutMs: 300000,
});
export type CheckExecutable = Readonly<{
  path: string;
  sha256: string;
  bytes: number;
  mode: number;
}>;
export type CheckOutcome = Readonly<{
  phase: 'closed';
  exitCode: number;
  stdoutHash: string;
  stdoutBytes: number;
  postRevision: string | null;
  checkout: 'matches' | 'stale' | 'withheld';
  command: 'matches' | 'changed' | 'withheld';
}>;
export type CheckReceipt = CheckOutcome | Readonly<{ phase: 'unknown' | 'not_started' }>;
export type CheckRecord = Readonly<{
  id: string;
  projectId: string;
  requestId: string;
  reviewId: string;
  jobId: string | null;
  version: number;
  createdAt: number;
  root: string;
  revision: string;
  executable: CheckExecutable;
  args: readonly string[];
  environmentHash: string;
  timeoutMs: number;
  commandHash: string;
  requestHash: string;
  outcome: CheckReceipt | null;
}>;
export type CheckStorage = {
  findRequest(scope: JobScope, requestId: string): CheckRecord | null;
  get(scope: JobScope, id: string): CheckRecord;
  list(scope: JobScope, reviewId: string): CheckRecord[];
  reserve(scope: JobScope, record: CheckRecord): { record: CheckRecord; duplicate: boolean };
};
const sha = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function checkArgs(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > CHECK_LIMITS.args)
    throw new BosunError('invalid', 'Invalid check arguments');
  const result: string[] = [];
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const argument = data(value, String(i));
    if (typeof argument !== 'string') throw new BosunError('invalid', 'Invalid check argument');
    if (argument !== '') workspaceText(argument, CHECK_LIMITS.argBytes);
    bytes += utf8Bytes(argument);
    if (bytes > CHECK_LIMITS.argBytes) throw new BosunError('invalid', 'Check argument budget');
    result.push(argument);
  }
  return Object.freeze(result);
}
export function checkExecutable(input: CheckExecutable): CheckExecutable {
  const path = workspaceText(data(input, 'path'));
  const sha256 = data(input, 'sha256'),
    bytes = data(input, 'bytes'),
    mode = data(input, 'mode');
  if (
    !path.startsWith('/') ||
    !sha(sha256) ||
    !Number.isSafeInteger(bytes) ||
    Number(bytes) < 1 ||
    Number(bytes) > CHECK_LIMITS.executableBytes ||
    !Number.isSafeInteger(mode) ||
    Number(mode) < 0 ||
    Number(mode) > 0o7777
  )
    throw new BosunError('invalid', 'Invalid command identity');
  return Object.freeze({
    path,
    sha256: sha256 as string,
    bytes: Number(bytes),
    mode: Number(mode),
  });
}
export function checkOutcome(input: unknown): CheckReceipt {
  const phase = data(input, 'phase');
  if (phase === 'unknown' || phase === 'not_started') return Object.freeze({ phase });
  if (phase !== 'closed') throw new BosunError('invalid', 'Invalid check receipt');
  const value = Object.fromEntries(
    ['phase', 'exitCode', 'stdoutHash', 'stdoutBytes', 'postRevision', 'checkout', 'command'].map(
      (key) => [key, data(input, key)],
    ),
  );
  if (
    !Number.isSafeInteger(value.exitCode) ||
    Number(value.exitCode) < 0 ||
    Number(value.exitCode) > 255 ||
    !sha(value.stdoutHash) ||
    !Number.isSafeInteger(value.stdoutBytes) ||
    Number(value.stdoutBytes) < 0 ||
    Number(value.stdoutBytes) > CHECK_LIMITS.outputBytes ||
    (value.postRevision !== null && !sha(value.postRevision)) ||
    !['matches', 'stale', 'withheld'].includes(value.checkout as string) ||
    !['matches', 'changed', 'withheld'].includes(value.command as string)
  )
    throw new BosunError('invalid', 'Invalid check outcome');
  return Object.freeze(value) as CheckOutcome;
}
export function checkRecord(input: CheckRecord): CheckRecord {
  const value = Object.fromEntries(
    [
      'id',
      'projectId',
      'requestId',
      'reviewId',
      'jobId',
      'version',
      'createdAt',
      'root',
      'revision',
      'executable',
      'args',
      'environmentHash',
      'timeoutMs',
      'commandHash',
      'requestHash',
      'outcome',
    ].map((key) => [key, data(input, key)]),
  );
  for (const key of ['id', 'projectId', 'requestId', 'reviewId', 'root']) workspaceText(value[key]);
  jobId(value.requestId);
  jobTime(value.createdAt as number);
  if (
    !/^chk_[a-f0-9]{32}$/.test(value.id as string) ||
    !/^p_[a-f0-9]{16}$/.test(value.projectId as string) ||
    !/^rev_[a-f0-9]{32}$/.test(value.reviewId as string) ||
    !(value.root as string).startsWith('/') ||
    !Number.isSafeInteger(value.version) ||
    Number(value.version) < 1
  )
    throw new BosunError('invalid', 'Invalid check record');
  if (value.jobId !== null) jobId(value.jobId);
  for (const key of ['revision', 'environmentHash', 'commandHash', 'requestHash'])
    if (!sha(value[key])) throw new BosunError('invalid', 'Invalid check fingerprint');
  if (
    !Number.isSafeInteger(value.timeoutMs) ||
    Number(value.timeoutMs) < 1 ||
    Number(value.timeoutMs) > CHECK_LIMITS.maxTimeoutMs
  )
    throw new BosunError('invalid', 'Invalid check deadline');
  return Object.freeze({
    ...value,
    executable: checkExecutable(value.executable as CheckExecutable),
    args: checkArgs(value.args),
    outcome: value.outcome === null ? null : checkOutcome(value.outcome),
  }) as CheckRecord;
}
