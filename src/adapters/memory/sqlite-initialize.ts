import fs from 'node:fs';
import path from 'node:path';
import type { SqliteDatabase } from '../../platform/sqlite.ts'
import { BosunError } from '../../core/errors.ts';
import { openOwnedSqlite } from '../../platform/sqlite-owned.ts';
import { MEMORY_MIGRATIONS, MEMORY_SCHEMA_VERSION } from './sqlite-schema.ts';

// Explicit new-only admin setup. Normal daemon open never calls this initializer.
export function initializeMemory({ file, assertOwner, now }: { file: string; assertOwner(): void; now(): number }): { schema: 2 } {
  let db: SqliteDatabase | undefined; let commitAttempted = false; let committed = false; let failure: unknown;
  try {
    assertOwner(); const at = now();
    if (!Number.isSafeInteger(at) || at < 0 || at > 8_640_000_000_000_000) throw 0;
    if (typeof file !== 'string' || !path.isAbsolute(file) || path.resolve(file) !== file || file.includes('\0')) throw 0;
    const parent = path.dirname(file); const stat = fs.lstatSync(parent);
    if (!stat.isDirectory() || (stat.mode & 0o7777) !== 0o700 || fs.realpathSync(parent) !== parent
      || process.getuid && stat.uid !== process.getuid()) throw 0;
    // Atomic refusal of every existing file, including an empty previous attempt. Never adopt or remove it.
    assertOwner();
    for (const suffix of ['-wal', '-shm', '-journal']) {
      try { fs.lstatSync(file + suffix); throw 0; }
      catch (e) { if (!e || typeof e !== 'object' || (e as { code?: string }).code !== 'ENOENT') throw e; }
    }
    fs.closeSync(fs.openSync(file, 'wx', 0o600));
    assertOwner(); db = openOwnedSqlite(file);
    db.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
    db.exec('BEGIN IMMEDIATE');
    db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
    for (const [index, migration] of MEMORY_MIGRATIONS.entries()) {
      db.exec(migration); db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)').run(index + 1, at);
    }
    if (MEMORY_MIGRATIONS.length !== MEMORY_SCHEMA_VERSION) throw 0;
    assertOwner(); commitAttempted = true; db.exec('COMMIT'); committed = true;
  } catch { failure = new BosunError('unavailable', 'Memory initialization unavailable', commitAttempted ? { details: { outcome: 'unknown' } } : undefined); }
  finally {
    if (db) {
      try { if (db.isTransaction) db.exec('ROLLBACK'); }
      catch { failure = new BosunError('unavailable', 'Memory initialization unavailable', { details: { outcome: 'unknown' } }); }
      try { db.close(); }
      catch { failure ??= new BosunError('unavailable', 'Memory initialization unavailable', committed ? { details: { outcome: 'unknown' } } : undefined); }
    }
  }
  if (failure) throw failure;
  return { schema: 2 };
}
