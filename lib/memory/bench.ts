// bosun memory bench / eval: measured numbers only. bench builds a synthetic corpus in a temp database; eval scores labelled queries.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { P, type Cfg } from '../config.ts';
import { curated, retrieve } from '../context.ts';
import { mute, quantile } from '../metrics.ts';
import { die, jsonl } from '../util.ts';
import { project } from './project.ts';
import { openLocalMemory } from './service.ts';
import { writerPaths, planLocalMemoryCutover, applyLocalMemoryCutover, publishLocalMemory } from './sqlite.ts';
import type { Ctx, MemoryApi } from './types.ts';

// mulberry32: a seeded PRNG, so every run measures the same corpus
const prng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const SYL = ['ka', 'ro', 'mi', 'te', 'su', 'na', 'lo', 'vi', 'de', 'pa', 'shi', 'gu', 'ne', 'to', 'ba', 'ri'];
const f = (xs: number[]) => `p50 ${quantile(xs, 0.5).toFixed(2)} ms  p95 ${quantile(xs, 0.95).toFixed(2)} ms`;
const QUERIES = 200;
const HOOK_RUNS = 20;
type HookProcess = { status: number | null; stdout: string; error?: unknown; signal?: unknown };
// A timing is retrieval evidence only when both the successful child output and its own metric confirm delivery.
export function hookObservation(child: HookProcess, metric: unknown): { outcome: 'failed' | 'no-memory' | 'unqualified' | 'injected'; ms?: number } {
  if (child.status !== 0 || child.error || child.signal) return { outcome: 'failed' };
  let context = '';
  try {
    const parsed = child.stdout.trim() ? JSON.parse(child.stdout) : null;
    const value = parsed?.hookSpecificOutput?.additionalContext;
    if (typeof value === 'string') context = value;
  } catch { return { outcome: 'unqualified' }; }
  if (!metric || typeof metric !== 'object' || Array.isArray(metric)) return { outcome: 'unqualified' };
  const m = metric as Record<string, unknown>;
  if (m.op !== 'hook' || typeof m.n !== 'number' || !Number.isSafeInteger(m.n) || m.n < 0
    || typeof m.ms !== 'number' || !Number.isFinite(m.ms) || m.ms < 0 || m.ms > Number.MAX_SAFE_INTEGER) return { outcome: 'unqualified' };
  const count = context.match(/^\[bosun memory: ([1-9][0-9]*) notes?;/)?.[1];
  if (!count && m.n === 0) return { outcome: 'no-memory' };
  if (Number(count) !== m.n || typeof m.estTokens !== 'number' || m.estTokens <= 0 || !Number.isFinite(m.estTokens)) return { outcome: 'unqualified' };
  return { outcome: 'injected', ms: m.ms };
}

export async function bench(cfg: Cfg, n: number, publicView = false): Promise<number> {
  if (!Number.isSafeInteger(n) || n < 1 || publicView && n > 10000) return die('bench --n needs a positive whole number (public view maximum 10000)', 2);
  mute();
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bosun-bench-')));
  const rnd = prng(42);
  const vocab = Array.from({ length: 2000 }, () => Array.from({ length: 2 + Math.floor(rnd() * 3) }, () => SYL[Math.floor(rnd() * SYL.length)]).join(''));
  const word = () => vocab[Math.floor(vocab.length * rnd() ** 2)];   // skewed: low indexes are common words
  const text = (k: number) => Array.from({ length: k }, word).join(' ');
  try {
    const file = path.join(dir, 'memory.db');
    // Synthetic corpus never adopts the owner's explicitly selected gate/backup paths.
    const synthetic = { ...cfg, MEMORY_URL: '', MEMORY_TOKEN: '', MEMORY_VIEW_PATH: '', MEMORY_BACKUP_DIR: '', MEMORY_SOURCE_ID: '', MEMORY_LINKED_PROJECTS: '', CLAUDE_MEM: 'off', CLAUDE_MEM_DB: '' };
    const svc = openLocalMemory(synthetic, file);
    const ctx: Ctx = { projectId: project(process.cwd()).id, sessionId: null, linked: [] };
    const store: number[] = [];
    for (let i = 0; i < n; i++) {
      const t = performance.now();
      await svc.store({ category: i % 10 ? 'project' : 'personal', title: text(5), body: text(40 + Math.floor(rnd() * 80)) }, ctx);
      store.push(performance.now() - t);
    }
    const search: number[] = [];
    const context: number[] = [];
    const sizes: number[] = [];
    const prompts: string[] = [];
    for (let i = 0; i < QUERIES; i++) {
      const q = text(6);
      prompts.push(q);
      let t = performance.now();
      await svc.search({ text: q, limit: 10, touch: false }, ctx);
      search.push(performance.now() - t);
      t = performance.now();
      sizes.push((await retrieve(q, [curated(svc)], ctx, { budgetTokens: 400, minScore: 0, itemChars: 400 })).estTokens);
      context.push(performance.now() - t);
    }
    svc.close();
    let sourceId = '';
    const paths = writerPaths(file, synthetic);
    if (publicView) {
      // This explicit option prepares/applies only the newly generated, closed temp corpus.
      fs.chmodSync(dir, 0o700);
      fs.mkdirSync(path.dirname(paths.view), { mode: 0o700 });
      fs.mkdirSync(paths.backups, { mode: 0o700 });
      const plan = planLocalMemoryCutover(synthetic, file);
      if (plan.state !== 'PLANNED' || !plan.plan || !plan.sourceId) return die('synthetic public-view preparation held', 1);
      sourceId = plan.sourceId; // independently saved before apply; never learned from the candidate view
      await applyLocalMemoryCutover(synthetic, { plan: plan.plan, operation: 'apply', clientsStopped: true }, file);
      await publishLocalMemory(synthetic, file);
    }
    const wall: number[] = [];
    const mem: number[] = [];
    const outcomes = { injected: 0, 'no-memory': 0, unqualified: 0, failed: 0 };
    const hookMetrics = () => jsonl(path.join(dir, 'metrics.jsonl')).filter((r) => r.op === 'hook');
    const env = { ...process.env, BOSUN_HOME: dir, ROUTER_URL: 'http://127.0.0.1:1', MEMORY_URL: '', MEMORY_TOKEN: '',
      MEMORY_VIEW_PATH: '', MEMORY_BACKUP_DIR: '', MEMORY_SOURCE_ID: sourceId, MEMORY_LINKED_PROJECTS: '', CLAUDE_MEM: 'off', CLAUDE_MEM_DB: '', CLAUDE_PROJECT_DIR: process.cwd() };
    for (let i = 0; i <= HOOK_RUNS; i++) {   // run 0 warms the compile cache and is not counted
      const prior = hookMetrics().length;
      const t = performance.now();
      const child = spawnSync(process.execPath, [path.join(P.REPO, 'bin', 'bosun'), 'route', '--hook'], { env, encoding: 'utf8', input: JSON.stringify({ prompt: prompts[i] }) });
      if (i) {
        wall.push(performance.now() - t);
        const rows = hookMetrics().slice(prior);
        const observation = hookObservation(child, rows.length === 1 ? rows[0] : null);
        outcomes[observation.outcome]++;
        if (observation.outcome === 'injected') mem.push(observation.ms!);
      }
    }
    const mb = (p: string) => (fs.existsSync(p) ? fs.statSync(p).size / 1048576 : 0);
    console.log(`bosun memory bench: ${n} memories (synthetic, seed 42), ${QUERIES} queries; node ${process.versions.node}, sqlite ${process.versions.sqlite}`);
    console.log(`  store    ${f(store)}   (one transaction per memory)`);
    console.log(`  search   ${f(search)}   (FTS5, limit 10)`);
    console.log(`  context  ${f(context)}   (curated, budget ~400 tokens)`);
    console.log(`  budget   ${sizes.filter((s) => s <= 400).length}/${sizes.length} within ~400 tokens (max ~${Math.max(0, ...sizes)}, average ~${Math.round(sizes.reduce((a, b) => a + b, 0) / Math.max(1, sizes.length))})`);
    console.log(`  hook     ${f(wall)}   (wall clock per attempt, Kev unreachable, ${wall.length} runs)`);
    console.log(`  outcomes ${outcomes.injected} verified memory injections, ${outcomes['no-memory']} no-memory/held, ${outcomes.failed} failed, ${outcomes.unqualified} unqualified`);
    console.log(mem.length ? `  hook mem ${f(mem)}   (verified injected runs only, ${mem.length} runs)`
      : '  hook mem unqualified: no verified memory injection; no retrieval latency reported');
    console.log(`  db       ${(mb(file) + mb(`${file}-wal`)).toFixed(1)} MB`);
    if (publicView) console.log(`  public   READY (explicit synthetic apply/publish/binding), view ${mb(paths.view).toFixed(1)} MB; finite-expiry notes omitted`);
    return 0;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

export async function evaluate(file: string, api: MemoryApi, ctx: Ctx): Promise<number> {
  const qs = jsonl(file).filter((r) => typeof r.query === 'string' && Array.isArray(r.relevant) && r.relevant.length);
  if (!qs.length) return die(`no labelled queries in ${file}: one JSON object per line, {"query": "...", "relevant": ["m_…"]}`, 2);
  let recall = 0;
  let mrr = 0;
  for (const q of qs) {
    const ids = (await api.search({ text: q.query, limit: 20, includePrivate: true, touch: false }, ctx)).map((m) => m.id);
    recall += q.relevant.filter((id: string) => ids.slice(0, 5).includes(id)).length / q.relevant.length;
    const first = ids.findIndex((id) => q.relevant.includes(id));
    mrr += first < 0 ? 0 : 1 / (first + 1);
  }
  console.log(`${qs.length} queries  recall@5 ${(recall / qs.length).toFixed(3)}  MRR ${(mrr / qs.length).toFixed(3)}  (full-text search over curated memory)`);
  return 0;
}
