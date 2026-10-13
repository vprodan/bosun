import { BosunError } from '../errors.ts';
import { jobId, jobScope, jobTime, type JobScope } from '../domain/job.ts';
import { screenPublicText } from '../secret-screen.ts';
import {
  workspaceRecord,
  workspaceText,
  type WorkspaceStorage,
  type WorkspaceRecord,
} from '../domain/workspace.ts';
import type { Workspace } from '../ports/workspace.ts';

export function createWorkspaceService(options: {
  storage: WorkspaceStorage;
  driver: Workspace & Required<Pick<Workspace, 'repository' | 'inspect'>>;
  path(id: string): string;
  id(): string;
  now(): number;
  hash(text: string): string;
}) {
  const { storage, driver } = options;
  function owner(scope: JobScope): JobScope {
    const trusted = jobScope(scope);
    if (trusted.audience !== 'owner' || !trusted.projectId)
      throw new BosunError('unsupported', 'Owner workspace operation required');
    return trusted;
  }
  async function bound(record: WorkspaceRecord, from: string, signal?: AbortSignal) {
    const repository = await driver.repository(from, undefined, signal);
    if (repository.common !== record.repository || repository.projectId !== record.projectId)
      throw new BosunError('not_found', 'Workspace not found in this repository');
    return repository;
  }
  return {
    async create(
      input: { requestId: string; name: string; base?: string },
      scope: JobScope,
      from: string,
      signal?: AbortSignal,
    ) {
      const trusted = owner(scope);
      const requestId = jobId(input.requestId);
      screenPublicText(requestId);
      // Durable deduplication precedes new base resolution or worktree effects.
      const existing = storage.findRequest(trusted, requestId);
      if (existing) {
        await bound(existing, from, signal);
        return {
          record: existing,
          duplicate: true,
          dirtyContentsCopied: false,
        };
      }
      const name = workspaceText(input.name, 48);
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/.test(name))
        throw new BosunError('invalid', 'Invalid workspace name');
      const repository = await driver.repository(workspaceText(from), input.base, signal);
      if (repository.projectId !== trusted.projectId)
        throw new BosunError('conflict', 'Workspace project identity changed');
      if (signal?.aborted) throw new BosunError('cancelled', 'Workspace creation cancelled');
      const id = options.id();
      const at = jobTime(options.now());
      const record = workspaceRecord({
        id,
        requestId,
        name,
        projectId: trusted.projectId!,
        repository: repository.common,
        from: repository.root,
        path: options.path(id),
        branch: `bosun/${id}`,
        base: repository.head,
        state: 'creating',
        version: 1,
        createdAt: at,
        updatedAt: at,
      });
      const reserved = storage.reserve(trusted, record);
      if (reserved.duplicate) return { ...reserved, dirtyContentsCopied: false };
      // Intent is durable before Git. Any uncertain native receipt stays sticky; no replay or cleanup.
      let state: 'ready' | 'unknown' = 'unknown';
      try {
        if (signal?.aborted) throw new BosunError('cancelled', 'Workspace creation cancelled');
        const created = await driver.create({
          name: id,
          from: record.from,
          baseBranch: record.base,
          signal,
        });
        if (created.id === id && created.path === record.path && created.branch === record.branch)
          state = 'ready';
      } catch {
        /* Git may have created a branch/path even when its receipt is lost */
      }
      return {
        record: storage.finish(trusted, id, 1, state, jobTime(options.now())),
        duplicate: false,
        dirtyContentsCopied: false,
      };
    },
    async get(scope: JobScope, from: string, id: string, signal?: AbortSignal) {
      const record = storage.get(owner(scope), jobId(id));
      await bound(record, from, signal);
      return record;
    },
    async list(scope: JobScope, from: string, signal?: AbortSignal) {
      const trusted = owner(scope);
      const repository = await driver.repository(from, undefined, signal);
      if (repository.projectId !== trusted.projectId)
        throw new BosunError('conflict', 'Workspace project identity changed');
      return storage.list(trusted).filter((record) => record.repository === repository.common);
    },
    async reconcile(scope: JobScope, from: string, id: string, signal?: AbortSignal) {
      const trusted = owner(scope);
      const record = storage.get(trusted, jobId(id));
      await bound(record, from, signal);
      const observed = await driver.inspect(record, signal);
      const jobs = storage.jobs(trusted, record.path);
      const active = jobs.filter((job) => ['queued', 'held', 'running'].includes(job.state)).length;
      const uncertain = jobs.filter((job) => job.state === 'unknown').length;
      const reasons: string[] = [];
      if (record.state !== 'ready') reasons.push('creation_receipt_unknown');
      if (observed.state !== 'present')
        reasons.push(observed.state === 'missing' ? 'missing' : 'identity_changed');
      if (observed.dirty) reasons.push('dirty');
      if (observed.locked) reasons.push('locked');
      if (observed.prunable) reasons.push('git_prunable');
      if (!observed.merged) reasons.push('unmerged');
      if (active) reasons.push('active_jobs');
      if (uncertain) reasons.push('unknown_jobs');
      const revision = options.hash(
        JSON.stringify([record, observed, jobs.map((job) => [job.id, job.state, job.version])]),
      );
      return {
        record,
        observed,
        jobs: { total: jobs.length, active, uncertain },
        prune: {
          candidate: reasons.length === 0,
          reasons,
          revision,
          applies: false as const,
        },
      };
    },
  };
}
