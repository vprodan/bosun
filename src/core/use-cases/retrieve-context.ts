import type { ContextBundle, Hit } from '../domain/context.ts';
import type { Ctx } from '../domain/memory.ts';
import type { ContextSource } from '../ports/context-source.ts';
import { MemoryError } from '../errors.ts';
import { jaccard, terms, words } from '../text.ts';

export type Item = Hit & { score: number };
export type Result = ContextBundle;
export type ContextOptions = { budgetTokens: number; minScore: number; itemChars: number; minMatched?: number };
export type ContextMeasurement = { op: 'context.retrieve'; ms: number; n: number; chars: number; estTokens: number };
export type ContextDependencies = {
  now(): number;
  monotonic(): number;
  hash(title: string, text: string): string;
  dateLabel(at: number): string;
  measure(value: ContextMeasurement): void;
};
const HEADER_MAX = 60;
const FETCH = 20;
const MAX_SOURCES = 64;
const MAX_HITS = 1000; // A callback must honor a finite result contract; legacy sources request only 20.
const MAX_DATE_MS = 8640000000000000;
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const nonnegative = (n: unknown): n is number => finite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER;
const timestamp = (n: unknown): n is number => finite(n) && Math.abs(n) <= MAX_DATE_MS;
const scopeId = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length <= 200 && !s.includes('\0');
function invalid(): never { throw new MemoryError('invalid', 'invalid context request'); }
function unavailable(): never { throw new MemoryError('unavailable', 'context unavailable'); }
export const estTokens = (s: string): number => Math.ceil(s.length / 4);

function scope(ctx: Ctx): Ctx {
  const { projectId, sessionId, linked, source } = ctx;
  if (!(projectId === null || scopeId(projectId)) || !(sessionId === null || scopeId(sessionId))
    || !Array.isArray(linked) || linked.length > 2000 || linked.some((id) => !scopeId(id))
    || !(source === undefined || scopeId(source))) invalid();
  // The caller supplies trusted scope, never task/model arguments. Copy it before asynchronous callbacks.
  const copy: Ctx = { projectId, sessionId, linked: [...linked] };
  if (source !== undefined) copy.source = source;
  Object.freeze(copy.linked);
  return Object.freeze(copy);
}
function options(o: ContextOptions): Required<ContextOptions> {
  const { budgetTokens, minScore, itemChars, minMatched = 1 } = o;
  if (!nonnegative(budgetTokens) || !finite(minScore) || !Number.isSafeInteger(itemChars) || itemChars < 1
    || !Number.isSafeInteger(minMatched) || minMatched < 0) invalid();
  return { budgetTokens, minScore, itemChars, minMatched };
}
function projectHit(raw: Hit, id: string, need: number): Hit | null {
  // Identity and matching eligibility precede every payload field. Never spread provider extras/getters.
  if (!raw || typeof raw !== 'object' || raw.source !== id) return null;
  const matched = raw.matched;
  if (matched !== undefined && (!Number.isSafeInteger(matched) || matched < 0)) unavailable();
  if ((matched ?? Infinity) < need) return null;
  const { rank, at, accessCount, hash } = raw;
  if (!finite(rank) || !timestamp(at) || !nonnegative(accessCount) || !(hash === undefined || typeof hash === 'string')) unavailable();
  const { title, text, category, id: hitId } = raw;
  if (![title, text, category, hitId].every((s) => typeof s === 'string')) unavailable();
  const hit: Hit = { source: id, id: hitId, title, text, category, rank, at, accessCount };
  if (hash !== undefined || Object.hasOwn(raw, 'hash')) hit.hash = hash;
  if (matched !== undefined || Object.hasOwn(raw, 'matched')) hit.matched = matched;
  return hit;
}

