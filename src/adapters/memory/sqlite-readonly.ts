// Qualified rollback-journal reader. Current mutable WAL primaries are held, never opened immutable.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CATEGORIES, type Ctx, type Found, type Memory, type Query } from '../../core/domain/memory.ts';
import { MemoryError } from '../../core/errors.ts';
import type { MemoryReader } from '../../core/ports/memory.ts';
import { ftsQuery } from '../../core/text.ts';

const MAX_BYTES = 16 * 1024 * 1024;
const BUDGET_MS = 250;
const COLUMNS = 'seq id category project_id session_id title body tags status shared private source source_ref hash created_at updated_at expires_at accessed_at access_count version'.split(' ');
const READ = `((m.category = 'personal' AND m.project_id IS NULL) OR (m.category IN ('project','session') AND typeof(m.project_id) = 'text'
    AND (m.project_id = :pid OR m.shared = 1 OR m.project_id IN (SELECT value FROM json_each(:linked)))))
  AND typeof(m.private) = 'integer' AND m.private = 0 AND m.status = 'active'
  AND (m.expires_at IS NULL OR (typeof(m.expires_at) = 'integer' AND m.expires_at > :now))
  AND (:permanent=0 OR m.expires_at IS NULL)`;
type Row = Record<string, any>;
type Reason = 'path' | 'missing' | 'size' | 'format' | 'wal_requires_writes' | 'journal_pending' | 'schema' | 'storage' | 'deadline' | 'closed';
function unavailable(reason: Reason): never { throw new MemoryError('unavailable', `local memory unavailable (${reason})`); }
function invalid(): never { throw new MemoryError('invalid', 'invalid read-only memory request'); }
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const timestamp = (v: unknown): boolean => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 8_640_000_000_000_000;

