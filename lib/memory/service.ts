// MemoryService: the curated store over SQLite. Validation, dedupe, provenance (an event per change), retention, isolation.
import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { P, type Cfg } from '../config.ts';
import { timed } from '../metrics.ts';
import { validate, type Schema } from '../util.ts';
import { RemoteStore } from './remote.ts';
import { contentHash, ftsQuery, openDb, tx } from './sqlite.ts';
import { CATEGORIES, STATUSES, MemoryError, type Ctx, type Found, type Memory, type MemoryApi, type MemoryEvent, type Patch, type Query, type StoreInput } from './types.ts';

const text = (max: number): Schema => ({ type: 'string', minLength: 1, maxLength: max, pattern: '\\S' });
// Shared with MCP: the tool schemas are built from these, so every entry point enforces the same limits.
export const FIELDS: Record<string, Schema> = {
  category: { type: 'string', enum: CATEGORIES, description: 'personal (you, in every project), project (this repo), session (expires after a week)' },
  title: text(200),
  body: text(4000),
  tags: { type: 'array', maxItems: 12, items: { type: 'string', pattern: '^[a-z0-9-]{1,40}$' } },
  private: { type: 'boolean', description: 'never shown to the model or sent to a remote LLM' },
  shared: { type: 'boolean', description: 'readable from every project' },
  ttlDays: { type: 'integer', minimum: 1, maximum: 3650 },
};
const STORE: Schema = { type: 'object', additionalProperties: false, required: ['category', 'title', 'body'], properties: {
  ...FIELDS, status: { type: 'string', enum: ['active', 'proposed'] }, source: { type: 'string', maxLength: 200 }, sourceRef: { type: 'string', maxLength: 200 } } };
export const PATCH: Schema = { type: 'object', additionalProperties: false, properties: {
  title: FIELDS.title, body: FIELDS.body, tags: FIELDS.tags, private: FIELDS.private, shared: FIELDS.shared,
  status: { type: 'string', enum: ['active', 'archived'], description: 'active accepts a proposal or restores; archived deletes softly' } } };
const QUERY: Schema = { type: 'object', additionalProperties: false, properties: {
  text: { type: 'string', maxLength: 20000 }, category: FIELDS.category, tags: FIELDS.tags,
  status: { type: 'array', maxItems: 3, items: { type: 'string', enum: STATUSES } },
  limit: { type: 'integer', minimum: 1, maximum: 50 }, includePrivate: { type: 'boolean' }, touch: { type: 'boolean' } } };
const ID: Schema = { type: 'string', minLength: 1, maxLength: 64 };
const VERSION_NO: Schema = { type: 'integer', minimum: 1 };
const DAY = 86400000;

function check(schema: Schema, v: unknown): void {
  const e = validate(schema, v);
  if (e) throw new MemoryError('invalid', e);
}
// LLM-suggested tags → valid ones: lowercase, [a-z0-9-], deduped, at most 12.
export const cleanTags = (tags: unknown): string[] => (Array.isArray(tags)
  ? [...new Set(tags.map((t) => String(t).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)).filter(Boolean))].slice(0, 12)
  : []);

// Readable: personal, this project, shared, linked projects. Writable: personal and this project only.
const READ = '(m.project_id IS NULL OR m.project_id = :pid OR m.shared = 1 OR m.project_id IN (SELECT value FROM json_each(:linked)))';
type Row = Record<string, any>;
const scope = (ctx: Ctx) => ({ pid: ctx.projectId, linked: JSON.stringify(ctx.linked) });
const newId = () => `m_${Date.now().toString(32).padStart(9, '0')}${crypto.randomBytes(4).toString('hex')}`;
const toMemory = (r: Row): Memory => ({
  id: r.id, category: r.category, projectId: r.project_id, sessionId: r.session_id, title: r.title, body: r.body, tags: JSON.parse(r.tags),
  status: r.status, shared: !!r.shared, private: !!r.private, source: r.source, sourceRef: r.source_ref, hash: r.hash,
  createdAt: r.created_at, updatedAt: r.updated_at, expiresAt: r.expires_at, accessedAt: r.accessed_at, accessCount: r.access_count, version: r.version,
});

