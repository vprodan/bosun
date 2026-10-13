import path from 'node:path';
import { BosunError } from '../../../core/errors.ts';
import type { Env } from '../../../core/domain/inference.ts';
import { streamProcess, type ProcessInput } from '../../../platform/process.ts';
import { version } from '../../../platform/assets.ts';
import { createCodexRunner, CODEX_VERSION } from './runner.ts';

export type CodexMethod = 'account/read' | 'account/rateLimits/read' | 'config/read' | 'thread/start' | 'thread/read'
  | 'thread/compact/start' | 'thread/unsubscribe' | 'thread/inject_items' | 'thread/backgroundTerminals/list' | 'turn/start' | 'turn/interrupt';
const METHODS = new Set<string>(['account/read', 'account/rateLimits/read', 'config/read', 'thread/start', 'thread/read',
  'thread/compact/start', 'thread/unsubscribe', 'thread/inject_items', 'thread/backgroundTerminals/list', 'turn/start', 'turn/interrupt']);
export type CodexClient = {
  request(method: CodexMethod, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
};
export type CodexClientOptions = {
  env: Env; cwd: string; command?: string; timeoutMs?: number; requestTimeoutMs?: number; killGraceMs?: number;
  notification?: (method: string, params: unknown) => void;
  closed?: () => void;
};
type Pending = { resolve(value: unknown): void; reject(error: BosunError): void; dispose(): void };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const failed = (code: 'unavailable' | 'timeout' | 'cancelled' = 'unavailable') => new BosunError(code,
  code === 'timeout' ? 'Codex request timed out' : code === 'cancelled' ? 'Codex request cancelled' : 'Codex request unavailable', { details: { outcome: 'unknown' } });
const id = (value: unknown): value is string | number => Number.isSafeInteger(value) && Number(value) >= 0
  || typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);

