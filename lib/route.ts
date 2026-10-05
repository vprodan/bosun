// Kev System-1 router: a UserPromptSubmit hook for Claude Code and Codex, plus stats / label / eval.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { P, type Cfg } from './config.ts';
import { jsonl } from './util.ts';
import { log as logEvent } from './log.ts';
import { record } from './metrics.ts';
import type { MemoryReader } from './memory/types.ts';
import { finite, isLane as lane, isRisk as risk, type Decision, type RouteResult } from '../src/core/domain/route.ts';
import { createRoutePrompt } from '../src/core/use-cases/route-prompt.ts';
import { createAdapterRegistry } from '../src/app/registry.ts';
export { LANES } from '../src/core/domain/route.ts';
export type { Decision } from '../src/core/domain/route.ts';
export { decide } from '../src/core/route-policy.ts';

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
const observationId = (value: unknown): value is string => typeof value === 'string' && /^(?:[a-f0-9]{10}|[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/.test(value);
const reasons = new Set(['', 'low confidence', 'risk=high overrides local', 'risk=high overrides worker']);

export const routerUrl = (cfg: Cfg): string => (cfg.ROUTER_URL || `http://127.0.0.1:${cfg.ROUTER_PORT}`).replace(/\/$/, '');

// Only this legacy boundary classifies unmarked v0.2 input as public; new callers must classify explicitly.
async function ask(cfg: Cfg, text: string): Promise<RouteResult | null> {
  const router = await createAdapterRegistry().router('legacy-kev', { url: routerUrl(cfg) });
  return createRoutePrompt({ router, minConfidence: Number(cfg.ROUTER_MIN_CONF) })(
    { text, privacy: 'public' }, AbortSignal.timeout(Number(cfg.ROUTER_TIMEOUT) * 1000));
}

function log(d: Decision, final: string | null, why: string): void {
  try {
    fs.mkdirSync(P.BOSUN, { recursive: true });
    fs.appendFileSync(LOG(), JSON.stringify({ ts: Math.floor(Date.now() / 1000), id: crypto.randomUUID(),
      lane: d.lane, conf: d.conf, risk: d.risk, risk_conf: d.risk_conf, ms: d.ms, router: d.router, final, why }) + '\n');
  } catch { /* logging must never break a prompt */ }
}

// Read only finite metadata from historical rows; raw prompts and response fields are never redisplayed.
type Row = Decision & { id: string; ts: number | null; final: string | null; why: string };
function rows(): Row[] {
  return jsonl(LOG()).filter((r) => r && observationId(r.id) && lane(r.lane) && risk(r.risk) && finite(r.conf, 1) && finite(r.risk_conf, 1) && finite(r.ms, 3_600_000))
    .map((r) => ({ id: r.id, ts: finite(r.ts, 8_640_000_000_000) ? r.ts : null, lane: r.lane, conf: r.conf,
      risk: r.risk, risk_conf: r.risk_conf, ms: r.ms, router: 'legacy', final: lane(r.final) ? r.final : null, why: reasons.has(r.why) ? r.why : '' }));
}
const labels = (): Map<string, string> => new Map(jsonl(LABELS()).filter((r) => r && observationId(r.id) && lane(r.label)).map((r) => [r.id, r.label]));

function stats(): number {
  const rs = rows();
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
  const todo: Row[] = [];
  for (const r of rows().reverse()) if (!done.has(r.id) && !seen.has(r.id)) { seen.add(r.id); todo.push(r); }
  if (!todo.length) { console.log('nothing to label'); return 0; }
  console.log(`${todo.length} unlabeled. Who SHOULD have handled it?  s=scout l=local w=worker m=main  enter=router right  x=skip  q=quit\n`);
  console.log('Metadata only: correlate the observation ID/time with your own session; skip tasks you cannot identify. Historical prompts are never displayed.\n');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask1 = (s: string) => new Promise<string>((res) => rl.question(s, res));
  try {
    for (const [i, r] of todo.entries()) {
      console.log(`[${i + 1}/${todo.length}] observation ${r.id}  ts=${r.ts ?? 'unknown'}`);
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
  for (const r of rows()) if (labs.has(r.id)) byId.set(r.id, r);
  const rs = [...byId.values()];
  const n = rs.length;
  if (n < 10) { console.log(`only ${n} labeled decisions: label at least 10 (30+ gives a useful threshold): bosun label`); return 0; }
  const right = (r: Row) => r.lane === labs.get(r.id);
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
  for (const r of rs) if (!right(r)) { const k = `${labs.get(r.id)}->${r.lane}`; confusion[k] = (confusion[k] || 0) + 1; }
  console.log('\nconfusion (label -> router):', Object.keys(confusion).length ? JSON.stringify(confusion) : 'none');
  console.log(best ? `\nsuggested ROUTER_MIN_CONF=${best[0]} (>=85% accurate when it speaks)`
    : '\nno threshold reaches 85%: keep hints advisory, or fine-tune Kev on your labels');
  return 0;
}

type MemoryBlock = { text: string; valid?: () => boolean; complete?: (delivered: boolean) => void };
const DELIVERY_BYTES = 16 * 1024;
const DELIVERY_MS = 250;
// Only POSIX pipe/socket stdout permits an asynchronous write phase on the qualified Node runtime.
function memorySink(): boolean {
  try { const sink = fs.fstatSync(process.stdout.fd); return !process.versions.bun && process.platform !== 'win32' && (sink.isFIFO() || sink.isSocket()); }
  catch { return false; }
}

// A local nonempty block owns its EXCLUSIVE-mode connection until native stdout acceptance/cancellation.
async function memoryBlock(cfg: Cfg, prompt: string, sessionId: string | null): Promise<MemoryBlock> {
  const t = performance.now();
  let n = 0;
  let est = 0;
  let api: (MemoryReader & { validate?: () => void }) | null = null;
  let retained = false;
  let completed = false;
  const complete = (delivered: boolean) => {
    if (completed) return;
    completed = true;
    try { api?.close(); } catch { /* process teardown also releases a failed close */ }
    record({ op: 'hook', ms: performance.now() - t, n: delivered ? n : 0, estTokens: delivered ? est : 0, ok: delivered });
  };
  try {
    if (!cfg.MEMORY_URL && (!memorySink() || !fs.existsSync(P.DB))) return { text: '' }; // unsupported sink/missing DB: acquire nothing
    const [{ curated, retrieve }, { makeCtx, project, projectDir }] = await Promise.all([
      import('./context.ts'), import('./memory/project.ts')]);
    if (cfg.MEMORY_URL) {
      const { openMemory } = await import('./memory/service.ts');
      api = openMemory(cfg, Number(cfg.REMOTE_HOOK_TIMEOUT_MS));
    } else {
      const { openHookMemory } = await import('../src/adapters/memory/sqlite-readonly.ts');
      api = openHookMemory({ primary: P.DB, view: cfg.MEMORY_VIEW_PATH, sourceId: cfg.MEMORY_SOURCE_ID }, Date.now);
    }
    const r = await retrieve(prompt, [curated(api)], makeCtx(cfg, project(projectDir()), sessionId, 'hook'), {
      budgetTokens: Number(cfg.CONTEXT_HOOK_BUDGET), minScore: Number(cfg.CONTEXT_HOOK_MIN_SCORE), itemChars: Number(cfg.CONTEXT_ITEM_CHARS),
      minMatched: Number(cfg.CONTEXT_HOOK_MIN_TERMS) });
    n = r.items.length;
    est = r.estTokens;
    if (!cfg.MEMORY_URL && r.text) {
      retained = true;
      return { text: r.text, complete, valid: () => { try { api?.validate?.(); return true; } catch { return false; } } };
    }
    // Remote has no local read lease and retains its existing selected-row accounting/parallel path.
    complete(!!r.text);
    return { text: r.text };
  } catch (e) {
    logEvent('warn', 'hook.memory', { err: e });
    return { text: '' };
  } finally {
    if (!retained) complete(false);
  }
}

// Success is native stdout acceptance, not host processing. Stdout destroy/closed can reset and flush later on Node.
function deliverHook(line: string, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const out = process.stdout;
    let done = false;
    const finish = (accepted: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      out.off('error', cancel); signal.removeEventListener('abort', cancel);
      resolve(accepted);
    };
    const cancel = () => {
      if (done) return;
      // Native probes disproved destroy/closed as permanent cancellation. Keep the reader until OS teardown.
      // No synchronous telemetry IO here and no JavaScript release before terminating this one-shot hook.
      try { out.destroy(); } catch { /* teardown still cancels pending output */ }
      process.exit(0);
    };
    const deadline = setTimeout(cancel, DELIVERY_MS);
    if (signal.aborted || out.destroyed) { finish(false); return; } // this memory has never been queued
    out.on('error', cancel); signal.addEventListener('abort', cancel, { once: true });
    try { out.write(line, (error) => { if (done) return; if (error) cancel(); else finish(true); }); }
    catch { cancel(); }
  });
}

export async function main(argv: string[], cfg: Cfg): Promise<number> {
  const cmd = ({ '--stats': stats, '--label': label, '--eval': evaluate } as Record<string, () => number | Promise<number>>)[argv[0]];
  if (cmd) return cmd();
  if (argv.includes('--private')) return 0; // no routing, retrieval or model payload for explicitly private input
  const hook = argv.includes('--hook');
  const hi = argv.indexOf('--host');
  const host = hi >= 0 && argv[hi + 1] ? argv[hi + 1] : 'claude';
  if (hook) {
    if (process.env.BOSUN_DEPTH) return 0;   // inside a bosun executor: stay out of the way
    let input: any;
    try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { return 0; }
    if (input?.private !== undefined && input.private !== false || input?.privacy !== undefined && input.privacy !== 'public') return 0;
    const prompt = typeof input?.prompt === 'string' ? input.prompt : '';
    const p = prompt.trimStart();
    if (!p || p.startsWith('/') || p.startsWith('!') || p.split(/\s+/).length < 3 || prompt.includes('#noroute')) return 0;
    const sid = typeof input.session_id === 'string' ? input.session_id : null;
    // Remote compatibility stays parallel. Local acquisition follows all configured router/network work.
    const [result, remote] = cfg.MEMORY_URL
      ? await Promise.all([ask(cfg, prompt).catch(() => null), memoryBlock(cfg, prompt, sid)])
      : [await ask(cfg, prompt).catch(() => null), null];
    let hint = '';
    if (result) {
      const { decision: d, final, why } = result;
      log(d, final, why);
      if (final) hint = `[router ${d.router} ${d.ms}ms] suggests: ${final} (conf ${d.conf}, risk ${d.risk})${why ? ` (${why})` : ''} -> ${(HINT[host] || HINT.claude)[final]}. Advisory only: override it if the request needs otherwise.`;
    }
    if (remote) {
      const ctx = [remote.text, hint].filter(Boolean).join('\n\n');
      if (ctx) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: ctx } }));
      return 0;
    }
    const abort = new AbortController();
    const cancel = () => abort.abort();
    process.once('SIGTERM', cancel); process.once('SIGINT', cancel);
    let mem: MemoryBlock | undefined;
    let delivered = false;
    try {
      mem = await memoryBlock(cfg, prompt, sid);
      if (abort.signal.aborted) return 0;
      if (mem.text && mem.valid && !mem.valid()) { mem.complete?.(false); mem.text = ''; }
      const envelope = (text: string) => JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } }) + '\n';
      let ctx = [mem.text, hint].filter(Boolean).join('\n\n');
      let line = ctx ? envelope(ctx) : '';
      if (mem.complete && Buffer.byteLength(line) > DELIVERY_BYTES) {
        mem.complete(false); // discard the uncertain memory, never emit it after releasing
        ctx = hint;
        line = ctx ? envelope(ctx) : '';
      }
      if (line) delivered = await deliverHook(line, abort.signal);
      return 0;
    } finally {
      mem?.complete?.(delivered);
      process.off('SIGTERM', cancel); process.off('SIGINT', cancel);
    }
  }
  const prompt = argv.filter((a) => !a.startsWith('--')).join(' ') || fs.readFileSync(0, 'utf8');
  let result: RouteResult | null;
  try { result = await ask(cfg, prompt); } catch { console.error('router unavailable or returned an invalid response'); return 1; }
  if (!result) { console.error('router unavailable or returned an invalid response'); return 1; }
  const { decision: d, final, why } = result;
  log(d, final, why);
  console.log(JSON.stringify({ ...d, final, why }, null, 2));
  return 0;
}
