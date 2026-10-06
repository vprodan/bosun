// Explicit owner cutover/publication and registered admission. No automatic floor installation or hook reader.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync, StatementSync, backup, constants } from 'node:sqlite';
import { BosunError, MemoryError } from '../../core/errors.ts';
import { norm } from '../../core/text.ts';
import { GATE_SQL, PUBLIC_STATE_SQL, PUBLIC_MEMORY_SQL, PUBLIC_FTS_SQL, PUBLIC_FTS_TRIGGERS, PUBLIC_SQL, PUBLIC_COLUMNS, PUBLIC_MAX_ROWS, PUBLIC_MAX_BYTES, VIEW_MAX_BYTES, RESTORE_PENDING_SUFFIX, RESTORE_RECEIPT_SUFFIX, normalize } from './sqlite-public-protocol.ts';

const FLOOR = 1;
const FN = 'bosun_writer_floor_v1';
const FN2 = 'bosun_writer_floor_v2';
const PUBLIC_FLOOR = 'bosun_public_floor';
const META = 'bosun_source_floor';
const MAX_BYTES = 64 * 1024 * 1024;
// SQLite FULL WAL commit may repeat its last frame through the next sector boundary.
// sqlite3SectorSize caps that boundary at 64 KiB; reserve one further full frame.
const WAL_SECTOR_BYTES = 64 * 1024;
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
export { RESTORE_PENDING_SUFFIX, RESTORE_RECEIPT_SUFFIX };
export function hasPendingMemoryRestore(view: string): boolean { return present(view + RESTORE_PENDING_SUFFIX); }
export type CutoverPhase = 'intent' | 'backup' | 'floor' | 'commit';
export type CutoverOptions = {
  paths: CutoverPaths;
  now: () => number;
  id: () => string;
  /** Explicit owner workflow only. No native handles are passed; validation must be synchronous. */
  expectation?: { operation: 'apply' | 'reconcile' | 'recover'; sourceId: string; validate: () => void };
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
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1n || Number(s.mode & 0o7777n) !== 0o600
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
function paths(input: CutoverPaths, ownerRestore = false): CutoverPaths {
  if (!input) fail('input');
  const p = { primary: input.primary, view: input.view, backups: input.backups };
  if (!ownerRestore && present(p.view + RESTORE_PENDING_SUFFIX)) fail('state');
  canonical(p.primary, true); canonical(p.view, present(p.view));
  if (typeof p.backups !== 'string' || path.resolve(p.backups) !== p.backups || fs.realpathSync(p.backups) !== p.backups) fail('path');
  for (const dir of [p.backups, path.dirname(p.view), path.dirname(p.primary)]) {
    const s = fs.statSync(dir);
    if (!s.isDirectory() || (s.mode & 0o7777) !== 0o700 || process.getuid && s.uid !== process.getuid()) fail('path');
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
    || !integer(r.started_at) || r.started_at > 8_640_000_000_000_000 || r.backup_hash !== null && !/^[a-f0-9]{64}$/.test(r.backup_hash)
    || (r.phase === 'copying' ? r.backup_hash !== null : r.backup_hash === null)) fail('state');
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
  if (present(p.view + RESTORE_PENDING_SUFFIX)) fail('state');
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
    const expectation = options.expectation;
    if (expectation !== undefined && (!expectation || !['apply', 'reconcile', 'recover'].includes(expectation.operation)
      || typeof expectation.sourceId !== 'string' || !UUID.test(expectation.sourceId) || typeof expectation.validate !== 'function')) fail('input');
    // Validate injected values before any reservation or gate creation.
    const started = time(options.now); const attempt = freshId(options.id); const newEpoch = freshId(options.id);
    if (attempt === newEpoch) fail('input');
    if (expectation?.operation === 'apply' && newEpoch !== expectation.sourceId) fail('input');
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
    // Independent owner expectations and filesystem freshness are checked under actual admission,
    // before revocation, artifact reservation, gate changes or floor installation.
    if (expectation) {
      if (expectation.operation === 'apply' ? !!floor || !!gate : expectation.operation === 'recover'
        ? !!floor || !gate || gate.source_id !== expectation.sourceId
        : !floor || !gate || floor.source_id !== expectation.sourceId || gate.source_id !== expectation.sourceId) fail('identity');
      if (expectation.operation === 'recover') recoveryGate(gate!, p);
      if (expectation.validate() !== undefined) fail('input');
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
    if (gate) recoveryGate(gate, p);
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
function recoveryGate(gate: Gate, p: CutoverPaths): void {
  if (gate.format !== 1 || !['copying', 'backed'].includes(gate.phase)) fail('state');
  if (gate.phase === 'backed') reconcileBackup(gate, p);
  else {
    if (gate.backup_hash !== null) fail('state');
    const file = path.join(p.backups, gate.backup_name);
    // Only a valid gate's exact referenced inode may be incomplete. Never read its unfinished bytes.
    if (fs.statSync(file).size > MAX_BYTES || ['-wal', '-shm', '-journal'].some((s) => present(file + s))) fail('backup');
  }
}
/** Owner-only reference inspection. Never opens the primary or an unreferenced artifact through SQLite. */
export function inspectOwnerCutoverReference(p: CutoverPaths, names: readonly string[], sourceId?: string, recover = false): { index: number; phase: 'copying' | 'backed' | 'applied' } {
  let view: DatabaseSync | undefined;
  try {
    if (sourceId !== undefined && (typeof sourceId !== 'string' || !UUID.test(sourceId)) || recover && sourceId === undefined
      || !Array.isArray(names) || names.length > 32 || names.some((name) => typeof name !== 'string' || !UUID.test(name.slice(0, -3)) || !name.endsWith('.db'))) fail('input');
    p = paths(p); const source = identity(p.primary); const fixed = viewIdentity(p);
    view = new DatabaseSync(p.view, { readOnly: true, allowExtension: false, defensive: true, enableDoubleQuotedStringLiterals: false });
    view.exec('PRAGMA query_only=ON; PRAGMA temp_store=MEMORY; PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN;');
    runtime(view);
    const gate = validateGate(view, p, source, fixed);
    if (sourceId !== undefined && gate.source_id !== sourceId) fail('identity');
    const index = names.indexOf(gate.backup_name); if (index < 0) fail('identity');
    if (recover) recoveryGate(gate, p); else reconcileBackup(gate, p);
    same(p.primary, source); same(p.view, fixed); paths(p); viewIdentity(p);
    return { index, phase: gate.phase as 'copying' | 'backed' | 'applied' };
  } catch (e) { return mapped(e); }
  finally { if (!closeNative(view)) fail('storage'); }
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

// Immutable owner-only intent. The reader checks its filename only, never these recovery values.
const RESTORE_META_BYTES = 16 * 1024;
const RESTORE_MAX_ROWS = 100_000;
type CapsuleIdentity = Identity & { hash: string };
type RestoreIntent = { version: 1; old: Gate; generation: number; newSourceId: string; attemptId: string;
  backupDev: string; backupIno: string; startedAt: number; priorReceipt: CapsuleIdentity | null };
type Capsule = { intent: RestoreIntent; identity: CapsuleIdentity };
export type RestorePhase = 'intent' | 'hold' | 'backup' | 'rows' | 'source-commit' | 'view-commit' | 'receipt';
export type RestoreReceipt = CutoverReceipt & { outcome: 'committed' | 'rolled_back'; previousSourceId: string };
export type RestoreOptions = { paths: CutoverPaths; sourceId: string; newSourceId: string; attemptId: string;
  operation: 'restore' | 'restore-reconcile'; now: () => number; validate: () => void;
  checkpoint?: (phase: RestorePhase) => void | Promise<void> };
function exactFields(value: unknown, names: readonly string[]): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Reflect.ownKeys(value).length !== names.length
    || Reflect.ownKeys(value).some((name) => typeof name !== 'string' || !names.includes(name))) fail('state');
  const out: Row = {};
  for (const name of names) {
    const d = Object.getOwnPropertyDescriptor(value, name); if (!d || !Object.hasOwn(d, 'value')) fail('state');
    out[name] = d.value;
  }
  return out;
}
const GATE_FIELDS = ['id', 'protocol', 'state', 'phase', 'source_id', 'attempt_id', 'source_dev', 'source_ino',
  'view_dev', 'view_ino', 'backup_name', 'backup_dev', 'backup_ino', 'backup_hash', 'started_at'] as const;
function parseIntent(text: string): RestoreIntent {
  const r = exactFields(JSON.parse(text), ['version', 'old', 'generation', 'newSourceId', 'attemptId', 'backupDev', 'backupIno', 'startedAt', 'priorReceipt']);
  if (JSON.stringify(JSON.parse(text)) !== text) fail('state');
  const old = exactFields(r.old, [...GATE_FIELDS, 'format']) as unknown as Gate;
  const decimal = (v: unknown) => typeof v === 'string' && /^[0-9]{1,30}$/.test(v);
  const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
  if (r.version !== 1 || !integer(r.generation) || !stamp(r.startedAt) || old.id !== 1 || old.protocol !== 1
    || old.state !== 'HOLD' || old.phase !== 'applied' || ![1, 2].includes(old.format!) || !stamp(old.started_at)
    || !UUID.test(old.source_id) || !UUID.test(old.attempt_id) || !hash(old.backup_hash) || old.backup_name !== old.attempt_id + '.db'
    || ![old.source_dev, old.source_ino, old.view_dev, old.view_ino, old.backup_dev, old.backup_ino, r.backupDev, r.backupIno].every(decimal)
    || typeof r.newSourceId !== 'string' || !UUID.test(r.newSourceId) || typeof r.attemptId !== 'string' || !UUID.test(r.attemptId)
    || new Set([old.source_id, old.attempt_id, r.newSourceId, r.attemptId]).size !== 4) fail('state');
  if (r.priorReceipt !== null) {
    const prior = exactFields(r.priorReceipt, ['dev', 'ino', 'hash']);
    if (!decimal(prior.dev) || !decimal(prior.ino) || !hash(prior.hash)) fail('state');
  }
  return { ...r, old } as RestoreIntent;
}
function readCapsule(file: string): Capsule {
  canonical(file, true); const fixed = identity(file); const before = fs.lstatSync(file, { bigint: true });
  if (before.size < 1n || before.size > BigInt(RESTORE_META_BYTES)) fail('state');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    for (const key of ['dev', 'ino', 'mode', 'uid', 'nlink', 'size', 'mtimeNs', 'ctimeNs'] as const) if (opened[key] !== before[key]) fail('identity');
    bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) fail('identity');
      offset += count;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    for (const key of ['dev', 'ino', 'mode', 'uid', 'nlink', 'size', 'mtimeNs', 'ctimeNs'] as const) if (after[key] !== before[key]) fail('identity');
  } finally { fs.closeSync(fd); }
  same(file, fixed); const after = fs.lstatSync(file, { bigint: true });
  for (const key of ['size', 'mtimeNs', 'ctimeNs'] as const) if (after[key] !== before[key]) fail('identity');
  const intent = parseIntent(bytes.toString('utf8'));
  return { intent, identity: { ...fixed, hash: crypto.createHash('sha256').update(bytes).digest('hex') } };
}
function sameCapsule(file: string, expected: CapsuleIdentity): Capsule {
  const current = readCapsule(file);
  if (JSON.stringify(current.identity) !== JSON.stringify(expected)) fail('identity');
  return current;
}
function syncDirectory(directory: string): void {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function writeIntent(p: CutoverPaths, intent: RestoreIntent): Capsule {
  const text = JSON.stringify(intent); parseIntent(text);
  if (Buffer.byteLength(text) > RESTORE_META_BYTES) fail('state');
  const file = p.view + RESTORE_PENDING_SUFFIX;
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  syncDirectory(path.dirname(p.view)); return readCapsule(file);
}
function gateEqual(a: Gate, b: Gate): boolean { return [...GATE_FIELDS, 'format'].every((key) => a[key as keyof Gate] === b[key as keyof Gate]); }
function restoreGate(intent: RestoreIntent, outcome: 'committed' | 'rolled_back', hash?: string): Gate {
  if (outcome === 'rolled_back') return { ...intent.old, source_id: intent.newSourceId };
  if (!hash) fail('backup');
  return { ...intent.old, source_id: intent.newSourceId, attempt_id: intent.attemptId, backup_name: intent.attemptId + '.db',
    backup_dev: intent.backupDev, backup_ino: intent.backupIno, backup_hash: hash, started_at: intent.startedAt };
}
function completedReceipt(p: CutoverPaths, gate: Gate): Capsule | undefined {
  const file = p.view + RESTORE_RECEIPT_SUFFIX;
  if (!present(file)) return undefined;
  const capsule = readCapsule(file); const intent = capsule.intent;
  const outcome = gate.attempt_id === intent.attemptId ? 'committed' : 'rolled_back';
  const expected = restoreGate(intent, outcome, gate.backup_hash ?? undefined);
  // Explicit publication can upgrade the converged store after its receipt was saved.
  // That changes only the validated protocol format, never the recorded epoch/reference.
  if (expected.format === 1 && gate.format === 2) expected.format = 2;
  if (!gateEqual(expected, gate)) fail('identity');
  // The prior selected backup is still owned and preserved even after the current reference changes.
  bindGate(intent.old, p, { dev: gate.source_dev, ino: gate.source_ino }, { dev: gate.view_dev, ino: gate.view_ino });
  reconcileBackup(intent.old, p);
  const artifact = path.join(p.backups, intent.attemptId + '.db');
  same(artifact, { dev: intent.backupDev, ino: intent.backupIno });
  if (fs.statSync(artifact).size > MAX_BYTES || ['-wal', '-shm', '-journal'].some((suffix) => present(artifact + suffix))) fail('backup');
  return capsule;
}
function priorReceipt(p: CutoverPaths, intent: RestoreIntent): void {
  const file = p.view + RESTORE_RECEIPT_SUFFIX;
  if (intent.priorReceipt) {
    sameCapsule(file, intent.priorReceipt); completedReceipt(p, intent.old);
  } else if (present(file)) fail('identity');
}
function intentArtifacts(intent: RestoreIntent, p: CutoverPaths, source: Identity, view: Identity): void {
  bindGate(intent.old, p, source, view);
  const artifact = path.join(p.backups, intent.attemptId + '.db');
  same(artifact, { dev: intent.backupDev, ino: intent.backupIno });
  if (fs.statSync(artifact).size > MAX_BYTES || ['-wal', '-shm', '-journal'].some((suffix) => present(artifact + suffix))) fail('backup');
}
function intentBinding(intent: RestoreIntent, p: CutoverPaths, source: Identity, view: Identity, ownedRecovery = false): void {
  paths(p, true); same(p.primary, source); same(p.view, view); viewIdentity(p, ownedRecovery);
  intentArtifacts(intent, p, source, view);
  reconcileBackup(intent.old, p);
  priorReceipt(p, intent);
}
// No journal payload is read. The trusted-app boundary binds its mutable filesystem
// identity to the reviewed plan; source authority must still be proved under admission.
function restoreJournal(p: CutoverPaths): string {
  const file = p.view + '-journal'; canonical(file, true); identity(file);
  const s = fs.lstatSync(file, { bigint: true });
  if (s.size < 512n || s.size > BigInt(MAX_BYTES)) fail('state');
  return JSON.stringify(['dev', 'ino', 'mode', 'uid', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].map((key) => String(s[key as keyof fs.BigIntStats])));
}
/** Explicit owner planning only. A pending journal uses capsule/filesystem metadata;
 * otherwise only the journal-free rollback view is opened natively, never primary/backup. */
export function inspectOwnerRestore(p: CutoverPaths, names: readonly string[], sourceId: string, newSourceId?: string): {
  reference: 'verified' | 'unverified'; index: number; ownedNames: string[]; attemptId: string | null; newSourceId: string | null;
  pending: boolean; outcome: 'committed' | 'rolled_back' | null;
} {
  let view: DatabaseSync | undefined;
  try {
    if (typeof sourceId !== 'string' || !UUID.test(sourceId) || newSourceId !== undefined && (typeof newSourceId !== 'string' || !UUID.test(newSourceId))
      || !Array.isArray(names) || names.length > 32) fail('input');
    p = paths(p, true); const source = identity(p.primary);
    const journal = present(p.view + '-journal'); const pending = present(p.view + RESTORE_PENDING_SUFFIX);
    if (journal) {
      if (!pending || newSourceId === undefined) fail('state');
      const fixed = viewIdentity(p, true); const journalBefore = restoreJournal(p);
      const capsule = readCapsule(p.view + RESTORE_PENDING_SUFFIX); const intent = capsule.intent;
      if (intent.old.source_id !== sourceId || intent.newSourceId !== newSourceId) fail('identity');
      intentArtifacts(intent, p, source, fixed);
      const receiptFile = p.view + RESTORE_RECEIPT_SUFFIX;
      if (intent.priorReceipt) sameCapsule(receiptFile, intent.priorReceipt); else if (present(receiptFile)) fail('identity');
      const index = names.indexOf(intent.old.backup_name); if (index < 0 || !names.includes(intent.attemptId + '.db')) fail('identity');
      sameCapsule(p.view + RESTORE_PENDING_SUFFIX, capsule.identity); same(p.primary, source); same(p.view, fixed);
      if (restoreJournal(p) !== journalBefore) fail('identity');
      return { reference: 'unverified', index, ownedNames: [intent.old.backup_name, intent.attemptId + '.db'],
        attemptId: intent.attemptId, newSourceId: intent.newSourceId, pending: true, outcome: null };
    }
    const fixed = viewIdentity(p);
    view = new DatabaseSync(p.view, { readOnly: true, allowExtension: false, defensive: true, enableDoubleQuotedStringLiterals: false });
    view.exec('PRAGMA query_only=ON; PRAGMA temp_store=MEMORY; PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN;'); runtime(view);
    const gate = validateGate(view, p, source, fixed); if (gate.phase !== 'applied') fail('state');
    let intent: RestoreIntent | undefined; let outcome: 'committed' | 'rolled_back' | null = null;
    if (newSourceId !== undefined) {
      intent = readCapsule(p.view + (pending ? RESTORE_PENDING_SUFFIX : RESTORE_RECEIPT_SUFFIX)).intent;
      if (intent.old.source_id !== sourceId || intent.newSourceId !== newSourceId) fail('identity');
      if (pending) {
        intentBinding(intent, p, source, fixed);
        if (!gateEqual(gate, intent.old) && !gateEqual(gate, restoreGate(intent, 'committed', gate.backup_hash ?? undefined))
          && !gateEqual(gate, restoreGate(intent, 'rolled_back'))) fail('identity');
      } else { completedReceipt(p, gate); outcome = gate.attempt_id === intent.attemptId ? 'committed' : 'rolled_back'; }
    } else {
      if (pending || gate.source_id !== sourceId) fail('identity');
      intent = completedReceipt(p, gate)?.intent;
    }
    reconcileBackup(gate, p);
    const index = names.indexOf(newSourceId !== undefined ? intent!.old.backup_name : gate.backup_name); if (index < 0) fail('identity');
    same(p.primary, source); same(p.view, fixed); viewIdentity(p);
    return { reference: 'verified', index, ownedNames: [...new Set([gate.backup_name, ...(intent ? [intent.old.backup_name, intent.attemptId + '.db'] : [])])],
      attemptId: newSourceId !== undefined ? intent!.attemptId : null, newSourceId: newSourceId !== undefined ? intent!.newSourceId : null, pending, outcome };
  } catch (e) { return mapped(e); }
  finally { if (!closeNative(view)) fail('storage'); }
}
async function exactBackup(p: CutoverPaths, file: string, fixed: Identity): Promise<string> {
  let copy: DatabaseSync | undefined;
  try {
    copy = open(p.primary, true); await backup(copy, file, { source: 'main', target: 'main', rate: 100 });
    if (!closeNative(copy)) fail('storage'); copy = undefined;
    const artifact = open(file);
    try {
      if (artifact.prepare('PRAGMA journal_mode=DELETE').get()!.journal_mode !== 'delete'
        || artifact.prepare('PRAGMA quick_check').get()!.quick_check !== 'ok') fail('backup');
      schema(artifact); sourceFloor(artifact);
    } finally { if (!closeNative(artifact)) fail('storage'); }
    const hash = digestBackup(file, fixed); const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    syncDirectory(p.backups); return hash;
  } finally { if (!closeNative(copy)) fail('storage'); }
}
function restoreRows(source: DatabaseSync, artifact: DatabaseSync): void {
  let bytes = 0; let total = 0;
  // Existing AFTER triggers maintain both external-content FTS indexes. Keep all explicit primary keys.
  for (const table of TABLES) {
    const columns = artifact.prepare(`PRAGMA table_info(${table})`).all().map((r) => String(r.name));
    const select = artifact.prepare(`SELECT ${columns.join(',')} FROM ${table} ORDER BY 1`); select.setReadBigInts(true);
    const insert = source.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`);
    source.exec(`DELETE FROM ${table}`);
    for (const row of select.iterate()) {
      if (++total > RESTORE_MAX_ROWS) fail('state');
      const values = columns.map((column) => row[column] as string | number | bigint | Uint8Array | null);
      for (const value of values) bytes += typeof value === 'string' ? Buffer.byteLength(value) : value instanceof Uint8Array ? value.byteLength : 8;
      if (bytes > MAX_BYTES) fail('state'); insert.run(...values);
    }
  }
  const migration = artifact.prepare('SELECT applied_at FROM schema_migrations WHERE version=1'); migration.setReadBigInts(true);
  source.prepare('UPDATE schema_migrations SET applied_at=? WHERE version=1').run(migration.get()!.applied_at as bigint);
  if (source.prepare('PRAGMA quick_check').get()!.quick_check !== 'ok') fail('state');
}
function rotateFloor(source: DatabaseSync, gate: Gate, generation: number): void {
  source.prepare(`UPDATE ${META} SET source_id=?,attempt_id=?,generation=?,backup_name=?,backup_dev=?,backup_ino=?,backup_hash=?,started_at=? WHERE id=1`)
    .run(gate.source_id, gate.attempt_id, generation, gate.backup_name, gate.backup_dev, gate.backup_ino, gate.backup_hash, gate.started_at);
  if (gate.format === 2) source.prepare(`UPDATE ${PUBLIC_FLOOR} SET source_id=? WHERE id=1`).run(gate.source_id);
}
function rotateView(view: DatabaseSync, gate: Gate): void {
  viewTx(view, () => {
    view.prepare(`UPDATE bosun_cutover_gate SET source_id=?,attempt_id=?,backup_name=?,backup_dev=?,backup_ino=?,backup_hash=?,started_at=? WHERE id=1`)
      .run(gate.source_id, gate.attempt_id, gate.backup_name, gate.backup_dev, gate.backup_ino, gate.backup_hash, gate.started_at);
    if (gate.format === 2) view.prepare("UPDATE bosun_public_state SET state='HOLD',source_id=?,generation=NULL,publication_id=NULL,published_at=NULL,valid_until=NULL WHERE id=1").run(gate.source_id);
  });
}
function restoreConfirmed(source: DatabaseSync, view: DatabaseSync, p: CutoverPaths, gate: Gate): number {
  same(p.primary, { dev: gate.source_dev, ino: gate.source_ino }); same(p.view, { dev: gate.view_dev, ino: gate.view_ino });
  schema(source); const floor = sourceFloor(source); if (!floor) fail('state');
  const current = validateGate(view, p, identity(p.primary), viewIdentity(p));
  if (!gateEqual(gate, current) || floor.format !== current.format) fail('identity'); reconcile(floor, current, p);
  if (current.format === 2 && publicState(view, current).state !== 'HOLD') fail('state');
  return Number(floor.generation);
}
/** Bounded logical restoration of the CURRENT verified owner reference; no live DB/WAL file copy. */
export async function restoreMemory(options: RestoreOptions): Promise<RestoreReceipt> {
  let source: DatabaseSync | undefined; let view: DatabaseSync | undefined; let artifact: DatabaseSync | undefined; let admitted = false;
  let effected = false;
  try {
    if (!options || !['restore', 'restore-reconcile'].includes(options.operation) || typeof options.sourceId !== 'string' || !UUID.test(options.sourceId)
      || typeof options.newSourceId !== 'string' || !UUID.test(options.newSourceId) || typeof options.attemptId !== 'string' || !UUID.test(options.attemptId)
      || new Set([options.sourceId, options.newSourceId, options.attemptId]).size !== 3 || typeof options.now !== 'function' || typeof options.validate !== 'function'
      || options.checkpoint !== undefined && typeof options.checkpoint !== 'function') fail('input');
    const startedAt = time(options.now); const p = paths(options.paths, true); const primaryId = identity(p.primary);
    const journal = present(p.view + '-journal');
    if (journal && (options.operation !== 'restore-reconcile' || !hasPendingMemoryRestore(p.view))) fail('state');
    const fixed = viewIdentity(p, journal); const journalBefore = journal ? restoreJournal(p) : null;
    const recovering = journal ? readCapsule(p.view + RESTORE_PENDING_SUFFIX) : undefined;
    if (recovering && (recovering.intent.old.source_id !== options.sourceId || recovering.intent.newSourceId !== options.newSourceId
      || recovering.intent.attemptId !== options.attemptId)) fail('identity');
    source = open(p.primary); runtime(source); source.exec('BEGIN IMMEDIATE'); admitted = true;
    same(p.primary, primaryId); paths(p, true); schema(source); const floor = sourceFloor(source); if (!floor) fail('state');
    if (recovering) {
      const intent = recovering.intent;
      intentBinding(intent, p, primaryId, fixed, true);
      // Independently supplied epochs plus the actual admitted source floor are
      // required BEFORE SQLite can recover any view bytes. The old floor permits
      // its reserved unfinished backup; a new committed floor requires its digest.
      if (floor.source_id === intent.old.source_id) {
        if (floor.format !== intent.old.format || floor.generation !== intent.generation) fail('identity');
        reconcile(floor, intent.old, p);
      } else if (floor.source_id === intent.newSourceId) {
        const outcome = floor.attempt_id === intent.attemptId ? 'committed' : 'rolled_back';
        const expected = restoreGate(intent, outcome, String(floor.backup_hash));
        if (floor.format !== expected.format) fail('identity'); reconcile(floor, expected, p);
      } else fail('identity');
      if (options.validate() !== undefined) fail('input');
      intentBinding(intent, p, primaryId, fixed, true); sameCapsule(p.view + RESTORE_PENDING_SUFFIX, recovering.identity);
      if (restoreJournal(p) !== journalBefore) fail('identity');
      // Native recovery can change storage even if subsequent schema validation
      // fails. Preserve pending fencing and classify that result as uncertain.
      effected = true;
    }
    view = open(p.view); let gate = validateGate(view, p, primaryId, fixed); if (gate.phase !== 'applied' || floor.format !== gate.format) fail('state');
    let capsule: Capsule; let outcome: 'committed' | 'rolled_back'; let generation: number;
    if (options.operation === 'restore') {
      if (hasPendingMemoryRestore(p.view) || floor.source_id !== options.sourceId || gate.source_id !== options.sourceId) fail('identity');
      reconcile(floor, gate, p); const previous = completedReceipt(p, gate);
      if (options.validate() !== undefined) fail('input');
      const target = path.join(p.backups, gate.backup_name); reconcileBackup(gate, p);
      artifact = new DatabaseSync(target, { readOnly: true, allowExtension: false, defensive: true, enableDoubleQuotedStringLiterals: false });
      artifact.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=0; PRAGMA temp_store=MEMORY; PRAGMA locking_mode=EXCLUSIVE; BEGIN;');
      runtime(artifact); schema(artifact); sourceFloor(artifact);
      if (artifact.prepare('PRAGMA quick_check').get()!.quick_check !== 'ok') fail('backup');
      const backupId = reserve(path.join(p.backups, options.attemptId + '.db')); effected = true;
      const intent: RestoreIntent = { version: 1, old: { ...gate, format: gate.format }, generation: Number(floor.generation),
        newSourceId: options.newSourceId, attemptId: options.attemptId, backupDev: backupId.dev, backupIno: backupId.ino,
        startedAt, priorReceipt: previous?.identity ?? null };
      capsule = writeIntent(p, intent); await options.checkpoint?.('intent');
      intentBinding(intent, p, primaryId, fixed); sameCapsule(p.view + RESTORE_PENDING_SUFFIX, capsule.identity);
      holdPublic(view, gate); await options.checkpoint?.('hold');
      intentBinding(intent, p, primaryId, fixed); sameCapsule(p.view + RESTORE_PENDING_SUFFIX, capsule.identity);
      if (!gateEqual(validateGate(view, p, primaryId, fixed), intent.old)
        || gate.format === 2 && publicState(view, gate).state !== 'HOLD') fail('state');
      const hash = await exactBackup(p, path.join(p.backups, intent.attemptId + '.db'), backupId);
      await options.checkpoint?.('backup');
      sameCapsule(p.view + RESTORE_PENDING_SUFFIX, capsule.identity); intentBinding(intent, p, primaryId, fixed);
      reconcileBackup(gate, p);
      if (!gateEqual(validateGate(view, p, primaryId, fixed), intent.old)
        || gate.format === 2 && publicState(view, gate).state !== 'HOLD') fail('state');
      // This UDF is private to the explicit operation and returns only after independent durable HOLD.
      source.function(gate.format === 2 ? FN2 : FN, { directOnly: false }, () => {
        if (!admitted || !source?.isTransaction) fail('state');
        same(p.primary, primaryId); same(p.view, fixed);
        same(p.view + RESTORE_PENDING_SUFFIX, capsule.identity);
        return 1;
      });
      restoreRows(source, artifact); await options.checkpoint?.('rows');
      intentBinding(intent, p, primaryId, fixed); sameCapsule(p.view + RESTORE_PENDING_SUFFIX, capsule.identity);
      if (!gateEqual(validateGate(view, p, primaryId, fixed), intent.old)
        || gate.format === 2 && publicState(view, gate).state !== 'HOLD') fail('state');
      if (!closeNative(artifact)) fail('storage'); artifact = undefined;
      gate = restoreGate(intent, 'committed', hash); rotateFloor(source, gate, 0); outcome = 'committed'; generation = 0;
    } else {
      const pending = hasPendingMemoryRestore(p.view);
      capsule = readCapsule(p.view + (pending ? RESTORE_PENDING_SUFFIX : RESTORE_RECEIPT_SUFFIX)); const intent = capsule.intent;
      if (recovering && JSON.stringify(capsule.identity) !== JSON.stringify(recovering.identity)) fail('identity');
      if (intent.old.source_id !== options.sourceId || intent.newSourceId !== options.newSourceId || intent.attemptId !== options.attemptId) fail('identity');
      if (!pending) {
        completedReceipt(p, gate); reconcile(floor, gate, p);
        if (floor.source_id !== intent.newSourceId) fail('identity');
        if (options.validate() !== undefined) fail('input');
        generation = Number(floor.generation); outcome = gate.attempt_id === intent.attemptId ? 'committed' : 'rolled_back';
        holdPublic(view, gate);
        paths(p, true); same(p.primary, primaryId); same(p.view, fixed);
        sameCapsule(p.view + RESTORE_RECEIPT_SUFFIX, capsule.identity);
        restoreConfirmed(source, view, p, gate);
        source.exec('COMMIT'); admitted = false;
        generation = restoreConfirmed(source, view, p, gate);
        return { ...receipt(gate, generation), outcome, previousSourceId: intent.old.source_id };
      }
      intentBinding(intent, p, primaryId, fixed);
      if (!recovering && options.validate() !== undefined) fail('input');
      effected = true;
      if (floor.source_id === intent.old.source_id) {
        if (!gateEqual(gate, intent.old)) fail('identity'); reconcile(floor, gate, p);
        if (floor.generation !== intent.generation) fail('identity');
        holdPublic(view, gate); gate = restoreGate(intent, 'rolled_back'); generation = intent.generation; outcome = 'rolled_back';
        rotateFloor(source, gate, generation);
      } else if (floor.source_id === intent.newSourceId) {
        outcome = floor.attempt_id === intent.attemptId ? 'committed' : 'rolled_back';
        gate = restoreGate(intent, outcome, String(floor.backup_hash));
        reconcile(floor, gate, p); if (floor.format !== gate.format) fail('identity');
        generation = Number(floor.generation);
        const current = validateGate(view, p, primaryId, fixed);
        if (!gateEqual(current, intent.old) && !gateEqual(current, gate)) fail('identity');
        holdPublic(view, current);
      } else fail('identity');
    }
    const intent = capsule.intent;
    sameCapsule(p.view + RESTORE_PENDING_SUFFIX, capsule.identity); intentBinding(intent, p, primaryId, fixed);
    const preparedFloor = sourceFloor(source); if (!preparedFloor || preparedFloor.format !== gate.format) fail('identity');
    reconcile(preparedFloor, gate, p);
    source.exec('COMMIT'); admitted = false;
    await options.checkpoint?.('source-commit');
    // Pending filename fences other registered authorities during the two-database commit gap.
    const committed = sourceFloor(source); if (!committed || committed.format !== gate.format) fail('identity'); reconcile(committed, gate, p);
    intentBinding(intent, p, primaryId, fixed); sameCapsule(p.view + RESTORE_PENDING_SUFFIX, capsule.identity);
    rotateView(view, gate); await options.checkpoint?.('view-commit');
    generation = restoreConfirmed(source, view, p, gate);
    sameCapsule(p.view + RESTORE_PENDING_SUFFIX, capsule.identity); priorReceipt(p, intent);
    fs.renameSync(p.view + RESTORE_PENDING_SUFFIX, p.view + RESTORE_RECEIPT_SUFFIX); syncDirectory(path.dirname(p.view));
    sameCapsule(p.view + RESTORE_RECEIPT_SUFFIX, capsule.identity); completedReceipt(p, gate);
    await options.checkpoint?.('receipt');
    generation = restoreConfirmed(source, view, p, gate);
    return { ...receipt(gate, generation), outcome, previousSourceId: intent.old.source_id };
  } catch (e) { if (effected) fail('receipt_unknown'); return mapped(e); }
  finally {
    let clean = closeNative(artifact);
    if (admitted) try { source?.exec('ROLLBACK'); } catch { clean = false; }
    const sourceClosed = closeNative(source); const viewClosed = closeNative(view);
    if (!clean || !sourceClosed || !viewClosed) fail(effected ? 'receipt_unknown' : 'storage');
  }
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
  #pragma: { name: string; value: string | null } | null = null;
  #capacityAllowed = false;
  #protectedDml = false;
  constructor(input: CutoverPaths) {
    try {
      this.#paths = paths(input);
      const p = this.#paths;
      this.#source = open(p.primary); runtime(this.#source);
      // Keep dirty pages in the native cache until the one pending WAL commit.
      // This is connection-local and never changes source journal mode or schema.
      this.#source.exec('PRAGMA cache_spill=OFF');
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
        if (!this.#capacityAllowed) fail('state');
        this.#protectedDml = true;
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
        if (ddl.has(action) || action === constants.SQLITE_PRAGMA
          && !(table === 'data_version' && _column === null)
          && !(this.#pragma?.name === table && this.#pragma.value === _column && (_db === null || _db === 'main'))) return constants.SQLITE_DENY;
        if (action === constants.SQLITE_TRANSACTION && !this.#transactionControl || action === constants.SQLITE_SAVEPOINT) return constants.SQLITE_DENY;
        if (action === constants.SQLITE_FUNCTION && [FN, FN2].includes(_column ?? '') && !TABLES.some((t) => ['insert', 'update', 'delete'].some((op) => trigger === triggerName(t, op)))) return constants.SQLITE_DENY;
        if ([constants.SQLITE_UPDATE, constants.SQLITE_INSERT, constants.SQLITE_DELETE].includes(action)
          && (table === PUBLIC_FLOOR || table === META && !TABLES.some((t) => ['insert', 'update', 'delete'].some((op) => trigger === triggerName(t, op))))) return constants.SQLITE_DENY;
        return constants.SQLITE_OK;
      });
    } catch (e) { try { this.close(); } catch {} mapped(e); }
  }
  // Exact driver-only authorization, cleared even when prepare/get throws. Callbacks
  // cannot set or inspect these controls through the ordinary PRAGMA SQL interface.
  #control(name: string, value: number | null = null): unknown {
    this.#pragma = { name, value: value === null ? null : String(value) };
    try { return this.#source!.prepare(`PRAGMA main.${name}${value === null ? '' : '=' + value}`).get()?.[name]; }
    finally { this.#pragma = null; }
  }
  #confirmed(): { gate: Gate; generation: number } {
    paths(this.#paths); viewIdentity(this.#paths);
    return confirmed(this.#source!, this.#view!, this.#paths, this.#gate);
  }
  #reserveCapacity(): void {
    const p = this.#paths;
    if (this.#control('journal_mode') !== 'wal' || this.#control('cache_spill') !== 0) fail('state');
    const page = this.#control('page_size'); const count = this.#control('page_count');
    if (!integer(page) || page < 512 || page > 65536 || (page & (page - 1)) !== 0 || !integer(count) || count < 1) fail('state');
    const sourceBytes = fs.statSync(p.primary).size;
    const walBytes = present(p.primary + '-wal') ? fs.statSync(p.primary + '-wal').size : 0;
    const frame = page + 24;
    const remaining = MAX_BYTES - walBytes - 32 - WAL_SECTOR_BYTES - frame;
    // Both inequalities bound max(physical source, final logical source) plus
    // the entire existing WAL extent and at most one dirty frame per page.
    const limit = Math.min(Math.floor((remaining - sourceBytes) / frame), Math.floor(remaining / (page + frame)));
    this.#capacityAllowed = limit >= count;
    // max_page_count cannot be reduced below the current native page count.
    // Keep larger eligible stores queryable; their first protected DML refuses.
    const applied = this.#control('max_page_count', Math.max(count, limit));
    if (applied !== Math.max(count, limit)) fail('state');
  }
  /** Synchronous callback only; do not retain statements/connection or replace its floor function. */
  transaction<T>(write: (db: DatabaseSync) => T): T {
    if (!this.#source || !this.#view || this.#admitted || typeof write !== 'function') fail('state');
    let admissionAttempted = false; let commitAttempted = false; let committed = false;
    try {
      const p = this.#paths;
      paths(p); viewIdentity(p);
      same(p.primary, { dev: this.#gate.source_dev, ino: this.#gate.source_ino });
      same(p.view, { dev: this.#gate.view_dev, ino: this.#gate.view_ino });
      this.#transactionControl = true;
      admissionAttempted = true;
      this.#source.exec('BEGIN IMMEDIATE'); this.#transactionControl = false; this.#admitted = true;
      // Revalidate the installed epoch/floor after acquiring actual write admission.
      const current = this.#confirmed();
      if (current.gate.phase !== 'applied') fail('state');
      this.#reserveCapacity();
      const result = write(this.#source);
      if (result === this.#source || result instanceof StatementSync || result && typeof (result as { then?: unknown }).then === 'function') fail('input');
      this.#confirmed();
      this.#reserveCapacity();
      if (this.#protectedDml && !this.#capacityAllowed) fail('state');
      this.#transactionControl = true;
      commitAttempted = true;
      this.#source.exec('COMMIT'); committed = true; this.#transactionControl = false; this.#admitted = false;
      this.#capacityAllowed = false; this.#protectedDml = false;
      // A post-commit check can only produce an uncertain receipt, never a domain
      // refusal that implies the source was unchanged or safe to replay.
      this.#confirmed();
      return result;
    } catch (e) {
      this.#transactionControl = true;
      let rolledBack = false;
      // A native wrapper can throw after BEGIN acquired admission, before our
      // bookkeeping assignment. Inspect/release that actual transaction too.
      let nativeAdmission = this.#admitted; let unreadableAdmission = false;
      try { if (admissionAttempted && !committed) nativeAdmission ||= this.#source.isTransaction; }
      catch { unreadableAdmission = true; }
      if (nativeAdmission) try { this.#source.exec('ROLLBACK'); rolledBack = true; } catch {}
      const uncertain = committed || commitAttempted && !rolledBack;
      const poison = unreadableAdmission || nativeAdmission && !rolledBack || uncertain;
      this.#admitted = false; this.#transactionControl = false; this.#capacityAllowed = false; this.#protectedDml = false; this.#pragma = null;
      if (poison) try { this.close(); } catch {}
      if (uncertain) fail('receipt_unknown');
      // Authoritative store validation/conflict errors survive only a successful rollback.
      const domain = rolledBack ? authoritative(e) : undefined;
      if (domain) throw domain;
      mapped(e);
    }
  }
  /** Synchronous SQL reads for the owner store; never exposes a native handle as a property. */
  read<T>(read: (db: DatabaseSync) => T): T {
    if (!this.#source || typeof read !== 'function') fail('state');
    try {
      const current = this.#confirmed();
      if (current.gate.phase !== 'applied') fail('state');
      const result = read(this.#source);
      if (result === this.#source || result instanceof StatementSync || result && typeof (result as { then?: unknown }).then === 'function') fail('input');
      return result;
    } catch (e) { const domain = authoritative(e); if (domain) throw domain; return mapped(e); }
  }
  close(): void {
    const source = this.#source; const view = this.#view;
    this.#source = null; this.#view = null; this.#admitted = false; this.#capacityAllowed = false; this.#protectedDml = false; this.#pragma = null; this.#transactionControl = false;
    const sourceClosed = closeNative(source); const viewClosed = closeNative(view);
    if (!sourceClosed || !viewClosed) fail('storage');
  }
}
