import { GRAPH_SCHEMA_SQL } from './sqlite-graph-schema.ts';
// Schema1 remains a documented upgrade source. New installations use the complete schema2.
export const MEMORY_SCHEMA_VERSION = 2;
export const MEMORY_MIGRATIONS: readonly string[] = Object.freeze([`
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
`, GRAPH_SCHEMA_SQL]);
