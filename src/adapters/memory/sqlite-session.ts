import type { SqliteDatabase } from '../../platform/sqlite.ts'

export function tx<T>(db: SqliteDatabase, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// Internal synchronous SQL lifecycle, not another domain port. Registered native handles remain callback-local.
export type SqliteSession = {
  readonly legacyDb?: SqliteDatabase;
  read<T>(fn: (db: SqliteDatabase) => T): T;
  transaction<T>(fn: (db: SqliteDatabase) => T): T;
  close(): void;
};
export function plainSession(db: SqliteDatabase): SqliteSession {
  return { legacyDb: db, read: (fn) => fn(db), transaction: (fn) => tx(db, () => fn(db)), close: () => db.close() };
}
