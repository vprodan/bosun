// Query/projection only. No expiry, access, index or other storage mutation belongs here.
import type { DatabaseSync } from 'node:sqlite';
import type { Ctx, Found, Memory, MemoryEvent, Query } from '../../core/domain/memory.ts';
import { MemoryError } from '../../core/errors.ts';
import { ftsQuery } from '../../core/text.ts';
import { check, ID, QUERY } from '../../contracts/memory.ts';

export type Row = Record<string, any>;
export const MAX_DATE_MS = 8_640_000_000_000_000;
const READ = "(m.project_id IS NULL OR m.project_id = :pid OR (typeof(m.shared) = 'integer' AND m.shared = 1) OR m.project_id IN (SELECT value FROM json_each(:linked)))";
const scope = (ctx: Ctx) => ({ pid: ctx.projectId, linked: JSON.stringify(ctx.linked) });
export const toMemory = (r: Row): Memory => ({
  id: r.id, category: r.category, projectId: r.project_id, sessionId: r.session_id, title: r.title, body: r.body, tags: JSON.parse(r.tags),
  // Only integer zero is public and integer one grants sharing; omitted patches preserve raw flags.
  status: r.status, shared: r.shared === 1, private: r.private !== 0, source: r.source, sourceRef: r.source_ref, hash: r.hash,
  createdAt: r.created_at, updatedAt: r.updated_at, expiresAt: r.expires_at, accessedAt: r.accessed_at, accessCount: r.access_count, version: r.version,
});
export const bySeq = (db: DatabaseSync, seq: number): Memory => toMemory(db.prepare('SELECT * FROM memories WHERE seq = ?').get(seq) as Row);

// Out-of-scope IDs are not found, so owner inspection does not reveal another project's existence.
export function scopedRow(db: DatabaseSync, id: unknown, ctx: Ctx): Row {
  check(ID, id);
  const r = db.prepare(`SELECT * FROM memories m WHERE m.id = :id AND ${READ}`).get({ id: id as string, ...scope(ctx) });
  if (!r) throw new MemoryError('not_found', 'memory not found');
  return r as Row;
}
export function writableRow(db: DatabaseSync, id: unknown, ctx: Ctx): Row {
  const r = scopedRow(db, id, ctx);
  if (r.project_id !== null && r.project_id !== ctx.projectId) throw new MemoryError('invalid', 'that memory belongs to another project (read-only here)');
  return r;
}
export function queryGet(db: DatabaseSync, id: string, ctx: Ctx, opts: { events?: boolean } = {}): Memory & { events?: MemoryEvent[] } {
  // Owner inspection returns the persisted row, including an unmaintained expired row, without manufacturing an archive/event.
  const m = toMemory(scopedRow(db, id, ctx));
  if (!opts.events) return m;
  const events = (db.prepare('SELECT op, at, source, hash_before, hash_after FROM memory_events WHERE memory_id = ? ORDER BY id').all(m.id) as Row[])
    .map((e) => ({ op: e.op, at: e.at, source: e.source, hashBefore: e.hash_before, hashAfter: e.hash_after }));
  return { ...m, events };
}

export function querySearch(db: DatabaseSync, q: Query, ctx: Ctx, now: number, excludeExpired = true): Found[] {
  check(QUERY, q);
  const match = q.text ? ftsQuery(q.text) : '';
  if (q.text?.trim() && !match) return [];
  const params = { ...scope(ctx), statuses: JSON.stringify(q.status?.length ? q.status : ['active']), category: q.category ?? null,
    private: q.includePrivate ? 1 : 0, tags: q.tags?.length ? JSON.stringify(q.tags) : null, limit: q.limit ?? 10, now, excludeExpired: Number(excludeExpired) };
  const filter = `${READ} AND m.status IN (SELECT value FROM json_each(:statuses)) AND (:category IS NULL OR m.category = :category)
    AND (:private = 1 OR (typeof(m.private) = 'integer' AND m.private = 0))
    AND (:excludeExpired = 0 OR m.status = 'archived' OR m.expires_at IS NULL
      OR (typeof(m.expires_at) = 'integer' AND m.expires_at > :now AND m.expires_at <= ${MAX_DATE_MS}))
    AND (:tags IS NULL OR EXISTS (SELECT 1 FROM json_each(m.tags) t WHERE t.value IN (SELECT value FROM json_each(:tags))))`;
  const rows = (match
    ? db.prepare(`SELECT m.*, bm25(memories_fts) AS rank FROM memories_fts JOIN memories m ON m.seq = memories_fts.rowid
        WHERE memories_fts MATCH :match AND ${filter} ORDER BY bm25(memories_fts) LIMIT :limit`).all({ ...params, match })
    : db.prepare(`SELECT m.*, 0 AS rank FROM memories m WHERE ${filter} ORDER BY m.updated_at DESC, m.seq DESC LIMIT :limit`).all(params)) as Row[];
  const matched = match && rows.length ? matchedWords(db, match, rows.map((r) => r.seq)) : null;
  return rows.map((r) => ({ ...toMemory(r), rank: r.rank, ...(matched ? { matched: matched.get(r.seq) ?? 0 } : {}) }));
}

// Query only the selected rows for porter-aware word matches, avoiding highlight for every FTS candidate.
function matchedWords(db: DatabaseSync, match: string, seqs: number[]): Map<number, number> {
  const marks = (s: unknown) => [...String(s ?? '').matchAll(/\u0001([^\u0002]*)\u0002/g)].map((m) => m[1].toLowerCase());
  const rows = db.prepare(`SELECT rowid AS seq, highlight(memories_fts, 0, char(1), char(2)) AS t, highlight(memories_fts, 1, char(1), char(2)) AS b,
      highlight(memories_fts, 2, char(1), char(2)) AS g FROM memories_fts WHERE memories_fts MATCH :match AND rowid IN (SELECT value FROM json_each(:seqs))`)
    .all({ match, seqs: JSON.stringify(seqs) }) as Row[];
  return new Map(rows.map((r) => [r.seq as number, new Set([...marks(r.t), ...marks(r.b), ...marks(r.g)]).size]));
}
