import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import type { Env } from '../core/domain/inference.ts';
import { createCuratedSource } from '../core/memory-source.ts';
import { createRetrieveContext } from '../core/use-cases/retrieve-context.ts';
import { runtimePaths } from '../platform/paths.ts';
import { loadHookConfig } from '../platform/hook-config.ts';
import { project, memoryScope } from '../platform/project.ts';
import { contentHash } from '../platform/content-hash.ts';
import { memorySqliteRuntime } from '../platform/sqlite-runtime.ts';
import { hookOutput, type HookOutput } from '../platform/hook-output.ts';
import { callLocalRpc } from '../adapters/transport/local-rpc.ts';
import type { MemoryReader } from '../core/ports/memory.ts';

import { screenPublicText } from '../core/secret-screen.ts';
const MAX_OUTPUT = 16384;
function sink(): boolean {
  try {
    const stat = fs.fstatSync(process.stdout.fd);
    return (
      memorySqliteRuntime() && (stat.isFIFO() || stat.isSocket())
    );
  } catch {
    return false;
  }
}
function input(): Record<string, unknown> | null {
  const buffer = Buffer.alloc(32769);
  let bytes = 0;
  try {
    while (bytes < buffer.length) {
      const n = fs.readSync(0, buffer, bytes, buffer.length - bytes, null);
      if (!n) break;
      bytes += n;
    }
    if (bytes > 32768) return null;
    const parsed = JSON.parse(buffer.subarray(0, bytes).toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
function deliver(output: HookOutput, line: string, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (accepted: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      output.stream.off('error', cancel);
      signal.removeEventListener('abort', cancel);
      resolve(accepted);
    };
    const cancel = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // Retain the native read lease until OS producer teardown. A JS stream close
      // does not establish permanent cancellation of a pending native write.
      output.terminate();
    };
    const timer = setTimeout(cancel, 250);
    if (signal.aborted || output.stream.destroyed) {
      finish(false);
      return;
    }
    output.stream.on('error', cancel);
    signal.addEventListener('abort', cancel, { once: true });
    try {
      output.stream.write(line, (error) => {
        if (error) cancel();
        else finish(true);
      });
    } catch {
      cancel();
    }
  });
}

// Lean one-shot entry: generated JSON, one bounded local metadata request and a
// producer-owned read lease. No model inference, indexing or storage mutation.
export async function main(env: Env = process.env, options: { output?: () => HookOutput } = {}): Promise<number> {
  if (env.BOSUN_DEPTH || !sink()) return 0;
  const request = input();
  if (
    !request ||
    (request.private !== undefined && request.private !== false) ||
    (request.privacy !== undefined && request.privacy !== 'public')
  )
    return 0;
  const prompt = typeof request.prompt === 'string' ? request.prompt : '';
  if (
    !prompt.trim() ||
    prompt.trimStart().startsWith('/') ||
    prompt.trimStart().startsWith('!') ||
    prompt.includes('#noroute') ||
    prompt.length > 8000
  )
    return 0;
  try { screenPublicText(prompt); } catch { return 0; }
  let reader: (MemoryReader & { validate?: () => void }) | undefined;
  let output: HookOutput | undefined;
  const abort = new AbortController();
  const cancel = () => abort.abort();
  process.once('SIGTERM', cancel);
  process.once('SIGINT', cancel);
  try {
    const paths = runtimePaths(env);
    const config = loadHookConfig(paths);
    if (!config) return 0;
    const workspace =
      typeof request.cwd === 'string' ? request.cwd : env.CLAUDE_PROJECT_DIR || process.cwd();
    const sessionId =
      typeof request.session_id === 'string' ? request.session_id : env.CODEX_THREAD_ID || null;
    const ctx = memoryScope(project(workspace), config.memory.linkedProjects, sessionId, 'hook');
    let candidates: Set<string> | null = null;
    if (!config.memory.remoteAuthorityId)
      try {
        const result = await callLocalRpc<{ ids: unknown }>({
          socket: config.socket,
          timeoutMs: 20,
          signal: abort.signal,
          request: {
            version: 1,
            id: crypto.randomUUID(),
            method: 'hook.candidates',
            params: { task: prompt },
            scope: { workspace, sessionId, audience: 'model' },
          },
        });
        if (
          !Array.isArray(result.ids) ||
          result.ids.length > 20 ||
          result.ids.some((id) => typeof id !== 'string' || id.length > 64)
        )
          return 0;
        candidates = new Set(result.ids);
      } catch {
        /* Absent daemon: the same bound public/rollback reader remains read-only. */
      }
    if (abort.signal.aborted) return 0;
    if (config.memory.remoteAuthorityId) {
      if (!config.memory.remoteClientId || !config.memory.sourceId) return 0;
      const { RemoteViewReadOnly } = await import('../adapters/memory/remote-view-readonly.ts');
      reader = new RemoteViewReadOnly(
        path.join(paths.home, 'remote-view.db'),
        {
          authorityId: config.memory.remoteAuthorityId,
          clientId: config.memory.remoteClientId,
          clientSourceId: config.memory.sourceId,
          configRevision: config.configRevision,
        },
        ctx,
        Date.now,
      );
    } else {
      const { openHookMemory } = await import('../adapters/memory/sqlite-readonly.ts');
      reader = openHookMemory(
        {
          primary: config.memory.primary,
          view: config.memory.view,
          sourceId: config.memory.sourceId ?? undefined,
        },
        Date.now,
      );
    }
    const borrowed: MemoryReader = {
      get: reader.get.bind(reader),
      close() {},
      async search(query, scope) {
        const records = await reader!.search(query, scope);
        return candidates ? records.filter((record) => candidates!.has(record.id)) : records;
      },
    };
    const result = await createRetrieveContext([createCuratedSource(borrowed)], {
      now: Date.now,
      monotonic: () => performance.now(),
      hash: contentHash,
      dateLabel: (at) => new Date(at).toISOString().slice(0, 10),
      measure() {},
    })(prompt, ctx, config.context);
    if (!result.text || abort.signal.aborted) return 0;
    reader.validate?.();
    const line =
      JSON.stringify({
        hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: result.text },
      }) + '\n';
    if (Buffer.byteLength(line) > MAX_OUTPUT) return 0;
    output = (options.output ?? hookOutput)();
    await deliver(output, line, abort.signal);
    return 0;
  } catch {
    return 0;
  } finally {
    reader?.close();
    output?.finish?.();
    process.off('SIGTERM', cancel);
    process.off('SIGINT', cancel);
  }
}
