// RemoteStore: the memory API over HTTP (MEMORY_URL), the same interface as the local MemoryService.
// Unreachable or foreign servers become `unavailable`. No offline queue: a write while offline fails visibly.
import type { Cfg } from '../config.ts';
import { record } from '../metrics.ts';
import { MemoryError, type Ctx, type ErrorCode, type Found, type Memory, type MemoryApi, type MemoryEvent, type Patch, type Query, type StoreInput } from './types.ts';

const CODES: ErrorCode[] = ['not_found', 'conflict', 'invalid', 'unavailable'];

export class RemoteStore implements MemoryApi {
  url: string;
  timeoutMs: number;
  token: string;
  constructor(cfg: Cfg, timeoutMs = Number(cfg.REMOTE_TIMEOUT_MS)) {
    this.url = cfg.MEMORY_URL.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
    this.token = cfg.MEMORY_TOKEN || '';
  }
  private async call<T>(route: string, body?: object): Promise<T> {
    const t = performance.now();
    let j: any;
    try {
      const r = await fetch(`${this.url}/v1/${route}`, {
        method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(this.timeoutMs),
        headers: { 'content-type': 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      j = await r.json().catch(() => null);
    } catch {
      throw new MemoryError('unavailable', `memory server unreachable at ${this.url}`);
    } finally { record({ op: `remote.${route}`, ms: performance.now() - t }); }
    if (!j || typeof j !== 'object' || typeof j.ok !== 'boolean') throw new MemoryError('unavailable', `memory server at ${this.url} sent no bosun reply`);
    if (!j.ok) throw new MemoryError(CODES.includes(j.error?.code) ? j.error.code : 'unavailable', String(j.error?.message ?? 'error').slice(0, 300), j.error?.current);
    return j.data as T;
  }
  store(input: StoreInput, ctx: Ctx) { return this.call<{ memory: Memory; duplicate: boolean }>('memory/store', { ctx, input }); }
  search(query: Query, ctx: Ctx) { return this.call<Found[]>('memory/search', { ctx, query }); }
  get(id: string, ctx: Ctx, opts: { events?: boolean } = {}) { return this.call<Memory & { events?: MemoryEvent[] }>('memory/get', { ctx, id, events: !!opts.events }); }
  update(id: string, patch: Patch, expectedVersion: number, ctx: Ctx) { return this.call<Memory>('memory/update', { ctx, id, patch, expectedVersion }); }
  delete(id: string, ctx: Ctx) { return this.call<Memory>('memory/delete', { ctx, id }); }
  accept(id: string, ctx: Ctx) { return this.call<Memory>('memory/accept', { ctx, id }); }
  reject(id: string, ctx: Ctx) { return this.call<Memory>('memory/reject', { ctx, id }); }
  health() { return this.call<{ version: string; schema: number; memory: boolean }>('health'); }
  close(): void { /* nothing held */ }
}
