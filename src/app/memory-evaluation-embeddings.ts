import crypto from 'node:crypto';
import { z } from 'zod';
import { embeddingEvaluationRequest } from '../contracts/embedding.ts';
import { BosunError } from '../core/errors.ts';
import { requirePublicInput } from '../core/policy.ts';
import type { MemoryEvalNote } from '../core/domain/memory-evaluation.ts';
import type { JobSnapshot } from '../core/domain/job.ts';
import type { ModelProvider } from '../core/ports/model.ts';
import { benchmarkDistribution } from '../core/memory-benchmark.ts';
import { embeddingInputs } from '../core/embeddings.ts';
import { createOllamaEmbeddingProvider } from '../adapters/models/ollama-embedding.ts';
import { callLocalRpc } from '../adapters/transport/local-rpc.ts';
import { EMBEDDING_RUNNER } from './embeddings.ts';

const receipt = z.strictObject({
  stored: z.strictObject({ stored: z.number().int().min(1).max(32) }),
  model: z.string(),
  digest: z.string(),
  dimensions: z.number(),
  transform: z.string(),
  sources: z.number().int().min(1).max(8),
  chunks: z.number().int().min(1).max(32),
  tokensIn: z.number().int().min(0).optional(),
});
const unknown = () =>
  new BosunError('unavailable', 'Embedding evaluation outcome unknown', {
    details: { outcome: 'unknown' },
  });

// A fixed, explicitly public model selection. This factory performs no HTTP;
// every actual embedding goes through the existing provider and owner executor.
export function evaluationEmbeddings(input: unknown, live: () => void) {
  requirePublicInput(input as { privacy?: unknown });
  const parsed = embeddingEvaluationRequest.safeParse(input);
  if (!parsed.success)
    throw new BosunError('invalid', 'Pinned reference embedding evaluation required');
  const settings = Object.freeze(parsed.data.settings);
  const implementation = createOllamaEmbeddingProvider(settings);
  const embed = implementation.embed?.bind(implementation);
  if (!embed) throw new BosunError('unsupported', 'Embedding evaluation provider unavailable');
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(settings)).digest('hex');
  const latency: number[] = [],
    jobs: { id: string; sourceIds: string[]; resultSha256: string; chunks: number }[] = [];
  const counter = () => ({
    requested: 0,
    completed: 0,
    reportedTokensIn: null as number | null,
    missingTokenCounts: 0,
  });
  const usage = { document: counter(), query: counter() };
  let sequence = 0;
  const provider: ModelProvider = {
    ...implementation,
    async embed(request) {
      embeddingInputs(request);
      live();
      const counters = usage[request.purpose];
      counters.requested++;
      const started = performance.now();
      try {
        const result = await embed({
          ...request,
          verifySource() {
            live();
            request.verifySource?.();
          },
        });
        live();
        counters.completed++;
        if (result.tokensIn === undefined) counters.missingTokenCounts++;
        else {
          counters.reportedTokensIn = (counters.reportedTokensIn ?? 0) + result.tokensIn;
          if (!Number.isSafeInteger(counters.reportedTokensIn)) throw unknown();
        }
        return result;
      } finally {
        latency.push(performance.now() - started);
      }
    },
  };
  return {
    settings,
    selection: {
      schema: 1,
      settings,
      fingerprint,
      frozenBefore: 'indexing',
      automaticActivation: false,
    },
    provider: () => provider,
    async index(options: {
      socket: string;
      notes: readonly MemoryEvalNote[];
      workspaces: ReadonlyMap<string | null, { workspace: string; projectId: string }>;
    }) {
      const groups = new Map<string, MemoryEvalNote[]>();
      for (const note of options.notes) {
        const key = JSON.stringify([note.scope.projectId, note.scope.sessionId]);
        const group = groups.get(key) ?? [];
        group.push(note);
        groups.set(key, group);
      }
      for (const group of groups.values()) {
        const note = group[0],
          binding = options.workspaces.get(note.scope.projectId);
        if (!binding) throw new BosunError('invalid', 'Embedding replica scope missing');
        const scope = {
          workspace: binding.workspace,
          sessionId: note.scope.sessionId,
          audience: 'owner' as const,
        };
        const rpc = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
          live();
          const result = await callLocalRpc<T>({
            socket: options.socket,
            request: {
              version: 1,
              id: `embedding_eval_${++sequence}`,
              method,
              params,
              scope,
            },
          });
          live();
          return result;
        };
        for (let start = 0; start < group.length; start += 8) {
          const ids = group.slice(start, start + 8).map((source) => source.id);
          const queued = await rpc<{ job: JobSnapshot; duplicate: boolean }>('memory.embed', {
            privacy: 'public',
            requestId: `eval_index_${jobs.length}`,
            ids,
          });
          let job = queued.job;
          if (queued.duplicate || job.runnerId !== EMBEDDING_RUNNER || !job.ownerOnly)
            throw unknown();
          const deadline = performance.now() + settings.timeoutMs + 1000;
          while (['queued', 'running'].includes(job.state) && performance.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 10));
            job = await rpc<JobSnapshot>('job.get', { id: job.id });
          }
          if (job.state !== 'succeeded') throw unknown(); // Inspect once; never release/retry/resubmit.
          const returned = await rpc<{ result: string }>('job.result', { id: job.id });
          let decoded: unknown;
          try {
            decoded = JSON.parse(returned.result);
          } catch {
            throw unknown();
          }
          const result = receipt.safeParse(decoded);
          if (
            !result.success ||
            result.data.model !== settings.model ||
            result.data.digest !== settings.digest ||
            result.data.dimensions !== settings.dimensions ||
            result.data.transform !== settings.transform ||
            result.data.sources !== ids.length ||
            result.data.stored.stored !== result.data.chunks
          )
            throw unknown();
          jobs.push({
            id: job.id,
            sourceIds: ids,
            chunks: result.data.chunks,
            resultSha256: crypto.createHash('sha256').update(returned.result).digest('hex'),
          });
        }
      }
    },
    report: () => ({
      model: settings.model,
      digest: settings.digest,
      dimensions: settings.dimensions,
      transform: settings.transform,
      backend: settings.backend,
      settingsFingerprint: fingerprint,
      selectionFrozenBeforeIndexing: true,
      indexedJobs: jobs,
      usage,
      queryCache: { size: settings.queryCacheSize, ttlMs: settings.queryCacheTtlMs },
      providerLatency: benchmarkDistribution(latency),
      physicalModelQualification: 'unverified',
      actualHostTokens: 'unverified',
      compiledQualification: 'unverified',
      automaticActivation: false,
    }),
  };
}
