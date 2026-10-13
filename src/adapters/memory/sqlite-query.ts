// Query/projection only. No expiry, access, index or other storage mutation belongs here.
import type { SqliteDatabase } from '../../platform/sqlite.ts'
import {
  CATEGORIES,
  STATUSES,
  type Ctx,
  type Found,
  type Memory,
  type MemoryEvent,
  type Query,
} from '../../core/domain/memory.ts';
import { MemoryError } from '../../core/errors.ts';
import { ftsQuery } from '../../core/text.ts';
import { check, ID, QUERY } from '../../contracts/memory.ts';

export type Row = Record<string, any>;
export const MAX_DATE_MS = 8_640_000_000_000_000;
const READ =
  "(m.project_id IS NULL OR m.project_id = :pid OR (typeof(m.shared) = 'integer' AND m.shared = 1) OR m.project_id IN (SELECT value FROM json_each(:linked)))";
const scope = (ctx: Ctx) => ({ pid: ctx.projectId, linked: JSON.stringify(ctx.linked) });
export const toMemory = (r: Row): Memory => ({
  id: r.id,
  category: r.category,
  projectId: r.project_id,
  sessionId: r.session_id,
  title: r.title,
  body: r.body,
  tags: JSON.parse(r.tags),
  // Only integer zero is public and integer one grants sharing; omitted patches preserve raw flags.
  status: r.status,
  shared: r.shared === 1,
  private: r.private !== 0,
  source: r.source,
  sourceRef: r.source_ref,
  hash: r.hash,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  expiresAt: r.expires_at,
  accessedAt: r.accessed_at,
  accessCount: r.access_count,
  version: r.version,
});
export const bySeq = (db: SqliteDatabase, seq: number): Memory =>
  toMemory(db.prepare('SELECT * FROM memories WHERE seq = ?').get(seq) as Row);

// Out-of-scope IDs are not found, so owner inspection does not reveal another project's existence.
export function scopedRow(db: SqliteDatabase, id: unknown, ctx: Ctx): Row {
  check(ID, id);
  const r = db
    .prepare(`SELECT * FROM memories m WHERE m.id = :id AND ${READ}`)
    .get({ id: id as string, ...scope(ctx) });
  if (!r) throw new MemoryError('not_found', 'memory not found');
  return r as Row;
}
export function writableRow(db: SqliteDatabase, id: unknown, ctx: Ctx): Row {
  const r = scopedRow(db, id, ctx);
  // The final dispatcher binds audience outside model arguments. Check stored flags
  // inside the same admitted transaction before changing a hidden record.
  if (
    ctx.audience === 'model' &&
    !db
      .prepare("SELECT 1 FROM memories WHERE seq=? AND typeof(private)='integer' AND private=0")
      .get(r.seq)
  ) {
    throw new MemoryError('not_found', 'memory not found');
  }
  if (r.project_id !== null && r.project_id !== ctx.projectId)
    throw new MemoryError('invalid', 'that memory belongs to another project (read-only here)');
  return r;
}
export function queryGet(
  db: SqliteDatabase,
  id: string,
  ctx: Ctx,
  opts: { events?: boolean } = {},
): Memory & { events?: MemoryEvent[] } {
  // Owner inspection returns the persisted row, including an unmaintained expired row, without manufacturing an archive/event.
  const m = toMemory(scopedRow(db, id, ctx));
  if (!opts.events) return m;
  const events = (
    db
      .prepare(
        'SELECT op, at, source, hash_before, hash_after FROM memory_events WHERE memory_id = ? ORDER BY id',
      )
      .all(m.id) as Row[]
  ).map((e) => ({
    op: e.op,
    at: e.at,
    source: e.source,
    hashBefore: e.hash_before,
    hashAfter: e.hash_after,
  }));
  return { ...m, events };
}

