import { requirePublicInput } from '../core/policy.ts';
import type { RuntimeConfig } from '../core/domain/config.ts';
import crypto from 'node:crypto';
import type { Ctx, Memory } from '../core/domain/memory.ts';
import type { GraphLevel } from '../core/domain/graph.ts';
import type { ContextDependencies } from '../core/use-cases/retrieve-context.ts';
import { createRetrieveContext } from '../core/use-cases/retrieve-context.ts';
import { createCuratedSource } from '../core/memory-source.ts';
import { createLexicalSource } from '../core/lexical-source.ts';
import { mayDeliverMemoryToModel } from '../core/memory-policy.ts';
import {
  modelMemoryReply,
  modelMemoryStoreReply,
  modelMemoryHits,
} from '../core/memory-presentation.ts';
import { BosunError } from '../core/errors.ts';
import { methodParams, type MethodName, type MethodParams } from '../contracts/methods.ts';
import { rpcRequest, rpcError, type RpcRequest } from '../contracts/rpc.ts';
import { project, memoryScope } from '../platform/project.ts';
import type { openDaemonJobs } from './jobs.ts';
import type { openDaemonMemory } from './memory.ts';
import { ADMIN_RUNNER, enqueueAdmin } from './admin-jobs.ts';
import { EMBEDDING_RUNNER, type createEmbeddingService } from './embeddings.ts';
import { MEMORY_SUGGESTION_RUNNER, type createMemorySuggestions } from './memory-suggestions.ts';
import type { createHandoffArtifacts } from './handoff.ts';
import { createRouteService } from './route.ts';
import { createRouteObservations } from './route-observations.ts';
import type { createRouterEvaluation } from './router-evaluation.ts';
import { ROUTER_EVAL_RUNNER } from '../core/domain/router-evaluation.ts';
import { inspectHandoffCheckout } from '../platform/handoff-checkout.ts';
import { validateHandoffBundle } from '../adapters/handoff/artifacts.ts';
import { SUMMARY_RUNNER, type createSummaryService } from './summary.ts';
import { CONSOLIDATION_RUNNER, type createConsolidationService } from './consolidation.ts';
import { createProfileService } from './profiles.ts';
import type { createNotificationService } from './notifications.ts';
import type { createDaemonWorkspaces } from './workspaces.ts';
import type { createReviewService } from './review.ts';
import type { createCheckService } from './checks.ts';
import { CHECK_RUNNER } from '../core/domain/check.ts';
import type { createCardService } from './cards.ts';
import type { createWatchService } from './watches.ts';
import type { createManagedService } from './managed.ts';
import type { createRemoteClient } from './remote.ts';
import type { createRemoteViews } from './remote-views.ts';
import { contentHash } from '../platform/content-hash.ts';
import { MANAGED_START_RUNNER, MANAGED_HANDOFF_RUNNER } from '../core/domain/managed.ts';

