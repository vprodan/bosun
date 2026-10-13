import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SqliteDatabase } from '../src/platform/sqlite.ts';
import { sandbox, fresh } from './helpers.ts';
import { openSchemaOneMemory } from './memory-store-fixture.ts';
import { MemoryError } from '../src/core/errors.ts';
import { cutoverMemory, CutoverWriter, CutoverError } from '../src/adapters/memory/sqlite-cutover.ts';

const LIMIT = 64 * 1024 * 1024;
async function fixture(options: { pageSize?: number; legacyBytes?: number } = {}) {
  const sb = sandbox(); fresh(sb);
  for (const name of ['primary', 'view', 'backups']) fs.mkdirSync(path.join(sb.root, name), { mode: 0o700 });
  const paths = { primary: path.join(sb.root, 'primary', 'memory.db'), view: path.join(sb.root, 'view', 'public.db'), backups: path.join(sb.root, 'backups') };
  if (options.pageSize) {
    fs.closeSync(fs.openSync(paths.primary, 'wx', 0o600)); const initial = new SqliteDatabase(paths.primary);
    try { initial.exec(`PRAGMA page_size=${options.pageSize}; VACUUM;`); } finally { initial.close(); }
  }
  let db = openSchemaOneMemory(paths.primary);
  db.exec("INSERT INTO memories(id,category,title,body,private,source,hash,created_at,updated_at) VALUES('m_saved','personal','PRIVATE canary title','PRIVATE canary body',1,'owner','saved-hash',1,1);");
  db.exec("INSERT INTO memory_events(memory_id,op,at,source,hash_after) VALUES('m_saved','store',1,'owner','saved-hash');");
  if (options.legacyBytes) {
    db.prepare("UPDATE memories SET source_ref=hex(randomblob(?)) WHERE id='m_saved'").run(options.legacyBytes / 2);
    db.close(); db = openSchemaOneMemory(paths.primary);
  }
  await cutoverMemory({ paths, now: () => 100, id: crypto.randomUUID });
  const writer = new CutoverWriter(paths);
  const state = () => Object.fromEntries(['memories', 'memory_events', 'bosun_source_floor'].map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()]));
  const bytes = () => fs.statSync(paths.primary).size + (fs.existsSync(paths.primary + '-wal') ? fs.statSync(paths.primary + '-wal').size : 0);
  return { sb, paths, db, writer, state, bytes, close() { writer.close(); if (db.isOpen) db.close(); sb.cleanup(); } };
}
const finite = (reason?: string) => (error: unknown) => {
  assert.ok(error instanceof CutoverError); if (reason) assert.equal(error.reason, reason);
  assert.doesNotMatch(error.message, /PRIVATE|\.db|canary/); return true;
};

for (const operation of ['read', 'transaction'] as const) for (const file of ['primary', 'wal'] as const) test(`cached ${operation} rejects actual oversized ${file} before callback`, async () => {
  const f = await fixture(); const target = file === 'primary' ? f.paths.primary : f.paths.primary + '-wal';
  const fd = fs.openSync(target, 'r+'); const length = fs.fstatSync(fd).size; let called = 0;
  try {
    fs.ftruncateSync(fd, LIMIT + 1);
    assert.throws(() => f.writer[operation](() => { called++; return 1; }), finite('state'));
    assert.equal(called, 0, 'positive counter: oversized source never invokes native callback');
    assert.equal(fs.fstatSync(fd).size, LIMIT + 1, 'rejection neither truncates nor checkpoints unknown extent');
  } finally { fs.ftruncateSync(fd, length); fs.closeSync(fd); f.close(); }
});

