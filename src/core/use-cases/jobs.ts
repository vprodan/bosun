import { BosunError } from '../errors.ts';
import { requirePublicInput } from '../policy.ts';
import { screenPublicText } from '../secret-screen.ts';
import type { AgentRunner, RunEvent } from '../ports/runner.ts';
import {
  billingQualification,
  nativeUsage,
  UNKNOWN_BILLING,
  type BillingQualification,
  type JobUsage,
  type UsageSelection,
  type JobMetadataEvent,
  type DailyUsage,
} from '../domain/usage.ts';
import {
  acceptedJob,
  data,
  jobId,
  jobScope,
  jobTime,
  terminalJob,
  utf8Bytes,
  JOB_LIMITS,
  type Admission,
  type AdmissionMetadata,
  type JobChange,
  type JobEvent,
  type JobInput,
  type JobScope,
  type JobSnapshot,
  type JobRetentionStatus,
  type JobPruneReceipt,
} from '../domain/job.ts';
import type {
  NotificationStorage,
  NotificationEvent,
  NotificationDelivery,
} from '../domain/notifications.ts';
import type { WorkspaceStorage } from '../domain/workspace.ts';
import type { ReviewStorage } from '../domain/review.ts';
import type { CheckStorage } from '../domain/check.ts';
import { assessDispatch } from '../dispatch-policy.ts';

// Internal synchronous persistence functions, not an eighth public port or an adapter registry.
export type JobStorage = {
  workspaces?: WorkspaceStorage;
  reviews?: ReviewStorage;
  checks?: CheckStorage;
  findRequest(scope: JobScope, requestId: string): JobSnapshot | null;
  create(
    scope: JobScope,
    id: string,
    input: JobInput,
    at: number,
  ): { job: JobSnapshot; duplicate: boolean };
  get(scope: JobScope, id: string): JobSnapshot;
  input(scope: JobScope, id: string): JobInput;
  metadata(scope: JobScope, id: string): AdmissionMetadata;
  result(scope: JobScope, id: string): string | null;
  list(scope: JobScope, limit?: number): JobSnapshot[];
  events(scope: JobScope, after: number, limit?: number): { events: JobEvent[]; cursor: number };
  nextQueued(backgroundRunnerIds?: readonly string[]): JobSnapshot | null;
  change(scope: JobScope, id: string, version: number, change: JobChange, at: number): JobSnapshot;
  startAttempt(
    scope: JobScope,
    id: string,
    version: number,
    selection: UsageSelection,
    billing: BillingQualification,
    at: number,
  ): { job: JobSnapshot; usage: JobUsage };
  usageList(scope: JobScope, limit?: number): JobUsage[];
  usageDaily(scope: JobScope, limit?: number): DailyUsage[];
  retentionStatus(scope: JobScope, at: number): JobRetentionStatus;
  prune(scope: JobScope, at: number, limit?: number): JobPruneReceipt;
  notificationReserve: NotificationStorage['reserve'];
  notificationNext: NotificationStorage['next'];
  notificationStart: NotificationStorage['start'];
  notificationFinish: NotificationStorage['finish'];
  notificationRecover: NotificationStorage['recover'];
  notificationStatus: NotificationStorage['status'];
  recover(at: number): number;
  close(): void;
};
export type JobDependencies = {
  storage: JobStorage;
  now(): number;
  id(): string;
  abort(): { signal: AbortSignal; abort(): void };
  runner(id: string, signal: AbortSignal): Promise<AgentRunner>;
  admit(
    job: Readonly<JobSnapshot>,
    signal: AbortSignal,
    metadata?: AdmissionMetadata,
  ): Promise<Admission>;
  failed?(
    job: Readonly<JobSnapshot>,
    signal: AbortSignal,
    metadata: AdmissionMetadata,
  ): Promise<void>;
  billing?(selection: UsageSelection): BillingQualification;
  metadata?(event: JobMetadataEvent): void;
  stateChanged?(job: Readonly<JobSnapshot>): void;
  backgroundRunnerIds?: readonly string[];
  internalRunnerIds?: readonly string[];
  drainMs?: number;
  grace?(settlement: Promise<void>, milliseconds: number): Promise<void>;
};
const unavailable = (unknown = false) =>
  new BosunError(
    'unavailable',
    'Jobs unavailable',
    unknown ? { details: { outcome: 'unknown' } } : undefined,
  );
