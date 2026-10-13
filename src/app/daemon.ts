import crypto from 'node:crypto';
import fs from 'node:fs';
import type { RuntimeConfig } from '../core/domain/config.ts';
import type { AgentRunner } from '../core/ports/runner.ts';
import type { Admission, AdmissionMetadata, JobSnapshot } from '../core/domain/job.ts';
import type { SupportedQuotaSource } from '../core/use-cases/quota.ts';
import { rpcError, type RpcError } from '../contracts/rpc.ts';
import type { RuntimePaths } from '../platform/paths.ts';
import { privateDirectory } from '../platform/private-file.ts';
import { readRuntimeManifest } from '../platform/manifest.ts';
import { configRevision } from '../platform/config.ts';
import { contentHash } from '../platform/content-hash.ts';
import { version } from '../platform/assets.ts';
import { BosunError } from '../core/errors.ts';
import { serveLocalRpc } from '../adapters/transport/local-rpc-server.ts';
import { openDaemonJobs } from './jobs.ts';
import { openDaemonMemory } from './memory.ts';
import { createDispatcher } from './dispatcher.ts';
import { publishHookConfig } from './config.ts';
import { ADMIN_RUNNER, createAdminRunner } from './admin-jobs.ts';
import { createHandoffArtifacts } from './handoff.ts';
import type { ContextSource } from '../core/ports/context-source.ts';
import path from 'node:path';
import { openRuntimeLog } from '../platform/logging.ts';
import type { ModelProvider } from '../core/ports/model.ts';
import { modelProviders } from './model-providers.ts';
import { SUMMARY_RUNNER, createSummaryService } from './summary.ts';
import { MEMORY_SUGGESTION_RUNNER, createMemorySuggestions } from './memory-suggestions.ts';
import { EMBEDDING_RUNNER, createEmbeddingService } from './embeddings.ts';
import { createRouterEvaluation } from './router-evaluation.ts';
import { ROUTER_EVAL_RUNNER } from '../core/domain/router-evaluation.ts';
import type { Env } from '../core/domain/inference.ts';
import { CONSOLIDATION_RUNNER, createConsolidationService } from './consolidation.ts';
import { createConsolidationScheduler } from './consolidation-scheduler.ts';
import { createNotificationService } from './notifications.ts';
import { createMacNotificationSink } from '../adapters/notifications/macos.ts';
import type { NotificationSink } from '../core/domain/notifications.ts';
import { createDaemonWorkspaces } from './workspaces.ts';
import type { Workspace } from '../core/ports/workspace.ts';
import { createReviewService } from './review.ts';
import { createCheckService } from './checks.ts';
import { CHECK_RUNNER } from '../core/domain/check.ts';
import { createCardService } from './cards.ts';
import type { WorkspaceCard, WorkspaceWatch } from '../core/ports/workspace.ts';
import { createWatchService } from './watches.ts';
import type { JobObserver } from '../platform/watch-command.ts';
import { createManagedService, type ManagedFactories } from './managed.ts';
import { createRemoteClient } from './remote.ts';
import { serveRemoteRpc } from '../adapters/transport/remote-rpc-server.ts';
import { RemoteLeaseStore } from '../adapters/memory/remote-leases.ts';
import { createRemoteViews, createRemoteViewAuthority } from './remote-views.ts';
import { MANAGED_START_RUNNER, MANAGED_HANDOFF_RUNNER } from '../core/domain/managed.ts';

