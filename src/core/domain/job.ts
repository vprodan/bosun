import { BosunError } from '../errors.ts';
import { requirePublicInput } from '../policy.ts';
import { screenPublicText } from '../secret-screen.ts';
import type { Access } from './task.ts';
import type { NativeUsage } from './usage.ts';
import { dispatchPolicy, type DispatchPolicy } from '../dispatch-policy.ts';

export type JobScope = { projectId: string | null; audience?: 'owner' | 'model' };
export type JobState =
  | 'queued'
  | 'held'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'unknown';
export type JobReason =
  | 'quota'
  | 'approval'
  | 'admission_unavailable'
  | 'runner_unavailable'
  | 'unsupported'
  | 'cancel_requested'
  | 'interrupted'
  | 'runner_lost'
  | 'output_limit'
  | 'event_limit'
  | 'runner_failed';
export type JobInput = {
  privacy: 'public';
  requestId: string;
  taskId: string;
  runnerId: string;
  prompt: string;
  cwd: string;
  access: Access;
  model: string;
  effort?: string;
  maxTurns?: number;
  ownerOnly?: boolean;
  allowUnknownQuota?: boolean;
  workspaceId?: string;
  workspaceVersion?: number;
  reviewId?: string;
  checkId?: string;
  managedId?: string;
  managedVersion?: number;
  policy?: DispatchPolicy;
  submittedBy?: 'owner' | 'model';
};
export type JobSnapshot = {
  id: string;
  projectId: string | null;
  requestId: string;
  taskId: string;
  runnerId: string;
  state: JobState;
  version: number;
  createdAt: number;
  updatedAt: number;
  cancelRequested: boolean;
  reason: JobReason | null;
  ownerOnly: boolean;
  allowUnknownQuota: boolean;
  retained?: 'receipt';
};
export const JOB_RETENTION = Object.freeze({
  days: 30,
  receipts: 16384,
  dailyGroups: 16384,
  batch: 100,
});
export type JobRetentionStatus = {
  days: number;
  scopedJobs: number;
  scopedReceipts: number;
  scopedAttempts: number;
  scopedDailyGroups: number;
  eligibleJobs: number;
  uncertainJobs: number;
  capacity: {
    jobs: number;
    queued: number;
    receipts: number;
    dailyGroups: number;
    events: number;
    attempts: number;
  };
  pressure: boolean;
};
export type JobPruneReceipt = { jobs: number; attempts: number; capacityHeld: boolean };
export type JobEventKind =
  | 'created'
  | 'state'
  | 'cancel'
  | 'text'
  | 'tool'
  | 'file'
  | 'permission'
  | 'usage';
// Closed metadata only. Runner text, tool names/targets, paths and results never enter this stream.
export type JobEvent = {
  seq: number;
  jobId: string;
  state: JobState;
  version: number;
  at: number;
  kind: JobEventKind;
  reason: JobReason | null;
};
export type JobChange = {
  state: JobState;
  kind: Exclude<JobEventKind, 'created'>;
  reason?: JobReason | null;
  cancelRequested?: true;
  result?: string;
  usage?: NativeUsage;
};
export type Admission =
  | { allowed: true }
  | { allowed: false; reason: 'quota' | 'approval' | 'admission_unavailable' };
export type AdmissionMetadata = Readonly<{
  model: string;
  effort?: string;
  cwd: string;
  access: Access;
  allowUnknownQuota: boolean;
  workspaceId?: string;
  workspaceVersion?: number;
  reviewId?: string;
  checkId?: string;
  managedId?: string;
  managedVersion?: number;
  policy?: DispatchPolicy;
  submittedBy?: 'owner' | 'model';
}>;
export const JOB_LIMITS = Object.freeze({
  promptBytes: 32768,
  inputBytes: 65536,
  resultBytes: 65536,
  eventBatch: 100,
  runnerEvents: 2048,
});
const STATES: readonly string[] = [
  'queued',
  'held',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'unknown',
];
const REASONS: readonly string[] = [
  'quota',
  'approval',
  'admission_unavailable',
  'runner_unavailable',
  'unsupported',
  'cancel_requested',
  'interrupted',
  'runner_lost',
  'output_limit',
  'event_limit',
  'runner_failed',
];
const KINDS: readonly string[] = ['state', 'cancel', 'text', 'tool', 'file', 'permission', 'usage'];
export const terminalJob = (state: JobState): boolean =>
  ['succeeded', 'failed', 'cancelled', 'unknown'].includes(state);
