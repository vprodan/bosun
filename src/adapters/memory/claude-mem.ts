// Optional external source: no import/open effects, persistence, migration or source mutation.
// Native metadata: thedotmack/claude-mem v13.29.0 src/services/sqlite/SessionStore.ts.
// Its legacy rows have no public/private classification; owner-reviewed references are required.
import fs from 'node:fs';
import { realpathWithoutOpen } from '../../platform/canonical-path.cjs';
import path from 'node:path';
import { SqliteDatabase } from '../../platform/sqlite.ts'
import type { Ctx } from '../../core/domain/memory.ts';
import type { Hit } from '../../core/domain/context.ts';
import type { ContextSource } from '../../core/ports/context-source.ts';
import { MemoryError } from '../../core/errors.ts';
import { terms } from '../../core/text.ts';
import { screenPublicText } from '../../core/secret-screen.ts';

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_REFS = 200;
const MAX_PAYLOAD = 16 * 1024;
const MAX_DATE = 8_640_000_000_000_000;
const REQUIRED = {
  schema_versions: ['id', 'version', 'applied_at'],
  observations: ['id', 'memory_session_id', 'project', 'title', 'subtitle', 'narrative', 'created_at_epoch'],
  session_summaries: ['id', 'memory_session_id', 'project', 'request', 'learned', 'completed', 'next_steps', 'created_at_epoch'],
} as const;
export type ClaudeMemProject = { projectId: string; nativeProjects: readonly string[] };
export type ClaudeMemReviewedRef = {
  kind: 'observation' | 'summary'; id: number; projectId: string; nativeProject: string; nativeSessionId: string;
  createdAt: number; privacy: 'public'; scope: 'project' | 'session'; callerSessionId?: string;
};
export type ClaudeMemReview = { revision: string; records: readonly ClaudeMemReviewedRef[] };
export type ClaudeMemOptions = {
  file?: string;
  projects: readonly ClaudeMemProject[];
  review?(ctx: Readonly<Ctx>): ClaudeMemReview | undefined;
  monotonic?(): number;
};
type Row = Record<string, unknown>;
const text = (value: unknown): value is string => typeof value === 'string' && !!value && value.length <= 200 && !value.includes('\0');
const time = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_DATE;
const canonical = (file: unknown): file is string => typeof file === 'string' && path.isAbsolute(file) && path.resolve(file) === file && !file.includes('\0');
const stamp = (stat: fs.BigIntStats): string => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
function present(file: string): boolean {
  try { fs.lstatSync(file); return true; } catch (error) { if (error && typeof error === 'object' && Object.getOwnPropertyDescriptor(error, 'code')?.value === 'ENOENT') return false; throw error; }
}
// Metadata only. Explicit callers may save this with reviewed IDs; a later source change invalidates that review.
export function claudeMemRevision(file: string): string | undefined {
  try {
    if (!canonical(file) || realpathWithoutOpen(file) !== file) return undefined;
    const stat = fs.lstatSync(file, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size < 100n || stat.size > BigInt(MAX_BYTES)) return undefined;
    return stamp(stat);
  } catch { return undefined; }
}
export class ClaudeMemSource implements ContextSource {
  readonly id = 'claude-mem';
  readonly trust = 'verified';
  readonly weight = 0.6;
  readonly halfLifeDays = 30;
  #file: string | undefined;
  #projects: readonly Readonly<ClaudeMemProject>[];
  #review: ClaudeMemOptions['review'];
  #monotonic: () => number;
  #closed = false;
  #state: 'disabled' | 'held' | 'ready' | 'closed' = 'disabled';
  constructor(options: ClaudeMemOptions) {
    try {
      const { file, projects, review, monotonic = () => performance.now() } = options;
      if (file !== undefined && !canonical(file) || !Array.isArray(projects) || projects.length > 200
        || review !== undefined && typeof review !== 'function' || typeof monotonic !== 'function') throw Error();
      this.#projects = Object.freeze(projects.map(({ projectId, nativeProjects }) => {
        if (!text(projectId) || !Array.isArray(nativeProjects) || nativeProjects.length > 50 || nativeProjects.some((name) => !text(name))) throw Error();
        return Object.freeze({ projectId, nativeProjects: Object.freeze([...new Set(nativeProjects)]) });
      }));
      this.#file = file; this.#review = review; this.#monotonic = monotonic;
    } catch { throw new MemoryError('invalid', 'invalid external memory settings'); }
  }
  state(): 'disabled' | 'held' | 'ready' | 'closed' { return this.#state; }
  close(): void { this.#closed = true; this.#state = 'closed'; }
  private schema(db: SqliteDatabase): void {
    for (const [table, required] of Object.entries(REQUIRED)) {
      const entry = db.prepare('SELECT type,sql FROM sqlite_master WHERE name=?').get(table);
      if (entry?.type !== 'table' || typeof entry.sql !== 'string' || !/^CREATE TABLE\b/i.test(entry.sql)) throw Error();
      const columns = db.prepare('SELECT name FROM pragma_table_info(?)').all(table);
      if (columns.length > 100 || required.some((name) => !columns.some((column) => column.name === name))) throw Error();
    }
    const versions = db.prepare('SELECT version FROM schema_versions ORDER BY version LIMIT 101').all();
    if (!versions.length || versions.length > 100 || versions.some((row) => !Number.isSafeInteger(row.version) || Number(row.version) < 1)
      || versions.at(-1)!.version !== 40) throw Error();
  }
  async search(query: string, ctx: Ctx, limit: number): Promise<Hit[]> {
    let db: SqliteDatabase | undefined; let transaction = false;
    if (this.#closed || !this.#file || !this.#review) return [];
    this.#state = 'held';
    try {
      if (typeof query !== 'string' || !Number.isSafeInteger(limit) || limit < 1 || limit > 50
        || !ctx || !(ctx.projectId === null || text(ctx.projectId)) || !(ctx.sessionId === null || text(ctx.sessionId))
        || !Array.isArray(ctx.linked) || ctx.linked.length > 200 || ctx.linked.some((id) => !text(id))) return [];
      const requested = terms(query); if (!requested.length) return [];
      const caller = Object.freeze({ ...ctx, linked: Object.freeze([...ctx.linked]) as unknown as string[] });
      const authorized = new Map(this.#projects.filter((mapping) => mapping.projectId === caller.projectId || caller.linked.includes(mapping.projectId))
        .map((mapping) => [mapping.projectId, mapping.nativeProjects]));
      if (!authorized.size) return [];
      const review = this.#review(caller);
      if (!review || typeof review.revision !== 'string' || !Array.isArray(review.records) || review.records.length > MAX_REFS) return [];
      // Classification precedes every other reference field; references themselves contain metadata only.
      const approved = review.records.flatMap((record) => {
        if (!record || typeof record !== 'object') return [];
        const classification = Object.getOwnPropertyDescriptor(record, 'privacy');
        if (!classification || !('value' in classification) || classification.value !== 'public') return [];
        const { kind, id, projectId, nativeProject, nativeSessionId, createdAt, scope, callerSessionId } = record;
        if (!['observation', 'summary'].includes(kind) || !Number.isSafeInteger(id) || id < 1 || !text(projectId) || !text(nativeProject)
          || !text(nativeSessionId) || !time(createdAt) || !authorized.get(projectId)?.includes(nativeProject)
          || scope !== 'project' && !(scope === 'session' && text(callerSessionId) && callerSessionId === caller.sessionId)) return [];
        return [{ kind, id, projectId, nativeProject, nativeSessionId, createdAt }];
      });
      if (!approved.length) return [];
      const file = this.#file; const revision = claudeMemRevision(file);
      if (!revision || revision !== review.revision || ['-wal', '-shm', '-journal'].some((suffix) => present(file + suffix))) return [];
      const started = this.#monotonic(); if (!Number.isFinite(started) || started < 0) return [];
      const header = Buffer.alloc(100); const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const opened = fs.fstatSync(fd, { bigint: true });
        if (!opened.isFile() || opened.nlink !== 1n || stamp(opened) !== revision || fs.readSync(fd, header, 0, 100, 0) !== 100) return [];
      } finally { fs.closeSync(fd); }
      if (header.toString('ascii', 0, 16) !== 'SQLite format 3\0' || header[18] !== 1 || header[19] !== 1 || claudeMemRevision(file) !== revision) return [];
      db = new SqliteDatabase(file, { readOnly: true, allowExtension: false, defensive: true, enableDoubleQuotedStringLiterals: false });
      db.exec('PRAGMA query_only=ON; PRAGMA temp_store=MEMORY; PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN;'); transaction = true;
      this.schema(db);
      const hits: Hit[] = [];
      for (const [kind, table] of [['observation', 'observations'], ['summary', 'session_summaries']] as const) {
        const records = JSON.stringify(approved.filter((record) => record.kind === kind));
        const fields = kind === 'observation' ? "COALESCE(o.title,o.subtitle,'') AS title,COALESCE(o.narrative,'') AS body"
          : "COALESCE(o.request,'') AS title,COALESCE(o.learned,'') || char(10) || COALESCE(o.completed,'') || char(10) || COALESCE(o.next_steps,'') AS body";
        const payload = kind === 'observation' ? ['title', 'subtitle', 'narrative'] : ['request', 'learned', 'completed', 'next_steps'];
        const bounds = payload.map((column) => `(o.${column} IS NULL OR (typeof(o.${column})='text' AND length(CAST(o.${column} AS BLOB))<=${MAX_PAYLOAD}))`).join(' AND ');
        const bodyBytes = kind === 'observation' ? "length(CAST(COALESCE(o.narrative,'') AS BLOB))"
          : "length(CAST(COALESCE(o.learned,'') AS BLOB))+length(CAST(COALESCE(o.completed,'') AS BLOB))+length(CAST(COALESCE(o.next_steps,'') AS BLOB))+2";
        const rows = db.prepare(`SELECT DISTINCT o.id,o.created_at_epoch AS at,${fields}
          FROM ${table} o JOIN json_each(?) r ON o.id=json_extract(r.value,'$.id')
          WHERE typeof(o.id)='integer' AND typeof(o.project)='text' AND o.project COLLATE BINARY=json_extract(r.value,'$.nativeProject')
          AND typeof(o.memory_session_id)='text' AND o.memory_session_id COLLATE BINARY=json_extract(r.value,'$.nativeSessionId')
          AND typeof(o.created_at_epoch)='integer' AND o.created_at_epoch=json_extract(r.value,'$.createdAt') AND ${bounds} AND ${bodyBytes}<=${MAX_PAYLOAD}
          ORDER BY o.created_at_epoch DESC LIMIT ${MAX_REFS + 1}`).all(records) as Row[];
        if (rows.length > MAX_REFS) return [];
        for (const row of rows) {
          if (typeof row.title !== 'string' || typeof row.body !== 'string' || row.body.length > MAX_PAYLOAD || !time(row.at)) continue;
          try { screenPublicText(row.title); screenPublicText(row.body); } catch { continue; }
          const available = new Set(terms(`${row.title} ${row.body}`, 1000));
          const matched = requested.filter((term) => available.has(term)).length;
          if (matched) hits.push({ source: this.id, id: `cm_${kind === 'observation' ? 'o' : 's'}${row.id}`, category: kind,
            title: row.title.slice(0, 200), text: row.body.trim().slice(0, 1600), rank: -matched / requested.length, matched, at: row.at, accessCount: 0 });
        }
      }
      db.exec('ROLLBACK'); transaction = false; db.close(); db = undefined;
      const elapsed = this.#monotonic() - started;
      if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > 250 || claudeMemRevision(file) !== revision
        || ['-wal', '-shm', '-journal'].some((suffix) => present(file + suffix))) return [];
      this.#state = 'ready';
      return hits.sort((a, b) => a.rank - b.rank || b.at - a.at || a.id.localeCompare(b.id)).slice(0, limit);
    } catch { return []; }
    finally {
      if (transaction) try { db?.exec('ROLLBACK'); } catch {}
      try { db?.close(); } catch {}
    }
  }
}
