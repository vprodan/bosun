// SQLite through node:sqlite: open (0600, WAL), ordered migrations in transactions, FTS5 query building, text hashing.
import crypto from 'node:crypto';
import { norm } from '../../src/core/text.ts';
export { terms, ftsQuery, norm, words, jaccard } from '../../src/core/text.ts';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CutoverWriter, CutoverError, publishMemoryView, hasPendingMemoryRestore, type CutoverPaths, type PublicationReceipt } from '../../src/adapters/memory/sqlite-cutover.ts';
import { planOwnerCutover, planOwnerRecovery, applyOwnerCutover, planOwnerPreparation, prepareOwnerLayout, planOwnerRestore, applyOwnerRestore,
  type OwnerCutoverPlan, type OwnerCutoverReceipt, type OwnerPreparationPlan, type OwnerPreparationReceipt, type OwnerRestorePlan, type OwnerRestoreReceipt } from '../../src/adapters/memory/sqlite-owner.ts';
import { MemoryError } from './types.ts';
import { P, type Cfg } from '../config.ts';
import { log } from '../log.ts';
import { record } from '../metrics.ts';

export const MIGRATIONS: string[] = [`
CREATE TABLE memories (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL CHECK (category IN ('personal','project','session')),
  project_id TEXT,
  session_id TEXT,
  title TEXT NOT NULL, body TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','proposed','archived')),
  shared INTEGER NOT NULL DEFAULT 0, private INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL, source_ref TEXT, hash TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER,
  accessed_at INTEGER, access_count INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1,
  CHECK ((category = 'personal') = (project_id IS NULL))
);
CREATE UNIQUE INDEX memories_dedupe ON memories(COALESCE(project_id, ''), category, hash) WHERE status <> 'archived';
CREATE INDEX memories_scope ON memories(project_id, category, status);
CREATE INDEX memories_expiry ON memories(expires_at) WHERE expires_at IS NOT NULL;
CREATE VIRTUAL TABLE memories_fts USING fts5(title, body, tags, content='memories', content_rowid='seq', tokenize='porter unicode61');
CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, title, body, tags) VALUES (new.seq, new.title, new.body, new.tags);
END;
CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, body, tags) VALUES ('delete', old.seq, old.title, old.body, old.tags);
END;
CREATE TRIGGER memories_au AFTER UPDATE OF title, body, tags ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, body, tags) VALUES ('delete', old.seq, old.title, old.body, old.tags);
  INSERT INTO memories_fts(rowid, title, body, tags) VALUES (new.seq, new.title, new.body, new.tags);
END;
CREATE TABLE memory_events (id INTEGER PRIMARY KEY, memory_id TEXT NOT NULL, op TEXT NOT NULL, at INTEGER NOT NULL,
  source TEXT NOT NULL, hash_before TEXT, hash_after TEXT);
CREATE INDEX memory_events_memory ON memory_events(memory_id);
CREATE TABLE docs (seq INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL, mtime INTEGER NOT NULL, title TEXT, body TEXT NOT NULL);
CREATE VIRTUAL TABLE docs_fts USING fts5(title, body, content='docs', content_rowid='seq', tokenize='porter unicode61');
CREATE TRIGGER docs_ai AFTER INSERT ON docs BEGIN INSERT INTO docs_fts(rowid, title, body) VALUES (new.seq, new.title, new.body); END;
CREATE TRIGGER docs_ad AFTER DELETE ON docs BEGIN INSERT INTO docs_fts(docs_fts, rowid, title, body) VALUES ('delete', old.seq, old.title, old.body); END;
CREATE TRIGGER docs_au AFTER UPDATE ON docs BEGIN
  INSERT INTO docs_fts(docs_fts, rowid, title, body) VALUES ('delete', old.seq, old.title, old.body);
  INSERT INTO docs_fts(rowid, title, body) VALUES (new.seq, new.title, new.body);
END;
`];

