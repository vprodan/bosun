// Explicit admitted indexing; injected source operations are synchronous and must never return partial enumeration as complete.
import { BosunError, MemoryError } from '../../core/errors.ts';
import type { SqliteDatabase } from '../../platform/sqlite.ts'
import { docsRelative, docsScope, type DocsScope } from './sqlite-docs.ts';
import type { SqliteSession } from './sqlite-session.ts';
import { screenPublicText } from '../../core/secret-screen.ts';

export const DOCS_MAX_FILES = 2000;
export const DOCS_MAX_BYTES = 256 * 1024;
export const DOCS_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
export const DOCS_MAX_STORED_FILES = 10_000;
export const DOCS_MAX_LIST_BYTES = 2 * 1024 * 1024;
export type DocsEnumeration = { complete: true; files: string[]; valid(): boolean } | { complete: false };
export type DocsFile = { state: 'file'; mtime: number; bytes: number; title?: string; body?: string; valid(): boolean }
  | { state: 'rejected' | 'missing'; valid(): boolean }
  | { state: 'foreign'; root: string; valid(): boolean }
  | { state: 'held' };
export type DocsMeasurement = { op: 'docs.index'; ms: number; ok: boolean; n: number; removed: number };
export type DocsIndexDependencies = {
  enumerate(root: string): DocsEnumeration;
  inspect(root: string, relative: string, knownMtime?: number, readBody?: boolean): DocsFile;
  checkStorage(db: SqliteDatabase, reservedBytes: number): boolean;
  monotonic(): number;
  measure(value: DocsMeasurement): void;
};
export type DocsIndexReceipt = { state: 'indexed' | 'held'; changed: number; removed: number; excludedRoots: string[] };
type Known = { path: string; mtime: number; title: string | null; body: string; bytes: number };
const finite = (value: number): number => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : 0;
function unknownOutcome(error: unknown): boolean {
  try {
    if (!(error instanceof BosunError)) return false;
    const details = Object.getOwnPropertyDescriptor(error, 'details');
    if (!details || !('value' in details) || !details.value || typeof details.value !== 'object') return false;
    const outcome = Object.getOwnPropertyDescriptor(details.value, 'outcome');
    return !!outcome && 'value' in outcome && outcome.value === 'unknown';
  } catch { return false; }
}
export class SqliteDocsIndex {
  readonly scope: Readonly<Required<DocsScope>>;
  #session: SqliteSession;
  #dependencies: Readonly<DocsIndexDependencies>;
  constructor(session: SqliteSession, scope: DocsScope, dependencies: DocsIndexDependencies) {
    this.#session = session; this.scope = docsScope(scope);
    const { enumerate, inspect, checkStorage, monotonic, measure } = dependencies;
    if (![enumerate, inspect, checkStorage, monotonic, measure].every((fn) => typeof fn === 'function')) throw new MemoryError('invalid', 'invalid docs dependencies');
    this.#dependencies = Object.freeze({ enumerate, inspect, checkStorage, monotonic, measure });
  }
  private ticks(): number { try { return finite(this.#dependencies.monotonic()); } catch { return 0; } }
  index(): DocsIndexReceipt {
    const started = this.ticks(); let result: DocsIndexReceipt | undefined;
    try { result = this.run(); return result; }
    catch (error) {
      if (unknownOutcome(error)) throw new BosunError('unavailable', 'docs index unavailable', { details: { outcome: 'unknown' } });
      throw new MemoryError('unavailable', 'docs index unavailable');
    }
    finally {
      try { this.#dependencies.measure({ op: 'docs.index', ms: finite(this.ticks() - started),
        ok: result?.state === 'indexed', n: result?.changed ?? 0, removed: result?.removed ?? 0 }); } catch {}
    }
  }
  private run(): DocsIndexReceipt {
    const { root, projectId } = this.scope; const prefix = root + '/';
    const excluded = new Set(this.scope.excludedRoots);
    const held = (): DocsIndexReceipt => ({ state: 'held', changed: 0, removed: 0, excludedRoots: [...excluded] });
    const enumeration = this.#dependencies.enumerate(root);
    if (!enumeration.complete || enumeration.files.length > DOCS_MAX_FILES
      || enumeration.files.reduce((bytes, relative) => bytes + relative.length * 3 + 1, 0) > DOCS_MAX_LIST_BYTES
      || enumeration.files.some((relative) => !relative.endsWith('.md') || docsRelative(root, root + '/' + relative) !== relative)) return held();
    const files = [...new Set(enumeration.files)];
    const listed = new Set(files);
    const preflight = () => this.#session.read((db) => {
      if (!this.#dependencies.checkStorage(db, 0)) return null;
      return db.prepare(`SELECT count(*) AS n,coalesce(sum(length(CAST(path AS BLOB))+
        coalesce(length(CAST(title AS BLOB)),0)+length(CAST(body AS BLOB))),0) AS bytes FROM docs`).get()!;
    });
    let totalsBefore: ReturnType<typeof preflight>;
    // A registered session can reject storage before invoking this read callback.
    // Preserve the existing held preflight receipt; no mutation/COMMIT exceptions
    // are caught here, and no source payload inspection has begun.
    try { totalsBefore = preflight(); } catch { return held(); }
    if (!totalsBefore || Number(totalsBefore.n) > DOCS_MAX_STORED_FILES || Number(totalsBefore.bytes) > DOCS_MAX_TOTAL_BYTES) return held();
    const known = this.#session.read((db) => db.prepare(`SELECT path,mtime,title,body,
      length(CAST(path AS BLOB))+coalesce(length(CAST(title AS BLOB)),0)+length(CAST(body AS BLOB)) AS bytes
      FROM docs WHERE project_id=? AND substr(path,1,?)=? LIMIT ?`).all(projectId, prefix.length, prefix, DOCS_MAX_FILES + 1) as Known[]);
    if (known.length > DOCS_MAX_FILES) return held();
    const saved = new Map(known.map((row) => [row.path, row]));
    const candidates = new Set([...files, ...known.map((row) => docsRelative(root, row.path)).filter((rel): rel is string => rel !== null)]);
    const checks: (() => boolean)[] = [enumeration.valid]; const remove: string[] = [];
    const put: { path: string; mtime: number; title: string; body: string }[] = [];
    let scopedBytes = 0;
    for (const relative of candidates) {
      const file = root + '/' + relative;
      if ([...excluded].some((subroot) => file.startsWith(subroot + '/'))) continue;
      const old = saved.get(file);
      const source = this.#dependencies.inspect(root, relative, old?.mtime, listed.has(relative));
      if (source.state === 'held') return held();
      checks.push(source.valid);
      if (source.state === 'foreign') { excluded.add(source.root); continue; }
      if (source.state !== 'file' || !listed.has(relative)) {
        if (old) remove.push(file); continue;
      }
      if (!Number.isSafeInteger(source.mtime) || source.mtime < 0 || !Number.isSafeInteger(source.bytes) || source.bytes < 0 || source.bytes > DOCS_MAX_BYTES) return held();
      if (source.body === undefined) {
        if (!old || source.mtime !== old.mtime || !Number.isSafeInteger(old.bytes) || old.bytes < 0) return held();
        try { screenPublicText(old.body); if (old.title) screenPublicText(old.title); } catch { remove.push(file); continue; }
        scopedBytes += old.bytes;
      } else {
        if (typeof source.title !== 'string' || typeof source.body !== 'string' || source.title.length > 200 || source.body.length > DOCS_MAX_BYTES) return held();
        try { screenPublicText(source.title); screenPublicText(source.body); } catch { if (old) remove.push(file); continue; }
        // Upper bound UTF-8 allocation/storage for injected strings without an ambient encoder.
        scopedBytes += (file.length + source.title.length + source.body.length) * 3;
        if (!old || old.mtime !== source.mtime || old.title !== source.title || old.body !== source.body) {
          put.push({ path: file, mtime: source.mtime, title: source.title, body: source.body });
        }
      }
      if (scopedBytes > DOCS_MAX_TOTAL_BYTES) return held();
    }
    if (!checks.every((valid) => valid())) return held();
    if (put.length || remove.length) {
      const committed = this.#session.transaction((db) => {
        // Recheck source stamps under actual admission before DML; all bytes/listing were preflighted.
        if (!checks.every((valid) => valid())) return false;
        const totals = db.prepare(`SELECT count(*) AS n,coalesce(sum(length(CAST(path AS BLOB))+
          coalesce(length(CAST(title AS BLOB)),0)+length(CAST(body AS BLOB))),0) AS bytes FROM docs`).get()!;
        const replaced = [...put.map((row) => row.path), ...remove];
        let freed = 0; let replacedCount = 0;
        const existing = db.prepare('SELECT project_id,length(CAST(path AS BLOB))+coalesce(length(CAST(title AS BLOB)),0)+length(CAST(body AS BLOB)) AS bytes FROM docs WHERE path=?');
        for (const file of replaced) {
          const row = existing.get(file);
          // Absolute keys owned by another project are preserved, never adopted by UPSERT.
          if (row && row.project_id !== projectId) return false;
          if (row) { freed += Number(row.bytes); replacedCount++; }
        }
        const added = put.reduce((sum, row) => sum + (row.path.length + row.title.length + row.body.length) * 3, 0);
        if (Number(totals.bytes) - freed + added > DOCS_MAX_TOTAL_BYTES
          || Number(totals.n) - replacedCount + put.length > DOCS_MAX_STORED_FILES) return false;
        // Conservative eligibility reservation, not a proved SQLite commit-allocation ceiling.
        if (!this.#dependencies.checkStorage(db, added * 8 + (put.length + remove.length) * 12 * 1024)) return false;
        const up = db.prepare(`INSERT INTO docs(path,project_id,mtime,title,body) VALUES(?,?,?,?,?) ON CONFLICT(path)
          DO UPDATE SET mtime=excluded.mtime,title=excluded.title,body=excluded.body WHERE docs.project_id=excluded.project_id`);
        for (const row of put) up.run(row.path, projectId, row.mtime, row.title, row.body);
        const rm = db.prepare('DELETE FROM docs WHERE path=? AND project_id=?');
        for (const file of remove) rm.run(file, projectId);
        if (!this.#dependencies.checkStorage(db, 0)) throw new MemoryError('unavailable', 'docs storage unavailable');
        if (!checks.every((valid) => valid())) throw new MemoryError('unavailable', 'docs source unavailable');
        return true;
      });
      if (!committed) return held();
    }
    return { state: 'indexed', changed: put.length, removed: remove.length, excludedRoots: [...excluded] };
  }
}
