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
import { MemoryService } from './service.ts';
import { openDb } from './sqlite.ts';
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

export async function bench(cfg: Cfg, n: number): Promise<number> {
  mute();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bosun-bench-'));
  const rnd = prng(42);
  const vocab = Array.from({ length: 2000 }, () => Array.from({ length: 2 + Math.floor(rnd() * 3) }, () => SYL[Math.floor(rnd() * SYL.length)]).join(''));
  const word = () => vocab[Math.floor(vocab.length * rnd() ** 2)];   // skewed: low indexes are common words
  const text = (k: number) => Array.from({ length: k }, word).join(' ');
  try {
    const file = path.join(dir, 'memory.db');
    const svc = new MemoryService(openDb(file), cfg);
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
    const wall: number[] = [];
    const env = { ...process.env, BOSUN_HOME: dir, ROUTER_URL: 'http://127.0.0.1:1', MEMORY_URL: '', CLAUDE_PROJECT_DIR: process.cwd() };
    for (let i = 0; i <= HOOK_RUNS; i++) {   // run 0 warms the compile cache and is not counted
      const t = performance.now();
      spawnSync(process.execPath, [path.join(P.REPO, 'bin', 'bosun'), 'route', '--hook'], { env, input: JSON.stringify({ prompt: prompts[i] }) });
      if (i) wall.push(performance.now() - t);
    }
    const mem = jsonl(path.join(dir, 'metrics.jsonl')).filter((r) => r.op === 'hook').slice(1).map((r) => r.ms);
    const mb = (p: string) => (fs.existsSync(p) ? fs.statSync(p).size / 1048576 : 0);
    console.log(`bosun memory bench: ${n} memories (synthetic, seed 42), ${QUERIES} queries; node ${process.versions.node}, sqlite ${process.versions.sqlite}`);
    console.log(`  store    ${f(store)}   (one transaction per memory)`);
    console.log(`  search   ${f(search)}   (FTS5, limit 10)`);
    console.log(`  context  ${f(context)}   (curated, budget ~400 tokens)`);
    console.log(`  budget   ${sizes.filter((s) => s <= 400).length}/${sizes.length} within ~400 tokens (max ~${Math.max(0, ...sizes)}, average ~${Math.round(sizes.reduce((a, b) => a + b, 0) / Math.max(1, sizes.length))})`);
    console.log(`  hook     ${f(wall)}   (wall clock per prompt, Kev unreachable, ${wall.length} runs)`);
    console.log(`  hook mem ${f(mem)}   (the memory part inside the hook)`);
    console.log(`  db       ${(mb(file) + mb(`${file}-wal`)).toFixed(1)} MB`);
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