export function openDb(file: string, migrations: string[] = MIGRATIONS): DatabaseSync {
  const t = performance.now();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.closeSync(fs.openSync(file, 'a', 0o600));   // exists as 0600 before SQLite opens it; -wal and -shm copy its mode
  fs.chmodSync(file, 0o600);
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout = 2000; PRAGMA foreign_keys = ON;');
    wal(db);
    migrate(db, migrations);
  } catch (e) { db.close(); throw e; }
  record({ op: 'db.open', ms: performance.now() - t });
  return db;
}

// Switching to WAL needs an exclusive lock, and SQLite skips the busy handler for that upgrade: two processes creating
// the database at once deadlock and one gets SQLITE_BUSY at once. Retry for up to 2 s (the busy_timeout). WAL persists
// in the file, so only the very first open ever switches.
function wal(db: DatabaseSync): void {
  for (let i = 0; ; i++) {
    try { db.exec('PRAGMA journal_mode = WAL'); return; } catch (e) {
      if (i >= 40 || (e as { errcode?: number }).errcode !== 5) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

export const schemaVersion = (db: DatabaseSync): number =>
  Number((db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get() as { v: number }).v);

// Each migration runs with its schema_migrations row in one BEGIN IMMEDIATE; an error rolls it back and aborts.
// The version is re-read inside the transaction, so processes opening a new database at once migrate it only once.
export function migrate(db: DatabaseSync, migrations: string[] = MIGRATIONS): number {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
  while (schemaVersion(db) < migrations.length) {
    tx(db, () => {
      const v = schemaVersion(db);
      if (v >= migrations.length) return;
      db.exec(migrations[v]);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(v + 1, Date.now());
      log('info', 'db.migrate', { version: v + 1 });
    });
  }
  return schemaVersion(db);
}

export function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// Internal synchronous SQL lifecycle, not another domain port. Registered native handles remain callback-local.
export type SqliteSession = {
  readonly legacyDb?: DatabaseSync;
  read<T>(fn: (db: DatabaseSync) => T): T;
  transaction<T>(fn: (db: DatabaseSync) => T): T;
  close(): void;
};
export function plainSession(db: DatabaseSync): SqliteSession {
  return { legacyDb: db, read: (fn) => fn(db), transaction: (fn) => tx(db, () => fn(db)), close: () => db.close() };
}
export function writerPaths(file: string, cfg: Cfg): CutoverPaths {
  return { primary: file, view: cfg.MEMORY_VIEW_PATH || path.join(path.dirname(file), 'memory-view', 'public.db'),
    backups: cfg.MEMORY_BACKUP_DIR || path.join(path.dirname(file), 'memory-backups') };
}
export function planLocalMemoryCutover(cfg: Cfg, file = P.DB, input: { retainUnreferenced?: boolean } = {}): OwnerCutoverPlan {
  if (cfg.MEMORY_URL) throw new MemoryError('unavailable', 'local cutover unavailable (remote)');
  const request = ownerRequest<typeof input>(input, ['retainUnreferenced']);
  return planOwnerCutover({ ...request, paths: writerPaths(file, cfg), now: Date.now, id: crypto.randomUUID });
}
export function planLocalMemoryRecovery(cfg: Cfg, input: { sourceId: string; retainUnreferenced?: boolean }, file = P.DB): OwnerCutoverPlan {
  if (cfg.MEMORY_URL) throw new MemoryError('unavailable', 'local cutover unavailable (remote)');
  const request = ownerRequest<typeof input>(input, ['sourceId', 'retainUnreferenced']);
  return planOwnerRecovery({ ...request, paths: writerPaths(file, cfg), now: Date.now });
}
export function planLocalMemoryRestore(cfg: Cfg, input: { sourceId: string; newSourceId?: string; retainUnreferenced?: boolean }, file = P.DB): OwnerRestorePlan {
  if (cfg.MEMORY_URL) throw new MemoryError('unavailable', 'local cutover unavailable (remote)');
  const request = ownerRequest<typeof input>(input, ['sourceId', 'newSourceId', 'retainUnreferenced']);
  return planOwnerRestore({ ...request, paths: writerPaths(file, cfg), now: Date.now, id: crypto.randomUUID });
}
export async function applyLocalMemoryRestore(cfg: Cfg, input: { plan: string; operation: 'restore' | 'restore-reconcile'; sourceId: string;
  newSourceId: string; clientsStopped: boolean; retainUnreferenced?: boolean }, file = P.DB): Promise<OwnerRestoreReceipt> {
  if (cfg.MEMORY_URL) throw new MemoryError('unavailable', 'local cutover unavailable (remote)');
  const request = ownerRequest<typeof input>(input, ['plan', 'operation', 'sourceId', 'newSourceId', 'clientsStopped', 'retainUnreferenced']);
  return applyOwnerRestore({ ...request, paths: writerPaths(file, cfg), now: Date.now });
}
function ownerRequest<T>(input: unknown, names: string[]): T {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Reflect.ownKeys(input).some((key) => typeof key !== 'string' || !names.includes(key))) throw 0;
    const request: Record<string, unknown> = {};
    for (const name of names) {
      const d = Object.getOwnPropertyDescriptor(input, name);
      if (d && !Object.hasOwn(d, 'value')) throw 0;
      Object.defineProperty(request, name, { value: d?.value, enumerable: true });
    }
    return request as T;
  } catch { throw new MemoryError('invalid', 'invalid owner cutover request'); }
}
export async function applyLocalMemoryCutover(cfg: Cfg, input: { plan: string; operation: 'apply' | 'reconcile' | 'recover'; sourceId?: string; clientsStopped: boolean; retainUnreferenced?: boolean }, file = P.DB): Promise<OwnerCutoverReceipt> {
  if (cfg.MEMORY_URL) throw new MemoryError('unavailable', 'local cutover unavailable (remote)');
  const request = ownerRequest<typeof input>(input, ['plan', 'operation', 'sourceId', 'clientsStopped', 'retainUnreferenced']);
  return applyOwnerCutover({ ...request, paths: writerPaths(file, cfg), now: Date.now, id: crypto.randomUUID });
}
export function planLocalMemoryPreparation(cfg: Cfg, input: { createViewDirectory?: boolean; createBackupDirectory?: boolean } = {}, file = P.DB): OwnerPreparationPlan {
  if (cfg.MEMORY_URL) throw new MemoryError('unavailable', 'local cutover unavailable (remote)');
  const request = ownerRequest<typeof input>(input, ['createViewDirectory', 'createBackupDirectory']);
  return planOwnerPreparation({ ...request, paths: writerPaths(file, cfg), now: Date.now });
}
export function prepareLocalMemoryLayout(cfg: Cfg, input: { plan: string; clientsStopped: boolean }, file = P.DB): OwnerPreparationReceipt {
  if (cfg.MEMORY_URL) throw new MemoryError('unavailable', 'local cutover unavailable (remote)');
  const request = ownerRequest<typeof input>(input, ['plan', 'clientsStopped']);
  return prepareOwnerLayout({ ...request, paths: writerPaths(file, cfg), now: Date.now });
}
export async function publishLocalMemory(cfg: Cfg, file = P.DB): Promise<PublicationReceipt> {
  if (cfg.MEMORY_URL) throw new MemoryError('unavailable', 'local publication unavailable');
  try { return await publishMemoryView({ paths: writerPaths(file, cfg), now: Date.now, id: crypto.randomUUID }); }
  catch (e) {
    let unknown = false; try { unknown = e instanceof CutoverError && e.reason === 'receipt_unknown'; } catch {}
    if (unknown) throw new MemoryError('unavailable', 'local publication outcome unknown; explicitly publish again');
    return storageError(e);
  }
}
function storageError(e: unknown): never {
  let domain: MemoryError | undefined;
  try { if (e instanceof MemoryError) {
    const code = Object.getOwnPropertyDescriptor(e, 'code'); const message = Object.getOwnPropertyDescriptor(e, 'message');
    if (code && 'value' in code && ['not_found', 'conflict', 'invalid', 'unavailable'].includes(code.value)
      && message && 'value' in message && typeof message.value === 'string') domain = e;
  } } catch {}
  if (domain) throw domain;
  throw new MemoryError('unavailable', 'local memory unavailable');
}
function present(file: string): boolean {
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.resolve(file) !== file || file.includes('\0')) throw new MemoryError('unavailable', 'local memory unavailable');
  let current = file; let exists = true;
  // ENOENT in a dangling ancestor must not masquerade as a clean absent gate.
  for (;;) {
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || (current === file ? !stat.isFile() : !stat.isDirectory()) || fs.realpathSync(current) !== current) throw new MemoryError('unavailable', 'local memory unavailable');
      // Canonicalization validates all ancestors without inspecting unrelated filesystem roots.
      return exists;
    } catch (e) {
      let absent = false;
      try { absent = !!e && typeof e === 'object' && Object.getOwnPropertyDescriptor(e, 'code')?.value === 'ENOENT'; } catch {}
      if (absent && current !== path.dirname(current)) { exists = false; current = path.dirname(current); continue; }
      return storageError(e);
    }
  }
}
/** Probe before legacy chmod/migration. A floor/pending gate can never fall back to a plain connection. */
export function openLocalSqlite(file: string, cfg: Cfg): SqliteSession {
  let probe: DatabaseSync | undefined;
  try {
    const p = writerPaths(file, cfg);
    if (hasPendingMemoryRestore(p.view)) throw new MemoryError('unavailable', 'local memory unavailable');
    let floored = false;
    const pendingGate = present(p.view);
    if (present(file)) {
      probe = new DatabaseSync(file, { readOnly: true, allowExtension: false, defensive: true });
      probe.exec('PRAGMA query_only=ON; PRAGMA temp_store=MEMORY; PRAGMA busy_timeout=0;');
      floored = !!probe.prepare("SELECT 1 FROM sqlite_master WHERE name LIKE 'bosun_%' LIMIT 1").get();
      probe.close(); probe = undefined;
    }
    if (!floored && (cfg.MEMORY_VIEW_PATH || cfg.MEMORY_BACKUP_DIR || pendingGate)) throw new MemoryError('unavailable', 'local memory unavailable');
    if (!floored) return plainSession(openDb(file));
    const writer = new CutoverWriter(p);
    return {
      read(fn) { try { return writer.read(fn); } catch (e) { return storageError(e); } },
      transaction(fn) { try { return writer.transaction(fn); } catch (e) { return storageError(e); } },
      close() { try { writer.close(); } catch (e) { storageError(e); } },
    };
  } catch (e) { return storageError(e); }
  finally { if (probe) try { probe.close(); } catch { /* finite unavailable was already selected */ } }
}

