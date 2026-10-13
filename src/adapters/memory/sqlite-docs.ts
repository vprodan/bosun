// Established-session snapshot query. Source discovery/indexing is a separate explicit operation.
import type { SqliteDatabase } from '../../platform/sqlite.ts'
import type { Ctx } from '../../core/domain/memory.ts';
import type { Hit } from '../../core/domain/context.ts';
import type { ContextSource } from '../../core/ports/context-source.ts';
import { MemoryError } from '../../core/errors.ts';
import { screenPublicText } from '../../core/secret-screen.ts';
import { ftsQuery } from '../../core/text.ts';
import type { SqliteSession } from './sqlite-session.ts';

export type DocsScope = { root: string; projectId: string; excludedRoots?: readonly string[] };
const canonical = (root: string): boolean => typeof root === 'string' && root.startsWith('/') && root.length > 1 && root.length <= 4096
  && !root.includes('\0') && root.split('/').slice(1).every((part) => !!part && part !== '.' && part !== '..');
export function docsScope(scope: DocsScope): Readonly<Required<DocsScope>> {
  if (!canonical(scope.root) || typeof scope.projectId !== 'string' || !scope.projectId || scope.projectId.length > 200 || scope.projectId.includes('\0')) {
    throw new MemoryError('invalid', 'invalid docs scope');
  }
  const excludedRoots = [...new Set(scope.excludedRoots ?? [])];
  if (excludedRoots.length > 2000 || excludedRoots.some((root) => !canonical(root) || !root.startsWith(scope.root + '/'))) {
    throw new MemoryError('invalid', 'invalid docs scope');
  }
  return Object.freeze({ root: scope.root, projectId: scope.projectId, excludedRoots: Object.freeze(excludedRoots) });
}
export function docsRelative(root: string, file: string): string | null {
  if (typeof file !== 'string' || !file.startsWith(root + '/')) return null;
  const relative = file.slice(root.length + 1);
  return relative && !relative.includes('\0') && relative.split('/').every((part) => !!part && part !== '.' && part !== '..' && part !== '.git') ? relative : null;
}
export function docsAuthorized(scope: DocsScope, ctx: Ctx): boolean {
  // ctx is the trusted caller policy supplied by composition; it is never a model-facing project selector.
  return ctx.projectId === scope.projectId || Array.isArray(ctx.linked) && ctx.linked.includes(scope.projectId);
}
export class SqliteDocs implements ContextSource {
  readonly id = 'docs';
  readonly name = 'docs';
  readonly trust = 'verified';
  readonly weight = 0.8;
  readonly halfLifeDays = 90;
  readonly scope: Readonly<Required<DocsScope>>;
  #session: SqliteSession;
  constructor(session: SqliteSession, scope: DocsScope) { this.#session = session; this.scope = docsScope(scope); }
  get db(): SqliteDatabase {
    if (!this.#session.legacyDb) throw new MemoryError('unavailable', 'registered memory database is private');
    return this.#session.legacyDb;
  }
  close(): void { this.#session.close(); }
  async search(text: string, ctx: Ctx, limit: number): Promise<Hit[]> {
    if (!docsAuthorized(this.scope, ctx)) return [];
    if (typeof text !== 'string' || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new MemoryError('invalid', 'invalid docs query');
    const match = ftsQuery(text); if (!match) return [];
    const { root, projectId, excludedRoots } = this.scope; const prefix = root + '/';
    const excluded = excludedRoots.map(() => 'AND substr(d.path, 1, ?) <> ?').join(' ');
    try {
      return this.#session.read((db) => db.prepare(`SELECT d.path, d.title, d.mtime, d.body,
        snippet(docs_fts, 1, '', '', '…', 32) AS text, bm25(docs_fts) AS rank
        FROM docs_fts JOIN docs d ON d.seq = docs_fts.rowid
        WHERE docs_fts MATCH ? AND d.project_id = ? AND substr(d.path, 1, ?) = ? ${excluded}
        ORDER BY bm25(docs_fts) LIMIT ?`).all(match, projectId, prefix.length, prefix,
          ...excludedRoots.flatMap((value) => [value.length + 1, value + '/']), limit)
        .flatMap((row) => {
          try { screenPublicText(row.body as string); screenPublicText(row.title as string); } catch { return []; }
          const id = docsRelative(root, row.path as string);
          return id === null ? [] : [{ source: 'docs', id, title: row.title as string, text: row.text as string,
            category: 'doc', rank: row.rank as number, at: row.mtime as number, accessCount: 0 }];
        }));
    } catch { throw new MemoryError('unavailable', 'docs query unavailable'); }
  }
}
