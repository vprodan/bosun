import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SqliteDatabase, type SqliteStatement, sqliteBackup } from '../src/platform/sqlite.ts';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { sandbox, fresh, REPO } from './helpers.ts';
import { openSchemaOneMemory } from './memory-store-fixture.ts';
import { cutoverMemory, CutoverWriter, CutoverError, type CutoverPaths, type CutoverOptions } from '../src/adapters/memory/sqlite-cutover.ts';
import { sqliteWalSafe } from '../src/platform/sqlite-runtime.ts';

test('loaded SQLite must retain a patched WAL branch irrespective of compiler version', () => {
  for (const version of ['3.44.6', '3.50.7', '3.51.3', '3.52.0', '3.53.0']) assert.equal(sqliteWalSafe(version), true);
  for (const version of ['3.44.5', '3.45.9', '3.46.0', '3.49.9', '3.50.6', '3.51.2', '4.0.0', '3.53.0-custom', '3.53.0.1', '', null, 3.53])
    assert.equal(sqliteWalSafe(version), false);
});

function fixture() {
  const sb = sandbox(); fresh(sb);
  for (const name of ['primary', 'view', 'backups']) fs.mkdirSync(path.join(sb.root, name), { mode: 0o700 });
  const paths = { primary: path.join(sb.root, 'primary', 'memory.db'), view: path.join(sb.root, 'view', 'public.db'), backups: path.join(sb.root, 'backups') };
  const db = openSchemaOneMemory(paths.primary);
  db.prepare(`INSERT INTO memories(id,category,title,body,tags,private,source,source_ref,hash,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run('m_private', 'personal', 'PRIVATE title canary', 'PRIVATE body canary', '["private-tags"]', 1, 'PRIVATE source', 'PRIVATE ref', 'PRIVATE hash', 1, 1);
  db.prepare(`INSERT INTO memories(id,category,title,body,source,hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`)
    .run('m_public', 'personal', 'Public title', 'Public body words', 'owner', 'public-hash', 2, 2);
  db.prepare('INSERT INTO memory_events(memory_id,op,at,source,hash_after) VALUES(?,?,?,?,?)').run('m_private', 'add', 1, 'PRIVATE audit', 'PRIVATE audit hash');
  db.prepare('INSERT INTO docs(path,project_id,mtime,title,body) VALUES(?,?,?,?,?)').run('doc.md', 'p_a', 1, 'Doc title', 'Doc body');
  const scoped = db.prepare(`INSERT INTO memories(id,category,project_id,session_id,title,body,status,shared,source,hash,created_at,updated_at,expires_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const [id, category, project, session, status, shared, expires] of [
    ['m_project', 'project', 'p_a', null, 'active', 0, null],
    ['m_shared', 'project', 'p_b', null, 'active', 1, null],
    ['m_expired', 'session', 'p_a', 's_a', 'active', 0, 1],
    ['m_proposed', 'personal', null, null, 'proposed', 0, null],
    ['m_archived', 'project', 'p_a', null, 'archived', 0, null],
  ] as const) scoped.run(id, category, project, session, id, 'Scoped preserved body', status, shared, 'owner', id + '-hash', 2, 2, expires);
  return { sb, paths, db, close() { db.close(); sb.cleanup(); } };
}
const options = (paths: CutoverPaths): CutoverOptions => ({ paths, now: () => 100, id: () => crypto.randomUUID() });
const rows = (db: SqliteDatabase, table: string) => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all();

test('cutover native qualification: pinned schema and owner artifact format', async () => {
  const f = fixture(); const file = path.join(f.paths.backups, 'qualification.db'); let source: SqliteDatabase | undefined;
  try {
    const schema = f.db.prepare("SELECT name,type,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE 'bosun_%' ORDER BY name").all();
    const hash = crypto.createHash('sha256').update(JSON.stringify(schema.map((r) => [r.name, r.type, r.tbl_name, typeof r.sql === 'string' ? r.sql.replace(/\s+/g, ' ').trim() : '']))).digest('hex');
    assert.equal(hash, '3cb4d90795d1afc8819cae315ed6835876bc85de27b9b1ceb603a1b98c1f57e2');
    f.db.exec('BEGIN IMMEDIATE');
    fs.closeSync(fs.openSync(file, 'wx', 0o600));
    source = new SqliteDatabase(f.paths.primary, { readOnly: true });
    await sqliteBackup(source, file, {}); source.close(); source = undefined;
    assert.deepEqual([...fs.readFileSync(file).subarray(18, 20)], [2, 2], 'native backup inherits WAL format');
    const copy = new SqliteDatabase(file, { readOnly: true });
    try { assert.deepEqual(rows(copy, 'memories'), rows(f.db, 'memories')); } finally { copy.close(); }
    assert.deepEqual(fs.readdirSync(f.paths.backups).sort(), ['qualification.db', 'qualification.db-shm', 'qualification.db-wal']);
    const owner = new SqliteDatabase(file);
    try { assert.equal(owner.prepare('PRAGMA journal_mode=DELETE').get()!.journal_mode, 'delete'); } finally { owner.close(); }
    assert.deepEqual([...fs.readFileSync(file).subarray(18, 20)], [1, 1]);
    assert.deepEqual(fs.readdirSync(f.paths.backups), ['qualification.db']);
    f.db.exec('ROLLBACK');
  } finally { source?.close(); if (f.db.isTransaction) f.db.exec('ROLLBACK'); f.close(); }
});

test('cutover holds write admission across exact native backup and persistent floor; old prepared DML is fenced', async () => {
  const f = fixture(); const old = new SqliteDatabase(f.paths.primary); old.exec('PRAGMA busy_timeout=0;');
  const writes = ["UPDATE memories SET private=1 WHERE id='m_public'", "DELETE FROM memories WHERE id='m_public'",
    "INSERT INTO memories(id,category,title,body,source,hash,created_at,updated_at) VALUES('m_new','personal','T','B','S','H',1,1)",
    "UPDATE memories SET access_count=access_count+1", "UPDATE memory_events SET source='changed'", "UPDATE docs SET body='changed'"];
  const prepared = writes.map((sql) => old.prepare(sql));
  const before = Object.fromEntries(['memories', 'memory_events', 'docs', 'schema_migrations'].map((t) => [t, rows(f.db, t)]));
  try {
    const result = await cutoverMemory({ ...options(f.paths), checkpoint(phase) {
      assert.throws(() => old.exec(writes[0]), phase === 'commit' ? /no such function.*bosun_writer_floor_v1/ : /locked/, phase);
    } });
    assert.deepEqual(Object.keys(result).sort(), ['attemptId', 'floor', 'generation', 'sourceId', 'state']);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|\.db|backup|hash|title|body/);
    assert.equal(result.state, 'HOLD');
    for (const s of prepared) assert.throws(() => s.run(), /no such function.*bosun_writer_floor_v1/);
    const copy = new SqliteDatabase(path.join(f.paths.backups, result.attemptId + '.db'), { readOnly: true });
    try {
      for (const [table, expected] of Object.entries(before)) {
        assert.deepEqual(rows(copy, table), expected); assert.deepEqual(rows(f.db, table), expected);
      }
      assert.equal(copy.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'bosun_%'").get()!.n, 0);
      assert.deepEqual(copy.prepare('SELECT rowid,title,body,tags FROM memories_fts ORDER BY rowid').all(),
        f.db.prepare('SELECT rowid,title,body,tags FROM memories_fts ORDER BY rowid').all());
      assert.deepEqual(copy.prepare('SELECT rowid,title,body FROM docs_fts ORDER BY rowid').all(),
        f.db.prepare('SELECT rowid,title,body FROM docs_fts ORDER BY rowid').all());
    } finally { copy.close(); }
    assert.doesNotMatch(fs.readFileSync(f.paths.view).toString(), /PRIVATE|Public body/);
    const files = fs.readdirSync(f.paths.backups); assert.deepEqual(files, [result.attemptId + '.db']);
    assert.equal(fs.statSync(path.join(f.paths.backups, files[0])).mode & 0o777, 0o600);
    assert.deepEqual([...fs.readFileSync(path.join(f.paths.backups, files[0])).subarray(18, 20)], [1, 1]);
  } finally { old.close(); f.close(); }
});

test('cutover registration requires actual wrapper admission; old read snapshots and cached handles cannot mutate', async () => {
  const f = fixture(); const reader = new SqliteDatabase(f.paths.primary); let writer: CutoverWriter | undefined;
  try {
    reader.exec('BEGIN'); reader.prepare('SELECT * FROM memories').all();
    const result = await cutoverMemory(options(f.paths));
    assert.throws(() => reader.exec("UPDATE memories SET body='stale' WHERE id='m_public'"), /locked|no such function/);
    reader.exec('ROLLBACK');
    writer = new CutoverWriter(f.paths);
    let cached: SqliteDatabase | undefined; let prepared: SqliteStatement | undefined;
    writer.transaction((db) => { cached = db; prepared = db.prepare("UPDATE memories SET title='Changed' WHERE id='m_public'"); prepared.run(); });
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM memories_fts WHERE memories_fts MATCH 'changed'").get()!.n, 1, 'registered writes retain FTS maintenance');
    assert.equal(f.db.prepare('SELECT generation FROM bosun_source_floor').get()!.generation, 1);
    assert.throws(() => prepared!.run());
    assert.throws(() => cached!.exec('BEGIN'), /authorized/);
    assert.throws(() => writer!.transaction((db) => db.exec('COMMIT')), CutoverError);
    assert.throws(() => writer!.transaction((db) => db.exec('BEGIN')), CutoverError);
    assert.throws(() => writer!.transaction((db) => db.exec('SAVEPOINT sneak')), CutoverError);
    assert.throws(() => writer!.transaction((db) => db.exec('DROP TRIGGER bosun_floor_memories_update')), CutoverError);
    assert.throws(() => writer!.transaction((db) => { db.exec("UPDATE memories SET body='rollback' WHERE id='m_public'"); throw Error('PRIVATE provider error canary'); }), (e: unknown) => {
      assert.ok(e instanceof CutoverError); assert.doesNotMatch(e.message, /PRIVATE/); return true;
    });
    assert.equal(f.db.prepare("SELECT body FROM memories WHERE id='m_public'").get()!.body, 'Public body words');
    assert.equal(f.db.prepare('SELECT generation FROM bosun_source_floor').get()!.generation, 1);
    assert.throws(() => writer!.transaction(async (db) => db.exec("UPDATE memories SET body='bad async' WHERE id='m_public'")), CutoverError);
    assert.equal(f.db.prepare("SELECT body FROM memories WHERE id='m_public'").get()!.body, 'Public body words');
    const again = await cutoverMemory(options(f.paths));
    assert.deepEqual(again, { ...result, generation: 1 });
    assert.deepEqual(fs.readdirSync(f.paths.backups), [result.attemptId + '.db']);
    const gate = new SqliteDatabase(f.paths.view, { readOnly: true });
    try { assert.equal(gate.prepare('SELECT state FROM bosun_cutover_gate').get()!.state, 'HOLD'); } finally { gate.close(); }
  } finally { writer?.close(); reader.close(); f.close(); }
});

async function crash(paths: CutoverPaths, phase: string, cwd: string): Promise<void> {
  const code = `import ${JSON.stringify(pathToFileURL(path.join(REPO, 'test/bootstrap.ts')).href)};
    import {cutoverMemory} from ${JSON.stringify(pathToFileURL(path.join(REPO, 'src/adapters/memory/sqlite-cutover.ts')).href)};
    import {randomUUID} from 'node:crypto';
    await cutoverMemory({paths:JSON.parse(process.argv[1]),now:()=>100,id:randomUUID,
      async checkpoint(p){if(p===process.argv[2]) {process.stdout.write('CUTOVER_CHECKPOINT\\n'); await new Promise(()=>{});}}});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, JSON.stringify(paths), phase], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise<void>((resolve, reject) => {
    let marker = false; let output = ''; let error = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.stdout.on('data', (chunk) => { output += chunk; if (output.includes('CUTOVER_CHECKPOINT') && !marker) { marker = true; child.kill('SIGKILL'); } });
    child.stderr.on('data', (chunk) => { error = (error + chunk).slice(-1000); });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      clearTimeout(timeout);
      if (!marker || signal !== 'SIGKILL') reject(Error(`synthetic cutover missed ${phase}: ${code}/${signal} ${error}`)); else resolve();
    });
  });
}

test('cutover process crashes recover with fresh exact backups before commit, or reconcile committed floor without doubleapply', async () => {
  for (const phase of ['intent', 'backup', 'floor', 'commit']) {
    const f = fixture();
    try {
      assert.ok(fs.statSync(f.paths.primary + '-wal').size > 0, 'synthetic data remains in live WAL');
      await crash(f.paths, phase, f.sb.root);
      const oldFiles = fs.readdirSync(f.paths.backups);
      assert.equal(oldFiles.length, 1);
      const preserved = fs.readFileSync(path.join(f.paths.backups, oldFiles[0]));
      const hasFloor = Boolean(f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='bosun_source_floor'").get());
      assert.equal(hasFloor, phase === 'commit');
      if (!hasFloor) f.db.exec("UPDATE memories SET title='changed between attempts' WHERE id='m_public'");
      const result = await cutoverMemory(options(f.paths));
      assert.deepEqual(fs.readFileSync(path.join(f.paths.backups, oldFiles[0])), preserved, 'prior artifact never overwritten');
      assert.equal(fs.readdirSync(f.paths.backups).length, hasFloor ? 1 : 2);
      assert.equal(result.attemptId + '.db' === oldFiles[0], hasFloor);
      const copy = new SqliteDatabase(path.join(f.paths.backups, result.attemptId + '.db'), { readOnly: true });
      try { for (const t of ['memories', 'memory_events', 'docs']) assert.deepEqual(rows(copy, t), rows(f.db, t)); } finally { copy.close(); }
      const again = await cutoverMemory(options(f.paths)); assert.deepEqual(again, result);
      assert.equal(f.db.prepare('SELECT generation FROM bosun_source_floor').get()!.generation, 0);
    } finally { f.close(); }
  }
});

test('cutover failed callbacks/errors are finite and restart never reuses a stale backup', async () => {
  const f = fixture();
  try {
    await assert.rejects(cutoverMemory({ ...options(f.paths), checkpoint(phase) {
      if (phase === 'backup') throw { get errcode() { throw Error('PRIVATE getter canary'); }, message: 'PRIVATE provider canary' };
    } }), (e: unknown) => { assert.ok(e instanceof CutoverError); assert.equal(e.reason, 'storage'); assert.doesNotMatch(JSON.stringify(e), /PRIVATE/); return true; });
    assert.equal(f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='bosun_source_floor'").get(), undefined);
    const first = fs.readdirSync(f.paths.backups)[0]; const bytes = fs.readFileSync(path.join(f.paths.backups, first));
    f.db.exec("UPDATE memories SET private=1 WHERE id='m_public'");
    const result = await cutoverMemory(options(f.paths)); assert.notEqual(result.attemptId + '.db', first);
    assert.deepEqual(fs.readFileSync(path.join(f.paths.backups, first)), bytes);
    const copy = new SqliteDatabase(path.join(f.paths.backups, result.attemptId + '.db'), { readOnly: true });
    try { assert.equal(copy.prepare("SELECT private FROM memories WHERE id='m_public'").get()!.private, 1); } finally { copy.close(); }
  } finally { f.close(); }
});

test('cutover never returns messages/causes from mutated typed errors or hostile exception prototypes', async () => {
  for (const kind of ['typed', 'proxy']) {
    const f = fixture();
    try {
      await assert.rejects(cutoverMemory({ ...options(f.paths), checkpoint() {
        if (kind === 'typed') { const error = new CutoverError('storage'); error.message = 'PRIVATE typed error canary'; error.cause = { private: 'PRIVATE cause' }; throw error; }
        throw new Proxy({}, { getPrototypeOf() { throw Error('PRIVATE prototype canary'); }, get() { throw Error('PRIVATE getter canary'); } });
      } }), (e: unknown) => {
        assert.ok(e instanceof CutoverError); assert.doesNotMatch(e.message + JSON.stringify(e), /PRIVATE/); assert.equal(e.cause, undefined); return true;
      });
    } finally { f.close(); }
  }
});

test('cutover unknown schema, corrupt storage, symlinks and artifact collisions fail closed without overwrite', async () => {
  for (const kind of ['schema', 'corrupt', 'symlink', 'collision', 'mode']) {
    const f = fixture();
    try {
      let p = f.paths; let id = crypto.randomUUID();
      if (kind === 'schema') f.db.exec('ALTER TABLE memories ADD COLUMN unexpected TEXT');
      if (kind === 'corrupt') {
        const file = path.join(f.sb.root, 'primary', 'corrupt.db'); fs.writeFileSync(file, 'PRIVATE corrupt canary', { mode: 0o600 }); p = { ...p, primary: file };
      }
      if (kind === 'symlink') {
        const file = path.join(f.sb.root, 'primary', 'alias.db'); fs.symlinkSync(p.primary, file); p = { ...p, primary: file };
      }
      if (kind === 'collision') fs.writeFileSync(path.join(p.backups, id + '.db'), 'PRIVATE preserved backup', { mode: 0o600 });
      if (kind === 'mode') fs.chmodSync(p.backups, 0o755);
      await assert.rejects(cutoverMemory({ ...options(p), id: () => id }), (e: unknown) => {
        assert.ok(e instanceof CutoverError); assert.doesNotMatch(e.message, /PRIVATE|corrupt\.db|alias\.db/); return true;
      });
      if (kind === 'collision') assert.equal(fs.readFileSync(path.join(p.backups, id + '.db'), 'utf8'), 'PRIVATE preserved backup');
      assert.equal(f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='bosun_source_floor'").get(), undefined);
    } finally { f.close(); }
  }
});

test('cutover recovery holds inode/epoch swaps, backup tampering and unknown floor/gate definitions', async () => {
  for (const kind of ['view', 'source', 'backup', 'gate', 'floor', 'trigger', 'restore']) {
    const f = fixture();
    try {
      const result = await cutoverMemory(options(f.paths));
      const file = path.join(f.paths.backups, result.attemptId + '.db');
      if (kind === 'view') { const bytes = fs.readFileSync(f.paths.view); fs.renameSync(f.paths.view, f.paths.view + '.old'); fs.writeFileSync(f.paths.view, bytes, { mode: 0o600 }); }
      if (kind === 'source') {
        const other = path.join(f.sb.root, 'primary', 'replacement.db'); const db = openSchemaOneMemory(other); db.close();
        const original = f.paths.primary; f.paths.primary = other; assert.notEqual(original, f.paths.primary);
      }
      if (kind === 'backup') fs.appendFileSync(file, 'PRIVATE tamper canary');
      if (kind === 'gate') { const view = new SqliteDatabase(f.paths.view); try { view.exec("UPDATE bosun_cutover_gate SET source_id='malformed-canary'"); } finally { view.close(); } }
      if (kind === 'floor') f.db.exec("UPDATE bosun_source_floor SET source_id='malformed-canary'");
      if (kind === 'trigger') f.db.exec('DROP TRIGGER bosun_floor_memories_update');
      if (kind === 'restore') {
        for (const table of ['memories', 'memory_events', 'docs']) for (const op of ['insert', 'update', 'delete']) f.db.exec(`DROP TRIGGER bosun_floor_${table}_${op}`);
        f.db.exec('DROP TABLE bosun_source_floor');
      }
      const before = fs.readdirSync(f.paths.backups);
      await assert.rejects(cutoverMemory(options(f.paths)), CutoverError);
      assert.throws(() => new CutoverWriter(f.paths), CutoverError);
      assert.deepEqual(fs.readdirSync(f.paths.backups), before, 'unknown identity never becomes a new attempt');
    } finally { f.close(); }
  }
});

test('cutover validates initial dependencies before reserving artifacts; the first committed gate is recoverable', async () => {
  for (const kind of ['clock', 'id', 'duplicate', 'checkpoint']) {
    const f = fixture();
    try {
      const o = options(f.paths);
      if (kind === 'clock') o.now = () => { throw Error('PRIVATE clock canary'); };
      if (kind === 'id') o.id = () => 'PRIVATE malformed id';
      if (kind === 'duplicate') { const id = crypto.randomUUID(); o.id = () => id; }
      await assert.rejects(cutoverMemory(kind === 'checkpoint' ? { ...o, checkpoint: 'PRIVATE invalid callback' as any } : o), (e: unknown) => {
        assert.ok(e instanceof CutoverError); assert.equal(e.reason, 'input'); assert.doesNotMatch(e.message, /PRIVATE/); return true;
      });
      assert.equal(fs.existsSync(f.paths.view), false); assert.deepEqual(fs.readdirSync(f.paths.backups), []);
      const result = await cutoverMemory(options(f.paths)); assert.equal(result.state, 'HOLD');
    } finally { f.close(); }
  }
});

test('cutover refuses successful receipts when final post-commit checkpoint changes source/view/artifact/epoch', async () => {
  for (const kind of ['source', 'view', 'backup', 'gate']) {
    const f = fixture();
    try {
      await assert.rejects(cutoverMemory({ ...options(f.paths), checkpoint(phase) {
        if (phase !== 'commit') return;
        const file = path.join(f.paths.backups, fs.readdirSync(f.paths.backups)[0]);
        if (kind === 'source' || kind === 'view') {
          const changed = kind === 'source' ? f.paths.primary : f.paths.view;
          const bytes = kind === 'source' ? fs.readFileSync(file) : fs.readFileSync(changed);
          fs.renameSync(changed, changed + '.retired'); fs.writeFileSync(changed, bytes, { mode: 0o600 });
        }
        if (kind === 'backup') fs.appendFileSync(file, 'PRIVATE checkpoint tamper');
        if (kind === 'gate') { const db = new SqliteDatabase(f.paths.view); try { db.exec('DELETE FROM bosun_cutover_gate'); } finally { db.close(); } }
      } }), CutoverError);
      assert.equal(fs.readdirSync(f.paths.backups).length, 1);
    } finally { f.close(); }
  }
});

test('cutover cleanup failures remain finite, release native admission and reconcile the committed attempt', async () => {
  const f = fixture(); const close = SqliteDatabase.prototype.close;
  let injected = false; let failNext = false;
  try {
    SqliteDatabase.prototype.close = function () {
      if (failNext) { failNext = false; injected = true; throw Error('PRIVATE cleanup canary'); }
      return close.call(this);
    };
    await assert.rejects(cutoverMemory({ ...options(f.paths), checkpoint(phase) { if (phase === 'commit') failNext = true; } }), (e: unknown) => {
      assert.ok(e instanceof CutoverError); assert.equal(e.reason, 'storage'); assert.doesNotMatch(e.message, /PRIVATE/); return true;
    });
    assert.equal(injected, true);
    f.db.exec('BEGIN IMMEDIATE'); f.db.exec('ROLLBACK');
    const files = fs.readdirSync(f.paths.backups); const result = await cutoverMemory(options(f.paths));
    assert.deepEqual(files, [result.attemptId + '.db']);
  } finally { SqliteDatabase.prototype.close = close; f.close(); }
});

test('registered writer rollback failure poisons and closes the connection rather than leaving admission alive', async () => {
  const f = fixture(); const exec = SqliteDatabase.prototype.exec; let writer: CutoverWriter | undefined; let failRollback = false;
  try {
    await cutoverMemory(options(f.paths)); writer = new CutoverWriter(f.paths);
    SqliteDatabase.prototype.exec = function (sql) {
      if (sql === 'ROLLBACK' && failRollback) { failRollback = false; throw Error('PRIVATE rollback canary'); }
      return exec.call(this, sql);
    };
    assert.throws(() => writer!.transaction((db) => {
      db.exec("UPDATE memories SET private=1 WHERE id='m_public'"); failRollback = true; throw Error('PRIVATE write error');
    }), CutoverError);
    assert.equal(failRollback, false); assert.throws(() => writer!.transaction(() => {}), CutoverError);
    assert.equal(f.db.prepare("SELECT private FROM memories WHERE id='m_public'").get()!.private, 0);
    f.db.exec('BEGIN IMMEDIATE'); f.db.exec('ROLLBACK');
  } finally { SqliteDatabase.prototype.exec = exec; writer?.close(); f.close(); }
});

test('registered writer invalidation respects a lease on the same rollback gate inode and never precedes primary admission', async () => {
  const f = fixture(); let writer: CutoverWriter | undefined; let other: CutoverWriter | undefined; let lease: SqliteDatabase | undefined;
  try {
    await cutoverMemory(options(f.paths)); writer = new CutoverWriter(f.paths); other = new CutoverWriter(f.paths);
    lease = new SqliteDatabase(f.paths.view, { readOnly: true }); lease.exec('BEGIN'); lease.prepare('SELECT * FROM bosun_cutover_gate').get();
    const gateBefore = fs.readFileSync(f.paths.view);
    assert.throws(() => writer!.transaction((db) => db.exec("UPDATE memories SET private=1 WHERE id='m_public'")), CutoverError);
    assert.equal(f.db.prepare("SELECT private FROM memories WHERE id='m_public'").get()!.private, 0);
    assert.deepEqual(fs.readFileSync(f.paths.view), gateBefore);
    lease.exec('ROLLBACK'); lease.close(); lease = undefined;
    writer.transaction((db) => {
      assert.throws(() => other!.transaction((otherDb) => otherDb.exec("UPDATE memories SET private=1 WHERE id='m_public'")), (e: unknown) => {
        assert.ok(e instanceof CutoverError); assert.equal(e.reason, 'busy'); return true;
      });
      db.exec("UPDATE memories SET private=1 WHERE id='m_public'");
    });
    assert.equal(f.db.prepare('SELECT generation FROM bosun_source_floor').get()!.generation, 1);
    assert.equal(f.db.prepare("SELECT private FROM memories WHERE id='m_public'").get()!.private, 1);
    assert.equal(f.db.prepare('PRAGMA journal_mode').get()!.journal_mode, 'wal');
  } finally { lease?.close(); writer?.close(); other?.close(); f.close(); }
});

test('registered writer refuses a coordinated same-inode source/view epoch change after registration', async () => {
  const f = fixture(); let writer: CutoverWriter | undefined;
  try {
    await cutoverMemory(options(f.paths)); writer = new CutoverWriter(f.paths);
    const epoch = crypto.randomUUID();
    f.db.prepare('UPDATE bosun_source_floor SET source_id=?').run(epoch);
    const view = new SqliteDatabase(f.paths.view);
    try { view.prepare('UPDATE bosun_cutover_gate SET source_id=?').run(epoch); } finally { view.close(); }
    assert.throws(() => writer!.transaction((db) => db.exec("UPDATE memories SET private=1 WHERE id='m_public'")), (e: unknown) => {
      assert.ok(e instanceof CutoverError); assert.equal(e.reason, 'identity'); return true;
    });
    assert.equal(f.db.prepare("SELECT private FROM memories WHERE id='m_public'").get()!.private, 0);
  } finally { writer?.close(); f.close(); }
});
