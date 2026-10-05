// Explicit owner cutover/publication and registered admission. No automatic floor installation or hook reader.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync, StatementSync, backup, constants } from 'node:sqlite';
import { BosunError, MemoryError } from '../../core/errors.ts';
import { norm } from '../../core/text.ts';
import { GATE_SQL, PUBLIC_STATE_SQL, PUBLIC_MEMORY_SQL, PUBLIC_FTS_SQL, PUBLIC_FTS_TRIGGERS, PUBLIC_SQL, PUBLIC_COLUMNS, PUBLIC_MAX_ROWS, PUBLIC_MAX_BYTES, VIEW_MAX_BYTES, normalize } from './sqlite-public-protocol.ts';

const FLOOR = 1;
const FN = 'bosun_writer_floor_v1';
const FN2 = 'bosun_writer_floor_v2';
const PUBLIC_FLOOR = 'bosun_public_floor';
const META = 'bosun_source_floor';
const MAX_BYTES = 64 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TABLES = ['memories', 'memory_events', 'docs'] as const;
// Fingerprint of the existing migration-1 sqlite_master (including FTS shadow tables), not its data.
const SCHEMA = '3cb4d90795d1afc8819cae315ed6835876bc85de27b9b1ceb603a1b98c1f57e2';
type Row = Record<string, unknown>;
type Identity = { dev: string; ino: string };
export type CutoverReason = 'path' | 'identity' | 'schema' | 'state' | 'backup' | 'busy' | 'storage' | 'runtime' | 'input' | 'receipt_unknown';
export class CutoverError extends BosunError {
  readonly reason: CutoverReason;
  constructor(reason: CutoverReason) {
    const safe: CutoverReason = ['path', 'identity', 'schema', 'state', 'backup', 'busy', 'storage', 'runtime', 'input', 'receipt_unknown'].includes(reason) ? reason : 'storage';
    super(safe === 'input' ? 'invalid' : 'unavailable', `memory cutover unavailable (${safe})`, safe === 'receipt_unknown' ? { details: { outcome: 'unknown' } } : undefined);
    this.reason = safe;
  }
}
function fail(reason: CutoverReason): never { throw new CutoverError(reason); }
export type CutoverPaths = { primary: string; view: string; backups: string };
export type CutoverPhase = 'intent' | 'backup' | 'floor' | 'commit';
export type CutoverOptions = {
  paths: CutoverPaths;
  now: () => number;
  id: () => string;
  /** Owner progress/checkpoint only; no data, artifact hashes or paths are passed. */
  checkpoint?: (phase: CutoverPhase) => void | Promise<void>;
};
export type CutoverReceipt = { state: 'HOLD'; floor: 1; sourceId: string; attemptId: string; generation: number };
type Gate = {
  id: number; protocol: number; state: string; phase: string; source_id: string; attempt_id: string;
  source_dev: string; source_ino: string; view_dev: string; view_ino: string;
  backup_name: string; backup_dev: string; backup_ino: string; backup_hash: string | null; started_at: number;
  format?: number;
};
const META_SQL = `CREATE TABLE ${META} (
  id INTEGER PRIMARY KEY CHECK(id=1), protocol INTEGER NOT NULL CHECK(protocol=1),
  source_id TEXT NOT NULL, attempt_id TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation>=0 AND generation<=9007199254740991),
  source_dev TEXT NOT NULL, source_ino TEXT NOT NULL, view_dev TEXT NOT NULL, view_ino TEXT NOT NULL,
  backup_name TEXT NOT NULL, backup_dev TEXT NOT NULL, backup_ino TEXT NOT NULL, backup_hash TEXT NOT NULL, started_at INTEGER NOT NULL
)`;
const triggerName = (table: string, op: string) => `bosun_floor_${table}_${op}`;
const triggerSql = (table: string, op: string, format = 1) => `CREATE TRIGGER ${triggerName(table, op)} BEFORE ${op.toUpperCase()} ON ${table} BEGIN
  SELECT CASE WHEN ${format === 2 ? FN2 : FN}() != 1 THEN RAISE(ABORT,'writer unavailable') END;
  UPDATE ${META} SET generation=generation+1 WHERE id=1 AND generation<9007199254740991;
  SELECT CASE WHEN changes()!=1 THEN RAISE(ABORT,'writer unavailable') END;
END`;
const PUBLIC_FLOOR_SQL = `CREATE TABLE ${PUBLIC_FLOOR} (id INTEGER PRIMARY KEY CHECK(id=1),format INTEGER NOT NULL CHECK(format=2),
  source_id TEXT NOT NULL,view_dev TEXT NOT NULL,view_ino TEXT NOT NULL)`;
