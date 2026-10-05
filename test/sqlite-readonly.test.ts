import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { sandbox, fresh, bosun, gitRepo, mock, type Sandbox } from './helpers.ts';
import { openDb } from '../lib/memory/sqlite.ts';
import { MemoryService } from '../lib/memory/service.ts';
import { load, P } from '../lib/config.ts';
import { makeCtx, project } from '../lib/memory/project.ts';
import { curated, retrieve } from '../lib/context.ts';
import { MemoryError, type Ctx } from '../lib/memory/types.ts';
import { SqliteReadOnly } from '../src/adapters/memory/sqlite-readonly.ts';

function footprint(dir: string): Record<string, object> {
  const directory = fs.statSync(dir, { bigint: true });
  return { '.': { mode: String(directory.mode), mtime: String(directory.mtimeNs), ctime: String(directory.ctimeNs) }, ...Object.fromEntries(fs.readdirSync(dir).sort().map((name) => {
    const file = path.join(dir, name);
    const s = fs.statSync(file, { bigint: true });
    return [name, { bytes: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
      size: String(s.size), mode: String(s.mode), mtime: String(s.mtimeNs), ctime: String(s.ctimeNs) }];
  })) };
}
function probe(file: string, sql = '') {
  const dir = path.dirname(file);
  const before = footprint(dir);
  let db: DatabaseSync | undefined;
  let outcome = 'read';
  let during: ReturnType<typeof footprint>;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    db.exec(`PRAGMA query_only=ON; PRAGMA temp_store=MEMORY; PRAGMA busy_timeout=0; ${sql}`);
    db.prepare('SELECT COUNT(*) AS n FROM memories').get();
    during = footprint(dir);
  } catch {
    outcome = 'unavailable'; during = footprint(dir);
  } finally { db?.close(); }
  const after = footprint(dir);
  return { outcome, changedDuring: JSON.stringify(before) !== JSON.stringify(during), changedAfter: JSON.stringify(before) !== JSON.stringify(after),
    before: Object.keys(before), during: Object.keys(during), after: Object.keys(after) };
}

test('qualification: native readOnly SQLite filesystem effects on current closed/open WAL and invalid/locked fixtures', () => {
  const sb = sandbox();
  try {
    fresh(sb);
    const results: Record<string, ReturnType<typeof probe>> = {};
    for (const exclusive of [false, true]) {
      for (const live of [false, true]) {
        const dir = path.join(sb.root, `wal-${exclusive}-${live}`); fs.mkdirSync(dir);
        const file = path.join(dir, 'memory.db');
        const writer = openDb(file);
        writer.prepare("INSERT INTO memories(id,category,title,body,source,hash,created_at,updated_at) VALUES ('m_fixture','personal','Public','Fixture','fixture','fixed',1,1)").run();
        if (!live) writer.close();
        results[`WAL-${exclusive ? 'exclusive' : 'default'}-${live ? 'live' : 'closed'}`] = probe(file, exclusive ? 'PRAGMA locking_mode=EXCLUSIVE;' : '');
        if (live) writer.close();
      }
    }
    for (const kind of ['missing', 'corrupt', 'schema-skew', 'locked']) {
      const dir = path.join(sb.root, kind); fs.mkdirSync(dir);
      const file = path.join(dir, 'memory.db');
      let writer: DatabaseSync | undefined;
      if (kind === 'corrupt') fs.writeFileSync(file, 'not SQLite');
      if (kind === 'schema-skew') { writer = new DatabaseSync(file); writer.exec('CREATE TABLE unrelated(x)'); writer.close(); writer = undefined; }
      if (kind === 'locked') { writer = new DatabaseSync(file); writer.exec('CREATE TABLE memories(x); BEGIN EXCLUSIVE'); }
      results[kind] = probe(file);
      writer?.close();
    }
    for (const live of [false, true]) {
      const dir = path.join(sb.root, `rollback-${live}`); fs.mkdirSync(dir);
      const file = path.join(dir, 'memory.db');
      const writer = openDb(file);
      writer.exec('PRAGMA journal_mode=DELETE'); // synthetic setup by the writer, never a reader operation
      if (!live) writer.close();
      results[`rollback-${live ? 'live' : 'closed'}`] = probe(file, 'PRAGMA locking_mode=EXCLUSIVE;');
      if (live) writer.close();
    }
    console.log('SQLite read-only qualification:', JSON.stringify(results));
    assert.equal(results.missing.outcome, 'unavailable');
    assert.equal(results.missing.changedAfter, false);
    assert.equal(results.corrupt.changedAfter, false);
    assert.equal(results['schema-skew'].changedAfter, false);
    assert.equal(results.locked.changedAfter, false);
    for (const state of ['closed', 'live']) {
      assert.equal(results[`WAL-default-${state}`].changedDuring, true);
      assert.equal(results[`WAL-exclusive-${state}`].outcome, 'unavailable');
      assert.equal(results[`WAL-exclusive-${state}`].changedDuring, false);
      assert.equal(results[`WAL-exclusive-${state}`].changedAfter, false);
      assert.equal(results[`rollback-${state}`].outcome, 'read');
      assert.equal(results[`rollback-${state}`].changedDuring, false);
      assert.equal(results[`rollback-${state}`].changedAfter, false);
    }
  } finally { sb.cleanup(); }
});

