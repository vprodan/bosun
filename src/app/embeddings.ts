import crypto from 'node:crypto';
import { BosunError } from '../core/errors.ts';
import { requireCapability, requirePublicInput } from '../core/policy.ts';
import { indexEmbeddings } from '../core/use-cases/index-embeddings.ts';
import type { Ctx } from '../core/domain/memory.ts';
import type { RuntimeConfig } from '../core/domain/config.ts';
import type { ModelProvider } from '../core/ports/model.ts';
import type { ContextSource } from '../core/ports/context-source.ts';
import { embeddingInputs, normalizedVector } from '../core/embeddings.ts';
import type { AgentRunner } from '../core/ports/runner.ts';
import { embeddingIndexRequest } from '../contracts/embedding.ts';
import { project } from '../platform/project.ts';
import { createOllamaEmbeddingProvider } from '../adapters/models/ollama-embedding.ts';
import type { openDaemonMemory } from './memory.ts';
import type { openDaemonJobs } from './jobs.ts';
import type { SqliteVecOpen, SqliteVecDistance } from '../adapters/memory/sqlite-vec.ts';

export const EMBEDDING_RUNNER = 'bosun-embedding-index';
export function createEmbeddingService(options: {
  config: RuntimeConfig;
  memory: ReturnType<typeof openDaemonMemory>;
  jobs: ReturnType<typeof openDaemonJobs>;
  schedule(): void;
  provider?(): ModelProvider;
  sqliteVecOpen?: SqliteVecOpen;
}) {
  const settings = options.config.graph.embedding,
    settingsHash = crypto.createHash('sha256').update(JSON.stringify(settings)).digest('hex');
  const provider = () => options.provider?.() ?? createOllamaEmbeddingProvider(settings);
  const queries = new Map<string, { at: number; vector: number[] }>();
  function validate(input: unknown, ctx: Ctx, workspace: string) {
    requirePublicInput(input as { privacy?: unknown });
    options.jobs.assertOwner();
    if (ctx.audience !== 'owner' || !ctx.projectId)
      throw new BosunError('unsupported', 'Owner embedding operation required');
    const parsed = embeddingIndexRequest.safeParse(input);
    if (!parsed.success) throw new BosunError('invalid', 'Invalid embedding request');
    if (!options.config.graph.vectors)
      throw new BosunError('unsupported', 'Embedding indexing disabled');
    if (project(workspace).id !== ctx.projectId)
      throw new BosunError('conflict', 'Embedding workspace changed');
    return parsed.data;
  }
  return {
    source(privacy: unknown, signal: AbortSignal, workspace: string): ContextSource {
      const enabled =
        options.config.graph.vectors &&
        (settings.backend === 'reference' ||
          (settings.backend === 'sqlite-vec' && settings.extension !== undefined));
      return {
        id: 'vectors',
        trust: enabled ? 'verified' : 'unsupported',
        weight: 0.6,
        halfLifeDays: 60,
        async search(text, ctx, limit) {
          requirePublicInput({ privacy });
          if (!enabled) return [];
          signal.throwIfAborted();
          options.jobs.assertOwner();
          if (project(workspace).id !== ctx.projectId)
            throw new BosunError('conflict', 'Embedding workspace changed');
          const spaces = options.memory.embeddings.spaces(settings, ctx);
          if (spaces.length === 0) return [];
          if (spaces.length !== 1)
            throw new BosunError('unavailable', 'Embedding space requires an exact digest');
          const selected = spaces[0];
          const request = {
            privacy: 'public' as const,
            purpose: 'query' as const,
            inputs: [{ privacy: 'public' as const, text }],
            model: settings.model,
            digest: selected.digest,
            dimensions: settings.dimensions,
            transform: settings.transform,
            signal,
          };
          const inputs = embeddingInputs(request);
          let native: SqliteVecDistance | null = null;
          if (settings.backend === 'sqlite-vec') {
            const { openSqliteVecDistance } = await import('../adapters/memory/sqlite-vec.ts');
            native = openSqliteVecDistance(settings.extension!, options.sqliteVecOpen);
            if (!native) return []; // Explicit native selection never silently becomes reference ranking.
          }
          let key: string | undefined;
          try {
            const generation = options.memory.embeddings.generation(selected, ctx);
            key = crypto
              .createHash('sha256')
              .update(
                JSON.stringify({
                  projectId: ctx.projectId,
                  sessionId: ctx.sessionId,
                  linked: [...ctx.linked].sort(),
                  settingsHash,
                  selected,
                  generation,
                  inputs,
                }),
              )
              .digest('hex');
            const verify = () => {
              signal.throwIfAborted();
              options.jobs.assertOwner();
              if (project(workspace).id !== ctx.projectId)
                throw new BosunError('conflict', 'Embedding workspace changed');
              const current = options.memory.embeddings.spaces(selected, ctx);
              if (
                current.length !== 1 ||
                current[0].digest !== selected.digest ||
                options.memory.embeddings.generation(selected, ctx) !== generation
              )
                throw new BosunError('conflict', 'Embedding corpus changed');
            };
            const previous = settings.queryCacheSize ? queries.get(key) : undefined;
            const cached =
              previous && performance.now() - previous.at <= settings.queryCacheTtlMs
                ? previous
                : undefined;
            let vector: number[];
            if (cached) {
              verify();
              vector = cached.vector;
              queries.delete(key);
              queries.set(key, cached);
            } else {
              queries.delete(key);
              const implementation = provider();
              requireCapability(implementation.caps.embeddings, 'embeddings');
              requireCapability(implementation.caps.toolFree, 'tool-free embeddings');
              if (!implementation.embed)
                throw new BosunError('unsupported', 'Embedding query unavailable');
              const result = await implementation.embed({ ...request, verifySource: verify });
              verify();
              if (
                result.model !== selected.model ||
                result.digest !== selected.digest ||
                result.dimensions !== selected.dimensions ||
                result.transform !== selected.transform ||
                result.vectors.length !== 1
              )
                throw new BosunError('unavailable', 'Embedding query changed', {
                  details: { outcome: 'unknown' },
                });
              vector = normalizedVector(result.vectors[0], selected.dimensions);
            }
            const hits = options.memory.embeddings
              .search(vector, selected, ctx, {
                limit: Math.min(limit, 20),
                minCosine: settings.minCosine,
                ...(native ? { score: native.score } : {}),
              })
              .map((row) => ({
                source: 'vectors',
                id: row.memoryId,
                title: row.title,
                text: row.text,
                category: row.category,
                rank: -row.cosine,
                at: row.at,
                accessCount: 0,
                hash: row.hash,
              }));
            native?.close();
            native = null;
            verify();
            if (!cached && settings.queryCacheSize) {
              queries.set(key, { at: performance.now(), vector });
              while (queries.size > settings.queryCacheSize) {
                const oldest = queries.keys().next();
                if (oldest.done) break;
                queries.delete(oldest.value);
              }
            }
            return hits;
          } catch (error) {
            if (key) queries.delete(key);
            throw error;
          } finally {
            native?.close();
          }
        },
      };
    },
    submit(input: unknown, ctx: Ctx, workspace: string) {
      const request = validate(input, ctx, workspace),
        scope = { projectId: ctx.projectId, audience: 'owner' as const };
      const requestId = `embedding_${crypto.createHash('sha256').update(request.requestId).digest('hex')}`;
      const previous = options.jobs.findRequest(scope, requestId);
      if (previous) return { job: previous, duplicate: true };
      options.memory.embeddings.capture(request.ids, ctx);
      const result = options.jobs.submit(
        {
          privacy: 'public',
          ownerOnly: true,
          requestId,
          taskId: crypto.randomUUID(),
          runnerId: EMBEDDING_RUNNER,
          model: settings.model,
          cwd: workspace,
          access: 'edit',
          prompt: JSON.stringify({ request, ctx, settingsHash }),
        },
        scope,
      );
      options.schedule();
      return result;
    },
    runner(): AgentRunner {
      return {
        id: EMBEDDING_RUNNER,
        caps: {
          vendor: 'local-embedding',
          readOnly: 'unsupported',
          sandbox: 'none',
          mcpInject: 'unsupported',
          effort: 'unsupported',
          localBackend: 'unverified',
          billing: 'local',
        },
        detect: async () => ({ installed: true }),
        async *run(spec) {
          requirePublicInput(spec);
          const payload = JSON.parse(spec.prompt) as {
            request: unknown;
            ctx: Ctx;
            settingsHash: string;
          };
          const request = validate(payload.request, payload.ctx, spec.cwd);
          if (
            payload.settingsHash !== settingsHash ||
            spec.model !== settings.model ||
            spec.access !== 'edit'
          )
            throw new BosunError('conflict', 'Embedding configuration changed');
          const signal = AbortSignal.any([spec.signal, AbortSignal.timeout(settings.timeoutMs)]);
          const result = await indexEmbeddings(request, {
            capture: (ids) => options.memory.embeddings.capture(ids, payload.ctx),
            store: (records) => options.memory.embeddings.store(records, payload.ctx),
            provider,
            space: settings,
            hash: (text) => crypto.createHash('sha256').update(text).digest('hex'),
            id: () => `v_${crypto.randomUUID()}`,
            signal,
            verify() {
              options.jobs.assertOwner();
              if (project(spec.cwd).id !== payload.ctx.projectId)
                throw new BosunError('conflict', 'Embedding workspace changed');
            },
          });
          if (result.tokensIn !== undefined) yield { t: 'usage', tokensIn: result.tokensIn };
          yield { t: 'done', code: 0, result: JSON.stringify(result) };
        },
      };
    },
  };
}
