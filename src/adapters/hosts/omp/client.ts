import fs from 'node:fs';
import path from 'node:path';
import type { Detect, Env } from '../../../core/domain/inference.ts';
import type { ProcessInput } from '../../../platform/process.ts';
import type { OmpFrame, OmpMethod } from './protocol.ts';
import { BosunError } from '../../../core/errors.ts';
import { executable, streamProcess } from '../../../platform/process.ts';
import { assertReadyFrame, identifier, object, OmpFrameDecoder, ompFailure, OMP_LIMITS, OMP_VERSION } from './protocol.ts';

export type OmpClientSettings = { command?: string; env: Env; timeoutMs?: number; requestTimeoutMs?: number; killGraceMs?: number };
export type OmpReceipt = { id: string; command: OmpMethod; admission: 'pending' | 'accepted' | 'rejected' | 'unknown'; completion?: OmpFrame };
export type OmpClient = {
  request(method: OmpMethod, params: Record<string, unknown>, signal?: AbortSignal, id?: string): Promise<unknown>;
  waitPrompt(id: string, signal?: AbortSignal): Promise<OmpFrame>;
  receipt(id: string): Readonly<OmpReceipt> | undefined;
  close(): Promise<void>;
};
export type OmpClientOptions = OmpClientSettings & { cwd: string; args: readonly string[]; event(frame: OmpFrame): void; closed(): void };
type Pending = { command: OmpMethod; resolve(data: unknown): void; reject(error: BosunError): void; dispose(): void };
type Prompt = { receipt: OmpReceipt; resolve(frame: OmpFrame): void; reject(error: BosunError): void; result: Promise<OmpFrame> };
const methods: Record<OmpMethod, true> = { negotiate_protocol: true, get_state: true, get_entries: true, get_messages_page: true,
  set_model: true, set_thinking_level: true, set_auto_compaction: true, set_auto_retry: true,
  set_cache_warming: true, set_event_filter: true, prompt: true, abort_and_restore_queue: true };

export async function detectOmp(command: string, env: Env): Promise<Detect> {
  const located = executable(command, env);
  if (!located) return { installed: false };
  if (!env.HOME || !path.isAbsolute(env.HOME)) return { installed: true, path: located, notes: ['version_unverified'] };
  let output = '', code: number | null = null;
  try {
    for await (const row of streamProcess({ command: located, args: ['--version'], cwd: env.HOME, env,
      signal: new AbortController().signal, timeoutMs: 3000, maxOutputBytes: 4096, maxLineBytes: 1024 })) {
      if (row.t === 'line') output += row.text + '\n'; else code = row.code;
    }
    const version = code === 0 ? /^omp\/(\d+\.\d+\.\d+)\s*$/.exec(output)?.[1] : undefined;
    return { installed: true, path: located, ...(version ? { version } : { notes: ['version_unverified'] }) };
  } catch { return { installed: true, path: located, notes: ['version_unverified'] }; }
}

