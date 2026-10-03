// Kev System-1 router: a UserPromptSubmit hook for Claude Code and Codex, plus stats / label / eval.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { P, type Cfg } from './config.ts';
import { jsonl } from './util.ts';
import { log as logEvent } from './log.ts';
import { record } from './metrics.ts';
import type { MemoryApi } from './memory/types.ts';

export const LANES: Record<string, string> = {
  scout: 'Question or lookup about existing code: where is X, how does Y work, find usages, explain a file. No code changes.',
  local: 'Small mechanical code change with an obvious answer: rename, move, update imports, add a field end to end, fix a lint or type error, boilerplate that follows an existing example.',
  worker: 'Clearly specified code change that needs reasoning: new logic, writing tests, a multi-file feature from a clear plan, tricky types.',
  main: 'Needs design or judgment: architecture, an ambiguous bug, unclear requirements, planning, reviewing a PR, trade-offs.',
};
const RISK = {
  high: 'Touches payments, orders, invoices, auth, secrets, data deletion, migrations, or production infrastructure.',
  low: 'None of those; ordinary application code, tests, tooling or docs.',
};
const LOCAL_HINT = "write a spec, run `bosun run -f - <<'SPEC' … SPEC`, then review `git diff`";
const HINT: Record<string, Record<string, string>> = {
  claude: {
    scout: 'use the `bosun-scout` subagent',
    worker: 'plan it, then delegate to the `bosun-worker` subagent; review `git diff` after',
    main: 'keep it in the main thread; for an open design question use the `bosun-architect` subagent',
  },
  codex: {
    scout: 'spawn the `bosun_scout` agent',
    worker: 'plan it, then spawn the `bosun_worker` agent; review `git diff` after',
    main: 'keep it in the main thread; for an open design question spawn `bosun_architect`',
  },
};
for (const h of Object.values(HINT)) h.local = LOCAL_HINT;
const KEYS: Record<string, string> = { s: 'scout', l: 'local', w: 'worker', m: 'main' };
const LOG = () => path.join(P.BOSUN, 'route-log.jsonl');
const LABELS = () => path.join(P.BOSUN, 'route-labels.jsonl');
const round = (x: unknown) => Math.round(Number(x || 0) * 1000) / 1000;
const pct = (x: number) => `${Math.round(x * 100)}%`;

export type Decision = { lane: string; conf: number; risk: string; risk_conf: number; ms: number; router: string };

export const routerUrl = (cfg: Cfg): string => (cfg.ROUTER_URL || `http://127.0.0.1:${cfg.ROUTER_PORT}`).replace(/\/$/, '');

async function ask(cfg: Cfg, text: string): Promise<Decision> {
  const url = routerUrl(cfg);
  const body = {
    state: { request: text.slice(0, 4000) },
    model: 'kev-latest',
    questions: {
      lane: { type: 'choice', instructions: 'Which executor should handle this coding request?', criteria: LANES },
      risk: { type: 'choice', instructions: 'How risky is a mistake in this change?', criteria: RISK },
    },
  };
  const t = Date.now();
  const r = await fetch(`${url}/v1/systemone`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(Number(cfg.ROUTER_TIMEOUT) * 1000),
  });
  if (!r.ok) throw new Error(`kev answered ${r.status}`);
  const out: any = await r.json();
  const a = out.answers;
  return { lane: a.lane.choice, conf: round(a.lane.confidence), risk: a.risk.choice, risk_conf: round(a.risk.confidence), ms: out.latency_ms || Date.now() - t, router: out.model || '?' };
}

// Guard rails over Kev's raw answer. A false alarm on risk costs little; a miss costs a lot.
export function decide(d: Decision, minConf: number): [string | null, string] {
  if (d.risk === 'high' && (d.lane === 'local' || d.lane === 'worker')) return ['main', `risk=high overrides ${d.lane}`];
  if (d.conf < minConf) return [null, 'low confidence'];
  return [d.lane, ''];
}

