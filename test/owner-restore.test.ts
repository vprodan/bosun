import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { sandbox, fresh, bosun, REPO } from './helpers.ts';
import { P, load } from '../lib/config.ts';
import { openDb, writerPaths, contentHash, openLocalSqlite, planLocalMemoryRestore, applyLocalMemoryRestore } from '../lib/memory/sqlite.ts';
import { planOwnerCutover, applyOwnerCutover, planOwnerRestore, applyOwnerRestore, OwnerCutoverError } from '../src/adapters/memory/sqlite-owner.ts';
import { restoreMemory, publishMemoryView, CutoverWriter, CutoverError, RESTORE_PENDING_SUFFIX, RESTORE_RECEIPT_SUFFIX, type RestorePhase } from '../src/adapters/memory/sqlite-cutover.ts';
import { SqlitePublicReadOnly } from '../src/adapters/memory/sqlite-public-readonly.ts';

const options = (paths: ReturnType<typeof writerPaths>) => ({ paths, now: Date.now, id: crypto.randomUUID });
const rows = (db: DatabaseSync, table: string) => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all();
const snapshot = (db: DatabaseSync) => Object.fromEntries(['memories', 'memory_events', 'docs', 'schema_migrations'].map((t) => [t, rows(db, t)]));
const decode = (value: string) => JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const ctx = { projectId: null, linked: [], sessionId: null, source: 'cli' as const };
async function fixture(publication = true) {
  const sb = sandbox(); fresh(sb); const cfg = load(); fs.chmodSync(P.BOSUN, 0o700);
  const paths = writerPaths(P.DB, cfg); fs.mkdirSync(path.dirname(paths.view), { mode: 0o700 }); fs.mkdirSync(paths.backups, { mode: 0o700 });
  const db = openDb(paths.primary);
  db.prepare(`INSERT INTO memories(seq,id,category,title,body,tags,private,source,source_ref,hash,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(13, 'm_public', 'personal', 'Zebra public', 'Zebra preserved body', '[]', 0, 'owner', null,
      contentHash('Zebra public', 'Zebra preserved body'), 1, 1);
  db.prepare(`INSERT INTO memories(seq,id,category,project_id,title,body,tags,private,source,source_ref,hash,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(29, 'm_private', 'project', 'p_private', 'PRIVATE title', 'PRIVATE body', '["private-tag"]', 1,
      'PRIVATE source', 'PRIVATE ref', 'PRIVATE hash', 2, 2);
  db.prepare('INSERT INTO memory_events(id,memory_id,op,at,source,hash_after) VALUES(?,?,?,?,?,?)').run(19, 'm_private', 'add', 1, 'PRIVATE audit', 'PRIVATE audit hash');
  db.prepare('INSERT INTO docs(seq,path,project_id,mtime,title,body) VALUES(?,?,?,?,?,?)').run(17, 'doc.md', 'p_a', 1, 'Doc title', 'Doc preserved body');
  const original = snapshot(db); const p = planOwnerCutover(options(paths)); assert.equal(p.state, 'PLANNED');
  const initial = await applyOwnerCutover({ ...options(paths), operation: 'apply', plan: p.plan!, clientsStopped: true });
  if (publication) await publishMemoryView(options(paths));
  return { sb, cfg, paths, db, original, initial, close() { if (db.isOpen) db.close(); sb.cleanup(); } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function plan(f: Fixture, newSourceId?: string, retainUnreferenced = false) {
  const value = planOwnerRestore({ ...options(f.paths), sourceId: f.initial.sourceId, newSourceId, retainUnreferenced });
  assert.equal(value.state, 'PLANNED', JSON.stringify(value)); assert.ok(value.plan); return value;
}
const apply = (f: Fixture, p = plan(f)) => applyOwnerRestore({ paths: f.paths, plan: p.plan!, operation: 'restore',
  sourceId: f.initial.sourceId, newSourceId: p.newSourceId!, clientsStopped: true, now: Date.now });
function tree(file: string): unknown {
  const s = fs.lstatSync(file, { bigint: true });
  const meta = { dev: String(s.dev), ino: String(s.ino), mode: String(s.mode), size: String(s.size), mtime: String(s.mtimeNs), ctime: String(s.ctimeNs) };
  if (s.isSymbolicLink()) return { ...meta, link: fs.readlinkSync(file) };
  return s.isDirectory() ? { ...meta, entries: Object.fromEntries(fs.readdirSync(file).sort().map((n) => [n, tree(path.join(file, n))])) }
    : { ...meta, bytes: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
}
function change(f: Fixture) {
  const writer = new CutoverWriter(f.paths);
  writer.transaction((db) => {
    db.prepare("UPDATE memories SET body=?,hash=?,private=1 WHERE id='m_public'").run('Changed PRIVATE current', contentHash('Zebra public', 'Changed PRIVATE current'));
    db.prepare("INSERT INTO memory_events(id,memory_id,op,at,source,hash_after) VALUES(?,?,?,?,?,?)").run(42, 'm_public', 'update', 2, 'PRIVATE current audit', 'PRIVATE current hash');
    db.prepare("UPDATE docs SET body='Changed current doc' WHERE seq=17").run();
  }); writer.close();
}
function floor(f: Fixture) { return f.db.prepare('SELECT * FROM bosun_source_floor').get()!; }

test('restore plan saves independent new epoch before effects and real CLI opens only leased rollback view', async () => {
  const f = await fixture(); const exec = DatabaseSync.prototype.exec;
  try {
    change(f); const before = tree(P.BOSUN); const native: string[] = [];
    DatabaseSync.prototype.exec = function (sql) {
      native.push(String(this.prepare('PRAGMA database_list').get()!.file)); return exec.call(this, sql);
    };
    const p = plan(f); assert.equal(p.operation, 'restore'); assert.equal(p.schema, 'unverified'); assert.equal(p.floor, 'unverified');
    assert.notEqual(p.newSourceId, f.initial.sourceId); assert.equal(decode(p.plan!).newSourceId, p.newSourceId);
    assert.ok(native.length); assert.deepEqual([...new Set(native)], [f.paths.view]);
    DatabaseSync.prototype.exec = exec;
    const cli = await bosun(['memory', 'cutover', 'restore-plan', '--source-id', f.initial.sourceId, '--json'], { env: f.sb.env() });
    assert.equal(cli.code, 0, cli.err); assert.ok(JSON.parse(cli.out).newSourceId); assert.deepEqual(tree(P.BOSUN), before);
    assert.doesNotMatch(JSON.stringify(p) + cli.out + cli.err, /PRIVATE|backup_hash|\.db|source_ref|Changed/); assert.deepEqual(f.sb.calls(), []);
  } finally { DatabaseSync.prototype.exec = exec; f.close(); }
});

test('actual bounded format1/2 restore preserves full logical snapshot and old bytes, saves current backup and fences old authorities', async () => {
  for (const publication of [false, true]) {
    const f = await fixture(publication);
    try {
      const oldFile = path.join(f.paths.backups, f.initial.attemptId + '.db'); const oldBytes = fs.readFileSync(oldFile);
      const sourceInode = fs.statSync(f.paths.primary).ino; const viewInode = fs.statSync(f.paths.view).ino;
      const cached = new CutoverWriter(f.paths); change(f); const current = snapshot(f.db); const p = plan(f);
      let result;
      if (publication) {
        const cli = await bosun(['memory', 'cutover', 'restore', '--plan', p.plan!, '--source-id', f.initial.sourceId,
          '--new-source-id', p.newSourceId!, '--clients-stopped', '--json'], { env: f.sb.env() });
        assert.equal(cli.code, 0, cli.err); result = JSON.parse(cli.out); assert.doesNotMatch(cli.out + cli.err, /PRIVATE|backup_hash|\.db|Changed/);
      } else result = await apply(f, p);
      assert.equal(result.state, 'HOLD'); assert.equal(result.outcome, 'committed'); assert.equal(result.sourceId, p.newSourceId);
      assert.equal(result.generation, 0); assert.equal(result.previousSourceId, f.initial.sourceId); assert.equal(result.clientsStopped, 'attested');
      assert.deepEqual(snapshot(f.db), f.original); assert.deepEqual(fs.readFileSync(oldFile), oldBytes);
      assert.equal(fs.statSync(f.paths.primary).ino, sourceInode); assert.equal(fs.statSync(f.paths.view).ino, viewInode);
      const currentBackup = new DatabaseSync(path.join(f.paths.backups, result.attemptId + '.db'), { readOnly: true });
      try { assert.deepEqual(snapshot(currentBackup), current); assert.equal(currentBackup.prepare('SELECT source_id FROM bosun_source_floor').get()!.source_id, f.initial.sourceId); }
      finally { currentBackup.close(); }
      assert.equal(fs.existsSync(f.paths.view + RESTORE_PENDING_SUFFIX), false); assert.equal(fs.existsSync(f.paths.view + RESTORE_RECEIPT_SUFFIX), true);
      assert.throws(() => cached.transaction((db) => db.prepare("UPDATE docs SET body='stale'").run()), CutoverError);
      assert.throws(() => cached.read((db) => db.prepare('SELECT id FROM memories').all()), CutoverError); cached.close();
      assert.throws(() => new SqlitePublicReadOnly({ ...f.paths, sourceId: f.initial.sourceId }, Date.now));
      assert.throws(() => new SqlitePublicReadOnly({ ...f.paths, sourceId: p.newSourceId! }, Date.now));
      const reopened = new CutoverWriter(f.paths);
      try { assert.equal(reopened.read((db) => db.prepare("SELECT count(*) AS n FROM memories_fts WHERE memories_fts MATCH 'preserved'").get()!.n), 1);
        assert.equal(reopened.read((db) => db.prepare("SELECT count(*) AS n FROM docs_fts WHERE docs_fts MATCH 'preserved'").get()!.n), 1); }
      finally { reopened.close(); }
      await publishMemoryView(options(f.paths));
      assert.throws(() => new SqlitePublicReadOnly({ ...f.paths, sourceId: f.initial.sourceId }, Date.now));
      const reader = new SqlitePublicReadOnly({ ...f.paths, sourceId: p.newSourceId! }, Date.now);
      try { assert.equal((await reader.get('m_public', ctx)).body, 'Zebra preserved body'); await assert.rejects(reader.get('m_private', ctx)); }
      finally { reader.close(); }
      assert.equal(f.cfg.MEMORY_SOURCE_ID, ''); assert.doesNotMatch(fs.readFileSync(P.CFG, 'utf8'), new RegExp(p.newSourceId!));
      assert.deepEqual(f.sb.calls(), []);
    } finally { f.close(); }
  }
});

test('retained native delivery lease blocks restore HOLD before primary data DML; pending blocks every cached/new authority', async () => {
  const f = await fixture();
  try {
    const p = plan(f); const planned = decode(p.plan!); const cached = new CutoverWriter(f.paths);
    const reader = new SqlitePublicReadOnly({ ...f.paths, sourceId: f.initial.sourceId }, Date.now); const before = snapshot(f.db); let held = false;
    await assert.rejects(restoreMemory({ paths: f.paths, sourceId: f.initial.sourceId, newSourceId: p.newSourceId!, attemptId: planned.attemptId,
      operation: 'restore', now: Date.now, validate() {}, checkpoint(at) { if (at === 'hold') held = true; } }), (e) => e instanceof CutoverError && e.reason === 'receipt_unknown');
    assert.equal(held, false); assert.deepEqual(snapshot(f.db), before); assert.equal(floor(f).source_id, f.initial.sourceId);
    assert.throws(() => reader.validate()); reader.close();
    assert.throws(() => cached.transaction((db) => db.prepare("UPDATE docs SET body='stale'").run())); assert.throws(() => cached.read(() => undefined)); cached.close();
    assert.throws(() => new CutoverWriter(f.paths)); assert.throws(() => openLocalSqlite(f.paths.primary, f.cfg));
    await assert.rejects(publishMemoryView(options(f.paths)));
    const ordinary = planOwnerCutover(options(f.paths)); assert.equal(ordinary.state, 'BLOCKED');
    const reconciliation = plan(f, p.newSourceId!);
    const result = await applyOwnerRestore({ paths: f.paths, plan: reconciliation.plan!, operation: 'restore-reconcile', sourceId: f.initial.sourceId,
      newSourceId: p.newSourceId!, clientsStopped: true, now: Date.now });
    assert.equal(result.outcome, 'rolled_back'); assert.deepEqual(snapshot(f.db), before); assert.equal(result.generation, 0);
    await publishMemoryView(options(f.paths)); assert.throws(() => new SqlitePublicReadOnly({ ...f.paths, sourceId: f.initial.sourceId }, Date.now));
  } finally { f.close(); }
});

test('readers observe only pending filename and never open retained owner JSON or backup bytes', async () => {
  const f = await fixture(); const read = fs.readFileSync; const open = fs.openSync;
  try {
    const p = plan(f); await apply(f, p); await publishMemoryView(options(f.paths));
    fs.readFileSync = ((file: fs.PathOrFileDescriptor, ...rest: any[]) => {
      if (String(file).includes('.restore') || String(file).includes(f.paths.backups)) throw Error('PRIVATE forbidden owner bytes');
      return (read as any)(file, ...rest);
    }) as typeof fs.readFileSync;
    fs.openSync = ((file, flags, mode) => {
      if (String(file).includes('.restore') || String(file).includes(f.paths.backups)) throw Error('PRIVATE forbidden owner metadata');
      return open(file, flags, mode);
    }) as typeof fs.openSync;
    const reader = new SqlitePublicReadOnly({ ...f.paths, sourceId: p.newSourceId! }, Date.now);
    try { assert.equal((await reader.get('m_public', ctx)).id, 'm_public'); } finally { reader.close(); }
    fs.symlinkSync(path.join(f.sb.root, 'absent'), f.paths.view + RESTORE_PENDING_SUFFIX);
    assert.throws(() => new SqlitePublicReadOnly({ ...f.paths, sourceId: p.newSourceId! }, Date.now));
  } finally { fs.readFileSync = read; fs.openSync = open; f.close(); }
});

function nativeOptions(f: Fixture, p = plan(f)) {
  return { paths: f.paths, sourceId: f.initial.sourceId, newSourceId: p.newSourceId!, attemptId: decode(p.plan!).attemptId,
    operation: 'restore' as const, now: Date.now, validate() {} };
}
async function killedRestore(f: Fixture, p: ReturnType<typeof plan>, phase: RestorePhase): Promise<void> {
  const code = [
    'import ' + JSON.stringify(pathToFileURL(path.join(REPO, 'test/bootstrap.ts')).href) + ';',
    'import {restoreMemory} from ' + JSON.stringify(pathToFileURL(path.join(REPO, 'src/adapters/memory/sqlite-cutover.ts')).href) + ';',
    'const settings=JSON.parse(process.argv[1]); const timer=setInterval(()=>{},1000);',
    'await restoreMemory({...settings,now:Date.now,validate(){},async checkpoint(at){if(at===process.argv[2]){process.stdout.write("RESTORE_KILL_MARKER\\n");await new Promise(()=>{});}}});clearInterval(timer);',
  ].join('\n');
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, JSON.stringify(nativeOptions(f, p)), phase],
    { cwd: f.sb.root, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise<void>((resolve, reject) => {
    let marked = false; let out = ''; let err = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), 8000);
    child.stdout.on('data', (chunk) => { out += chunk; if (!marked && out.includes('RESTORE_KILL_MARKER')) { marked = true; child.kill('SIGKILL'); } });
    child.stderr.on('data', (chunk) => { err = (err + chunk).slice(-1500); });
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code, signal) => { clearTimeout(timeout); if (marked && signal === 'SIGKILL') resolve(); else reject(Error('missed synthetic restore checkpoint: ' + code + '/' + signal + ' ' + err)); });
  });
}
const reconcile = (f: Fixture, p: ReturnType<typeof plan>) => applyOwnerRestore({ paths: f.paths, plan: p.plan!, operation: 'restore-reconcile',
  sourceId: f.initial.sourceId, newSourceId: p.newSourceId!, clientsStopped: true, now: Date.now });

test('seven native kill boundaries reconcile authoritative rollback or commit without replay, generation reset or old binding revival', async () => {
  for (const phase of ['intent', 'hold', 'backup', 'rows', 'source-commit', 'view-commit', 'receipt'] as const) {
    const f = await fixture();
    try {
      change(f); const current = snapshot(f.db); const oldGeneration = floor(f).generation;
      const oldBackup = path.join(f.paths.backups, f.initial.attemptId + '.db'); const oldBytes = fs.readFileSync(oldBackup);
      const p = plan(f); await killedRestore(f, p, phase);
      const committed = ['source-commit', 'view-commit', 'receipt'].includes(phase);
      const expected = committed ? f.original : current;
      assert.deepEqual(snapshot(f.db), expected);
      assert.equal(floor(f).source_id, committed ? p.newSourceId : f.initial.sourceId);
      if (phase !== 'receipt') assert.throws(() => openLocalSqlite(f.paths.primary, f.cfg));
      const rp = plan(f, p.newSourceId!); const receipt = await reconcile(f, rp);
      assert.equal(receipt.outcome, committed ? 'committed' : 'rolled_back');
      assert.equal(receipt.generation, committed ? 0 : oldGeneration);
      assert.equal(receipt.sourceId, p.newSourceId); assert.deepEqual(snapshot(f.db), expected);
      assert.deepEqual(fs.readFileSync(oldBackup), oldBytes); assert.equal(fs.readdirSync(f.paths.backups).length, 2);
      assert.equal(fs.existsSync(f.paths.view + RESTORE_PENDING_SUFFIX), false);
      const again = await reconcile(f, plan(f, p.newSourceId!));
      assert.equal(again.outcome, receipt.outcome); assert.equal(again.generation, receipt.generation); assert.deepEqual(snapshot(f.db), expected);
      const live = new CutoverWriter(f.paths); try { live.transaction((db) => db.prepare('UPDATE docs SET mtime=mtime+1 WHERE seq=17').run()); } finally { live.close(); }
      const afterWrite = snapshot(f.db); const advanced = floor(f).generation;
      const later = await reconcile(f, plan(f, p.newSourceId!)); assert.equal(later.generation, advanced); assert.deepEqual(snapshot(f.db), afterWrite);
      await publishMemoryView(options(f.paths));
      assert.throws(() => new SqlitePublicReadOnly({ ...f.paths, sourceId: f.initial.sourceId }, Date.now));
      const reader = new SqlitePublicReadOnly({ ...f.paths, sourceId: p.newSourceId! }, Date.now);
      try { if (committed) assert.equal((await reader.get('m_public', ctx)).body, 'Zebra preserved body'); else await assert.rejects(reader.get('m_public', ctx)); }
      finally { reader.close(); }
      assert.doesNotMatch(JSON.stringify(receipt), /PRIVATE|backup_hash|\.db/);
    } finally { f.close(); }
  }
});

test('fallible checkpoints recheck actual source/view inodes before any commit through replaced native handles', async () => {
  for (const target of ['primary', 'view'] as const) for (const phase of ['intent', 'hold', 'backup', 'rows'] as const) {
    const f = await fixture();
    try {
      change(f); const before = snapshot(f.db); const sourceId = floor(f).source_id; const generation = floor(f).generation;
      const p = plan(f); let replaced = false;
      await assert.rejects(restoreMemory({ ...nativeOptions(f, p), checkpoint(at) {
        if (at !== phase) return;
        const file = f.paths[target]; const retained = path.join(f.sb.root, 'retained-' + target + '.db');
        fs.renameSync(file, retained); fs.writeFileSync(file, fs.readFileSync(retained), { mode: 0o600 }); replaced = true;
      } }), (e) => e instanceof CutoverError && e.reason === 'receipt_unknown');
      assert.equal(replaced, true); assert.deepEqual(snapshot(f.db), before);
      assert.equal(floor(f).source_id, sourceId); assert.equal(floor(f).generation, generation);
    } finally { f.close(); }
  }
});

test('owner capsule reads stay bounded and reject growth between metadata validation and descriptor use', async () => {
  for (const growing of [false, true]) {
    const f = await fixture(); const open = fs.openSync; const read = fs.readFileSync; const readSync = fs.readSync; const close = fs.closeSync;
    try {
      const p = plan(f); await assert.rejects(restoreMemory({ ...nativeOptions(f, p), checkpoint(at) { if (at === 'intent') throw Error('PRIVATE synthetic interruption'); } }));
      const pending = f.paths.view + RESTORE_PENDING_SUFFIX; const tracked = new Set<number>(); let bufferedReads = 0; let grown = false;
      fs.openSync = ((file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
        const fd = open(file, flags, mode);
        if (file === pending) { tracked.add(fd); if (growing && !grown) { fs.appendFileSync(pending, 'x'.repeat(32768)); grown = true; } }
        return fd;
      }) as typeof fs.openSync;
      fs.readFileSync = ((file: fs.PathOrFileDescriptor, ...rest: any[]) => {
        assert.ok(typeof file !== 'number' || !tracked.has(file), 'capsule never uses unbounded descriptor readFileSync');
        return (read as any)(file, ...rest);
      }) as typeof fs.readFileSync;
      fs.readSync = ((fd: number, buffer: NodeJS.ArrayBufferView, ...rest: any[]) => {
        if (tracked.has(fd)) { assert.ok(buffer.byteLength <= 16384); bufferedReads++; }
        return (readSync as any)(fd, buffer, ...rest);
      }) as typeof fs.readSync;
      fs.closeSync = (fd) => { tracked.delete(fd); close(fd); };
      const value = planOwnerRestore({ ...options(f.paths), sourceId: f.initial.sourceId, newSourceId: p.newSourceId! });
      if (growing) { assert.equal(grown, true); assert.equal(value.state, 'BLOCKED'); assert.equal(bufferedReads, 0); }
      else { assert.equal(value.state, 'PLANNED'); assert.ok(bufferedReads > 0); await reconcile(f, value); }
      assert.equal(floor(f).source_id, growing ? f.initial.sourceId : p.newSourceId);
    } finally { fs.openSync = open; fs.readFileSync = read; fs.readSync = readSync; fs.closeSync = close; f.close(); }
  }
});

test('post-rename directory fsync failure reports uncertainty while committed new epoch stays HOLD and reconciles without replay', async () => {
  const f = await fixture(); const rename = fs.renameSync; const sync = fs.fsyncSync; let renamed = false;
  try {
    change(f); const p = plan(f);
    fs.renameSync = (from, to) => { rename(from, to); if (from === f.paths.view + RESTORE_PENDING_SUFFIX) renamed = true; };
    fs.fsyncSync = (fd) => { if (renamed && fs.fstatSync(fd).isDirectory()) throw Error('PRIVATE directory fsync failure'); sync(fd); };
    await assert.rejects(apply(f, p), (e) => e instanceof CutoverError && e.reason === 'receipt_unknown' && !/PRIVATE/.test(e.message));
    fs.renameSync = rename; fs.fsyncSync = sync;
    assert.equal(renamed, true); assert.equal(fs.existsSync(f.paths.view + RESTORE_PENDING_SUFFIX), false);
    assert.equal(fs.existsSync(f.paths.view + RESTORE_RECEIPT_SUFFIX), true); assert.deepEqual(snapshot(f.db), f.original);
    assert.equal(floor(f).source_id, p.newSourceId); assert.equal(floor(f).generation, 0);
    assert.throws(() => new SqlitePublicReadOnly({ ...f.paths, sourceId: p.newSourceId! }, Date.now));
    const recovered = await reconcile(f, plan(f, p.newSourceId!)); assert.equal(recovered.outcome, 'committed'); assert.equal(recovered.generation, 0);
    assert.deepEqual(snapshot(f.db), f.original);
  } finally { fs.renameSync = rename; fs.fsyncSync = sync; f.close(); }
});

test('strict restore CLI and independently bound tokens refuse missing attestation, extra inputs and wrong epochs without effects', async () => {
  const f = await fixture();
  try {
    const p = plan(f); const before = tree(P.BOSUN);
    for (const args of [ ['restore-plan'], ['restore-plan', '--source-id', f.initial.sourceId, '--new-source-id', p.newSourceId!],
      ['restore-plan', '--source-id', f.initial.sourceId, '--json', '--json'], ['restore-reconcile-plan', '--source-id', f.initial.sourceId],
      ['restore', '--plan', p.plan!, '--source-id', f.initial.sourceId, '--new-source-id', p.newSourceId!],
      ['restore', '--plan', p.plan!, '--source-id', f.initial.sourceId, '--new-source-id', p.newSourceId!, '--clients-stopped', 'PRIVATE extra'] ]) {
      const result = await bosun(['memory', 'cutover', ...args], { env: f.sb.env() }); assert.equal(result.code, 2); assert.doesNotMatch(result.out + result.err, /PRIVATE/); assert.deepEqual(tree(P.BOSUN), before);
    }
    const wrong = crypto.randomUUID(); assert.equal(planOwnerRestore({ ...options(f.paths), sourceId: wrong }).state, 'BLOCKED');
    for (const change of [{ sourceId: wrong }, { newSourceId: wrong }, { clientsStopped: false }, { plan: encode({ ...decode(p.plan!), extra: 'PRIVATE token' }) }]) {
      await assert.rejects(applyOwnerRestore({ paths: f.paths, plan: p.plan!, operation: 'restore', sourceId: f.initial.sourceId,
        newSourceId: p.newSourceId!, clientsStopped: true, now: Date.now, ...change }), (e) => e instanceof OwnerCutoverError && !/PRIVATE/.test(e.message));
      assert.deepEqual(tree(P.BOSUN), before);
    }
    const remote = await bosun(['memory', 'cutover', 'restore-plan', '--source-id', f.initial.sourceId, '--json'], { env: f.sb.env({ MEMORY_URL: 'http://127.0.0.1:1' }) });
    assert.equal(remote.code, 1); assert.deepEqual(tree(P.BOSUN), before);
  } finally { f.close(); }
});

test('completed receipts survive explicit format upgrade and repeated restores replace only verified metadata while preserving every backup', async () => {
  for (const publication of [false, true]) {
    const f = await fixture(publication);
    try {
      change(f); const changed = snapshot(f.db); const initialBytes = fs.readFileSync(path.join(f.paths.backups, f.initial.attemptId + '.db'));
      const firstPlan = plan(f); const first = await apply(f, firstPlan); await publishMemoryView(options(f.paths));
      const firstReconciliation = await reconcile(f, plan(f, firstPlan.newSourceId!));
      assert.equal(firstReconciliation.outcome, 'committed'); assert.equal(firstReconciliation.generation, 0);
      const priorReceipt = fs.statSync(f.paths.view + RESTORE_RECEIPT_SUFFIX).ino;
      const secondPlan = planOwnerRestore({ ...options(f.paths), sourceId: first.sourceId }); assert.equal(secondPlan.state, 'PLANNED', JSON.stringify(secondPlan));
      const second = await applyOwnerRestore({ paths: f.paths, plan: secondPlan.plan!, operation: 'restore', sourceId: first.sourceId,
        newSourceId: secondPlan.newSourceId!, clientsStopped: true, now: Date.now });
      assert.equal(second.outcome, 'committed'); assert.equal(second.generation, 0); assert.notEqual(second.sourceId, first.sourceId);
      assert.deepEqual(snapshot(f.db), changed); assert.equal(fs.readdirSync(f.paths.backups).length, 3);
      assert.deepEqual(fs.readFileSync(path.join(f.paths.backups, f.initial.attemptId + '.db')), initialBytes);
      assert.notEqual(fs.statSync(f.paths.view + RESTORE_RECEIPT_SUFFIX).ino, priorReceipt);
      const undoBackup = new DatabaseSync(path.join(f.paths.backups, second.attemptId + '.db'), { readOnly: true });
      try { assert.deepEqual(snapshot(undoBackup), f.original); } finally { undoBackup.close(); }
      await publishMemoryView(options(f.paths));
      for (const sourceId of [f.initial.sourceId, first.sourceId]) assert.throws(() => new SqlitePublicReadOnly({ ...f.paths, sourceId }, Date.now));
      const current = new SqlitePublicReadOnly({ ...f.paths, sourceId: second.sourceId }, Date.now);
      try { await assert.rejects(current.get('m_public', ctx)); } finally { current.close(); }
    } finally { f.close(); }
  }
});

test('pending capsule, reference and schema tampering stays held without repairing or committing unrelated owner data', async () => {
  for (const effect of ['json', 'extra', 'mode', 'hardlink', 'dangling', 'selected-bytes', 'view-schema', 'journal', 'special-primary']) {
    const f = await fixture();
    try {
      const p = plan(f); await assert.rejects(restoreMemory({ ...nativeOptions(f, p), checkpoint(at) { if (at === 'intent') throw Error('PRIVATE interruption'); } }));
      const pending = f.paths.view + RESTORE_PENDING_SUFFIX;
      if (effect === 'json') fs.writeFileSync(pending, 'PRIVATE malformed JSON');
      if (effect === 'extra') { const value = JSON.parse(fs.readFileSync(pending, 'utf8')); value.extra = 'PRIVATE extra'; fs.writeFileSync(pending, JSON.stringify(value)); }
      if (effect === 'mode') fs.chmodSync(pending, 0o644);
      if (effect === 'hardlink') fs.linkSync(pending, path.join(f.sb.root, 'capsule-link'));
      if (effect === 'dangling') { fs.unlinkSync(pending); fs.symlinkSync(path.join(f.sb.root, 'missing'), pending); }
      if (effect === 'selected-bytes') fs.appendFileSync(path.join(f.paths.backups, f.initial.attemptId + '.db'), 'tamper');
      if (effect === 'view-schema') { const view = new DatabaseSync(f.paths.view); try { view.exec('CREATE TABLE unexpected(id)'); } finally { view.close(); } }
      if (effect === 'journal') fs.symlinkSync(path.join(f.sb.root, 'missing-journal'), f.paths.view + '-journal');
      if (effect === 'special-primary') fs.chmodSync(f.paths.primary, 0o1600);
      const before = tree(P.BOSUN); const data = snapshot(f.db);
      const result = planOwnerRestore({ ...options(f.paths), sourceId: f.initial.sourceId, newSourceId: p.newSourceId! });
      assert.equal(result.state, 'BLOCKED', effect); assert.equal(result.plan, null); assert.doesNotMatch(JSON.stringify(result), /PRIVATE|backup_hash/);
      assert.deepEqual(tree(P.BOSUN), before); assert.deepEqual(snapshot(f.db), data);
      assert.throws(() => openLocalSqlite(f.paths.primary, f.cfg));
    } finally { f.close(); }
  }
});

test('restore admission blocks an actual registered contender and never reads unreferenced bytes acknowledged at both steps', async () => {
  const f = await fixture(); const read = fs.readFileSync; const open = fs.openSync;
  try {
    const extra = path.join(f.paths.backups, crypto.randomUUID() + '.db'); fs.writeFileSync(extra, 'PRIVATE arbitrary unreferenced bytes', { mode: 0o600 });
    const bytes = fs.readFileSync(extra); const before = snapshot(f.db);
    assert.equal(planOwnerRestore({ ...options(f.paths), sourceId: f.initial.sourceId }).state, 'BLOCKED');
    fs.readFileSync = ((file: fs.PathOrFileDescriptor, ...rest: any[]) => { assert.notEqual(file, extra); return (read as any)(file, ...rest); }) as typeof fs.readFileSync;
    fs.openSync = ((file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => { assert.notEqual(file, extra); return open(file, flags, mode); }) as typeof fs.openSync;
    const p = plan(f, undefined, true);
    await assert.rejects(apply(f, p), (e) => e instanceof OwnerCutoverError && e.blocker.reason === 'input');
    const cached = new CutoverWriter(f.paths); let checked = false;
    try {
      const result = await restoreMemory({ ...nativeOptions(f, p), validate() {
        assert.throws(() => cached.transaction((db) => db.prepare('UPDATE docs SET mtime=2').run()), (e) => e instanceof CutoverError && e.reason === 'busy'); checked = true;
      } });
      assert.equal(checked, true); assert.equal(result.outcome, 'committed'); assert.deepEqual(snapshot(f.db), before);
    } finally { cached.close(); }
    const currentSourceId = floor(f).source_id as string;
    const approved = planOwnerRestore({ ...options(f.paths), sourceId: currentSourceId, retainUnreferenced: true });
    assert.equal(approved.state, 'PLANNED');
    const acknowledged = await applyLocalMemoryRestore(f.cfg, { plan: approved.plan!, operation: 'restore', sourceId: currentSourceId,
      newSourceId: approved.newSourceId!, clientsStopped: true, retainUnreferenced: true });
    assert.equal(acknowledged.outcome, 'committed'); assert.equal(acknowledged.retainedArtifacts.unreferencedCount, 1);
    fs.readFileSync = read; fs.openSync = open; assert.deepEqual(fs.readFileSync(extra), bytes);
    const getter = Object.defineProperty({}, 'sourceId', { get() { throw Error('PRIVATE getter'); } });
    const proxy = new Proxy({}, { ownKeys() { throw Error('PRIVATE proxy'); } });
    for (const value of [getter, proxy]) {
      const blocked = planOwnerRestore(value as never); assert.equal(blocked.state, 'BLOCKED'); assert.doesNotMatch(JSON.stringify(blocked), /PRIVATE/);
      assert.throws(() => planLocalMemoryRestore(f.cfg, value as never), /invalid owner cutover request/);
      await assert.rejects(applyLocalMemoryRestore(f.cfg, value as never), /invalid owner cutover request/);
    }
  } finally { fs.readFileSync = read; fs.openSync = open; f.close(); }
});
