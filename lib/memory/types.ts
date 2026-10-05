// Compatibility exports: definitions and class identity now live in the pure core.
export * from '../../src/core/domain/memory.ts';
export type { Source, Hit } from '../../src/core/domain/context.ts';
export { MemoryError } from '../../src/core/errors.ts';
export type { MemoryErrorCode as ErrorCode } from '../../src/core/errors.ts';
export type { MemoryApi, MemoryReader } from '../../src/core/ports/memory.ts';
export type { MemoryProvider } from '../../src/core/ports/context-source.ts';
