import crypto from 'node:crypto';
import { BosunError } from '../core/errors.ts';
import type { Ctx } from '../core/domain/memory.ts';
import type { Lane } from '../core/domain/route.ts';
import {
  routeObservation,
  routeStatistics,
  ROUTE_OBSERVATION_LIMITS,
} from '../core/domain/route-observation.ts';
import { readLegacyRouteLog } from '../platform/legacy-route-log.ts';
import type { openDaemonJobs } from './jobs.ts';
import type { createRouteService } from './route.ts';

export function createRouteObservations(options: {
  home: string;
  jobs: ReturnType<typeof openDaemonJobs>;
  threshold: number;
}) {
  function owner(ctx: Ctx) {
    options.jobs.assertOwner();
    if (ctx.audience !== 'owner' || !ctx.projectId)
      throw new BosunError('unsupported', 'Owner operation required');
    return { projectId: ctx.projectId, audience: 'owner' as const };
  }
  function rows(ctx: Ctx, legacy: boolean, limit: number) {
    const scope = owner(ctx);
    const labels = new Map(
      options.jobs.routing
        .labels(scope, legacy ? 'legacy' : 'recorded')
        .map((label) => [label.id, label]),
    );
    const historical = legacy ? readLegacyRouteLog(options.home) : undefined;
    const values = historical
      ? historical.rows.slice().reverse().slice(0, limit)
      : options.jobs.routing.list(scope, limit);
    return values.map((value) => ({
      ...value,
      label: labels.get(value.id) ?? historical?.labels.get(value.id) ?? null,
    }));
  }
  return {
    record(
      ctx: Ctx,
      result: Awaited<ReturnType<ReturnType<typeof createRouteService>['classify']>>,
    ) {
      if (!ctx.projectId || !result.route || !result.status.digest) return null;
      const id = crypto.randomUUID();
      try {
        options.jobs.assertOwner();
        const value = routeObservation({
          schema: 1,
          id,
          at: Date.now(),
          projectId: ctx.projectId,
          sessionKey:
            ctx.sessionId === null
              ? null
              : crypto
                  .createHash('sha256')
                  .update(JSON.stringify([ctx.projectId, ctx.sessionId]))
                  .digest('hex'),
          audience: ctx.audience === 'model' ? 'model' : 'owner',
          digest: result.status.digest,
          threshold: options.threshold,
          lane: result.route.decision.lane,
          conf: result.route.decision.conf,
          risk: result.route.decision.risk,
          risk_conf: result.route.decision.risk_conf,
          ms: result.route.decision.ms,
          router: result.route.decision.router,
          final: result.route.final,
          why: result.route.why,
        });
        options.jobs.routing.record({ projectId: ctx.projectId, audience: 'owner' }, value);
        return { id, state: 'recorded' as const };
      } catch (error) {
        return {
          id,
          state:
            error instanceof BosunError && error.details?.outcome === 'unknown'
              ? ('unknown' as const)
              : ('held' as const),
        };
      }
    },
    list(ctx: Ctx, legacy = false, limit = 50) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new BosunError('invalid', 'Invalid observation limit');
      return {
        source: legacy ? 'legacy' : 'recorded',
        scope: legacy ? 'unscoped' : 'project',
        observations: rows(ctx, legacy, limit),
        calibration: 'unverified',
        automaticDispatch: false,
      };
    },
    label(ctx: Ctx, input: { id: string; label: Lane; expectedVersion: number; legacy?: boolean }) {
      const scope = owner(ctx),
        source = input.legacy ? ('legacy' as const) : ('recorded' as const);
      const historical = input.legacy ? readLegacyRouteLog(options.home) : undefined;
      if (historical && !historical.rows.some((row) => row.id === input.id))
        throw new BosunError('not_found', 'Historical observation not found');
      return {
        label: options.jobs.routing.label(
          scope,
          input.id,
          input.label,
          input.expectedVersion,
          source,
          Date.now(),
          historical?.valid,
        ),
      };
    },
    stats(ctx: Ctx, legacy = false) {
      return {
        source: legacy ? 'legacy' : 'recorded',
        scope: legacy ? 'unscoped' : 'project',
        ...routeStatistics(rows(ctx, legacy, ROUTE_OBSERVATION_LIMITS.records)),
      };
    },
  };
}
