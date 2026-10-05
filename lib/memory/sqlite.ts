// SQLite through node:sqlite: open (0600, WAL), ordered migrations in transactions, FTS5 query building, text hashing.
import crypto from 'node:crypto';
import { norm } from '../../src/core/text.ts';
export { terms, ftsQuery, norm, words, jaccard } from '../../src/core/text.ts';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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

// ── Text: deterministic query terms (user text never becomes FTS syntax), hashing, word-set overlap ──
export const contentHash = (title: string, body: string): string =>
  crypto.createHash('sha256').update(norm(`${title}\n${body}`)).digest('hex').slice(0, 32);