function unknownOutcome(error: unknown): boolean {
  try {
    return error instanceof BosunError && error.details?.outcome === 'unknown';
  } catch {
    return false;
  }
}

export function createJobService(dependencies: JobDependencies) {
  const {
    storage,
    now: clock,
    id: makeId,
    abort: makeAbort,
    runner: loadRunner,
    admit,
  } = dependencies;
  if ((dependencies.backgroundRunnerIds?.length ?? 0) > 16)
    throw new BosunError('invalid', 'Too many background runners');
  const backgroundRunnerIds = Object.freeze((dependencies.backgroundRunnerIds ?? []).map(jobId));
  if ((dependencies.internalRunnerIds?.length ?? 0) > 16)
    throw new BosunError('invalid', 'Too many internal runners');
  const internalRunnerIds = new Set((dependencies.internalRunnerIds ?? []).map(jobId));
  const drainMs = dependencies.drainMs ?? 0;
  if (
    !Number.isSafeInteger(drainMs) ||
    drainMs < 0 ||
    drainMs > 300000 ||
    (drainMs > 0 && !dependencies.grace)
  )
    throw new BosunError('invalid', 'Invalid drain grace');
  let ready = false;
  let draining = false;
  let closed = false;
  let fenced = false;
  let pump: Promise<void> | null = null;
  let active: {
    job: JobSnapshot;
    scope: JobScope;
    control: ReturnType<JobDependencies['abort']>;
  } | null = null;
  const now = () => {
    try {
      return jobTime(clock());
    } catch {
      throw unavailable();
    }
  };
  function read<T>(fn: () => T): T {
    if (closed || fenced) throw unavailable(fenced);
    try {
      return fn();
    } catch (e) {
      if (unknownOutcome(e)) {
        fenced = true;
        active?.control.abort();
      }
      throw e;
    }
  }
  function workspaceRead<T>(
    scope: JobScope,
    operation: (storage: WorkspaceStorage, scope: JobScope) => T,
  ): T {
    const trusted = jobScope(scope);
    if (trusted.audience !== 'owner')
      throw new BosunError('unsupported', 'Owner workspace operation required');
    return read(() => {
      if (!storage.workspaces) throw unavailable();
      return operation(storage.workspaces, trusted);
    });
  }
  const writeReady = () => {
    if (!ready || draining || closed || fenced) throw unavailable(fenced);
  };
  const observe = (event: JobMetadataEvent) => {
    try {
      dependencies.metadata?.(Object.freeze(event));
    } catch {}
  };
  const stateChanged = (job: JobSnapshot) => {
    try {
      dependencies.stateChanged?.(Object.freeze({ ...job }));
    } catch {}
  };
  const update = (job: JobSnapshot, change: JobChange) => {
    const result = read(() =>
      storage.change({ projectId: job.projectId }, job.id, job.version, change, now()),
    );
    observe({
      event: change.kind === 'usage' ? 'job.usage' : 'job.state',
      state: result.state,
      reason: result.reason,
      ...(change.usage
        ? { tokensIn: change.usage.tokensIn, tokensOut: change.usage.tokensOut }
        : {}),
    });
    if (change.kind === 'state' || change.kind === 'cancel') stateChanged(result);
    return result;
  };
  function cancel(scope: JobScope, id: string): JobSnapshot {
    if (!ready || closed || fenced) throw unavailable(fenced);
    const job = read(() => storage.get(jobScope(scope), jobId(id)));
    if (terminalJob(job.state) || job.cancelRequested) return job;
    if (job.state === 'queued' || job.state === 'held') {
      const changed = update(job, {
        state: 'cancelled',
        kind: 'cancel',
        reason: 'cancel_requested',
        cancelRequested: true,
      });
      if (active?.job.id === job.id) active.control.abort();
      return changed;
    }
    // Only this daemon's active runner can supply positive completion after cancellation.
    const changed = update(job, {
      state: active?.job.id === job.id ? 'running' : 'unknown',
      kind: 'cancel',
      reason: 'cancel_requested',
      cancelRequested: true,
    });
    if (active?.job.id === job.id) active.control.abort();
    return changed;
  }
  async function execute(job: JobSnapshot): Promise<void> {
    const scope = { projectId: job.projectId };
    const control = makeAbort();
    active = { job, scope, control };
    let started = false;
    let completion: { code: number; result: string } | null = null;
    let lost: 'runner_lost' | 'output_limit' | 'event_limit' | null = null;
    try {
      let admission: Admission;
      const metadata = read(() => storage.metadata(scope, job.id));
      if (
        !(job.ownerOnly && internalRunnerIds.has(job.runnerId)) &&
        !assessDispatch({
          access: metadata.access,
          model: metadata.model,
          submittedBy: metadata.submittedBy ?? 'owner',
          policy: metadata.policy,
        }).allowed
      ) {
        update(job, { state: 'held', kind: 'state', reason: 'approval' });
        return;
      }
      try {
        admission = await admit(Object.freeze({ ...job }), control.signal, metadata);
      } catch (e) {
        if (unknownOutcome(e)) throw e;
        admission = { allowed: false, reason: 'admission_unavailable' };
      }
      if (draining || control.signal.aborted || fenced) return;
      job = read(() => storage.get(scope, job.id));
      if (job.state !== 'queued') return;
      if (!admission || admission.allowed !== true) {
        const reason =
          admission?.allowed === false &&
          ['quota', 'approval', 'admission_unavailable'].includes(admission.reason)
            ? admission.reason
            : 'admission_unavailable';
        update(job, { state: 'held', kind: 'state', reason });
        return;
      }
      let runner: AgentRunner;
      try {
        runner = await loadRunner(job.runnerId, control.signal);
      } catch {
        if (!draining && !control.signal.aborted)
          update(
            read(() => storage.get(scope, job.id)),
            { state: 'held', kind: 'state', reason: 'runner_unavailable' },
          );
        return;
      }
      if (draining || control.signal.aborted || fenced) return;
      job = read(() => storage.get(scope, job.id));
      if (job.state !== 'queued') return;
      const input = acceptedJob(read(() => storage.input(scope, job.id)));
      let supported = false;
      try {
        supported =
          runner.id === job.runnerId &&
          typeof runner.run === 'function' &&
          (input.access !== 'read' || runner.caps.readOnly === 'verified') &&
          (input.effort === undefined || runner.caps.effort === 'verified');
      } catch {}
      if (!supported) {
        update(job, { state: 'held', kind: 'state', reason: 'unsupported' });
        return;
      }
      const selection = Object.freeze({
        runnerId: job.runnerId,
        model: input.model,
        effort: input.effort ?? null,
      });
      let billing = UNKNOWN_BILLING;
      try {
        if (dependencies.billing) billing = billingQualification(dependencies.billing(selection));
      } catch {}
      const attempt = read(() =>
        storage.startAttempt(scope, job.id, job.version, selection, billing, now()),
      );
      job = attempt.job;
      active.job = job;
      started = true;
      observe({
        event: 'job.state',
        state: job.state,
        reason: job.reason,
        generation: attempt.usage.generation,
      });
      let events = 0;
      let textBytes = 0;
      const eventData = (event: RunEvent, key: string) => {
        try {
          return data(event, key);
        } catch (e) {
          control.abort();
          throw e;
        }
      };
      try {
        for await (const event of runner.run({
          prompt: input.prompt,
          privacy: 'public',
          cwd: input.cwd,
          access: input.access,
          jobId: job.id,
          projectId: job.projectId,
          ...(input.managedId
            ? { managed: { id: input.managedId, version: input.managedVersion! } }
            : {}),
          model: input.model,
          ...(input.effort === undefined ? {} : { effort: input.effort }),
          ...(input.maxTurns === undefined ? {} : { maxTurns: input.maxTurns }),
          signal: control.signal,
        })) {
          if (fenced) {
            control.abort();
            break;
          }
          if (++events > JOB_LIMITS.runnerEvents) {
            lost = 'event_limit';
            control.abort();
            break;
          }
          if (completion) {
            lost = 'runner_lost';
            control.abort();
            break;
          }
          const kind = eventData(event, 't');
          if (kind === 'done') {
            const code = eventData(event, 'code');
            const result = eventData(event, 'result');
            if (
              !Number.isSafeInteger(code) ||
              Number(code) < 0 ||
              Number(code) > 255 ||
              typeof result !== 'string'
            ) {
              lost = 'runner_lost';
              control.abort();
              break;
            }
            if (utf8Bytes(result) > JOB_LIMITS.resultBytes) {
              lost = 'output_limit';
              control.abort();
              break;
            }
            completion = { code: Number(code), result };
          } else if (['text', 'tool', 'file', 'permission', 'usage'].includes(kind as string)) {
            let usage;
            if (kind === 'usage')
              try {
                usage = nativeUsage(event);
              } catch {
                lost = 'runner_lost';
                control.abort();
                break;
              }
            if (kind === 'text') {
              const text = eventData(event, 'text');
              if (
                typeof text !== 'string' ||
                (textBytes += utf8Bytes(text)) > JOB_LIMITS.resultBytes
              ) {
                lost = 'output_limit';
                control.abort();
                break;
              }
            }
            try {
              job = read(() => storage.get(scope, job.id));
              job = update(job, {
                state: 'running',
                kind: kind as Exclude<RunEvent['t'], 'done'>,
                reason: job.cancelRequested ? 'cancel_requested' : null,
                ...(usage ? { usage } : {}),
              });
            } catch (e) {
              control.abort();
              throw e;
            }
          } else {
            lost = 'runner_lost';
            control.abort();
            break;
          }
        }
      } catch (error) {
        // Native cancellation/lost effect receipts are normal unknown job outcomes.
        // Only the storage guard's own uncertainty fences the writer; treating a
        // runner's unknown effect as an uncertain SQLite COMMIT loses recovery state.
        if (fenced) throw error;
        if (!completion) lost = 'runner_lost';
      }
      if (!fenced) {
        job = read(() => storage.get(scope, job.id));
        if (completion && !lost)
          job = update(job, {
            state: completion.code === 0 ? 'succeeded' : 'failed',
            kind: 'state',
            reason: completion.code === 0 ? null : 'runner_failed',
            result: completion.result,
          });
        else job = update(job, { state: 'unknown', kind: 'state', reason: lost ?? 'runner_lost' });
        // The native outcome is durable before telemetry is refreshed. An
        // unavailable quota source cannot erase it; uncertain quota persistence
        // still fences subsequent dispatch without replaying the completed job.
        if (
          dependencies.failed &&
          (job.state === 'failed' || job.state === 'unknown') &&
          !draining &&
          !control.signal.aborted
        ) {
          try {
            await dependencies.failed(Object.freeze({ ...job }), control.signal, metadata);
          } catch (error) {
            if (unknownOutcome(error)) throw error;
          }
        }
      }
    } catch (e) {
      // A lost start/finish receipt must never call the runner again or manufacture a rolled-back state.
      control.abort();
      if (started || unknownOutcome(e)) fenced = true;
      if (fenced) observe({ event: 'job.storage_hold', outcome: 'unknown' });
      throw unavailable(started || unknownOutcome(e));
    } finally {
      active = null;
    }
  }
  function runQueued(): Promise<void> {
    writeReady();
    if (pump) return pump;
    const loop = async () => {
      while (!draining && !fenced) {
        const job = read(() => storage.nextQueued(backgroundRunnerIds));
        if (!job) return;
        await execute(job);
      }
    };
    pump = loop().finally(() => {
      pump = null;
    });
    return pump;
  }
  async function drain(options: { abort?: boolean } = {}): Promise<void> {
    draining = true;
    let failure: unknown;
    if (options.abort !== false && active?.job.state === 'running' && pump && drainMs) {
      try {
        await dependencies.grace!(pump, drainMs);
      } catch (e) {
        failure = e;
      }
    }
    if (options.abort !== false && active) {
      try {
        if (active.job.state === 'running') cancel(active.scope, active.job.id);
      } catch (e) {
        failure = e;
      }
      active?.control.abort();
    }
    try {
      await pump;
    } catch (e) {
      failure ??= e;
    }
    if (failure) throw failure;
  }
  return {
    // Caller holds the daemon owner lock before this explicit startup operation.
    recover(): number {
      if (ready || pump || draining || closed) throw unavailable();
      const n = read(() => storage.recover(now()));
      ready = true;
      return n;
    },
    submit(input: JobInput, scope: JobScope): { job: JobSnapshot; duplicate: boolean } {
      requirePublicInput(input); // before request lookup, task prompt getters or runner selection
      writeReady();
      const trusted = jobScope(scope);
      const requestId = jobId(data(input, 'requestId'));
      screenPublicText(requestId);
      if (
        trusted.audience === 'model' &&
        (Object.getOwnPropertyDescriptor(input, 'ownerOnly')?.value === true ||
          Object.getOwnPropertyDescriptor(input, 'allowUnknownQuota') !== undefined)
      )
        throw new BosunError('unsupported', 'Owner job permission required');
      if (
        trusted.audience !== 'owner' &&
        ['workspaceId', 'workspaceVersion'].some(
          (key) => Object.getOwnPropertyDescriptor(input, key) !== undefined,
        )
      )
        throw new BosunError('unsupported', 'Owner workspace operation required');
      if (
        trusted.audience !== 'owner' &&
        Object.getOwnPropertyDescriptor(input, 'reviewId') !== undefined
      )
        throw new BosunError('unsupported', 'Owner review operation required');
      if (
        trusted.audience !== 'owner' &&
        Object.getOwnPropertyDescriptor(input, 'checkId') !== undefined
      )
        throw new BosunError('unsupported', 'Owner verification operation required');
      if (
        trusted.audience !== 'owner' &&
        ['managedId', 'managedVersion'].some(
          (key) => Object.getOwnPropertyDescriptor(input, key) !== undefined,
        )
      )
        throw new BosunError('unsupported', 'Owner managed operation required');
      if (Object.getOwnPropertyDescriptor(input, 'submittedBy') !== undefined)
        throw new BosunError('unsupported', 'Job origin is assigned by the authority');
      const existing = read(() => storage.findRequest(trusted, requestId));
      if (existing) return { job: existing, duplicate: true };
      const accepted = {
        ...acceptedJob(input),
        submittedBy: trusted.audience === 'model' ? ('model' as const) : ('owner' as const),
      };
      let id: string;
      try {
        id = jobId(makeId());
      } catch {
        throw new BosunError('invalid', 'Invalid job identifier');
      }
      const created = read(() => storage.create(trusted, id, accepted, now()));
      if (!created.duplicate) stateChanged(created.job);
      return created;
    },
    get(scope: JobScope, id: string) {
      return read(() => storage.get(jobScope(scope), jobId(id)));
    },
    policy(scope: JobScope, id: string) {
      const trusted = jobScope(scope);
      if (trusted.audience !== 'owner')
        throw new BosunError('unsupported', 'Owner policy inspection required');
      const job = read(() => storage.get(trusted, jobId(id)));
      if (job.retained) return { risk: 'unknown', allowed: false, reason: 'receipt_only' };
      const metadata = read(() => storage.metadata(trusted, job.id));
      return job.ownerOnly && internalRunnerIds.has(job.runnerId)
        ? { risk: 'unknown', allowed: true, reason: 'owner_operation' }
        : assessDispatch({
            access: metadata.access,
            model: metadata.model,
            submittedBy: metadata.submittedBy ?? 'owner',
            policy: metadata.policy,
          });
    },
    findRequest(scope: JobScope, requestId: string) {
      return read(() => storage.findRequest(jobScope(scope), jobId(requestId)));
    },
    result(scope: JobScope, id: string) {
      return read(() => storage.result(jobScope(scope), jobId(id)));
    },
    list(scope: JobScope, limit?: number) {
      return read(() => storage.list(jobScope(scope), limit));
    },
    events(scope: JobScope, after: number, limit?: number) {
      return read(() => storage.events(jobScope(scope), after, limit));
    },
    usage(scope: JobScope, limit?: number) {
      return read(() => storage.usageList(jobScope(scope), limit));
    },
    dailyUsage(scope: JobScope, limit?: number) {
      return read(() => storage.usageDaily(jobScope(scope), limit));
    },
    retentionStatus(scope: JobScope) {
      return read(() => storage.retentionStatus(jobScope(scope), now()));
    },
    prune(scope: JobScope, limit?: number) {
      writeReady();
      return read(() => storage.prune(jobScope(scope), now(), limit));
    },
    notifications: {
      reserve(job: NotificationEvent, jobRef: string) {
        writeReady();
        return read(() => storage.notificationReserve(job, jobRef, now()));
      },
      next() {
        return read(() => storage.notificationNext());
      },
      start(id: string) {
        writeReady();
        return read(() => storage.notificationStart(id, now()));
      },
      finish(id: string, delivery: NotificationDelivery) {
        return read(() => storage.notificationFinish(id, delivery, now()));
      },
      recover() {
        writeReady();
        return read(() => storage.notificationRecover(now()));
      },
      status(scope: JobScope) {
        return read(() => storage.notificationStatus(jobScope(scope)));
      },
    },
    workspaces: {
      jobWorkspace(scope: JobScope, id: string) {
        return workspaceRead(scope, (storage, trusted) => storage.jobWorkspace(trusted, id));
      },
      byPath(scope: JobScope, path: string) {
        return workspaceRead(scope, (storage, trusted) => storage.byPath(trusted, path));
      },
      findRequest(scope: JobScope, requestId: string) {
        return workspaceRead(scope, (storage, trusted) => storage.findRequest(trusted, requestId));
      },
      get(scope: JobScope, id: string) {
        return workspaceRead(scope, (storage, trusted) => storage.get(trusted, id));
      },
      list(scope: JobScope) {
        return workspaceRead(scope, (storage, trusted) => storage.list(trusted));
      },
      reserve(scope: JobScope, record: Parameters<WorkspaceStorage['reserve']>[1]) {
        writeReady();
        return workspaceRead(scope, (storage, trusted) => storage.reserve(trusted, record));
      },
      finish(scope: JobScope, id: string, version: number, state: 'ready' | 'unknown', at: number) {
        return workspaceRead(scope, (storage, trusted) =>
          storage.finish(trusted, id, version, state, at),
        );
      },
      jobs(scope: JobScope, path: string) {
        return workspaceRead(scope, (storage, trusted) => storage.jobs(trusted, path));
      },
    },
    reviews: {
      findRequest(scope: JobScope, requestId: string) {
        const trusted = jobScope(scope);
        if (trusted.audience !== 'owner')
          throw new BosunError('unsupported', 'Owner review operation required');
        return read(() => {
          if (!storage.reviews) throw unavailable();
          return storage.reviews.findRequest(trusted, requestId);
        });
      },
      get(scope: JobScope, id: string) {
        const trusted = jobScope(scope);
        if (trusted.audience !== 'owner')
          throw new BosunError('unsupported', 'Owner review operation required');
        return read(() => {
          if (!storage.reviews) throw unavailable();
          return storage.reviews.get(trusted, id);
        });
      },
      reserve(scope: JobScope, record: Parameters<ReviewStorage['reserve']>[1]) {
        const trusted = jobScope(scope);
        if (trusted.audience !== 'owner')
          throw new BosunError('unsupported', 'Owner review operation required');
        writeReady();
        return read(() => {
          if (!storage.reviews) throw unavailable();
          return storage.reviews.reserve(trusted, record);
        });
      },
    },
    checks: {
      findRequest(scope: JobScope, requestId: string) {
        const trusted = jobScope(scope);
        if (trusted.audience !== 'owner')
          throw new BosunError('unsupported', 'Owner verification operation required');
        return read(() => {
          if (!storage.checks) throw unavailable();
          return storage.checks.findRequest(trusted, requestId);
        });
      },
      get(scope: JobScope, id: string) {
        const trusted = jobScope(scope);
        if (trusted.audience !== 'owner')
          throw new BosunError('unsupported', 'Owner verification operation required');
        return read(() => {
          if (!storage.checks) throw unavailable();
          return storage.checks.get(trusted, id);
        });
      },
      list(scope: JobScope, reviewId: string) {
        const trusted = jobScope(scope);
        if (trusted.audience !== 'owner')
          throw new BosunError('unsupported', 'Owner verification operation required');
        return read(() => {
          if (!storage.checks) throw unavailable();
          return storage.checks.list(trusted, reviewId);
        });
      },
      reserve(scope: JobScope, record: Parameters<CheckStorage['reserve']>[1]) {
        const trusted = jobScope(scope);
        if (trusted.audience !== 'owner')
          throw new BosunError('unsupported', 'Owner verification operation required');
        writeReady();
        return read(() => {
          if (!storage.checks) throw unavailable();
          return storage.checks.reserve(trusted, record);
        });
      },
    },
    cancel,
    async release(scope: JobScope, id: string): Promise<JobSnapshot> {
      writeReady();
      const trusted = jobScope(scope);
      if (trusted.audience === 'model')
        throw new BosunError('unsupported', 'Owner operation required');
      const prior = read(() => storage.get(trusted, jobId(id)));
      if (prior.state !== 'held') throw new BosunError('conflict', 'Job is not held');
      const metadata = read(() => storage.metadata(trusted, prior.id));
      const control = makeAbort();
      if (
        !(prior.ownerOnly && internalRunnerIds.has(prior.runnerId)) &&
        !assessDispatch({
          access: metadata.access,
          model: metadata.model,
          submittedBy: metadata.submittedBy ?? 'owner',
          policy: metadata.policy,
        }).allowed
      )
        return prior;
      let admission: Admission;
      try {
        admission = await admit(Object.freeze({ ...prior }), control.signal, metadata);
      } catch (e) {
        if (unknownOutcome(e)) {
          fenced = true;
          active?.control.abort();
          throw e;
        }
        admission = { allowed: false, reason: 'admission_unavailable' };
      }
      writeReady();
      const current = read(() => storage.get(trusted, prior.id));
      if (current.version !== prior.version || current.state !== 'held')
        throw new BosunError('conflict', 'Job changed during release');
      if (admission?.allowed === true) return update(current, { state: 'queued', kind: 'state' });
      const reason =
        admission?.allowed === false &&
        ['quota', 'approval', 'admission_unavailable'].includes(admission.reason)
          ? admission.reason
          : 'admission_unavailable';
      return current.reason === reason
        ? current
        : update(current, { state: 'held', kind: 'state', reason });
    },
    idle(): boolean {
      return (
        ready &&
        !draining &&
        !closed &&
        !fenced &&
        !pump &&
        !active &&
        read(() => storage.nextQueued()) === null
      );
    },
    runQueued,
    drain,
    async close(): Promise<void> {
      if (closed) return;
      let failure: unknown;
      try {
        await drain();
      } catch (e) {
        failure = e;
      }
      closed = true;
      try {
        storage.close();
      } catch (e) {
        failure ??= e;
      }
      if (failure) throw failure;
    },
  };
}