test('native large source/FTS transaction is refused without committed row/event/floor changes', async () => {
  const f = await fixture(); const before = f.state(); const exec = SqliteDatabase.prototype.exec; let called = 0; let full = 0; let source: SqliteDatabase | undefined;
  try {
    SqliteDatabase.prototype.exec = function (sql) {
      try { return exec.call(this, sql); } catch (error) { if (this === source && (error as { errcode?: number }).errcode === 13) full++; throw error; }
    };
    let failure: unknown;
    try { f.writer.transaction((db) => {
      called++; source = db;
      db.exec("INSERT INTO docs(path,project_id,mtime,title,body) VALUES('large.md','p_a',1,'Large entropy',hex(randomblob(40*1024*1024)));");
    }); } catch (error) { failure = error; }
    if (!failure) console.log('Native overflow baseline:', { bytes: f.bytes(), docs: f.db.prepare('SELECT count(*) AS n FROM docs').get()!.n, generation: f.db.prepare('SELECT generation FROM bosun_source_floor').get()!.generation });
    finite()(failure);
    assert.equal(called, 1, 'actual native DML attempted');
    assert.equal(full, 1, 'positive native SQLITE_FULL from max_page_count, not a mapped synthetic error');
    assert.deepEqual(f.state(), before); assert.equal(f.db.prepare('SELECT count(*) AS n FROM docs').get()!.n, 0);
    assert.ok(f.bytes() <= LIMIT);
    const query = new CutoverWriter(f.paths);
    try {
      assert.equal(query.read((db) => db.prepare('SELECT body FROM memories WHERE id=?').get('m_saved')!.body), 'PRIVATE canary body');
      query.transaction((db) => db.exec("UPDATE memories SET access_count=access_count+1 WHERE id='m_saved'"));
    } finally { query.close(); }
  } finally { SqliteDatabase.prototype.exec = exec; f.close(); }
});

test('registered higher-entropy pending FTS COMMIT hits native page limit with unchanged data and unknown receipt', async () => {
  const f = await fixture(); const before = f.state(); const body = crypto.randomBytes(8 * 1024 * 1024).toString('hex').replace(/(.{32})/g, '$1 ');
  const exec = SqliteDatabase.prototype.exec;
  let full = 0; let commitFull = 0; let acceptedRowStatement = 0; let source: SqliteDatabase | undefined;
  try {
    assert.ok(Buffer.byteLength(body) < 18 * 1024 * 1024, 'body alone is below the approximately 32MiB native reservation');
    SqliteDatabase.prototype.exec = function (sql) {
      try { return exec.call(this, sql); }
      catch (error) { if (this === source && sql === 'COMMIT' && (error as { errcode?: number }).errcode === 13) commitFull++; throw error; }
    };
    assert.throws(() => f.writer.transaction((db) => {
      source = db;
      try { const result = db.prepare('INSERT INTO docs(path,project_id,mtime,title,body) VALUES(?,?,?,?,?)').run('entropy.md','p_a',1,'Entropy FTS',body); acceptedRowStatement++; return result; }
      catch (error) { if ((error as { errcode?: number }).errcode === 13) full++; throw error; }
    }), finite('receipt_unknown'));
    assert.equal(full, 0); assert.equal(commitFull, 1); assert.equal(acceptedRowStatement, 1); assert.deepEqual(f.state(), before);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM docs').get()!.n, 0); assert.ok(f.bytes() <= LIMIT);
    let replay = 0; assert.throws(() => f.writer.read(() => { replay++; }), finite()); assert.equal(replay, 0);
    const freshWriter = new CutoverWriter(f.paths);
    try { freshWriter.transaction((db) => db.exec("UPDATE memories SET access_count=1 WHERE id='m_saved'")); }
    finally { freshWriter.close(); }
  } finally { SqliteDatabase.prototype.exec = exec; f.close(); }
});