const NOW = Date.UTC(2026, 9, 5);
const A: Ctx = { projectId: 'p_a', sessionId: null, linked: [] };
const B: Ctx = { projectId: 'p_b', sessionId: null, linked: [] };
const PRIVATE = 'PRIVATE-READONLY-CANARY';
const errorCode = (code: string) => (e: unknown) => e instanceof MemoryError && e.code === code && !e.message.includes(PRIVATE);
async function fixture(sb: Sandbox, { rollback = true, keepOpen = false } = {}) {
  fresh(sb);
  const dir = path.join(sb.root, 'fixture'); fs.mkdirSync(dir);
  const file = path.join(dir, 'memory.db');
  const writer = new MemoryService(openDb(file), load());
  const records = {
    own: (await writer.store({ category: 'project', title: 'Cart naming', body: 'rename getCart to fetchCart in cart service', tags: ['cart'] }, A)).memory,
    personal: (await writer.store({ category: 'personal', title: 'Personal cart style', body: 'rename the cart with clear naming' }, A)).memory,
    foreign: (await writer.store({ category: 'project', title: 'Foreign cart', body: 'rename cart elsewhere' }, B)).memory,
    shared: (await writer.store({ category: 'project', title: 'Shared cart', body: 'rename shared cart', shared: true }, B)).memory,
    private: (await writer.store({ category: 'project', title: `${PRIVATE} title`, body: `${PRIVATE} cart rename`, tags: ['private-readonly-canary'], private: true,
      source: `${PRIVATE} source`, sourceRef: `${PRIVATE} ref` }, A)).memory,
    malformed: (await writer.store({ category: 'project', title: `${PRIVATE} unknown`, body: `${PRIVATE} cart rename unknown` }, A)).memory,
    expired: (await writer.store({ category: 'session', title: 'Expired cart', body: 'rename expired cart' }, A)).memory,
    proposed: (await writer.store({ category: 'project', title: 'Proposed cart', body: 'rename proposed cart', status: 'proposed' }, A)).memory,
    archived: (await writer.store({ category: 'project', title: 'Archived cart', body: 'rename archived cart' }, A)).memory,
  };
  writer.db.prepare("UPDATE memories SET private='false' WHERE id=?").run(records.malformed.id);
  writer.db.prepare('UPDATE memories SET expires_at=? WHERE id=?').run(NOW - 1, records.expired.id);
  await writer.delete(records.archived.id, A);
  if (rollback) writer.db.exec('PRAGMA journal_mode=DELETE'); // administrative synthetic setup, never the reader
  const logical = () => ({ memories: writer.db.prepare('SELECT * FROM memories ORDER BY seq').all(), events: writer.db.prepare('SELECT * FROM memory_events ORDER BY id').all() });
  const before = logical();
  if (!keepOpen) writer.close();
  return { dir, file, writer, records, before, logical };
}

