// Owned public rollback view only. The mutable WAL primary is never opened through SQLite; owner backups stay unread.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { CATEGORIES, type Ctx, type Found, type Memory, type Query } from '../../core/domain/memory.ts';
import { MemoryError } from '../../core/errors.ts';
import type { MemoryReader } from '../../core/ports/memory.ts';
import { ftsQuery, norm } from '../../core/text.ts';
import { PUBLIC_SQL, PUBLIC_COLUMNS, PUBLIC_MAX_ROWS, PUBLIC_MAX_BYTES, VIEW_MAX_BYTES, normalize } from './sqlite-public-protocol.ts';

type Row = Record<string, any>;
type Identity = { dev: string; ino: string };
export type PublicReadOptions = { primary: string; view: string; sourceId: string; nonExpiringOnly?: boolean };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BUDGET_MS = 250;
const integer = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const stamp = (n: unknown): n is number => integer(n) && n <= 8_640_000_000_000_000;
const text = (v: unknown, max: number, nonempty = false): v is string => typeof v === 'string' && v.length <= max && (!nonempty || /\S/.test(v));
type Reason = 'input' | 'path' | 'identity' | 'size' | 'format' | 'journal_pending' | 'schema' | 'state' | 'data' | 'storage' | 'runtime' | 'deadline' | 'closed';
function unavailable(reason: Reason): never { throw new MemoryError('unavailable', `local public memory unavailable (${reason})`); }
function invalid(): never { throw new MemoryError('invalid', 'invalid read-only memory request'); }
function fields(input: unknown, names: string[], dependency = false): Row {
  const out: Row = {};
  try {
    if (!input || typeof input !== 'object') throw 0;
    for (const name of names) {
      const d = Object.getOwnPropertyDescriptor(input, name);
      if (d && !Object.hasOwn(d, 'value')) throw 0;
      out[name] = d?.value;
    }
  } catch { if (dependency) unavailable('input'); invalid(); }
  return out;
}
function list(value: unknown, max: number, accepts: (item: unknown) => boolean): any[] {
  try {
    if (!Array.isArray(value) || value.length > max) throw 0;
    const copied = Array.from(value); if (copied.some((item) => !accepts(item))) throw 0;
    return copied;
  } catch { invalid(); }
}
function mapped(e: unknown): never {
  let message: string | undefined; let code: string | undefined;
  try { if (e instanceof MemoryError) { message = Object.getOwnPropertyDescriptor(e, 'message')?.value; code = Object.getOwnPropertyDescriptor(e, 'code')?.value; } } catch {}
  if (code === 'invalid' && message === 'invalid read-only memory request') invalid();
  if (code === 'not_found' && message === 'memory not found') throw new MemoryError('not_found', 'memory not found');
  const reasons: Reason[] = ['input','path','identity','size','format','journal_pending','schema','state','data','storage','runtime','deadline','closed'];
  const reason = reasons.find((r) => message === `local public memory unavailable (${r})`);
  unavailable(code === 'unavailable' && reason ? reason : 'storage');
}
function present(file: string): boolean {
  try { fs.lstatSync(file); return true; }
  catch (e) { if ((e as { code?: unknown })?.code === 'ENOENT') return false; throw e; }
}
function identity(file: string): Identity {
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.resolve(file) !== file || file.includes('\0')) unavailable('path');
  const parent = path.dirname(file);
  if (fs.realpathSync(parent) !== parent || fs.realpathSync(file) !== file) unavailable('path');
  const dir = fs.statSync(parent); const s = fs.lstatSync(file, { bigint: true });
  if (!dir.isDirectory() || (dir.mode & 0o777) !== 0o700 || !s.isFile() || s.isSymbolicLink() || s.nlink !== 1n
    || Number(s.mode & 0o777n) !== 0o600 || process.getuid && (dir.uid !== process.getuid() || Number(s.uid) !== process.getuid())) unavailable('path');
  return { dev: String(s.dev), ino: String(s.ino) };
}
function same(file: string, expected: Identity): void {
  const actual = identity(file);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) unavailable('identity');
}