test('error after actual native COMMIT has unknown receipt, committed data and a fenced cached writer', async () => {
  const f = await fixture(); const exec = SqliteDatabase.prototype.exec; let source: SqliteDatabase | undefined; let commits = 0;
  try {
    SqliteDatabase.prototype.exec = function (sql) {
      const result = exec.call(this, sql);
      if (this === source && sql === 'COMMIT') { commits++; throw new MemoryError('conflict', 'PRIVATE canary conflict', 99); }
      return result;
    };
    let failure: unknown;
    try { f.writer.transaction((db) => {
      source = db;
      db.exec("UPDATE memories SET access_count=access_count+1 WHERE id='m_saved'; INSERT INTO memories(id,category,title,body,source,hash,created_at,updated_at) VALUES('m_committed','personal','Actual committed row','actual committed words','owner','committed-hash',2,2); INSERT INTO memory_events(memory_id,op,at,source) VALUES('m_committed','store',2,'owner')");
    }); } catch (error) { failure = error; }
    assert.equal(commits, 1, 'real native COMMIT reached');
    assert.equal(f.db.prepare("SELECT access_count FROM memories WHERE id='m_saved'").get()!.access_count, 1);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM memory_events').get()!.n, 2);
    assert.equal(f.db.prepare("SELECT body FROM memories WHERE id='m_committed'").get()!.body, 'actual committed words');
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM memories_fts WHERE memories_fts MATCH 'committed'").get()!.n, 1);
    assert.equal(f.db.prepare('SELECT generation FROM bosun_source_floor').get()!.generation, 3);
    finite('receipt_unknown')(failure); assert.equal((failure as CutoverError).details?.outcome, 'unknown');
    let replay = 0; assert.throws(() => f.writer.transaction(() => { replay++; }), finite()); assert.equal(replay, 0);
    const reopened = new CutoverWriter(f.paths);
    try { assert.equal(reopened.read((db) => db.prepare("SELECT access_count FROM memories WHERE id='m_saved'").get()!.access_count), 1); }
    finally { reopened.close(); }
  } finally { SqliteDatabase.prototype.exec = exec; f.close(); }
});

test('error before native COMMIT retains exact domain identity only after successful rollback', async () => {
  const f = await fixture(); const exec = SqliteDatabase.prototype.exec; const before = f.state();
  const error = new MemoryError('conflict', 'owner conflict', 7); let source: SqliteDatabase | undefined; let rollbacks = 0;
  try {
    SqliteDatabase.prototype.exec = function (sql) {
      if (this === source && sql === 'COMMIT') throw error;
      const result = exec.call(this, sql); if (this === source && sql === 'ROLLBACK') rollbacks++;
      return result;
    };
    assert.throws(() => f.writer.transaction((db) => { source = db; db.exec("UPDATE memories SET access_count=3 WHERE id='m_saved'"); }), (e) => e === error);
    assert.equal(rollbacks, 1); assert.deepEqual(f.state(), before);
  } finally { SqliteDatabase.prototype.exec = exec; f.close(); }
});

test('error after actual native BEGIN releases unrecorded admission before any callback and permits a fresh write', async () => {
  const f = await fixture(); const before = f.state(); const exec = SqliteDatabase.prototype.exec;
  let begun: SqliteDatabase | undefined; let fault = true; let callbacks = 0; let rolledBack = 0;
  try {
    SqliteDatabase.prototype.exec = function (sql) {
      const result = exec.call(this, sql);
      if (sql === 'BEGIN IMMEDIATE' && fault) { fault = false; begun = this; assert.equal(this.isTransaction, true); throw Error('PRIVATE native admission canary'); }
      if (this === begun && sql === 'ROLLBACK') rolledBack++;
      return result;
    };
    assert.throws(() => f.writer.transaction(() => { callbacks++; }), finite());
    assert.equal(callbacks, 0); assert.ok(begun); assert.equal(begun.isTransaction, false); assert.equal(rolledBack, 1);
    assert.deepEqual(f.state(), before);
    f.db.exec('BEGIN IMMEDIATE'); f.db.exec('ROLLBACK');
    const freshWriter = new CutoverWriter(f.paths);
    try { freshWriter.transaction((db) => db.exec("UPDATE memories SET access_count=1 WHERE id='m_saved'")); }
    finally { freshWriter.close(); }
    assert.equal(f.db.prepare("SELECT access_count FROM memories WHERE id='m_saved'").get()!.access_count, 1);
    f.writer.transaction(() => { callbacks++; }); assert.equal(callbacks, 1, 'successful rollback keeps cached writer reusable');
  } finally { SqliteDatabase.prototype.exec = exec; f.close(); }
});