test('read-only rollback acceptance: constructor/search/get/close preserve every byte, file timestamp/mode and stored ID; audit requests are denied', async () => {
  const sb = sandbox();
  try {
    const f = await fixture(sb, { keepOpen: true });
    fs.chmodSync(f.file, 0o640); // prove the reader does not enforce the writer's 0600 mode
    const before = footprint(f.dir);
    const telemetryBefore = footprint(P.BOSUN);
    const reader = new SqliteReadOnly(f.file, () => NOW);
    try {
      assert.deepEqual(footprint(f.dir), before, 'while constructor is open');
      const hits = await reader.search({ text: 'cart rename', tags: ['cart'], limit: 20 }, A);
      assert.deepEqual(hits.map((h) => h.id), [f.records.own.id]);
      assert.ok(hits[0].matched! >= 2);
      assert.ok(hits[0].rank < 0);
      await assert.rejects(reader.get(f.records.own.id, A, { events: true }), errorCode('invalid'));
      const read = await reader.get(f.records.own.id, A);
      assert.deepEqual(read, f.records.own);
      assert.deepEqual(f.logical(), f.before, 'no expiry/access/version/events mutation');
      assert.deepEqual(footprint(f.dir), before, 'while queries are open');
    } finally { reader.close(); reader.close(); }
    assert.deepEqual(footprint(f.dir), before, 'including close housekeeping');
    assert.deepEqual(f.logical(), f.before);
    assert.deepEqual(footprint(P.BOSUN), telemetryBefore, 'the reader writes no logs/metrics/config');
    f.writer.close();
  } finally { sb.cleanup(); }
});

test('read-only visibility: personal/own/shared/linked only; private/malformed/proposed/archived/expired excluded in SQL without archive events', async () => {
  const sb = sandbox();
  try {
    const f = await fixture(sb);
    const before = footprint(f.dir);
    const reader = new SqliteReadOnly(f.file, () => NOW);
    try {
      const hits = await reader.search({ text: 'cart rename' }, A);
      assert.deepEqual(hits.map((h) => h.id).sort(), [f.records.own.id, f.records.personal.id, f.records.shared.id].sort());
      assert.doesNotMatch(JSON.stringify(hits), /PRIVATE-READONLY|Expired|Proposed|Archived|Foreign/);
      const linked = await reader.search({ text: 'cart rename' }, { ...A, linked: ['p_b'] });
      assert.ok(linked.some((h) => h.id === f.records.foreign.id));
      for (const name of ['private', 'malformed', 'expired', 'proposed', 'archived', 'foreign'] as const) await assert.rejects(reader.get(f.records[name].id, A), errorCode('not_found'));
      assert.deepEqual(await reader.search({ text: 'the of a' }, A), []);
      const packed = await retrieve('cart rename', [curated(reader)], A, { budgetTokens: 400, minScore: 0, itemChars: 400, minMatched: 2 });
      assert.ok(packed.items.length > 0);
      assert.doesNotMatch(JSON.stringify(packed), /PRIVATE-READONLY|Expired|Proposed|Archived|Foreign/);
    } finally { reader.close(); }
    assert.deepEqual(footprint(f.dir), before);
    const owner = new SqliteReadOnly(f.file, () => NOW - 2);
    try { assert.equal((await owner.get(f.records.expired.id, A)).status, 'active', 'expiry was filtered, never archived'); }
    finally { owner.close(); }
    assert.deepEqual(footprint(f.dir), before);
  } finally { sb.cleanup(); }
});

