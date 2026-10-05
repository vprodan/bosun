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

// The JSON Schema subset bosun uses (MCP tool input, the memory API, LLM output). Error messages name the path, never the value.
export type Schema = {
  type?: 'object' | 'array' | 'string' | 'integer' | 'number' | 'boolean'; description?: string;
  properties?: Record<string, Schema>; required?: string[]; additionalProperties?: boolean;
  items?: Schema; maxItems?: number; enum?: readonly unknown[];
  minLength?: number; maxLength?: number; pattern?: string; minimum?: number; maximum?: number;
};
export function validate(s: Schema, v: unknown, at = '$'): string | null {
  if (s.type === 'object') {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return `${at}: expected an object`;
    const o = v as Record<string, unknown>;
    for (const k of s.required || []) if (o[k] === undefined) return `${at}.${k}: required`;
    for (const [k, x] of Object.entries(o)) {
      if (x === undefined) continue;
      const p = s.properties?.[k];
      if (!p) { if (s.additionalProperties === false) return `${at}.${k}: unknown field`; continue; }
      const e = validate(p, x, `${at}.${k}`);
      if (e) return e;
    }
  } else if (s.type === 'array') {
    if (!Array.isArray(v)) return `${at}: expected an array`;
    if (s.maxItems !== undefined && v.length > s.maxItems) return `${at}: more than ${s.maxItems} items`;
    if (s.items) for (const [i, x] of v.entries()) { const e = validate(s.items, x, `${at}[${i}]`); if (e) return e; }
  } else if (s.type === 'string') {
    if (typeof v !== 'string') return `${at}: expected a string`;
    if (s.minLength !== undefined && v.length < s.minLength) return `${at}: shorter than ${s.minLength}`;
    if (s.maxLength !== undefined && v.length > s.maxLength) return `${at}: longer than ${s.maxLength}`;
    if (s.pattern && !new RegExp(s.pattern, 'u').test(v)) return `${at}: invalid format`;
  } else if (s.type === 'integer' || s.type === 'number') {
    if (typeof v !== 'number' || !Number.isFinite(v) || (s.type === 'integer' && !Number.isInteger(v))) return `${at}: expected ${s.type === 'integer' ? 'an integer' : 'a number'}`;
    if (s.minimum !== undefined && v < s.minimum) return `${at}: below ${s.minimum}`;
    if (s.maximum !== undefined && v > s.maximum) return `${at}: above ${s.maximum}`;
  } else if (s.type === 'boolean' && typeof v !== 'boolean') return `${at}: expected true or false`;
  if (s.enum && !s.enum.includes(v)) return `${at}: must be one of ${s.enum.join(', ')}`;
  return null;
}
