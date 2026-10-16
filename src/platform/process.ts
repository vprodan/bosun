import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { BosunError } from '../core/errors.ts';
import type { Env } from '../core/domain/inference.ts';

export type ProcessSpec = {
  command: string; args: readonly string[]; cwd: string; env: Env; signal: AbortSignal; input?: string;
  stdin?: (input: ProcessInput) => void;
  onClosed?: () => void;
  // Binary capture preserves Git's NUL-delimited paths without another process lifecycle.
  stdout?: (chunk: Uint8Array) => void;
  timeoutMs?: number; killGraceMs?: number; maxOutputBytes?: number; maxLineBytes?: number;
};
export type ProcessInput = { write(text: string): Promise<void>; end(): void };
export type ProcessEvent = { t: 'line'; text: string }
  | { t: 'exit'; code: number | null; signal: NodeJS.Signals | null };
export function executable(command: string, env: Env): string | null {
  if (typeof command !== 'string' || command.includes('\0')) return null;
  // The running interpreter is already known; do not re-read an external binary
  // merely to use it for a guarded Bun child or source development entry.
  if (command === process.execPath) return command;
  const candidates = path.isAbsolute(command) ? [command] : /^[a-zA-Z0-9._-]+$/.test(command)
    ? (env.PATH ?? '').split(path.delimiter).filter(dir => path.isAbsolute(dir)).map(dir => path.join(dir, command)) : [];
  for (const file of candidates) {
    try { if (fs.statSync(file).isFile()) { fs.accessSync(file, fs.constants.X_OK); return file; } } catch { /* next explicit PATH entry */ }
  }
  return null;
}
const limit = (value: number | undefined, fallback: number, max: number): number => {
  const number = value ?? fallback;
  if (!Number.isSafeInteger(number) || number < 1 || number > max) throw new BosunError('invalid', 'Invalid process limits');
  return number;
};