const integer = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
function mapped(error: unknown): never {
  let reason: CutoverReason | undefined;
  try { if (error instanceof CutoverError) reason = error.reason; } catch {}
  // Even an injected callback can mutate/spoof an Error instance; reconstruct finite text.
  if (reason !== undefined) fail(reason);
  let code: unknown;
  try { code = error && typeof error === 'object' ? (error as { errcode?: unknown }).errcode : undefined; } catch {}
  fail(code === 5 || code === 6 || code === 517 ? 'busy' : 'storage');
}
function authoritative(error: unknown): MemoryError | undefined {
  try {
    if (!(error instanceof MemoryError)) return undefined;
    const code = Object.getOwnPropertyDescriptor(error, 'code'); const message = Object.getOwnPropertyDescriptor(error, 'message');
    const current = Object.getOwnPropertyDescriptor(error, 'current');
    if (!code || !('value' in code) || !['not_found', 'conflict', 'invalid', 'unavailable'].includes(code.value)
      || !message || !('value' in message) || typeof message.value !== 'string'
      || current && (!('value' in current) || current.value !== undefined && (!integer(current.value) || current.value < 1))) return undefined;
    return error;
  } catch { return undefined; }
}
function identity(file: string): Identity {
  const s = fs.lstatSync(file, { bigint: true });
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1n || Number(s.mode & 0o777n) !== 0o600
    || process.getuid && Number(s.uid) !== process.getuid()) fail('path');
  return { dev: String(s.dev), ino: String(s.ino) };
}
function same(file: string, expected: Identity): void {
  const actual = identity(file);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) fail('identity');
}
function canonical(file: string, exists: boolean): void {
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.resolve(file) !== file || file.includes('\0')) fail('path');
  const parent = path.dirname(file);
  if (fs.realpathSync(parent) !== parent || exists && fs.realpathSync(file) !== file) fail('path');
}
function present(file: string): boolean {
  if (typeof file !== 'string' || file.includes('\0')) fail('path');
  try { fs.lstatSync(file); return true; }
  catch (error) {
    let missing = false;
    try { missing = !!error && typeof error === 'object' && Object.getOwnPropertyDescriptor(error, 'code')?.value === 'ENOENT'; } catch {}
    if (missing) return false;
    throw error;
  }
}
function paths(input: CutoverPaths): CutoverPaths {
  if (!input) fail('input');
  const p = { primary: input.primary, view: input.view, backups: input.backups };
  canonical(p.primary, true); canonical(p.view, present(p.view));
  if (typeof p.backups !== 'string' || path.resolve(p.backups) !== p.backups || fs.realpathSync(p.backups) !== p.backups) fail('path');
  for (const dir of [p.backups, path.dirname(p.view), path.dirname(p.primary)]) {
    const s = fs.statSync(dir);
    if (!s.isDirectory() || (s.mode & 0o777) !== 0o700 || process.getuid && s.uid !== process.getuid()) fail('path');
  }
  if (p.primary === p.view || path.dirname(p.primary) === p.backups || p.backups === path.dirname(p.view)) fail('path');
  identity(p.primary);
  let bytes = fs.statSync(p.primary).size;
  for (const suffix of ['-wal', '-shm']) if (present(p.primary + suffix)) {
    canonical(p.primary + suffix, true); identity(p.primary + suffix);
    if (suffix === '-wal') bytes += fs.statSync(p.primary + suffix).size;
  }
  if (bytes < 100 || bytes > MAX_BYTES || present(p.primary + '-journal')) fail('state');
  return p;
}
function reserve(file: string): Identity { fs.closeSync(fs.openSync(file, 'wx', 0o600)); return identity(file); }
function closeNative(db: DatabaseSync | undefined | null): boolean {
  if (!db) return true;
  try { if (db.isOpen) db.close(); return true; }
  catch { try { if (db.isOpen) db.close(); } catch {} return false; }
}
function open(file: string, readOnly = false): DatabaseSync {
  const db = new DatabaseSync(file, { readOnly, allowExtension: false, defensive: true, enableDoubleQuotedStringLiterals: false });
  try { db.exec('PRAGMA busy_timeout=0; PRAGMA temp_store=MEMORY; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=0;'); }
  catch (e) { closeNative(db); throw e; }
  return db;
}
function viewIdentity(p: CutoverPaths, ownedRecovery = false): Identity {
  const id = identity(p.view);
  if (fs.statSync(p.view).size < 100 || fs.statSync(p.view).size > MAX_BYTES
    || ['-wal', '-shm'].some((s) => present(p.view + s)) || !ownedRecovery && present(p.view + '-journal')) fail('state');
  if (ownedRecovery && present(p.view + '-journal')) {
    canonical(p.view + '-journal', true); identity(p.view + '-journal');
    if (fs.statSync(p.view + '-journal').size > MAX_BYTES) fail('state');
  }
  const header = Buffer.alloc(20); const fd = fs.openSync(p.view, 'r');
  try { fs.readSync(fd, header, 0, 20, 0); } finally { fs.closeSync(fd); }
  if (header.toString('ascii', 0, 16) !== 'SQLite format 3\0' || header[18] !== 1 || header[19] !== 1) fail('state');
  return id;
}
function runtime(db: DatabaseSync): void {
  const version = String(db.prepare('SELECT sqlite_version() AS v').get()!.v).split('.').map(Number);
  const [a, b, c] = version;
  if (process.versions.bun || a !== 3 || !(b > 51 || b === 51 && c >= 3 || b === 50 && c >= 7 || b === 44 && c >= 6)
    || typeof backup !== 'function' || typeof db.function !== 'function' || typeof db.setAuthorizer !== 'function') fail('runtime');
}
function schema(db: DatabaseSync): void {
  const versions = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all();
  if (versions.length !== 1 || versions[0].version !== 1) fail('schema');
  const rows = db.prepare("SELECT name,type,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE 'bosun_%' ORDER BY name").all();
  const digest = crypto.createHash('sha256').update(JSON.stringify(rows.map((r) => [r.name, r.type, r.tbl_name, normalize(r.sql)]))).digest('hex');
  if (digest !== SCHEMA) fail('schema');
  const extra = db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'bosun_%'").all();
  const allowed = new Set([META, PUBLIC_FLOOR, ...TABLES.flatMap((t) => ['insert', 'update', 'delete'].map((op) => triggerName(t, op)))]);
  if (extra.some((r) => !allowed.has(String(r.name)))) fail('schema');
}
function sqlEquals(db: DatabaseSync, name: string, sql: string): void {
  if (normalize(db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(name)?.sql) !== normalize(sql)) fail('schema');
}
function sourceFloor(db: DatabaseSync): Row | undefined {
  if (!db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(META)) {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name LIKE 'bosun_%'").get()) fail('schema');
    return undefined;
  }
  sqlEquals(db, META, META_SQL);
  const upgraded = !!db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(PUBLIC_FLOOR);
  const format = upgraded ? 2 : 1;
  for (const table of TABLES) for (const op of ['insert', 'update', 'delete']) sqlEquals(db, triggerName(table, op), triggerSql(table, op, format));
  const rows = db.prepare(`SELECT * FROM ${META}`).all();
  if (rows.length !== 1 || rows[0].id !== 1 || rows[0].protocol !== 1 || !integer(rows[0].generation)) fail('state');
  if (upgraded) {
    sqlEquals(db, PUBLIC_FLOOR, PUBLIC_FLOOR_SQL);
    const markers = db.prepare(`SELECT * FROM ${PUBLIC_FLOOR}`).all(); const marker = markers[0];
    if (markers.length !== 1 || marker.id !== 1 || marker.format !== 2 || marker.source_id !== rows[0].source_id
      || marker.view_dev !== rows[0].view_dev || marker.view_ino !== rows[0].view_ino) fail('identity');
  }
  rows[0].format = format;
  return rows[0];
}
function validateGate(db: DatabaseSync, p: CutoverPaths, source: Identity, view: Identity): Gate {
  const names = db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
  const format = names.some((r) => r.name === 'bosun_public_state') ? 2 : 1;
  if (format === 1 && (names.length !== 1 || names[0].name !== 'bosun_cutover_gate')) fail('schema');
  if (format === 2) {
    if (names.length !== PUBLIC_SQL.size || names.some((r) => !PUBLIC_SQL.has(String(r.name)))) fail('schema');
    for (const [name, sql] of PUBLIC_SQL) sqlEquals(db, name, sql);
  }
  sqlEquals(db, 'bosun_cutover_gate', GATE_SQL);
  const rows = db.prepare('SELECT * FROM bosun_cutover_gate').all();
  if (rows.length !== 1) fail('state');
  const r = rows[0] as unknown as Gate;
  bindGate(r, p, source, view);
  Object.defineProperty(r, 'format', { value: format });
  if (format === 2) publicState(db, r);
  return r;
}
function bindGate(r: Gate, p: CutoverPaths, source: Identity, view: Identity): void {
  if (r.id !== 1 || r.protocol !== FLOOR || r.state !== 'HOLD' || !['copying', 'backed', 'applied'].includes(r.phase)
    || !UUID.test(r.source_id) || !UUID.test(r.attempt_id) || r.backup_name !== r.attempt_id + '.db'
    || !integer(r.started_at) || r.started_at > 8_640_000_000_000_000 || r.backup_hash !== null && !/^[a-f0-9]{64}$/.test(r.backup_hash)) fail('state');
  if (r.source_dev !== source.dev || r.source_ino !== source.ino || r.view_dev !== view.dev || r.view_ino !== view.ino) fail('identity');
  same(path.join(p.backups, r.backup_name), { dev: r.backup_dev, ino: r.backup_ino });
}
function recoveryBinding(floor: Row, p: CutoverPaths, source: Identity, view: Identity): void {
  const gate: Gate = { id: 1, protocol: FLOOR, state: 'HOLD', phase: 'applied',
    source_id: floor.source_id as string, attempt_id: floor.attempt_id as string,
    source_dev: floor.source_dev as string, source_ino: floor.source_ino as string, view_dev: floor.view_dev as string, view_ino: floor.view_ino as string,
    backup_name: floor.backup_name as string, backup_dev: floor.backup_dev as string, backup_ino: floor.backup_ino as string,
    backup_hash: floor.backup_hash as string, started_at: floor.started_at as number };
  bindGate(gate, p, source, view); reconcile(floor, gate, p);
}
function publicState(db: DatabaseSync, gate: Gate): Row {
  const rows = db.prepare('SELECT * FROM bosun_public_state').all(); const r = rows[0];
  if (rows.length !== 1 || r.id !== 1 || r.format !== 2 || !['HOLD', 'READY'].includes(String(r.state)) || r.source_id !== gate.source_id
    || r.generation !== null && !integer(r.generation) || r.publication_id !== null && (typeof r.publication_id !== 'string' || !UUID.test(r.publication_id))
    || r.published_at !== null && !stamp(r.published_at) || r.valid_until !== null && !stamp(r.valid_until)) fail('state');
  if (r.state === 'READY' && (!integer(r.generation) || r.publication_id === null || r.published_at === null
    || r.valid_until !== null && Number(r.valid_until) <= Number(r.published_at))) fail('state');
  return r;
}
function stamp(value: unknown): value is number { return integer(value) && value <= 8_640_000_000_000_000; }
function digestBackup(file: string, id: Identity): string {
  same(file, id);
  const size = fs.statSync(file).size;
  if (size < 100 || size > MAX_BYTES || ['-wal', '-shm', '-journal'].some((s) => present(file + s))) fail('backup');
  const bytes = fs.readFileSync(file);
  if (bytes.toString('ascii', 0, 16) !== 'SQLite format 3\0' || bytes[18] !== 1 || bytes[19] !== 1) fail('backup');
  return crypto.createHash('sha256').update(bytes).digest('hex');
}
function reconcile(floor: Row, gate: Gate, p: CutoverPaths): void {
  for (const key of ['id', 'protocol', 'source_id', 'attempt_id', 'source_dev', 'source_ino', 'view_dev', 'view_ino', 'backup_name', 'backup_dev', 'backup_ino', 'backup_hash', 'started_at'] as const) {
    if (floor[key] !== gate[key]) fail('identity');
  }
  if (!gate.backup_hash || digestBackup(path.join(p.backups, gate.backup_name), { dev: gate.backup_dev, ino: gate.backup_ino }) !== gate.backup_hash) fail('backup');
}
function viewTx(db: DatabaseSync, fn: () => void): void {
  db.exec('BEGIN IMMEDIATE');
  try { fn(); db.exec('COMMIT'); } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
}
function time(now: () => number): number {
  let n: unknown; try { n = now(); } catch { fail('input'); }
  if (!integer(n) || n > 8_640_000_000_000_000) fail('input'); return n;
}
function freshId(id: () => string): string {
  let value: unknown; try { value = id(); } catch { fail('input'); }
  if (typeof value !== 'string' || !UUID.test(value)) fail('input'); return value;
}
const receipt = (gate: Gate, generation: number): CutoverReceipt => ({ state: 'HOLD', floor: FLOOR, sourceId: gate.source_id, attemptId: gate.attempt_id, generation });
function confirmed(source: DatabaseSync, view: DatabaseSync, p: CutoverPaths, expected: Gate): { gate: Gate; generation: number } {
  const sourceId = { dev: expected.source_dev, ino: expected.source_ino }; const viewId = { dev: expected.view_dev, ino: expected.view_ino };
  same(p.primary, sourceId); same(p.view, viewId);
  const gate = validateGate(view, p, sourceId, viewId);
  for (const key of ['source_id', 'attempt_id', 'backup_name', 'backup_dev', 'backup_ino', 'backup_hash', 'started_at'] as const) {
    if (gate[key] !== expected[key]) fail('identity');
  }
  const floor = sourceFloor(source); if (!floor) fail('state'); reconcile(floor, gate, p);
  if (floor.format !== (expected.format ?? 1) || gate.format !== (expected.format ?? 1)) fail('state');
  if (gate.format === 2) {
    const state = publicState(view, gate);
    if (state.state === 'READY' && state.generation !== floor.generation) fail('state');
  }
  return { gate, generation: Number(floor.generation) };
}

