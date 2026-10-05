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