// No shell, inherited environment, terminal detection or prompt/output logs. Cancellation
// waits for native close; POSIX workers own a process group so ordinary tool children stop too.
export async function* streamProcess(spec: ProcessSpec): AsyncGenerator<ProcessEvent> {
  if (spec.signal.aborted) throw new BosunError('cancelled', 'Process cancelled');
  const timeoutMs = limit(spec.timeoutMs, 1800000, 86400000); const killGraceMs = limit(spec.killGraceMs, 500, 10000);
  // Explicit binary streaming (release assets) may opt into a larger finite cap;
  // ordinary callers retain the 1 MiB default and bounded line decoding.
  const maxOutputBytes = limit(spec.maxOutputBytes, 1048576, 300 * 1024 * 1024); const maxLineBytes = limit(spec.maxLineBytes, 65536, 262144);
  if (!path.isAbsolute(spec.cwd) || spec.cwd.includes('\0') || !fs.statSync(spec.cwd).isDirectory()
    || !Array.isArray(spec.args) || spec.args.some(arg => typeof arg !== 'string' || arg.includes('\0'))
    || Buffer.byteLength(JSON.stringify(spec.args)) > 1048576 || spec.input !== undefined && Buffer.byteLength(spec.input) > 262144
    || spec.stdin !== undefined && (typeof spec.stdin !== 'function' || spec.input !== undefined)
    || spec.onClosed !== undefined && typeof spec.onClosed !== 'function'
    || spec.stdout !== undefined && typeof spec.stdout !== 'function') {
    throw new BosunError('invalid', 'Invalid process request');
  }
  const command = executable(spec.command, spec.env);
  if (!command) throw new BosunError('unavailable', 'Executable unavailable');
  const grouped = process.platform !== 'win32';
  // Read the builtin object at dispatch: Bun does not synchronize patched named exports.
  const child = childProcess.spawn(command, [...spec.args], { cwd: spec.cwd, env: { ...spec.env }, shell: false, detached: grouped, stdio: ['pipe', 'pipe', 'pipe'] });
  let closed = false; let outputBytes = 0; let failure: 'cancelled' | 'timeout' | 'unavailable' | null = null;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  function signal(name: NodeJS.Signals) {
    if (!child.pid || closed) return;
    try { if (grouped) process.kill(-child.pid, name); else child.kill(name); } catch { /* native close remains required */ }
  }
  function stop(reason: typeof failure) {
    failure ??= reason; signal('SIGTERM');
    if (!closed && !killTimer) { killTimer = setTimeout(() => signal('SIGKILL'), killGraceMs); killTimer.unref(); }
  }
  const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once('error', () => { failure ??= 'unavailable'; });
    child.once('close', (code, name) => { closed = true; resolve({ code, signal: name }); });
  });
  const abort = () => stop('cancelled'); spec.signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => stop('timeout'), timeoutMs); timer.unref();
  const count = (bytes: number) => { outputBytes += bytes; if (outputBytes > maxOutputBytes) stop('unavailable'); };
  child.stderr.on('data', (chunk: Buffer) => count(chunk.length));
  child.stdin.on('error', () => stop('unavailable'));
  const decoder = new StringDecoder('utf8'); let pending = '';
  let inputBytes = 0; let inputEnded = false;
  const input: ProcessInput = {
    async write(text) {
      if (closed || inputEnded || failure || typeof text !== 'string') throw new BosunError('unavailable', 'Process input unavailable');
      const bytes = Buffer.byteLength(text);
      if (bytes > 262144 || (inputBytes += bytes) > 4194304) { stop('unavailable'); throw new BosunError('unavailable', 'Process input unavailable'); }
      await new Promise<void>((resolve, reject) => child.stdin.write(text, error => error
        ? reject(new BosunError('unavailable', 'Process input unavailable')) : resolve()));
    },
    end() { if (!closed && !inputEnded) { inputEnded = true; child.stdin.end(); } },
  };
  let groupCleanup: Promise<void> | undefined;
  function stopRemainingGroup(): Promise<void> { return groupCleanup ??= terminateGroup(); }
  async function terminateGroup() {
    if (!grouped || !child.pid) return;
    const exists = () => { try { process.kill(-child.pid!, 0); return true; } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
      throw new BosunError('unavailable', 'Process termination unavailable');
    } };
    if (!exists()) return;
    // A parent can close while an ordinary child with ignored stdio survives.
    // The group is still ours: do not cancel its KILL merely because the parent closed.
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // EPERM is not a termination acknowledgement. The original group may
      // still settle; require native ESRCH below within the existing grace.
      if (code !== 'ESRCH' && code !== 'EPERM') throw new BosunError('unavailable', 'Process termination unavailable');
    }
    const deadline = performance.now() + killGraceMs;
    while (exists()) {
      if (performance.now() >= deadline) throw new BosunError('unavailable', 'Process termination unavailable');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  try {
    if (spec.signal.aborted) abort();
    if (spec.stdin) spec.stdin(input); else child.stdin.end(spec.input ?? '');
    for await (const chunk of child.stdout) {
      count((chunk as Buffer).length);
      if (failure) break;
      if (spec.stdout) { spec.stdout(chunk as Buffer); continue; }
      pending += decoder.write(chunk as Buffer);
      for (;;) {
        const newline = pending.indexOf('\n'); if (newline < 0) break;
        const line = pending.slice(0, newline).replace(/\r$/, ''); pending = pending.slice(newline + 1);
        if (Buffer.byteLength(line) > maxLineBytes) { stop('unavailable'); break; }
        if (line) yield { t: 'line', text: line };
        if (failure) break;
      }
      if (Buffer.byteLength(pending) > maxLineBytes) stop('unavailable');
      if (failure) break;
    }
    if (!spec.stdout) pending += decoder.end();
    if (!failure && pending) {
      if (Buffer.byteLength(pending) > maxLineBytes) stop('unavailable');
      else yield { t: 'line', text: pending };
    }
    const result = await completion;
    await stopRemainingGroup();
    if (failure) throw new BosunError(failure, failure === 'cancelled' ? 'Process cancelled' : failure === 'timeout' ? 'Process timed out' : 'Process output unavailable');
    yield { t: 'exit', ...result };
  } catch (error) {
    stop(error instanceof BosunError && error.code === 'cancelled' ? 'cancelled' : 'unavailable');
    await completion;
    throw error instanceof BosunError ? error : new BosunError('unavailable', 'Process unavailable');
  } finally {
    if (!closed) stop('cancelled');
    try { await completion; await stopRemainingGroup(); spec.onClosed?.(); }
    finally {
      clearTimeout(timer); if (killTimer) clearTimeout(killTimer);
      spec.signal.removeEventListener('abort', abort);
    }
  }
}