export function jobTime(now: number): number {
  if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000)
    throw new BosunError('unavailable', 'Job clock unavailable');
  return now;
}
export function jobId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value))
    throw new BosunError('invalid', 'Invalid job identifier');
  return value;
}
export function jobScope(scope: JobScope): JobScope {
  const projectId = data(scope, 'projectId');
  const audience = optional(scope, 'audience');
  if (
    projectId !== null &&
    (typeof projectId !== 'string' ||
      !projectId.length ||
      projectId.length > 200 ||
      projectId.includes('\0'))
  )
    throw new BosunError('invalid', 'Invalid job scope');
  if (audience !== undefined && audience !== 'owner' && audience !== 'model')
    throw new BosunError('invalid', 'Invalid job audience');
  return { projectId: projectId as string | null, ...(audience === undefined ? {} : { audience }) };
}
export function data(value: unknown, key: string): unknown {
  try {
    const property =
      value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, key) : undefined;
    if (property && Object.hasOwn(property, 'value')) return property.value;
  } catch {
    /* finite validation failure */
  }
  throw new BosunError('invalid', 'Invalid job input');
}
export function utf8Bytes(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const n = char.codePointAt(0)!;
    bytes += n <= 0x7f ? 1 : n <= 0x7ff ? 2 : n <= 0xffff ? 3 : 4;
  }
  return bytes;
}
function string(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || utf8Bytes(value) > max)
    throw new BosunError('invalid', 'Invalid job input');
  return value;
}
export function acceptedJob(input: JobInput): JobInput {
  requirePublicInput(input); // before every prompt/content property, including throwing getters
  const requestId = jobId(data(input, 'requestId'));
  const taskId = jobId(data(input, 'taskId'));
  const runnerId = jobId(data(input, 'runnerId'));
  const ownerOnly = optional(input, 'ownerOnly');
  if (ownerOnly !== undefined && typeof ownerOnly !== 'boolean')
    throw new BosunError('invalid', 'Invalid job visibility');
  const allowUnknownQuota = optional(input, 'allowUnknownQuota');
  if (allowUnknownQuota !== undefined && typeof allowUnknownQuota !== 'boolean')
    throw new BosunError('invalid', 'Invalid quota permission');
  const prompt = string(data(input, 'prompt'), JOB_LIMITS.promptBytes);
  screenPublicText(prompt);
  const cwd = string(data(input, 'cwd'), 4096);
  const access = data(input, 'access');
  if (!cwd.startsWith('/') || (access !== 'read' && access !== 'edit'))
    throw new BosunError('invalid', 'Invalid job input');
  const model = string(data(input, 'model'), 200);
  const effort = optional(input, 'effort');
  const maxTurns = optional(input, 'maxTurns');
  if (
    maxTurns !== undefined &&
    (!Number.isSafeInteger(maxTurns) || Number(maxTurns) < 1 || Number(maxTurns) > 100)
  )
    throw new BosunError('invalid', 'Invalid job input');
  const result: JobInput = {
    privacy: 'public',
    requestId,
    taskId,
    runnerId,
    prompt,
    cwd,
    access,
    model,
    ...(effort === undefined ? {} : { effort: string(effort, 80) }),
    ...(maxTurns === undefined ? {} : { maxTurns: Number(maxTurns) }),
    ...(ownerOnly === undefined ? {} : { ownerOnly }),
    ...(allowUnknownQuota === undefined ? {} : { allowUnknownQuota }),
    ...workspaceBinding(input),
    ...reviewBinding(input),
    ...checkBinding(input),
    ...managedBinding(input),
    ...dispatchMetadata(input),
  };
  for (const value of Object.values(result)) if (typeof value === 'string') screenPublicText(value);
  if (utf8Bytes(JSON.stringify(result)) > JOB_LIMITS.inputBytes)
    throw new BosunError('invalid', 'Job input too large');
  return result;
}
export function admissionMetadata(input: JobInput): AdmissionMetadata {
  requirePublicInput(input);
  const model = string(data(input, 'model'), 200);
  const cwd = string(data(input, 'cwd'), 4096);
  const access = data(input, 'access');
  const effort = optional(input, 'effort');
  const allow = optional(input, 'allowUnknownQuota');
  if (
    !cwd.startsWith('/') ||
    (access !== 'read' && access !== 'edit') ||
    (allow !== undefined && typeof allow !== 'boolean')
  )
    throw new BosunError('invalid', 'Invalid admission metadata');
  const result: AdmissionMetadata = {
    model,
    cwd,
    access,
    allowUnknownQuota: allow === true,
    ...(effort === undefined ? {} : { effort: string(effort, 80) }),
    ...workspaceBinding(input),
    ...reviewBinding(input),
    ...checkBinding(input),
    ...managedBinding(input),
    ...dispatchMetadata(input),
  };
  for (const value of Object.values(result)) if (typeof value === 'string') screenPublicText(value);
  return Object.freeze(result);
}
function dispatchMetadata(input: unknown): Pick<JobInput, 'policy' | 'submittedBy'> {
  const policy = optional(input, 'policy'),
    submittedBy = optional(input, 'submittedBy');
  if (submittedBy !== undefined && submittedBy !== 'owner' && submittedBy !== 'model')
    throw new BosunError('invalid', 'Invalid job origin');
  return {
    ...(policy === undefined ? {} : { policy: dispatchPolicy(policy) }),
    ...(submittedBy === undefined ? {} : { submittedBy }),
  };
}
function checkBinding(input: unknown): Pick<JobInput, 'checkId'> {
  const checkId = optional(input, 'checkId');
  if (checkId === undefined) return {};
  if (typeof checkId !== 'string' || !/^chk_[a-f0-9]{32}$/.test(checkId))
    throw new BosunError('invalid', 'Invalid check binding');
  return { checkId };
}
function reviewBinding(input: unknown): Pick<JobInput, 'reviewId'> {
  const reviewId = optional(input, 'reviewId');
  if (reviewId === undefined) return {};
  if (typeof reviewId !== 'string' || !/^rev_[a-f0-9]{32}$/.test(reviewId))
    throw new BosunError('invalid', 'Invalid review job binding');
  return { reviewId };
}
function workspaceBinding(input: unknown): Pick<JobInput, 'workspaceId' | 'workspaceVersion'> {
  if (
    optional(input, 'managedId') !== undefined &&
    (optional(input, 'reviewId') !== undefined || optional(input, 'checkId') !== undefined)
  )
    throw new BosunError('invalid', 'Conflicting managed job binding');
  const id = optional(input, 'workspaceId');
  const version = optional(input, 'workspaceVersion');
  if (id === undefined && version === undefined) return {};
  if (
    typeof id !== 'string' ||
    !/^w_[a-f0-9]{32}$/.test(id) ||
    !Number.isSafeInteger(version) ||
    Number(version) < 1
  )
    throw new BosunError('invalid', 'Invalid workspace job binding');
  return { workspaceId: id, workspaceVersion: Number(version) };
}
function managedBinding(input: unknown): Pick<JobInput, 'managedId' | 'managedVersion'> {
  const id = optional(input, 'managedId'),
    version = optional(input, 'managedVersion');
  if (id === undefined && version === undefined) return {};
  if (
    typeof id !== 'string' ||
    !/^ms_[a-f0-9]{32}$/.test(id) ||
    !Number.isSafeInteger(version) ||
    Number(version) < 0
  )
    throw new BosunError('invalid', 'Invalid managed job binding');
  return { managedId: id, managedVersion: Number(version) };
}
function optional(input: unknown, key: string): unknown {
  try {
    if (Object.getOwnPropertyDescriptor(input, key) === undefined) return undefined;
  } catch {
    throw new BosunError('invalid', 'Invalid job input');
  }
  return data(input, key);
}
export function changedJob(job: JobSnapshot, change: JobChange, now: number): JobSnapshot {
  jobTime(now);
  const allowed: Record<JobState, readonly JobState[]> = {
    queued: ['running', 'held', 'cancelled'],
    held: ['held', 'queued', 'cancelled'],
    running: ['running', 'succeeded', 'failed', 'unknown'],
    succeeded: [],
    failed: [],
    cancelled: [],
    unknown: [],
  };
  if (
    !STATES.includes(change.state) ||
    !KINDS.includes(change.kind) ||
    !allowed[job.state].includes(change.state) ||
    (change.reason != null && !REASONS.includes(change.reason)) ||
    (change.result !== undefined &&
      (!['succeeded', 'failed'].includes(change.state) ||
        typeof change.result !== 'string' ||
        utf8Bytes(change.result) > JOB_LIMITS.resultBytes))
  ) {
    throw new BosunError('conflict', 'Invalid job transition');
  }
  return {
    ...job,
    state: change.state,
    version: job.version + 1,
    updatedAt: now,
    cancelRequested: job.cancelRequested || change.cancelRequested === true,
    reason: change.reason ?? null,
  };
}
