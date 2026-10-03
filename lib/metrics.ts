// Operation timings and sizes (~/.bosun/metrics.jsonl) and the report behind `bosun memory stats`. Numbers only, never content.
import fs from 'node:fs';
import path from 'node:path';
import { P } from './config.ts';
import { jsonl } from './util.ts';

export type Metric = { op: string; ms: number; n?: number; chars?: number; estTokens?: number; provider?: string; ok?: boolean };
const FILE = () => path.join(P.BOSUN, 'metrics.jsonl');
let muted = false;
export const mute = (): void => { muted = true; };   // bench: a synthetic corpus must not skew your stats

export function record(m: Metric): void {
  if (muted) return;
  try {
    fs.mkdirSync(P.BOSUN, { recursive: true });
    fs.appendFileSync(FILE(), `${JSON.stringify({ ts: Date.now(), ...m, ms: Math.round(m.ms * 100) / 100 })}\n`);
  } catch { /* metrics never break a caller */ }
}

// Times fn and records it, also when it throws.
export async function timed<T>(op: string, fn: () => T | Promise<T>, size: (r: T) => Omit<Metric, 'op' | 'ms'> = () => ({})): Promise<T> {
  const t = performance.now();
  try {
    const r = await fn();
    record({ op, ms: performance.now() - t, ok: true, ...size(r) });
    return r;
  } catch (e) { record({ op, ms: performance.now() - t, ok: false }); throw e; }
}

export const quantile = (xs: number[], q: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0;
};
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const sum = (xs: number[]) => xs.reduce((a, b) => a + (b || 0), 0);

export function report(): string[] {
  const rows = jsonl(FILE()) as Metric[];
  const usage = jsonl(path.join(P.BOSUN, 'llm-usage.jsonl'));
  if (!rows.length && !usage.length) return [`no metrics yet (${FILE()})`];
  const by = new Map<string, Metric[]>();
  for (const r of rows) by.set(r.op, [...(by.get(r.op) || []), r]);
  const out = [`${'op'.padEnd(22)} ${'n'.padStart(6)} ${'p50 ms'.padStart(9)} ${'p95 ms'.padStart(9)}`];
  for (const [op, rs] of [...by].sort(([a], [b]) => a.localeCompare(b))) {
    const ms = rs.map((r) => r.ms);
    out.push(`${op.padEnd(22)} ${String(rs.length).padStart(6)} ${quantile(ms, 0.5).toFixed(1).padStart(9)} ${quantile(ms, 0.95).toFixed(1).padStart(9)}`);
  }
  const hook = by.get('hook') || [];
  const inj = hook.filter((r) => (r.n || 0) > 0);
  const ctx = by.get('context.retrieve') || [];
  out.push('',
    `hook: ${inj.length} with memory, ${hook.length - inj.length} without; ~${avg(inj.map((r) => r.estTokens || 0)).toFixed(0)} tokens and ${avg(inj.map((r) => r.n || 0)).toFixed(1)} items per injection (estimated)`,
    `context: ${ctx.length} retrievals, ~${avg(ctx.map((r) => r.estTokens || 0)).toFixed(0)} tokens and ${avg(ctx.map((r) => r.n || 0)).toFixed(1)} items on average`,
    `llm: ${usage.length} calls, ${usage.filter((u) => u.ok).length} ok, ${avg(usage.map((u) => u.ms)).toFixed(0)} ms average, tokens in/out ${sum(usage.map((u) => u.tokensIn))}/${sum(usage.map((u) => u.tokensOut))}`,
    `remote calls: ${rows.filter((r) => r.op.startsWith('remote.')).length}`);
  return out;
}
