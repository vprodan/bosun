// Legacy owner composition. The actual writable adapter and SQL helpers live in src.
import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { P, type Cfg } from '../config.ts';
import { record } from '../metrics.ts';
import { RemoteStore } from './remote.ts';
import { contentHash, ftsQuery, openLocalSqlite, plainSession, type SqliteSession } from './sqlite.ts';
import type { Ctx, Found, Memory, MemoryApi, MemoryEvent, Query } from './types.ts';
import { check, QUERY } from '../../src/contracts/memory.ts';
import { SqliteMemoryStore, type MemoryDependencies } from '../../src/adapters/memory/sqlite-store.ts';
export { FIELDS, PATCH, cleanTags } from '../../src/contracts/memory.ts';

// Ambient settings/time/telemetry are bound only here, never inside the adapter. Reopen to change retention.
export function memoryDependencies(cfg: Cfg): MemoryDependencies {
  return {
    now: () => Date.now(), retention: { sessionTtlDays: Number(cfg.MEMORY_SESSION_TTL_DAYS), purgeAfterDays: Number(cfg.MEMORY_PURGE_AFTER_DAYS) },
    id: (now) => `m_${now.toString(32).padStart(9, '0')}${crypto.randomBytes(4).toString('hex')}`, hash: contentHash,
    monotonic: () => performance.now(), measure: record,
  };
}

export class MemoryService extends SqliteMemoryStore {
  cfg: Cfg;
  constructor(db: DatabaseSync | SqliteSession, cfg: Cfg) {
    super('transaction' in db ? db : plainSession(db), memoryDependencies(cfg));
    this.cfg = cfg;
    try { this.expire(); } catch (e) { try { this.close(); } catch {} throw e; }
  }
  // Explicit compatibility maintenance until daemon callers/scheduling migrate. These reads remain writable.
  override search(q: Query, ctx: Ctx): Promise<Found[]> {
    return this.measure('memory.search', () => {
      check(QUERY, q);
      this.expire();
      const rows = this.readSearch(q, ctx, false);
      if (q.text && ftsQuery(q.text) && rows.length && q.touch !== false) {
        try { this.touch(rows.map((r) => r.id)); } catch { /* a busy database must not fail a read */ }
      }
      return rows;
    }, (r) => ({ n: r.length }));
  }
  override get(id: string, ctx: Ctx, opts: { events?: boolean } = {}): Promise<Memory & { events?: MemoryEvent[] }> {
    return this.measure('memory.get', () => { this.expire(); return this.readGet(id, ctx, opts); });
  }
}

// The memory store for this machine's config: a memory server when MEMORY_URL is set, else local SQLite.
export function openMemory(cfg: Cfg, timeoutMs?: number): MemoryApi {
  return cfg.MEMORY_URL ? new RemoteStore(cfg, timeoutMs) : openLocalMemory(cfg);
}
// Authoritative serve always uses local storage, even when the owner's client has MEMORY_URL configured.
export function openLocalMemory(cfg: Cfg, file = P.DB): MemoryService { return new MemoryService(openLocalSqlite(file, cfg), cfg); }
