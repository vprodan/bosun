import fs from 'node:fs';
import { project } from '../platform/project.ts';
import { BosunError } from '../core/errors.ts';
import { cardOwner } from '../core/domain/card.ts';
import { jobId, data, type JobScope } from '../core/domain/job.ts';
import {
  watchRecord,
  terminalHandle,
  WATCH_LIMITS,
  type WatchRecord,
} from '../core/domain/watch.ts';
import { workspaceText } from '../core/domain/workspace.ts';
import type { WorkspaceWatch } from '../core/ports/workspace.ts';
import type { Env } from '../core/domain/inference.ts';
import type { RuntimePaths } from '../platform/paths.ts';
import { createOfflineGit } from '../platform/git.ts';
import { createBunJobObserver } from '../platform/watch-command.ts';
import type { JobObserver } from '../platform/watch-command.ts';
import { createOrcaWatch } from '../adapters/workspaces/orca-watch.ts';
import type { openDaemonJobs } from './jobs.ts';

export function createWatchService(options: {
  jobs: ReturnType<typeof openDaemonJobs>;
  env: Env;
  paths: RuntimePaths;
  driver?: WorkspaceWatch;
  observer?: () => JobObserver;
}) {
  let selectedDriver = options.driver;
  const driver = () => (selectedDriver ??= createOrcaWatch({ env: options.env }));
  const git = createOfflineGit({ env: options.env });
  let selectedObserver: JobObserver | undefined;
  const observer = () =>
    (selectedObserver ??= options.observer
      ? options.observer()
      : createBunJobObserver(options.paths));
  const shutdown = new AbortController(),
    pending = new Set<Promise<unknown>>();
  let closed = false;
  async function operation<T>(
    run: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (closed || pending.size >= WATCH_LIMITS.pending)
      throw new BosunError('unavailable', 'Watch authority unavailable');
    options.jobs.assertOwner();
    const control = AbortSignal.any([
      shutdown.signal,
      AbortSignal.timeout(WATCH_LIMITS.timeoutMs),
      ...(signal ? [signal] : []),
    ]);
    const task = Promise.resolve().then(() => {
      if (control.aborted) throw new BosunError('cancelled', 'Watch operation cancelled');
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
  async function bound(scope: JobScope, from: string, id: string, signal: AbortSignal) {
    const job = options.jobs.get(scope, id);
    const record = options.jobs.watches.find(scope, id);
    const metadata = job.retained ? null : options.jobs.watchMetadata(scope, id);
    const cwd = record?.cwd ?? metadata?.cwd;
    if (!cwd) throw new BosunError('unavailable', 'Job checkout receipt unavailable');
    const source = await git.repository(from, undefined, signal),
      target = await git.repository(cwd, undefined, signal);
    if (
      source.projectId !== scope.projectId ||
      target.projectId !== scope.projectId ||
      source.common !== target.common ||
      (source.root !== target.root && !options.jobs.workspaces.jobWorkspace(scope, id)) ||
      (record &&
        (record.requestId !== job.requestId ||
          record.binding.common !== target.common ||
          record.binding.root !== target.root ||
          (metadata !== null && record.cwd !== metadata.cwd)))
    )
      throw new BosunError('conflict', 'Watch belongs to another checkout');
    return { job, record, target, cwd };
  }
  function report(
    job: ReturnType<typeof options.jobs.get>,
    record: WatchRecord | null,
    duplicate = false,
  ) {
    return {
      job,
      record,
      duplicate,
      qualification: 'source-bun' as const,
      observation: {
        wait: ['bosun', 'job', 'wait', job.id],
        get: ['bosun', 'job', 'get', job.id],
        result: ['bosun', 'job', 'result', job.id],
      },
    };
  }
  return {
    submit(
      input: { id: string; near?: string },
      scope: JobScope,
      from: string,
      sourceSessionId: string | null,
      signal?: AbortSignal,
    ) {
      const trusted = cardOwner(scope),
        id = jobId(data(input, 'id'));
      return operation(async (control) => {
        const binding = await bound(trusted, from, id, control);
        if (binding.record) return report(binding.job, binding.record, true);
        const nearProperty = Object.getOwnPropertyDescriptor(input, 'near');
        const near = nearProperty ? terminalHandle(data(input, 'near')) : null;
        if (sourceSessionId !== null) workspaceText(sourceSessionId, 200);
        let prepared;
        try {
          prepared = await driver().prepare(binding.target.root, near, control);
        } catch {
          return { ...report(binding.job, null), state: 'not_started' as const };
        }
        if (
          prepared.root !== binding.target.root ||
          prepared.common !== binding.target.common ||
          prepared.projectId !== trusted.projectId
        )
          throw new BosunError('conflict', 'Watch checkout identity changed');
        let command: string;
        try {
          command = observer().command(id, prepared.root, sourceSessionId);
        } catch {
          return { ...report(binding.job, null), state: 'not_started' as const };
        }
        const at = Date.now();
        const reserved = options.jobs.watches.reserve(
          trusted,
          watchRecord({
            jobId: id,
            requestId: binding.job.requestId,
            projectId: trusted.projectId!,
            cwd: binding.cwd,
            sourceSessionId,
            binding: prepared,
            near,
            handle: null,
            state: 'pending',
            version: 1,
            createdAt: at,
            updatedAt: at,
          }),
        );
        if (reserved.duplicate) return report(binding.job, reserved.record, true);
        let entered = false,
          handle: string | null = null,
          state: 'opened' | 'unknown' | 'not_started' = 'not_started';
        try {
          if (control.aborted) throw new BosunError('cancelled', 'Watch operation cancelled');
          handle = terminalHandle(
            await driver().open(prepared, near, command, control, () => {
              options.jobs.assertOwner();
              const current = options.jobs.watchMetadata(trusted, id);
              const intent = options.jobs.watches.find(trusted, id);
              if (
                control.aborted ||
                current.cwd !== reserved.record.cwd ||
                intent?.state !== 'pending' ||
                intent.version !== 1 ||
                fs.realpathSync(prepared.root) !== prepared.root ||
                fs.realpathSync(prepared.common) !== prepared.common ||
                project(prepared.root).id !== trusted.projectId ||
                observer().command(id, prepared.root, sourceSessionId) !== command
              )
                throw new BosunError('conflict', 'Watch authority or binding changed');
              if (current.workspaceId) {
                const workspace = options.jobs.workspaces.get(trusted, current.workspaceId);
                if (
                  workspace.state !== 'ready' ||
                  workspace.version !== current.workspaceVersion ||
                  workspace.path !== current.cwd
                )
                  throw new BosunError('conflict', 'Watch workspace changed');
              }
              entered = true;
            }),
          );
          if (!entered) throw new BosunError('unavailable', 'Missing terminal effect receipt');
          await bound(trusted, from, id, control);
          state = 'opened';
        } catch {
          state = entered ? 'unknown' : 'not_started';
          handle = null;
        }
        return report(
          options.jobs.get(trusted, id),
          options.jobs.watches.finish(trusted, id, 1, state, handle, Date.now()),
        );
      }, signal);
    },
    get(scope: JobScope, from: string, id: string, reconcile = false, signal?: AbortSignal) {
      const trusted = cardOwner(scope);
      return operation(async (control) => {
        const { job, record } = await bound(trusted, from, jobId(id), control);
        if (!reconcile || !record?.handle) return report(job, record);
        let pane: 'connected' | 'closed' | 'unavailable' = 'unavailable';
        try {
          pane = await driver().observe(record.binding, record.handle, control);
        } catch {}
        return { ...report(job, record), pane };
      }, signal);
    },
    async close() {
      closed = true;
      shutdown.abort();
      await Promise.allSettled([...pending]);
    },
  };
}
