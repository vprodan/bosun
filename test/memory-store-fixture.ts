import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SqliteDatabase } from '../src/platform/sqlite.ts';
import { defaultConfig, type RuntimeConfig } from '../src/core/domain/config.ts';
import { MEMORY_MIGRATIONS } from '../src/adapters/memory/sqlite-schema.ts';
import { CutoverWriter, type CutoverPaths } from '../src/adapters/memory/sqlite-cutover.ts';
import { SqliteMemoryStore, type MemoryDependencies } from '../src/adapters/memory/sqlite-store.ts';
import { plainSession, type SqliteSession } from '../src/adapters/memory/sqlite-session.ts';
import { contentHash } from '../src/platform/content-hash.ts';
import { renderRuntimeConfig } from '../src/platform/config.ts';
import { runtimePaths, type RuntimePaths } from '../src/platform/paths.ts';

// Owner/storage fixtures use the shipped path and config APIs. Preparation is
// explicit because runtime config reads are deliberately side-effect free.
export function prepareTestRuntime(): RuntimePaths {
  const paths = runtimePaths(process.env);
  fs.mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  fs.chmodSync(paths.home, 0o700);
  if (!fs.existsSync(paths.config))
    fs.writeFileSync(paths.config, renderRuntimeConfig(defaultConfig()), { mode: 0o600 });
  return paths;
}

export function testCutoverPaths(paths: RuntimePaths = runtimePaths(process.env)): CutoverPaths {
  return { primary: paths.memory, view: paths.view, backups: paths.backups };
}

// Several supported owner workflows start from the documented schema-1
// database. Keep this minimal initializer in test code; production owns
// initialization and schema changes through sqlite-initialize/sqlite-cutover.
export function openSchemaOneMemory(file: string): SqliteDatabase {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.closeSync(fs.openSync(file, 'a', 0o600));
  fs.chmodSync(file, 0o600);
  const db = new SqliteDatabase(file);
  try {
    db.exec('PRAGMA busy_timeout=2000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');
    const initialized = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
    if (!initialized) {
      db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
      db.exec(MEMORY_MIGRATIONS[0]);
      db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(1,?)').run(Date.now());
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function dependencies(config: RuntimeConfig): MemoryDependencies {
  return {
    now: () => Date.now(),
    retention: {
      sessionTtlDays: config.memory.sessionTtlDays,
      purgeAfterDays: config.memory.purgeAfterDays,
    },
    id: (now) => `m_${now.toString(32).padStart(9, '0')}${crypto.randomBytes(4).toString('hex')}`,
    hash: contentHash,
    monotonic: () => performance.now(),
    measure() {},
  };
}

export function createTestMemoryStore(
  db: SqliteDatabase | SqliteSession,
  config: RuntimeConfig = defaultConfig(),
): SqliteMemoryStore {
  const session = 'transaction' in db ? db : plainSession(db);
  return new SqliteMemoryStore(session, dependencies(config));
}

export function openTestLocalMemory(paths: CutoverPaths): SqliteMemoryStore {
  return createTestMemoryStore(new CutoverWriter(paths));
}
