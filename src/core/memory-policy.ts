import { screenPublicText } from './secret-screen.ts';
export type MemoryAudience = 'owner' | 'model';
// Deny the entire record, including title/tags/provenance/derived data, for private model exposure.
// This does not replace project-scope authorization. Unclassified records fail closed.
export function mayExposeMemory(record: unknown, audience: MemoryAudience): boolean {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  try {
    if (audience === 'model' && !Object.hasOwn(record, 'private')) return false;
    // Classification is the first and only property read for a denied record.
    const flag = (record as { private?: unknown }).private;
    return audience === 'owner' ? typeof flag === 'boolean' : audience === 'model' && flag === false;
  } catch { return false; }
}
// Legacy owner rows keep their IDs/flags/content. A public flag cannot override a
// known credential pattern in a model reply or a derived context pack.
export function mayDeliverMemoryToModel(record: unknown): boolean {
  if (!mayExposeMemory(record, 'model')) return false;
  try {
    const memory = record as Record<string, unknown>;
    for (const key of ['title', 'body', 'source', 'sourceRef']) if (typeof memory[key] === 'string') screenPublicText(memory[key] as string);
    if (Array.isArray(memory.tags)) for (const tag of memory.tags) if (typeof tag === 'string') screenPublicText(tag);
    return true;
  } catch { return false; }
}