function log(prompt: string, d: Decision, final: string | null, why: string): void {
  try {
    fs.mkdirSync(P.BOSUN, { recursive: true });
    const id = crypto.createHash('sha1').update(prompt).digest('hex').slice(0, 10);
    fs.appendFileSync(LOG(), JSON.stringify({ ts: Math.floor(Date.now() / 1000), id, prompt: prompt.slice(0, 300), ...d, final, why }) + '\n');
  } catch { /* logging must never break a prompt */ }
}

const labels = (): Record<string, string> => Object.fromEntries(jsonl(LABELS()).filter((r) => r.label).map((r) => [r.id, r.label]));

function stats(): number {
  const rs = jsonl(LOG());
  if (!rs.length) { console.log(`no log yet: ${LOG()}`); return 0; }
  const count = (f: (r: any) => string) => rs.reduce((m: Record<string, number>, r) => { m[f(r)] = (m[f(r)] || 0) + 1; return m; }, {});
  console.log(`${rs.length} decisions  (${LOG()})`);
  console.log('final:', count((r) => r.final || 'none'));
  console.log('raw:  ', count((r) => r.lane));
  const ms = rs.map((r) => r.ms).sort((a, b) => a - b);
  console.log('latency p50/p95 ms:', ms[Math.floor(ms.length / 2)], ms[Math.max(0, Math.floor(ms.length * 0.95) - 1)]);
  return 0;
}

