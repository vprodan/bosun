import './bootstrap.ts';
// Test-only protocol model. No production caller imports it; no owner DB is opened.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SqliteDatabase, sqliteConstants } from '../src/platform/sqlite.ts';
import { openSchemaOneMemory } from './memory-store-fixture.ts';
import { MEMORY_MIGRATIONS } from '../src/adapters/memory/sqlite-schema.ts';
import type { Ctx } from '../src/core/domain/memory.ts';

export const FLOOR_FN = 'bosun_read_view_floor_v1';
export const NOW = 100;
const admitted = new WeakSet<SqliteDatabase>();
export function beginAdmission(source: SqliteDatabase): void {
  source.exec('BEGIN IMMEDIATE'); admitted.add(source);
}
export function endAdmission(source: SqliteDatabase, commit: boolean): void {
  try { source.exec(commit ? 'COMMIT' : 'ROLLBACK'); } finally { admitted.delete(source); }
}
export function patchedVersion(version: string): boolean {
  const p = version.split('.').map(Number);
  return p.length === 3 && p.every(Number.isSafeInteger) && p[0] === 3
    && (p[1] > 51 || p[1] === 51 && p[2] >= 3 || p[1] === 50 && p[2] >= 7 || p[1] === 44 && p[2] >= 6);
}
export function footprint(dir: string): Record<string, object> {
  const stat = fs.statSync(dir, { bigint: true });
  return { '.': { mode: String(stat.mode), mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs) },
    ...Object.fromEntries(fs.readdirSync(dir).sort().map((name) => {
      const file = path.join(dir, name);
      const s = fs.statSync(file, { bigint: true });
      return [name, { bytes: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), size: String(s.size),
        mode: String(s.mode), mtime: String(s.mtimeNs), ctime: String(s.ctimeNs) }];
    })) };
}
const connectionSettings = (db: SqliteDatabase) => db.exec('PRAGMA busy_timeout=0; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=0;');
export function hold(view: SqliteDatabase): void {
  try {
    view.exec('BEGIN IMMEDIATE; UPDATE view_gate SET state=\'HOLD\'; COMMIT;');
  } catch (error) { try { view.exec('ROLLBACK'); } catch { /* no transaction */ } throw error; }
}
export function qualified(file: string, view: SqliteDatabase, counter?: { calls: number }): SqliteDatabase {
  const db = new SqliteDatabase(file);
  connectionSettings(db);
  db.function(FLOOR_FN, { directOnly: false }, () => {
    if (counter) counter.calls++;
    hold(view); // independent FULL commit completes before primary DML is allowed
    return 1;
  });
  return db;
}
export function installFloor(source: SqliteDatabase): void {
  source.exec(`BEGIN IMMEDIATE;
    CREATE TABLE source_gate(id INTEGER PRIMARY KEY CHECK(id=1),source_id TEXT NOT NULL,generation INTEGER NOT NULL,floor INTEGER NOT NULL);
    INSERT INTO source_gate VALUES(1,'synthetic-source',0,1);
    ${['INSERT', 'UPDATE', 'DELETE'].map((event) => `CREATE TRIGGER bosun_floor_${event.toLowerCase()} BEFORE ${event} ON memories BEGIN
      SELECT ${FLOOR_FN}(); UPDATE source_gate SET generation=generation+1 WHERE id=1; END;`).join('\n')}
    COMMIT;`);
}
export function sourceGeneration(source: SqliteDatabase): number { return Number(source.prepare('SELECT generation FROM source_gate WHERE id=1').get()!.generation); }
export function gate(view: SqliteDatabase) {
  const row = view.prepare('SELECT state,source_id,generation,floor FROM view_gate WHERE id=1').get()!;
  return { state: String(row.state), sourceId: String(row.source_id), generation: Number(row.generation), floor: Number(row.floor) };
}
export function buildUnderAdmission(source: SqliteDatabase, view: SqliteDatabase, now = NOW, beforeReady?: () => void): number {
  // Marker comes only from this test helper's BEGIN IMMEDIATE wrapper. isTransaction alone is insufficient.
  if (!admitted.has(source) || !source.isTransaction) throw Error('primary_admission_required');
  const generation = sourceGeneration(source);
  const rows = source.prepare(`SELECT * FROM memories WHERE typeof(private)='integer' AND private=0 AND status='active'
    AND (expires_at IS NULL OR expires_at>?)`).all(now);
  const columns = source.prepare("SELECT name FROM pragma_table_info('memories')").all().map((row) => String(row.name));
  try {
    view.exec('BEGIN IMMEDIATE; DELETE FROM memories;');
    const insert = view.prepare(`INSERT INTO memories(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`);
    for (const row of rows) insert.run(...columns.map((name) => row[name]));
    beforeReady?.();
    view.prepare("UPDATE view_gate SET state='READY',generation=?,floor=1,source_id='synthetic-source' WHERE id=1").run(generation);
    view.exec('COMMIT');
    return generation;
  } catch (error) { try { view.exec('ROLLBACK'); } catch { /* already rolled back */ } throw error; }
}
export function publish(source: SqliteDatabase, view: SqliteDatabase): number {
  beginAdmission(source);
  try { const generation = buildUnderAdmission(source, view); endAdmission(source, true); return generation; }
  catch (error) { try { endAdmission(source, false); } catch { /* admission failed */ } throw error; }
}
export function fixture(root: string, floor = true) {
  const primaryDir = path.join(root, 'primary'); const viewDir = path.join(root, 'view');
  fs.mkdirSync(primaryDir); fs.mkdirSync(viewDir);
  const primaryFile = path.join(primaryDir, 'memory.db'); const viewFile = path.join(viewDir, 'public.db');
  const source = openSchemaOneMemory(primaryFile); connectionSettings(source);
  const add = source.prepare(`INSERT INTO memories(id,category,project_id,title,body,tags,shared,private,source,hash,created_at,updated_at,expires_at)
    VALUES(?,?,?,?,?,'[]',?,?,'fixture',?,1,1,?)`);
  add.run('m_personal', 'personal', null, 'Personal', 'PUBLIC personal body', 0, 0, 'hash-personal', null);
  add.run('m_project', 'project', 'p_a', 'Project', 'PUBLIC project body', 0, 0, 'hash-project', null);
  add.run('m_linked', 'project', 'p_b', 'Linked', 'PUBLIC linked body', 0, 0, 'hash-linked', null);
  add.run('m_shared', 'project', 'p_c', 'Shared', 'PUBLIC shared body', 1, 0, 'hash-shared', null);
  add.run('m_private', 'personal', null, 'PRIVATE CANARY', 'PRIVATE body canary', 0, 1, 'PRIVATE-hash', null);
  add.run('m_expired', 'session', 'p_a', 'Expired', 'EXPIRED body', 0, 0, 'hash-expired', 99);
  source.exec("INSERT INTO memory_events(memory_id,op,at,source,hash_after) VALUES('m_private','store',1,'PRIVATE audit','PRIVATE-hash')");
  fs.closeSync(fs.openSync(viewFile, 'wx', 0o600));
  const view = new SqliteDatabase(viewFile); view.exec('PRAGMA synchronous=FULL; PRAGMA busy_timeout=0;');
  view.exec(MEMORY_MIGRATIONS[0]);
  view.exec(`CREATE TABLE view_gate(id INTEGER PRIMARY KEY CHECK(id=1),state TEXT NOT NULL,source_id TEXT NOT NULL,generation INTEGER NOT NULL,floor INTEGER NOT NULL);
    INSERT INTO view_gate VALUES(1,'HOLD','synthetic-source',0,1);`);
  const counter = { calls: 0 };
  source.function(FLOOR_FN, { directOnly: false }, () => { counter.calls++; hold(view); return 1; });
  if (floor) installFloor(source);
  return { source, view, primaryFile, viewFile, primaryDir, viewDir, counter,
    close() { source.close(); view.close(); } };
}