export class SqliteReadOnly implements MemoryReader {
  #db: DatabaseSync | null = null;
  #now: () => number;
  #nonExpiringOnly: boolean;
  constructor(file: string, now: () => number, options: { nonExpiringOnly?: boolean } = {}) {
    this.#now = now;
    if (typeof now !== 'function' || options.nonExpiringOnly !== undefined && typeof options.nonExpiringOnly !== 'boolean') invalid();
    this.#nonExpiringOnly = options.nonExpiringOnly ?? false;
    const started = this.time();
    try {
      if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0') || path.resolve(file) !== file) unavailable('path');
      if (!fs.existsSync(file)) unavailable('missing');
      if (fs.realpathSync(file) !== file || !fs.statSync(file).isFile()) unavailable('path');
      const size = fs.statSync(file).size;
      if (size < 100 || size > MAX_BYTES) unavailable('size');
      const header = Buffer.alloc(100);
      const fd = fs.openSync(file, 'r');
      try { if (fs.readSync(fd, header, 0, 100, 0) !== 100) unavailable('format'); } finally { fs.closeSync(fd); }
      if (header.toString('ascii', 0, 16) !== 'SQLite format 3\0') unavailable('format');
      if (header[18] === 2 || header[19] === 2) unavailable('wal_requires_writes');
      if (header[18] !== 1 || header[19] !== 1) unavailable('format');
      if (['-journal', '-wal', '-shm'].some((suffix) => present(file + suffix))) unavailable('journal_pending');
      this.#db = new DatabaseSync(file, { readOnly: true, allowExtension: false, defensive: true, enableDoubleQuotedStringLiterals: false });
      // Exclusive connection mode is the measured zero-write backstop if journal state races the preflight.
      this.#db.exec('PRAGMA query_only=ON; PRAGMA temp_store=MEMORY; PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE;');
      this.read(() => {
        // An owned floor with an absent/invalid public view must never downgrade to primary rows.
        if (this.#db!.prepare("SELECT 1 FROM sqlite_master WHERE name LIKE 'bosun_%' LIMIT 1").get()) unavailable('schema');
        const versions = this.#db!.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Row[];
        if (versions.length !== 1 || versions[0].version !== 1) unavailable('schema');
        const columns = this.#db!.prepare("SELECT name FROM pragma_table_info('memories')").all() as Row[];
        if (columns.length !== COLUMNS.length || columns.some((row, i) => row.name !== COLUMNS[i])) unavailable('schema');
        const objects = this.#db!.prepare("SELECT name,type,sql FROM sqlite_master WHERE name IN ('memories','memory_events','memories_fts')").all() as Row[];
        if (objects.length !== 3 || objects.some((row) => row.type !== 'table')
          || !objects.some((row) => row.name === 'memories_fts' && /\bUSING\s+fts5\s*\(/i.test(row.sql)
            && /\bcontent\s*=\s*['"]memories['"]/i.test(row.sql) && /\bcontent_rowid\s*=\s*['"]seq['"]/i.test(row.sql))) unavailable('schema');
        for (const [table, expected] of [['memories_fts', ['title', 'body', 'tags']], ['memory_events', ['id', 'memory_id', 'op', 'at', 'source', 'hash_before', 'hash_after']]] as const) {
          const actual = this.#db!.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as Row[];
          if (actual.length !== expected.length || actual.some((row, i) => row.name !== expected[i])) unavailable('schema');
        }
      });
      this.deadline(started);
    } catch (e) {
      this.close();
      if (e instanceof MemoryError) throw e;
      unavailable('storage');
    }
  }
  private time(): number {
    let value: unknown;
    try { value = this.#now(); } catch { invalid(); }
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) invalid();
    return value;
  }
  private deadline(started: number): void { const elapsed = this.time() - started; if (elapsed < 0 || elapsed > BUDGET_MS) unavailable('deadline'); }
  private read<T>(fn: () => T): T {
    if (!this.#db) unavailable('closed');
    const started = this.time();
    let transaction = false;
    try {
      this.#db.exec('BEGIN'); transaction = true;
      const result = fn();
      this.#db.exec('ROLLBACK'); transaction = false;
      this.deadline(started);
      return result;
    } catch (e) {
      if (transaction) try { this.#db.exec('ROLLBACK'); } catch { /* close releases failed reads */ }
      if (e instanceof MemoryError) throw e;
      unavailable('storage');
    }
  }
  private scope(ctx: Ctx): { pid: string | null; linked: string; now: number; permanent: number } {
    if (!ctx || !(ctx.projectId === null || text(ctx.projectId, 64)) || !Array.isArray(ctx.linked) || ctx.linked.length > 50) invalid();
    const linked = Array.from(ctx.linked);
    if (linked.some((id) => !text(id, 64))) invalid();
    return { pid: ctx.projectId, linked: JSON.stringify(linked), now: this.time(), permanent: this.#nonExpiringOnly ? 1 : 0 };
  }
  private memory(row: Row): Memory {
    // SQL excludes non-public records before any content decoding/projection.
    if (row.private !== 0) unavailable('storage');
    const tags: unknown = JSON.parse(row.tags);
    if (!Array.isArray(tags) || tags.length > 12 || tags.some((tag) => typeof tag !== 'string' || !/^[a-z0-9-]{1,40}$/.test(tag)) || !CATEGORIES.includes(row.category)
      || !text(row.id, 64) || !text(row.title, 200) || !text(row.body, 4000) || !text(row.hash, 64)
      || typeof row.source !== 'string' || row.source.length > 200 || row.source_ref !== null && (typeof row.source_ref !== 'string' || row.source_ref.length > 200)
      || row.project_id !== null && !text(row.project_id, 64) || row.session_id !== null && (typeof row.session_id !== 'string' || row.session_id.length > 200)
      || row.shared !== 0 && row.shared !== 1 || !timestamp(row.created_at) || !timestamp(row.updated_at)
      || row.expires_at !== null && !timestamp(row.expires_at) || row.accessed_at !== null && !timestamp(row.accessed_at)
      || !Number.isSafeInteger(row.access_count) || row.access_count < 0 || !Number.isSafeInteger(row.version) || row.version < 1) unavailable('storage');
    return { private: false, id: row.id, category: row.category, projectId: row.project_id, sessionId: row.session_id,
      title: row.title, body: row.body, tags, status: 'active', shared: row.shared === 1, source: row.source, sourceRef: row.source_ref,
      hash: row.hash, createdAt: row.created_at, updatedAt: row.updated_at, expiresAt: row.expires_at,
      accessedAt: row.accessed_at, accessCount: row.access_count, version: row.version };
  }
  async search(q: Query, ctx: Ctx): Promise<Found[]> {
    if (!q || q.text !== undefined && (typeof q.text !== 'string' || q.text.length > 20000)
      || q.category !== undefined && !CATEGORIES.includes(q.category) || q.includePrivate !== undefined && q.includePrivate !== false
      || q.touch !== undefined && q.touch !== false || q.status !== undefined && (!Array.isArray(q.status) || q.status.length > 1 || q.status.some((s) => s !== 'active'))
      || q.limit !== undefined && (!Number.isSafeInteger(q.limit) || q.limit < 1 || q.limit > 50)
      || q.tags !== undefined && (!Array.isArray(q.tags) || q.tags.length > 12 || q.tags.some((tag) => typeof tag !== 'string' || !/^[a-z0-9-]{1,40}$/.test(tag)))) invalid();
    const match = q.text ? ftsQuery(q.text) : '';
    if (q.text?.trim() && !match) return [];
    const params = { ...this.scope(ctx), category: q.category ?? null, tags: q.tags?.length ? JSON.stringify(Array.from(q.tags)) : null, limit: q.limit ?? 10 };
    return this.read(() => {
      const filter = `${READ} AND (:category IS NULL OR m.category = :category)
        AND (:tags IS NULL OR EXISTS (SELECT 1 FROM json_each(m.tags) t WHERE t.value IN (SELECT value FROM json_each(:tags))))`;
      const rows = (match ? this.#db!.prepare(`SELECT m.*, bm25(memories_fts) AS rank FROM memories_fts JOIN memories m ON m.seq = memories_fts.rowid
          WHERE memories_fts MATCH :match AND ${filter} ORDER BY bm25(memories_fts) LIMIT :limit`).all({ ...params, match })
        : this.#db!.prepare(`SELECT m.*, 0 AS rank FROM memories m WHERE ${filter} ORDER BY m.updated_at DESC,m.seq DESC LIMIT :limit`).all(params)) as Row[];
      const counts = match && rows.length ? this.#db!.prepare(`SELECT rowid AS seq,highlight(memories_fts,0,char(1),char(2)) AS t,
        highlight(memories_fts,1,char(1),char(2)) AS b,highlight(memories_fts,2,char(1),char(2)) AS g
        FROM memories_fts WHERE memories_fts MATCH :match AND rowid IN (SELECT value FROM json_each(:seqs))`)
        .all({ match, seqs: JSON.stringify(rows.map((row) => row.seq)) }) as Row[] : [];
      const words = (s: string) => [...s.matchAll(/\u0001([^\u0002]*)\u0002/g)].map((m) => m[1].toLowerCase());
      const matched = new Map(counts.map((row) => [row.seq, new Set([...words(row.t), ...words(row.b), ...words(row.g)]).size]));
      return rows.map((row) => ({ ...this.memory(row), rank: row.rank, ...(match ? { matched: matched.get(row.seq) ?? 0 } : {}) }));
    });
  }
  async get(id: string, ctx: Ctx, opts: { events?: boolean } = {}): Promise<Memory> {
    // Audit fields may describe an earlier private version. Only the owner writer API exposes history.
    if (!text(id, 64) || opts.events !== undefined && opts.events !== false) invalid();
    const params = { id, ...this.scope(ctx) };
    return this.read(() => {
      const row = this.#db!.prepare(`SELECT m.* FROM memories m WHERE m.id = :id AND ${READ}`).get(params) as Row | undefined;
      if (!row) throw new MemoryError('not_found', 'memory not found');
      return this.memory(row);
    });
  }
  close(): void { const db = this.#db; this.#db = null; db?.close(); }
}

function present(file: string): boolean {
  try { fs.lstatSync(file); return true; }
  catch (e) { if ((e as { code?: unknown })?.code === 'ENOENT') return false; throw e; }
}
