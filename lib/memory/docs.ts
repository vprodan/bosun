// Project docs index: this repo's Markdown files in FTS5, re-read only when a file's mtime changes.
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { record } from '../metrics.ts';
import { sh } from '../util.ts';
import { ftsQuery, plainSession, type SqliteSession } from './sqlite.ts';
import { MemoryError, type Ctx, type Hit, type MemoryProvider } from './types.ts';

const MAX_FILES = 2000;
const MAX_BYTES = 256 * 1024;   // ponytail: larger docs are skipped, not chunked; chunk them if big design docs matter
type Row = Record<string, any>;

export class Docs implements MemoryProvider {
  name = 'docs' as const;
  #session: SqliteSession;
  dir: string;
  projectId: string;
  top = '';
  constructor(db: DatabaseSync | SqliteSession, dir: string, projectId: string) {
    this.#session = 'transaction' in db ? db : plainSession(db); this.dir = dir; this.projectId = projectId;
  }
  get db(): DatabaseSync {
    if (!this.#session.legacyDb) throw new MemoryError('unavailable', 'registered memory database is private');
    return this.#session.legacyDb;
  }
  close(): void { this.#session.close(); }

  // Tracked, and untracked-but-not-ignored, *.md files of the repo around dir. Rows are keyed by the repo's top-level path,
  // so two worktrees of one project don't evict each other's rows.
  index(): { changed: number; removed: number } {
    const t = performance.now();
    const top = sh('git', ['-C', this.dir, 'rev-parse', '--show-toplevel']);
    if (top.code || !top.out) return { changed: 0, removed: 0 };
    this.top = top.out;
    const prefix = `${top.out}${path.sep}`;
    const ls = sh('git', ['-C', top.out, 'ls-files', '-z', '-co', '--exclude-standard', '--', '*.md']);
    const known = this.#session.read((db) => new Map((db.prepare('SELECT path, mtime FROM docs WHERE substr(path, 1, ?) = ?').all(prefix.length, prefix) as Row[]).map((r) => [r.path as string, r.mtime as number])));
    const put: [string, number, string, string][] = [];
    for (const rel of ls.out.split('\0').filter(Boolean).slice(0, MAX_FILES)) {
      const file = path.join(top.out, rel);
      let st: fs.Stats;
      try { st = fs.statSync(file); } catch { continue; }
      if (!st.isFile() || st.size > MAX_BYTES) continue;
      const mtime = Math.floor(st.mtimeMs);
      const seen = known.get(file);
      known.delete(file);
      if (seen === mtime) continue;
      const body = fs.readFileSync(file, 'utf8');
      put.push([file, mtime, (body.match(/^#\s+(.+)$/m)?.[1] ?? rel).trim().slice(0, 200), body]);
    }
    if (put.length || known.size) {
      this.#session.transaction((db) => {
        const up = db.prepare(`INSERT INTO docs (path, project_id, mtime, title, body) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(path) DO UPDATE SET project_id = excluded.project_id, mtime = excluded.mtime, title = excluded.title, body = excluded.body`);
        for (const [file, mtime, title, body] of put) up.run(file, this.projectId, mtime, title, body);
        const rm = db.prepare('DELETE FROM docs WHERE path = ?');
        for (const file of known.keys()) rm.run(file);
      });
    }
    record({ op: 'docs.index', ms: performance.now() - t, n: put.length });
    return { changed: put.length, removed: known.size };
  }

  async search(text: string, _ctx: Ctx, limit: number): Promise<Hit[]> {
    const match = ftsQuery(text);
    if (!match) return [];
    this.index();
    if (!this.top) return [];
    const prefix = `${this.top}${path.sep}`;
    return this.#session.read((db) => (db.prepare(`SELECT d.path, d.title, d.mtime, snippet(docs_fts, 1, '', '', '…', 32) AS text, bm25(docs_fts) AS rank
      FROM docs_fts JOIN docs d ON d.seq = docs_fts.rowid
      WHERE docs_fts MATCH ? AND substr(d.path, 1, ?) = ? ORDER BY bm25(docs_fts) LIMIT ?`).all(match, prefix.length, prefix, limit) as Row[])
      .map((r) => ({ source: 'docs', id: path.relative(this.top, r.path), title: r.title, text: r.text, category: 'doc', rank: r.rank, at: r.mtime, accessCount: 0 })));
  }
}
