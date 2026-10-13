import { BosunError, MemoryError, isBosunErrorCode, type BosunErrorCode, type ErrorDetails } from '../core/errors.ts';

export const RPC_VERSION = 1;
export const RPC_LIMITS = Object.freeze({ requestBytes: 262144, responseBytes: 1048576, timeoutMs: 10000 });
export type RpcScope = { workspace: string; sessionId: string | null; audience: 'owner' | 'model' };
export type RpcRequest = { version: 1; id: string; method: string; params: Record<string, unknown>; scope?: RpcScope };
export type RpcError = { code: BosunErrorCode; message: string; details?: ErrorDetails };
export type RpcResponse<T = unknown> = { version: 1; id: string; ok: true; result: T }
  | { version: 1; id: string; ok: false; error: RpcError };
const MESSAGES: Record<BosunErrorCode, string> = {
  invalid: 'Invalid request', not_found: 'Requested item not found', conflict: 'Request conflicts with current state',
  unavailable: 'Service unavailable', internal: 'Request failed', timeout: 'Request timed out', cancelled: 'Request cancelled',
  unsupported: 'Operation unsupported', unverified: 'Capability unverified', private_input: 'Input is not permitted for inference',
};
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
export function rpcRequest(value: unknown): RpcRequest {
  if (!record(value) || value.version !== RPC_VERSION || !identifier(value.id)
    || typeof value.method !== 'string' || !/^[a-z][a-zA-Z0-9.]{0,79}$/.test(value.method)
    || !record(value.params) || Object.keys(value).some(key => !['version', 'id', 'method', 'params', 'scope'].includes(key))) {
    throw new BosunError('invalid', MESSAGES.invalid);
  }
  let scope: RpcScope | undefined;
  if (value.scope !== undefined) {
    const input = value.scope;
    if (!record(input) || typeof input.workspace !== 'string' || !input.workspace.startsWith('/') || input.workspace.length > 4096 || input.workspace.includes('\0')
      || input.sessionId !== null && (typeof input.sessionId !== 'string' || !input.sessionId || input.sessionId.length > 200 || input.sessionId.includes('\0'))
      || !['owner', 'model'].includes(input.audience as string) || Object.keys(input).some(key => !['workspace', 'sessionId', 'audience'].includes(key))) throw new BosunError('invalid', MESSAGES.invalid);
    scope = { workspace: input.workspace, sessionId: input.sessionId as string | null, audience: input.audience as 'owner' | 'model' };
  }
  return { version: 1, id: value.id, method: value.method, params: value.params, ...(scope ? { scope } : {}) };
}
// Provider/storage exception messages are never a transport contract or a log payload.
export function rpcError(error: unknown): RpcError {
  let code: BosunErrorCode = 'internal'; let details: ErrorDetails | undefined;
  try {
    if (error instanceof BosunError) {
      code = error.code;
      if (error.details?.outcome === 'unknown') details = { outcome: 'unknown' };
      if (Number.isSafeInteger(error.details?.currentVersion) && Number(error.details?.currentVersion) >= 0) {
        details = { ...details, currentVersion: error.details!.currentVersion };
      }
    } else if (error instanceof MemoryError) {
      code = error.code;
    }
  } catch { code = 'internal'; details = undefined; }
  if (!isBosunErrorCode(code)) code = 'internal';
  return { code, message: MESSAGES[code], ...(details ? { details } : {}) };
}
export function rpcResponse<T = unknown>(value: unknown, id: string): RpcResponse<T> {
  if (!record(value) || value.version !== 1 || value.id !== id || typeof value.ok !== 'boolean') throw new BosunError('unavailable', MESSAGES.unavailable);
  if (value.ok === true && Object.hasOwn(value, 'result') && Object.keys(value).every(key => ['version', 'id', 'ok', 'result'].includes(key))) {
    return { version: 1, id, ok: true, result: value.result as T };
  }
  if (value.ok === false && record(value.error) && isBosunErrorCode(value.error.code)
    && Object.keys(value).every(key => ['version', 'id', 'ok', 'error'].includes(key))) {
    const error = value.error;
    // Normalize even a malformed/untrusted server reply to the finite vocabulary.
    const normalized = rpcError(new BosunError(error.code as BosunErrorCode, '', { details: record(error.details) ? error.details as ErrorDetails : undefined }));
    return { version: 1, id, ok: false, error: normalized };
  }
  throw new BosunError('unavailable', MESSAGES.unavailable);
}