// Owner metadata only. Apply the same sharing/linked-project policy as reads;
// this aggregate never projects titles, bodies, tags or provenance.
export function queryStats(db: SqliteDatabase, ctx: Ctx) {
  const byCategory = { personal: 0, project: 0, session: 0 };
  const byStatus = { active: 0, proposed: 0, archived: 0 };
  let total = 0,
    publicNotes = 0;
  const rows = db
    .prepare(`SELECT m.category,m.status,COUNT(*) AS n,
    SUM(CASE WHEN typeof(m.private)='integer' AND m.private=0 THEN 1 ELSE 0 END) AS public
    FROM memories m WHERE ${READ} GROUP BY m.category,m.status`)
    .all(scope(ctx));
  for (const row of rows) {
    const category = row.category as keyof typeof byCategory,
      status = row.status as keyof typeof byStatus;
    const n = Number(row.n),
      exposed = Number(row.public);
    if (
      !CATEGORIES.includes(category) ||
      !STATUSES.includes(status) ||
      !Number.isSafeInteger(n) ||
      n < 0 ||
      !Number.isSafeInteger(exposed) ||
      exposed < 0 ||
      exposed > n
    )
      throw new MemoryError('unavailable', 'memory stats unavailable');
    byCategory[category] += n;
    byStatus[status] += n;
    total += n;
    publicNotes += exposed;
  }
  return {
    projectId: ctx.projectId,
    total,
    byCategory,
    byStatus,
    privacy: { public: publicNotes, private: total - publicNotes },
  };
}

export function querySearch(
  db: SqliteDatabase,
  q: Query,
  ctx: Ctx,
  now: number,
  excludeExpired = true,
  ranking: 'baseline' | 'lexical' = 'baseline',
): Found[] {
  check(QUERY, q);
  const match = q.text ? ftsQuery(q.text) : '';
  if (q.text?.trim() && !match) return [];
  const params = {
    ...scope(ctx),
    statuses: JSON.stringify(q.status?.length ? q.status : ['active']),
    category: q.category ?? null,
    private: q.includePrivate ? 1 : 0,
    tags: q.tags?.length ? JSON.stringify(q.tags) : null,
    limit: q.limit ?? 10,
    now,
    excludeExpired: Number(excludeExpired),
  };
  const filter = `${READ} AND m.status IN (SELECT value FROM json_each(:statuses)) AND (:category IS NULL OR m.category = :category)
    AND (:private = 1 OR (typeof(m.private) = 'integer' AND m.private = 0))
    AND (:excludeExpired = 0 OR m.status = 'archived' OR m.expires_at IS NULL
      OR (typeof(m.expires_at) = 'integer' AND m.expires_at > :now AND m.expires_at <= ${MAX_DATE_MS}))
    AND (:tags IS NULL OR EXISTS (SELECT 1 FROM json_each(m.tags) t WHERE t.value IN (SELECT value FROM json_each(:tags))))`;
  const score = ranking === 'lexical' ? 'bm25(memories_fts,5,1,2)' : 'bm25(memories_fts)';
  const order = ranking === 'lexical' ? `${score},m.id` : score;
  const rows = (
    match
      ? db
          .prepare(`SELECT m.*, ${score} AS rank FROM memories_fts JOIN memories m ON m.seq = memories_fts.rowid
        WHERE memories_fts MATCH :match AND ${filter} ORDER BY ${order} LIMIT :limit`)
          .all({ ...params, match })
      : db
          .prepare(
            `SELECT m.*, 0 AS rank FROM memories m WHERE ${filter} ORDER BY m.updated_at DESC, m.seq DESC LIMIT :limit`,
          )
          .all(params)
  ) as Row[];
  const matched =
    match && rows.length
      ? matchedWords(
          db,
          match,
          rows.map((r) => r.seq),
        )
      : null;
  return rows.map((r) => ({
    ...toMemory(r),
    rank: r.rank,
    ...(matched ? { matched: matched.get(r.seq) ?? 0 } : {}),
  }));
}

// Query only the selected rows for porter-aware word matches, avoiding highlight for every FTS candidate.
function matchedWords(db: SqliteDatabase, match: string, seqs: number[]): Map<number, number> {
  const marks = (s: unknown) =>
    // biome-ignore lint/suspicious/noControlCharactersInRegex: SQLite highlight uses these fixed delimiters, rather than user-supplied regex syntax.
    [...String(s ?? '').matchAll(/\u0001([^\u0002]*)\u0002/g)].map((m) => m[1].toLowerCase());
  const rows = db
    .prepare(`SELECT rowid AS seq, highlight(memories_fts, 0, char(1), char(2)) AS t, highlight(memories_fts, 1, char(1), char(2)) AS b,
      highlight(memories_fts, 2, char(1), char(2)) AS g FROM memories_fts WHERE memories_fts MATCH :match AND rowid IN (SELECT value FROM json_each(:seqs))`)
    .all({ match, seqs: JSON.stringify(seqs) }) as Row[];
  return new Map(
    rows.map((r) => [r.seq as number, new Set([...marks(r.t), ...marks(r.b), ...marks(r.g)]).size]),
  );
}