// A new, explicitly selected native process. No daemon discovery, token import,
// login, model request, resume, retry or provider fallback is performed here.
// Transport acknowledgement is a correlated native response, not a pipe write.
export async function connectCodexAppServer(options: CodexClientOptions, signal: AbortSignal): Promise<CodexClient> {
  if (signal.aborted) throw new BosunError('cancelled', 'Codex connection cancelled');
  if (!path.isAbsolute(options.cwd) || options.cwd.includes('\0')) throw new BosunError('invalid', 'Invalid Codex workspace');
  const requestTimeout = options.requestTimeoutMs ?? 10000;
  if (!Number.isSafeInteger(requestTimeout) || requestTimeout < 1 || requestTimeout > 60000) throw new BosunError('invalid', 'Invalid Codex request timeout');
  const env: Env = { ...options.env, BOSUN_DEPTH: '1', BOSUN_CALLER: 'model' };
  const detected = await createCodexRunner({ env, command: options.command }).detect(env);
  if (!detected.installed) throw new BosunError('unavailable', 'Codex executable unavailable');
  if (detected.version !== CODEX_VERSION) throw new BosunError('unverified', 'Codex version unverified');
  if (signal.aborted) throw new BosunError('cancelled', 'Codex connection cancelled');
  const control = new AbortController(); const pending = new Map<number, Pending>();
  let input: ProcessInput | undefined; let closing = false; let closed = false; let terminated = false;
  let failure: BosunError | undefined; let counter = 0; let messages = 0;
  let attach!: () => void; let attachFailed!: (error: BosunError) => void;
  const attached = new Promise<void>((resolve, reject) => { attach = resolve; attachFailed = reject; });
  const stop = (error: BosunError) => { failure ??= error; closing = true; control.abort(); };
  const abort = () => stop(failed('cancelled')); signal.addEventListener('abort', abort, { once: true });
  const pump = (async () => {
    try {
      for await (const event of streamProcess({ command: detected.path!, args: ['app-server', '--listen', 'stdio://',
        '-c', 'approval_policy="never"', '-c', 'features.hooks=false', '-c', 'notify=[]'], cwd: options.cwd, env,
        signal: control.signal, timeoutMs: options.timeoutMs, killGraceMs: options.killGraceMs, maxOutputBytes: 4194304, maxLineBytes: 262144,
        stdin(channel) { input = channel; attach(); }, onClosed() { terminated = true; } })) {
        if (event.t === 'exit') { if (!closing) throw failed(); continue; }
        if (++messages > 4096) throw failed();
        let row: unknown; try { row = JSON.parse(event.text); } catch { throw failed(); }
        if (!object(row) || row.jsonrpc !== undefined && row.jsonrpc !== '2.0') throw failed();
        if (typeof row.method === 'string') {
          if (!row.method || row.method.length > 160 || /[\x00-\x1f\x7f]/.test(row.method)) throw failed();
          if (Object.hasOwn(row, 'id')) {
            if (!id(row.id)) throw failed();
            // No native approval, tool execution or credential refresh is
            // silently delegated to this transport client.
            await input!.write(JSON.stringify({ id: row.id, error: { code: -32601, message: 'Client operation unavailable' } }) + '\n');
          } else options.notification?.(row.method, row.params);
          continue;
        }
        if (!Number.isSafeInteger(row.id) || !pending.has(Number(row.id))
          || Object.hasOwn(row, 'result') === Object.hasOwn(row, 'error')) throw failed();
        const operation = pending.get(Number(row.id))!; pending.delete(Number(row.id)); operation.dispose();
        if (Object.hasOwn(row, 'error')) operation.reject(failed()); else operation.resolve(row.result);
      }
    } catch { failure ??= failed(); }
    finally {
      closed = true; closing = true; signal.removeEventListener('abort', abort);
      const error = failure ?? failed('cancelled'); attachFailed(error);
      for (const operation of pending.values()) { operation.dispose(); operation.reject(error); } pending.clear();
      options.closed?.();
    }
  })();
  const close = async () => { if (!closed) { closing = true; control.abort(); } await pump; if (!terminated) throw failed(); };
  async function request(method: string, params: Record<string, unknown>, requestSignal?: AbortSignal): Promise<unknown> {
    if (closing || closed || !input) throw failure ?? failed();
    if (requestSignal?.aborted) throw failed('cancelled');
    if (pending.size >= 8 || counter >= 2048 || !object(params)) throw new BosunError('invalid', 'Invalid Codex request');
    const requestId = ++counter; let body: string;
    try { body = JSON.stringify({ id: requestId, method, params }) + '\n'; } catch { throw new BosunError('invalid', 'Invalid Codex request'); }
    if (Buffer.byteLength(body) > 262144) throw new BosunError('invalid', 'Codex request too large');
    const response = new Promise<unknown>((resolve, reject) => {
      const cancel = () => stop(failed('cancelled'));
      const timer = setTimeout(() => stop(failed('timeout')), requestTimeout); timer.unref();
      requestSignal?.addEventListener('abort', cancel, { once: true });
      pending.set(requestId, { resolve, reject, dispose() { clearTimeout(timer); requestSignal?.removeEventListener('abort', cancel); } });
      if (requestSignal?.aborted) cancel();
    });
    void input.write(body).catch(() => stop(failed()));
    return response;
  }
  try {
    await attached;
    const initialized = await request('initialize', { clientInfo: { name: 'bosun', version },
      capabilities: { experimentalApi: true, explicitGatewayOauth: true } }, signal);
    const expectedHome = env.CODEX_HOME ?? (env.HOME ? path.join(env.HOME, '.codex') : undefined);
    if (!object(initialized) || initialized.codexHome !== expectedHome || typeof initialized.userAgent !== 'string' || !initialized.userAgent
      || typeof initialized.platformFamily !== 'string' || typeof initialized.platformOs !== 'string') throw failed();
    await input!.write('{"method":"initialized"}\n');
    return { close,
      request(method, params, requestSignal) {
        if (!METHODS.has(method)) return Promise.reject(new BosunError('unsupported', 'Codex method unsupported'));
        return request(method, params, requestSignal);
      },
    };
  } catch (error) {
    await close(); throw error instanceof BosunError ? error : failed();
  }
}