/** Doctor never creates/migrates or opens mutable WAL state. A header is not schema evidence. */
export function inspectMemorySchema(file: string): { state: 'missing' | 'wal-held' | 'verified' | 'unavailable'; version?: number } {
  let db: DatabaseSync | undefined;
  try {
    if (!present(file)) return { state: 'missing' };
    if (!path.isAbsolute(file) || path.resolve(file) !== file || fs.realpathSync(file) !== file || !fs.statSync(file).isFile()) return { state: 'unavailable' };
    const header = Buffer.alloc(100); const fd = fs.openSync(file, 'r');
    try { if (fs.readSync(fd, header, 0, 100, 0) !== 100) return { state: 'unavailable' }; } finally { fs.closeSync(fd); }
    if (header.toString('ascii', 0, 16) !== 'SQLite format 3\0') return { state: 'unavailable' };
    if (header[18] === 2 || header[19] === 2) return { state: 'wal-held' };
    if (header[18] !== 1 || header[19] !== 1 || ['-journal', '-wal', '-shm'].some((suffix) => fs.existsSync(file + suffix))) return { state: 'unavailable' };
    db = new DatabaseSync(file, { readOnly: true, allowExtension: false, defensive: true });
    db.exec('PRAGMA query_only=ON; PRAGMA temp_store=MEMORY; PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE;');
    const rows = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all();
    return rows.length === 1 && rows[0].version === 1 ? { state: 'verified', version: 1 } : { state: 'unavailable' };
  } catch { return { state: 'unavailable' }; }
  finally { try { db?.close(); } catch {} }
}

// ── Text: deterministic query terms (user text never becomes FTS syntax), hashing, word-set overlap ──
export const contentHash = (title: string, body: string): string =>
  crypto.createHash('sha256').update(norm(`${title}\n${body}`)).digest('hex').slice(0, 32);