async function label(): Promise<number> {
  const done = labels();
  const seen = new Set<string>();
  const todo: any[] = [];
  for (const r of jsonl(LOG()).reverse()) if (!done[r.id] && !seen.has(r.id)) { seen.add(r.id); todo.push(r); }
  if (!todo.length) { console.log('nothing to label'); return 0; }
  console.log(`${todo.length} unlabeled. Who SHOULD have handled it?  s=scout l=local w=worker m=main  enter=router right  x=skip  q=quit\n`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask1 = (s: string) => new Promise<string>((res) => rl.question(s, res));
  try {
    for (const [i, r] of todo.entries()) {
      console.log(`[${i + 1}/${todo.length}] ${r.prompt.slice(0, 200)}`);
      const k = (await ask1(`   router: ${r.lane} (${r.conf}), final: ${r.final} > `)).trim().toLowerCase();
      if (k === 'q') break;
      if (k === 'x') continue;
      const lab = k === '' ? r.lane : KEYS[k];
      if (!lab) { console.log('   ? skipped'); continue; }
      fs.appendFileSync(LABELS(), JSON.stringify({ id: r.id, label: lab }) + '\n');
    }
  } finally { rl.close(); }
  console.log(`labels: ${LABELS()}`);
  return 0;
}

function evaluate(): number {
  const labs = labels();
  const byId = new Map<string, any>();
  for (const r of jsonl(LOG())) if (labs[r.id]) byId.set(r.id, r);
  const rs = [...byId.values()];
  const n = rs.length;
  if (n < 10) { console.log(`only ${n} labeled decisions: label at least 10 (30+ gives a useful threshold): bosun label`); return 0; }
  const right = (r: any) => r.lane === labs[r.id];
  console.log(`${n} labeled. raw router accuracy: ${pct(rs.filter(right).length / n)}`);
  console.log('\nthreshold  coverage  accuracy-when-hinting');
  let best: [number, number] | null = null;
  for (const t of [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]) {
    const hit = rs.filter((r) => r.conf >= t);
    if (!hit.length) continue;
    const a = hit.filter(right).length / hit.length;
    console.log(`  ${t.toFixed(1)}      ${pct(hit.length / n).padStart(6)}    ${pct(a).padStart(6)}`);
    if (a >= 0.85 && (!best || hit.length > best[1])) best = [t, hit.length];
  }
  const confusion: Record<string, number> = {};
  for (const r of rs) if (!right(r)) { const k = `${labs[r.id]}->${r.lane}`; confusion[k] = (confusion[k] || 0) + 1; }
  console.log('\nconfusion (label -> router):', Object.keys(confusion).length ? JSON.stringify(confusion) : 'none');
  console.log(best ? `\nsuggested ROUTER_MIN_CONF=${best[0]} (>=85% accurate when it speaks)`
    : '\nno threshold reaches 85%: keep hints advisory, or fine-tune Kev on your labels');
  return 0;
}

// The hook's memory part: a few relevant curated notes, or '' on any failure (fail open). Always records its latency.
async function memoryBlock(cfg: Cfg, prompt: string, sessionId: string | null): Promise<string> {
  const t = performance.now();
  let n = 0;
  let est = 0;
  let api: MemoryApi | null = null;
  try {
    if (!cfg.MEMORY_URL && !fs.existsSync(P.DB)) return '';   // no memories yet: open nothing, load nothing
    const [{ curated, retrieve }, { makeCtx, project, projectDir }, { openMemory }] = await Promise.all([
      import('./context.ts'), import('./memory/project.ts'), import('./memory/service.ts')]);
    api = openMemory(cfg, Number(cfg.REMOTE_HOOK_TIMEOUT_MS));
    const r = await retrieve(prompt, [curated(api)], makeCtx(cfg, project(projectDir()), sessionId, 'hook'), {
      budgetTokens: Number(cfg.CONTEXT_HOOK_BUDGET), minScore: Number(cfg.CONTEXT_HOOK_MIN_SCORE), itemChars: Number(cfg.CONTEXT_ITEM_CHARS),
      minMatched: Number(cfg.CONTEXT_HOOK_MIN_TERMS) });
    n = r.items.length;
    est = r.estTokens;
    return r.text;
  } catch (e) {
    logEvent('warn', 'hook.memory', { err: e });
    return '';
  } finally {
    try { api?.close(); } catch { /* already closed */ }
    record({ op: 'hook', ms: performance.now() - t, n, estTokens: est });
  }
}

export async function main(argv: string[], cfg: Cfg): Promise<number> {
  const cmd = ({ '--stats': stats, '--label': label, '--eval': evaluate } as Record<string, () => number | Promise<number>>)[argv[0]];
  if (cmd) return cmd();
  const hook = argv.includes('--hook');
  const hi = argv.indexOf('--host');
  const host = hi >= 0 && argv[hi + 1] ? argv[hi + 1] : 'claude';
  if (hook) {
    if (process.env.BOSUN_DEPTH) return 0;   // inside a bosun executor: stay out of the way
    let input: any;
    try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { return 0; }
    const prompt = String(input?.prompt || '');
    const p = prompt.trimStart();
    if (!p || p.startsWith('/') || p.startsWith('!') || p.split(/\s+/).length < 3 || prompt.includes('#noroute')) return 0;
    const sid = typeof input.session_id === 'string' ? input.session_id : null;
    const [d, mem] = await Promise.all([ask(cfg, prompt).catch(() => null), memoryBlock(cfg, prompt, sid)]);
    let hint = '';
    if (d) {
      const [final, why] = decide(d, Number(cfg.ROUTER_MIN_CONF));
      log(prompt, d, final, why);
      if (final) hint = `[router ${d.router} ${d.ms}ms] suggests: ${final} (conf ${d.conf}, risk ${d.risk})${why ? ` (${why})` : ''} -> ${(HINT[host] || HINT.claude)[final]}. Advisory only: override it if the request needs otherwise.`;
    }
    const ctx = [mem, hint].filter(Boolean).join('\n\n');
    if (ctx) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: ctx } }));
    return 0;   // fail open: with nothing to add, the main model decides on its own
  }
  const prompt = argv.filter((a) => !a.startsWith('--')).join(' ') || fs.readFileSync(0, 'utf8');
  let d: Decision;
  try { d = await ask(cfg, prompt); } catch (e) { console.error(`router unreachable: ${(e as Error).message}`); return 1; }
  const [final, why] = decide(d, Number(cfg.ROUTER_MIN_CONF));
  log(prompt, d, final, why);
  console.log(JSON.stringify({ ...d, final, why }, null, 2));
  return 0;
}
