import type { Ctx, Found, Memory, MemoryEvent, Patch, Query, StoreInput } from '../domain/memory.ts';

// Preserve the current store surface; health remains optional until local/remote adapters migrate.
export interface MemoryStore {
  store(input: StoreInput, ctx: Ctx): Promise<{ memory: Memory; duplicate: boolean }>;
  search(q: Query, ctx: Ctx): Promise<Found[]>;
  get(id: string, ctx: Ctx, opts?: { events?: boolean }): Promise<Memory & { events?: MemoryEvent[] }>;
  update(id: string, patch: Patch, expectedVersion: number, ctx: Ctx): Promise<Memory>;
  delete(id: string, ctx: Ctx): Promise<Memory>;
  accept(id: string, ctx: Ctx): Promise<Memory>;
  reject(id: string, ctx: Ctx): Promise<Memory>;
  health?(): Promise<{ version: string; schema: number }>;
  close(): void;
}
export type MemoryApi = MemoryStore;
// The implemented local model reader is a read subset of this port, not another port or fake writer.
export type MemoryReader = Pick<MemoryStore, 'search' | 'get' | 'close'>;