test('read-only bounds and escaped query text use finite diagnostics with zero file changes', async () => {
  const sb = sandbox();
  try {
    const f = await fixture(sb);
    const before = footprint(f.dir);
    const reader = new SqliteReadOnly(f.file, () => NOW);
    try {
      for (const query of [{ limit: 0 }, { limit: 51 }, { text: 'x'.repeat(20001) }, { includePrivate: true }, { touch: true }, { status: ['archived'] }, { tags: ['x; DROP TABLE memories'] }]) {
        await assert.rejects(reader.search(query as never, A), errorCode('invalid'));
      }
      await assert.rejects(reader.search({}, { ...A, linked: Array(51).fill('p_b') }), errorCode('invalid'));
      await assert.rejects(reader.get('', A), errorCode('invalid'));
      for (const query of ['cart" OR "rename', 'cart); DROP TABLE memories; --', 'NEAR(cart rename)', '* : ^']) await reader.search({ text: query }, A);
      assert.equal((await reader.get(f.records.own.id, A)).id, f.records.own.id);
    } finally { reader.close(); }
    await assert.rejects(reader.get(f.records.own.id, A), errorCode('unavailable'));
    assert.deepEqual(footprint(f.dir), before);
  } finally { sb.cleanup(); }
});

test('unchanged default writer WAL is explicitly held closed/live without any sidecar/expiry/access effects', async () => {
  for (const keepOpen of [false, true]) {
    const sb = sandbox();
    try {
      const f = await fixture(sb, { rollback: false, keepOpen });
      const before = footprint(f.dir);
      assert.throws(() => new SqliteReadOnly(f.file, () => NOW), (e) => errorCode('unavailable')(e) && (e as Error).message.endsWith('(wal_requires_writes)'));
      assert.deepEqual(footprint(f.dir), before);
      if (keepOpen) { assert.deepEqual(f.logical(), f.before); f.writer.close(); }
    } finally { sb.cleanup(); }
  }
});

test('missing/corrupt/schema-skew/locked/pending-journal/URI/symlink cases never create, migrate or repair files', async () => {
  const sb = sandbox();
  try {
    fresh(sb);
    const empty = path.join(sb.root, 'empty'); fs.mkdirSync(empty);
    const beforeEmpty = footprint(empty);
    assert.throws(() => new SqliteReadOnly(path.join(empty, 'missing.db'), () => NOW), errorCode('unavailable'));
    assert.deepEqual(footprint(empty), beforeEmpty);
    const corrupt = path.join(empty, 'corrupt.db'); fs.writeFileSync(corrupt, PRIVATE.repeat(10));
    const beforeCorrupt = footprint(empty);
    assert.throws(() => new SqliteReadOnly(corrupt, () => NOW), errorCode('unavailable'));
    assert.deepEqual(footprint(empty), beforeCorrupt);
    const f = await fixture(sb, { keepOpen: true });
    for (const versions of [[2], []]) {
      f.writer.db.exec('DELETE FROM schema_migrations');
      for (const version of versions) f.writer.db.prepare('INSERT INTO schema_migrations VALUES (?,1)').run(version);
      const before = footprint(f.dir);
      assert.throws(() => new SqliteReadOnly(f.file, () => NOW), errorCode('unavailable'));
      assert.deepEqual(footprint(f.dir), before);
    }
    f.writer.db.exec('INSERT INTO schema_migrations VALUES (1,1); BEGIN EXCLUSIVE');
    let before = footprint(f.dir);
    assert.throws(() => new SqliteReadOnly(f.file, () => NOW), errorCode('unavailable'));
    assert.deepEqual(footprint(f.dir), before);
    f.writer.db.exec('ROLLBACK'); f.writer.close();
    fs.writeFileSync(f.file + '-journal', PRIVATE);
    before = footprint(f.dir);
    assert.throws(() => new SqliteReadOnly(f.file, () => NOW), errorCode('unavailable'));
    assert.deepEqual(footprint(f.dir), before);
    fs.rmSync(f.file + '-journal');
    fs.symlinkSync(f.file, path.join(empty, 'alias.db'));
    const beforePaths = footprint(f.dir);
    for (const candidate of ['file:' + f.file + '?mode=ro&immutable=1', 'relative.db', path.join(empty, 'alias.db')]) assert.throws(() => new SqliteReadOnly(candidate, () => NOW), errorCode('unavailable'));
    assert.deepEqual(footprint(f.dir), beforePaths);
    assert.deepEqual(fs.readdirSync(f.dir), ['memory.db']);
  } finally { sb.cleanup(); }
});

