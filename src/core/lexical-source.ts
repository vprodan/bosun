import type { ContextSource } from './ports/context-source.ts';
import type { Found, Query, Ctx, Memory } from './domain/memory.ts';
import type { GraphQuery, GraphSearch, GraphArtifact } from './domain/graph.ts';
import type { MemoryStore } from './ports/memory.ts';
import { mayDeliverMemoryToModel } from './memory-policy.ts';
import { LEXICAL_MEMORY_POLICY, memoryExcerpt } from './lexical-memory.ts';
import { graphFusion } from './graph.ts';
import { norm, terms } from './text.ts';
import { MemoryError } from './errors.ts';

// Read-only query composition. Reviewed aliases resolve current public source
// versions through the graph authority; they never create an L1 copy/index.
export function createLexicalSource(
  memory: Pick<MemoryStore, 'get'> & { searchLexical(q: Query, ctx: Ctx): Promise<Found[]> },
  graph?: {
    enabled: boolean;
    query(q: GraphQuery, ctx: Ctx): GraphSearch;
    get(id: string, ctx: Ctx): GraphArtifact;
  },
  options: { sessionScoped?: boolean } = {},
): ContextSource {
  const allowed = (row: Memory, ctx: Ctx) =>
    mayDeliverMemoryToModel(row) &&
    (!options.sessionScoped ||
      row.category !== 'session' ||
      row.shared ||
      row.sessionId === ctx.sessionId);
  return {
    id: 'curated',
    trust: 'verified',
    weight: 1,
    halfLifeDays: 60,
    async search(text, ctx, limit) {
      const rows = await memory.searchLexical(
        { text, includePrivate: false, touch: false, limit },
        ctx,
      );
      const byId = new Map<string, Found>(),
        direct: string[] = [],
        aliases: string[] = [],
        reviewed = new Set<string>();
      for (let i = 0; i < rows.length; i++)
        if (allowed(rows[i], ctx)) {
          const row = rows[i];
          byId.set(row.id, row);
          direct.push(row.id);
        }
      if (graph?.enabled) {
        const queryTerms = new Set(terms(text));
        for (const artifact of graph.query({ text, limit: 20, expand: false, levels: [2] }, ctx)
          .items) {
          if (
            artifact.kind !== 'entity' ||
            !artifact.entity?.aliases?.some(
              (alias) => norm(alias) === norm(text) || queryTerms.has(norm(alias)),
            )
          )
            continue;
          for (const ref of artifact.supports) {
            let row: Memory;
            try {
              row = await memory.get(ref.memoryId, ctx);
            } catch (error) {
              if ((error as { code?: string }).code === 'not_found') continue;
              throw error;
            }
            if (!allowed(row, ctx) || row.version !== ref.version || row.hash !== ref.hash)
              continue;
            // Recheck lineage after the asynchronous memory boundary.
            graph.get(artifact.id, ctx);
            if (!byId.has(row.id)) byId.set(row.id, { ...row, rank: 0 });
            if (!reviewed.has(row.id)) {
              reviewed.add(row.id);
              aliases.push(row.id);
            }
          }
        }
      }
      const scores = graphFusion([
        { weight: 1, ids: direct },
        { weight: 0.7, ids: aliases },
      ]);
      return [...scores]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, limit)
        .map(([id, score]) => {
          const row = byId.get(id);
          if (!row) throw new MemoryError('unavailable', 'lexical source unavailable');
          return {
            source: 'curated',
            id,
            title: row.title.slice(0, LEXICAL_MEMORY_POLICY.titleChars),
            text: memoryExcerpt(row.body, text),
            category: row.category,
            rank: -score,
            at: row.updatedAt,
            accessCount: row.accessCount,
            hash: row.hash,
            // A reviewed alias is explicit evidence, rather than a fabricated
            // lexical word count. Ordinary FTS candidates keep their exact gate.
            ...(reviewed.has(id) ? {} : { matched: row.matched }),
          };
        });
    },
  };
}
