// Shared helpers: terminal output, subprocesses, JSON files, a small JSON Schema check. Node built-ins only.
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import fs from 'node:fs';
import { BosunError } from '../src/core/errors.ts';
export { BosunError } from '../src/core/errors.ts';
import path from 'node:path';

const tty = !!process.stdout.isTTY;
export const C = { b: tty ? '\x1b[1m' : '', g: tty ? '\x1b[32m' : '', r: tty ? '\x1b[31m' : '', y: tty ? '\x1b[33m' : '', n: tty ? '\x1b[0m' : '' };
export const state = { failed: false };
export const say = (m: string): void => console.log(`\n${C.b}==> ${m}${C.n}`);
export const ok = (m: string): void => console.log(`  ${C.g}✓${C.n} ${m}`);
export const bad = (m: string): void => { console.log(`  ${C.r}✗${C.n} ${m}`); state.failed = true; };
export const warn = (m: string): void => console.log(`  ${C.y}!${C.n} ${m}`);

export function die(message: string, exitCode = 1): never { throw new BosunError(message, exitCode); }

// Run and capture. Never throws: a missing binary is code 1.
export type Sh = { code: number; out: string; err: string };
export function sh(cmd: string, args: string[] = [], opts: SpawnSyncOptions = {}): Sh {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  return { code: r.status === null ? 1 : r.status, out: String(r.stdout || '').trim(), err: String(r.stderr || (r.error ? r.error.message : '')).trim() };
}
// Run attached to the user's terminal (installs, pulls); dies on failure.
export function step(cmd: string, args: string[] = [], opts: SpawnSyncOptions = {}): void {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) die(`${cmd} ${args.join(' ')} failed`);
}
export const which = (cmd: string): string => sh('/bin/sh', ['-c', 'command -v "$1"', 'sh', cmd]).out;
export const has = (cmd: string): boolean => which(cmd) !== '';
export const up = (url: string): boolean => sh('curl', ['-sf', '-m', '2', '-o', '/dev/null', url]).code === 0;
export const sleep = (s: number): void => { sh('sleep', [String(s)]); };

// Missing file -> null. Invalid JSON throws, so a file we can't parse is never overwritten.
export const readJson = (p: string): any => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null);
export function writeJson(p: string, v: unknown): void { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n'); }
export function backup(p: string): void { if (fs.existsSync(p) && !fs.existsSync(`${p}.bak-bosun`)) fs.copyFileSync(p, `${p}.bak-bosun`); }

// JSON lines. Skips unparseable lines: a half-written line must not break a reader forever.
export function jsonl(file: string): any[] {
  if (!fs.existsSync(file)) return [];
  const rows: any[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return rows;
}

// Exact compatibility forwarding for all existing tool/API/LLM validation callers.
export { validate, type Schema } from '../src/contracts/schema.ts';
