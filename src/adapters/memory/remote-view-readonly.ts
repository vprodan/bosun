import fs from 'node:fs';
import { SqliteDatabase } from '../../platform/sqlite.ts'
import type { Ctx, Found, Memory, Query } from '../../core/domain/memory.ts';
import { MemoryError } from '../../core/errors.ts';
import { parseRemoteView, type RemoteViewSnapshot } from '../../core/remote-view.ts';
import { terms } from '../../core/text.ts';
import { contentHash } from '../../platform/content-hash.ts';
import { checkRemoteViewFile } from './remote-view-file.ts';
import { REMOTE_VIEW_SQL, type RemoteViewBinding } from './remote-view-protocol.ts';

// Read transaction survives packing and stdout acceptance, so HOLD cannot commit prematurely.
export class RemoteViewReadOnly {
  #db: SqliteDatabase | undefined;
  #snapshot!: RemoteViewSnapshot;
  #file: string;
  #identity: { dev: number; ino: number };
  #now: () => number;
  #at = 0;
  #expires = 0;
  #last = 0;
  constructor(
    file: string,
    binding: RemoteViewBinding,
    ctx: Pick<Ctx, 'projectId' | 'sessionId'>,
    now: () => number = Date.now,
  ) {
    this.#file = file;
    this.#now = now;
    this.#identity = checkRemoteViewFile(file);
    try {
      const db = (this.#db = new SqliteDatabase(file, {
        readOnly: true,
        allowExtension: false,
        defensive: true,
        enableDoubleQuotedStringLiterals: false,
      }));
      db.exec(
        'PRAGMA query_only=ON;PRAGMA temp_store=MEMORY;PRAGMA busy_timeout=0;PRAGMA locking_mode=EXCLUSIVE;BEGIN;',
      );
      const objects = db
        .prepare("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
        .all();
      if (
        objects.length !== 1 ||
        objects[0].name !== 'remote_view' ||
        objects[0].sql !== REMOTE_VIEW_SQL
      )
        throw 0;
      const row = db.prepare("SELECT * FROM remote_view WHERE singleton=1 AND state='ready'").get();
      if (!row) throw 0;
      const intent = JSON.parse(String(row.intent));
      if (
        Object.keys(intent).length !== 7 ||
        Object.entries(binding).some(([key, value]) => intent[key] !== value) ||
        intent.projectId !== ctx.projectId ||
        intent.sessionId !== ctx.sessionId
      )
        throw 0;
      const snapshot = (this.#snapshot = parseRemoteView(
        JSON.parse(String(row.snapshot)),
        contentHash,
      ));
      if (
        snapshot.id !== intent.id ||
        snapshot.clientId !== binding.clientId ||
        snapshot.authorityId !== binding.authorityId ||
        snapshot.projectId !== ctx.projectId ||
        snapshot.sessionId !== ctx.sessionId
      )
        throw 0;
      this.#at = Number(row.cached_at);
      this.#expires = Number(row.expires_at);
      if (
        !Number.isSafeInteger(this.#at) ||
        !Number.isSafeInteger(this.#expires) ||
        this.#expires - this.#at < 1000 ||
        this.#expires - this.#at > 3600000
      )
        throw 0;
      this.#last = this.#at;
      this.validate();
    } catch {
      this.close();
      throw new MemoryError('unavailable', 'Remote view unavailable');
    }
  }
  validate() {
    const now = this.#now(),
      stat = fs.lstatSync(this.#file);
    if (
      !this.#db ||
      !Number.isSafeInteger(now) ||
      now < this.#last ||
      now >= this.#expires ||
      stat.dev !== this.#identity.dev ||
      stat.ino !== this.#identity.ino ||
      stat.nlink !== 1 ||
      (stat.mode & 0o7777) !== 0o600
    )
      throw new MemoryError('unavailable', 'Remote view unavailable');
    this.#last = now;
  }
  #scope(ctx: Ctx) {
    this.validate();
    if (ctx.projectId !== this.#snapshot.projectId || ctx.sessionId !== this.#snapshot.sessionId)
      throw new MemoryError('unavailable', 'Remote view scope differs');
  }
  async search(query: Query, ctx: Ctx): Promise<Found[]> {
    this.#scope(ctx);
    if (
      query.includePrivate ||
      query.touch ||
      query.status?.some((status) => status !== 'active') ||
      (query.limit !== undefined &&
        (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 50))
    )
      throw new MemoryError('invalid', 'Invalid remote view query');
    const wanted = terms(query.text ?? '');
    return this.#snapshot.rows
      .flatMap((row) => {
        if (
          (query.category && query.category !== row.category) ||
          (query.tags?.length && !query.tags.some((tag) => row.tags.includes(tag)))
        )
          return [];
        const corpus = new Set(terms(`${row.title} ${row.body} ${row.tags.join(' ')}`, 4096)),
          matched = wanted.filter((term) => corpus.has(term)).length;
        if (wanted.length && !matched) return [];
        return [{ ...row, tags: [...row.tags], rank: 0, matched }];
      })
      .sort(
        (a, b) => b.matched - a.matched || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id),
      )
      .slice(0, query.limit ?? 10);
  }
  async get(id: string, ctx: Ctx, options: { events?: boolean } = {}): Promise<Memory> {
    this.#scope(ctx);
    if (options.events) throw new MemoryError('invalid', 'Audit unavailable');
    const row = this.#snapshot.rows.find((row) => row.id === id);
    if (!row) throw new MemoryError('not_found', 'memory not found');
    return { ...row, tags: [...row.tags] };
  }
  close() {
    const db = this.#db;
    this.#db = undefined;
    try {
      if (db?.isTransaction) db.exec('ROLLBACK');
    } finally {
      db?.close();
    }
  }
}
