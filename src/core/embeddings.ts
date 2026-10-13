import { BosunError } from './errors.ts';
import { requirePublicInput } from './policy.ts';
import { screenPublicText } from './secret-screen.ts';
import { data } from './domain/job.ts';
import type { EmbedRequest } from './ports/model.ts';

export const EMBEDDING_LIMITS = Object.freeze({
  batch: 8,
  dimensions: 4096,
  inputChars: 4096,
  totalChars: 16384,
});
export function embeddingText(
  purpose: 'query' | 'document',
  transform: 'embeddinggemma-v1' | 'plain-v1',
  text: string,
  title = 'none',
): string {
  return transform === 'plain-v1'
    ? text
    : purpose === 'query'
      ? `task: search result | query: ${text}`
      : `title: ${title} | text: ${text}`;
}
export function embeddingInputs(input: EmbedRequest): string[] {
  requirePublicInput(input);
  const rows = data(input, 'inputs');
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > EMBEDDING_LIMITS.batch)
    throw new BosunError('invalid', 'Invalid embedding batch');
  for (let i = 0; i < rows.length; i++)
    requirePublicInput(data(rows, String(i)) as { privacy?: unknown });
  const { purpose, transform, dimensions } = input;
  if (
    !['query', 'document'].includes(purpose) ||
    !['embeddinggemma-v1', 'plain-v1'].includes(transform) ||
    !Number.isSafeInteger(dimensions) ||
    dimensions < 1 ||
    dimensions > EMBEDDING_LIMITS.dimensions ||
    (purpose === 'query' && rows.length !== 1)
  )
    throw new BosunError('invalid', 'Invalid embedding request');
  const out: string[] = [];
  let total = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i],
      text = row.text,
      title = row.title ?? 'none';
    if (
      typeof text !== 'string' ||
      !text.trim() ||
      text.length > EMBEDDING_LIMITS.inputChars ||
      text.includes('\0') ||
      typeof title !== 'string' ||
      title.length > 200 ||
      title.includes('\0')
    )
      throw new BosunError('invalid', 'Invalid embedding input');
    screenPublicText(text);
    screenPublicText(title);
    const value = embeddingText(purpose, transform, text, title);
    total += value.length;
    if (total > EMBEDDING_LIMITS.totalChars)
      throw new BosunError('invalid', 'Embedding batch exceeds limit');
    out.push(value);
  }
  return out;
}
export function normalizedVector(input: readonly number[], dimensions: number): number[] {
  if (
    !Array.isArray(input) ||
    input.length !== dimensions ||
    !Number.isSafeInteger(dimensions) ||
    dimensions < 1 ||
    dimensions > 4096
  )
    throw new BosunError('invalid', 'Invalid embedding vector');
  let norm = 0;
  const values = input.map((value) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1e30)
      throw new BosunError('invalid', 'Invalid embedding component');
    norm += value * value;
    return value;
  });
  if (!Number.isFinite(norm) || norm <= 0)
    throw new BosunError('invalid', 'Empty embedding vector');
  const scale = Math.sqrt(norm);
  return values.map((value) => Math.fround(value / scale));
}
export function vectorBytes(vector: readonly number[]): Uint8Array {
  const buffer = new ArrayBuffer(vector.length * 4),
    view = new DataView(buffer);
  vector.forEach((value, i) => {
    view.setFloat32(i * 4, value, true);
  });
  return new Uint8Array(buffer);
}
export function readVector(bytes: Uint8Array, dimensions: number): number[] {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== dimensions * 4)
    throw new BosunError('unavailable', 'Embedding data unavailable');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return normalizedVector(
    Array.from({ length: dimensions }, (_, i) => view.getFloat32(i * 4, true)),
    dimensions,
  );
}
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) throw new BosunError('invalid', 'Vector spaces differ');
  return Math.max(
    -1,
    Math.min(
      1,
      a.reduce((sum, value, i) => sum + value * b[i], 0),
    ),
  );
}
