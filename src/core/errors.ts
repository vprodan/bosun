export type BosunErrorCode = 'invalid' | 'not_found' | 'conflict' | 'unavailable' | 'internal'
  | 'timeout' | 'cancelled' | 'unsupported' | 'unverified' | 'private_input';
export type ErrorDetails = { currentVersion?: number; outcome?: 'unknown' };
const EXITS: Record<BosunErrorCode, number> = {
  invalid: 2, not_found: 1, conflict: 3, unavailable: 1, internal: 1,
  timeout: 124, cancelled: 130, unsupported: 1, unverified: 1, private_input: 1,
};
export const BOSUN_ERROR_CODES: readonly BosunErrorCode[] = Object.freeze(Object.keys(EXITS) as BosunErrorCode[]);
export const isBosunErrorCode = (value: unknown): value is BosunErrorCode => typeof value === 'string' && Object.hasOwn(EXITS, value);

// The legacy (message, exitCode) overload keeps lib/util callers compatible.
export class BosunError extends Error {
  code: BosunErrorCode;
  exitCode: number;
  details?: ErrorDetails;
  constructor(message: string, exitCode?: number);
  constructor(code: BosunErrorCode, message: string, options?: ErrorOptions & { details?: ErrorDetails });
  constructor(first: string, second: string | number = 1, options?: ErrorOptions & { details?: ErrorDetails }) {
    super(typeof second === 'string' ? second : first, options);
    this.code = typeof second === 'string' ? isBosunErrorCode(first) ? first : 'internal' : second === 2 ? 'invalid' : 'internal';
    this.exitCode = typeof second === 'number' ? second : EXITS[this.code];
    if (options?.details) {
      this.details = {
        currentVersion: Number.isSafeInteger(options.details.currentVersion) && Number(options.details.currentVersion) >= 0 ? options.details.currentVersion : undefined,
        outcome: options.details.outcome === 'unknown' ? 'unknown' : undefined,
      };
    }
  }
}

export type MemoryErrorCode = 'not_found' | 'conflict' | 'invalid' | 'unavailable';
// Model transports cannot trust messages or version details from a storage/provider error.
const MODEL_MEMORY_ERRORS: Record<MemoryErrorCode, string> = {
  not_found: 'memory not found', conflict: 'memory version conflict',
  invalid: 'invalid memory request', unavailable: 'memory unavailable',
};
export function modelMemoryError(error: unknown): { code: MemoryErrorCode; message: string } {
  let code: MemoryErrorCode = 'unavailable';
  try {
    const candidate = (error as { code?: unknown } | null)?.code;
    if (typeof candidate === 'string' && Object.hasOwn(MODEL_MEMORY_ERRORS, candidate)) code = candidate as MemoryErrorCode;
  } catch { /* untrusted getters fail closed */ }
  return { code, message: MODEL_MEMORY_ERRORS[code] };
}
// Preserve this constructor/class identity and legacy codes until transport migration.
export class MemoryError extends Error {
  code: MemoryErrorCode;
  current?: number;
  constructor(code: MemoryErrorCode, message: string, current?: number) {
    super(message); this.code = ['not_found', 'conflict', 'invalid', 'unavailable'].includes(code) ? code : 'unavailable'; this.current = current;
  }
}