test('read-only reader checks injected deadlines and safely holds corrupt required schemas without writes', async () => {
  const sb = sandbox();
  try {
    const f = await fixture(sb, { keepOpen: true });
    let before = footprint(f.dir);
    let ticks = 0;
    assert.throws(() => new SqliteReadOnly(f.file, () => NOW + ticks++ * 251), errorCode('unavailable'));
    assert.deepEqual(footprint(f.dir), before);
    assert.throws(() => new SqliteReadOnly(f.file, () => { throw Error(PRIVATE); }), errorCode('invalid'));
    f.writer.db.exec('ALTER TABLE memories ADD COLUMN incompatible TEXT');
    before = footprint(f.dir);
    assert.throws(() => new SqliteReadOnly(f.file, () => NOW), errorCode('unavailable'));
    assert.deepEqual(footprint(f.dir), before);
    f.writer.close();
  } finally { sb.cleanup(); }
});

test('read-only DTOs reject malformed numeric/nullable metadata and never expose earlier private audit history', async () => {
  const sb = sandbox();
  try {
    const f = await fixture(sb, { keepOpen: true });
    const update = (field: string, value: string | number | null) => f.writer.db.prepare(`UPDATE memories SET ${field}=? WHERE id=?`).run(value, f.records.own.id);
    for (const [field, value] of [['updated_at', PRIVATE], ['version', PRIVATE], ['accessed_at', PRIVATE], ['shared', PRIVATE]] as const) {
      update(field, value);
      const before = footprint(f.dir);
      const reader = new SqliteReadOnly(f.file, () => NOW);
      try { await assert.rejects(reader.get(f.records.own.id, A), errorCode('unavailable')); }
      finally { reader.close(); }
      assert.deepEqual(footprint(f.dir), before);
      update(field, field === 'updated_at' ? f.records.own.updatedAt : field === 'accessed_at' ? null : field === 'version' ? 1 : 0);
    }
    f.writer.db.prepare("INSERT INTO memory_events(memory_id,op,at,source,hash_before,hash_after) VALUES(?,'update',1,?,?,?)").run(f.records.own.id, PRIVATE, PRIVATE, PRIVATE);
    const before = footprint(f.dir);
    const reader = new SqliteReadOnly(f.file, () => NOW);
    try {
      assert.doesNotMatch(JSON.stringify(await reader.get(f.records.own.id, A)), /PRIVATE-READONLY/);
      await assert.rejects(reader.get(f.records.own.id, A, { events: true }), errorCode('invalid'));
    } finally { reader.close(); }
    assert.deepEqual(footprint(f.dir), before);
    f.writer.close();
  } finally { sb.cleanup(); }
});

test('read-only bounds cover oversized files and an unused synthetic foreign virtual-table definition without loading an extension', async () => {
  const sb = sandbox();
  try {
    const f = await fixture(sb, { keepOpen: true });
    f.writer.db.enableDefensive(false); // administrative fixture construction only; reader keeps native defenses enabled
    f.writer.db.exec(`PRAGMA writable_schema=ON;
      INSERT INTO sqlite_schema(type,name,tbl_name,rootpage,sql) VALUES('table','optional_vectors','optional_vectors',0,'CREATE VIRTUAL TABLE optional_vectors USING vec0(embedding float[3])');
      PRAGMA writable_schema=OFF;`); // synthetic schema only; no sqlite-vec installation or genuine-module compatibility claim
    f.writer.close();
    const before = footprint(f.dir);
    const reader = new SqliteReadOnly(f.file, () => NOW);
    try { assert.equal((await reader.get(f.records.own.id, A)).id, f.records.own.id); }
    finally { reader.close(); }
    assert.deepEqual(footprint(f.dir), before);
    const big = path.join(f.dir, 'big.db');
    const fd = fs.openSync(big, 'w'); fs.ftruncateSync(fd, 16 * 1024 * 1024 + 1); fs.closeSync(fd);
    const beforeBig = footprint(f.dir);
    assert.throws(() => new SqliteReadOnly(big, () => NOW), errorCode('unavailable'));
    assert.deepEqual(footprint(f.dir), beforeBig);
  } finally { sb.cleanup(); }
});

