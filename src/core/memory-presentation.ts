import type { Memory, Found } from './domain/memory.ts';
import { mayDeliverMemoryToModel } from './memory-policy.ts';

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const number = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const nullableNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
export const opaqueMemory = () => ({ memory: { private: true } });
// Classification always precedes caller invocation of this declared-field projection.
export function publicMemory(memory: Memory) {
  if (!mayDeliverMemoryToModel(memory)) throw new Error('Memory projection denied');
  return {
    private: false,
    id: text(memory.id),
    category: text(memory.category),
    projectId: nullableText(memory.projectId),
    sessionId: nullableText(memory.sessionId),
    title: text(memory.title),
    body: text(memory.body),
    tags: Array.isArray(memory.tags)
      ? Array.from(memory.tags).filter((tag) => typeof tag === 'string')
      : [],
    status: text(memory.status),
    shared: memory.shared === true,
    source: text(memory.source),
    sourceRef: nullableText(memory.sourceRef),
    hash: text(memory.hash),
    createdAt: number(memory.createdAt),
    updatedAt: number(memory.updatedAt),
    expiresAt: nullableNumber(memory.expiresAt),
    accessedAt: nullableNumber(memory.accessedAt),
    accessCount: number(memory.accessCount),
    version: number(memory.version),
  };
}
export function modelMemoryReply(memory: Memory, explicitlyPrivate = false) {
  return !explicitlyPrivate && mayDeliverMemoryToModel(memory)
    ? { memory: publicMemory(memory) }
    : opaqueMemory();
}
export function modelMemoryStoreReply(
  result: { memory: Memory; duplicate: boolean },
  explicitlyPrivate = false,
) {
  if (explicitlyPrivate) return opaqueMemory();
  const memory = result.memory;
  return mayDeliverMemoryToModel(memory)
    ? { memory: publicMemory(memory), duplicate: result.duplicate }
    : opaqueMemory();
}
export function modelMemoryHits(rows: Found[]) {
  const hits: (ReturnType<typeof publicMemory> & { rank: number; matched?: number })[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (mayDeliverMemoryToModel(row))
      hits.push({
        ...publicMemory(row),
        rank: row.rank,
        ...(row.matched === undefined ? {} : { matched: row.matched }),
      });
  }
  return hits;
}