export class MemoryService implements MemoryApi {
  db: DatabaseSync;
  cfg: Cfg;
  constructor(db: DatabaseSync, cfg: Cfg) { this.db = db; this.cfg = cfg; this.expire(); }
  close(): void { this.db.close(); }

  // Retention, applied lazily on open: expired memories are archived, each with an event.
  expire(now = Date.now()): number {
    if (!this.db.prepare("SELECT 1 FROM memories WHERE expires_at <= ? AND status <> 'archived' LIMIT 1").get(now)) return 0;
    return tx(this.db, () => {
      this.db.prepare(`INSERT INTO memory_events (memory_id, op, at, source, hash_before, hash_after)
        SELECT id, 'expire', ?, 'retention', hash, hash FROM memories WHERE expires_at <= ? AND status <> 'archived'`).run(now, now);
      return Number(this.db.prepare("UPDATE memories SET status = 'archived', updated_at = ?, version = version + 1 WHERE expires_at <= ? AND status <> 'archived'").run(now, now).changes);
    });
  }

  private event(id: string, op: string, source: string, before: string | null, after: string | null, at = Date.now()): void {
    this.db.prepare('INSERT INTO memory_events (memory_id, op, at, source, hash_before, hash_after) VALUES (?, ?, ?, ?, ?, ?)').run(id, op, at, source, before, after);
  }
  private bySeq(seq: number): Memory { return toMemory(this.db.prepare('SELECT * FROM memories WHERE seq = ?').get(seq) as Row); }
  // Out-of-scope ids are "not found", never "forbidden": no existence leaks.
  private row(id: unknown, ctx: Ctx): Row {
    check(ID, id);
    const r = this.db.prepare(`SELECT * FROM memories m WHERE m.id = :id AND ${READ}`).get({ id: id as string, ...scope(ctx) });
    if (!r) throw new MemoryError('not_found', 'memory not found');
    return r as Row;
  }
  private writable(id: unknown, ctx: Ctx): Row {
    const r = this.row(id, ctx);
    if (r.project_id !== null && r.project_id !== ctx.projectId) throw new MemoryError('invalid', 'that memory belongs to another project (read-only here)');
    return r;
  }

