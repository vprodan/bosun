import type { SqliteDatabase } from './sqlite.ts';
import fs from 'node:fs';
import { realpathWithoutOpen } from './canonical-path.cjs';
import { BosunError } from '../core/errors.ts';
import { openOwnedSqlite } from './sqlite-owned.ts';

// Separate native lock file, held for the daemon lifetime; process exit releases SQLite's lock.
export class DaemonOwner {
  #db: SqliteDatabase | null = null;
  #file: string; #identity: fs.Stats | null = null;
  constructor(file: string) {
    this.#file = file;
    let db: SqliteDatabase | undefined;
    try {
      db = openOwnedSqlite(file, { readOnly: true });
      const rows = db.prepare("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 2").all();
      if (rows.length > 1 || rows.length === 1 && (rows[0].name !== 'daemon_owner'
        || String(rows[0].sql).replace(/\s+/g, ' ').trim() !== 'CREATE TABLE daemon_owner (id INTEGER PRIMARY KEY CHECK(id=1))')) throw 0;
      db.close(); db = undefined;
      db = openOwnedSqlite(file);
      db.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS daemon_owner (id INTEGER PRIMARY KEY CHECK(id=1)); BEGIN EXCLUSIVE;');
      this.#db = db;
      this.#identity = fs.lstatSync(file);
    } catch { try { db?.close(); } catch {} throw new BosunError('unavailable', 'Daemon owner unavailable'); }
  }
  assert(): void {
    if (!this.#db?.isTransaction) throw new BosunError('unavailable', 'Daemon owner unavailable');
    try {
      const stat = fs.lstatSync(this.#file);
      if (!this.#identity || !stat.isFile() || stat.nlink !== 1 || stat.dev !== this.#identity.dev || stat.ino !== this.#identity.ino
        || (stat.mode & 0o7777) !== 0o600 || realpathWithoutOpen(this.#file) !== this.#file
        || process.getuid && stat.uid !== process.getuid()) throw 0;
    } catch { throw new BosunError('unavailable', 'Daemon owner unavailable'); }
  }
  close(): void {
    const db = this.#db; this.#db = null;
    if (!db) return;
    try { db.exec('ROLLBACK'); db.close(); }
    catch { try { db.close(); } catch {} throw new BosunError('unavailable', 'Daemon owner unavailable'); }
  }
}