for (const operation of ['read', 'transaction'] as const) for (const kind of ['journal', 'wal-mode', 'parent-mode', 'wal-link'] as const) test(`cached ${operation} rejects changed ${kind} before callback without repair`, async () => {
  const f = await fixture(); const wal = f.paths.primary + '-wal'; let called = 0;
  try {
    if (kind === 'journal') fs.writeFileSync(f.paths.primary + '-journal', 'UNKNOWN journal canary', { mode: 0o600 });
    if (kind === 'wal-mode') fs.chmodSync(wal, 0o644);
    if (kind === 'parent-mode') fs.chmodSync(path.dirname(f.paths.primary), 0o755);
    if (kind === 'wal-link') { fs.renameSync(wal, wal + '-park'); fs.symlinkSync(wal + '-park', wal); }
    const stat = fs.lstatSync(kind === 'parent-mode' ? path.dirname(f.paths.primary) : kind === 'journal' ? f.paths.primary + '-journal' : wal);
    assert.throws(() => f.writer[operation](() => { called++; }), finite());
    assert.equal(called, 0);
    const after = fs.lstatSync(kind === 'parent-mode' ? path.dirname(f.paths.primary) : kind === 'journal' ? f.paths.primary + '-journal' : wal);
    assert.equal(after.mode, stat.mode); assert.equal(after.ino, stat.ino); assert.equal(after.size, stat.size);
  } finally {
    if (kind === 'journal') fs.unlinkSync(f.paths.primary + '-journal');
    if (kind === 'wal-mode') fs.chmodSync(wal, 0o600);
    if (kind === 'parent-mode') fs.chmodSync(path.dirname(f.paths.primary), 0o700);
    if (kind === 'wal-link') { fs.unlinkSync(wal); fs.renameSync(wal + '-park', wal); }
    f.close();
  }
});

for (const page of [512, 4096, 65536]) test(`native ${page}-byte pages honor exact conservative WAL eligibility boundary and checkpoint footprint`, async () => {
  const f = await fixture({ pageSize: page }); const before = f.state(); const wal = f.paths.primary + '-wal';
  const count = Number(f.db.prepare('PRAGMA page_count').get()!.page_count);
  assert.equal(f.db.prepare('PRAGMA page_size').get()!.page_size, page);
  const threshold = LIMIT - Math.max(fs.statSync(f.paths.primary).size, count * page) - count * (page + 24) - 32 - 65536 - (page + 24);
  const originalLength = fs.statSync(wal).size; assert.ok(threshold > originalLength);
  let source: SqliteDatabase | undefined; let touched = 0;
  try {
    const fd = fs.openSync(wal, 'r+'); try { fs.ftruncateSync(fd, threshold + 1); } finally { fs.closeSync(fd); }
    assert.throws(() => f.writer.transaction((db) => { source = db; touched++; db.exec("UPDATE memories SET access_count=1 WHERE id='m_saved'"); }), finite());
    assert.equal(touched, 1, 'callback entered but floor rejects before protected source DML');
    assert.deepEqual(f.state(), before); assert.equal(fs.statSync(wal).size, threshold + 1);
    const retryFd = fs.openSync(wal, 'r+'); try { fs.ftruncateSync(retryFd, threshold); } finally { fs.closeSync(retryFd); }
    f.writer.transaction((db) => { assert.equal(db, source); db.exec("UPDATE memories SET access_count=1 WHERE id='m_saved'"); });
    assert.equal(f.db.prepare("SELECT access_count FROM memories WHERE id='m_saved'").get()!.access_count, 1);
    assert.ok(f.bytes() <= LIMIT);
    const check = f.db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get()!; assert.equal(check.busy, 0);
    assert.ok(f.bytes() <= LIMIT, 'checkpoint may grow primary while retaining WAL');
    f.db.close(); f.writer.close();
    assert.ok(fs.statSync(f.paths.primary).size <= LIMIT); assert.equal(fs.existsSync(wal), false, 'last native close deletes WAL');
    const reopened = new CutoverWriter(f.paths);
    try { assert.equal(reopened.read((db) => db.prepare("SELECT access_count FROM memories WHERE id='m_saved'").get()!.access_count), 1); }
    finally { reopened.close(); }
  } finally { f.close(); }
});

