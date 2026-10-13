import { BosunError } from '../../core/errors.ts';
import { embeddingInputs, normalizedVector } from '../../core/embeddings.ts';
import { requirePublicInput } from '../../core/policy.ts';
import type { ModelProvider, EmbedRequest } from '../../core/ports/model.ts';
import { httpJson, protocolBase } from '../../platform/http-json.ts';

export type OllamaEmbeddingSettings = {
  url: string;
  model: string;
  dimensions: number;
  transform: 'embeddinggemma-v1' | 'plain-v1';
  digest?: string;
  timeoutMs: number;
  keepAlive: string;
};
const object = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const cloud = (v: Record<string, unknown>) =>
  ['remote_host', 'remote_model'].some((key) => v[key] !== undefined && v[key] !== '');
const digest = (v: unknown) =>
  typeof v === 'string' && /^(?:sha256:)?[a-f0-9]{64}$/.test(v) ? v.replace(/^sha256:/, '') : null;
const unavailable = (unknown = false) =>
  new BosunError(
    'unavailable',
    'Embedding provider unavailable',
    unknown ? { details: { outcome: 'unknown' } } : undefined,
  );
export function createOllamaEmbeddingProvider(settings: OllamaEmbeddingSettings): ModelProvider {
  const base = protocolBase(settings.url, true),
    model = settings.model;
  if (
    !model ||
    model.length > 200 ||
    !Number.isSafeInteger(settings.dimensions) ||
    settings.dimensions < 1 ||
    settings.dimensions > 4096 ||
    !Number.isSafeInteger(settings.timeoutMs) ||
    settings.timeoutMs < 1 ||
    settings.timeoutMs > 60000 ||
    !/^(?:0|[1-9][0-9]{0,4}(?:ms|s|m))$/.test(settings.keepAlive) ||
    (settings.digest !== undefined && !digest(settings.digest))
  )
    throw new BosunError('invalid', 'Invalid embedding configuration');
  async function selected(signal: AbortSignal) {
    const list = object(
      await httpJson(`${base}/api/tags`, { method: 'GET', signal }, settings.timeoutMs, 524288),
    );
    if (!list || !Array.isArray(list.models) || list.models.length > 1024) throw unavailable();
    const matches = list.models
      .map(object)
      .filter((row) => row && (row.model === model || row.name === model));
    if (matches.length !== 1 || !matches[0] || cloud(matches[0])) throw unavailable();
    const hash = digest(matches[0].digest);
    if (!hash || (settings.digest && hash !== digest(settings.digest))) throw unavailable();
    const show = object(
      await httpJson(
        `${base}/api/show`,
        {
          method: 'POST',
          signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model, verbose: false }),
        },
        settings.timeoutMs,
        524288,
      ),
    );
    if (
      !show ||
      cloud(show) ||
      !Array.isArray(show.capabilities) ||
      !show.capabilities.includes('embedding')
    )
      throw unavailable();
    return hash;
  }
  return {
    id: model,
    caps: {
      structured: 'unsupported',
      local: 'unverified',
      numCtx: 'unsupported',
      toolFree: 'verified',
      embeddings: 'verified',
    },
    async generate(request) {
      requirePublicInput(request);
      throw new BosunError('unsupported', 'Embedding provider does not generate text');
    },
    async health(signal) {
      try {
        await selected(signal);
        return !signal.aborted;
      } catch {
        return false;
      }
    },
    async embed(request: EmbedRequest) {
      const inputs = embeddingInputs(request); // Entire batch classified/screened before metadata/provider access.
      if (
        (request.model !== undefined && request.model !== model) ||
        request.dimensions !== settings.dimensions ||
        request.transform !== settings.transform
      )
        throw new BosunError('invalid', 'Embedding model/space differs');
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(settings.timeoutMs)]);
      let attempted = false;
      try {
        signal.throwIfAborted();
        const hash = await selected(signal);
        if (request.digest !== undefined && digest(request.digest) !== hash) throw unavailable();
        request.verifySource?.();
        attempted = true;
        const raw = object(
          await httpJson(
            `${base}/api/embed`,
            {
              method: 'POST',
              signal,
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                model,
                input: inputs,
                truncate: false,
                dimensions: settings.dimensions,
                keep_alive: settings.keepAlive,
              }),
            },
            settings.timeoutMs,
            1048576,
          ),
        );
        if (
          !raw ||
          raw.model !== model ||
          !Array.isArray(raw.embeddings) ||
          raw.embeddings.length !== inputs.length
        )
          throw unavailable(true);
        const vectors = raw.embeddings.map((vector) =>
          normalizedVector(vector as number[], settings.dimensions),
        );
        const metrics: Record<string, number> = {};
        for (const [key, out] of [
          ['prompt_eval_count', 'tokensIn'],
          ['total_duration', 'totalNs'],
          ['load_duration', 'loadNs'],
        ] as const) {
          const value = raw[key];
          if (value !== undefined) {
            if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
              throw unavailable(true);
            metrics[out] = value;
          }
        }
        if ((await selected(signal)) !== hash || signal.aborted) throw unavailable(true);
        request.verifySource?.();
        return {
          model,
          digest: hash,
          dimensions: settings.dimensions,
          transform: settings.transform,
          vectors,
          ...metrics,
        };
      } catch (error) {
        if (!attempted && error instanceof BosunError) throw error;
        throw unavailable(attempted);
      }
    },
  };
}
