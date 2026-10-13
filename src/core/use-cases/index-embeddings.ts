import { BosunError } from '../errors.ts';
import { requireCapability, requirePublicInput } from '../policy.ts';
import { embeddingInputs, embeddingText, normalizedVector } from '../embeddings.ts';
import type { ModelProvider } from '../ports/model.ts';
import type { EmbeddingRecord, EmbeddingSource, EmbeddingSpace } from '../domain/embedding.ts';

export async function indexEmbeddings(
  input: { privacy: 'public'; ids: string[] },
  deps: {
    capture(ids: string[]): EmbeddingSource[];
    store(records: EmbeddingRecord[]): unknown;
    provider(): ModelProvider;
    space: Omit<EmbeddingSpace, 'digest'> & { digest?: string };
    hash(text: string): string;
    id(): string;
    signal: AbortSignal;
    verify(): void;
  },
) {
  requirePublicInput(input);
  deps.signal.throwIfAborted();
  deps.verify();
  const original = deps.capture(input.ids);
  const verify = () => {
    deps.signal.throwIfAborted();
    deps.verify();
    const current = deps.capture(input.ids);
    if (
      current.length !== original.length ||
      current.some(
        (row, i) =>
          row.memoryId !== original[i].memoryId ||
          row.version !== original[i].version ||
          row.hash !== original[i].hash,
      )
    )
      throw new BosunError('conflict', 'Embedding source changed');
  };
  const chunks = original.flatMap((source) => {
    const out: {
      source: EmbeddingSource;
      chunk: number;
      start: number;
      end: number;
      text: string;
    }[] = [];
    for (let start = 0; start < source.body.length; ) {
      let end = Math.min(source.body.length, start + 1000);
      if (end < source.body.length && /[\uD800-\uDBFF]/.test(source.body[end - 1])) end--;
      out.push({ source, chunk: out.length, start, end, text: source.body.slice(start, end) });
      start = end;
    }
    return out;
  });
  // Entire source window is screened before selecting a model implementation.
  for (let i = 0; i < chunks.length; i += 8)
    embeddingInputs({
      privacy: 'public',
      purpose: 'document',
      inputs: chunks
        .slice(i, i + 8)
        .map((row) => ({ privacy: 'public', title: row.source.title, text: row.text })),
      dimensions: deps.space.dimensions,
      transform: deps.space.transform,
      signal: deps.signal,
    });
  verify();
  const provider = deps.provider();
  requireCapability(provider.caps.embeddings, 'embeddings');
  requireCapability(provider.caps.toolFree, 'tool-free embeddings');
  if (!provider.embed) throw new BosunError('unsupported', 'Embedding method unavailable');
  const records: EmbeddingRecord[] = [];
  let selectedDigest = deps.space.digest,
    tokensIn: number | undefined;
  for (let i = 0; i < chunks.length; i += 8) {
    const batch = chunks.slice(i, i + 8);
    verify();
    const result = await provider.embed({
      privacy: 'public',
      purpose: 'document',
      inputs: batch.map((row) => ({ privacy: 'public', title: row.source.title, text: row.text })),
      model: deps.space.model,
      digest: selectedDigest,
      dimensions: deps.space.dimensions,
      transform: deps.space.transform,
      signal: deps.signal,
      verifySource: verify,
    });
    verify();
    if (
      result.model !== deps.space.model ||
      result.dimensions !== deps.space.dimensions ||
      result.transform !== deps.space.transform ||
      !/^[a-f0-9]{64}$/.test(result.digest) ||
      (selectedDigest !== undefined && result.digest !== selectedDigest) ||
      result.vectors.length !== batch.length
    )
      throw new BosunError('unavailable', 'Embedding result changed', {
        details: { outcome: 'unknown' },
      });
    selectedDigest = result.digest;
    if (result.tokensIn !== undefined) {
      if (!Number.isSafeInteger(result.tokensIn) || result.tokensIn < 0)
        throw new BosunError('unavailable', 'Embedding usage invalid');
      tokensIn = (tokensIn ?? 0) + result.tokensIn;
      if (!Number.isSafeInteger(tokensIn))
        throw new BosunError('unavailable', 'Embedding usage invalid', {
          details: { outcome: 'unknown' },
        });
    }
    for (let n = 0; n < batch.length; n++) {
      const row = batch[n];
      records.push({
        id: deps.id(),
        memoryId: row.source.memoryId,
        version: row.source.version,
        hash: row.source.hash,
        chunk: row.chunk,
        start: row.start,
        end: row.end,
        space: { ...deps.space, digest: result.digest },
        inputHash: deps.hash(
          embeddingText('document', deps.space.transform, row.text, row.source.title),
        ),
        vector: normalizedVector(result.vectors[n], deps.space.dimensions),
      });
    }
  }
  verify();
  const stored = deps.store(records);
  return {
    stored,
    model: deps.space.model,
    digest: selectedDigest,
    dimensions: deps.space.dimensions,
    transform: deps.space.transform,
    sources: original.length,
    chunks: records.length,
    ...(tokensIn === undefined ? {} : { tokensIn }),
  };
}
