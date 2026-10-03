// Read-only provider over claude-mem's database: this repo's observations and session summaries. Never writes, never throws.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { P, type Cfg } from '../config.ts';
import { log } from '../log.ts';
import { record } from '../metrics.ts';
import { ftsQuery } from './sqlite.ts';
import type { Ctx, Hit, MemoryProvider } from './types.ts';

// The columns bosun reads. When claude-mem's schema (v40 when this was written) moves on, the provider goes quiet with a warning.
const NEED: Record<string, string[]> = {
  observations: ['id', 'project', 'title', 'subtitle', 'narrative', 'created_at_epoch'],
  observations_fts: ['title', 'subtitle', 'narrative'],
  session_summaries: ['id', 'project', 'request', 'learned', 'completed', 'next_steps', 'created_at_epoch'],
  session_summaries_fts: ['request', 'learned', 'completed'],
};
export type Summary = { id: number; at: number; request: string; learned: string; completed: string; nextSteps: string };
type Row = Record<string, any>;

export class ClaudeMem implements MemoryProvider {
  name = 'claude-mem' as const;
  file: string;
  projects: string;   // JSON array of the repo names claude-mem may have recorded this project under
  off: boolean;
  constructor(cfg: Cfg, projects: string[]) {
    this.file = cfg.CLAUDE_MEM_DB || path.join(P.HOME, '.claude-mem', 'claude-mem.db');
    this.projects = JSON.stringify([...new Set(projects.filter(Boolean))]);
    this.off = cfg.CLAUDE_MEM === 'off';
  }

  private open(): DatabaseSync | null {
    if (this.off || !fs.existsSync(this.file)) return null;
    const db = new DatabaseSync(this.file, { readOnly: true });
    try {
      for (const [table, cols] of Object.entries(NEED)) {
        const have = new Set((db.prepare('SELECT name FROM pragma_table_info(?)').all(table) as Row[]).map((r) => r.name));
        if (cols.some((c) => !have.has(c))) throw Object.assign(new Error('claude-mem schema mismatch'), { code: `schema:${table}` });
      }
      return db;
    } catch (e) { db.close(); throw e; }
  }
  private safe<T>(what: string, fallback: T, fn: (db: DatabaseSync) => T): T {
    const t = performance.now();
    let db: DatabaseSync | null = null;
    try {
      db = this.open();
      return db ? fn(db) : fallback;
    } catch (e) {
      log('warn', 'claude-mem.unavailable', { what, file: this.file, err: e });
      return fallback;
    } finally {
      db?.close();
      record({ op: `claude-mem.${what}`, ms: performance.now() - t });
    }
  }

  async search(text: string, _ctx: Ctx, limit: number): Promise<Hit[]> {
    const match = ftsQuery(text);
    if (!match) return [];
    return this.safe('search', [] as Hit[], (db) => {
      const obs = db.prepare(`SELECT o.id, COALESCE(o.title, o.subtitle, '') AS title, snippet(observations_fts, -1, '', '', '…', 32) AS text,
          o.created_at_epoch AS at, bm25(observations_fts) AS rank
        FROM observations_fts JOIN observations o ON o.id = observations_fts.rowid
        WHERE observations_fts MATCH ? AND o.project COLLATE NOCASE IN (SELECT value FROM json_each(?))
        ORDER BY bm25(observations_fts) LIMIT ?`).all(match, this.projects, limit) as Row[];
      const sums = db.prepare(`SELECT s.id, COALESCE(s.request, '') AS title, snippet(session_summaries_fts, -1, '', '', '…', 32) AS text,
          s.created_at_epoch AS at, bm25(session_summaries_fts) AS rank
        FROM session_summaries_fts JOIN session_summaries s ON s.id = session_summaries_fts.rowid
        WHERE session_summaries_fts MATCH ? AND s.project COLLATE NOCASE IN (SELECT value FROM json_each(?))
        ORDER BY bm25(session_summaries_fts) LIMIT ?`).all(match, this.projects, limit) as Row[];
      const hit = (r: Row, category: string, id: string): Hit => ({ source: 'claude-mem', id, title: String(r.title).slice(0, 200), text: r.text, category, rank: r.rank, at: r.at, accessCount: 0 });
      return [...obs.map((r) => hit(r, 'observation', `cm_o${r.id}`)), ...sums.map((r) => hit(r, 'summary', `cm_s${r.id}`))]
        .sort((a, b) => a.rank - b.rank).slice(0, limit);
    });
  }

  // For consolidation: this repo's newest session summaries since a time.
  summaries(since: number, limit: number): Summary[] {
    return this.safe('summaries', [] as Summary[], (db) => db.prepare(`SELECT id, created_at_epoch AS at, COALESCE(request, '') AS request,
        COALESCE(learned, '') AS learned, COALESCE(completed, '') AS completed, COALESCE(next_steps, '') AS nextSteps
      FROM session_summaries WHERE project COLLATE NOCASE IN (SELECT value FROM json_each(?)) AND created_at_epoch >= ?
      ORDER BY created_at_epoch DESC LIMIT ?`).all(this.projects, since, limit) as Summary[]);
  }
}
