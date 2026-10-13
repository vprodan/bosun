import fs from 'node:fs';
import { SqliteDatabase } from '../../platform/sqlite.ts'
import { BosunError } from '../../core/errors.ts';
import {
  parseRemoteView,
  remoteViewUuid,
  type RemoteViewSnapshot,
} from '../../core/remote-view.ts';
import { contentHash } from '../../platform/content-hash.ts';
import { openOwnedSqlite } from '../../platform/sqlite-owned.ts';
import { checkRemoteViewFile } from './remote-view-file.ts';
import { REMOTE_VIEW_SQL, type RemoteViewIntent } from './remote-view-protocol.ts';

type State = 'held' | 'pending' | 'ready' | 'acquire-unknown' | 'release-unknown';
export class RemoteViewCache {
  #db: SqliteDatabase;
  #owner: () => void;
  #held = false;
  constructor(file: string, assertOwner: () => void) {
    this.#owner = assertOwner;
    assertOwner();
    const exists = fs.existsSync(file);
    let db: SqliteDatabase | undefined;
    try {
      if (exists) {
        checkRemoteViewFile(file);
        db = openOwnedSqlite(file, { readOnly: true });
        this.#schema(db);
        db.close();
        db = undefined;
      }
      this.#db = db = openOwnedSqlite(file);
      db.exec(
        'PRAGMA journal_mode=DELETE;PRAGMA busy_timeout=0;PRAGMA synchronous=FULL;PRAGMA cache_spill=OFF;',
      );
      if (!exists) db.exec(REMOTE_VIEW_SQL);
      this.current();
      // No network on startup. Make the previous process's view unreadable, retaining its original lease intent.
      this.hold();
    } catch (error) {
      try {
        db?.close();
      } catch {}
      throw error instanceof BosunError
        ? error
        : new BosunError('unavailable', 'Remote view cache unavailable');
    }
  }
  #schema(db: SqliteDatabase) {
    const objects = db
      .prepare("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
      .all();
    if (
      objects.length !== 1 ||
      objects[0].name !== 'remote_view' ||
      objects[0].sql !== REMOTE_VIEW_SQL
    )
      throw new BosunError('unavailable', 'Remote cache schema unavailable');
  }
  #active() {
    this.#owner();
    if (this.#held)
      throw new BosunError('unavailable', 'Remote cache receipt unknown', {
        details: { outcome: 'unknown' },
      });
  }
  #tx(run: () => void) {
    this.#active();
    let commit = false;
    try {
      this.#db.exec('BEGIN IMMEDIATE');
      run();
      this.#active();
      commit = true;
      this.#db.exec('COMMIT');
    } catch (error) {
      // A native BUSY at COMMIT is a positive refusal while the transaction remains active.
      const busy =
        (error as { errcode?: number }).errcode === 5 && (!commit || this.#db.isTransaction);
      if (commit && !busy) this.#held = true;
      try {
        if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
      } catch {
        this.#held = true;
      }
      if (this.#held)
        throw new BosunError('unavailable', 'Remote cache receipt unknown', {
          details: { outcome: 'unknown' },
        });
      if (busy) throw new BosunError('conflict', 'Remote reader still holds the view');
      throw error;
    }
  }
  current(): { state: State; intent: RemoteViewIntent } | null {
    this.#active();
    const row = this.#db.prepare('SELECT state,intent FROM remote_view WHERE singleton=1').get();
    if (!row) return null;
    const value = JSON.parse(String(row.intent)) as RemoteViewIntent;
    if (
      !['held', 'pending', 'ready', 'acquire-unknown', 'release-unknown'].includes(
        String(row.state),
      ) ||
      !value ||
      Object.keys(value).length !== 7 ||
      ![value.id, value.clientId, value.clientSourceId, value.authorityId].every(remoteViewUuid) ||
      !/^[a-f0-9]{64}$/.test(value.configRevision) ||
      !/^p_[a-f0-9]{16}$/.test(value.projectId) ||
      (value.sessionId !== null &&
        (typeof value.sessionId !== 'string' || value.sessionId.length > 200))
    )
      throw new BosunError('unavailable', 'Remote cache intent unavailable');
    return { state: row.state as State, intent: value };
  }
  hold() {
    const previous = this.current();
    if (!previous) return null;
    this.#tx(() =>
      this.#db
        .prepare(
          "UPDATE remote_view SET state=CASE WHEN state IN ('acquire-unknown','release-unknown','pending') THEN state ELSE 'held' END,snapshot=NULL,cached_at=NULL,expires_at=NULL WHERE singleton=1",
        )
        .run(),
    );
    return this.current();
  }
  reserve(intent: RemoteViewIntent) {
    if (this.current()) throw new BosunError('conflict', 'Release the original remote view first');
    this.#tx(() =>
      this.#db
        .prepare("INSERT INTO remote_view VALUES(1,'pending',?,NULL,NULL,NULL)")
        .run(JSON.stringify(intent)),
    );
  }
  ready(snapshot: RemoteViewSnapshot, at: number, ttlMs: number) {
    const prior = this.current();
    parseRemoteView(snapshot, contentHash);
    if (
      !prior ||
      prior.state !== 'pending' ||
      snapshot.id !== prior.intent.id ||
      snapshot.clientId !== prior.intent.clientId ||
      snapshot.authorityId !== prior.intent.authorityId ||
      snapshot.projectId !== prior.intent.projectId ||
      snapshot.sessionId !== prior.intent.sessionId ||
      !Number.isSafeInteger(at) ||
      at < snapshot.createdAt - 5000 ||
      !Number.isInteger(ttlMs) ||
      ttlMs < 1000 ||
      ttlMs > 3600000
    )
      throw new BosunError('conflict', 'Remote cache binding changed');
    this.#tx(() =>
      this.#db
        .prepare(
          "UPDATE remote_view SET state='ready',snapshot=?,cached_at=?,expires_at=? WHERE singleton=1",
        )
        .run(JSON.stringify(snapshot), at, at + ttlMs),
    );
  }
  phase(state: 'held' | 'acquire-unknown' | 'release-unknown') {
    this.#tx(() =>
      this.#db
        .prepare(
          'UPDATE remote_view SET state=?,snapshot=NULL,cached_at=NULL,expires_at=NULL WHERE singleton=1',
        )
        .run(state),
    );
  }
  status() {
    const current = this.current();
    if (!current) return { state: 'empty', id: null, projectId: null, expiresAt: null };
    const row = this.#db
      .prepare('SELECT cached_at,expires_at FROM remote_view WHERE singleton=1')
      .get()!;
    const now = Date.now(),
      at = Number(row.cached_at),
      expiry = Number(row.expires_at);
    const invalid =
      current.state === 'ready' &&
      (!Number.isSafeInteger(at) ||
        !Number.isSafeInteger(expiry) ||
        expiry - at < 1000 ||
        expiry - at > 3600000 ||
        now < at ||
        now >= expiry);
    return {
      state: invalid ? 'expired' : current.state,
      id: current.intent.id,
      projectId: current.intent.projectId,
      expiresAt: current.state === 'ready' ? expiry : null,
    };
  }
  clear() {
    this.#tx(() => this.#db.prepare('DELETE FROM remote_view WHERE singleton=1').run());
  }
  close() {
    this.#db.close();
  }
}