/** Holds actual source write admission continuously across native backup and the schema commit. */
export async function cutoverMemory(options: CutoverOptions): Promise<CutoverReceipt> {
  let source: DatabaseSync | undefined; let view: DatabaseSync | undefined; let copySource: DatabaseSync | undefined;
  let admitted = false;
  try {
    if (!options || typeof options.now !== 'function' || typeof options.id !== 'function') fail('input');
    if (options.checkpoint !== undefined && typeof options.checkpoint !== 'function') fail('input');
    // Validate injected values before any reservation or gate creation.
    const started = time(options.now); const attempt = freshId(options.id); const newEpoch = freshId(options.id);
    if (attempt === newEpoch) fail('input');
    const p = paths(options.paths); const sourceId = identity(p.primary);
    source = open(p.primary); runtime(source);
    source.exec('BEGIN IMMEDIATE'); admitted = true;
    same(p.primary, sourceId); paths(p); schema(source);
    const floor = sourceFloor(source);
    let gate: Gate | undefined;
    let viewId: Identity | undefined;
    if (present(p.view)) {
      viewId = viewIdentity(p);
      view = open(p.view); gate = validateGate(view, p, sourceId, viewId);
    } else {
      if (floor) fail('identity');
    }
    if (floor) {
      if (!gate || !view || !viewId) fail('state');
      reconcile(floor, gate, p);
      if (floor.format !== gate.format) fail('state');
      // Cutover reconciliation is a HOLD receipt, never an implicit preservation of public READY.
      if (gate.format === 2) holdPublic(view, gate);
      source.exec('COMMIT'); admitted = false;
      confirmed(source, view, p, gate);
      viewTx(view, () => view!.exec("UPDATE bosun_cutover_gate SET phase='applied' WHERE id=1"));
      const final = confirmed(source, view, p, gate); if (final.gate.phase !== 'applied') fail('state');
      return receipt(gate, final.generation);
    }
    if (gate?.phase === 'applied') fail('state');
    const epoch = gate?.source_id ?? newEpoch;
    if (attempt === epoch || attempt === gate?.attempt_id) fail('input');
    const backupFile = path.join(p.backups, attempt + '.db');
    const backupId = reserve(backupFile);
    const initial = !view;
    if (!view) { viewId = reserve(p.view); view = open(p.view); }
    if (!viewId) fail('state');
    gate = { id: 1, protocol: FLOOR, state: 'HOLD', phase: 'copying', source_id: epoch, attempt_id: attempt,
      source_dev: sourceId.dev, source_ino: sourceId.ino, view_dev: viewId.dev, view_ino: viewId.ino,
      backup_name: attempt + '.db', backup_dev: backupId.dev, backup_ino: backupId.ino, backup_hash: null, started_at: started };
    viewTx(view, () => {
      // The first valid recovery row and its schema commit together; no committed empty gate.
      if (initial) view!.exec(GATE_SQL);
      view!.exec('DELETE FROM bosun_cutover_gate');
      view!.prepare('INSERT INTO bosun_cutover_gate VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...Object.values(gate!));
    });
    await options.checkpoint?.('intent');
    same(p.primary, sourceId); same(p.view, viewId); same(backupFile, backupId);
    copySource = open(p.primary, true);
    await backup(copySource, backupFile, { source: 'main', target: 'main', rate: 100 });
    if (!closeNative(copySource)) fail('storage'); copySource = undefined;
    // Only the finished offline artifact is read by fs; the live DB/WAL is never copied.
    const artifact = open(backupFile);
    try {
      // Native backup inherits WAL format. Finalize ONLY this offline owner artifact, not the primary.
      if (artifact.prepare('PRAGMA journal_mode=DELETE').get()!.journal_mode !== 'delete') fail('backup');
      if (artifact.prepare('PRAGMA quick_check').get()!.quick_check !== 'ok') fail('backup'); schema(artifact);
    }
    finally { if (!closeNative(artifact)) fail('storage'); }
    gate.backup_hash = digestBackup(backupFile, backupId); gate.phase = 'backed';
    const fd = fs.openSync(backupFile, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    viewTx(view, () => view!.prepare("UPDATE bosun_cutover_gate SET phase='backed',backup_hash=? WHERE id=1").run(gate!.backup_hash));
    await options.checkpoint?.('backup');
    same(p.primary, sourceId); same(p.view, viewId); reconcileBackup(gate, p);
    source.exec(META_SQL);
    source.prepare(`INSERT INTO ${META} VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      gate.id, gate.protocol, gate.source_id, gate.attempt_id, 0, gate.source_dev, gate.source_ino, gate.view_dev, gate.view_ino,
      gate.backup_name, gate.backup_dev, gate.backup_ino, gate.backup_hash, gate.started_at);
    for (const table of TABLES) for (const op of ['insert', 'update', 'delete']) source.exec(triggerSql(table, op));
    await options.checkpoint?.('floor');
    same(p.primary, sourceId); same(p.view, viewId); reconcileBackup(gate, p);
    source.exec('COMMIT'); admitted = false;
    await options.checkpoint?.('commit');
    confirmed(source, view, p, gate);
    viewTx(view, () => view!.exec("UPDATE bosun_cutover_gate SET phase='applied' WHERE id=1"));
    const final = confirmed(source, view, p, gate); if (final.gate.phase !== 'applied') fail('state');
    return receipt(gate, final.generation);
  } catch (e) { return mapped(e); }
  finally {
    let clean = closeNative(copySource);
    if (admitted) try { source?.exec('ROLLBACK'); } catch { clean = false; }
    const viewClosed = closeNative(view); const sourceClosed = closeNative(source);
    if (!clean || !viewClosed || !sourceClosed) fail('storage');
  }
}
function reconcileBackup(gate: Gate, p: CutoverPaths): void {
  if (!gate.backup_hash || digestBackup(path.join(p.backups, gate.backup_name), { dev: gate.backup_dev, ino: gate.backup_ino }) !== gate.backup_hash) fail('backup');
}
function holdPublic(view: DatabaseSync, gate: Gate): void {
  viewTx(view, () => {
    view.exec("UPDATE bosun_cutover_gate SET state='HOLD' WHERE id=1");
    if (gate.format === 2) {
      publicState(view, gate);
      if (view.prepare("UPDATE bosun_public_state SET state='HOLD' WHERE id=1").run().changes !== 1) fail('state');
    }
  });
}
export type PublicationPhase = 'view-upgrade' | 'format' | 'format-commit' | 'hold' | 'rows' | 'ready';
export type PublicationOptions = { paths: CutoverPaths; now: () => number; id: () => string;
  checkpoint?: (phase: PublicationPhase) => void | Promise<void> };
export type PublicationReceipt = { state: 'READY'; publicationId: string };
type OwnedView = { paths: CutoverPaths; gate: Gate };
function reholdOwned(owned: OwnedView, active?: DatabaseSync): boolean {
  let extra: DatabaseSync | undefined;
  try {
    const { paths: p, gate } = owned;
    same(p.view, { dev: gate.view_dev, ino: gate.view_ino });
    viewIdentity(p); // cleanup may revoke a valid view, but cannot recover unknown/pending sidecars
    const view = active?.isOpen ? active : (extra = open(p.view));
    const current = validateGate(view, p, { dev: gate.source_dev, ino: gate.source_ino }, { dev: gate.view_dev, ino: gate.view_ino });
    if (current.source_id !== gate.source_id || current.attempt_id !== gate.attempt_id || current.format !== 2) return false;
    holdPublic(view, current); return true;
  } catch { return false; }
  finally { closeNative(extra); }
}
function publicRow(row: Row): Row {
  const text = (v: unknown, max: number, nonempty = false): v is string => typeof v === 'string' && v.length <= max && (!nonempty || /\S/.test(v));
  if (row.private !== 0 || row.status !== 'active' || !integer(row.seq) || row.seq < 1
    || !text(row.id, 64, true)
    || !['personal', 'project', 'session'].includes(String(row.category))
    || (row.category === 'personal') !== (row.project_id === null) || row.project_id !== null && !text(row.project_id, 64, true)
    || row.session_id !== null && !text(row.session_id, 200) || !text(row.title, 200, true) || !text(row.body, 4000, true)
    || !text(row.tags, 600) || row.shared !== 0 && row.shared !== 1 || !text(row.source, 200)
    || row.source_ref !== null && !text(row.source_ref, 200) || !stamp(row.created_at) || !stamp(row.updated_at)
    || row.expires_at !== null && !stamp(row.expires_at) || row.accessed_at !== null && !stamp(row.accessed_at)
    || !integer(row.access_count) || !integer(row.version) || row.version < 1) fail('state');
  const tags: unknown = JSON.parse(row.tags);
  if (!Array.isArray(tags) || tags.length > 12 || tags.some((t) => typeof t !== 'string' || !/^[a-z0-9-]{1,40}$/.test(t))) fail('state');
  const hash = crypto.createHash('sha256').update(norm(`${row.title}\n${row.body}`)).digest('hex').slice(0, 32);
  if (row.hash !== hash) fail('state');
  // Fixed current-public projection; audit history and owner recovery metadata are absent.
  return Object.fromEntries(PUBLIC_COLUMNS.map((key) => [key, row[key]]));
}
function publicRows(source: DatabaseSync, now: number): Row[] {
  const rows = source.prepare(`SELECT ${PUBLIC_COLUMNS.join(',')} FROM memories WHERE typeof(private)='integer' AND private=0
    AND status='active' AND (expires_at IS NULL OR (typeof(expires_at)='integer' AND expires_at>:now)) ORDER BY seq LIMIT :limit`)
    .all({ now, limit: PUBLIC_MAX_ROWS + 1 });
  if (rows.length > PUBLIC_MAX_ROWS) fail('state');
  let bytes = 0;
  return rows.map((row) => {
    const projected = publicRow(row); bytes += Buffer.byteLength(JSON.stringify(projected));
    if (bytes > PUBLIC_MAX_BYTES) fail('state'); return projected;
  });
}
function installPublicFloor(source: DatabaseSync, gate: Gate): void {
  source.exec(PUBLIC_FLOOR_SQL);
  source.prepare(`INSERT INTO ${PUBLIC_FLOOR} VALUES(1,2,?,?,?)`).run(gate.source_id, gate.view_dev, gate.view_ino);
  for (const table of TABLES) for (const op of ['insert', 'update', 'delete']) {
    source.exec(`DROP TRIGGER ${triggerName(table, op)}`); source.exec(triggerSql(table, op, 2));
  }
}
/** Explicit owner publication for an already-applied floor. No source/gate/backup creation or cutover. */
export async function publishMemoryView(options: PublicationOptions): Promise<PublicationReceipt> {
  let source: DatabaseSync | undefined; let view: DatabaseSync | undefined; let admitted = false; let viewTransaction = false;
  let owned: OwnedView | undefined; let readyCommitted = false;
  try {
    if (!options || typeof options.now !== 'function' || typeof options.id !== 'function'
      || options.checkpoint !== undefined && typeof options.checkpoint !== 'function') fail('input');
    const started = time(options.now); const publicationId = freshId(options.id);
    const p = paths(options.paths); const primaryId = identity(p.primary); const viewId = viewIdentity(p, true);
    if (fs.statSync(p.view).size > VIEW_MAX_BYTES) fail('state');
    source = open(p.primary); runtime(source);
    source.exec('BEGIN IMMEDIATE'); admitted = true;
    same(p.primary, primaryId); paths(p); schema(source);
    let floor = sourceFloor(source); if (!floor) fail('state');
    // Only this explicit owner operation may let SQLite recover an owned rollback journal.
    // Establish floor/epoch/inode/backup authority BEFORE any writable view open.
    recoveryBinding(floor, p, primaryId, viewId);
    same(p.primary, primaryId); same(p.view, viewId); view = open(p.view);
    let gate = validateGate(view, p, primaryId, viewId); if (gate.phase !== 'applied') fail('state');
    reconcile(floor, gate, p);
    if (floor.format === 1) {
      if (gate.format === 1) {
        viewTx(view, () => {
          view!.exec(PUBLIC_STATE_SQL); view!.exec(PUBLIC_MEMORY_SQL); view!.exec(PUBLIC_FTS_SQL);
          for (const sql of Object.values(PUBLIC_FTS_TRIGGERS)) view!.exec(sql);
          view!.prepare("INSERT INTO bosun_public_state VALUES(1,2,'HOLD',?,NULL,NULL,NULL,NULL)").run(gate.source_id);
        });
        gate = validateGate(view, p, primaryId, viewId);
        await options.checkpoint?.('view-upgrade');
      } else {
        const state = publicState(view, gate);
        if (state.state !== 'HOLD' || state.generation !== null || state.publication_id !== null
          || view.prepare('SELECT 1 FROM public_memories LIMIT 1').get()) fail('state');
      }
      same(p.primary, primaryId); same(p.view, viewId); reconcile(floor, gate, p);
      installPublicFloor(source, gate);
      await options.checkpoint?.('format');
      same(p.primary, primaryId); same(p.view, viewId); reconcileBackup(gate, p);
      source.exec('COMMIT'); admitted = false;
      await options.checkpoint?.('format-commit');
      source.exec('BEGIN IMMEDIATE'); admitted = true;
      schema(source); floor = sourceFloor(source); if (!floor || floor.format !== 2) fail('state');
      gate = validateGate(view, p, primaryId, viewId); reconcile(floor, gate, p);
    }
    if (floor.format !== 2 || gate.format !== 2) fail('state');
    same(p.primary, primaryId); same(p.view, viewId); reconcileBackup(gate, p);
    owned = { paths: p, gate };
    const prior = publicState(view, gate);
    if (prior.publication_id === publicationId) fail('input');
    const stale = prior.state === 'READY' && prior.generation !== floor.generation;
    holdPublic(view, gate); // independent durable revocation precedes rebuild, even if source later rolls back
    if (stale) fail('state');
    await options.checkpoint?.('hold');
    const selectedAt = time(options.now); if (selectedAt < started) fail('input');
    same(p.primary, primaryId); same(p.view, viewId); reconcileBackup(gate, p);
    confirmed(source, view, p, gate);
    schema(source); const currentFloor = sourceFloor(source);
    if (!currentFloor || currentFloor.format !== 2 || currentFloor.generation !== floor.generation) fail('state');
    const rows = publicRows(source, selectedAt);
    view.exec('BEGIN IMMEDIATE'); viewTransaction = true;
    view.exec('DELETE FROM public_memories');
    const insert = view.prepare(`INSERT INTO public_memories(${PUBLIC_COLUMNS.join(',')}) VALUES(${PUBLIC_COLUMNS.map(() => '?').join(',')})`);
    for (const row of rows) insert.run(...PUBLIC_COLUMNS.map((key) => row[key] as string | number | null));
    await options.checkpoint?.('rows');
    const readyAt = time(options.now); if (readyAt < selectedAt) fail('input');
    const expiries = rows.filter((r) => r.expires_at !== null).map((r) => Number(r.expires_at));
    const validUntil = expiries.length ? Math.min(...expiries) : null;
    if (validUntil !== null && validUntil <= readyAt) fail('state');
    same(p.primary, primaryId); same(p.view, viewId); reconcileBackup(gate, p);
    confirmed(source, view, p, gate);
    const endFloor = sourceFloor(source); if (!endFloor || endFloor.format !== 2 || endFloor.generation !== floor.generation) fail('state');
    if (Number(view.prepare('PRAGMA page_count').get()!.page_count) * Number(view.prepare('PRAGMA page_size').get()!.page_size) > VIEW_MAX_BYTES) fail('state');
    view.prepare("UPDATE bosun_public_state SET state='READY',generation=?,publication_id=?,published_at=?,valid_until=? WHERE id=1")
      .run(Number(floor.generation), publicationId, readyAt, validUntil);
    await options.checkpoint?.('ready');
    const commitAt = time(options.now);
    if (commitAt < readyAt || validUntil !== null && validUntil <= commitAt) fail('state');
    same(p.primary, primaryId); same(p.view, viewId); reconcileBackup(gate, p);
    const commitFloor = sourceFloor(source); if (!commitFloor || commitFloor.format !== 2 || commitFloor.generation !== floor.generation) fail('state');
    confirmed(source, view, p, gate);
    view.exec('COMMIT'); viewTransaction = false; readyCommitted = true;
    const final = confirmed(source, view, p, gate); const state = publicState(view, final.gate);
    if (state.state !== 'READY' || state.publication_id !== publicationId || final.generation !== floor.generation) fail('state');
    source.exec('COMMIT'); admitted = false;
    return { state: 'READY', publicationId };
  } catch (e) {
    if (viewTransaction) try { view?.exec('ROLLBACK'); viewTransaction = false; } catch {}
    // Revoke only the exact already-validated owned inode/epoch; never repair a substituted/unknown artifact.
    const held = owned ? reholdOwned(owned, view) : false;
    if (readyCommitted && !held) fail('receipt_unknown');
    return mapped(e);
  }
  finally {
    let clean = true;
    if (viewTransaction) try { view?.exec('ROLLBACK'); } catch { clean = false; }
    if (admitted) try { source?.exec('ROLLBACK'); } catch { clean = false; }
    const viewClosed = closeNative(view); const sourceClosed = closeNative(source);
    if (!clean || !viewClosed || !sourceClosed) {
      const held = owned ? reholdOwned(owned) : false;
      fail(readyCommitted && !held ? 'receipt_unknown' : 'storage');
    }
  }
}

/** Registered connection pinned to its construction format; publication is an explicit separate operation. */
export class CutoverWriter {
  #source: DatabaseSync | null = null;
  #view: DatabaseSync | null = null;
  #paths!: CutoverPaths;
  #gate!: Gate;
  #admitted = false;
  #transactionControl = false;
  constructor(input: CutoverPaths) {
    try {
      this.#paths = paths(input);
      const p = this.#paths;
      this.#source = open(p.primary); runtime(this.#source);
      const viewId = viewIdentity(p);
      this.#view = open(p.view);
      this.#gate = validateGate(this.#view, p, identity(p.primary), viewId);
      if (this.#gate.phase !== 'applied') fail('state');
      schema(this.#source);
      const floor = sourceFloor(this.#source); if (!floor) fail('state');
      reconcile(floor, this.#gate, p);
      if (floor.format !== this.#gate.format) fail('state');
      const fn = this.#gate.format === 2 ? FN2 : FN;
      this.#source.function(fn, { directOnly: false }, () => {
        if (!this.#admitted || !this.#source?.isTransaction) fail('state');
        same(p.primary, { dev: this.#gate.source_dev, ino: this.#gate.source_ino });
        same(p.view, { dev: this.#gate.view_dev, ino: this.#gate.view_ino });
        holdPublic(this.#view!, this.#gate);
        return 1;
      });
      const ddl = new Set([constants.SQLITE_CREATE_TABLE, constants.SQLITE_CREATE_INDEX, constants.SQLITE_CREATE_TRIGGER,
        constants.SQLITE_CREATE_VIEW, constants.SQLITE_CREATE_VTABLE, constants.SQLITE_DROP_TABLE, constants.SQLITE_DROP_INDEX,
        constants.SQLITE_DROP_TRIGGER, constants.SQLITE_DROP_VIEW, constants.SQLITE_DROP_VTABLE, constants.SQLITE_ALTER_TABLE,
        constants.SQLITE_CREATE_TEMP_TABLE, constants.SQLITE_CREATE_TEMP_INDEX, constants.SQLITE_CREATE_TEMP_TRIGGER,
        constants.SQLITE_CREATE_TEMP_VIEW, constants.SQLITE_DROP_TEMP_TABLE, constants.SQLITE_DROP_TEMP_INDEX,
        constants.SQLITE_DROP_TEMP_TRIGGER, constants.SQLITE_DROP_TEMP_VIEW,
        constants.SQLITE_ATTACH, constants.SQLITE_DETACH]);
      this.#source.setAuthorizer((action, table, _column, _db, trigger) => {
        if (ddl.has(action) || action === constants.SQLITE_PRAGMA && !(table === 'data_version' && _column === null)) return constants.SQLITE_DENY;
        if (action === constants.SQLITE_TRANSACTION && !this.#transactionControl || action === constants.SQLITE_SAVEPOINT) return constants.SQLITE_DENY;
        if (action === constants.SQLITE_FUNCTION && [FN, FN2].includes(_column ?? '') && !TABLES.some((t) => ['insert', 'update', 'delete'].some((op) => trigger === triggerName(t, op)))) return constants.SQLITE_DENY;
        if ([constants.SQLITE_UPDATE, constants.SQLITE_INSERT, constants.SQLITE_DELETE].includes(action)
          && (table === PUBLIC_FLOOR || table === META && !TABLES.some((t) => ['insert', 'update', 'delete'].some((op) => trigger === triggerName(t, op))))) return constants.SQLITE_DENY;
        return constants.SQLITE_OK;
      });
    } catch (e) { try { this.close(); } catch {} mapped(e); }
  }
  /** Synchronous callback only; do not retain statements/connection or replace its floor function. */
  transaction<T>(write: (db: DatabaseSync) => T): T {
    if (!this.#source || !this.#view || this.#admitted || typeof write !== 'function') fail('state');
    try {
      const p = this.#paths;
      same(p.primary, { dev: this.#gate.source_dev, ino: this.#gate.source_ino });
      same(p.view, { dev: this.#gate.view_dev, ino: this.#gate.view_ino });
      this.#transactionControl = true;
      this.#source.exec('BEGIN IMMEDIATE'); this.#transactionControl = false; this.#admitted = true;
      // Revalidate the installed epoch/floor after acquiring actual write admission.
      const current = confirmed(this.#source, this.#view, p, this.#gate);
      if (current.gate.phase !== 'applied') fail('state');
      const result = write(this.#source);
      if (result === this.#source || result instanceof StatementSync || result && typeof (result as { then?: unknown }).then === 'function') fail('input');
      same(p.primary, { dev: this.#gate.source_dev, ino: this.#gate.source_ino });
      same(p.view, { dev: this.#gate.view_dev, ino: this.#gate.view_ino });
      this.#transactionControl = true;
      this.#source.exec('COMMIT'); this.#transactionControl = false; this.#admitted = false;
      return result;
    } catch (e) {
      this.#transactionControl = true;
      let rolledBack = true;
      if (this.#admitted) try { this.#source.exec('ROLLBACK'); } catch { rolledBack = false; try { this.close(); } catch {} }
      this.#admitted = false; this.#transactionControl = false;
      // Authoritative store validation/conflict errors survive only a successful rollback.
      const domain = rolledBack ? authoritative(e) : undefined;
      if (domain) throw domain;
      if (!rolledBack) fail('storage');
      mapped(e);
    }
  }
  /** Synchronous SQL reads for the owner store; never exposes a native handle as a property. */
  read<T>(read: (db: DatabaseSync) => T): T {
    if (!this.#source || typeof read !== 'function') fail('state');
    try {
      const current = confirmed(this.#source, this.#view!, this.#paths, this.#gate);
      if (current.gate.phase !== 'applied') fail('state');
      const result = read(this.#source);
      if (result === this.#source || result instanceof StatementSync || result && typeof (result as { then?: unknown }).then === 'function') fail('input');
      return result;
    } catch (e) { const domain = authoritative(e); if (domain) throw domain; return mapped(e); }
  }
  close(): void {
    const source = this.#source; const view = this.#view;
    this.#source = null; this.#view = null; this.#admitted = false;
    const sourceClosed = closeNative(source); const viewClosed = closeNative(view);
    if (!sourceClosed || !viewClosed) fail('storage');
  }
}