// A fresh owned process only. No discovery, adoption, login, retry or provider
// fallback. Every effect has an original receipt even when the outcome is lost.
export async function connectOmpRpc(options: OmpClientOptions, signal: AbortSignal): Promise<OmpClient> {
  if (signal.aborted) throw ompFailure('cancelled');
  if (!path.isAbsolute(options.cwd) || !fs.statSync(options.cwd).isDirectory()) throw ompFailure('invalid');
  const requestTimeout = options.requestTimeoutMs ?? 10000, timeout = options.timeoutMs ?? 1800000;
  if (!Number.isSafeInteger(requestTimeout) || requestTimeout < 1 || requestTimeout > 60000
    || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 86400000) throw ompFailure('invalid');
  const env = { ...options.env, BOSUN_DEPTH: '1', BOSUN_CALLER: 'model', PI_NO_TITLE: '1', PI_NO_PTY: '1' };
  const detected = await detectOmp(options.command ?? 'omp', env);
  if (!detected.installed) throw ompFailure();
  if (detected.version !== OMP_VERSION) throw ompFailure('unverified');
  if (signal.aborted) throw ompFailure('cancelled');
  const control = new AbortController(), pending = new Map<string, Pending>(), prompts = new Map<string, Prompt>();
  const receipts = new Map<string, OmpReceipt>(), decoder = new OmpFrameDecoder();
  let input: ProcessInput | undefined, ready = false, closing = false, closed = false, joined = false, serial = 0;
  let failure: BosunError | undefined;
  const { promise: readiness, resolve: readyResolve, reject: readyReject } = Promise.withResolvers<void>();
  function stop(error: BosunError) {
    failure ??= error; closing = true;
    for (const receipt of receipts.values()) if (receipt.admission === 'pending' || receipt.admission === 'accepted' && !receipt.completion)
      receipt.admission = 'unknown';
    control.abort();
  }
  function frame(row: OmpFrame) {
    if (!ready) { assertReadyFrame(row); ready = true; readyResolve(); return; }
    if (row.type === 'ready') throw ompFailure('unavailable', true);
    if (row.type === 'response') {
      if (!identifier(row.id) || !identifier(row.command) || typeof row.success !== 'boolean') throw ompFailure('unavailable', true);
      const operation = pending.get(row.id);
      // A later same-id error after prompt admission is native uncertainty, not
      // permission to retry the admitted prompt or to downgrade its receipt.
      if (!operation || operation.command !== row.command) throw ompFailure('unavailable', true);
      pending.delete(row.id); operation.dispose();
      const receipt = receipts.get(row.id)!;
      if (!row.success) {
        receipt.admission = 'rejected';
        const error = ompFailure('unavailable', row.command === 'prompt');
        operation.reject(error); prompts.get(row.id)?.reject(error); return;
      }
      receipt.admission = 'accepted';
      if (row.command === 'prompt' && object(row.data) && row.data.agentInvoked === false) {
        // Native local completion is the original response, not an invented
        // prompt_result or quiescence receipt; the command may start async work.
        receipt.completion = row; prompts.get(row.id)!.resolve(row);
      }
      operation.resolve(row.data); return;
    }
    if (row.type === 'prompt_result') {
      if (!identifier(row.id) || typeof row.agentInvoked !== 'boolean' || typeof row.sessionSettled !== 'boolean'
        || !['completed', 'aborted', 'error'].includes(String(row.status))) throw ompFailure('unavailable', true);
      const prompt = prompts.get(row.id);
      if (!prompt || prompt.receipt.admission !== 'accepted' || prompt.receipt.completion) throw ompFailure('unavailable', true);
      prompt.receipt.completion = row; prompt.resolve(row);
    }
    if (row.type === 'extension_error' || row.type === 'notice' || row.type === 'host_tool_call' || row.type === 'host_uri_request'
      || row.type === 'extension_ui_request' || row.type === 'config_update' || row.type === 'model_changed'
      || row.type === 'thinking_level_changed' || row.type === 'retry_fallback_applied') {
      const expected = row.type === 'model_changed' ? 'set_model'
        : row.type === 'thinking_level_changed' ? 'set_thinking_level' : null;
      // Only the original correlated selector operation can authorize a change.
      // Unsolicited changes cannot be laundered by a later matching readback.
      if (!expected || ![...pending.values()].some(operation => operation.command === expected))
        throw ompFailure('unavailable', true);
    }
    options.event(row);
  }
  const abort = () => stop(ompFailure('cancelled', true));
  signal.addEventListener('abort', abort, { once: true });
  const readyTimer = setTimeout(() => stop(ompFailure('timeout', true)), requestTimeout); readyTimer.unref();
  const pump = (async () => {
    try {
      for await (const row of streamProcess({ command: detected.path!, args: options.args, cwd: options.cwd, env,
        signal: control.signal, timeoutMs: timeout, killGraceMs: options.killGraceMs,
        maxOutputBytes: OMP_LIMITS.sourceBytes, stdin(channel) { input = channel; },
        stdout(bytes) { decoder.push(bytes, frame); }, onClosed() { joined = true; } })) {
        if (row.t === 'exit') { decoder.finish(); if (!closing || row.code !== 0 || row.signal !== null) throw ompFailure('unavailable', true); }
      }
    } catch (error) { failure ??= error instanceof BosunError ? error : ompFailure('unavailable', true); }
    finally {
      clearTimeout(readyTimer); signal.removeEventListener('abort', abort); closing = true; closed = true;
      const error = failure ?? ompFailure('unavailable', true); readyReject(error);
      for (const [id, operation] of pending) {
        receipts.get(id)!.admission = 'unknown'; operation.dispose(); operation.reject(error);
      }
      pending.clear();
      for (const prompt of prompts.values()) if (!prompt.receipt.completion) { prompt.receipt.admission = 'unknown'; prompt.reject(error); }
      options.closed();
    }
  })();
  async function close(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (!closed) { closing = true; input?.end(); timer = setTimeout(() => control.abort(), options.killGraceMs ?? 500); timer.unref(); }
    await pump; clearTimeout(timer);
    if (!joined || failure) throw failure ?? ompFailure('unavailable', true);
  }
  async function request(method: OmpMethod, params: Record<string, unknown>, abortSignal?: AbortSignal, suppliedId?: string): Promise<unknown> {
    if (!Object.hasOwn(methods, method)) throw ompFailure('invalid');
    if (closing || closed || !input) throw failure ?? ompFailure('unavailable', true);
    if (abortSignal?.aborted) throw ompFailure('cancelled');
    if (pending.size >= 8 || receipts.size >= OMP_LIMITS.requests || !object(params)
      || Object.hasOwn(params, 'id') || Object.hasOwn(params, 'type')) throw ompFailure('invalid');
    const id = suppliedId ?? 'omp_' + (++serial);
    if (!identifier(id) || receipts.has(id)) throw ompFailure('invalid');
    let body: string;
    try { body = JSON.stringify({ ...params, id, type: method }) + '\n'; } catch { throw ompFailure('invalid'); }
    if (Buffer.byteLength(body) > 262144) throw ompFailure('invalid');
    const receipt: OmpReceipt = { id, command: method, admission: 'pending' }; receipts.set(id, receipt);
    if (method === 'prompt') {
      const { promise: result, resolve, reject } = Promise.withResolvers<OmpFrame>();
      void result.catch(() => {});
      prompts.set(id, { receipt, resolve, reject, result });
    }
    const { promise: result, resolve, reject } = Promise.withResolvers<unknown>();
    const cancel = () => stop(ompFailure('cancelled', true));
    const timer = setTimeout(() => stop(ompFailure('timeout', true)), requestTimeout); timer.unref();
    abortSignal?.addEventListener('abort', cancel, { once: true });
    pending.set(id, { command: method, resolve, reject, dispose() { clearTimeout(timer); abortSignal?.removeEventListener('abort', cancel); } });
    if (abortSignal?.aborted) cancel();
    void input.write(body).catch(() => stop(ompFailure('unavailable', true)));
    return result;
  }
  try {
    await readiness; clearTimeout(readyTimer);
    const negotiated = await request('negotiate_protocol', { protocolVersion: 2 }, signal);
    if (!object(negotiated) || negotiated.protocolVersion !== 2) throw ompFailure('unavailable', true);
    return { request, close, receipt(id) { const value = receipts.get(id); return value ? { ...value } : undefined; },
      async waitPrompt(id, abortSignal) {
        const prompt = prompts.get(id); if (!prompt) throw ompFailure('invalid');
        const cancel = () => stop(ompFailure('cancelled', true));
        const timer = setTimeout(() => stop(ompFailure('timeout', true)), timeout); timer.unref();
        abortSignal?.addEventListener('abort', cancel, { once: true });
        if (abortSignal?.aborted) cancel();
        try { return await prompt.result; } finally { clearTimeout(timer); abortSignal?.removeEventListener('abort', cancel); }
      } };
  } catch (error) {
    stop(ompFailure('unavailable', true)); await Promise.allSettled([close()]);
    throw error instanceof BosunError ? error : ompFailure('unavailable', true);
  }
}
