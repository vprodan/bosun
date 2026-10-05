// Context manager: rank curated memory, project docs and claude-mem for a task, dedupe, and fit a token budget.
import { record } from './metrics.ts';
import { contentHash } from './memory/sqlite.ts';
import { jaccard, terms, words } from '../src/core/text.ts';
import { mayExposeMemory } from '../src/core/memory-policy.ts';
import type { Ctx, Hit, MemoryApi, MemoryProvider, Source } from './memory/types.ts';

export type Item = Hit & { score: number };
export type Result = { items: Item[]; text: string; estTokens: number; sources: Record<string, number>; ms: number };
const WEIGHT: Record<Source, number> = { curated: 1.0, docs: 0.8, 'claude-mem': 0.6 };
const HALF_LIFE_DAYS: Record<Source, number> = { curated: 60, docs: 90, 'claude-mem': 30 };   // session memories: 1
const HEADER_MAX = 60;   // chars reserved for the header line
const FETCH = 20;        // hits per source
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const estTokens = (s: string): number => Math.ceil(s.length / 4);   // an estimate, always shown as ~

// Curated memory as a provider: active, non-private memories of the caller's scope.
export const curated = (api: Pick<MemoryApi, 'search'>): MemoryProvider => ({
  name: 'curated',
  async search(text, ctx, limit) {
    return Array.from(await api.search({ text, limit, includePrivate: false }, ctx)).filter((m) => mayExposeMemory(m, 'model')).map((m) => ({
      source: 'curated' as const, id: m.id, title: m.title, text: m.body, category: m.category, rank: m.rank, at: m.updatedAt, accessCount: m.accessCount, hash: m.hash, matched: m.matched,
    }));
  },
});

function line(it: Item, max: number): string {
  const s = `- [${it.source} ${it.category} ${day(it.at)} ${it.id}] ${it.title}: ${it.text}`.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// Curated errors propagate (the hook fails open, MCP answers unavailable); docs and claude-mem never throw.
// minMatched: a hit must contain at least this many distinct words of the task (capped at the task's term count). The
// per-source normalization gives every source's best hit a relevance of 1, so this is what keeps one shared word from injecting.
export async function retrieve(task: string, providers: MemoryProvider[], ctx: Ctx, o: { budgetTokens: number; minScore: number; itemChars: number; minMatched?: number }): Promise<Result> {
  const t0 = performance.now();
  const sources: Record<string, number> = {};
  // Providers get the capped term list, not the raw prompt: a 50 KB prompt stays a small, valid query (and a small remote request).
  const list = terms(task);
  const query = list.join(' ');
  const need = Math.min(o.minMatched ?? 1, list.length);
  if (!query) return { items: [], text: '', estTokens: 0, sources, ms: performance.now() - t0 };
  // The legacy seam accepts only existing source identities; new sources need verified metadata in the new adapter path.
  providers = providers.filter((p) => Object.hasOwn(WEIGHT, p.name));
  const lists = await Promise.all(providers.map((p) => p.search(query, ctx, FETCH)));
  const now = Date.now();
  const scored: Item[] = [];
  providers.forEach((p, i) => {
    const hits = lists[i].filter((h) => h.source === p.name && (h.matched ?? Infinity) >= need);   // providers without counts are not gated
    sources[p.name] = lists[i].length;
    const best = Math.max(0, ...hits.map((h) => -h.rank));   // bm25 is negative: more negative is better
    for (const h of hits) {
      const rel = best > 0 ? Math.max(0, -h.rank) / best : 1;
      const half = h.source === 'curated' && h.category === 'session' ? 1 : HALF_LIFE_DAYS[h.source];
      const age = Math.max(0, now - h.at) / 86400000;
      scored.push({ ...h, score: rel * WEIGHT[h.source] + 0.3 * 2 ** (-age / half) + 0.05 * Math.log(1 + h.accessCount) });
    }
  });
  scored.sort((a, b) => b.score - a.score);
  const kept: Item[] = [];
  const hashes = new Set<string>();
  const sets: Set<string>[] = [];
  for (const it of scored) {   // sorted, so the first of a duplicate pair has the higher score
    const h = it.hash ?? contentHash(it.title, it.text);
    const ws = words(`${it.title} ${it.text}`);
    if (hashes.has(h) || sets.some((s) => jaccard(s, ws) >= 0.8)) continue;
    hashes.add(h);
    sets.push(ws);
    kept.push(it);
  }
  const items: Item[] = [];
  const lines: string[] = [];
  let chars = HEADER_MAX;
  for (const it of kept) {
    if (it.score < o.minScore) break;
    const l = line(it, o.itemChars);
    if (Math.ceil((chars + 1 + l.length) / 4) > o.budgetTokens) continue;   // greedy: a smaller one may still fit
    chars += 1 + l.length;
    items.push(it);
    lines.push(l);
  }
  const text = items.length ? [`[bosun memory: ${items.length} note${items.length === 1 ? '' : 's'}; memory_get <id> for details]`, ...lines].join('\n') : '';
  const ms = performance.now() - t0;
  record({ op: 'context.retrieve', ms, n: items.length, chars: text.length, estTokens: estTokens(text) });
  return { items, text, estTokens: estTokens(text), sources, ms };
}
