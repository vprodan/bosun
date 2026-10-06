import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { sandbox, fresh, bosun } from './helpers.ts';
import { P, load } from '../lib/config.ts';
import { openDb, writerPaths, contentHash, applyLocalMemoryCutover, planLocalMemoryPreparation, prepareLocalMemoryLayout } from '../lib/memory/sqlite.ts';
import { planOwnerCutover, applyOwnerCutover, planOwnerPreparation, prepareOwnerLayout, OwnerCutoverError } from '../src/adapters/memory/sqlite-owner.ts';
import { cutoverMemory, publishMemoryView, CutoverError } from '../src/adapters/memory/sqlite-cutover.ts';

function fixture(closed = false) {
  const sb = sandbox(); fresh(sb); const cfg = load(); fs.chmodSync(P.BOSUN, 0o700);
  const paths = writerPaths(P.DB, cfg);
  fs.mkdirSync(path.dirname(paths.view), { mode: 0o700 }); fs.mkdirSync(paths.backups, { mode: 0o700 });
  const db = openDb(paths.primary);
  const insert = db.prepare(`INSERT INTO memories(id,category,title,body,tags,private,source,source_ref,hash,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
  insert.run('m_public', 'personal', 'Zebra public', 'Zebra preserved body', '[]', 0, 'owner', null, contentHash('Zebra public', 'Zebra preserved body'), 1, 1);
  insert.run('m_private', 'personal', 'PRIVATE title canary', 'PRIVATE body canary', '["private-tag"]', 1, 'PRIVATE source canary', 'PRIVATE ref canary', 'PRIVATE hash canary', 2, 2);
  db.prepare('INSERT INTO memory_events(memory_id,op,at,source,hash_after) VALUES(?,?,?,?,?)').run('m_private', 'add', 1, 'PRIVATE audit canary', 'PRIVATE audit hash canary');
  db.prepare('INSERT INTO docs(path,project_id,mtime,title,body) VALUES(?,?,?,?,?)').run('doc.md', 'p_a', 1, 'Doc title', 'Doc preserved body');
  if (closed) db.close();
  return { sb, cfg, paths, db, close() { if (db.isOpen) db.close(); sb.cleanup(); } };
}
const options = (paths: ReturnType<typeof writerPaths>, now = Date.now) => ({ paths, now, id: crypto.randomUUID });
function plan(f: ReturnType<typeof fixture>, now = Date.now) {
  const result = planOwnerCutover(options(f.paths, now)); assert.equal(result.state, 'PLANNED', JSON.stringify(result));
  assert.ok(result.plan); return result;
}
const apply = (f: ReturnType<typeof fixture>, value = plan(f)) => applyOwnerCutover({ ...options(f.paths), operation: 'apply', plan: value.plan!, clientsStopped: true });
function tree(dir: string): unknown {
  const s = fs.lstatSync(dir, { bigint: true });
  const meta = { dev: String(s.dev), ino: String(s.ino), mode: String(s.mode), size: String(s.size), mtime: String(s.mtimeNs), ctime: String(s.ctimeNs) };
  if (s.isSymbolicLink()) return { ...meta, link: fs.readlinkSync(dir) };
  if (s.isDirectory()) return { ...meta, entries: Object.fromEntries(fs.readdirSync(dir).sort().map((name) => [name, tree(path.join(dir, name))])) };
  return { ...meta, bytes: crypto.createHash('sha256').update(fs.readFileSync(dir)).digest('hex') };
}
const rows = (db: DatabaseSync, table: string) => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all();
function decode(value: string) { return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); }
function encode(value: unknown) { return Buffer.from(JSON.stringify(value)).toString('base64url'); }

test('owner plan reads only filesystem/header metadata; real CLI preserves live and closed WAL footprints', async () => {
  for (const closed of [false, true]) {
    const f = fixture(closed); const before = tree(P.BOSUN); const exec = DatabaseSync.prototype.exec;
    try {
      DatabaseSync.prototype.exec = function () { throw new Error('planning must not invoke SQLite'); };
      const result = plan(f); assert.equal(result.operation, 'apply'); assert.equal(result.schema, 'unverified'); assert.equal(result.floor, 'unverified');
      assert.match(result.sourceId!, /^[0-9a-f-]{36}$/); assert.equal(decode(result.plan!).sourceId, result.sourceId);
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE|backup_hash|source_ref|PRIVATE hash/);
      DatabaseSync.prototype.exec = exec;
      const cli = await bosun(['memory', 'cutover', 'plan', '--json'], { env: f.sb.env() });
      assert.equal(cli.code, 0, cli.err); assert.equal(JSON.parse(cli.out).state, 'PLANNED');
      assert.deepEqual(tree(P.BOSUN), before);
    } finally { DatabaseSync.prototype.exec = exec; f.close(); }
  }
});

test('real owner CLI applies independently planned UUID, preserving private/audit/docs/IDs and fencing cached writer', async () => {
  const f = fixture();
  try {
    const before = Object.fromEntries(['memories', 'memory_events', 'docs'].map((t) => [t, rows(f.db, t)]));
    const cliPlan = await bosun(['memory', 'cutover', 'plan', '--json'], { env: f.sb.env() }); assert.equal(cliPlan.code, 0, cliPlan.err);
    const p = JSON.parse(cliPlan.out);
    const cli = await bosun(['memory', 'cutover', 'apply', '--plan', p.plan, '--clients-stopped', '--json'], { env: f.sb.env() });
    assert.equal(cli.code, 0, cli.err); const result = JSON.parse(cli.out);
    assert.equal(result.state, 'HOLD'); assert.equal(result.sourceId, p.sourceId); assert.equal(result.clientsStopped, 'attested'); assert.equal(result.restartRequired, true);
    assert.equal(f.cfg.MEMORY_SOURCE_ID, ''); assert.doesNotMatch(fs.readFileSync(P.CFG, 'utf8'), new RegExp(result.sourceId));
    const backups = fs.readdirSync(f.paths.backups); assert.deepEqual(backups, [result.attemptId + '.db']);
    const copy = new DatabaseSync(path.join(f.paths.backups, backups[0]), { readOnly: true });
    try { for (const [t, expected] of Object.entries(before)) { assert.deepEqual(rows(f.db, t), expected); assert.deepEqual(rows(copy, t), expected); } } finally { copy.close(); }
    assert.throws(() => f.db.prepare("UPDATE memories SET title='Cached' WHERE id='m_public'").run(), /bosun_writer_floor_v1/);
    const view = new DatabaseSync(f.paths.view, { readOnly: true });
    try { assert.equal(view.prepare('SELECT source_id FROM bosun_cutover_gate').get()!.source_id, p.sourceId); assert.equal(view.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='bosun_public_state'").get()!.n, 0); } finally { view.close(); }
    assert.doesNotMatch(cli.out + cli.err, /PRIVATE|\.db|backup_hash|private-tag|PRIVATE audit/); assert.deepEqual(f.sb.calls(), []);
  } finally { f.close(); }
});

test('closed WAL native open creates only empty WAL and canonical owner-only SHM; freshness permits those measured effects', async () => {
  const f = fixture(true); const p = plan(f); const exec = DatabaseSync.prototype.exec; let observed = false;
  assert.equal(fs.existsSync(f.paths.primary + '-wal'), false); assert.equal(fs.existsSync(f.paths.primary + '-shm'), false);
  try {
    DatabaseSync.prototype.exec = function (sql) {
      const result = exec.call(this, sql);
      if (sql === 'BEGIN IMMEDIATE' && !observed) {
        observed = true;
        assert.equal(fs.statSync(f.paths.primary + '-wal').size, 0);
        assert.equal(fs.statSync(f.paths.primary + '-shm').mode & 0o777, 0o600);
        assert.equal(fs.statSync(f.paths.primary + '-shm').size, 32768);
        assert.equal(fs.lstatSync(f.paths.primary + '-shm').isSymbolicLink(), false);
      }
      return result;
    };
    const result = await apply(f, p); assert.equal(observed, true); assert.equal(result.sourceId, p.sourceId);
  } finally { DatabaseSync.prototype.exec = exec; f.close(); }
});

test('stale source or WAL identity plans fail before native open without further footprint changes', async () => {
  for (const effect of ['write', 'wal-replace', 'primary-replace']) {
    const f = fixture(); const p = plan(f); const exec = DatabaseSync.prototype.exec; let native = 0;
    try {
      if (effect === 'write') f.db.prepare("UPDATE memories SET title='Changed' WHERE id='m_public'").run();
      else {
        const file = f.paths.primary + (effect === 'wal-replace' ? '-wal' : '');
        const replacement = file + '.new'; fs.writeFileSync(replacement, fs.readFileSync(file), { mode: 0o600 }); fs.renameSync(replacement, file);
      }
      const before = tree(P.BOSUN);
      DatabaseSync.prototype.exec = function (sql) { native++; return exec.call(this, sql); };
      await assert.rejects(apply(f, p), (e) => e instanceof OwnerCutoverError && e.blocker.reason === 'stale');
      assert.equal(native, 0); assert.deepEqual(tree(P.BOSUN), before); assert.deepEqual(fs.readdirSync(f.paths.backups), []);
    } finally { DatabaseSync.prototype.exec = exec; f.close(); }
  }
});

test('filesystem plan gives actionable strict-permission/missing-layout blockers and never adapts them', () => {
  for (const effect of ['legacy-mode', 'file-mode', 'missing-view-dir', 'missing-backups', 'missing-primary']) {
    const f = fixture(true);
    try {
      if (effect === 'legacy-mode') fs.chmodSync(P.BOSUN, 0o755);
      if (effect === 'file-mode') fs.chmodSync(f.paths.primary, 0o644);
      if (effect === 'missing-view-dir') fs.rmdirSync(path.dirname(f.paths.view));
      if (effect === 'missing-backups') fs.rmdirSync(f.paths.backups);
      if (effect === 'missing-primary') fs.unlinkSync(f.paths.primary);
      const before = tree(P.BOSUN); const result = planOwnerCutover(options(f.paths));
      assert.equal(result.state, 'BLOCKED'); assert.equal(result.plan, null); assert.equal(result.sourceId, null);
      assert.equal(result.blockers[0].reason, effect.endsWith('mode') ? 'permissions' : 'missing');
      if (effect === 'legacy-mode') assert.deepEqual(result.blockers[0], { target: 'primary-directory', reason: 'permissions', currentMode: '0755', requiredMode: '0700' });
      assert.deepEqual(tree(P.BOSUN), before);
    } finally { f.close(); }
  }
});

test('plan refuses symlink/dangling/hardlink path overrides, pending sidecars, orphans and unsupported headers', () => {
  for (const effect of ['view-link', 'dangling-parent', 'hardlink-primary', 'journal', 'orphan', 'empty-view', 'rollback-primary', 'unknown-artifact']) {
    const f = fixture(true);
    try {
      if (effect === 'view-link') fs.symlinkSync(f.paths.primary, f.paths.view);
      if (effect === 'dangling-parent') { fs.rmdirSync(path.dirname(f.paths.view)); fs.symlinkSync(path.join(f.sb.root, 'absent'), path.dirname(f.paths.view)); }
      if (effect === 'hardlink-primary') fs.linkSync(f.paths.primary, path.join(f.sb.root, 'hardlink.db'));
      if (effect === 'journal') fs.symlinkSync(path.join(f.sb.root, 'absent'), f.paths.primary + '-journal');
      if (effect === 'orphan') fs.writeFileSync(path.join(f.paths.backups, crypto.randomUUID() + '.db'), '', { mode: 0o600 });
      if (effect === 'empty-view') fs.writeFileSync(f.paths.view, '', { mode: 0o600 });
      if (effect === 'rollback-primary') { const db = new DatabaseSync(f.paths.primary); db.exec('PRAGMA journal_mode=DELETE'); db.close(); }
      if (effect === 'unknown-artifact') fs.writeFileSync(path.join(f.paths.backups, 'unknown'), 'PRIVATE error canary', { mode: 0o600 });
      const before = tree(P.BOSUN); const result = planOwnerCutover(options(f.paths)); assert.equal(result.state, 'BLOCKED', effect);
      assert.deepEqual(tree(P.BOSUN), before); assert.doesNotMatch(JSON.stringify(result), /PRIVATE|absent|memory\.db|unknown-artifact/);
    } finally { f.close(); }
  }
});

test('plans bind paths, expire in five minutes, reject future clocks/extra fields and require explicit stopped attestation', async () => {
  const f = fixture(true); const p = plan(f, () => 100); const before = tree(P.BOSUN);
  const defaults = { ...options(f.paths, () => 100), operation: 'apply' as const, plan: p.plan!, clientsStopped: true };
  try {
    for (const overrides of [ { clientsStopped: false }, { now: () => 99 }, { now: () => 300100 }, { operation: 'reconcile', sourceId: crypto.randomUUID() },
      { sourceId: crypto.randomUUID() }, { plan: encode({ ...decode(p.plan!), extra: 'PRIVATE token canary' }) },
      { plan: encode({ ...decode(p.plan!), expiresAt: 900000000 }) }, { plan: 'PRIVATE invalid token' }, { plan: 'A'.repeat(1025) },
      { paths: { ...f.paths, view: path.join(path.dirname(f.paths.view), 'different.db') } }, { extra: true } ]) {
      await assert.rejects(applyOwnerCutover({ ...defaults, ...overrides } as typeof defaults), (e) => e instanceof OwnerCutoverError);
      assert.deepEqual(tree(P.BOSUN), before);
    }
    for (const now of [() => -1, () => NaN, () => Promise.resolve(100), () => { throw new Error('PRIVATE clock canary'); }]) {
      const blocked = planOwnerCutover({ ...options(f.paths), now: now as () => number }); assert.equal(blocked.state, 'BLOCKED'); assert.doesNotMatch(JSON.stringify(blocked), /PRIVATE/);
    }
  } finally { f.close(); }
});

test('owner CLI rejects missing attestation, extra inputs, duplicate flags and remote selection without storage effects', async () => {
  const f = fixture(true); const p = plan(f); const before = tree(P.BOSUN);
  try {
    for (const args of [ ['plan', '--source-id', crypto.randomUUID()], ['plan', 'PRIVATE positional canary'], ['plan', '--json', '--json'],
      ['apply', '--plan', p.plan!], ['apply', '--plan', p.plan!, '--clients-stopped', '--source-id', p.sourceId!], ['reconcile', '--plan', p.plan!, '--clients-stopped'],
      ['apply', '--plan', p.plan!, '--clients-stopped', '--clients-stopped'], ['plan', '--PRIVATE-error-canary'] ]) {
      const result = await bosun(['memory', 'cutover', ...args], { env: f.sb.env() }); assert.equal(result.code, 2, result.err);
      assert.doesNotMatch(result.out + result.err, /PRIVATE/); assert.deepEqual(tree(P.BOSUN), before);
    }
    const remote = await bosun(['memory', 'cutover', 'plan', '--json'], { env: f.sb.env({ MEMORY_URL: 'http://127.0.0.1:1' }) });
    assert.equal(remote.code, 1); assert.match(remote.err, /local cutover unavailable \(remote\)/); assert.deepEqual(tree(P.BOSUN), before); assert.deepEqual(f.sb.calls(), []);
  } finally { f.close(); }
});

test('native schema validation refuses unsupported primary before backup/floor while filesystem plan remains unverified', async () => {
  const f = fixture(); f.db.exec('CREATE TABLE unexpected_schema(id INTEGER)'); const p = plan(f);
  try {
    await assert.rejects(apply(f, p), (e) => e instanceof CutoverError && e.reason === 'schema');
    assert.deepEqual(fs.readdirSync(f.paths.backups), []); assert.equal(fs.existsSync(f.paths.view), false);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'bosun_%'").get()!.n, 0);
  } finally { f.close(); }
});

test('admission rechecks plan before artifacts; contenders are blocked and a late backup-directory change is refused', async () => {
  const f = fixture(); const p = plan(f); const exec = DatabaseSync.prototype.exec; let admitted = false;
  try {
    DatabaseSync.prototype.exec = function (sql) {
      const result = exec.call(this, sql);
      if (sql === 'BEGIN IMMEDIATE' && !admitted) {
        admitted = true; assert.throws(() => f.db.prepare("UPDATE memories SET title='Contender'").run(), /locked/);
        fs.writeFileSync(path.join(f.paths.backups, 'orphan.db'), '', { mode: 0o600 });
      }
      return result;
    };
    await assert.rejects(apply(f, p), (e) => e instanceof CutoverError); assert.equal(admitted, true);
    assert.deepEqual(fs.readdirSync(f.paths.backups), ['orphan.db']); assert.equal(fs.existsSync(f.paths.view), false);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'bosun_%'").get()!.n, 0);
  } finally { DatabaseSync.prototype.exec = exec; f.close(); }
});

test('READY reconciliation requires independent source UUID before HOLD and explicitly revokes on success without new backup/doubleapply', async () => {
  const f = fixture();
  try {
    const initial = plan(f); const first = await apply(f, initial); await publishMemoryView(options(f.paths));
    const p = plan(f); assert.equal(p.operation, 'reconcile'); assert.equal(p.sourceId, null);
    const beforeBackups = tree(f.paths.backups); const viewIno = fs.statSync(f.paths.view, { bigint: true }).ino;
    const viewState = () => { const db = new DatabaseSync(f.paths.view, { readOnly: true }); try { return db.prepare('SELECT state FROM bosun_public_state').get()!.state; } finally { db.close(); } };
    await assert.rejects(applyOwnerCutover({ ...options(f.paths), operation: 'reconcile', plan: p.plan!, sourceId: crypto.randomUUID(), clientsStopped: true }), (e) => e instanceof CutoverError && e.reason === 'identity');
    assert.equal(viewState(), 'READY'); assert.deepEqual(tree(f.paths.backups), beforeBackups);
    const cli = await bosun(['memory', 'cutover', 'reconcile', '--plan', p.plan!, '--source-id', initial.sourceId!, '--clients-stopped', '--json'], { env: f.sb.env() });
    assert.equal(cli.code, 0, cli.err); const result = JSON.parse(cli.out); assert.equal(result.sourceId, first.sourceId); assert.equal(result.attemptId, first.attemptId);
    assert.equal(result.state, 'HOLD'); assert.equal(result.operation, 'reconcile'); assert.equal(viewState(), 'HOLD');
    assert.deepEqual(tree(f.paths.backups), beforeBackups); assert.equal(fs.statSync(f.paths.view, { bigint: true }).ino, viewIno);
  } finally { f.close(); }
});

test('saved planned source UUID recovers committed-but-unacknowledged floor; incomplete and multi-artifact attempts stay blocked', async () => {
  const f = fixture(); const p = plan(f); let generated = 0;
  try {
    await assert.rejects(cutoverMemory({ ...options(f.paths), id: () => ++generated === 2 ? p.sourceId! : crypto.randomUUID(), checkpoint(phase) {
      if (phase === 'commit') throw new Error('PRIVATE lost receipt canary');
    } }), CutoverError);
    const recovery = plan(f); assert.equal(recovery.operation, 'reconcile');
    const result = await applyOwnerCutover({ ...options(f.paths), operation: 'reconcile', plan: recovery.plan!, sourceId: p.sourceId!, clientsStopped: true });
    assert.equal(result.sourceId, p.sourceId); assert.equal(result.generation, 0); assert.equal(fs.readdirSync(f.paths.backups).length, 1);
    fs.writeFileSync(path.join(f.paths.backups, crypto.randomUUID() + '.db'), '', { mode: 0o600 });
    assert.equal(planOwnerCutover(options(f.paths)).state, 'BLOCKED');
  } finally { f.close(); }
  const incomplete = fixture();
  try {
    await assert.rejects(cutoverMemory({ ...options(incomplete.paths), checkpoint(phase) { if (phase === 'intent') throw new Error('interrupted'); } }), CutoverError);
    const before = tree(P.BOSUN); assert.equal(planOwnerCutover(options(incomplete.paths)).state, 'BLOCKED'); assert.deepEqual(tree(P.BOSUN), before);
  } finally { incomplete.close(); }
});

test('owner filesystem failures reconstruct mutated typed errors, accessor blockers and hostile proxies without private text', () => {
  const f = fixture(true); const lstat = fs.lstatSync; const before = tree(P.BOSUN);
  try {
    const typed = new OwnerCutoverError({ target: 'primary', reason: 'permissions', currentMode: '0644', requiredMode: '0600' });
    Object.assign(typed.blocker, { privateBody: 'PRIVATE added body canary' });
    const changed = new OwnerCutoverError({ target: 'primary', reason: 'path' });
    Object.assign(changed.blocker, { target: 'PRIVATE target canary', reason: 'PRIVATE reason canary' });
    const accessor = new OwnerCutoverError({ target: 'primary', reason: 'path' });
    Object.defineProperty(accessor, 'blocker', { get() { throw new Error('PRIVATE getter canary'); } });
    const native = new CutoverError('storage');
    Object.defineProperty(native, 'reason', { get() { throw new Error('PRIVATE native getter canary'); } });
    const hostile = new Proxy({}, { getPrototypeOf() { throw new Error('PRIVATE proxy canary'); } });
    for (const error of [typed, changed, accessor, native, hostile, new Error('PRIVATE filesystem canary')]) {
      fs.lstatSync = ((file: fs.PathLike, ...rest: unknown[]) => {
        if (file === f.paths.primary) throw error;
        return (lstat as (...args: unknown[]) => unknown)(file, ...rest);
      }) as typeof fs.lstatSync;
      let value: unknown;
      try { value = planOwnerCutover(options(f.paths)); } catch (e) { value = { message: (e as Error).message }; }
      assert.doesNotMatch(JSON.stringify(value), /PRIVATE/);
      if (error === typed) assert.deepEqual((value as { blockers: unknown[] }).blockers, [{ target: 'primary', reason: 'permissions', currentMode: '0644', requiredMode: '0600' }]);
    }
    fs.lstatSync = lstat; assert.deepEqual(tree(P.BOSUN), before);
  } finally { fs.lstatSync = lstat; f.close(); }
});

test('local owner wrapper rejects getter/proxy/hidden extra request fields before composition or native effects', async () => {
  const f = fixture(true); const p = plan(f); const before = tree(P.BOSUN);
  const base = { operation: 'apply' as const, plan: p.plan!, clientsStopped: true };
  try {
    const getter = { ...base }; Object.defineProperty(getter, 'plan', { get() { throw new Error('PRIVATE wrapper getter canary'); } });
    const proxy = new Proxy(base, { ownKeys() { throw new Error('PRIVATE wrapper proxy canary'); } });
    const hidden = { ...base }; Object.defineProperty(hidden, 'private', { value: 'PRIVATE hidden canary' });
    for (const request of [getter, proxy, hidden]) {
      await assert.rejects(applyLocalMemoryCutover(f.cfg, request), (e) => e instanceof Error && e.message === 'invalid owner cutover request');
      assert.deepEqual(tree(P.BOSUN), before);
    }
  } finally { f.close(); }
});

test('owner dependency getters and proxies reject before filesystem inspection or private error serialization', async () => {
  const f = fixture(true); const approved = plan(f); const before = tree(P.BOSUN); const lstat = fs.lstatSync;
  const getter = Object.defineProperty({}, 'paths', { get() { throw new Error('PRIVATE dependency getter canary'); } });
  const proxy = new Proxy({}, { ownKeys() { throw new Error('PRIVATE dependency proxy canary'); } });
  let inspected = 0;
  try {
    fs.lstatSync = (() => { inspected++; throw new Error('PRIVATE unexpected filesystem canary'); }) as typeof fs.lstatSync;
    for (const input of [getter, proxy]) {
      const result = planOwnerCutover(input as never);
      assert.equal(result.state, 'BLOCKED'); assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
      await assert.rejects(applyOwnerCutover(input as never), (e) => e instanceof OwnerCutoverError && e.blocker.reason === 'input' && !/PRIVATE/.test(e.message));
    }
    assert.equal(inspected, 0);
    assert.ok(approved.sourceId, 'fixture has an independently saved identity before malformed requests');
  } finally { fs.lstatSync = lstat; assert.deepEqual(tree(P.BOSUN), before); f.close(); }
});

test('non-synchronous owner validation is refused under native admission before any artifact or floor mutation', async () => {
  for (const kind of ['promise', 'value', 'native-handle']) {
    const f = fixture(); const approved = plan(f); let generated = 0; let validated = false;
    const before = Object.fromEntries(['memories', 'memory_events', 'docs'].map((table) => [table, rows(f.db, table)]));
    try {
      await assert.rejects(cutoverMemory({ ...options(f.paths), id: () => ++generated === 2 ? approved.sourceId! : crypto.randomUUID(),
        expectation: { operation: 'apply', sourceId: approved.sourceId!, validate() {
          validated = true; assert.equal(arguments.length, 0, 'validator receives no native handle');
          assert.throws(() => f.db.prepare("UPDATE memories SET title='Contender'").run(), /locked/, 'native write admission is retained');
          return (kind === 'promise' ? Promise.resolve() : kind === 'value' ? true : f.db) as never;
        } },
      }), (e) => e instanceof CutoverError && e.reason === 'input');
      assert.equal(validated, true);
      assert.equal(fs.existsSync(f.paths.view), false); assert.deepEqual(fs.readdirSync(f.paths.backups), []);
      assert.equal(f.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'bosun_%'").get()!.n, 0);
      for (const [table, expected] of Object.entries(before)) assert.deepEqual(rows(f.db, table), expected);
    } finally { f.close(); }
  }
});

function preparation(f: ReturnType<typeof fixture>, create = false, now = Date.now) {
  const result = planOwnerPreparation({ paths: f.paths, now, createViewDirectory: create, createBackupDirectory: create });
  assert.equal(result.state, 'PLANNED', JSON.stringify(result)); assert.ok(result.plan); return result;
}
function prepare(f: ReturnType<typeof fixture>, value = preparation(f), now = Date.now) {
  return prepareOwnerLayout({ paths: f.paths, plan: value.plan!, clientsStopped: true, now });
}
const mode = (file: string) => fs.statSync(file).mode & 0o7777;

test('real CLI reviews absent-leaf creation and legacy modes without SQLite, then applies a fresh strict candidate', async () => {
  const f = fixture(true); const exec = DatabaseSync.prototype.exec; const query = DatabaseSync.prototype.prepare;
  try {
    fs.rmdirSync(path.dirname(f.paths.view)); fs.rmdirSync(f.paths.backups);
    fs.chmodSync(P.BOSUN, 0o755); fs.chmodSync(f.paths.primary, 0o644);
    const primary = fs.readFileSync(f.paths.primary); const config = tree(P.CFG); const before = tree(P.BOSUN);
    const blocked = await bosun(['memory', 'cutover', 'prepare-plan', '--json'], { env: f.sb.env() });
    assert.equal(blocked.code, 1); assert.equal(JSON.parse(blocked.out).blockers[0].reason, 'missing');
    assert.deepEqual(tree(P.BOSUN), before);
    const planned = await bosun(['memory', 'cutover', 'prepare-plan', '--create-view-directory', '--create-backup-directory', '--json'], { env: f.sb.env() });
    assert.equal(planned.code, 0, planned.err); const p = JSON.parse(planned.out);
    assert.equal(p.schema, 'unverified'); assert.equal(p.floor, 'unverified'); assert.equal(p.clients, 'unverified');
    assert.deepEqual(p.actions.map((a: { target: string }) => a.target).sort(), ['backup-directory', 'primary', 'primary-directory', 'view-directory']);
    assert.deepEqual(p.actions.filter((a: { action: string }) => a.action === 'mkdir').map((a: { path: string }) => a.path).sort(), [f.paths.backups, path.dirname(f.paths.view)].sort());
    assert.doesNotMatch(JSON.stringify(p), /PRIVATE|sourceId|backup_hash/); assert.deepEqual(tree(P.BOSUN), before);
    DatabaseSync.prototype.exec = function () { throw new Error('preparation must not execute SQLite'); };
    DatabaseSync.prototype.prepare = function () { throw new Error('preparation must not prepare SQLite'); };
    // The adapter also runs with native SQL methods trapped; the CLI independently covers composition.
    const nativePlan = preparation(f, true); assert.deepEqual(nativePlan.actions, p.actions);
    DatabaseSync.prototype.exec = exec; DatabaseSync.prototype.prepare = query;
    const applied = await bosun(['memory', 'cutover', 'prepare', '--plan', p.plan, '--clients-stopped', '--json'], { env: f.sb.env() });
    assert.equal(applied.code, 0, applied.err); const result = JSON.parse(applied.out);
    assert.equal(result.state, 'PREPARED'); assert.equal(result.clientsStopped, 'attested'); assert.equal(result.replanRequired, true);
    for (const file of [P.BOSUN, path.dirname(f.paths.view), f.paths.backups]) assert.equal(mode(file), 0o700);
    assert.equal(mode(f.paths.primary), 0o600); assert.deepEqual(fs.readFileSync(f.paths.primary), primary); assert.deepEqual(tree(P.CFG), config);
    assert.equal(fs.existsSync(f.paths.view), false); assert.deepEqual(fs.readdirSync(f.paths.backups), []);
    assert.equal(fs.existsSync(f.paths.primary + '-wal'), false); assert.equal(fs.existsSync(f.paths.primary + '-shm'), false);
    const candidate = plan(f); assert.equal(candidate.operation, 'apply');
    const cutover = await bosun(['memory', 'cutover', 'apply', '--plan', candidate.plan!, '--clients-stopped', '--json'], { env: f.sb.env() });
    assert.equal(cutover.code, 0, cutover.err); assert.equal(JSON.parse(cutover.out).sourceId, candidate.sourceId); assert.equal(JSON.parse(cutover.out).state, 'HOLD');
    assert.equal(f.cfg.MEMORY_SOURCE_ID, ''); assert.deepEqual(f.sb.calls(), []);
  } finally { DatabaseSync.prototype.exec = exec; DatabaseSync.prototype.prepare = query; f.close(); }
});

test('preparation narrows only known descriptors including existing WAL/SHM and leaves all SQLite bytes/identities untouched', () => {
  const f = fixture(); const exec = DatabaseSync.prototype.exec; const query = DatabaseSync.prototype.prepare; const chmod = fs.chmodSync;
  const files = [f.paths.primary, f.paths.primary + '-wal', f.paths.primary + '-shm'];
  try {
    fs.chmodSync(P.BOSUN, 0o750); fs.chmodSync(path.dirname(f.paths.view), 0o755); fs.chmodSync(f.paths.backups, 0o750);
    for (const [i, file] of files.entries()) fs.chmodSync(file, i % 2 ? 0o640 : 0o644);
    const before = files.map((file) => ({ file, bytes: fs.readFileSync(file), ino: fs.statSync(file).ino, mtime: fs.statSync(file, { bigint: true }).mtimeNs }));
    const config = tree(P.CFG); const p = preparation(f); assert.equal(p.actions.length, 6);
    DatabaseSync.prototype.exec = function () { throw new Error('no SQL'); }; DatabaseSync.prototype.prepare = function () { throw new Error('no SQL'); };
    fs.chmodSync = (() => { throw new Error('path chmod is forbidden'); }) as typeof fs.chmodSync;
    const result = prepare(f, p); assert.equal(result.state, 'PREPARED');
    for (const expected of before) {
      assert.equal(mode(expected.file), 0o600); assert.deepEqual(fs.readFileSync(expected.file), expected.bytes);
      assert.equal(fs.statSync(expected.file).ino, expected.ino); assert.equal(fs.statSync(expected.file, { bigint: true }).mtimeNs, expected.mtime);
    }
    assert.deepEqual(tree(P.CFG), config); assert.equal(fs.existsSync(f.paths.view), false);
    assert.equal(preparation(f).actions.length, 0); assert.equal(plan(f).operation, 'apply');
  } finally { DatabaseSync.prototype.exec = exec; DatabaseSync.prototype.prepare = query; fs.chmodSync = chmod; f.close(); }
});

test('preparation rejects unknown modes, links, owners, existing views, pending/unknown inventory and unsupported formats without effects', () => {
  const effects = ['directory-write', 'directory-special', 'file-write', 'file-special', 'file-unusual', 'unowned', 'primary-link', 'hardlink',
    'view-link', 'view-present', 'primary-journal', 'view-shm', 'view-inventory', 'backup-inventory', 'rollback', 'oversize', 'missing-primary', 'recursive-parent'];
  for (const effect of effects) {
    const f = fixture(true); const lstat = fs.lstatSync;
    try {
      fs.chmodSync(P.BOSUN, 0o755);
      if (effect === 'directory-write') fs.chmodSync(path.dirname(f.paths.view), 0o777);
      if (effect === 'directory-special') fs.chmodSync(f.paths.backups, 0o1700);
      if (effect === 'file-write') fs.chmodSync(f.paths.primary, 0o666);
      if (effect === 'file-special') fs.chmodSync(f.paths.primary, 0o4600);
      if (effect === 'file-unusual') fs.chmodSync(f.paths.primary, 0o604);
      if (effect === 'primary-link') { fs.renameSync(f.paths.primary, f.paths.primary + '.old'); fs.symlinkSync(f.paths.primary + '.old', f.paths.primary); }
      if (effect === 'hardlink') fs.linkSync(f.paths.primary, path.join(f.sb.root, 'alias.db'));
      if (effect === 'view-link') fs.symlinkSync(path.join(f.sb.root, 'absent'), f.paths.view);
      if (effect === 'view-present') fs.writeFileSync(f.paths.view, '', { mode: 0o600 });
      if (effect === 'primary-journal') fs.writeFileSync(f.paths.primary + '-journal', '', { mode: 0o600 });
      if (effect === 'view-shm') fs.symlinkSync(path.join(f.sb.root, 'absent'), f.paths.view + '-shm');
      if (effect === 'view-inventory') fs.writeFileSync(path.join(path.dirname(f.paths.view), 'unknown'), 'PRIVATE canary', { mode: 0o600 });
      if (effect === 'backup-inventory') fs.writeFileSync(path.join(f.paths.backups, crypto.randomUUID() + '.db'), '', { mode: 0o600 });
      if (effect === 'rollback') { const db = new DatabaseSync(f.paths.primary); db.exec('PRAGMA journal_mode=DELETE'); db.close(); }
      if (effect === 'oversize') fs.truncateSync(f.paths.primary, 64 * 1024 * 1024 + 1);
      if (effect === 'missing-primary') fs.unlinkSync(f.paths.primary);
      const before = tree(P.BOSUN);
      if (effect === 'unowned') fs.lstatSync = ((file, options) => {
        const stat = lstat(file, options as never); if (file === f.paths.primary) Object.defineProperty(stat, 'uid', { value: typeof stat.uid === 'bigint' ? stat.uid + 1n : stat.uid + 1 });
        return stat;
      }) as typeof fs.lstatSync;
      const paths = effect === 'recursive-parent' ? { ...f.paths, view: path.join(P.BOSUN, 'absent', 'leaf', 'public.db') } : f.paths;
      const result = planOwnerPreparation({ paths, now: Date.now, createViewDirectory: true, createBackupDirectory: true });
      fs.lstatSync = lstat;
      assert.equal(result.state, 'BLOCKED', effect); assert.equal(result.plan, null); assert.deepEqual(result.actions, []);
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE|alias\.db/); assert.deepEqual(tree(P.BOSUN), before);
    } finally { fs.lstatSync = lstat; f.close(); }
  }
});

test('a real existing READY view stays blocked before any preparation permission action', async () => {
  const f = fixture(true);
  try {
    const initial = await apply(f); await publishMemoryView(options(f.paths));
    fs.chmodSync(P.BOSUN, 0o755); fs.chmodSync(path.dirname(f.paths.view), 0o755); fs.chmodSync(f.paths.view, 0o644);
    const before = tree(P.BOSUN); const result = planOwnerPreparation({ paths: f.paths, now: Date.now });
    assert.equal(result.state, 'BLOCKED'); assert.deepEqual(result.blockers, [{ target: 'view', reason: 'layout' }]);
    const cli = await bosun(['memory', 'cutover', 'prepare-plan', '--json'], { env: f.sb.env() });
    assert.equal(cli.code, 1); assert.deepEqual(tree(P.BOSUN), before); assert.ok(initial.sourceId);
  } finally { f.close(); }
});

test('preparation freshness binds complete WAL/SHM stamps, directory identities, missing leaves and configuration paths', () => {
  for (const effect of ['wal-bytes', 'shm-bytes', 'shm-replace', 'primary-mode', 'view-dir-replace', 'create-leaf', 'path']) {
    const f = fixture();
    try {
      fs.chmodSync(P.BOSUN, 0o755);
      if (effect === 'create-leaf') fs.rmdirSync(path.dirname(f.paths.view));
      const p = preparation(f, effect === 'create-leaf');
      if (effect === 'wal-bytes' || effect === 'shm-bytes') {
        const file = f.paths.primary + (effect === 'wal-bytes' ? '-wal' : '-shm'); const fd = fs.openSync(file, 'r+');
        try { fs.writeSync(fd, Buffer.from('changed'), 0, 7, 40); } finally { fs.closeSync(fd); }
      }
      if (effect === 'shm-replace') { const file = f.paths.primary + '-shm'; fs.renameSync(file, file + '.old'); fs.writeFileSync(file, fs.readFileSync(file + '.old'), { mode: 0o600 }); }
      if (effect === 'primary-mode') fs.chmodSync(f.paths.primary, 0o644);
      if (effect === 'view-dir-replace') { fs.rmdirSync(path.dirname(f.paths.view)); fs.mkdirSync(path.dirname(f.paths.view), { mode: 0o700 }); }
      if (effect === 'create-leaf') fs.mkdirSync(path.dirname(f.paths.view), { mode: 0o700 });
      const before = tree(P.BOSUN);
      const paths = effect === 'path' ? { ...f.paths, view: path.join(path.dirname(f.paths.view), 'changed.db') } : f.paths;
      assert.throws(() => prepareOwnerLayout({ paths, plan: p.plan!, clientsStopped: true, now: Date.now }), (e) => e instanceof OwnerCutoverError && e.blocker.reason === 'stale', effect);
      assert.deepEqual(tree(P.BOSUN), before);
    } finally { f.close(); }
  }
});

test('preparation pins all actionable and creation-parent descriptors before any permission effect', () => {
  const f = fixture(true); const open = fs.openSync; const fchmod = fs.fchmodSync; let changed = 0;
  try {
    fs.chmodSync(P.BOSUN, 0o755); fs.chmodSync(f.paths.primary, 0o644); const p = preparation(f);
    const before = tree(P.BOSUN);
    fs.openSync = ((file, flags, mode) => {
      if (file === path.dirname(f.paths.view)) throw new Error('PRIVATE cannot pin directory');
      return open(file, flags, mode);
    }) as typeof fs.openSync;
    fs.fchmodSync = ((fd, permissions) => { changed++; return fchmod(fd, permissions); }) as typeof fs.fchmodSync;
    assert.throws(() => prepare(f, p), (e) => e instanceof OwnerCutoverError && !/PRIVATE/.test(e.message));
    assert.equal(changed, 0); assert.deepEqual(tree(P.BOSUN), before);
  } finally { fs.openSync = open; fs.fchmodSync = fchmod; f.close(); }
});

test('all pinned source, WAL and SHM metadata is rechecked before the first fchmod', () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = fixture(); const open = fs.openSync; const close = fs.closeSync; const fchmod = fs.fchmodSync;
    const held = new Set<number>(); let replaced = false; let narrowed = 0;
    try {
      fs.chmodSync(P.BOSUN, 0o755); const p = preparation(f);
      fs.openSync = ((file, flags, permissions) => {
        const fd = open(file, flags, permissions); held.add(fd);
        if (!replaced && held.size === 6) {
          replaced = true;
          assert.equal(typeof flags, 'number'); assert.ok(Number(flags) & fs.constants.O_NOFOLLOW);
          const changed = open(f.paths.primary + suffix, 'r+');
          try { fs.writeSync(changed, Buffer.from('changed'), 0, 7, 40); } finally { close(changed); }
        }
        return fd;
      }) as typeof fs.openSync;
      fs.closeSync = ((fd) => { held.delete(fd); return close(fd); }) as typeof fs.closeSync;
      fs.fchmodSync = ((fd, permissions) => { narrowed++; return fchmod(fd, permissions); }) as typeof fs.fchmodSync;
      assert.throws(() => prepare(f, p), OwnerCutoverError);
      assert.equal(replaced, true); assert.equal(narrowed, 0); assert.equal(mode(P.BOSUN), 0o755); assert.equal(held.size, 0);
    } finally { fs.openSync = open; fs.closeSync = close; fs.fchmodSync = fchmod; f.close(); }
  }
});

test('descriptor replacement during pinning is refused; replacement after chmod never receives path permission changes', () => {
  for (const effect of ['pin-replace', 'chmod-replace']) {
    const f = fixture(true); const open = fs.openSync; const fchmod = fs.fchmodSync; let primaryOpens = 0; let changed = 0;
    try {
      fs.chmodSync(f.paths.primary, 0o644); const p = preparation(f); const file = f.paths.primary;
      function replace() { fs.renameSync(file, file + '.old'); fs.writeFileSync(file, fs.readFileSync(file + '.old'), { mode: 0o644 }); }
      if (effect === 'pin-replace') fs.openSync = ((candidate, flags, mode) => {
        const fd = open(candidate, flags, mode);
        if (candidate === file && ++primaryOpens === 2) replace();
        return fd;
      }) as typeof fs.openSync;
      fs.fchmodSync = ((fd, permissions) => {
        changed++; const result = fchmod(fd, permissions); if (effect === 'chmod-replace') replace(); return result;
      }) as typeof fs.fchmodSync;
      assert.throws(() => prepare(f, p), OwnerCutoverError);
      assert.equal(mode(file), 0o644); assert.equal(changed, effect === 'pin-replace' ? 0 : 1);
      assert.equal(mode(file + '.old'), effect === 'pin-replace' ? 0o644 : 0o600);
    } finally { fs.openSync = open; fs.fchmodSync = fchmod; f.close(); }
  }
});

test('partial fchmod, mkdir and close failures stay conservative, expose finite errors and require a new preparation plan', () => {
  for (const effect of ['chmod-fail', 'chmod-after-effect', 'mkdir-fail', 'close-fail']) {
    const f = fixture(true); const fchmod = fs.fchmodSync; const mkdir = fs.mkdirSync; const close = fs.closeSync;
    let narrowed = 0; let failClose = true;
    try {
      fs.chmodSync(P.BOSUN, 0o755); fs.chmodSync(f.paths.primary, 0o644);
      if (effect === 'mkdir-fail') { fs.rmdirSync(path.dirname(f.paths.view)); fs.rmdirSync(f.paths.backups); }
      const p = preparation(f, effect === 'mkdir-fail');
      fs.fchmodSync = ((fd, permissions) => {
        if (effect === 'chmod-fail' && narrowed === 1) throw new Error('PRIVATE partial fchmod');
        const result = fchmod(fd, permissions); narrowed++;
        if (effect === 'chmod-after-effect') throw new Error('PRIVATE after fchmod');
        return result;
      }) as typeof fs.fchmodSync;
      fs.mkdirSync = ((file, options) => { if (file === path.dirname(f.paths.view)) throw new Error('PRIVATE partial mkdir'); return mkdir(file, options); }) as typeof fs.mkdirSync;
      fs.closeSync = ((fd) => {
        if (effect === 'close-fail' && narrowed > 0 && failClose && fs.fstatSync(fd).isDirectory()) { failClose = false; throw new Error('PRIVATE close failed'); }
        return close(fd);
      }) as typeof fs.closeSync;
      assert.throws(() => prepare(f, p), (e) => e instanceof OwnerCutoverError && !/PRIVATE/.test(e.message));
      fs.fchmodSync = fchmod; fs.mkdirSync = mkdir; fs.closeSync = close;
      assert.equal(mode(P.BOSUN), 0o700); assert.equal(mode(f.paths.primary), effect === 'close-fail' ? 0o600 : 0o644);
      if (effect === 'mkdir-fail') { assert.equal(mode(f.paths.backups), 0o700); assert.equal(fs.existsSync(path.dirname(f.paths.view)), false); }
      assert.throws(() => prepare(f, p), OwnerCutoverError, 'an old token cannot waive earlier partial effects');
      const fresh = preparation(f, effect === 'mkdir-fail'); assert.ok(fresh.plan);
      assert.equal(prepare(f, fresh).state, 'PREPARED');
    } finally { fs.fchmodSync = fchmod; fs.mkdirSync = mkdir; fs.closeSync = close; f.close(); }
  }
});

test('created-leaf races and unexpected changes between preparation actions are rejected without cleanup or broadening', () => {
  for (const effect of ['raced-existing', 'created-link', 'created-replace', 'other-change']) {
    const f = fixture(true); const mkdir = fs.mkdirSync; const open = fs.openSync; const fchmod = fs.fchmodSync;
    try {
      fs.rmdirSync(path.dirname(f.paths.view)); fs.rmdirSync(f.paths.backups); fs.chmodSync(P.BOSUN, 0o755); fs.chmodSync(f.paths.primary, 0o644);
      const p = preparation(f, true); const leaf = f.paths.backups;
      fs.mkdirSync = ((file, options) => {
        if (file === leaf && effect === 'raced-existing') mkdir(file, { mode: 0o750 });
        const result = mkdir(file, options);
        if (file === leaf && effect === 'created-link') { fs.renameSync(leaf, leaf + '.old'); fs.symlinkSync(leaf + '.old', leaf); }
        return result;
      }) as typeof fs.mkdirSync;
      fs.openSync = ((file, flags, mode) => {
        if (file === leaf && effect === 'created-replace') { fs.renameSync(leaf, leaf + '.old'); mkdir(leaf, { mode: 0o750 }); }
        return open(file, flags, mode);
      }) as typeof fs.openSync;
      fs.fchmodSync = ((fd, permissions) => {
        const result = fchmod(fd, permissions);
        if (effect === 'other-change') fs.chmodSync(f.paths.primary, 0o640);
        return result;
      }) as typeof fs.fchmodSync;
      assert.throws(() => prepare(f, p), OwnerCutoverError);
      assert.equal(mode(P.BOSUN), 0o700); assert.equal(fs.existsSync(leaf), effect !== 'other-change');
      if (effect === 'raced-existing' || effect === 'created-replace') assert.equal(mode(leaf), 0o750);
      if (effect === 'created-link') assert.equal(fs.lstatSync(leaf).isSymbolicLink(), true);
      assert.equal(mode(f.paths.primary), effect === 'other-change' ? 0o640 : 0o644);
    } finally { fs.mkdirSync = mkdir; fs.openSync = open; fs.fchmodSync = fchmod; f.close(); }
  }
});

test('owner-held close failure retries once, remains finite failure, and does not claim persistent descriptor release', () => {
  for (const persistent of [false, true]) {
    const f = fixture(true); const close = fs.closeSync; const fchmod = fs.fchmodSync;
    let narrowed = false; let refused: number | undefined; let attempts = 0;
    try {
      fs.chmodSync(P.BOSUN, 0o755); const p = preparation(f);
      fs.fchmodSync = ((fd, permissions) => { narrowed = true; return fchmod(fd, permissions); }) as typeof fs.fchmodSync;
      fs.closeSync = ((fd) => {
        if (narrowed && refused === undefined && fs.fstatSync(fd).isDirectory()) refused = fd;
        if (fd === refused && (++attempts === 1 || persistent)) throw new Error('PRIVATE close receipt');
        return close(fd);
      }) as typeof fs.closeSync;
      assert.throws(() => prepare(f, p), (e) => e instanceof OwnerCutoverError && e.blocker.reason === 'storage' && !/PRIVATE/.test(e.message));
      assert.equal(attempts, 2); assert.equal(mode(P.BOSUN), 0o700);
      if (persistent) { assert.equal(fs.fstatSync(refused!).isDirectory(), true); close(refused!); }
      else assert.throws(() => fs.fstatSync(refused!), /bad file descriptor|EBADF/);
      assert.throws(() => prepare(f, p), OwnerCutoverError);
    } finally { fs.closeSync = close; fs.fchmodSync = fchmod; f.close(); }
  }
});

test('preparation rejects malformed, future/expired/oversized tokens, wrong operations, missing attestation and extra request fields', () => {
  const f = fixture(true); const p = preparation(f, false, () => 100); const before = tree(P.BOSUN);
  const defaults = { paths: f.paths, plan: p.plan!, clientsStopped: true, now: () => 100 };
  try {
    for (const override of [ { clientsStopped: false }, { now: () => 99 }, { now: () => 300100 }, { plan: 'A'.repeat(1025) },
      { plan: 'PRIVATE invalid token' }, { plan: encode({ ...decode(p.plan!), extra: true }) }, { plan: encode({ ...decode(p.plan!), operation: 'apply' }) },
      { plan: encode({ ...decode(p.plan!), expiresAt: 999999 }) }, { plan: encode({ ...decode(p.plan!), createViewDirectory: 'true' }) },
      { plan: plan(f, () => 100).plan! }, { extra: true } ]) {
      assert.throws(() => prepareOwnerLayout({ ...defaults, ...override } as typeof defaults), OwnerCutoverError); assert.deepEqual(tree(P.BOSUN), before);
    }
    for (const createViewDirectory of ['true', 1, null]) assert.equal(planOwnerPreparation({ paths: f.paths, now: Date.now, createViewDirectory } as never).state, 'BLOCKED');
  } finally { f.close(); }
});

test('real preparation CLI rejects unexpected flags/positionals/duplicate options/remote and prints finite partial-outcome guidance', async () => {
  const f = fixture(true); const p = preparation(f); const before = tree(P.BOSUN);
  try {
    for (const args of [ ['prepare-plan', '--plan', p.plan!], ['prepare-plan', '--create-view-directory', '--create-view-directory'],
      ['prepare-plan', 'extra'], ['prepare', '--plan', p.plan!], ['prepare', '--plan', p.plan!, '--clients-stopped', '--create-backup-directory'],
      ['prepare', '--plan', p.plan!, '--plan', p.plan!, '--clients-stopped'], ['prepare', '--plan', p.plan!, '--source-id', crypto.randomUUID(), '--clients-stopped'] ]) {
      const cli = await bosun(['memory', 'cutover', ...args], { env: f.sb.env() }); assert.equal(cli.code, 2, cli.err); assert.deepEqual(tree(P.BOSUN), before);
    }
    const bad = await bosun(['memory', 'cutover', 'prepare', '--plan', 'PRIVATEinvalid', '--clients-stopped'], { env: f.sb.env() });
    assert.equal(bad.code, 2); assert.match(bad.err, /tightened modes or created directories may remain/); assert.doesNotMatch(bad.err, /PRIVATE/);
    for (const args of [['prepare-plan', '--json'], ['prepare', '--plan', p.plan!, '--clients-stopped']]) {
      const cli = await bosun(['memory', 'cutover', ...args], { env: f.sb.env({ MEMORY_URL: 'http://127.0.0.1:1' }) });
      assert.equal(cli.code, 1); assert.match(cli.err, /local cutover unavailable \(remote\)/); assert.deepEqual(tree(P.BOSUN), before);
    }
    assert.deepEqual(f.sb.calls(), []);
  } finally { f.close(); }
});

test('real CLI quotes exact reviewed action paths containing spaces and control characters without changing storage', async () => {
  const f = fixture(true);
  try {
    const view = path.join(P.BOSUN, 'view space\nline', 'public.db'); const before = tree(P.BOSUN);
    const result = await bosun(['memory', 'cutover', 'prepare-plan', '--create-view-directory'], { env: f.sb.env({ MEMORY_VIEW_PATH: view }) });
    assert.equal(result.code, 0, result.err);
    assert.ok(result.out.includes(`view-directory: mkdir ${JSON.stringify(path.dirname(view))} (absent -> 0700)`));
    assert.equal(result.out.includes('view space\nline'), false); assert.deepEqual(tree(P.BOSUN), before);
  } finally { f.close(); }
});

test('preparation descriptor/getter/proxy/dependency errors remain finite and malformed inputs inspect no filesystem', () => {
  const f = fixture(true); const p = preparation(f); const before = tree(P.BOSUN); const lstat = fs.lstatSync; let inspected = 0;
  try {
    const getter = Object.defineProperty({}, 'paths', { get() { throw new Error('PRIVATE getter'); } });
    const proxy = new Proxy({}, { ownKeys() { throw new Error('PRIVATE proxy'); } });
    fs.lstatSync = (() => { inspected++; throw new Error('PRIVATE unexpected scan'); }) as typeof fs.lstatSync;
    for (const input of [getter, proxy]) {
      const blocked = planOwnerPreparation(input as never); assert.equal(blocked.state, 'BLOCKED'); assert.doesNotMatch(JSON.stringify(blocked), /PRIVATE/);
      assert.throws(() => prepareOwnerLayout(input as never), (e) => e instanceof OwnerCutoverError && e.blocker.reason === 'input');
    }
    for (const field of ['plan', 'clientsStopped']) {
      const input = Object.defineProperty({}, field, { get() { throw new Error('PRIVATE wrapper getter'); } });
      assert.throws(() => prepareLocalMemoryLayout(f.cfg, input as never), /invalid owner cutover request/);
    }
    assert.throws(() => planLocalMemoryPreparation(f.cfg, proxy), /invalid owner cutover request/);
    assert.equal(inspected, 0);
    const injected = new OwnerCutoverError({ target: 'primary', reason: 'storage' });
    Object.defineProperty(injected, 'blocker', { get() { throw new Error('PRIVATE blocker accessor'); } });
    fs.lstatSync = (() => { throw injected; }) as typeof fs.lstatSync;
    const result = planOwnerPreparation({ paths: f.paths, now: Date.now }); assert.equal(result.state, 'BLOCKED'); assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
    assert.throws(() => prepare(f, p), (e) => e instanceof OwnerCutoverError && !/PRIVATE/.test(e.message));
    fs.lstatSync = (() => { throw new Proxy({}, { getPrototypeOf() { throw new Error('PRIVATE error proxy'); } }); }) as typeof fs.lstatSync;
    assert.doesNotMatch(JSON.stringify(planOwnerPreparation({ paths: f.paths, now: Date.now })), /PRIVATE/);
  } finally { fs.lstatSync = lstat; assert.deepEqual(tree(P.BOSUN), before); f.close(); }
});
