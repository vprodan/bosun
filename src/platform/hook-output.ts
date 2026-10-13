import fs from 'node:fs';
import type { Writable } from 'node:stream';

export type HookOutput = {
  stream: Writable;
  terminate(): void;
  finish?(): void;
};

// Explicit fs.write avoids Bun's buffered FileSink/stdout callback fast path.
// This is a runtime candidate; compiled pipe/lease qualification is separate.
export function createFdHookOutput(): HookOutput {
  const stream = fs.createWriteStream('', {
    fd: process.stdout.fd,
    autoClose: false,
    fs: { write: fs.write },
  });
  let stopped = false;
  return {
    stream,
    terminate() {
      if (stopped) return;
      stopped = true;
      // Bun closes SQLite handles during graceful VM teardown. Kill this exact
      // producer instead, retaining its lease until all native producers stop.
      // If termination is denied, keep the unresolved delivery and lease alive
      // for the caller's process deadline; never resolve or retry the write.
      const keepAlive = setInterval(() => {}, 1000);
      keepAlive.ref();
      try { process.kill(process.pid, 'SIGKILL'); } catch {}
    },
    finish() { stream.end(); },
  };
}

export function hookOutput(): HookOutput {
  return createFdHookOutput();
}