export async function startDaemon(options: {
  paths: RuntimePaths;
  config: RuntimeConfig;
  runners: Readonly<Record<string, (signal: AbortSignal) => AgentRunner | Promise<AgentRunner>>>;
  admit?(
    job: Readonly<JobSnapshot>,
    signal: AbortSignal,
    metadata?: AdmissionMetadata,
  ): Promise<Admission>;
  quotaSources?: Readonly<Record<string, SupportedQuotaSource>>;
  externalSources?: readonly ContextSource[];
  providers?: Readonly<Record<string, ModelProvider>>;
  embeddingProvider?(): ModelProvider;
  environment?: Env;
  consolidationAdmit?(providerId: string, model: string, signal: AbortSignal): Promise<Admission>;
  suggestionAdmit?(providerId: string, model: string, signal: AbortSignal): Promise<Admission>;
  notificationSink?: () => NotificationSink;
  workspaceDriver?: Workspace & Required<Pick<Workspace, 'repository' | 'inspect'>>;
  cardDriver?: WorkspaceCard;
  watchDriver?: WorkspaceWatch;
  watchObserver?: (paths: RuntimePaths) => JobObserver;
  managedFactories?: ManagedFactories;
  remotePort?: number;
  remoteNow?: () => number;
  memoryNow?: () => number;
}) {
  const { paths, config } = options;
  privateDirectory(paths.home);
  privateDirectory(paths.run);
  const manifest = readRuntimeManifest(paths);
  if (manifest.state !== 'ready') throw new BosunError('unavailable', 'Runtime setup incomplete');
  const deploymentId = options.environment?.BOSUN_INSTALLATION_ID;
  if (
    deploymentId &&
    (manifest.installation?.id !== deploymentId ||
      manifest.installation.state !== 'ready' ||
      !['enabling', 'enabled', 'disabling', 'unknown'].includes(
        manifest.installation.service.state,
      ))
  )
    throw new BosunError('conflict', 'Daemon deployment is not admitted');
  if (
    [
      ADMIN_RUNNER,
      SUMMARY_RUNNER,
      MEMORY_SUGGESTION_RUNNER,
      EMBEDDING_RUNNER,
      ROUTER_EVAL_RUNNER,
      CONSOLIDATION_RUNNER,
      CHECK_RUNNER,
      MANAGED_START_RUNNER,
      MANAGED_HANDOFF_RUNNER,
    ].some((id) => Object.hasOwn(options.runners, id))
  )
    throw new BosunError('invalid', 'Reserved runner');
  let memory: ReturnType<typeof openDaemonMemory> | undefined;
  let dispatcher: ReturnType<typeof createDispatcher> | undefined;
  let logging: ReturnType<typeof openRuntimeLog> | undefined;
  let summaries: ReturnType<typeof createSummaryService> | undefined;
  let memorySuggestions: ReturnType<typeof createMemorySuggestions> | undefined;
  let embeddings: ReturnType<typeof createEmbeddingService> | undefined;
  let routerEvaluation: ReturnType<typeof createRouterEvaluation> | undefined;
  let consolidation: ReturnType<typeof createConsolidationService> | undefined;
  let consolidationScheduler: ReturnType<typeof createConsolidationScheduler> | undefined;
  let notifications: ReturnType<typeof createNotificationService> | undefined;
  let workspaces: ReturnType<typeof createDaemonWorkspaces> | undefined;
  let reviews: ReturnType<typeof createReviewService> | undefined;
  let checks: ReturnType<typeof createCheckService> | undefined;
  let cards: ReturnType<typeof createCardService> | undefined;
  let watches: ReturnType<typeof createWatchService> | undefined;
  let managed: ReturnType<typeof createManagedService> | undefined;
  const remoteClient = createRemoteClient({ config, env: options.environment ?? {} });
  let remoteServer: Awaited<ReturnType<typeof serveRemoteRpc>> | undefined;
  let remoteLeases: RemoteLeaseStore | undefined;
  let remoteViews: ReturnType<typeof createRemoteViews> | undefined;
  const runners = Object.fromEntries(
    Object.entries(options.runners).map(([id, factory]) => [
      id,
      async (signal: AbortSignal) => managed!.wrap(id, await factory(signal)),
    ]),
  );
  const jobs = openDaemonJobs({
    stateFile: paths.state,
    ownerFile: paths.owner,
    runners: {
      ...runners,
      [ADMIN_RUNNER]: () =>
        createAdminRunner(memory!, (workspace, projectId) =>
          dispatcher!.indexWorkspace(workspace, projectId),
        ),
      [SUMMARY_RUNNER]: () => summaries!.runner(),
      [MEMORY_SUGGESTION_RUNNER]: () => memorySuggestions!.runner(),
      [EMBEDDING_RUNNER]: () => embeddings!.runner(),
      [ROUTER_EVAL_RUNNER]: () => routerEvaluation!.runner(),
      [CONSOLIDATION_RUNNER]: () => consolidation!.runner(),
      [CHECK_RUNNER]: () => checks!.runner(),
      [MANAGED_START_RUNNER]: () => managed!.bootstrapRunner(),
      [MANAGED_HANDOFF_RUNNER]: () => managed!.handoffRunner(),
    },
    admit: options.admit,
    quotaSources: options.quotaSources,
    internalRunnerIds: [
      ADMIN_RUNNER,
      SUMMARY_RUNNER,
      MEMORY_SUGGESTION_RUNNER,
      EMBEDDING_RUNNER,
      ROUTER_EVAL_RUNNER,
      CONSOLIDATION_RUNNER,
      CHECK_RUNNER,
      MANAGED_START_RUNNER,
      MANAGED_HANDOFF_RUNNER,
    ],
    backgroundRunnerIds: [CONSOLIDATION_RUNNER],
    maxQueue: config.daemon.maxQueuedJobs,
    maxJobs: config.daemon.maxStoredJobs,
    maxEvents: config.daemon.maxStoredEvents,
    maxReceipts: config.daemon.maxStoredReceipts,
    maxDailyGroups: config.daemon.maxDailyUsageGroups,
    retentionDays: config.daemon.jobRetentionDays,
    drainMs: config.daemon.drainMs,
    maxNotifications: config.notifications.maxReceipts,
    maxPendingNotifications: config.notifications.maxPending,
    stateChanged: (job) => {
      notifications?.observe(job);
      managed?.observe(job);
    },
    workspaceAdmit: (job, signal, metadata) =>
      workspaces ? workspaces.admit(job, signal, metadata) : Promise.resolve(false),
    reviewAdmit: (job, signal, metadata) =>
      reviews ? reviews.admit(job, signal, metadata) : Promise.resolve(false),
    checkAdmit: (job, signal, metadata) =>
      checks ? checks.admit(job, signal, metadata) : Promise.resolve(false),
    managedAdmit: (job, signal, metadata) =>
      managed ? managed.admit(job, signal, metadata) : Promise.resolve(false),
    metadata: (event) => {
      logging?.record(event);
    },
  });
  let server: Awaited<ReturnType<typeof serveLocalRpc>> | undefined;
  let draining = false;
  let fault: RpcError | null = null;
  let closePromise: Promise<void> | null = null;
  try {
    // Log ownership follows the same acquired daemon authority, so a losing start cannot append to an active daemon log.
    const log = (logging = openRuntimeLog({ file: path.join(paths.home, 'daemon.log') }));
    jobs.recover();
    // A retained authority lease remains enforced even if TCP serving is later disabled.
    const leaseFile = path.join(paths.home, 'remote-leases.db');
    if (config.remote.enabled || fs.existsSync(leaseFile))
      remoteLeases = new RemoteLeaseStore(leaseFile, jobs.assertOwner);
    if (remoteClient.enabled) {
      remoteViews = createRemoteViews({
        file: path.join(paths.home, 'remote-view.db'),
        binding: {
          authorityId: config.remote.authorityId!,
          clientId: manifest.installationId,
          clientSourceId: manifest.sourceId,
          configRevision: configRevision(config),
        },
        settings: config.remote,
        env: options.environment ?? {},
        assertOwner: jobs.assertOwner,
      });
      remoteClient.attachViews(remoteViews);
    }
    const context = {
      now: options.memoryNow ?? Date.now,
      monotonic: () => performance.now(),
      hash: contentHash,
      dateLabel: (at: number) => new Date(at).toISOString().slice(0, 10),
      measure() {},
    };
    memory = openDaemonMemory({
      paths: { primary: paths.memory, view: paths.view, backups: paths.backups },
      assertOwner: jobs.assertOwner,
      memory: {
        now: options.memoryNow ?? Date.now,
        monotonic: () => performance.now(),
        retention: {
          sessionTtlDays: config.memory.sessionTtlDays,
          purgeAfterDays: config.memory.purgeAfterDays,
        },
        id: (now) =>
          `m_${now.toString(32).padStart(9, '0')}${crypto.randomBytes(4).toString('hex')}`,
        hash: contentHash,
        measure() {},
      },
      context,
      docsIndex: { monotonic: () => performance.now(), measure() {} },
      publicationId: crypto.randomUUID,
      externalSources: options.externalSources,
      ...(remoteClient.enabled ? { curatedSource: remoteClient.source } : {}),
      graphEnabled: config.graph.enabled,
      beforeWrite: () => remoteLeases?.assertWritable(),
    });
    if (memory.schemaVersion !== manifest.memorySchema)
      throw new BosunError(
        'conflict',
        'Runtime memory schema differs from manifest; inspect the supported upgrade',
      );
    const schedule = () => {
      if (!draining && !fault)
        void jobs.runQueued().catch((error) => {
          fault = rpcError(error);
          log.record({
            event: 'daemon.hold',
            state: 'held',
            ...(fault.details?.outcome === 'unknown' ? { outcome: 'unknown' as const } : {}),
          });
        });
    };
    managed = createManagedService({
      jobs,
      config,
      env: options.environment ?? {},
      schedule,
      factories: options.managedFactories,
      handoffs: () => handoffs,
      summaries: () => summaries!,
    });
    const status = () => ({
      state: draining ? 'draining' : fault ? 'held' : 'running',
      logging: log.state(),
      protocol: 1,
      version,
      installationId: manifest.installationId,
      sourceId: manifest.sourceId,
      deploymentId: deploymentId ?? null,
      pid: process.pid,
      primaryHost: config.hosts.primary,
      configRevision: configRevision(config),
      maxConcurrency: 1,
      remote: {
        ...remoteClient.status(),
        ...(remoteServer
          ? { mode: 'server', endpoint: remoteServer.url, authorityId: manifest.installationId }
          : {}),
        ...(remoteLeases ? { leases: remoteLeases.status() } : {}),
      },
      ...(fault ? { error: fault } : {}),
    });
    const handoffs = createHandoffArtifacts({ root: paths.artifacts, jobs });
    const providers = options.providers ?? modelProviders(config, options.environment ?? {});
    summaries = createSummaryService({ config, providers, jobs, handoffs, schedule });
    routerEvaluation = createRouterEvaluation({
      config,
      jobs,
      artifacts: paths.artifacts,
      schedule,
    });
    embeddings = createEmbeddingService({
      config,
      memory,
      jobs,
      schedule,
      provider: options.embeddingProvider,
    });
    memorySuggestions = createMemorySuggestions({
      config,
      providers,
      jobs,
      memory,
      schedule,
      admit: options.suggestionAdmit,
    });
    consolidation = createConsolidationService({
      config,
      providers,
      storage: memory.graph.consolidation(),
      jobs,
      schedule,
      publish: async () => {
        await memory!.publish();
      },
      policy: config.graph.consolidation,
      admit: options.consolidationAdmit,
    });
    notifications = createNotificationService({
      enabled: config.notifications.enabled,
      jobs,
      timeoutMs: config.notifications.timeoutMs,
      sink:
        options.notificationSink ??
        (() =>
          createMacNotificationSink({
            enabled: config.notifications.enabled,
            env: options.environment ?? {},
            cwd: paths.home,
            timeoutMs: config.notifications.timeoutMs,
          })),
    });
    notifications.start();
    workspaces = createDaemonWorkspaces({
      home: paths.home,
      jobs,
      env: options.environment ?? {},
      driver: options.workspaceDriver,
      schedule,
    });
    checks = createCheckService({
      jobs,
      env: options.environment ?? {},
      home: paths.home,
      schedule,
    });
    reviews = createReviewService({ jobs, env: options.environment ?? {}, schedule, checks });
    cards = createCardService({ jobs, env: options.environment ?? {}, driver: options.cardDriver });
    watches = createWatchService({ jobs, env: options.environment ?? {}, paths, driver: options.watchDriver,
      ...(options.watchObserver ? { observer: () => options.watchObserver!(paths) } : {}) });
    dispatcher = createDispatcher({
      stateHome: paths.home,
      jobs,
      memory,
      config,
      context,
      schedule,
      status,
      handoffs,
      summaries,
      memorySuggestions,
      embeddings,
      routerEvaluation,
      consolidation,
      notifications,
      workspaces,
      reviews,
      checks,
      cards,
      watches,
      managed,
      remote: remoteClient,
      remoteViews,
    });
    consolidationScheduler = createConsolidationScheduler({
      enabled:
        !remoteClient.enabled &&
        config.graph.enabled &&
        config.graph.extraction &&
        config.graph.consolidation.schedule.enabled,
      intervalMs: config.graph.consolidation.schedule.intervalMs,
      idle: () => !draining && !fault && jobs.idle(),
      poll: (signal) => dispatcher!.pollConsolidation(signal),
    });
    publishHookConfig(config, paths, {
      sourceId: manifest.sourceId,
      installationId: manifest.installationId,
      now: Date.now(),
    });
    server = await serveLocalRpc({
      socket: paths.socket,
      assertOwner: jobs.assertOwner,
      dispatch: dispatcher.dispatch,
    });
    if (config.remote.enabled)
      remoteServer = await serveRemoteRpc({
        settings: config.remote,
        env: options.environment ?? {},
        identity: {
          protocol: 1,
          version,
          memorySchema: 2,
          authorityId: manifest.installationId,
          sourceId: manifest.sourceId,
        },
        assertOwner: jobs.assertOwner,
        dispatch: dispatcher.dispatch,
        dispatchView: createRemoteViewAuthority({
          leases: remoteLeases!,
          memory,
          authorityId: manifest.installationId,
          sourceId: manifest.sourceId,
          now: options.remoteNow ?? Date.now,
        }),
        port: options.remotePort,
        now: options.remoteNow,
      });
    log.record({ event: 'daemon.start', state: 'running' });
    schedule();
    const close = () => {
      if (closePromise) return closePromise;
      draining = true;
      server!.stopAdmission();
      remoteServer?.stopAdmission();
      closePromise = (async () => {
        let failure: unknown;
        // Stop the executor synchronously before awaiting auxiliary callbacks;
        // otherwise an active job could finish and dispatch another queued job
        // while notification/scheduler shutdown still holds the owner.
        const stops = await Promise.allSettled([
          jobs.drain(),
          consolidationScheduler!.close(),
          notifications!.close(),
          workspaces!.close(),
          reviews!.close(),
          checks!.close(),
          cards!.close(),
          watches!.close(),
        ]);
        for (const result of stops) if (result.status === 'rejected') failure ??= result.reason;
        for (const operation of [
          () => {
            return managed!.close();
          },
          () => server!.close(),
          () => remoteServer?.close(),
          () => {
            dispatcher!.close();
          },
          () => memory!.close(),
          () => remoteViews?.close(),
          () => remoteLeases?.close(),
        ]) {
          try {
            await operation();
          } catch (error) {
            failure ??= error;
          }
        }
        log.record({ event: 'daemon.stop', state: 'stopped' });
        log.close();
        try {
          await jobs.close();
        } catch (error) {
          failure ??= error;
        }
        if (failure) throw failure;
      })();
      return closePromise;
    };
    return { status, close };
  } catch (error) {
    try {
      await managed?.close();
    } catch {}
    try {
      await watches?.close();
      await cards?.close();
    } catch {}
    try {
      await checks?.close();
    } catch {}
    try {
      await reviews?.close();
    } catch {}
    try {
      await workspaces?.close();
    } catch {}
    try {
      await consolidationScheduler?.close();
    } catch {}
    try {
      await notifications?.close();
    } catch {}
    try {
      await server?.close();
    } catch {}
    try {
      await remoteServer?.close();
    } catch {}
    try {
      dispatcher?.close();
    } catch {}
    try {
      await memory?.close();
    } catch {}
    try {
      remoteViews?.close();
    } catch {}
    try {
      remoteLeases?.close();
    } catch {}
    logging?.record({ event: 'daemon.hold', state: 'held' });
    logging?.close();
    try {
      await jobs.close();
    } catch {}
    throw error;
  }
}
