import type { DatabaseSync } from 'node:sqlite';

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