export class SqlitePublicReadOnly implements MemoryReader {
  #db: DatabaseSync | null = null;
  #now: () => number;
  #options: PublicReadOptions;
  #source: Identity;
  #view: Identity;
  #state: Row | undefined;
  #lastTime = 0;
  constructor(options: PublicReadOptions, now: () => number) {
    // Validate binding and callback before filesystem/native effects. Never learn the expected epoch from this view.
    options = fields(options, ['primary','view','sourceId','nonExpiringOnly'], true) as PublicReadOptions;
    if (typeof options.primary !== 'string' || typeof options.view !== 'string' || typeof options.sourceId !== 'string' || !UUID.test(options.sourceId) || typeof now !== 'function'
      || options.nonExpiringOnly !== undefined && typeof options.nonExpiringOnly !== 'boolean') unavailable('input');
    this.#options = options; this.#now = now;
    this.#source = { dev: '', ino: '' }; this.#view = { dev: '', ino: '' };
    const started = this.time();
    try {
      if (process.versions.bun || process.platform === 'win32' || Number(process.versions.node.split('.')[0]) < 24) unavailable('runtime');
      this.#source = identity(options.primary); this.#view = identity(options.view);
      if (options.primary === options.view || this.#source.dev === this.#view.dev && this.#source.ino === this.#view.ino) unavailable('path');
      this.files();
      const header = Buffer.alloc(100); const fd = fs.openSync(options.view, 'r');
      try { if (fs.readSync(fd, header, 0, 100, 0) !== 100) unavailable('format'); } finally { fs.closeSync(fd); }
      if (header.toString('ascii', 0, 16) !== 'SQLite format 3\0' || header[18] !== 1 || header[19] !== 1) unavailable('format');
      this.#db = new DatabaseSync(options.view, { readOnly: true, allowExtension: false, defensive: true, enableDoubleQuotedStringLiterals: false });
      this.#db.exec('PRAGMA query_only=ON; PRAGMA temp_store=MEMORY; PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN;');
      const objects = this.#db.prepare("SELECT name,type,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all() as Row[];
      if (objects.length !== PUBLIC_SQL.size || objects.some((r) => !PUBLIC_SQL.has(r.name)
        || r.type !== (r.name === 'public_memories_ai' || r.name === 'public_memories_ad' ? 'trigger' : 'table')
        || normalize(r.sql) !== normalize(PUBLIC_SQL.get(r.name)))) unavailable('schema');
      // Only protocol/identity fields are selected. Owner backup names, digests and recovery derivatives stay unread.
      const gates = this.#db.prepare(`SELECT id,protocol,state,phase,source_id,source_dev,source_ino,view_dev,view_ino FROM bosun_cutover_gate`).all() as Row[];
      const gate = gates[0];
      if (gates.length !== 1 || gate.id !== 1 || gate.protocol !== 1 || gate.state !== 'HOLD' || gate.phase !== 'applied'
        || gate.source_id !== options.sourceId || gate.source_dev !== this.#source.dev || gate.source_ino !== this.#source.ino
        || gate.view_dev !== this.#view.dev || gate.view_ino !== this.#view.ino) unavailable('identity');
      this.state();
      // Whole-view limits return only scalars. Foreign-scope content is never materialized into JavaScript here.
      const count = this.#db.prepare(`SELECT count(*) AS n,sum(CASE WHEN typeof(private)!='integer' OR private!=0 OR status!='active'
        OR expires_at IS NOT NULL AND (typeof(expires_at)!='integer' OR expires_at<0 OR expires_at>8640000000000000)
        THEN 1 ELSE 0 END) AS denied,min(expires_at) AS expiry FROM public_memories`).get() as Row;
      if (!integer(count.n) || count.n > PUBLIC_MAX_ROWS || count.denied !== null && count.denied !== 0 || count.expiry !== this.#state!.valid_until) unavailable('data');
      const encoded = this.#db.prepare(`SELECT COALESCE(sum(length(CAST(json_object(${PUBLIC_COLUMNS.map((c) => `'${c}',${c}`).join(',')}) AS BLOB))),0) AS bytes
        FROM public_memories WHERE typeof(private)='integer' AND private=0 AND status='active'`).get() as Row;
      if (!integer(encoded.bytes) || encoded.bytes > PUBLIC_MAX_BYTES) unavailable('size');
      this.check(); this.deadline(started);
    } catch (e) {
      this.close();
      mapped(e);
    }
  }
  private time(): number {
    let n: unknown; try { n = this.#now(); } catch { invalid(); }
    if (!stamp(n)) invalid();
    if (n < this.#lastTime) unavailable('deadline');
    this.#lastTime = n; return n;
  }
  private deadline(started: number): void { if (this.time() - started > BUDGET_MS) unavailable('deadline'); }
  private files(): void {
    same(this.#options.primary, this.#source); same(this.#options.view, this.#view);
    // Minimal filesystem header check rejects obvious offline/rollback restoration without opening mutable WAL through SQLite.
    const primarySize = fs.statSync(this.#options.primary).size;
    if (primarySize < 100 || primarySize > 64 * 1024 * 1024 || present(this.#options.primary + '-journal')) unavailable('format');
    const sourceHeader = Buffer.alloc(20); const sourceFd = fs.openSync(this.#options.primary, 'r');
    try { if (fs.readSync(sourceFd, sourceHeader, 0, 20, 0) !== 20) unavailable('format'); } finally { fs.closeSync(sourceFd); }
    if (sourceHeader.toString('ascii', 0, 16) !== 'SQLite format 3\0' || sourceHeader[18] !== 2 || sourceHeader[19] !== 2) unavailable('format');
    const size = fs.statSync(this.#options.view).size;
    if (size < 100 || size > VIEW_MAX_BYTES) unavailable('size');
    if (['-journal', '-wal', '-shm'].some((s) => present(this.#options.view + s))) unavailable('journal_pending');
  }
  private state(): void {
    const rows = this.#db!.prepare('SELECT id,format,state,source_id,generation,publication_id,published_at,valid_until FROM bosun_public_state').all() as Row[];
    const s = rows[0]; const now = this.time();
    if (rows.length !== 1 || s.id !== 1 || s.format !== 2 || s.state !== 'READY' || s.source_id !== this.#options.sourceId
      || !integer(s.generation) || typeof s.publication_id !== 'string' || !UUID.test(s.publication_id)
      || !stamp(s.published_at) || s.published_at > now || s.valid_until !== null && (!stamp(s.valid_until) || s.valid_until <= now || s.valid_until <= s.published_at)) unavailable('state');
    if (this.#state && Object.keys(s).some((key) => s[key] !== this.#state![key])) unavailable('state');
    this.#state = s;
  }
  private check(): void { if (!this.#db) unavailable('closed'); this.files(); this.state(); }
  /** Concrete handoff seam: recheck the retained lease immediately before queuing its packed content. */
  validate(): void { this.read(() => undefined); }
  private read<T>(fn: () => T): T {
    const started = this.time();
    try { this.check(); const result = fn(); this.check(); this.deadline(started); return result; }
    catch (e) { mapped(e); }
  }
  private scope(ctx: Ctx): { pid: string | null; linked: string; now: number; permanent: number } {
    const scope = fields(ctx, ['projectId','linked']);
    if (!(scope.projectId === null || text(scope.projectId, 64, true))) invalid();
    const linked = list(scope.linked, 50, (id) => text(id, 64, true));
    return { pid: scope.projectId, linked: JSON.stringify(linked), now: this.time(), permanent: this.#options.nonExpiringOnly ? 1 : 0 };
  }
  private memory(row: Row): Memory {
    if (row.private !== 0 || row.status !== 'active' || !integer(row.seq) || row.seq < 1 || !text(row.id, 64, true) || !CATEGORIES.includes(row.category)
      || (row.category === 'personal') !== (row.project_id === null) || row.project_id !== null && !text(row.project_id, 64, true)
      || row.session_id !== null && !text(row.session_id, 200) || !text(row.title, 200, true) || !text(row.body, 4000, true)
      || !text(row.tags, 600) || row.shared !== 0 && row.shared !== 1 || !text(row.source, 200) || row.source_ref !== null && !text(row.source_ref, 200)
      || !stamp(row.created_at) || !stamp(row.updated_at) || row.expires_at !== null && !stamp(row.expires_at)
      || row.accessed_at !== null && !stamp(row.accessed_at) || !integer(row.access_count) || !integer(row.version) || row.version < 1) unavailable('data');
    const tags: unknown = JSON.parse(row.tags);
    if (!Array.isArray(tags) || tags.length > 12 || tags.some((tag) => typeof tag !== 'string' || !/^[a-z0-9-]{1,40}$/.test(tag))
      || row.hash !== crypto.createHash('sha256').update(norm(`${row.title}\n${row.body}`)).digest('hex').slice(0, 32)) unavailable('data');
    return { private: false, id: row.id, category: row.category, projectId: row.project_id, sessionId: row.session_id,
      title: row.title, body: row.body, tags, status: 'active', shared: row.shared === 1, source: row.source, sourceRef: row.source_ref,
      hash: row.hash, createdAt: row.created_at, updatedAt: row.updated_at, expiresAt: row.expires_at, accessedAt: row.accessed_at,
      accessCount: row.access_count, version: row.version };
  }
  async search(q: Query, ctx: Ctx): Promise<Found[]> {
    q = fields(q, ['text','category','includePrivate','touch','status','limit','tags']) as Query;
    if (q.status !== undefined) q.status = list(q.status, 1, (s) => s === 'active');
    if (q.tags !== undefined) q.tags = list(q.tags, 12, (tag) => typeof tag === 'string' && /^[a-z0-9-]{1,40}$/.test(tag));
    if (q.text !== undefined && (typeof q.text !== 'string' || q.text.length > 20000)
      || q.category !== undefined && !CATEGORIES.includes(q.category) || q.includePrivate !== undefined && q.includePrivate !== false
      || q.touch !== undefined && q.touch !== false || q.limit !== undefined && (!Number.isSafeInteger(q.limit) || q.limit < 1 || q.limit > 50)) invalid();
    const params = { ...this.scope(ctx), category: q.category ?? null, tags: q.tags?.length ? JSON.stringify(Array.from(q.tags)) : null, limit: q.limit ?? 10 };
    const match = q.text ? ftsQuery(q.text) : '';
    return this.read(() => {
      if (q.text?.trim() && !match) return [];
      const filter = `${READ} AND (:category IS NULL OR m.category=:category)
        AND (:tags IS NULL OR EXISTS(SELECT 1 FROM json_each(m.tags) t WHERE t.value IN (SELECT value FROM json_each(:tags))))`;
      const rows = (match ? this.#db!.prepare(`SELECT m.*,bm25(public_memories_fts) AS rank FROM public_memories_fts JOIN public_memories m ON m.seq=public_memories_fts.rowid
        WHERE public_memories_fts MATCH :match AND ${filter} ORDER BY bm25(public_memories_fts) LIMIT :limit`).all({ ...params, match })
        : this.#db!.prepare(`SELECT m.*,0 AS rank FROM public_memories m WHERE ${filter} ORDER BY m.updated_at DESC,m.seq DESC LIMIT :limit`).all(params)) as Row[];
      const counts = match && rows.length ? this.#db!.prepare(`SELECT rowid AS seq,highlight(public_memories_fts,0,char(1),char(2)) AS t,
        highlight(public_memories_fts,1,char(1),char(2)) AS b,highlight(public_memories_fts,2,char(1),char(2)) AS g FROM public_memories_fts
        WHERE public_memories_fts MATCH :match AND rowid IN (SELECT value FROM json_each(:seqs))`).all({ match, seqs: JSON.stringify(rows.map((r) => r.seq)) }) as Row[] : [];
      const words = (s: string) => [...s.matchAll(/\u0001([^\u0002]*)\u0002/g)].map((m) => m[1].toLowerCase());
      const matched = new Map(counts.map((r) => [r.seq, new Set([...words(r.t), ...words(r.b), ...words(r.g)]).size]));
      return rows.map((r) => {
        if (typeof r.rank !== 'number' || !Number.isFinite(r.rank)) unavailable('data');
        return { ...this.memory(r), rank: r.rank, ...(match ? { matched: matched.get(r.seq) ?? 0 } : {}) };
      });
    });
  }
  async get(id: string, ctx: Ctx, opts: { events?: boolean } = {}): Promise<Memory> {
    opts = fields(opts, ['events']);
    if (!text(id, 64, true) || opts.events !== undefined && opts.events !== false) invalid();
    const params = { id, ...this.scope(ctx) };
    return this.read(() => {
      const row = this.#db!.prepare(`SELECT m.* FROM public_memories m WHERE m.id=:id AND ${READ}`).get(params) as Row | undefined;
      if (!row) throw new MemoryError('not_found', 'memory not found');
      return this.memory(row);
    });
  }
  close(): void {
    const db = this.#db; this.#db = null;
    if (!db) return;
    try { db.close(); } catch { try { db.close(); } catch { /* process teardown releases any failed native close */ } }
  }
}
const READ = `((m.category='personal' AND m.project_id IS NULL) OR (m.category IN ('project','session') AND typeof(m.project_id)='text'
  AND (m.project_id=:pid OR m.shared=1 OR m.project_id IN (SELECT value FROM json_each(:linked)))))
  AND typeof(m.private)='integer' AND m.private=0 AND m.status='active'
  AND (m.expires_at IS NULL OR (typeof(m.expires_at)='integer' AND m.expires_at>:now)) AND (:permanent=0 OR m.expires_at IS NULL)`;
