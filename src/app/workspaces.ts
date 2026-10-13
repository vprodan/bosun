import crypto from 'node:crypto';
import path from 'node:path';
import { BosunError } from '../core/errors.ts';
import { createWorkspaceService } from '../core/use-cases/workspaces.ts';
import type { Workspace } from '../core/ports/workspace.ts';
import { createGitWorkspace } from '../adapters/workspaces/git.ts';
import type { Env } from '../core/domain/inference.ts';
import type { openDaemonJobs } from './jobs.ts';
import { WORKSPACE_LIMITS } from '../core/domain/workspace.ts';
import {
  acceptedJob,
  data,
  jobId,
  jobScope,
  type JobInput,
  type JobScope,
  type JobSnapshot,
  type AdmissionMetadata,
} from '../core/domain/job.ts';
import { requirePublicInput } from '../core/policy.ts';
import { screenPublicText } from '../core/secret-screen.ts';

type PublicJob = Omit<JobInput, 'cwd' | 'ownerOnly' | 'workspaceId' | 'workspaceVersion'>;
type WorkspaceJob = PublicJob & { id: string; expectedVersion: number };
type SpinJob = PublicJob & { name: string; base?: string };

export function createDaemonWorkspaces(options: {
  home: string;
  jobs: ReturnType<typeof openDaemonJobs>;
  env: Env;
  schedule?(): void;
  driver?: Workspace & Required<Pick<Workspace, 'repository' | 'inspect'>>;
}) {
  const root = path.join(options.home, 'worktrees');
  const driver = options.driver ?? createGitWorkspace({ root, env: options.env });
  const service = createWorkspaceService({
    storage: options.jobs.workspaces,
    driver,
    path: (id) => path.join(root, id),
    id: () => `w_${crypto.randomUUID().replaceAll('-', '')}`,
    now: Date.now,
    hash: (text) => crypto.createHash('sha256').update(text).digest('hex'),
  });
  const shutdown = new AbortController();
  const pending = new Set<Promise<unknown>>();
  let closed = false;
  function owner(scope: JobScope) {
    const trusted = jobScope(scope);
    if (trusted.audience !== 'owner')
      throw new BosunError('unsupported', 'Owner workspace operation required');
    return trusted;
  }
  function request(input: PublicJob) {
    requirePublicInput(input);
    const requestId = jobId(data(input, 'requestId'));
    screenPublicText(requestId);
    return requestId;
  }
  function publicJob(input: PublicJob, cwd: string): JobInput {
    requirePublicInput(input);
    const capture: Record<string, unknown> = { cwd };
    for (const key of [
      'privacy',
      'requestId',
      'taskId',
      'runnerId',
      'prompt',
      'access',
      'model',
      'effort',
      'maxTurns',
      'allowUnknownQuota',
      'policy',
    ]) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor) continue;
      if (!Object.hasOwn(descriptor, 'value'))
        throw new BosunError('invalid', 'Invalid workspace job input');
      capture[key] = descriptor.value;
    }
    return acceptedJob(capture as JobInput);
  }
  async function queue(input: WorkspaceJob, scope: JobScope, from: string, signal: AbortSignal) {
    const trusted = owner(scope);
    const requestId = request(input);
    const id = jobId(data(input, 'id'));
    const existing = options.jobs.findRequest(trusted, requestId);
    if (existing) {
      if (options.jobs.workspaces.jobWorkspace(trusted, existing.id) !== id)
        throw new BosunError('conflict', 'Job request belongs to another workspace');
      const record = await service.get(trusted, from, id, signal);
      return { record, job: existing, duplicate: true };
    }
    const accepted = publicJob(input, from);
    const version = data(input, 'expectedVersion');
    const record = await service.get(trusted, from, id, signal);
    if (record.state !== 'ready' || record.version !== version)
      throw new BosunError('conflict', 'Workspace version or creation receipt changed');
    const observed = await driver.inspect(record, signal);
    if (observed.state !== 'present' || observed.prunable)
      throw new BosunError('conflict', 'Workspace identity changed');
    if (signal.aborted) throw new BosunError('cancelled', 'Workspace dispatch cancelled');
    const result = options.jobs.submit(
      { ...accepted, cwd: record.path, workspaceId: record.id, workspaceVersion: record.version },
      trusted,
    );
    // A racing duplicate cannot bind an existing job from another path.
    if (options.jobs.workspaces.jobWorkspace(trusted, result.job.id) !== record.id)
      throw new BosunError('conflict', 'Job request belongs to another workspace');
    options.schedule?.();
    return { record, ...result };
  }
  async function operation<T>(
    run: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (closed) throw new BosunError('unavailable', 'Workspace authority draining');
    options.jobs.assertOwner();
    if (pending.size >= 8)
      throw new BosunError('unavailable', 'Workspace operation capacity reached');
    const control = AbortSignal.any([
      shutdown.signal,
      AbortSignal.timeout(WORKSPACE_LIMITS.timeoutMs),
      ...(signal ? [signal] : []),
    ]);
    const task = Promise.resolve().then(() => {
      if (control.aborted) throw new BosunError('cancelled', 'Workspace operation cancelled');
      return run(control);
    });
    pending.add(task);
    try {
      const result = await task;
      options.jobs.assertOwner();
      return result;
    } finally {
      pending.delete(task);
    }
  }
  return {
    submit(input: WorkspaceJob, scope: JobScope, from: string, signal?: AbortSignal) {
      owner(scope);
      return operation((control) => queue(input, scope, from, control), signal);
    },
    spin(input: SpinJob, scope: JobScope, from: string, signal?: AbortSignal) {
      const trusted = owner(scope);
      return operation(async (control) => {
        const requestId = request(input);
        const existing = options.jobs.findRequest(trusted, requestId);
        if (existing) {
          const id = options.jobs.workspaces.jobWorkspace(trusted, existing.id);
          if (!id) throw new BosunError('conflict', 'Job request is not a workspace launch');
          return {
            record: await service.get(trusted, from, id, control),
            job: existing,
            duplicate: true,
          };
        }
        const accepted = publicJob(input, from); // screening before any worktree creation
        const created = await service.create(
          {
            requestId,
            name: data(input, 'name') as string,
            ...(Object.getOwnPropertyDescriptor(input, 'base')
              ? { base: data(input, 'base') as string }
              : {}),
          },
          trusted,
          from,
          control,
        );
        if (created.record.state !== 'ready')
          return {
            record: created.record,
            job: null,
            duplicate: created.duplicate,
            state: 'held' as const,
          };
        return queue(
          { ...accepted, id: created.record.id, expectedVersion: created.record.version },
          trusted,
          from,
          control,
        );
      }, signal);
    },
    admit(job: Readonly<JobSnapshot>, signal: AbortSignal, metadata: AdmissionMetadata) {
      return operation(async (control) => {
        if (!metadata.workspaceId) return false;
        const scope = { projectId: job.projectId, audience: 'owner' as const };
        if (options.jobs.workspaces.jobWorkspace(scope, job.id) !== metadata.workspaceId)
          return false;
        const record = await service.get(scope, metadata.cwd, metadata.workspaceId, control);
        if (
          record.state !== 'ready' ||
          record.version !== metadata.workspaceVersion ||
          record.path !== metadata.cwd
        )
          return false;
        const observed = await driver.inspect(record, control);
        return observed.state === 'present' && !observed.prunable;
      }, signal);
    },
    create(...args: Parameters<typeof service.create>) {
      return operation((signal) => service.create(args[0], args[1], args[2], signal), args[3]);
    },
    get(...args: Parameters<typeof service.get>) {
      return operation((signal) => service.get(args[0], args[1], args[2], signal), args[3]);
    },
    list(...args: Parameters<typeof service.list>) {
      return operation((signal) => service.list(args[0], args[1], signal), args[2]);
    },
    reconcile(...args: Parameters<typeof service.reconcile>) {
      return operation((signal) => service.reconcile(args[0], args[1], args[2], signal), args[3]);
    },
    async close() {
      closed = true;
      shutdown.abort();
      await Promise.allSettled([...pending]);
    },
  };
}
