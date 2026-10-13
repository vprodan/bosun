import fs from 'node:fs';
import { SqliteDatabase } from '../../platform/sqlite.ts'
import { BosunError, MemoryError } from '../../core/errors.ts';
import { openOwnedSqlite } from '../../platform/sqlite-owned.ts';
import { remoteViewUuid } from '../../core/remote-view.ts';
import { checkRemoteViewFile } from './remote-view-file.ts';

const SQL = `CREATE TABLE remote_leases (id TEXT PRIMARY KEY,project_id TEXT NOT NULL,client_id TEXT NOT NULL,source_id TEXT NOT NULL,grant_hash TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('active','retired')),created_at INTEGER NOT NULL,retired_at INTEGER)`;
export type RemoteLease = {
  id: string;
  projectId: string;
  clientId: string;
  sourceId: string;
  grantHash: string;
  state: 'active' | 'retired';
  createdAt: number;
  retiredAt: number | null;
};
const bad = () =>
  new BosunError('unavailable', 'Remote view lease unavailable', {
    details: { outcome: 'unknown' },
  });
const uuid = remoteViewUuid;
export class RemoteLeaseStore {
  #db: SqliteDatabase;
  #held = false;
  #assert: () => void;
  constructor(file: string, assertOwner: () => void) {
    this.#assert = assertOwner;
    assertOwner();
    const exists = fs.existsSync(file);
    let db: SqliteDatabase | undefined;
    try {
      if (exists) {
        checkRemoteViewFile(file);
        db = openOwnedSqlite(file, { readOnly: true });
        const objects = db
          .prepare("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
          .all();
        if (objects.length !== 1 || objects[0].name !== 'remote_leases' || objects[0].sql !== SQL)
          throw bad();
        db.close();
        db = undefined;
      }
      this.#db = db = openOwnedSqlite(file);
      db.exec('PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=0; PRAGMA synchronous=FULL;');
      if (!exists) db.exec(SQL);
      for (const row of db.prepare('SELECT * FROM remote_leases').all()) this.#row(row);
      const counts = this.status();
      if (counts.active > 64 || counts.active + counts.retired > 4096) throw bad();
    } catch {
      try {
        db?.close();
      } catch {}
      throw bad();
    }
  }
  #active() {
    this.#assert();
    if (this.#held) throw bad();
  }
  #row(value: any): RemoteLease {
    if (
      !value ||
      !uuid(value.id) ||
      !uuid(value.client_id) ||
      !uuid(value.source_id) ||
      !/^p_[a-f0-9]{16}$/.test(value.project_id) ||
      !/^[a-f0-9]{64}$/.test(value.grant_hash) ||
      !['active', 'retired'].includes(value.state) ||
      !Number.isSafeInteger(value.created_at) ||
      value.created_at < 0 ||
      value.created_at > 8640000000000000 ||
      (value.state === 'active' && value.retired_at !== null) ||
      (value.state === 'retired' && value.retired_at === null) ||
      (value.retired_at !== null &&
        (!Number.isSafeInteger(value.retired_at) ||
          value.retired_at < value.created_at ||
          value.retired_at > 8640000000000000))
    )
      throw bad();
    return {
      id: value.id,
      projectId: value.project_id,
      clientId: value.client_id,
      sourceId: value.source_id,
      grantHash: value.grant_hash,
      state: value.state,
      createdAt: value.created_at,
      retiredAt: value.retired_at,
    };
  }
  #tx<T>(run: () => T): T {
    this.#active();
    let commit = false;
    try {
      this.#db.exec('BEGIN IMMEDIATE');
      const value = run();
      this.#active();
      commit = true;
      this.#db.exec('COMMIT');
      return value;
    } catch (error) {
      if (commit) this.#held = true;
      try {
        if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
      } catch {
        this.#held = true;
      }
      if (this.#held) throw bad();
      throw error;
    }
  }
  acquire(input: Omit<RemoteLease, 'state' | 'retiredAt'>): RemoteLease {
    const proposed = this.#row({
      id: input.id,
      project_id: input.projectId,
      client_id: input.clientId,
      source_id: input.sourceId,
      grant_hash: input.grantHash,
      state: 'active',
      created_at: input.createdAt,
      retired_at: null,
    });
    return this.#tx(() => {
      const previous = this.#db.prepare('SELECT * FROM remote_leases WHERE id=?').get(input.id);
      if (previous) {
        const row = this.#row(previous);
        if (
          row.state !== 'active' ||
          row.projectId !== input.projectId ||
          row.clientId !== input.clientId ||
          row.sourceId !== input.sourceId ||
          row.grantHash !== input.grantHash
        )
          throw new BosunError('conflict', 'Remote view lease binding changed');
        return row;
      }
      if (
        Number(this.#db.prepare('SELECT count(*) n FROM remote_leases').get()!.n) >= 4096 ||
        Number(
          this.#db.prepare("SELECT count(*) n FROM remote_leases WHERE state='active'").get()!.n,
        ) >= 64
      )
        throw new BosunError('unavailable', 'Remote view capacity held');
      this.#db
        .prepare("INSERT INTO remote_leases VALUES(?,?,?,?,?,'active',?,NULL)")
        .run(
          input.id,
          input.projectId,
          input.clientId,
          input.sourceId,
          input.grantHash,
          input.createdAt,
        );
      return proposed;
    });
  }
  release(id: string, projectId: string, clientId: string, at: number): RemoteLease {
    return this.#tx(() => {
      const row = this.#row(this.#db.prepare('SELECT * FROM remote_leases WHERE id=?').get(id));
      if (
        row.projectId !== projectId ||
        row.clientId !== clientId ||
        !Number.isSafeInteger(at) ||
        at < row.createdAt
      )
        throw new BosunError('conflict', 'Remote release binding changed');
      if (row.state === 'retired') return row;
      this.#db
        .prepare(
          "UPDATE remote_leases SET state='retired',retired_at=? WHERE id=? AND state='active'",
        )
        .run(at, id);
      return { ...row, state: 'retired', retiredAt: at };
    });
  }
  get(id: string, projectId: string, clientId: string): RemoteLease | null {
    this.#active();
    const raw = this.#db.prepare('SELECT * FROM remote_leases WHERE id=?').get(id);
    if (!raw) return null;
    const row = this.#row(raw);
    if (row.projectId !== projectId || row.clientId !== clientId)
      throw new BosunError('conflict', 'Remote lease binding changed');
    return row;
  }
  assertWritable() {
    this.#active();
    if (this.#db.prepare("SELECT 1 FROM remote_leases WHERE state='active' LIMIT 1").get())
      throw new MemoryError(
        'conflict',
        'Remote reader view must be invalidated before changing source data',
      );
  }
  status() {
    this.#active();
    return {
      active: Number(
        this.#db.prepare("SELECT count(*) n FROM remote_leases WHERE state='active'").get()!.n,
      ),
      retired: Number(
        this.#db.prepare("SELECT count(*) n FROM remote_leases WHERE state='retired'").get()!.n,
      ),
    };
  }
  close() {
    this.#db.close();
  }
}