test('eligible larger legacy store keeps reads and no-DML maintenance while refusing protected DML', async () => {
  const f = await fixture({ legacyBytes: 36 * 1024 * 1024 }); const before = f.state();
  try {
    assert.ok(f.bytes() > 32 * 1024 * 1024 && f.bytes() <= LIMIT);
    assert.equal(f.writer.read((db) => db.prepare("SELECT body FROM memories WHERE id='m_saved'").get()!.body), 'PRIVATE canary body');
    f.writer.transaction((db) => db.exec("UPDATE memories SET status='archived' WHERE expires_at<0"));
    assert.deepEqual(f.state(), before, 'legacy expire0/no-op transaction succeeds without generation changes');
    assert.throws(() => f.writer.transaction((db) => db.exec("UPDATE memories SET access_count=1 WHERE id='m_saved'")), finite());
    assert.deepEqual(f.state(), before);
    assert.equal(f.writer.read((db) => db.prepare('SELECT count(*) AS n FROM memory_events').get()!.n), 1);
  } finally { f.close(); }
});

test('driver PRAGMA prepare failure clears private authorization and callback controls remain denied', async () => {
  const f = await fixture(); const prepare = SqliteDatabase.prototype.prepare; let failNext = true; let attempts = 0; let called = 0;
  try {
    SqliteDatabase.prototype.prepare = function (sql) {
      if (sql.startsWith('PRAGMA main.max_page_count=')) { attempts++; if (failNext) { failNext = false; throw Error('PRIVATE driver control canary'); } }
      return prepare.call(this, sql);
    };
    assert.throws(() => f.writer.transaction(() => { called++; }), finite()); assert.equal(called, 0); assert.equal(attempts, 1);
    f.writer.transaction((db) => {
      called++;
      for (const sql of ['PRAGMA max_page_count=999999', 'PRAGMA cache_spill=ON', 'PRAGMA page_count', 'PRAGMA journal_mode=DELETE', 'PRAGMA wal_checkpoint(TRUNCATE)', 'SAVEPOINT untrusted']) assert.throws(() => db.exec(sql), /authoriz/);
      db.exec("UPDATE memories SET access_count=1 WHERE id='m_saved'");
    });
    assert.equal(called, 1); assert.equal(attempts, 3, 'fresh pre/post-DML native controls after failed private prepare');
    assert.equal(f.db.prepare('PRAGMA journal_mode').get()!.journal_mode, 'wal');
  } finally { SqliteDatabase.prototype.prepare = prepare; f.close(); }
});

test('post-native-COMMIT confirmation read failure reports unknown and preserves committed rows without replay', async () => {
  const f = await fixture(); const exec = SqliteDatabase.prototype.exec; const prepare = SqliteDatabase.prototype.prepare;
  let source: SqliteDatabase | undefined; let committed = false; let failures = 0;
  try {
    SqliteDatabase.prototype.exec = function (sql) { const result = exec.call(this, sql); if (this === source && sql === 'COMMIT') committed = true; return result; };
    SqliteDatabase.prototype.prepare = function (sql) {
      if (this === source && committed && sql.includes('bosun_source_floor')) { failures++; throw Error('PRIVATE post-commit read canary'); }
      return prepare.call(this, sql);
    };
    assert.throws(() => f.writer.transaction((db) => { source = db; db.exec("UPDATE memories SET access_count=2 WHERE id='m_saved'"); }), finite('receipt_unknown'));
    assert.ok(committed); assert.ok(failures > 0); assert.equal(f.db.prepare("SELECT access_count FROM memories WHERE id='m_saved'").get()!.access_count, 2);
    assert.equal(f.db.prepare('SELECT generation FROM bosun_source_floor').get()!.generation, 1);
    let replay = 0; assert.throws(() => f.writer.read(() => { replay++; }), finite()); assert.equal(replay, 0);
  } finally { SqliteDatabase.prototype.exec = exec; SqliteDatabase.prototype.prepare = prepare; f.close(); }
});