export function openLease(file: string) {
  if (!fs.existsSync(file) || ['-journal', '-wal', '-shm'].some((suffix) => fs.existsSync(file + suffix))) throw Error('view_hold_or_recovery');
  const header = Buffer.alloc(100); const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, header, 0, 100, 0); } finally { fs.closeSync(fd); }
  if (header[18] !== 1 || header[19] !== 1) throw Error('view_journal_unqualified');
  const db = new SqliteDatabase(file, { readOnly: true, defensive: true, allowExtension: false });
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA temp_store=MEMORY; PRAGMA locking_mode=EXCLUSIVE; PRAGMA busy_timeout=0; BEGIN;');
    const admitted = gate(db);
    if (admitted.state !== 'READY' || admitted.floor !== 1 || admitted.sourceId !== 'synthetic-source') throw Error('view_hold');
    let open = true;
    return {
      generation: admitted.generation,
      rows(ctx: Ctx, now = NOW) {
        if (!open) throw Error('lease_closed');
        return db.prepare(`SELECT id,body,hash,project_id,expires_at FROM memories WHERE typeof(private)='integer' AND private=0 AND status='active'
          AND (expires_at IS NULL OR expires_at>?) AND (category='personal' AND project_id IS NULL OR project_id=? OR shared=1
          OR project_id IN(SELECT value FROM json_each(?))) ORDER BY id`).all(now, ctx.projectId, JSON.stringify(ctx.linked));
      },
      validate() { if (!open || JSON.stringify(gate(db)) !== JSON.stringify(admitted)) throw Error('lease_invalid'); },
      close() { if (!open) return; open = false; try { db.exec('ROLLBACK'); } finally { db.close(); } },
    };
  } catch (error) { db.close(); throw error; }
}
export function protectSchema(source: SqliteDatabase): void {
  source.setAuthorizer((action) => [sqliteConstants.SQLITE_DROP_TRIGGER, sqliteConstants.SQLITE_DROP_TABLE, sqliteConstants.SQLITE_ALTER_TABLE].includes(action)
    ? sqliteConstants.SQLITE_DENY : sqliteConstants.SQLITE_OK);
}

export function crashPhase(primaryFile: string, viewFile: string, phase: string): void {
  const view = new SqliteDatabase(viewFile); view.exec('PRAGMA synchronous=FULL; PRAGMA busy_timeout=0;');
  const source = qualified(primaryFile, view);
  if (phase === 'after-hold') { source.exec('BEGIN IMMEDIATE'); hold(view); }
  else if (phase === 'after-primary-commit') source.exec("UPDATE memories SET private=1 WHERE id='m_project'");
  else if (phase === 'during-view-build') {
    hold(view); source.exec('BEGIN IMMEDIATE');
    view.exec("BEGIN IMMEDIATE; DELETE FROM memories; UPDATE view_gate SET state='READY';");
  } else if (phase === 'after-ready') { hold(view); publish(source, view); }
  else throw Error('unknown_crash_phase');
  process.stdout.write('QUALIFICATION_READY\n');
  setInterval(() => {}, 1000); // parent kills this guarded synthetic child at the exact boundary
}