// Metadata/trust are a composition contract, not authentication of hostile adapter objects.
export function createRetrieveContext(inputSources: readonly ContextSource[], dependencies: ContextDependencies) {
  let sources: readonly ContextSource[];
  let deps: Readonly<ContextDependencies>;
  try {
    const { now, monotonic, hash, dateLabel, measure } = dependencies;
    if (![now, monotonic, hash, dateLabel, measure].every((fn) => typeof fn === 'function') || !Array.isArray(inputSources)) invalid();
    deps = Object.freeze({ now, monotonic, hash, dateLabel, measure });
    sources = Object.freeze(inputSources.flatMap((source) => {
      // Disabled/unverified sources are not inspected for search or content.
      const trust = source.trust;
      if (trust === 'unsupported' || trust === 'unverified') return [];
      if (trust !== 'verified') invalid();
      const { id, weight, halfLifeDays } = source;
      if (!scopeId(id) || !nonnegative(weight) || !finite(halfLifeDays) || halfLifeDays <= 0 || halfLifeDays > Number.MAX_SAFE_INTEGER) invalid();
      const search = source.search;
      if (typeof search !== 'function') invalid();
      return [Object.freeze({ id, trust: 'verified' as const, weight, halfLifeDays,
        search: (text: string, ctx: Ctx, limit: number) => search.call(source, text, ctx, limit) })];
    }));
    if (sources.length > MAX_SOURCES) invalid();
  } catch { invalid(); }
  const timing = (): number | null => { try { const t = deps.monotonic(); return nonnegative(t) ? t : null; } catch { return null; } };
  const duration = (start: number | null): number => {
    const end = timing();
    return start !== null && end !== null && nonnegative(end - start) ? end - start : 0;
  };
  return async (task: string, ctx: Ctx, o: ContextOptions): Promise<Result> => {
    const started = timing();
    let caller: Ctx; let settings: Required<ContextOptions>;
    try {
      if (typeof task !== 'string') invalid();
      caller = scope(ctx); settings = options(o);
    } catch { invalid(); }
    const counts: Record<string, number> = {};
    const list = terms(task); const query = list.join(' ');
    if (!query) return { items: [], text: '', estTokens: 0, sources: counts, ms: duration(started) };
    const need = Math.min(settings.minMatched, list.length);
    // Provider-domain failures propagate unchanged; telemetry never replaces them.
    const lists = await Promise.all(sources.map((s) => s.search(query, caller, FETCH)));
    let now: number;
    try { now = deps.now(); if (!timestamp(now) || now < 0) unavailable(); } catch { unavailable(); }
    const scored: Item[] = [];
    for (let i = 0; i < sources.length; i++) {
      const source = sources[i]; const raw = lists[i];
      if (!Array.isArray(raw) || raw.length > MAX_HITS) unavailable();
      let hits: Hit[];
      try { hits = raw.flatMap((h) => { const hit = projectHit(h, source.id, need); return hit ? [hit] : []; }); }
      catch { unavailable(); }
      // defineProperty also handles open core IDs such as __proto__ without prototype mutation.
      Object.defineProperty(counts, source.id, { value: raw.length, writable: true, enumerable: true, configurable: true });
      const best = hits.reduce((n, h) => Math.max(n, -h.rank), 0);
      for (const h of hits) {
        const rel = best > 0 ? Math.max(0, -h.rank) / best : 1;
        const half = source.id === 'curated' && h.category === 'session' ? 1 : source.halfLifeDays;
        const age = Math.max(0, now - h.at) / 86400000;
        const score = rel * source.weight + 0.3 * 2 ** (-age / half) + 0.05 * Math.log(1 + h.accessCount);
        if (!finite(score)) unavailable();
        scored.push({ ...h, score }); // h is the declared projection, never a provider object
      }
    }
    scored.sort((a, b) => b.score - a.score);
    const kept: Item[] = []; const hashes = new Set<string>(); const sets: Set<string>[] = [];
    for (const it of scored) {
      let hash: string;
      try { hash = it.hash ?? deps.hash(it.title, it.text); if (typeof hash !== 'string') unavailable(); } catch { unavailable(); }
      const ws = words(`${it.title} ${it.text}`);
      if (hashes.has(hash) || sets.some((s) => jaccard(s, ws) >= 0.8)) continue;
      hashes.add(hash); sets.push(ws); kept.push(it);
    }
    const items: Item[] = []; const lines: string[] = []; let chars = HEADER_MAX;
    for (const it of kept) {
      if (it.score < settings.minScore) break;
      let label: string;
      try { label = deps.dateLabel(it.at); if (typeof label !== 'string' || !/^(?:\d{4}-\d{2}-\d{2}|[+-]\d{6}-\d{2})$/.test(label)) unavailable(); }
      catch { unavailable(); }
      const full = `- [${it.source} ${it.category} ${label} ${it.id}] ${it.title}: ${it.text}`.replace(/\s+/g, ' ').trim();
      const line = full.length > settings.itemChars ? `${full.slice(0, settings.itemChars - 1)}…` : full;
      if (Math.ceil((chars + 1 + line.length) / 4) > settings.budgetTokens) continue;
      chars += 1 + line.length; items.push(it); lines.push(line);
    }
    const text = items.length ? [`[bosun memory: ${items.length} note${items.length === 1 ? '' : 's'}; memory_get <id> for details]`, ...lines].join('\n') : '';
    const ms = duration(started); const tokens = estTokens(text);
    try { deps.measure({ op: 'context.retrieve', ms, n: items.length, chars: text.length, estTokens: tokens }); } catch { /* best effort */ }
    return { items, text, estTokens: tokens, sources: counts, ms };
  };
}
