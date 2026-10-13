// Actual writable MemoryStore adapter. Dependencies are explicit; queries never perform maintenance.
import type { SqliteDatabase } from '../../platform/sqlite.ts'
import type { MemoryStore } from '../../core/ports/memory.ts';
import type {
  Ctx,
  Found,
  Memory,
  MemoryEvent,
  Patch,
  Query,
  StoreInput,
} from '../../core/domain/memory.ts';
import { MemoryError } from '../../core/errors.ts';
import { screenPublicText } from '../../core/secret-screen.ts';
import { check, ID, STORE, PATCH, QUERY, VERSION_NO } from '../../contracts/memory.ts';
import {
  bySeq,
  queryGet,
  querySearch,
  queryStats,
  toMemory,
  writableRow,
  MAX_DATE_MS,
  type Row,
} from './sqlite-query.ts';
import { DAY, event, expire, touch, prune, type RetentionPolicy } from './sqlite-maintenance.ts';
import type { SqliteSession } from './sqlite-session.ts';

export type MemoryOperation =
  | 'memory.store'
  | 'memory.search'
  | 'memory.get'
  | 'memory.update'
  | 'memory.delete'
  | 'memory.purge';
export type MemoryMeasurement = {
  op: MemoryOperation;
  ms: number;
  ok: boolean;
  n?: number;
  chars?: number;
};
export type MemoryDependencies = {
  now(): number;
  retention: RetentionPolicy;
  id(now: number): string;
  hash(title: string, body: string): string;
  monotonic(): number;
  measure(value: MemoryMeasurement): void;
};
const finite = (n: unknown): number | undefined =>
  typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER
    ? n
    : undefined;