export function createDispatcher(options: {
  jobs: ReturnType<typeof openDaemonJobs>;
  memory: ReturnType<typeof openDaemonMemory>;
  config: RuntimeConfig;
  context: ContextDependencies;
  status(): unknown;
  schedule(): void;
  stateHome?: string;
  handoffs?: ReturnType<typeof createHandoffArtifacts>;
  summaries?: ReturnType<typeof createSummaryService>;
  memorySuggestions?: ReturnType<typeof createMemorySuggestions>;
  embeddings?: ReturnType<typeof createEmbeddingService>;
  routerEvaluation?: ReturnType<typeof createRouterEvaluation>;
  consolidation?: ReturnType<typeof createConsolidationService>;
  notifications?: ReturnType<typeof createNotificationService>;
  workspaces?: ReturnType<typeof createDaemonWorkspaces>;
  reviews?: ReturnType<typeof createReviewService>;
  checks?: ReturnType<typeof createCheckService>;
  cards?: ReturnType<typeof createCardService>;
  watches?: ReturnType<typeof createWatchService>;
  managed?: ReturnType<typeof createManagedService>;
  remote?: ReturnType<typeof createRemoteClient>;
  remoteViews?: ReturnType<typeof createRemoteViews>;
}) {
  const facets = new Map<string, ReturnType<typeof options.memory.project>>();
  const consolidationScopes = new Map<
    string,
    { scope: ReturnType<typeof jobScope>; workspace: string; sessionId: string | null }
  >();
  const curated = options.remote?.enabled
    ? options.remote.source
    : createCuratedSource(options.memory.memory);
  const routing = createRouteService(options.config);
  const routeObservations = createRouteObservations({
    jobs: options.jobs,
    home: options.stateHome ?? '',
    threshold: options.config.router.minConfidence,
  });
  const profiles = createProfileService({
    config: options.config,
    assertOwner: options.jobs.assertOwner,
    loadReviewedProfile: (id, ctx) => options.memory.graph.get(id, ctx),
  });
  let closed = false;
  function caller(request: RpcRequest): Ctx {
    if (!request.scope) throw new BosunError('invalid', 'Workspace scope required');
    const identity = project(request.scope.workspace);
    return {
      ...memoryScope(
        identity,
        options.config.memory.linkedProjects,
        request.scope.sessionId,
        `rpc:${request.scope.audience}`,
      ),
      audience: request.scope.audience,
    };
  }
  function facet(request: RpcRequest, ctx: Ctx) {
    const key = `${request.scope!.workspace}:${ctx.projectId}`;
    if (!facets.has(key)) {
      if (facets.size >= 64) throw new BosunError('unavailable', 'Workspace capacity reached');
      facets.set(
        key,
        options.memory.project({ root: request.scope!.workspace, projectId: ctx.projectId! }),
      );
    }
    return facets.get(key)!;
  }
  function reply(memory: Memory, ctx: Ctx) {
    return ctx.audience === 'model' ? modelMemoryReply(memory) : { memory };
  }
  const jobScope = (ctx: Ctx) => ({ projectId: ctx.projectId, audience: ctx.audience });
  function consolidation(request: RpcRequest, ctx: Ctx) {
    if (!options.consolidation) throw new BosunError('unavailable', 'Consolidation unavailable');
    const key = JSON.stringify([request.scope!.workspace, ctx.projectId, ctx.sessionId]);
    if (!consolidationScopes.has(key) && consolidationScopes.size >= 64)
      throw new BosunError('unavailable', 'Consolidation workspace capacity reached');
    consolidationScopes.set(key, {
      scope: jobScope(ctx),
      workspace: request.scope!.workspace,
      sessionId: ctx.sessionId,
    });
    return options.consolidation;
  }
  function publishAfter(request: RpcRequest, ctx: Ctx): void {
    // A committed memory mutation stays committed even if the background queue
    // is full/fenced. Its public view remains held until explicit publication.
    const id = 'publish_' + crypto.createHash('sha256').update(request.id).digest('hex');
    try {
      enqueueAdmin(options.jobs, options.schedule, 'memory.publish', {}, { ...request, id }, ctx);
    } catch {
      /* owner status/explicit publish can inspect queue pressure */
    }
  }
  const handlers: {
    [K in MethodName]: (
      params: MethodParams<K>,
      request: RpcRequest,
      ctx: Ctx,
      signal: AbortSignal,
    ) => unknown | Promise<unknown>;
  } = {
    async 'remote.vectors.search'(params, request, ctx, signal) {
      requirePublicInput(params);
      if (!ctx.projectId || !options.embeddings)
        throw new BosunError('unsupported', 'Vector authority unavailable');
      const hits = await options.embeddings
        .source(params.privacy, signal, request.scope!.workspace)
        .search(params.text, { ...ctx, linked: [], audience: 'model' }, params.limit);
      return {
        projectId: ctx.projectId,
        sessionId: ctx.sessionId,
        hits: hits.map((hit) => ({
          ...hit,
          private: false,
          projectionHash: contentHash(hit.title, hit.text),
        })),
      };
    },
    async 'remote.graph.search'(params, _request, ctx) {
      if (!ctx.projectId) throw new BosunError('invalid', 'Graph scope required');
      const hits = await options.memory.graph
        .source({ expand: false, levels: params.levels })
        .search(params.text, { ...ctx, linked: [], audience: 'model' }, params.limit);
      return {
        projectId: ctx.projectId,
        sessionId: ctx.sessionId,
        hits: hits.map((hit) => ({
          ...hit,
          private: false,
          projectionHash: contentHash(hit.title, hit.text),
        })),
      };
    },
    async 'remote.lexical.search'(params, _request, ctx) {
      if (!ctx.projectId) throw new BosunError('invalid', 'Lexical scope required');
      const hits = await createLexicalSource(options.memory.memory, options.memory.graph, {
        sessionScoped: true,
      }).search(params.text, { ...ctx, linked: [], audience: 'model' }, params.limit);
      return {
        projectId: ctx.projectId,
        sessionId: ctx.sessionId,
        hits: hits.map((hit) => ({
          ...hit,
          private: false,
          projectionHash: contentHash(hit.title, hit.text),
        })),
      };
    },
    'remote.view.acquire': () => {
      throw new BosunError('unsupported', 'Use authenticated remote view admission');
    },
    'remote.view.release': () => {
      throw new BosunError('unsupported', 'Use authenticated remote view release');
    },
    'remote.view.get': () => {
      throw new BosunError('unsupported', 'Use authenticated remote view inspection');
    },
    'remote.view.refresh': (params, request, ctx, signal) => {
      if (!options.remoteViews) throw new BosunError('unavailable', 'Remote views disabled');
      return options.remoteViews.refresh(ctx, params.ttlMs, signal);
    },
    'remote.view.invalidate': (_params, _request, _ctx, signal) => {
      if (!options.remoteViews) throw new BosunError('unavailable', 'Remote views disabled');
      return options.remoteViews.invalidate(signal);
    },
    'remote.view.reconcile': (_params, _request, _ctx, signal) => {
      if (!options.remoteViews) throw new BosunError('unavailable', 'Remote views disabled');
      return options.remoteViews.reconcile(signal);
    },
    'remote.view.status': () => options.remoteViews?.status() ?? { state: 'disabled' },
    'daemon.status': () => options.status(),
    'managed.authorize': (params, request, ctx) => {
      if (!options.managed) throw new BosunError('unavailable', 'Managed runtime unavailable');
      return options.managed.authorize(params, jobScope(ctx), request.scope!.workspace);
    },
    'managed.handoff': (params, request, ctx) => {
      if (!options.managed) throw new BosunError('unavailable', 'Managed runtime unavailable');
      return options.managed.handoff(params, jobScope(ctx), request.scope!.workspace);
    },
    'managed.start': (params, request, ctx) => {
      if (!options.managed) throw new BosunError('unavailable', 'Managed runtime unavailable');
      return options.managed.start(params, jobScope(ctx), request.scope!.workspace);
    },
    'managed.turn': (params, request, ctx) => {
      if (!options.managed) throw new BosunError('unavailable', 'Managed runtime unavailable');
      return options.managed.turn(params, jobScope(ctx), request.scope!.workspace);
    },
    'managed.get': (params, request, ctx) => {
      if (!options.managed) throw new BosunError('unavailable', 'Managed runtime unavailable');
      return options.managed.get(jobScope(ctx), request.scope!.workspace, params.id);
    },
    'managed.capture': (params, request, ctx, signal) => {
      if (!options.managed) throw new BosunError('unavailable', 'Managed runtime unavailable');
      return options.managed.capture(params, jobScope(ctx), request.scope!.workspace, signal);
    },
    'managed.retire': (params, request, ctx, signal) => {
      if (!options.managed) throw new BosunError('unavailable', 'Managed runtime unavailable');
      return options.managed.retire(params, jobScope(ctx), request.scope!.workspace, signal);
    },
    async 'route.classify'(params, request, ctx, signal) {
      const result = await routing.classify(params, signal);
      options.jobs.assertOwner();
      if (project(request.scope!.workspace).id !== ctx.projectId)
        throw new BosunError('conflict', 'Routing workspace changed');
      return { ...result, observation: routeObservations.record(ctx, result) };
    },
    'route.status': (_params, _request, _ctx, signal) => routing.status(signal),
    'route.observations': (params, _request, ctx) =>
      routeObservations.list(ctx, params.legacy, params.limit),
    'route.label': (params, _request, ctx) => routeObservations.label(ctx, params),
    'route.stats': (params, _request, ctx) => routeObservations.stats(ctx, params.legacy),
    'route.evaluate': (params, request, ctx) => {
      if (!options.routerEvaluation)
        throw new BosunError('unavailable', 'Router evaluation unavailable');
      return options.routerEvaluation.evaluate(params, ctx, request.scope!.workspace);
    },
    'route.capture': (params, request, ctx) => {
      if (!options.routerEvaluation)
        throw new BosunError('unavailable', 'Router evaluation unavailable');
      return options.routerEvaluation.submit(params, ctx, request.scope!.workspace);
    },
    'route.frozen': (params, request, ctx) => {
      if (!options.routerEvaluation)
        throw new BosunError('unavailable', 'Router evaluation unavailable');
      return options.routerEvaluation.frozen(ctx, request.scope!.workspace, params.id);
    },
    async 'hook.candidates'(params, _request, ctx) {
      const records = await options.memory.memory.search(
        { text: params.task, limit: 20, includePrivate: false, touch: false },
        ctx,
      );
      return { ids: records.filter(mayDeliverMemoryToModel).map((memory) => memory.id) };
    },
    async 'memory.store'(params, _request, ctx) {
      const result = await options.memory.memory.store(params, ctx);
      publishAfter(_request, ctx);
      if (ctx.audience === 'model') return modelMemoryStoreReply(result, params.private === true);
      return result;
    },
    'memory.embed': (params, request, ctx) => {
      if (!options.embeddings) throw new BosunError('unavailable', 'Embedding service unavailable');
      return options.embeddings.submit(params, ctx, request.scope!.workspace);
    },
    'memory.autoStore': (params, request, ctx, signal) => {
      if (!options.memorySuggestions)
        throw new BosunError('unavailable', 'Memory suggestions unavailable');
      return options.memorySuggestions.submit(params, ctx, request.scope!.workspace, signal);
    },
    async 'memory.search'(params, _request, ctx) {
      const results = await options.memory.memory.search(
        ctx.audience === 'model' ? { ...params, includePrivate: false } : params,
        ctx,
      );
      return {
        hits: ctx.audience === 'model' ? modelMemoryHits(results) : results,
      };
    },
    async 'memory.get'(params, _request, ctx) {
      return reply(
        await options.memory.memory.get(params.id, ctx, {
          events: ctx.audience === 'owner' && params.events,
        }),
        ctx,
      );
    },
    async 'memory.update'(params, request, ctx) {
      const value = await options.memory.memory.update(
        params.id,
        params.patch,
        params.expectedVersion,
        ctx,
      );
      publishAfter(request, ctx);
      return ctx.audience === 'model'
        ? modelMemoryReply(value, params.patch.private === true)
        : { memory: value };
    },
    async 'memory.delete'(params, request, ctx) {
      const value = await options.memory.memory.delete(params.id, ctx);
      publishAfter(request, ctx);
      return reply(value, ctx);
    },
    async 'memory.accept'(params, request, ctx) {
      const value = await options.memory.memory.accept(params.id, ctx);
      publishAfter(request, ctx);
      return reply(value, ctx);
    },
    async 'memory.reject'(params, request, ctx) {
      const value = await options.memory.memory.reject(params.id, ctx);
      publishAfter(request, ctx);
      return reply(value, ctx);
    },
    async 'memory.purge'(params, request, ctx) {
      await options.memory.memory.purge(params.id, ctx);
      publishAfter(request, ctx);
      return { purged: params.id };
    },
    'memory.stats': (_params, _request, ctx) => options.memory.memory.stats(ctx),
    'memory.maintain': (params, request, ctx) =>
      enqueueAdmin(options.jobs, options.schedule, 'memory.maintain', params, request, ctx),
    'memory.publish': (_params, request, ctx) =>
      enqueueAdmin(options.jobs, options.schedule, 'memory.publish', {}, request, ctx),
    'graph.create': (params, request, ctx) => {
      const artifact = options.memory.graph.create(params, ctx);
      publishAfter(request, ctx);
      return { artifact };
    },
    'graph.get': (params, _request, ctx) => ({
      artifact: options.memory.graph.get(params.id, ctx),
    }),
    'graph.query': (params, _request, ctx) => options.memory.graph.query(params, ctx),
    'graph.explain': (params, _request, ctx) => options.memory.graph.explain(params.id, ctx),
    'graph.review': (params, request, ctx) => {
      const artifact = options.memory.graph.review(
        params.id,
        params.expectedVersion,
        params.action,
        ctx,
      );
      publishAfter(request, ctx);
      return { artifact };
    },
    'graph.revoke': (params, request, ctx) => {
      const result = options.memory.graph.revoke(params.id, params.expectedVersion, ctx);
      if (result.invalidated) publishAfter(request, ctx);
      return result;
    },
    'graph.backfill': (params, request, ctx) => {
      const result = options.memory.graph.backfill(ctx, params.limit);
      if (result.created) publishAfter(request, ctx);
      return result;
    },
    'graph.exportProfile': (params, _request, ctx) =>
      options.memory.graph.exportProfile(params.id, ctx),
    'consolidation.run': (params, request, ctx, signal) =>
      consolidation(request, ctx).submit(
        params,
        jobScope(ctx),
        request.scope!.workspace,
        ctx.sessionId,
        signal,
      ),
    'consolidation.status': (_params, request, ctx) =>
      consolidation(request, ctx).status(jobScope(ctx), ctx.sessionId),
    'consolidation.proposals': (params, request, ctx) => ({
      proposals: consolidation(request, ctx).proposals(jobScope(ctx), ctx.sessionId, params.limit),
    }),
    'consolidation.abandon': (params, request, ctx) =>
      consolidation(request, ctx).abandon(
        jobScope(ctx),
        ctx.sessionId,
        params.id,
        params.expectedVersion,
      ),
    'profile.export': (params, _request, ctx) => profiles.export(params, ctx),
    'profile.inspect': (params, _request, ctx) => profiles.inspect(params, ctx),
    'profile.preview': (params, _request, ctx) => profiles.preview(params, ctx),
    async 'context.retrieve'(params, request, ctx, signal) {
      const selected = params.sources ?? ['curated', 'docs', 'claude-mem'];
      if (selected.includes('curated') && selected.includes('lexical'))
        throw new BosunError('invalid', 'Select one curated retrieval strategy');
      if (selected.includes('vectors')) {
        requirePublicInput(params);
      }
      const graphLevels: GraphLevel[] = [
        ...(selected.includes('graph') ? ([1, 2] as GraphLevel[]) : []),
        ...(selected.includes('overview') ? ([3, 4] as GraphLevel[]) : []),
      ];
      const sources = [
        ...(selected.includes('curated') ? [curated] : []),
        ...(selected.includes('vectors') && options.embeddings
          ? [
              options.remote?.enabled
                ? options.remote.vectorSource(params.privacy, signal)
                : options.embeddings.source(params.privacy, signal, request.scope!.workspace),
            ]
          : []),
        ...(selected.includes('lexical')
          ? [options.remote?.enabled ? options.remote.lexicalSource : options.memory.lexical]
          : []),
        ...(selected.includes('docs') ? [facet(request, ctx).docs] : []),
        ...(selected.includes('claude-mem') ? options.memory.externalSources : []),
        ...(graphLevels.length && options.memory.graph.enabled
          ? [
              options.remote?.enabled
                ? options.remote.graphForLevels(graphLevels)
                : options.memory.graph.source({ expand: false, levels: graphLevels }),
            ]
          : []),
      ];
      const result = await createRetrieveContext(sources, options.context)(params.task, ctx, {
        budgetTokens: params.budgetTokens ?? 1000,
        minScore: 0,
        itemChars: options.config.context.itemChars,
        includeCandidates: params.includeCandidates,
      });
      return {
        text: result.text,
        estTokens: result.estTokens,
        ids: result.items.map((item) => item.id),
        sources: result.sources,
        ...(params.includeCandidates
          ? {
              candidates: result.candidates ?? [],
              items: result.items.map(({ source, id }) => ({ source, id })),
            }
          : {}),
        ms: result.ms,
      };
    },
    'docs.index': (_params, request, ctx) =>
      enqueueAdmin(options.jobs, options.schedule, 'docs.index', {}, request, ctx),
    'job.submit'(params, request, ctx) {
      if (
        [
          ADMIN_RUNNER,
          MEMORY_SUGGESTION_RUNNER,
          EMBEDDING_RUNNER,
          ROUTER_EVAL_RUNNER,
          SUMMARY_RUNNER,
          CONSOLIDATION_RUNNER,
          CHECK_RUNNER,
          MANAGED_START_RUNNER,
          MANAGED_HANDOFF_RUNNER,
        ].includes(params.runnerId)
      )
        throw new BosunError('unsupported', 'Reserved runner');
      const result = options.jobs.submit(
        { ...params, cwd: request.scope!.workspace },
        jobScope(ctx),
      );
      options.schedule();
      return result;
    },
    'job.watch': (params, request, ctx, signal) => {
      if (!options.watches) throw new BosunError('unavailable', 'Watch authority unavailable');
      return options.watches.submit(params, jobScope(ctx), request.scope!.workspace, request.scope!.sessionId, signal);
    },
    'job.watchGet': (params, request, ctx, signal) => {
      if (!options.watches) throw new BosunError('unavailable', 'Watch authority unavailable');
      return options.watches.get(jobScope(ctx), request.scope!.workspace, params.id, false, signal);
    },
    'job.watchReconcile': (params, request, ctx, signal) => {
      if (!options.watches) throw new BosunError('unavailable', 'Watch authority unavailable');
      return options.watches.get(jobScope(ctx), request.scope!.workspace, params.id, true, signal);
    },
    'job.get': (params, _request, ctx) => options.jobs.get(jobScope(ctx), params.id),
    'job.result': (params, _request, ctx) => ({
      result: options.jobs.result(jobScope(ctx), params.id),
    }),
    'job.list': (params, _request, ctx) => ({
      jobs: options.jobs.list(jobScope(ctx), params.limit),
    }),
    'job.events': (params, _request, ctx) =>
      options.jobs.events(jobScope(ctx), params.after, params.limit),
    'job.cancel': (params, _request, ctx) => options.jobs.cancel(jobScope(ctx), params.id),
    async 'job.release'(params, _request, ctx) {
      const result = await options.jobs.release(jobScope(ctx), params.id);
      if (result.state === 'queued') options.schedule();
      return result;
    },
    'job.retention': (_params, _request, ctx) => options.jobs.retention.status(jobScope(ctx)),
    'job.policy': (params, _request, ctx) => options.jobs.policy(jobScope(ctx), params.id),
    'job.prune': (params, _request, ctx) =>
      options.jobs.retention.prune(jobScope(ctx), params.limit),
    'quota.status': () => options.jobs.quota.status(),
    'usage.list': (params, _request, ctx) => ({
      attempts: options.jobs.usage.list(jobScope(ctx), params.limit),
    }),
    'usage.daily': (params, _request, ctx) => ({
      coverage: 'archived-attempts',
      days: options.jobs.usage.daily(jobScope(ctx), params.limit),
    }),
    'notification.status': (_params, _request, ctx) => {
      if (!options.notifications) throw new BosunError('unavailable', 'Notifications unavailable');
      return options.notifications.status(jobScope(ctx));
    },
    'workspace.create': (params, request, ctx, signal) => {
      if (!options.workspaces)
        throw new BosunError('unavailable', 'Workspace authority unavailable');
      return options.workspaces.create(params, jobScope(ctx), request.scope!.workspace, signal);
    },
    'workspace.get': (params, request, ctx, signal) => {
      if (!options.workspaces)
        throw new BosunError('unavailable', 'Workspace authority unavailable');
      return options.workspaces.get(jobScope(ctx), request.scope!.workspace, params.id, signal);
    },
    'workspace.list': async (_params, request, ctx, signal) => {
      if (!options.workspaces)
        throw new BosunError('unavailable', 'Workspace authority unavailable');
      return {
        workspaces: await options.workspaces.list(jobScope(ctx), request.scope!.workspace, signal),
      };
    },
    'workspace.reconcile': (params, request, ctx, signal) => {
      if (!options.workspaces)
        throw new BosunError('unavailable', 'Workspace authority unavailable');
      return options.workspaces.reconcile(
        jobScope(ctx),
        request.scope!.workspace,
        params.id,
        signal,
      );
    },
    'workspace.prunePreview': (params, request, ctx, signal) => {
      if (!options.workspaces)
        throw new BosunError('unavailable', 'Workspace authority unavailable');
      return options.workspaces.reconcile(
        jobScope(ctx),
        request.scope!.workspace,
        params.id,
        signal,
      );
    },
    'workspace.submit': (params, request, ctx, signal) => {
      if (!options.workspaces)
        throw new BosunError('unavailable', 'Workspace authority unavailable');
      if (
        [
          ADMIN_RUNNER,
          MEMORY_SUGGESTION_RUNNER,
          EMBEDDING_RUNNER,
          ROUTER_EVAL_RUNNER,
          SUMMARY_RUNNER,
          CONSOLIDATION_RUNNER,
          CHECK_RUNNER,
          MANAGED_START_RUNNER,
          MANAGED_HANDOFF_RUNNER,
        ].includes(params.runnerId)
      )
        throw new BosunError('unsupported', 'Reserved runner');
      return options.workspaces.submit(params, jobScope(ctx), request.scope!.workspace, signal);
    },
    'spin.submit': (params, request, ctx, signal) => {
      if (!options.workspaces)
        throw new BosunError('unavailable', 'Workspace authority unavailable');
      if (
        [
          ADMIN_RUNNER,
          MEMORY_SUGGESTION_RUNNER,
          EMBEDDING_RUNNER,
          ROUTER_EVAL_RUNNER,
          SUMMARY_RUNNER,
          CONSOLIDATION_RUNNER,
          CHECK_RUNNER,
          MANAGED_START_RUNNER,
          MANAGED_HANDOFF_RUNNER,
        ].includes(params.runnerId)
      )
        throw new BosunError('unsupported', 'Reserved runner');
      return options.workspaces.spin(params, jobScope(ctx), request.scope!.workspace, signal);
    },
    'review.submit': (params, request, ctx, signal) => {
      if (!options.reviews) throw new BosunError('unavailable', 'Review authority unavailable');
      return options.reviews.submit(params, jobScope(ctx), request.scope!.workspace, signal);
    },
    'review.get': (params, request, ctx, signal) => {
      if (!options.reviews) throw new BosunError('unavailable', 'Review authority unavailable');
      return options.reviews.get(jobScope(ctx), request.scope!.workspace, params.id, signal);
    },
    'check.submit': (params, request, ctx, signal) => {
      if (!options.checks)
        throw new BosunError('unavailable', 'Verification authority unavailable');
      return options.checks.submit(params, jobScope(ctx), request.scope!.workspace, signal);
    },
    'check.get': (params, request, ctx, signal) => {
      if (!options.checks)
        throw new BosunError('unavailable', 'Verification authority unavailable');
      return options.checks.get(jobScope(ctx), request.scope!.workspace, params.id, signal);
    },
    'card.submit': (params, request, ctx, signal) => {
      if (!options.cards) throw new BosunError('unavailable', 'Card authority unavailable');
      return options.cards.submit(params, jobScope(ctx), request.scope!.workspace, signal);
    },
    'card.get': (params, request, ctx, signal) => {
      if (!options.cards) throw new BosunError('unavailable', 'Card authority unavailable');
      return options.cards.get(jobScope(ctx), request.scope!.workspace, params.id, signal);
    },
    'card.reconcile': (params, request, ctx, signal) => {
      if (!options.cards) throw new BosunError('unavailable', 'Card authority unavailable');
      return options.cards.reconcile(jobScope(ctx), request.scope!.workspace, params.id, signal);
    },
    'card.acknowledge': (params, request, ctx, signal) => {
      if (!options.cards) throw new BosunError('unavailable', 'Card authority unavailable');
      return options.cards.acknowledge(params, jobScope(ctx), request.scope!.workspace, signal);
    },
    'quota.refresh': (params, _request, _ctx, signal) => options.jobs.quota.refresh(params, signal),
    'handoff.create': (params, _request, ctx) => {
      if (!options.handoffs) throw new BosunError('unavailable', 'Handoff artifacts unavailable');
      return options.handoffs.create(params, jobScope(ctx));
    },
    'handoff.get': (params, _request, ctx) => {
      if (!options.handoffs) throw new BosunError('unavailable', 'Handoff artifacts unavailable');
      return options.handoffs.get(jobScope(ctx), params.id);
    },
    'handoff.list': (params, _request, ctx) => {
      if (!options.handoffs) throw new BosunError('unavailable', 'Handoff artifacts unavailable');
      return { artifacts: options.handoffs.list(jobScope(ctx), params.limit) };
    },
    'handoff.summarize': (params, request, ctx) => {
      if (!options.summaries) throw new BosunError('unavailable', 'Summary service unavailable');
      return options.summaries.submit(params, jobScope(ctx), request.scope!.workspace);
    },
    'handoff.import': (params, _request, ctx) => {
      if (!options.handoffs) throw new BosunError('unavailable', 'Handoff artifacts unavailable');
      const bundle = validateHandoffBundle(params.bundle);
      const checkout = inspectHandoffCheckout(_request.scope!.workspace, bundle.manifest.facts);
      return { ...options.handoffs.import(jobScope(ctx), params.requestId, bundle), checkout };
    },
  };
  return {
    async pollConsolidation(signal: AbortSignal) {
      if (
        closed ||
        signal.aborted ||
        !options.config.graph.enabled ||
        !options.config.graph.extraction ||
        !options.consolidation
      )
        return;
      // Only explicitly registered owner scopes are eligible. Round-robin finite
      // polling enqueues at most one job and never competes with active work.
      for (const [key, value] of [...consolidationScopes]) {
        if (closed || signal.aborted || !options.jobs.idle()) return;
        consolidationScopes.delete(key);
        consolidationScopes.set(key, value);
        if (project(value.workspace).id !== value.scope.projectId) {
          consolidationScopes.delete(key);
          continue;
        }
        try {
          const result = await options.consolidation.submit(
            { requestId: crypto.randomUUID() },
            value.scope,
            value.workspace,
            value.sessionId,
            signal,
          );
          if (result.state === 'queued') return;
        } catch {
          /* Existing source/job state remains authoritative; no recovery or replay. */
        }
      }
    },
    indexWorkspace(workspace: string, projectId: string) {
      if (closed) throw new BosunError('unavailable', 'Dispatcher unavailable');
      return facet(
        {
          version: 1,
          id: 'admin',
          method: 'docs.index',
          params: {},
          scope: { workspace, sessionId: null, audience: 'owner' },
        },
        { projectId, sessionId: null, linked: [], audience: 'owner' },
      ).index();
    },
    async dispatch(input: RpcRequest, signal: AbortSignal): Promise<unknown> {
      if (closed || signal.aborted) throw new BosunError('unavailable', 'Dispatcher unavailable');
      const request = rpcRequest(input);
      const params = methodParams(request);
      const ctx =
        request.method === 'daemon.status'
          ? { projectId: null, sessionId: null, linked: [] }
          : caller(request);
      options.jobs.assertOwner();
      try {
        if (
          options.remote?.enabled &&
          ['job.get', 'job.result', 'job.policy'].includes(request.method)
        ) {
          try {
            options.jobs.get(jobScope(ctx), (params as { id: string }).id);
          } catch (error) {
            if (error instanceof BosunError && error.code === 'not_found')
              return await options.remote.dispatch(request, ctx, signal);
            throw error;
          }
        } else if (options.remote?.handles(request.method))
          return await options.remote.dispatch(request, ctx, signal);
        const handler = handlers[request.method as MethodName] as (
          params: unknown,
          request: RpcRequest,
          ctx: Ctx,
          signal: AbortSignal,
        ) => unknown;
        return await handler(params, request, ctx, signal);
      } catch (error) {
        const normalized = rpcError(error);
        if (ctx.audience === 'model' && normalized.details)
          delete normalized.details.currentVersion;
        throw new BosunError(normalized.code, normalized.message, { details: normalized.details });
      }
    },
    close() {
      closed = true;
      for (const value of facets.values()) value.close();
      facets.clear();
      consolidationScopes.clear();
    },
  };
}
