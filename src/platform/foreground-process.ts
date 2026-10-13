import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import type { Env } from '../core/domain/inference.ts';
import { BosunError } from '../core/errors.ts';

// Native TUI owns the inherited terminal. Unlike bounded job processes this
// deliberately shares its controlling terminal and makes no tool-quiescence claim.
export async function foregroundProcess(spec: {
  command: string;
  args: readonly string[];
  cwd: string;
  env: Env;
  signal: AbortSignal;
}): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (spec.signal.aborted) throw new BosunError('cancelled', 'Native launch cancelled');
  if (
    !path.isAbsolute(spec.command) ||
    !path.isAbsolute(spec.cwd) ||
    !fs.statSync(spec.cwd).isDirectory() ||
    !Array.isArray(spec.args) ||
    spec.args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))
  )
    throw new BosunError('invalid', 'Invalid foreground process');
  let child;
  try {
    child = childProcess.spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      env: { ...spec.env },
      shell: false,
      stdio: 'inherit',
      detached: false,
    });
  } catch {
    throw new BosunError('unavailable', 'Native launch receipt unavailable', {
      details: { outcome: 'unknown' },
    });
  }
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const stop = () => {
    if (closed) return;
    try {
      child.kill('SIGTERM');
    } catch {}
    killTimer ??= setTimeout(() => {
      if (!closed)
        try {
          child.kill('SIGKILL');
        } catch {}
    }, 500);
    killTimer.unref();
  };
  spec.signal.addEventListener('abort', stop, { once: true });
  if (spec.signal.aborted) stop();
  try {
    return await new Promise((resolve, reject) => {
      let failed = false;
      child.once('error', () => {
        failed = true;
      });
      child.once('close', (code, signal) => {
        closed = true;
        if (failed)
          reject(
            new BosunError('unavailable', 'Native launch receipt unavailable', {
              details: { outcome: 'unknown' },
            }),
          );
        else resolve({ code, signal });
      });
    });
  } finally {
    if (killTimer) clearTimeout(killTimer);
    spec.signal.removeEventListener('abort', stop);
  }
}