export class SqliteMemoryStore implements MemoryStore {
  #session: SqliteSession;
  #dependencies: Readonly<MemoryDependencies>;
  constructor(session: SqliteSession, dependencies: MemoryDependencies) {
    this.#session = session;
    try {
      const { now, retention, id, hash, monotonic, measure } = dependencies;
      const policy = Object.freeze({
        sessionTtlDays: retention.sessionTtlDays,
        purgeAfterDays: retention.purgeAfterDays,
      });
      if (
        ![now, id, hash, monotonic, measure].every((fn) => typeof fn === 'function') ||
        ![policy.sessionTtlDays, policy.purgeAfterDays].every(
          (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 3650,
        )
      ) {
        throw new MemoryError('invalid', 'invalid memory dependencies');
      }
      this.#dependencies = Object.freeze({ now, retention: policy, id, hash, monotonic, measure });
    } catch (e) {
      try {
        session.close();
      } catch {}
      throw e;
    }
  }
  // Plain legacy callers may retain their handle; registered sessions never expose one.
  get db(): SqliteDatabase {
    if (!this.#session.legacyDb)
      throw new MemoryError('unavailable', 'registered memory database is private');
    return this.#session.legacyDb;
  }
  close(): void {
    this.#session.close();
  }
  protected now(): number {
    return this.timestamp(this.#dependencies.now());
  }
  private timestamp(now: number): number {
    if (!Number.isSafeInteger(now) || now < 0 || now > MAX_DATE_MS)
      throw new MemoryError('unavailable', 'invalid memory clock');
    return now;
  }
  private expiresAt(now: number, ttl: number | null): number | null {
    return ttl ? this.timestamp(now + ttl * DAY) : null;
  }
  private monotonic(): number {
    try {
      return finite(this.#dependencies.monotonic()) ?? 0;
    } catch {
      return 0;
    }
  }
  private hash(title: string, body: string): string {
    const hash = this.#dependencies.hash(title, body);
    if (typeof hash !== 'string' || !/^[a-f0-9]{32}$/.test(hash))
      throw new MemoryError('invalid', 'invalid memory hash');
    return hash;
  }
  protected async measure<T>(
    op: MemoryOperation,
    fn: () => T | Promise<T>,
    size: (r: T) => { n?: number; chars?: number } = () => ({}),
  ): Promise<T> {
    const started = this.monotonic();
    const record = (ok: boolean, result?: T) => {
      // Closed numeric metadata only; failures in telemetry or its clock never change a completed operation.
      try {
        let values: { n?: number; chars?: number } = {};
        if (ok)
          try {
            values = size(result as T);
          } catch {}
        const metric: MemoryMeasurement = { op, ms: finite(this.monotonic() - started) ?? 0, ok };
        const n = finite(values.n);
        const chars = finite(values.chars);
        if (n !== undefined) metric.n = n;
        if (chars !== undefined) metric.chars = chars;
        this.#dependencies.measure(metric);
      } catch {
        /* measurement is best effort */
      }
    };
    try {
      const r = await fn();
      record(true, r);
      return r;
    } catch (e) {
      record(false);
      throw e;
    }
  }

  // These maintenance methods are explicit and intentionally outside the seven-port query methods.
  expire(now = this.now()): number {
    return expire(this.#session, this.timestamp(now));
  }
  touch(ids: string[], now = this.now()): void {
    touch(this.#session, ids, this.timestamp(now));
  }
  prune(now = this.now()): { archived: number; purged: number } {
    return prune(this.#session, this.timestamp(now), this.#dependencies.retention);
  }
  counts(): Record<string, number> {
    return this.#session.read((db) =>
      Object.fromEntries(
        (
          db.prepare('SELECT status, COUNT(*) AS n FROM memories GROUP BY status').all() as Row[]
        ).map((r) => [r.status, r.n]),
      ),
    );
  }
  stats(ctx: Ctx) {
    if (ctx.audience !== 'owner') throw new MemoryError('invalid', 'owner memory stats required');
    return this.#session.read((db) => queryStats(db, ctx));
  }
  protected readSearch(q: Query, ctx: Ctx, excludeExpired = true): Found[] {
    check(QUERY, q);
    const now = excludeExpired ? this.now() : 0;
    return this.#session.read((db) => querySearch(db, q, ctx, now, excludeExpired));
  }
  protected readGet(
    id: string,
    ctx: Ctx,
    opts: { events?: boolean } = {},
  ): Memory & { events?: MemoryEvent[] } {
    return this.#session.read((db) => queryGet(db, id, ctx, opts));
  }
  search(q: Query, ctx: Ctx): Promise<Found[]> {
    return this.measure(
      'memory.search',
      () => this.readSearch(q, ctx),
      (r) => ({ n: r.length }),
    );
  }
  searchLexical(q: Query, ctx: Ctx): Promise<Found[]> {
    check(QUERY, q);
    return this.measure(
      'memory.search',
      () => this.#session.read((db) => querySearch(db, q, ctx, this.now(), true, 'lexical')),
      (rows) => ({ n: rows.length }),
    );
  }
  get(
    id: string,
    ctx: Ctx,
    opts: { events?: boolean } = {},
  ): Promise<Memory & { events?: MemoryEvent[] }> {
    return this.measure('memory.get', () => this.readGet(id, ctx, opts));
  }

  store(input: StoreInput, ctx: Ctx) {
    return this.measure(
      'memory.store',
      () => {
        check(STORE, input);
        const title = input.title.trim();
        const body = input.body.trim();
        screenPublicText(title);
        screenPublicText(body);
        screenPublicText(JSON.stringify(input.tags ?? []));
        if (input.source) screenPublicText(input.source);
        if (input.sourceRef) screenPublicText(input.sourceRef);
        const cat = input.category;
        if (cat !== 'personal' && !ctx.projectId)
          throw new MemoryError('invalid', `${cat} memories need a project directory`);
        const projectId = cat === 'personal' ? null : ctx.projectId;
        const hash = this.hash(title, body);
        const now = this.now();
        const ttl =
          input.ttlDays ?? (cat === 'session' ? this.#dependencies.retention.sessionTtlDays : null);
        const expiresAt = this.expiresAt(now, ttl);
        const source = input.source || ctx.source || 'api';
        return this.#session.transaction((db) => {
          const dup = db
            .prepare(
              "SELECT * FROM memories WHERE COALESCE(project_id, '') = ? AND category = ? AND hash = ? AND status <> 'archived'",
            )
            .get(projectId ?? '', cat, hash);
          if (dup) return { memory: toMemory(dup as Row), duplicate: true };
          const id = this.#dependencies.id(now);
          check(ID, id);
          const r = db
            .prepare(`INSERT INTO memories (id, category, project_id, session_id, title, body, tags, status, shared, private, source, source_ref, hash, created_at, updated_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(
              id,
              cat,
              projectId,
              cat === 'session' ? ctx.sessionId : null,
              title,
              body,
              JSON.stringify([...new Set(input.tags || [])]),
              input.status || 'active',
              input.shared ? 1 : 0,
              input.private ? 1 : 0,
              source,
              input.sourceRef ?? null,
              hash,
              now,
              now,
              expiresAt,
            );
          event(db, id, input.status === 'proposed' ? 'propose' : 'store', source, null, hash, now);
          return { memory: bySeq(db, Number(r.lastInsertRowid)), duplicate: false };
        });
      },
      (r) => ({ chars: r.memory.body.length }),
    );
  }

  update(id: string, patch: Patch, expectedVersion: number, ctx: Ctx) {
    return this.measure('memory.update', () => {
      check(PATCH, patch);
      check(VERSION_NO, expectedVersion);
      return this.#session.transaction((db) => {
        const cur = writableRow(db, id, ctx);
        if (cur.version !== expectedVersion)
          throw new MemoryError(
            'conflict',
            `version conflict: current version is ${cur.version}`,
            cur.version,
          );
        const title = patch.title?.trim() ?? cur.title;
        const body = patch.body?.trim() ?? cur.body;
        if (ctx.audience === 'model') {
          try {
            screenPublicText(cur.title);
            screenPublicText(cur.body);
          } catch {
            throw new MemoryError('not_found', 'memory not found');
          }
        }
        if (
          patch.title !== undefined ||
          patch.body !== undefined ||
          (patch.private === false && cur.private === 1)
        ) {
          screenPublicText(title);
          screenPublicText(body);
        }
        if (patch.tags !== undefined) screenPublicText(JSON.stringify(patch.tags));
        const status = patch.status ?? cur.status;
        const hash = this.hash(title, body);
        if (status !== 'archived') {
          const dup = db
            .prepare(
              "SELECT id FROM memories WHERE COALESCE(project_id, '') = ? AND category = ? AND hash = ? AND status <> 'archived' AND seq <> ?",
            )
            .get(cur.project_id ?? '', cur.category, hash, cur.seq) as Row | undefined;
          if (dup) throw new MemoryError('conflict', `duplicate of ${dup.id}`, cur.version);
        }
        const now = this.now();
        let expiresAt = cur.expires_at;
        if (
          patch.status === 'active' &&
          cur.status === 'archived' &&
          cur.category === 'session' &&
          expiresAt !== null
        ) {
          // Historical rows retain a deadline, not their selected TTL. Only expired session restores renew the current default.
          if (!Number.isSafeInteger(expiresAt) || expiresAt < 0 || expiresAt > MAX_DATE_MS)
            throw new MemoryError('unavailable', 'invalid memory expiry');
          if (expiresAt <= now)
            expiresAt = this.expiresAt(now, this.#dependencies.retention.sessionTtlDays);
        }
        db.prepare(
          'UPDATE memories SET title = ?, body = ?, tags = ?, status = ?, private = ?, shared = ?, hash = ?, updated_at = ?, expires_at = ?, version = version + 1 WHERE seq = ?',
        ).run(
          title,
          body,
          patch.tags ? JSON.stringify([...new Set(patch.tags)]) : cur.tags,
          status,
          patch.private === undefined ? cur.private : Number(patch.private),
          patch.shared === undefined ? cur.shared : Number(patch.shared),
          hash,
          now,
          expiresAt,
          cur.seq,
        );
        const op =
          status === cur.status
            ? 'update'
            : status === 'archived'
              ? cur.status === 'proposed'
                ? 'reject'
                : 'archive'
              : cur.status === 'proposed'
                ? 'accept'
                : 'restore';
        event(db, cur.id, op, ctx.source || 'api', cur.hash, hash, now);
        return bySeq(db, cur.seq);
      });
    });
  }

  delete(id: string, ctx: Ctx) {
    return this.measure('memory.delete', () =>
      this.#session.transaction((db) => {
        const cur = writableRow(db, id, ctx);
        if (cur.status !== 'archived') {
          const now = this.now();
          db.prepare(
            "UPDATE memories SET status = 'archived', updated_at = ?, version = version + 1 WHERE seq = ?",
          ).run(now, cur.seq);
          event(db, cur.id, 'archive', ctx.source || 'api', cur.hash, cur.hash, now);
        }
        return bySeq(db, cur.seq);
      }),
    );
  }

  accept(id: string, ctx: Ctx) {
    return this.decide(id, ctx, 'active');
  }
  reject(id: string, ctx: Ctx) {
    return this.decide(id, ctx, 'archived');
  }
  private async decide(id: string, ctx: Ctx, to: 'active' | 'archived'): Promise<Memory> {
    const cur = await this.get(id, ctx);
    if (cur.status !== 'proposed')
      throw new MemoryError('invalid', `not a proposal (status ${cur.status})`);
    return this.update(id, { status: to }, cur.version, ctx);
  }

  // Hard delete, archived memories only. Their events stay: the audit trail outlives the content.
  purge(id: string, ctx: Ctx): Promise<void> {
    return this.measure('memory.purge', () =>
      this.#session.transaction((db) => {
        const cur = writableRow(db, id, ctx);
        if (cur.status !== 'archived')
          throw new MemoryError('invalid', 'only archived memories can be purged: delete it first');
        const now = this.now();
        db.prepare('DELETE FROM memories WHERE seq = ?').run(cur.seq);
        event(db, cur.id, 'purge', ctx.source || 'api', cur.hash, null, now);
      }),
    );
  }
}
