import path from 'node:path';
import { constants } from 'node:os';
import { BosunError } from '../../../core/errors.ts';
import type { Env } from '../../../core/domain/inference.ts';
import { sameNativeMajor } from '../../../core/domain/host-version.ts';
import { requirePublicInput } from '../../../core/policy.ts';
import { screenPublicText } from '../../../core/secret-screen.ts';
import { streamProcess, type ProcessInput } from '../../../platform/process.ts';
import { createClaudeRunner, CLAUDE_VERSION } from './runner.ts';

export type ClaudeReadMethod = 'get_settings' | 'get_hooks_listing' | 'get_status' | 'export_conversation' | 'get_context_usage';
export type ClaudeConnectionDiagnostic = Readonly<{
  phase: 'version-detection' | 'version-verified' | 'stream-attached' | 'initialize-request'
    | 'initialize-accepted' | 'original-joined' | 'original-join-unknown';
}> | Readonly<{ phase: 'native-exit'; code: number | null; signal: NodeJS.Signals | null }>;
export type ClaudeStreamOptions = {
  env: Env; cwd: string; sessionId: string; model: string; effort?: string; command?: string;
  timeoutMs?: number; requestTimeoutMs?: number; killGraceMs?: number;
  notification?(message: Readonly<Record<string, unknown>>): void;
  // Advisory fixed phases only; observer failures never change native control.
  diagnostic?(message: ClaudeConnectionDiagnostic): void | Promise<void>;
  // Positive original process/group join only, never pump completion by itself.
  closed?(): void;
};
export type ClaudeStreamClient = {
  read(method: ClaudeReadMethod, signal?: AbortSignal): Promise<unknown>;
  append(input: { privacy: 'public'; text: string; uuid: string }, signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
};
type Pending = { resolve(value: unknown): void; reject(error: BosunError): void; dispose(): void };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const failure = (code: 'unavailable' | 'cancelled' | 'timeout' = 'unavailable') => new BosunError(code,
  'Claude stream receipt unavailable', { details: { outcome: 'unknown' } });
const methods = new Set<ClaudeReadMethod>(['get_settings', 'get_hooks_listing', 'get_status', 'export_conversation', 'get_context_usage']);

// Publisher SDK0.3.292 describes this native transport and shouldQuery:false.
// This candidate admits no model turn or tools. Replay is an input receipt,
// never independent transcript retention, effective settings or readiness proof.
// Production managed capabilities remain unverified until native qualification.
export async function connectClaudeStream(options: ClaudeStreamOptions, signal: AbortSignal): Promise<ClaudeStreamClient> {
  if (signal.aborted) throw new BosunError('cancelled', 'Claude connection cancelled');
  if (!path.isAbsolute(options.cwd) || options.cwd.includes('\0') || !uuid(options.sessionId)
    || typeof options.model !== 'string' || !options.model || options.model.startsWith('-')
    || /[\s\0]/.test(options.model) || Buffer.byteLength(options.model) > 200
    || options.effort !== undefined && !['low', 'medium', 'high', 'xhigh', 'max'].includes(options.effort))
    throw new BosunError('invalid', 'Invalid Claude stream selection');
  const timeout = options.requestTimeoutMs ?? 10000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60000)
    throw new BosunError('invalid', 'Invalid Claude stream deadline');
  const diagnostic = (message: ClaudeConnectionDiagnostic) => {
    try { void Promise.resolve(options.diagnostic?.(Object.freeze(message))).catch(() => {}); }
    catch { /* Advisory observers cannot authorize, stop or retry native work. */ }
  };
  const env: Record<string, string | undefined> = { ...options.env, BOSUN_DEPTH: '1', BOSUN_CALLER: 'model',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  // Managed sessions require independently retained JSONL. The session guide
  // identifies this variable as transcript suppression; remove inheritance,
  // rather than relying on a native interpretation of the string "0".
  // https://code.claude.com/docs/en/agent-sdk/sessions
  delete env.CLAUDE_CODE_SKIP_PROMPT_HISTORY;
  delete env.CLAUDECODE; delete env.CLAUDE_EFFORT; delete env.CLAUDE_CODE_MESSAGING_SOCKET;
  diagnostic({ phase: 'version-detection' });
  const detected = await createClaudeRunner({ env, command: options.command }).detect(env);
  if (!detected.installed) throw new BosunError('unavailable', 'Claude executable unavailable');
  if (!sameNativeMajor(detected.version, CLAUDE_VERSION)) throw new BosunError('unverified', 'Claude version unverified');
  diagnostic({ phase: 'version-verified' });
  if (signal.aborted) throw new BosunError('cancelled', 'Claude connection cancelled');
  const lifetime = new AbortController(), pending = new Map<string, Pending>();
  const appended = new Set<string>();
  let channel: ProcessInput | undefined, stopped = false, joined = false, ended = false, lost: BosunError | undefined;
  let serial = 0, messages = 0;
  let attached!: () => void, attachFailed!: (error: BosunError) => void;
  const attach = new Promise<void>((resolve, reject) => { attached = resolve; attachFailed = reject; });
  const stop = (error: BosunError) => { lost ??= error; stopped = true; lifetime.abort(); };
  const abort = () => stop(failure('cancelled'));
  signal.addEventListener('abort', abort, { once: true });
  const args = ['-p', '--restricted', '--safe-mode', '--no-chrome', '--await-initialize',
    '--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json', '--replay-user-messages',
    '--session-id', options.sessionId, '--model', options.model,
    '--tools', '', '--disallowedTools', 'mcp__*', '--permission-mode', 'dontAsk',
    '--permission-prompt-tool', 'stdio', '--permission-prompts', 'none',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '',
    '--settings', JSON.stringify({ disableAllHooks: true, fallbackModel: [], switchModelsOnFlag: false })];
  if (options.effort) args.push('--effort', options.effort);
  const pump = (async () => {
    try {
      for await (const event of streamProcess({ command: detected.path!, args, cwd: options.cwd, env,
        signal: lifetime.signal, timeoutMs: options.timeoutMs, killGraceMs: options.killGraceMs,
        maxOutputBytes: 4194304, maxLineBytes: 262144,
        stdin(input) { channel = input; diagnostic({ phase: 'stream-attached' }); attached(); },
        onClosed() { joined = true; } })) {
        if (event.t === 'exit') {
          diagnostic({ phase: 'native-exit',
            code: event.code !== null && Number.isSafeInteger(event.code) && event.code >= -2147483648 && event.code <= 2147483647 ? event.code : null,
            signal: event.signal !== null && Object.hasOwn(constants.signals, event.signal) ? event.signal : null });
          if (!stopped) throw failure(); continue;
        }
        if (++messages > 4096) throw failure();
        const row: unknown = JSON.parse(event.text);
        if (!object(row)) throw failure();
        if (row.type === 'control_request') {
          if (!id(row.request_id) || !object(row.request)) throw failure();
          const response = row.request.subtype === 'can_use_tool'
            ? { subtype: 'success', request_id: row.request_id, response: { behavior: 'deny', message: 'Bootstrap tools unavailable' } }
            : { subtype: 'error', request_id: row.request_id, error: 'Client operation unavailable' };
          await channel!.write(JSON.stringify({ type: 'control_response', response }) + '\n');
        } else if (row.type === 'control_response') {
          if (!object(row.response) || !id(row.response.request_id)) throw failure();
          const response = row.response, waiting = pending.get(response.request_id as string);
          if (!waiting || !['success', 'error'].includes(response.subtype as string)) throw failure();
          if (response.subtype === 'error') stop(failure());
          else {
            pending.delete(response.request_id as string); waiting.dispose(); waiting.resolve(response.response);
          }
        } else if (row.type === 'user') {
          if (row.session_id !== options.sessionId || row.isReplay !== true || !uuid(row.uuid)) throw failure();
          const waiting = pending.get('user_' + row.uuid);
          if (!waiting) throw failure();
          pending.delete('user_' + row.uuid); waiting.dispose(); waiting.resolve(row);
        } else if (row.type === 'system') {
          if (row.session_id !== options.sessionId || !['init', 'status', 'session_state_changed'].includes(row.subtype as string)
            || row.subtype === 'status' && row.status !== null
            || row.subtype === 'session_state_changed' && !['idle', 'running', 'requires_action'].includes(row.state as string)) throw failure();
          options.notification?.(row);
        } else throw failure(); // No assistant, tool, task, result or extra user work in bootstrap.
      }
    } catch { lost ??= failure(); }
    finally {
      ended = true; stopped = true; signal.removeEventListener('abort', abort);
      const error = lost ?? failure('cancelled'); attachFailed(error);
      for (const operation of pending.values()) { operation.dispose(); operation.reject(error); }
      pending.clear();
      diagnostic({ phase: joined ? 'original-joined' : 'original-join-unknown' });
      if (joined) try { options.closed?.(); } catch { /* Join is independently established. */ }
    }
  })();
  const close = async () => { if (!ended) { stopped = true; lifetime.abort(); } await pump; if (!joined) throw failure(); };
  function wait(key: string, body: Record<string, unknown>, requestSignal?: AbortSignal): Promise<unknown> {
    if (stopped || ended || !channel) return Promise.reject(lost ?? failure());
    if (requestSignal?.aborted) return Promise.reject(failure('cancelled'));
    if (pending.size >= 8 || serial >= 2048 || pending.has(key)) return Promise.reject(failure());
    const response = new Promise<unknown>((resolve, reject) => {
      const cancel = () => stop(failure('cancelled'));
      const timer = setTimeout(() => stop(failure('timeout')), timeout); timer.unref();
      requestSignal?.addEventListener('abort', cancel, { once: true });
      pending.set(key, { resolve, reject, dispose() { clearTimeout(timer); requestSignal?.removeEventListener('abort', cancel); } });
      if (requestSignal?.aborted) cancel();
    });
    void channel.write(JSON.stringify(body) + '\n').catch(() => stop(failure()));
    return response;
  }
  const request = (subtype: string, requestSignal?: AbortSignal) => {
    const requestId = 'bosun_' + ++serial;
    return wait(requestId, { type: 'control_request', request_id: requestId,
      request: { subtype, ...(subtype === 'initialize' ? { hooks: {}, sdkMcpServers: [], agents: {}, skills: [], plugins: [], title: 'Bosun managed bootstrap', promptSuggestions: false }
        : subtype === 'get_context_usage' ? { detail: 'summary' } : {}) } }, requestSignal);
  };
  try {
    await attach;
    diagnostic({ phase: 'initialize-request' });
    const initialized = await request('initialize', signal);
    if (!object(initialized) || !Array.isArray(initialized.commands) || !Array.isArray(initialized.agents)
      || !Array.isArray(initialized.models) || !object(initialized.account)) throw failure();
    diagnostic({ phase: 'initialize-accepted' });
    return {
      close,
      read(method, requestSignal) {
        if (!methods.has(method)) return Promise.reject(new BosunError('unsupported', 'Claude stream read unavailable'));
        return request(method, requestSignal);
      },
      async append(input, requestSignal) {
        requirePublicInput(input);
        if (!uuid(input.uuid) || appended.has(input.uuid) || appended.size >= 64
          || typeof input.text !== 'string' || !input.text.trim() || input.text.includes('\0') || Buffer.byteLength(input.text) > 16384)
          throw new BosunError('invalid', 'Invalid Claude bootstrap input');
        screenPublicText(input.text);
        appended.add(input.uuid);
        const replay = await wait('user_' + input.uuid, { type: 'user', uuid: input.uuid, session_id: options.sessionId,
          parent_tool_use_id: null, shouldQuery: false, client_composed: true,
          message: { role: 'user', content: input.text } }, requestSignal);
        const content = object(replay) && object(replay.message) ? replay.message.content : undefined;
        const matches = content === input.text || Array.isArray(content) && content.length === 1
          && object(content[0]) && content[0].type === 'text' && content[0].text === input.text;
        if (!object(replay) || !object(replay.message) || replay.message.role !== 'user'
          || !matches || replay.parent_tool_use_id !== null
          || replay.shouldQuery !== false) { await close(); throw failure(); }
      },
    };
  } catch (error) { await close(); throw error instanceof BosunError ? error : failure(); }
}
