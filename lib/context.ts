// Compatibility composition: existing real callers delegate ranking/packing to the ambient-free core.
import { record } from './metrics.ts';
import { contentHash } from '../src/platform/content-hash.ts';
import { createRetrieveContext, type ContextOptions } from '../src/core/use-cases/retrieve-context.ts';
import { mayExposeMemory } from '../src/core/memory-policy.ts';
import { MemoryError, type Ctx, type MemoryApi, type MemoryProvider } from './memory/types.ts';
export { estTokens, type Item, type Result } from '../src/core/use-cases/retrieve-context.ts';
const METADATA = Object.freeze({
  curated: Object.freeze({ weight: 1.0, halfLifeDays: 60 }),
  docs: Object.freeze({ weight: 0.8, halfLifeDays: 90 }),
  'claude-mem': Object.freeze({ weight: 0.6, halfLifeDays: 30 }),
});

// Classification precedes metadata/body access, including adapters that ignore includePrivate.
export const curated = (api: Pick<MemoryApi, 'search'>): MemoryProvider => ({
  name: 'curated',
  async search(text, ctx, limit) {
    return Array.from(await api.search({ text, limit, includePrivate: false }, ctx)).filter((m) => mayExposeMemory(m, 'model')).map((m) => ({
      source: 'curated' as const, id: m.id, title: m.title, text: m.body, category: m.category, rank: m.rank, at: m.updatedAt, accessCount: m.accessCount, hash: m.hash, matched: m.matched,
    }));
  },
});

// Only the three reviewed legacy names can acquire metadata or expose their search callback.
// New source composition uses ContextSource explicitly; hits never confer trust.
export async function retrieve(task: string, providers: MemoryProvider[], ctx: Ctx, o: ContextOptions) {
  if (!Array.isArray(providers)) throw new MemoryError('invalid', 'invalid context request');
  const sources = providers.flatMap((provider) => {
    if (!provider || typeof provider !== 'object') throw new MemoryError('invalid', 'invalid context request');
    const name = provider.name;
    if (!Object.hasOwn(METADATA, name)) return [];
    const metadata = METADATA[name as keyof typeof METADATA];
    const search = provider.search;
    if (typeof search !== 'function') throw new MemoryError('invalid', 'invalid context request');
    return [{ id: name, trust: 'verified' as const, ...metadata,
      search: (text: string, caller: Ctx, limit: number) => search.call(provider, text, caller, limit) }];
  });
  return createRetrieveContext(sources, {
    now: () => Date.now(), monotonic: () => performance.now(), hash: contentHash,
    dateLabel: (at) => new Date(at).toISOString().slice(0, 10), measure: record,
  })(task, ctx, o);
}
