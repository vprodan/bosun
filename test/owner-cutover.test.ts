import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { sandbox, fresh, bosun } from './helpers.ts';
import { P, load } from '../lib/config.ts';
import { openDb, writerPaths, contentHash, applyLocalMemoryCutover } from '../lib/memory/sqlite.ts';
import { planOwnerCutover, applyOwnerCutover, OwnerCutoverError } from '../src/adapters/memory/sqlite-owner.ts';
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
