// Compatibility composition: search still explicitly indexes until daemon callers/scheduling migrate.
import type { DatabaseSync } from 'node:sqlite';
import { record } from '../metrics.ts';
import { ftsQuery, plainSession, type SqliteSession } from './sqlite.ts';
import { MemoryError, type Ctx, type Hit, type MemoryProvider } from './types.ts';
import { SqliteDocs, docsAuthorized } from '../../src/adapters/memory/sqlite-docs.ts';
import { SqliteDocsIndex } from '../../src/adapters/memory/sqlite-docs-index.ts';
import { checkDocsStorage, enumerateDocs, inspectDoc, resolveDocsRoot } from '../../src/adapters/memory/docs-filesystem.ts';

export class Docs implements MemoryProvider {
  name = 'docs' as const;
  #session: SqliteSession;
  #query?: SqliteDocs;
  #ready = false;
  readonly dir: string;
  readonly projectId: string;
  top = '';
  constructor(db: DatabaseSync | SqliteSession, dir: string, projectId: string) {
    this.#session = 'transaction' in db ? db : plainSession(db); this.dir = dir; this.projectId = projectId;
  }
  get db(): DatabaseSync {
    if (!this.#session.legacyDb) throw new MemoryError('unavailable', 'registered memory database is private');
    return this.#session.legacyDb;
  }
  close(): void { this.#session.close(); }
  index(): { changed: number; removed: number } {
    this.#ready = false;
    const root = resolveDocsRoot(this.dir);
    if (!root || this.#query && root !== this.#query.scope.root) return { changed: 0, removed: 0 };
    const scope = { root, projectId: this.projectId, excludedRoots: this.#query?.scope.excludedRoots };
    const result = new SqliteDocsIndex(this.#session, scope, {
      enumerate: enumerateDocs, inspect: inspectDoc, checkStorage: checkDocsStorage, monotonic: () => performance.now(), measure: record,
    }).index();
    if (result.state === 'indexed') {
      this.#query = new SqliteDocs(this.#session, { ...scope, excludedRoots: result.excludedRoots });
      this.top = root; this.#ready = true;
    }
    return { changed: result.changed, removed: result.removed };
  }
  async search(text: string, ctx: Ctx, limit: number): Promise<Hit[]> {
    if (!docsAuthorized({ root: this.top, projectId: this.projectId }, ctx)) return [];
    if (typeof text !== 'string' || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new MemoryError('invalid', 'invalid docs query');
    if (!ftsQuery(text)) return [];
    this.index();
    return this.#ready ? this.#query!.search(text, ctx, limit) : [];
  }
}
