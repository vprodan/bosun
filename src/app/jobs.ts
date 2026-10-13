import crypto from 'node:crypto';
import { BosunError } from '../core/errors.ts';
import type { AgentRunner } from '../core/ports/runner.ts';
import type { Admission, AdmissionMetadata, JobSnapshot } from '../core/domain/job.ts';
import { createJobService } from '../core/use-cases/jobs.ts';
import { createQuotaService, type SupportedQuotaSource } from '../core/use-cases/quota.ts';
import { QUOTA_LIMITS } from '../core/domain/quota.ts';
import { SqliteJobStore } from '../adapters/jobs/sqlite-jobs.ts';
import { DaemonOwner } from '../platform/daemon-owner.ts';
import type {
  BillingQualification,
  UsageSelection,
  JobMetadataEvent,
} from '../core/domain/usage.ts';

export function openDaemonJobs(options: {
  stateFile: string;
  ownerFile: string;
  runners: Readonly<Record<string, (signal: AbortSignal) => AgentRunner | Promise<AgentRunner>>>;
  admit?(
    job: Readonly<JobSnapshot>,
    signal: AbortSignal,
    metadata?: AdmissionMetadata,
  ): Promise<Admission>;
  quotaSources?: Readonly<Record<string, SupportedQuotaSource>>;
  internalRunnerIds?: readonly string[];
  backgroundRunnerIds?: readonly string[];
  maxQueue?: number;
  maxJobs?: number;
  maxEvents?: number;
  maxReceipts?: number;
  maxDailyGroups?: number;
  retentionDays?: number;
  drainMs?: number;
  maxNotifications?: number;
  maxPendingNotifications?: number;
  now?: () => number;
  id?: () => string;
  hash?: (text: string) => string;
  billing?(selection: UsageSelection): BillingQualification;
  metadata?(event: JobMetadataEvent): void;
  stateChanged?(job: Readonly<JobSnapshot>): void;
  workspaceAdmit?(
    job: Readonly<JobSnapshot>,
    signal: AbortSignal,
    metadata: AdmissionMetadata,
  ): Promise<boolean>;
  reviewAdmit?(
    job: Readonly<JobSnapshot>,
    signal: AbortSignal,
    metadata: AdmissionMetadata,
  ): Promise<boolean>;
  checkAdmit?(
    job: Readonly<JobSnapshot>,
    signal: AbortSignal,
    metadata: AdmissionMetadata,
  ): Promise<boolean>;
  managedAdmit?(
    job: Readonly<JobSnapshot>,
    signal: AbortSignal,
    metadata: AdmissionMetadata,
  ): Promise<boolean>;
}) {
  if (options.stateFile === options.ownerFile)
    throw new BosunError('invalid', 'Daemon state and owner paths must differ');
  if (
    options.drainMs !== undefined &&
    (!Number.isSafeInteger(options.drainMs) || options.drainMs < 0 || options.drainMs > 300000)
  )
    throw new BosunError('invalid', 'Invalid drain grace');
  // Snapshot factories without constructing/probing any runner or loading another provider.
  const factories = new Map(Object.entries(options.runners));
  const internalRunners = new Set(options.internalRunnerIds ?? []);
  const sources = new Map(Object.entries(options.quotaSources ?? {}));
  const clock = options.now ?? Date.now;
  const shutdown = new AbortController();
  type SourceResult = Awaited<ReturnType<SupportedQuotaSource['read']>>;
  const cached = new Map<string, { at: number; result: SourceResult }>();
  const pending = new Map<string, Promise<SourceResult>>();
  const wait = async <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> => {
    if (signal.aborted) throw new BosunError('cancelled', 'Quota request cancelled');
    let abort!: () => void;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          abort = () => reject(new BosunError('cancelled', 'Quota request cancelled'));
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        }),
      ]);
    } finally {
      signal.removeEventListener('abort', abort);
    }
  };
  const owner = new DaemonOwner(options.ownerFile);
  try {
    const storage = new SqliteJobStore({
      file: options.stateFile,
      assertOwner: () => owner.assert(),
      maxQueue: options.maxQueue,
      maxJobs: options.maxJobs,
      maxEvents: options.maxEvents,
      maxReceipts: options.maxReceipts,
      maxDailyGroups: options.maxDailyGroups,
      retentionDays: options.retentionDays,
      maxNotifications: options.maxNotifications,
      maxPendingNotifications: options.maxPendingNotifications,
    });
    const quota = createQuotaService({
      storage,
      now: clock,
      hash: options.hash ?? ((text) => crypto.createHash('sha256').update(text).digest('hex')),
      async observe(selection, signal) {
        owner.assert();
        const source = sources.get(selection.runnerId);
        if (!source || shutdown.signal.aborted) return null;
        const key = JSON.stringify(selection);
        const now = clock();
        const hit = cached.get(key);
        if (
          hit &&
          Number.isSafeInteger(now) &&
          now >= hit.at &&
          now - hit.at < QUOTA_LIMITS.refreshCacheMs
        )
          return hit.result;
        let request = pending.get(key);
        if (!request) {
          if (pending.size >= 16) return null;
          const deadline = AbortSignal.any([
            shutdown.signal,
            AbortSignal.timeout(QUOTA_LIMITS.readTimeoutMs),
          ]);
          request = wait(
            Promise.resolve().then(() => source.read(selection, deadline)),
            deadline,
          )
            .catch(() => null)
            .then((result) => {
              if (!shutdown.signal.aborted && result) {
                if (cached.size >= QUOTA_LIMITS.states) cached.delete(cached.keys().next().value!);
                cached.set(key, { at: clock(), result });
              }
              return result;
            })
            .finally(() => {
              pending.delete(key);
            });
          pending.set(key, request);
        }
        return wait(request, AbortSignal.any([signal, shutdown.signal]));
      },
    });
    const jobs = createJobService({
      storage,
      now: clock,
      id: options.id ?? crypto.randomUUID,
      billing: options.billing,
      metadata: options.metadata,
      stateChanged: options.stateChanged,
      backgroundRunnerIds: options.backgroundRunnerIds,
      internalRunnerIds: [...internalRunners],
      drainMs: options.drainMs,
      async grace(settlement, milliseconds) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            settlement.catch(() => {}),
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, milliseconds);
            }),
          ]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      },
      abort: () => new AbortController(),
      admit: async (job, signal, metadata) => {
        if (metadata && options.managedAdmit) {
          try {
            if (!(await options.managedAdmit(job, signal, metadata)))
              return { allowed: false, reason: 'approval' };
          } catch {
            return { allowed: false, reason: 'admission_unavailable' };
          }
        } else if (metadata?.managedId) return { allowed: false, reason: 'approval' };
        if (metadata?.checkId) {
          try {
            if (!options.checkAdmit || !(await options.checkAdmit(job, signal, metadata)))
              return { allowed: false, reason: 'approval' };
          } catch {
            return { allowed: false, reason: 'admission_unavailable' };
          }
        }
        if (metadata?.reviewId) {
          try {
            if (!options.reviewAdmit || !(await options.reviewAdmit(job, signal, metadata)))
              return { allowed: false, reason: 'approval' };
          } catch {
            return { allowed: false, reason: 'admission_unavailable' };
          }
        }
        const managedPath = metadata
          ? jobs.workspaces.byPath({ projectId: job.projectId, audience: 'owner' }, metadata.cwd)
          : null;
        if (metadata?.workspaceId || managedPath) {
          if (!metadata?.workspaceId || metadata.workspaceId !== managedPath?.id)
            return { allowed: false, reason: 'approval' };
          try {
            if (!options.workspaceAdmit || !(await options.workspaceAdmit(job, signal, metadata)))
              return { allowed: false, reason: 'approval' };
          } catch {
            return { allowed: false, reason: 'admission_unavailable' };
          }
        }
        if (job.ownerOnly && internalRunners.has(job.runnerId))
          return Promise.resolve({ allowed: true });
        return options.admit
          ? options.admit(job, signal, metadata)
          : metadata
            ? quota.admit(job, signal, metadata)
            : Promise.resolve({ allowed: false, reason: 'admission_unavailable' });
      },
      async failed(job, signal, metadata) {
        if (job.ownerOnly && internalRunners.has(job.runnerId)) return;
        const selection = { runnerId: job.runnerId, model: metadata.model };
        cached.delete(JSON.stringify(selection));
        await quota.refresh(selection, signal);
      },
      async runner(id, signal) {
        if (signal.aborted || !factories.has(id))
          throw new BosunError('unsupported', 'Runner unavailable');
        return factories.get(id)!(signal);
      },
    });
    return {
      ...jobs,
      usage: { list: jobs.usage, daily: jobs.dailyUsage },
      retention: { status: jobs.retentionStatus, prune: jobs.prune },
      // Internal facets of the existing authority; never a model RPC/storage handle.
      managed: {
        registerOwnership: storage.registerOwnership.bind(storage),
        ownership: storage.ownership.bind(storage),
        fenceOwnership: storage.fenceOwnership.bind(storage),
        stageOwnership: storage.stageOwnership.bind(storage),
        destinationOwnership: storage.destinationOwnership.bind(storage),
        transferOwnership: storage.transferOwnership.bind(storage),
        holdOwnership: storage.holdOwnership.bind(storage),
        recoverOwnership: storage.recoverOwnership.bind(storage),
        reserveOwnership: storage.reserveOwnership.bind(storage),
        bindOwnership: storage.bindOwnership.bind(storage),
        activateOwnership: storage.activateOwnership.bind(storage),
        authorityOwnership: storage.authorityOwnership.bind(storage),
        retireOwnership: storage.retireOwnership.bind(storage),
        ownerships: storage.ownerships.bind(storage),
        job: storage.managedJob.bind(storage),
        unsettled: storage.managedUnsettled.bind(storage),
      },
      handoffs: {
        get: storage.handoffPointer.bind(storage),
        findRequest: storage.findHandoffRequest.bind(storage),
        put: storage.putHandoffPointer.bind(storage),
        list: storage.listHandoffPointers.bind(storage),
      },
      cards: storage.cards,
      watches: storage.watches,
      watchMetadata(scope: import('../core/domain/job.ts').JobScope, id: string) {
        if (scope.audience !== 'owner') throw new BosunError('unsupported', 'Owner watch operation required');
        return storage.metadata(scope, id);
      },
      routing: {
        record: storage.recordRoute.bind(storage),
        list: storage.listRoutes.bind(storage),
        labels: storage.routeLabels.bind(storage),
        label: storage.labelRoute.bind(storage),
      },
      recover() {
        const recovered = jobs.recover();
        storage.recoverOwnership();
        return recovered;
      },
      assertOwner(): void {
        owner.assert();
      },
      quota: {
        status: quota.status,
        // For native work inside an admitted internal job. This deliberately
        // does not apply the internal-runner exemption a second time.
        admit(selection: { runnerId: string; model: string }, signal: AbortSignal,
          metadata: { cwd: string; allowUnknownQuota: boolean }) {
          owner.assert();
          return quota.admit(selection, signal, { ...metadata, model: selection.model, access: 'read' });
        },
        async refresh(selection: Parameters<typeof quota.refresh>[0], signal: AbortSignal) {
          cached.delete(JSON.stringify(selection));
          return quota.refresh(selection, signal);
        },
      },
      async close() {
        let failure: unknown;
        quota.close();
        shutdown.abort();
        cached.clear();
        try {
          await jobs.close();
        } catch (e) {
          failure = e;
        }
        try {
          owner.close();
        } catch (e) {
          failure ??= e;
        }
        if (failure) throw failure;
      },
    };
  } catch (e) {
    try {
      owner.close();
    } catch {}
    throw e;
  }
}