  store(input: StoreInput, ctx: Ctx) {
    return timed('memory.store', () => {
      check(STORE, input);
      const title = input.title.trim();
      const body = input.body.trim();
      const cat = input.category;
      if (cat !== 'personal' && !ctx.projectId) throw new MemoryError('invalid', `${cat} memories need a project directory`);
      const projectId = cat === 'personal' ? null : ctx.projectId;
      const hash = contentHash(title, body);
      const now = Date.now();
      const ttl = input.ttlDays ?? (cat === 'session' ? Number(this.cfg.MEMORY_SESSION_TTL_DAYS) : null);
      const source = input.source || ctx.source || 'api';
      return tx(this.db, () => {
        const dup = this.db.prepare("SELECT * FROM memories WHERE COALESCE(project_id, '') = ? AND category = ? AND hash = ? AND status <> 'archived'").get(projectId ?? '', cat, hash);
        if (dup) return { memory: toMemory(dup as Row), duplicate: true };
        const id = newId();
        const r = this.db.prepare(`INSERT INTO memories (id, category, project_id, session_id, title, body, tags, status, shared, private, source, source_ref, hash, created_at, updated_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, cat, projectId, cat === 'session' ? ctx.sessionId : null, title, body,
          JSON.stringify([...new Set(input.tags || [])]), input.status || 'active', input.shared ? 1 : 0, input.private ? 1 : 0,
          source, input.sourceRef ?? null, hash, now, now, ttl ? now + ttl * DAY : null);
        this.event(id, input.status === 'proposed' ? 'propose' : 'store', source, null, hash, now);
        return { memory: this.bySeq(Number(r.lastInsertRowid)), duplicate: false };
      });
    }, (r) => ({ chars: r.memory.body.length }));
  }

  search(q: Query, ctx: Ctx): Promise<Found[]> {
    return timed('memory.search', () => {
      check(QUERY, q);
      this.expire();   // cheap indexed check; a long-running server has no "next open"
      const match = q.text ? ftsQuery(q.text) : '';
      if (q.text?.trim() && !match) return [];   // only stop words: nothing to search for
      const params = { ...scope(ctx), statuses: JSON.stringify(q.status?.length ? q.status : ['active']), category: q.category ?? null,
        private: q.includePrivate ? 1 : 0, tags: q.tags?.length ? JSON.stringify(q.tags) : null, limit: q.limit ?? 10 };
      const filter = `${READ} AND m.status IN (SELECT value FROM json_each(:statuses)) AND (:category IS NULL OR m.category = :category)
        AND (:private = 1 OR m.private = 0)
        AND (:tags IS NULL OR EXISTS (SELECT 1 FROM json_each(m.tags) t WHERE t.value IN (SELECT value FROM json_each(:tags))))`;
      const rows = (match
        ? this.db.prepare(`SELECT m.*, bm25(memories_fts) AS rank FROM memories_fts JOIN memories m ON m.seq = memories_fts.rowid
            WHERE memories_fts MATCH :match AND ${filter} ORDER BY bm25(memories_fts) LIMIT :limit`).all({ ...params, match })
        : this.db.prepare(`SELECT m.*, 0 AS rank FROM memories m WHERE ${filter} ORDER BY m.updated_at DESC, m.seq DESC LIMIT :limit`).all(params)) as Row[];
      if (match && rows.length && q.touch !== false) this.touch(rows.map((r) => r.id));
      const matched = match && rows.length ? this.matched(match, rows.map((r) => r.seq)) : null;
      return rows.map((r) => ({ ...toMemory(r), rank: r.rank, ...(matched ? { matched: matched.get(r.seq) ?? 0 } : {}) }));
    }, (r) => ({ n: r.length }));
  }
  // Distinct words FTS5 matched in each row, from its own highlight() (so porter stemming counts). A second query over the
  // few returned rows: in the main query SQLite would compute highlight() for every matching row before sorting.
  private matched(match: string, seqs: number[]): Map<number, number> {
    const marks = (s: unknown) => [...String(s ?? '').matchAll(/\u0001([^\u0002]*)\u0002/g)].map((m) => m[1].toLowerCase());
    const rows = this.db.prepare(`SELECT rowid AS seq, highlight(memories_fts, 0, char(1), char(2)) AS t, highlight(memories_fts, 1, char(1), char(2)) AS b,
        highlight(memories_fts, 2, char(1), char(2)) AS g FROM memories_fts WHERE memories_fts MATCH :match AND rowid IN (SELECT value FROM json_each(:seqs))`)
      .all({ match, seqs: JSON.stringify(seqs) }) as Row[];
    return new Map(rows.map((r) => [r.seq as number, new Set([...marks(r.t), ...marks(r.b), ...marks(r.g)]).size]));
  }
  private touch(ids: string[]): void {
    try {
      this.db.prepare('UPDATE memories SET accessed_at = ?, access_count = access_count + 1 WHERE id IN (SELECT value FROM json_each(?))').run(Date.now(), JSON.stringify(ids));
    } catch { /* a busy database must not fail a read */ }
  }

  get(id: string, ctx: Ctx, opts: { events?: boolean } = {}) {
    return timed('memory.get', (): Memory & { events?: MemoryEvent[] } => {
      this.expire();
      const m = toMemory(this.row(id, ctx));
      if (!opts.events) return m;
      const events = (this.db.prepare('SELECT op, at, source, hash_before, hash_after FROM memory_events WHERE memory_id = ? ORDER BY id').all(m.id) as Row[])
        .map((e) => ({ op: e.op, at: e.at, source: e.source, hashBefore: e.hash_before, hashAfter: e.hash_after }));
      return { ...m, events };
    });
  }

  update(id: string, patch: Patch, expectedVersion: number, ctx: Ctx) {
    return timed('memory.update', () => {
      check(PATCH, patch);
      check(VERSION_NO, expectedVersion);
      return tx(this.db, () => {
        const cur = this.writable(id, ctx);
        if (cur.version !== expectedVersion) throw new MemoryError('conflict', `version conflict: current version is ${cur.version}`, cur.version);
        const title = patch.title?.trim() ?? cur.title;
        const body = patch.body?.trim() ?? cur.body;
        const status = patch.status ?? cur.status;
        const hash = contentHash(title, body);
        if (status !== 'archived') {
          const dup = this.db.prepare("SELECT id FROM memories WHERE COALESCE(project_id, '') = ? AND category = ? AND hash = ? AND status <> 'archived' AND seq <> ?")
            .get(cur.project_id ?? '', cur.category, hash, cur.seq) as Row | undefined;
          if (dup) throw new MemoryError('conflict', `duplicate of ${dup.id}`, cur.version);
        }
        const now = Date.now();
        this.db.prepare('UPDATE memories SET title = ?, body = ?, tags = ?, status = ?, private = ?, shared = ?, hash = ?, updated_at = ?, version = version + 1 WHERE seq = ?')
          .run(title, body, patch.tags ? JSON.stringify([...new Set(patch.tags)]) : cur.tags, status,
            patch.private === undefined ? cur.private : Number(patch.private), patch.shared === undefined ? cur.shared : Number(patch.shared), hash, now, cur.seq);
        const op = status === cur.status ? 'update'
          : status === 'archived' ? (cur.status === 'proposed' ? 'reject' : 'archive')
            : cur.status === 'proposed' ? 'accept' : 'restore';
        this.event(cur.id, op, ctx.source || 'api', cur.hash, hash, now);
        return this.bySeq(cur.seq);
      });
    });
  }

  delete(id: string, ctx: Ctx) {
    return timed('memory.delete', () => tx(this.db, () => {
      const cur = this.writable(id, ctx);
      if (cur.status !== 'archived') {
        this.db.prepare("UPDATE memories SET status = 'archived', updated_at = ?, version = version + 1 WHERE seq = ?").run(Date.now(), cur.seq);
        this.event(cur.id, 'archive', ctx.source || 'api', cur.hash, cur.hash);
      }
      return this.bySeq(cur.seq);
    }));
  }

  accept(id: string, ctx: Ctx) { return this.decide(id, ctx, 'active'); }
  reject(id: string, ctx: Ctx) { return this.decide(id, ctx, 'archived'); }
  private async decide(id: string, ctx: Ctx, to: 'active' | 'archived'): Promise<Memory> {
    const cur = await this.get(id, ctx);
    if (cur.status !== 'proposed') throw new MemoryError('invalid', `not a proposal (status ${cur.status})`);
    return this.update(id, { status: to }, cur.version, ctx);
  }

  // Hard delete, archived memories only. Their events stay: the audit trail outlives the content.
  purge(id: string, ctx: Ctx): Promise<void> {
    return timed('memory.purge', () => tx(this.db, () => {
      const cur = this.writable(id, ctx);
      if (cur.status !== 'archived') throw new MemoryError('invalid', 'only archived memories can be purged: delete it first');
      this.db.prepare('DELETE FROM memories WHERE seq = ?').run(cur.seq);
      this.event(cur.id, 'purge', ctx.source || 'api', cur.hash, null);
    }));
  }

  // Archives expired memories; purges archived ones untouched for MEMORY_PURGE_AFTER_DAYS.
  prune(now = Date.now()): { archived: number; purged: number } {
    const archived = this.expire(now);
    const cutoff = now - Number(this.cfg.MEMORY_PURGE_AFTER_DAYS) * DAY;
    const purged = tx(this.db, () => {
      this.db.prepare("INSERT INTO memory_events (memory_id, op, at, source, hash_before, hash_after) SELECT id, 'purge', ?, 'retention', hash, NULL FROM memories WHERE status = 'archived' AND updated_at < ?").run(now, cutoff);
      return Number(this.db.prepare("DELETE FROM memories WHERE status = 'archived' AND updated_at < ?").run(cutoff).changes);
    });
    return { archived, purged };
  }

  counts(): Record<string, number> {
    return Object.fromEntries((this.db.prepare('SELECT status, COUNT(*) AS n FROM memories GROUP BY status').all() as Row[]).map((r) => [r.status, r.n]));
  }
}

// The memory store for this machine's config: a memory server when MEMORY_URL is set, else local SQLite.
export function openMemory(cfg: Cfg, timeoutMs?: number): MemoryApi {
  return cfg.MEMORY_URL ? new RemoteStore(cfg, timeoutMs) : new MemoryService(openDb(P.DB), cfg);
}
