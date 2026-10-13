import crypto from 'node:crypto';
import { z } from 'zod';
import { BosunError } from '../core/errors.ts';
import { mayDeliverMemoryToModel } from '../core/memory-policy.ts';
import { opaqueMemory, publicMemory } from '../core/memory-presentation.ts';
import type { RuntimeConfig } from '../core/domain/config.ts';
import type { Env } from '../core/domain/inference.ts';
import type { Ctx } from '../core/domain/memory.ts';
import type { GraphLevel } from '../core/domain/graph.ts';
import type { ContextSource } from '../core/ports/context-source.ts';
import type { RpcRequest } from '../contracts/rpc.ts';
import { REMOTE_METHODS } from '../contracts/remote.ts';
import { callRemoteRpc, RemoteAccessError } from '../adapters/transport/remote-rpc.ts';
import type { createRemoteViews } from './remote-views.ts';
import { contentHash } from '../platform/content-hash.ts';
import { screenPublicText } from '../core/secret-screen.ts';
import { requirePublicInput } from '../core/policy.ts';

const timestamp = z.number().int().min(0).max(8640000000000000);
const publicHit = z.strictObject({
  private: z.literal(false),
  shared: z.boolean(),
  id: z.string().min(1).max(64),
  category: z.enum(['personal', 'project', 'session']),
  projectId: z.string().nullable(),
  sessionId: z.string().nullable(),
  title: z.string().max(200),
  body: z.string().max(16000),
  tags: z.array(z.string().max(64)).max(40),
  status: z.enum(['active', 'proposed', 'archived']),
  source: z.string().max(200),
  sourceRef: z.string().nullable(),
  hash: z.string().regex(/^[a-f0-9]{32}$/),
  createdAt: timestamp,
  updatedAt: timestamp,
  expiresAt: timestamp.nullable(),
  accessedAt: timestamp.nullable(),
  accessCount: z.number().int().min(0),
  version: z.number().int().min(1),
  rank: z.number().finite().optional(),
  matched: z.number().int().min(0).optional(),
});
const graphHit = z.strictObject({
  private: z.literal(false),
  source: z.literal('graph'),
  id: z.string().min(1).max(100),
  title: z.string().min(1).max(200),
  text: z.string().max(4000),
  category: z.string().max(80),
  rank: z.number().finite(),
  at: timestamp,
  accessCount: z.literal(0),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  matched: z.number().int().min(0).max(24).optional(),
  projectionHash: z.string().regex(/^[a-f0-9]{32}$/),
});
const lexicalHit = graphHit.extend({
  source: z.literal('curated'),
  id: z.string().min(1).max(64),
  hash: z.string().regex(/^[a-f0-9]{32}$/),
  accessCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  matched: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
});
const vectorHit = lexicalHit.extend({ source: z.literal('vectors'), accessCount: z.literal(0) });
const graphEnvelope = z.strictObject({
  projectId: z.string().regex(/^p_[a-f0-9]{16}$/),
  sessionId: z.string().min(1).max(200).nullable(),
  hits: z.array(z.unknown()).max(20),
});
export function createRemoteClient(options: { config: RuntimeConfig; env: Env }) {
  const enabled = !!options.config.remote.authority;
  let outcome: 'unverified' | 'available' | 'unavailable' = 'unverified';
  let views: ReturnType<typeof createRemoteViews> | undefined;
  async function dispatch(request: RpcRequest, ctx: Ctx, signal: AbortSignal) {
    if (!enabled || !ctx.projectId) throw new BosunError('unavailable', 'Remote scope unavailable');
    try {
      const value = await callRemoteRpc({
        settings: options.config.remote,
        env: options.env,
        projectId: ctx.projectId,
        request:
          request.scope?.audience === 'model' && request.method === 'memory.search'
            ? { ...request, params: { ...request.params, includePrivate: false } }
            : request,
        signal,
      });
      outcome = 'available';
      if (request.scope?.audience !== 'model' || !request.method.startsWith('memory.'))
        return value;
      if (
        (request.method === 'memory.store' && request.params.private === true) ||
        (request.method === 'memory.update' &&
          (request.params.patch as { private?: unknown } | undefined)?.private === true)
      )
        return opaqueMemory();
      const row = value as { memory?: unknown; hits?: unknown; duplicate?: unknown };
      const projectAllowed = (item: z.infer<typeof publicHit>) =>
        ((item.projectId === null && item.category === 'personal') ||
          item.projectId === ctx.projectId ||
          (!!item.projectId && ctx.linked.includes(item.projectId))) &&
        (item.category !== 'session' || item.shared || item.sessionId === ctx.sessionId);
      const checked = (input: unknown) => {
        if (!mayDeliverMemoryToModel(input)) return null;
        const parsed = publicHit.safeParse(input);
        if (
          !parsed.success ||
          !projectAllowed(parsed.data) ||
          contentHash(parsed.data.title, parsed.data.body) !== parsed.data.hash
        )
          throw new BosunError('unavailable', 'Remote memory projection unavailable');
        return parsed.data;
      };
      if (request.method === 'memory.search') {
        if (!Array.isArray(row?.hits) || row.hits.length > 50)
          throw new BosunError('unavailable', 'Remote search unavailable');
        return {
          hits: row.hits.flatMap((hit) => {
            const item = checked(hit);
            return item
              ? [
                  {
                    ...publicMemory(item),
                    rank: item.rank ?? 0,
                    ...(item.matched === undefined ? {} : { matched: item.matched }),
                  },
                ]
              : [];
          }),
        };
      }
      const item = checked(row?.memory);
      return item
        ? {
            memory: publicMemory(item),
            ...(typeof row.duplicate === 'boolean' ? { duplicate: row.duplicate } : {}),
          }
        : opaqueMemory();
    } catch (error) {
      outcome = 'unavailable';
      if (error instanceof RemoteAccessError) views?.rejectAccess();
      throw error;
    }
  }
  const source: ContextSource = {
    id: 'curated',
    trust: 'verified',
    weight: 1,
    halfLifeDays: 60,
    async search(text, ctx, limit) {
      const request: RpcRequest = {
        version: 1,
        id: crypto.randomUUID(),
        method: 'memory.search',
        params: { text, limit, includePrivate: false },
        scope: { workspace: '/', sessionId: ctx.sessionId, audience: 'model' },
      };
      let value: unknown;
      try {
        screenPublicText(text);
        value = await dispatch(request, ctx, AbortSignal.timeout(options.config.remote.timeoutMs));
      } catch {
        return [];
      } // Other client-local sources remain readable; no local L1 fallback.
      const parsed = z.strictObject({ hits: z.array(publicHit).max(50) }).safeParse(value);
      if (!parsed.success) {
        outcome = 'unavailable';
        return [];
      }
      return parsed.data.hits
        .filter(
          (hit) =>
            mayDeliverMemoryToModel(hit) &&
            contentHash(hit.title, hit.body) === hit.hash &&
            ((hit.projectId === null && hit.category === 'personal') ||
              hit.projectId === ctx.projectId ||
              (!!hit.projectId && ctx.linked.includes(hit.projectId))) &&
            hit.status === 'active' &&
            (hit.category !== 'session' || hit.shared || hit.sessionId === ctx.sessionId) &&
            (hit.expiresAt === null || hit.expiresAt > Date.now()),
        )
        .map((hit) => ({
          source: 'curated',
          id: hit.id,
          title: hit.title,
          text: hit.body,
          category: hit.category,
          rank: hit.rank ?? 0,
          at: hit.updatedAt,
          accessCount: hit.accessCount,
          hash: hit.hash,
          matched: hit.matched,
        }));
    },
  };
  const projectionSource = (
    kind: 'graph' | 'lexical' | 'vectors',
    levels?: GraphLevel[],
    privacy?: unknown,
    signal?: AbortSignal,
  ): ContextSource => ({
    id: kind === 'lexical' ? 'curated' : kind,
    trust: 'verified',
    weight: kind === 'graph' ? 0.7 : kind === 'vectors' ? 0.6 : 1,
    halfLifeDays: 60,
    async search(text, ctx, limit) {
      if (kind === 'vectors') {
        requirePublicInput({ privacy });
        if (!options.config.graph.vectors) return [];
      }
      if (kind === 'graph' && !options.config.graph.enabled) return [];
      let value: unknown;
      try {
        screenPublicText(text);
        value = await dispatch(
          {
            version: 1,
            id: crypto.randomUUID(),
            method: `remote.${kind}.search`,
            params: {
              privacy: 'public',
              text: kind === 'vectors' ? text : text.slice(0, 2000),
              limit: Math.min(limit, 20),
              ...(kind === 'graph' && levels ? { levels } : {}),
            },
            scope: { workspace: '/', sessionId: ctx.sessionId, audience: 'model' },
          },
          ctx,
          AbortSignal.any([
            AbortSignal.timeout(options.config.remote.timeoutMs),
            ...(signal ? [signal] : []),
          ]),
        );
      } catch {
        return [];
      }
      // Classify each response before any content projection. A closed per-call scope prevents client L2 fallback.
      const envelope = graphEnvelope.safeParse(value);
      if (
        !envelope.success ||
        envelope.data.projectId !== ctx.projectId ||
        envelope.data.sessionId !== ctx.sessionId
      ) {
        outcome = 'unavailable';
        return [];
      }
      const hits = [];
      for (const candidate of envelope.data.hits) {
        if (!mayDeliverMemoryToModel(candidate)) continue;
        const parsed = (
          kind === 'graph' ? graphHit : kind === 'vectors' ? vectorHit : lexicalHit
        ).safeParse(candidate);
        if (
          !parsed.success ||
          parsed.data.projectionHash !== contentHash(parsed.data.title, parsed.data.text)
        ) {
          outcome = 'unavailable';
          return [];
        }
        const hit = parsed.data;
        try {
          screenPublicText(hit.title);
          screenPublicText(hit.text);
        } catch {
          outcome = 'unavailable';
          return [];
        }
        hits.push({
          source: hit.source,
          id: hit.id,
          title: hit.title,
          text: hit.text,
          category: hit.category,
          rank: hit.rank,
          at: hit.at,
          accessCount: hit.accessCount,
          hash: hit.hash,
          matched: hit.matched,
        });
      }
      return hits;
    },
  });
  const graphSource = projectionSource('graph'),
    lexicalSource = projectionSource('lexical');
  return {
    enabled,
    handles: (method: string) =>
      enabled && REMOTE_METHODS.has(method) && !method.startsWith('remote.view.'),
    attachViews(value: ReturnType<typeof createRemoteViews>) {
      views = value;
    },
    dispatch,
    source,
    graphSource,
    graphForLevels: (levels: GraphLevel[]) => projectionSource('graph', levels),
    lexicalSource,
    vectorSource: (privacy: unknown, signal: AbortSignal) =>
      projectionSource('vectors', undefined, privacy, signal),
    status: () => ({
      mode: enabled ? 'client' : 'local',
      outcome,
      authorityId: options.config.remote.authorityId ?? null,
      offlineWrites: false,
      localView: views?.status() ?? { state: 'disabled' },
    }),
  };
}