for (const spill of [true, false]) test(`native dirty-page probe observes cache_spill=${spill} before actual commit`, () => {
  const sb = sandbox(); fresh(sb); const file = path.join(sb.root, 'spill.db'); const db = openSchemaOneMemory(file);
  const bytes = () => fs.statSync(file + '-wal').size;
  try {
    db.exec(`PRAGMA wal_autocheckpoint=0; PRAGMA cache_size=1; PRAGMA cache_spill=${spill ? 'ON' : 'OFF'}; BEGIN IMMEDIATE;`);
    const before = bytes();
    db.exec("INSERT INTO docs(path,project_id,mtime,title,body) VALUES('spill.md','p_a',1,'Spill canary',hex(randomblob(2*1024*1024)))");
    const pending = bytes();
    if (spill) assert.ok(pending > before, 'positive native cache spill grows WAL during DML');
    else assert.equal(pending, before, 'native OFF keeps main dirty pages off WAL before COMMIT');
    db.exec('COMMIT'); assert.ok(bytes() > before);
    assert.equal(db.prepare('SELECT length(body) AS n FROM docs').get()!.n, 4 * 1024 * 1024);
    console.log('Native dirty-page qualification:', { spill, before, pending, committed: bytes() });
  } finally { if (db.isTransaction) db.exec('ROLLBACK'); db.close(); sb.cleanup(); }
});

for (const full of [false, true]) test(`native FTS xSync ${full ? 'page-limit failure' : 'allocation'} occurs at actual COMMIT`, () => {
  const sb = sandbox(); fresh(sb); const file = path.join(sb.root, 'fts.db'); fs.closeSync(fs.openSync(file, 'wx', 0o600));
  const initial = new SqliteDatabase(file); initial.exec('PRAGMA page_size=512; VACUUM;'); initial.close();
  const db = openSchemaOneMemory(file); const count = () => Number(db.prepare('PRAGMA page_count').get()!.page_count);
  try {
    // A native FTS primitive isolates xSync without the legacy triggers' implicit
    // statement savepoints, which can flush their terms before COMMIT.
    db.exec("CREATE VIRTUAL TABLE commit_terms USING fts5(body,content='')");
    db.exec('PRAGMA cache_spill=OFF; PRAGMA wal_autocheckpoint=0; BEGIN IMMEDIATE');
    const insert = db.prepare('INSERT INTO commit_terms(body) VALUES(?)');
    for (let i = 0; i < 100; i++) insert.run(`unique${i} lateword ` + Array.from({ length: 300 }, (_, j) => `distinct${i}term${j}`).join(' '));
    const pending = count(); let error: unknown;
    if (full) db.prepare(`PRAGMA max_page_count=${pending}`).get();
    try { db.exec('COMMIT'); } catch (e) { error = e; }
    const activeAfterAttempt = db.isTransaction;
    if (full) {
      assert.equal((error as { errcode: number } | undefined)?.errcode, 13, 'actual native SQLITE_FULL during FTS COMMIT');
      if (db.isTransaction) db.exec('ROLLBACK');
      assert.equal(db.prepare("SELECT count(*) AS n FROM commit_terms WHERE commit_terms MATCH 'lateword'").get()!.n, 0);
    } else {
      assert.equal(error, undefined); assert.ok(count() > pending, 'actual native FTS pages allocated after pre-COMMIT page_count');
      assert.equal(db.prepare("SELECT count(*) AS n FROM commit_terms WHERE commit_terms MATCH 'lateword'").get()!.n, 100);
    }
    console.log('Native FTS COMMIT qualification:', { full, pendingPages: pending, finalPages: count(), activeAfterAttempt });
  } finally { if (db.isTransaction) db.exec('ROLLBACK'); db.close(); sb.cleanup(); }
});