test('real local hook reads explicitly prepared rollback public notes with unchanged database footprint; telemetry stays outside reader', async () => {
  const sb = sandbox();
  const router = await mock();
  try {
    fresh(sb);
    const repo = gitRepo(sb, 'shop');
    const ctx = makeCtx(load(), project(repo));
    const writer = new MemoryService(openDb(P.DB), load());
    const m = (await writer.store({ category: 'project', title: 'Cart naming', body: 'rename getCart to fetchCart in cart service' }, ctx)).memory;
    await writer.store({ category: 'project', title: PRIVATE, body: `${PRIVATE} rename getCart cart`, private: true }, ctx);
    writer.db.exec('PRAGMA journal_mode=DELETE'); writer.close(); // explicitly qualified fixture
    const dir = path.dirname(P.DB);
    const dbFiles = () => Object.fromEntries(Object.entries(footprint(dir)).filter(([name]) => name.startsWith('memory.db')));
    const before = dbFiles();
    const run = await bosun(['route', '--hook'], { env: sb.env({ ROUTER_URL: router.url }), cwd: repo, input: JSON.stringify({ prompt: 'rename getCart to fetchCart in cart service' }) });
    assert.equal(run.code, 0);
    const output = JSON.parse(run.out).hookSpecificOutput.additionalContext;
    assert.match(output, /Cart naming/); assert.ok(output.includes(m.id)); assert.match(output, /suggests: local/);
    assert.doesNotMatch(output, /PRIVATE-READONLY/);
    assert.doesNotMatch(JSON.stringify(router.requests), /PRIVATE-READONLY/);
    assert.deepEqual(dbFiles(), before);
    assert.ok(fs.existsSync(path.join(P.BOSUN, 'metrics.jsonl')), 'legacy hook/context telemetry is outside the zero-write reader');
    const requests = router.requests.length;
    const privateRun = await bosun(['route', '--hook', '--private'], { env: sb.env({ ROUTER_URL: router.url }), cwd: repo, input: JSON.stringify({ prompt: PRIVATE }) });
    assert.equal(privateRun.out, ''); assert.equal(router.requests.length, requests);
    assert.deepEqual(dbFiles(), before);
  } finally { await router.close(); sb.cleanup(); }
});

test('real hook holds unchanged default WAL and corrupt local memory fail-open while preserving router advice', async () => {
  const sb = sandbox();
  const router = await mock();
  try {
    fresh(sb);
    const repo = gitRepo(sb, 'shop');
    const writer = new MemoryService(openDb(P.DB), load());
    await writer.store({ category: 'project', title: 'WAL public cart', body: 'rename getCart to fetchCart in cart service' }, makeCtx(load(), project(repo)));
    writer.close(); // unchanged default WAL, no fixture conversion
    const dir = path.dirname(P.DB);
    const dbFiles = () => Object.fromEntries(Object.entries(footprint(dir)).filter(([name]) => name.startsWith('memory.db')));
    for (const corrupt of [false, true]) {
      if (corrupt) fs.writeFileSync(P.DB, PRIVATE.repeat(20));
      const before = dbFiles();
      const run = await bosun(['route', '--hook'], { env: sb.env({ ROUTER_URL: router.url }), cwd: repo, input: JSON.stringify({ prompt: 'rename getCart to fetchCart in cart service' }) });
      assert.equal(run.code, 0);
      const output = JSON.parse(run.out).hookSpecificOutput.additionalContext;
      assert.match(output, /suggests: local/); assert.doesNotMatch(output, /bosun memory|WAL public cart|PRIVATE-READONLY/);
      assert.deepEqual(dbFiles(), before);
    }
  } finally { await router.close(); sb.cleanup(); }
});
