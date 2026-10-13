import type { MemoryStore } from './ports/memory.ts';
import type { ContextSource } from './ports/context-source.ts';
import { mayDeliverMemoryToModel } from './memory-policy.ts';
import type { Hit } from './domain/context.ts';

// Reviewed curated metadata and declared projection. Classification precedes all denied payload/metadata getters.
export function createCuratedSource(memory: Pick<MemoryStore, 'search'>): ContextSource {
  return {
    id: 'curated',
    trust: 'verified',
    weight: 1,
    halfLifeDays: 60,
    async search(text, ctx, limit) {
      const rows = await memory.search({ text, limit, includePrivate: false, touch: false }, ctx);
      const hits: Hit[] = [];
      for (let i = 0; i < rows.length; i++) {
        const m = rows[i];
        if (mayDeliverMemoryToModel(m))
          hits.push({
            source: 'curated',
            id: m.id,
            title: m.title,
            text: m.body,
            category: m.category,
            rank: m.rank,
            at: m.updatedAt,
            accessCount: m.accessCount,
            hash: m.hash,
            matched: m.matched,
          });
      }
      return hits;
    },
  };
}
