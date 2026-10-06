import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { sandbox, REPO } from './helpers.ts';
import { footprint } from './read-view-prototype.ts';
import { MIGRATIONS, contentHash, plainSession as legacySession, tx as legacyTx } from '../lib/memory/sqlite.ts';
import { MemoryService, FIELDS as legacyFields, PATCH as legacyPatch, cleanTags as legacyCleanTags } from '../lib/memory/service.ts';
import { validate as legacyValidate } from '../lib/util.ts';
import type { Cfg } from '../lib/config.ts';
import { SqliteMemoryStore, type MemoryDependencies, type MemoryMeasurement } from '../src/adapters/memory/sqlite-store.ts';
import { plainSession, tx, type SqliteSession } from '../src/adapters/memory/sqlite-session.ts';
import { queryGet, querySearch } from '../src/adapters/memory/sqlite-query.ts';
import { cutoverMemory, CutoverWriter, CutoverError, publishMemoryView } from '../src/adapters/memory/sqlite-cutover.ts';
import { MemoryError } from '../src/core/errors.ts';
import type { Ctx } from '../src/core/domain/memory.ts';
import type { MemoryStore } from '../src/core/ports/memory.ts';
import { FIELDS, PATCH, cleanTags } from '../src/contracts/memory.ts';
import { validate } from '../src/contracts/schema.ts';

const DAY = 86400000;
const A: Ctx = { projectId: 'p_a', sessionId: 's_a', linked: [], source: 'fixture' };
const B: Ctx = { projectId: 'p_b', sessionId: 's_b', linked: [] };
const code = (value: string) => (e: unknown) => e instanceof MemoryError && e.code === value;
function dependencies() {
  const clock = { value: 1_800_000_000_000, ticks: 0 };
  const metrics: MemoryMeasurement[] = [];
  let sequence = 0;
  const deps: MemoryDependencies = {
    now: () => clock.value, retention: { sessionTtlDays: 3, purgeAfterDays: 5 },
    id: (now) => `m_${now.toString(32).padStart(9, '0')}${(++sequence).toString(16).padStart(8, '0')}`,
    hash: (title, body) => crypto.createHash('sha256').update(`${title}\n${body}`.toLowerCase().replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 32),
    monotonic: () => ++clock.ticks, measure: (metric) => metrics.push(metric),
  };
  return { deps, clock, metrics };
}
async function fixture(registered = false, compatible = false) {
  const sb = sandbox();
  const storage = path.join(sb.root, 'storage');
  const primaryDir = path.join(storage, 'primary'); const viewDir = path.join(storage, 'view'); const backups = path.join(storage, 'backups');
  for (const dir of [storage, primaryDir, viewDir, backups]) fs.mkdirSync(dir, { mode: 0o700 });
  const paths = { primary: path.join(primaryDir, 'memory.db'), view: path.join(viewDir, 'public.db'), backups };
  const db = new DatabaseSync(paths.primary); fs.chmodSync(paths.primary, 0o600);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=0; PRAGMA wal_autocheckpoint=0;');
  db.exec(MIGRATIONS[0]);
  db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL); INSERT INTO schema_migrations VALUES(1,0);');
  if (registered) await cutoverMemory({ paths, now: () => 1_800_000_000_000, id: crypto.randomUUID });
  const session: SqliteSession = registered ? new CutoverWriter(paths) : plainSession(db);
  const d = dependencies();
  const cfg: Cfg = { MEMORY_SESSION_TTL_DAYS: '3', MEMORY_PURGE_AFTER_DAYS: '5' };
  const store = compatible ? new MemoryService(session, cfg) : new SqliteMemoryStore(session, d.deps);
  return { sb, paths, db, session, store, ...d,
    generation() { return registered ? Number(db.prepare('SELECT generation FROM bosun_source_floor').get()!.generation) : 0; },
    state() { return session.read((native) => { const memories = native.prepare('SELECT * FROM memories ORDER BY seq'); memories.setReadBigInts(true); return { memories: memories.all(), events: native.prepare('SELECT * FROM memory_events ORDER BY id').all() }; }); },
    files() { return [footprint(primaryDir), footprint(viewDir), footprint(backups)]; },
    close() { store.close(); if (registered) db.close(); sb.cleanup(); },
  };
}

for (const registered of [false, true]) for (const compatible of [false, true]) test(`MemoryStore acceptance: ${registered ? 'registered' : 'plain'} ${compatible ? 'legacy composition' : 'direct adapter'}`, async () => {
  const f = await fixture(registered, compatible); const s: MemoryStore = f.store;
  try {
    const m = (await s.store({ category: 'project', title: '  Constellation tooling  ', body: ' Use pnpm for constellation tooling. ', tags: ['tools', 'tools'] }, A)).memory;
    assert.match(m.id, /^m_[0-9a-v]{9}[0-9a-f]{8}$/); assert.equal(m.hash, contentHash(m.title, m.body)); assert.deepEqual(m.tags, ['tools']);
    assert.equal((await s.get(m.id, A)).id, m.id);
    const before = f.generation();
    const duplicate = await s.store({ category: 'project', title: m.title.toUpperCase(), body: m.body.toUpperCase(), private: true, shared: true }, A);
    assert.equal(duplicate.duplicate, true); assert.deepEqual(duplicate.memory, m); assert.equal(f.generation(), before);
    await assert.rejects(s.get(m.id, B), code('not_found'));
    await assert.rejects(s.update(m.id, { body: 'conflict' }, 99, A), (e) => code('conflict')(e) && (e as MemoryError).current === 1);
    const shared = await s.update(m.id, { body: 'Revised constellation tooling', shared: true }, 1, A);
    assert.equal(shared.version, 2); assert.notEqual(shared.hash, m.hash); assert.equal((await s.get(m.id, B)).id, m.id);
    await assert.rejects(s.update(m.id, { body: 'foreign edit' }, 2, B), code('invalid'));
    const personal = (await s.store({ category: 'personal', title: 'Constellation personal', body: 'Constellation public personal' }, A)).memory;
    const protectedNote = (await s.store({ category: 'project', title: 'PRIVATE TITLE', body: 'Constellation PRIVATE BODY', tags: ['private-tag'], private: true }, A)).memory;
    assert.equal((await s.get(protectedNote.id, A)).body, protectedNote.body);
    const hits = await s.search({ text: 'constellation', touch: false }, B);
    assert.deepEqual(hits.map((h) => h.id).sort(), [m.id, personal.id].sort()); assert.ok(hits.every((h) => h.matched! >= 1));
    const proposal = (await s.store({ category: 'project', title: 'Proposal', body: 'Proposed fixture', status: 'proposed' }, A)).memory;
    assert.equal((await s.accept(proposal.id, A)).status, 'active');
    const reject = (await s.store({ category: 'project', title: 'Reject', body: 'Rejected fixture', status: 'proposed' }, A)).memory;
    assert.equal((await s.reject(reject.id, A)).status, 'archived');
    await assert.rejects(f.store.purge(m.id, A), code('invalid'));
    const archived = await s.delete(m.id, A); assert.equal(archived.version, 3); assert.equal((await s.delete(m.id, A)).version, 3);
    assert.deepEqual((await s.get(m.id, A, { events: true })).events!.map((e) => e.op), ['store', 'update', 'archive']);
    await f.store.purge(m.id, A); await assert.rejects(s.get(m.id, A), code('not_found'));
    assert.deepEqual(f.session.read((native) => native.prepare('SELECT op FROM memory_events WHERE memory_id=? ORDER BY id').all(m.id)).map((e) => e.op), ['store', 'update', 'archive', 'purge']);
    await assert.rejects(s.store({ category: 'project', title: 'PRIVATE INVALID'.repeat(20), body: 'invalid' }, A), (e) => code('invalid')(e) && !(e as Error).message.includes('PRIVATE INVALID'));
    if (registered) {
      assert.throws(() => f.store.db, code('unavailable')); assert.deepEqual(Object.keys(f.store).filter((k) => k !== 'cfg'), []);
      assert.throws(() => f.db.prepare("UPDATE memories SET private=1 WHERE id=?").run(protectedNote.id), /no such function/);
      assert.throws(() => f.session.read((native) => native), CutoverError);
      assert.throws(() => f.session.transaction(async () => undefined), CutoverError);
    }
  } finally { f.close(); }
});

for (const registered of [false, true]) test(`direct ${registered ? 'registered' : 'plain'} query/projection has unchanged storage footprint, scope/flags and deterministic expiry`, async () => {
  const f = await fixture(registered);
  try {
    const live = (await f.store.store({ category: 'project', title: 'Constellation live', body: 'Constellation live body' }, A)).memory;
    const expired = (await f.store.store({ category: 'session', title: 'Constellation expired', body: 'Constellation expired body', ttlDays: 1 }, A)).memory;
    const malformed: string[] = [];
    for (const flag of ['future', new Uint8Array([48]), 1.5, 9_007_199_254_740_992]) {
      const m = (await f.store.store({ category: 'project', title: `Constellation malformed ${malformed.length}`, body: `Constellation malformed ${malformed.length}` }, A)).memory;
      f.session.transaction((native) => native.prepare('UPDATE memories SET expires_at=?, tags=? WHERE id=?').run(flag, 'MALFORMED-EXPIRY-TAG-PROJECTION-CANARY', m.id)); malformed.push(m.id);
    }
    const protectedNote = (await f.store.store({ category: 'project', title: 'Constellation protected', body: 'PRIVATE BODY', tags: ['private-tag'] }, A)).memory;
    f.session.transaction((native) => native.prepare('UPDATE memories SET private=?, tags=? WHERE id=?').run('false', 'PRIVATE-TAG-PROJECTION-CANARY', protectedNote.id));
    const unshared = (await f.store.store({ category: 'project', title: 'Constellation foreign', body: 'Foreign constellation' }, B)).memory;
    f.session.transaction((native) => native.prepare('UPDATE memories SET shared=? WHERE id=?').run('false', unshared.id));
    const archived = (await f.store.store({ category: 'project', title: 'Constellation archived', body: 'Constellation archived body' }, A)).memory;
    await f.store.delete(archived.id, A);
    f.clock.value = expired.createdAt + DAY;
    const state = f.state(); const generation = f.generation(); const files = f.files();
    for (const q of [{}, { text: 'constellation' }, { text: 'constellation', touch: true }, { text: 'constellation', tags: ['no-match'] }]) {
      const hits = await f.store.search(q, A);
      assert.deepEqual(hits.map((h) => h.id), q.tags ? [] : [live.id]);
    }
    assert.deepEqual((await f.store.search({ text: 'constellation', status: ['archived'] }, A)).map((m) => m.id), [archived.id]);
    assert.equal((await f.store.get(expired.id, A, { events: true })).status, 'active', 'get inspects persisted expiry without manufacturing archive');
    assert.deepEqual((await f.store.get(expired.id, A, { events: true })).events!.map((e) => e.op), ['store']);
    await assert.rejects(f.store.get(unshared.id, A), code('not_found'));
    const queried = f.session.read((native) => querySearch(native, { text: 'constellation' }, A, f.clock.value)); assert.equal(queried[0].id, live.id);
    assert.equal(f.session.read((native) => queryGet(native, expired.id, A)).version, 1);
    assert.deepEqual(f.state(), state); assert.equal(f.generation(), generation); assert.deepEqual(f.files(), files);
  } finally { f.close(); }
});

for (const registered of [false, true]) test(`direct ${registered ? 'registered' : 'plain'} explicit retention/touch/prune uses frozen policy and injected timestamps`, async () => {
  const f = await fixture(registered);
  try {
    Object.assign(f.deps.retention, { sessionTtlDays: 200, purgeAfterDays: 200 });
    const m = (await f.store.store({ category: 'session', title: 'Expiry', body: 'Expiry fixture' }, A)).memory;
    assert.equal(m.expiresAt, m.createdAt + 3 * DAY);
    f.clock.value += 2 * DAY; f.store.touch([m.id]);
    const touched = await f.store.get(m.id, A); assert.equal(touched.accessedAt, f.clock.value); assert.equal(touched.accessCount, 1);
    f.clock.value = m.expiresAt!; assert.equal(f.store.expire(), 1); assert.equal(f.store.expire(), 0);
    const archived = await f.store.get(m.id, A, { events: true }); assert.equal(archived.status, 'archived'); assert.equal(archived.updatedAt, f.clock.value); assert.equal(archived.version, 2);
    assert.deepEqual(archived.events!.map((e) => [e.op, e.at]), [['store', m.createdAt], ['expire', f.clock.value]]);
    f.clock.value += 5 * DAY; assert.deepEqual(f.store.prune(), { archived: 0, purged: 0 }, 'strictly older than cutoff');
    f.clock.value++; assert.deepEqual(f.store.prune(), { archived: 0, purged: 1 });
    const events = f.session.read((native) => native.prepare('SELECT op,at,source FROM memory_events WHERE memory_id=? ORDER BY id').all(m.id));
    assert.deepEqual(events.map((e) => e.op), ['store', 'expire', 'purge']); assert.equal(events.at(-1)!.at, f.clock.value); assert.equal(events.at(-1)!.source, 'retention');
    await assert.rejects(f.store.get(m.id, A), code('not_found'));
  } finally { f.close(); }
});

for (const registered of [false, true]) test(`direct ${registered ? 'registered' : 'plain'} semantic clock/expiry failures leave existing rows/events/generation unchanged`, async () => {
  const f = await fixture(registered);
  try {
    const m = (await f.store.store({ category: 'personal', title: 'Clock fixture', body: 'Clock fixture body' }, A)).memory;
    const archived = (await f.store.store({ category: 'personal', title: 'Archived clock fixture', body: 'Archived clock fixture body' }, A)).memory;
    await f.store.delete(archived.id, A);
    const state = f.state(); const generation = f.generation();
    for (const clock of [NaN, Infinity, -1, 1.5, 8_640_000_000_000_001]) {
      const s = new SqliteMemoryStore(f.session, { ...f.deps, now: () => clock });
      await assert.rejects(s.store({ category: 'project', title: 'Invalid clock', body: 'Invalid clock body' }, A), code('unavailable'));
      await assert.rejects(s.update(m.id, { body: 'Invalid clock edit' }, 1, A), code('unavailable'));
      await assert.rejects(s.delete(m.id, A), code('unavailable'));
      await assert.rejects(s.purge(archived.id, A), code('unavailable'));
      await assert.rejects(s.search({ text: 'clock' }, A), code('unavailable'));
      assert.throws(() => s.touch([m.id]), code('unavailable')); assert.throws(() => s.expire(clock), code('unavailable')); assert.throws(() => s.prune(clock), code('unavailable'));
      assert.deepEqual(f.state(), state); assert.equal(f.generation(), generation);
    }
    const overflowing = new SqliteMemoryStore(f.session, { ...f.deps, now: () => 8_640_000_000_000_000 });
    await assert.rejects(overflowing.store({ category: 'session', title: 'Overflow', body: 'Overflow expiry body', ttlDays: 1 }, A), code('unavailable'));
    assert.deepEqual(f.state(), state); assert.equal(f.generation(), generation);
    let calls = 0;
    const once = new SqliteMemoryStore(f.session, { ...f.deps, now() { if (++calls > 1) throw new Error('second semantic clock'); return 123; } });
    const deleted = await once.delete(m.id, A); assert.equal(deleted.updatedAt, 123); assert.equal(calls, 1);
    assert.equal((await once.get(m.id, A, { events: true })).events!.at(-1)!.at, 123);
    calls = 0; await once.purge(m.id, A); assert.equal(calls, 1);
    assert.equal(f.session.read((native) => native.prepare('SELECT at FROM memory_events WHERE memory_id=? AND op=?').get(m.id, 'purge'))!.at, 123);
  } finally { f.close(); }
});

test('direct registered queries remain usable under a retained view lease while maintenance/mutation is admitted and held', async () => {
  const f = await fixture(true);
  let lease: DatabaseSync | undefined; let current: SqliteMemoryStore | undefined;
  try {
    const m = (await f.store.store({ category: 'personal', title: 'Lease constellation', body: 'Lease constellation body' }, A)).memory;
    const expired = (await f.store.store({ category: 'session', title: 'Held restore', body: 'Held restore session body', ttlDays: 1 }, A)).memory;
    f.clock.value = expired.expiresAt!; f.store.expire();
    await publishMemoryView({ paths: f.paths, now: () => f.clock.value, id: crypto.randomUUID });
    current = new SqliteMemoryStore(new CutoverWriter(f.paths), f.deps);
    lease = new DatabaseSync(f.paths.view, { readOnly: true }); lease.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=0; BEGIN;');
    assert.equal(lease.prepare('SELECT state FROM bosun_public_state').get()!.state, 'READY');
    const state = f.db.prepare('SELECT title,body,version,access_count FROM memories WHERE id=?').get(m.id); const generation = f.generation();
    assert.equal((await current.search({ text: 'constellation', touch: true }, A))[0].id, m.id);
    assert.equal((await current.get(m.id, A)).id, m.id); assert.equal(f.generation(), generation);
    await assert.rejects(current.update(m.id, { private: true }, 1, A), CutoverError);
    await assert.rejects(current.update(expired.id, { status: 'active' }, 2, A), CutoverError);
    assert.equal((await current.get(expired.id, A)).version, 2); assert.equal((await current.get(expired.id, A)).expiresAt, expired.expiresAt);
    assert.equal(lease.prepare('SELECT state FROM bosun_public_state').get()!.state, 'READY');
    assert.deepEqual(f.db.prepare('SELECT title,body,version,access_count FROM memories WHERE id=?').get(m.id), state); assert.equal(f.generation(), generation);
    lease.exec('ROLLBACK'); lease.close(); lease = undefined;
    await assert.rejects(f.store.update(expired.id, { status: 'active' }, 2, A), CutoverError, 'cached pre-publication writer remains fenced for restore');
    const restored = await current.update(expired.id, { status: 'active' }, 2, A); assert.equal(restored.expiresAt, f.clock.value + 3 * DAY); assert.equal(restored.version, 3);
    const gate = new DatabaseSync(f.paths.view, { readOnly: true });
    try { assert.equal(gate.prepare('SELECT state FROM bosun_public_state').get()!.state, 'HOLD'); } finally { gate.close(); }
    assert.equal((await current.update(m.id, { private: true }, 1, A)).version, 2);
  } finally { try { lease?.exec('ROLLBACK'); } catch {} lease?.close(); current?.close(); f.close(); }
});

test('legacy composition retains constructor/read expiry and best-effort touch on an actual SQLite session', async () => {
  const f = await fixture(); const now = Date.now;
  try {
    const m = (await f.store.store({ category: 'session', title: 'Compatibility', body: 'Compatibility fixture', ttlDays: 1 }, A)).memory;
    let failWrites = false;
    const session: SqliteSession = { legacyDb: f.db, read: (fn) => f.session.read(fn), transaction: (fn) => { if (failWrites) throw new Error('busy fixture'); return f.session.transaction(fn); }, close() {} };
    const cfg: Cfg = { MEMORY_SESSION_TTL_DAYS: '3', MEMORY_PURGE_AFTER_DAYS: '5' };
    Date.now = () => m.expiresAt!;
    const legacy = new MemoryService(session, cfg);
    assert.deepEqual((await legacy.get(m.id, A, { events: true })).events!.map((e) => e.op), ['store', 'expire']);
    const live = (await legacy.store({ category: 'project', title: 'Live compatibility', body: 'Live compatibility body' }, A)).memory;
    await legacy.search({ text: '   ' }, A); assert.equal((await legacy.get(live.id, A)).accessCount, 0, 'whitespace lists without FTS touch');
    failWrites = true; assert.equal((await legacy.search({ text: 'compatibility' }, A))[0].id, live.id); assert.equal((await legacy.get(live.id, A)).accessCount, 0);
    failWrites = false; await legacy.search({ text: 'compatibility' }, A); assert.equal((await legacy.get(live.id, A)).accessCount, 1);
    const future = (await legacy.store({ category: 'session', title: 'Future', body: 'Future expiry', ttlDays: 1 }, A)).memory;
    Date.now = () => future.expiresAt!;
    assert.equal((await legacy.get(future.id, A)).status, 'archived');
    assert.deepEqual(await legacy.search({ text: 'future', touch: false }, A), []);
  } finally { Date.now = now; f.close(); }
});

for (const registered of [false, true]) test(`direct ${registered ? 'registered' : 'plain'} post-commit sink/timing failures preserve result, events and generation`, async () => {
  const f = await fixture(registered);
  try {
    // Use a second adapter with the same caller-owned session; no new native open or handle escape.
    let timingCalls = 0; const captured: MemoryMeasurement[] = [];
    const s = new SqliteMemoryStore(f.session, { ...f.deps, monotonic() { if (++timingCalls > 1) throw new Error('PRIVATE TIMING'); return NaN; }, measure(m) { captured.push(m); throw new Error('PRIVATE SINK'); } });
    const before = f.generation();
    const receipt = await s.store({ category: 'personal', title: 'PRIVATE TITLE', body: 'PRIVATE BODY', tags: ['private-tag'], private: true }, A);
    assert.equal(receipt.duplicate, false); assert.equal((await s.get(receipt.memory.id, A)).id, receipt.memory.id);
    assert.equal(f.generation(), before + (registered ? 2 : 0), 'row and audit event are both committed');
    assert.deepEqual(f.state().events.map((e) => e.op), ['store']); assert.equal(f.state().memories[0].hash, receipt.memory.hash);
    assert.equal((await s.store({ category: 'personal', title: 'PRIVATE TITLE', body: 'PRIVATE BODY', private: true }, A)).duplicate, true);
    await assert.rejects(s.update(receipt.memory.id, {}, 99, A), code('conflict'));
    for (const metric of captured) {
      assert.ok(Object.keys(metric).every((k) => ['op', 'ms', 'ok', 'chars', 'n'].includes(k)));
      assert.ok(Number.isFinite(metric.ms) && metric.ms >= 0); assert.equal(metric.ms, 0);
      assert.equal(typeof metric.ok, 'boolean');
    }
    const serialized = JSON.stringify(captured);
    for (const secret of ['PRIVATE', 'private-tag', receipt.memory.id, receipt.memory.hash, 'version conflict']) assert.ok(!serialized.includes(secret), secret);
    assert.equal(captured.at(-1)!.ok, false); assert.equal(captured[0].chars, receipt.memory.body.length);
    if (registered) {
      await publishMemoryView({ paths: f.paths, now: () => f.clock.value, id: crypto.randomUUID });
      const gate = new DatabaseSync(f.paths.view, { readOnly: true });
      try {
        assert.equal(gate.prepare('SELECT state FROM bosun_public_state').get()!.state, 'READY');
        await assert.rejects(s.update(receipt.memory.id, { body: 'PRIVATE stale writer body' }, 1, A), CutoverError);
        const current = new SqliteMemoryStore(new CutoverWriter(f.paths), { ...f.deps, monotonic() { throw new Error('PRIVATE TIMING'); }, measure() { throw new Error('PRIVATE SINK'); } });
        try {
          const updated = await current.update(receipt.memory.id, { body: 'PRIVATE revised body' }, 1, A);
          assert.equal(updated.version, 2); assert.equal((await current.get(updated.id, A, { events: true })).events!.at(-1)!.op, 'update');
          assert.equal(gate.prepare('SELECT state FROM bosun_public_state').get()!.state, 'HOLD');
        } finally { current.close(); }
      } finally { gate.close(); }
    }
  } finally { f.close(); }
});

test('direct dependencies fail before DML, transactions roll back and lifecycle cleanup preserves the original error', async () => {
  const f = await fixture();
  try {
    const empty = f.state();
    for (const patch of [ { now: () => NaN }, { now: () => 8_640_000_000_000_001 }, { now: () => 8_640_000_000_000_000 }, { hash: () => 'PRIVATE BAD HASH' }, { id: () => '' } ]) {
      const s = new SqliteMemoryStore(f.session, { ...f.deps, ...patch });
      await assert.rejects(s.store({ category: 'session', title: 'Dependency', body: 'Dependency body' }, A), MemoryError);
      assert.deepEqual(f.state(), empty);
    }
    for (const name of ['now', 'hash', 'id'] as const) {
      const failure = new Error(`PRIVATE ${name}`);
      const s = new SqliteMemoryStore(f.session, { ...f.deps, [name]: () => { throw failure; } });
      await assert.rejects(s.store({ category: 'personal', title: 'Dependency', body: 'Dependency body' }, A), (e) => e === failure);
      assert.deepEqual(f.state(), empty); assert.equal(f.db.isTransaction, false);
    }
    const failure = new MemoryError('conflict', 'owner fixture conflict', 9);
    assert.throws(() => tx(f.db, () => { f.db.prepare("INSERT INTO memory_events(memory_id,op,at,source) VALUES('rollback','test',0,'fixture')").run(); throw failure; }), (e) => e === failure);
    assert.deepEqual(f.state(), empty); assert.equal(f.db.isTransaction, false);
    let closed = 0;
    const closing: SqliteSession = { ...f.session, close() { closed++; throw new Error('close fixture'); } };
    assert.throws(() => new SqliteMemoryStore(closing, { ...f.deps, retention: { sessionTtlDays: NaN, purgeAfterDays: 5 } }), code('invalid'));
    assert.equal(closed, 1);
    const s = new SqliteMemoryStore(closing, f.deps); assert.throws(() => s.close(), /close fixture/); assert.equal(closed, 2);
    const failingClock = new Error('PRIVATE constructor clock');
    const legacySession: SqliteSession = { ...f.session, close() { closed++; throw new Error('cleanup fixture'); } };
    const prior = Date.now; Date.now = () => { throw failingClock; };
    try { assert.throws(() => new MemoryService(legacySession, { MEMORY_SESSION_TTL_DAYS: '3', MEMORY_PURGE_AFTER_DAYS: '5' }), (e) => e === failingClock); }
    finally { Date.now = prior; }
    assert.equal(closed, 3);
  } finally { f.close(); }
});

test('validation schemas/validator and native session helpers retain exact legacy forwarding identity', () => {
  assert.equal(legacyValidate, validate); assert.equal(legacyFields, FIELDS); assert.equal(legacyPatch, PATCH); assert.equal(legacyCleanTags, cleanTags);
  assert.equal(legacySession, plainSession); assert.equal(legacyTx, tx);
  const cases: [Parameters<typeof validate>[0], unknown, string | null][] = [
    [{ type: 'object', required: ['title'], properties: { title: FIELDS.title }, additionalProperties: false }, {}, '$.title: required'],
    [FIELDS.title, 'PRIVATE'.repeat(40), '$: longer than 200'], [FIELDS.tags, ['PRIVATE tag'], '$[0]: invalid format'],
    [PATCH, { category: 'personal' }, '$.category: unknown field'], [{ type: 'integer' }, Infinity, '$: expected an integer'],
    [PATCH, { title: undefined }, null],
  ];
  for (const [schema, value, error] of cases) assert.equal(validate(schema, value), error);
  assert.deepEqual(cleanTags(['UPPER Space', 'upper space', '', 'a_b']), ['upper-space', 'a-b']);
});

test('direct adapter imports and works under a synthetic HOME with unusable ambient config and no owner filesystem effects', () => {
  const sb = sandbox();
  try {
    const owner = path.join(sb.home, '.bosun'); fs.mkdirSync(owner, { mode: 0o700 });
    fs.writeFileSync(path.join(owner, 'config.env'), 'PRIVATE invalid ambient config', { mode: 0o600 });
    const before = footprint(owner);
    const source = `import {DatabaseSync} from 'node:sqlite';
      import {SqliteMemoryStore} from ${JSON.stringify(path.join(REPO, 'src/adapters/memory/sqlite-store.ts'))};
      import {plainSession} from ${JSON.stringify(path.join(REPO, 'src/adapters/memory/sqlite-session.ts'))};
      const db=new DatabaseSync(':memory:'); db.exec(${JSON.stringify(MIGRATIONS[0])});
      const s=new SqliteMemoryStore(plainSession(db),{now:()=>100,retention:{sessionTtlDays:4,purgeAfterDays:8},id:()=> 'm_fixture',hash:()=> '0'.repeat(32),monotonic:()=>0,measure() {}});
      const ctx={projectId:'p_fixture',sessionId:'s_fixture',linked:[]};
      const m=(await s.store({category:'session',title:'Synthetic',body:'Synthetic body'},ctx)).memory;
      const hits=await s.search({text:'synthetic'},ctx); s.close();
      process.stdout.write(JSON.stringify({expiry:m.expiresAt,ids:hits.map(m=>m.id)}));`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { env: sb.env({ MEMORY_SESSION_TTL_DAYS: 'PRIVATE BAD SETTING', MEMORY_PURGE_AFTER_DAYS: 'PRIVATE BAD SETTING', BOSUN_DIR: owner }), cwd: sb.root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), { expiry: 100 + 4 * DAY, ids: ['m_fixture'] });
    assert.deepEqual(footprint(owner), before); assert.deepEqual(sb.calls(), []);
  } finally { sb.cleanup(); }
});

for (const registered of [false, true]) test(`direct ${registered ? 'registered' : 'plain'} expired session restore renews the current default and survives reopen until the new boundary`, async () => {
  const f = await fixture(registered);
  let reopened: SqliteMemoryStore | undefined;
  try {
    const m = (await f.store.store({ category: 'session', title: 'Restore constellation', body: 'Restore constellation body', ttlDays: 1,
      private: true, shared: true, source: 'owner-source', sourceRef: 'owner-ref', tags: ['restore'] }, A)).memory;
    f.clock.value = m.expiresAt!;
    assert.equal(f.store.expire(), 1);
    const archived = await f.store.get(m.id, A);
    const before = f.generation(); let calls = 0;
    const operation = new SqliteMemoryStore(f.session, { ...f.deps, now() { assert.equal(++calls, 1); return f.clock.value; } });
    const restored = await operation.update(m.id, { status: 'active' }, archived.version, A);
    assert.equal(restored.expiresAt, f.clock.value + 3 * DAY, 'old custom TTL is unavailable; use current configured default');
    assert.equal(restored.updatedAt, f.clock.value); assert.equal(restored.version, 3); assert.equal(calls, 1);
    for (const key of ['id', 'hash', 'createdAt', 'source', 'sourceRef', 'projectId', 'sessionId', 'tags', 'private', 'shared', 'accessedAt', 'accessCount'] as const) assert.deepEqual(restored[key], m[key], key);
    assert.equal(f.generation(), before + (registered ? 2 : 0));
    if (registered) reopened = new SqliteMemoryStore(new CutoverWriter(f.paths), f.deps);
    else reopened = new SqliteMemoryStore(plainSession(new DatabaseSync(f.paths.primary)), f.deps);
    assert.deepEqual(await reopened.get(m.id, A), restored);
    const audited = await reopened.get(m.id, A, { events: true });
    assert.deepEqual(audited.events!.map((e) => [e.op, e.at, e.source, e.hashBefore, e.hashAfter]), [
      ['store', m.createdAt, 'owner-source', null, m.hash], ['expire', f.clock.value, 'retention', m.hash, m.hash], ['restore', f.clock.value, 'fixture', m.hash, m.hash],
    ]);
    f.clock.value = restored.expiresAt! - 1;
    assert.equal(reopened.expire(), 0); assert.equal((await reopened.search({ text: 'constellation', includePrivate: true }, A))[0].id, m.id);
    f.clock.value++;
    assert.equal(reopened.expire(), 1); assert.equal(reopened.expire(), 0);
    const expired = await reopened.get(m.id, A, { events: true });
    assert.equal(expired.version, 4); assert.equal(expired.status, 'archived');
    assert.deepEqual(expired.events!.map((e) => e.op), ['store', 'expire', 'restore', 'expire']);
    assert.equal(expired.events!.at(-1)!.at, restored.expiresAt);
  } finally { reopened?.close(); f.close(); }
});

for (const registered of [false, true]) test(`direct ${registered ? 'registered' : 'plain'} restoration preserves unexpired/normal/non-session deadlines and omitted raw flags`, async () => {
  const f = await fixture(registered);
  try {
    const cases = [
      { category: 'session' as const, archived: true, ttl: 10, status: 'active' as const },
      { category: 'session' as const, archived: true, ttl: 1, status: undefined },
      { category: 'session' as const, archived: false, ttl: 1, status: 'active' as const },
      { category: 'project' as const, archived: true, ttl: 1, status: 'active' as const },
      { category: 'personal' as const, archived: true, ttl: 1, status: 'active' as const },
    ];
    const start = f.clock.value;
    for (const [i, c] of cases.entries()) {
      f.clock.value = start;
      const m = (await f.store.store({ category: c.category, title: `Preserve deadline ${i}`, body: `Preserve deadline body ${i}`, ttlDays: c.ttl }, A)).memory;
      if (c.archived) await f.store.delete(m.id, A);
      f.session.transaction((db) => db.prepare('UPDATE memories SET private=?,shared=? WHERE id=?').run('false', new Uint8Array([49]), m.id));
      const flags = () => f.session.read((db) => db.prepare('SELECT typeof(private) AS ptype,hex(private) AS phex,typeof(shared) AS stype,hex(shared) AS shex FROM memories WHERE id=?').get(m.id));
      const raw = flags();
      f.clock.value = start + 2 * DAY;
      const updated = await f.store.update(m.id, { body: `${m.body} edited`, status: c.status }, c.archived ? 2 : 1, A);
      assert.equal(updated.expiresAt, m.expiresAt, `case ${i}`); assert.deepEqual(flags(), raw); assert.equal(updated.private, true); assert.equal(updated.shared, false);
      assert.notEqual(updated.hash, m.hash); assert.equal(updated.updatedAt, f.clock.value);
    }
    const unbounded = (await f.store.store({ category: 'session', title: 'Unbounded archive', body: 'Unbounded archive body' }, A)).memory;
    await f.store.delete(unbounded.id, A);
    f.session.transaction((db) => db.prepare('UPDATE memories SET expires_at=NULL WHERE id=?').run(unbounded.id));
    assert.equal((await f.store.update(unbounded.id, { status: 'active' }, 2, A)).expiresAt, null);
    const proposal = (await f.store.store({ category: 'session', title: 'Expired proposal', body: 'Expired proposal body', status: 'proposed', ttlDays: 1 }, A)).memory;
    f.clock.value = proposal.expiresAt!;
    assert.equal((await f.store.accept(proposal.id, A)).expiresAt, proposal.expiresAt, 'accepting proposals keeps its existing TTL semantics');
    const malformed = (await f.store.store({ category: 'session', title: 'Malformed flags restore', body: 'Malformed flags restore body', ttlDays: 1 }, A)).memory;
    await f.store.delete(malformed.id, A);
    f.session.transaction((db) => db.prepare('UPDATE memories SET private=?,shared=? WHERE id=?').run(new Uint8Array([48]), 'false', malformed.id));
    const flags = f.session.read((db) => db.prepare('SELECT typeof(private) AS ptype,hex(private) AS phex,typeof(shared) AS stype,hex(shared) AS shex FROM memories WHERE id=?').get(malformed.id));
    f.clock.value = malformed.expiresAt!;
    const restored = await f.store.update(malformed.id, { status: 'active' }, 2, A);
    assert.equal(restored.expiresAt, f.clock.value + 3 * DAY); assert.equal(restored.private, true); assert.equal(restored.shared, false);
    assert.deepEqual(f.session.read((db) => db.prepare('SELECT typeof(private) AS ptype,hex(private) AS phex,typeof(shared) AS stype,hex(shared) AS shex FROM memories WHERE id=?').get(malformed.id)), flags);
  } finally { f.close(); }
});

for (const registered of [false, true]) test(`direct ${registered ? 'registered' : 'plain'} zero session TTL disables expiry for creation and explicit expired restore`, async () => {
  const f = await fixture(registered); let reopened: SqliteMemoryStore | undefined;
  try {
    const m = (await f.store.store({ category: 'session', title: 'Disable expiry', body: 'Disable expiry restore', ttlDays: 1 }, A)).memory;
    await f.store.delete(m.id, A);
    f.clock.value = m.expiresAt!;
    const zero = new SqliteMemoryStore(f.session, { ...f.deps, retention: { sessionTtlDays: 0, purgeAfterDays: 5 } });
    const restored = await zero.update(m.id, { status: 'active' }, 2, A); assert.equal(restored.expiresAt, null);
    f.clock.value = 8_640_000_000_000_000;
    const created = (await zero.store({ category: 'session', title: 'No expiry', body: 'No expiry creation' }, A)).memory; assert.equal(created.expiresAt, null);
    assert.equal(zero.expire(), 0); assert.equal((await zero.get(m.id, A)).status, 'active');
    reopened = new SqliteMemoryStore(registered ? new CutoverWriter(f.paths) : plainSession(new DatabaseSync(f.paths.primary)), f.deps);
    assert.equal((await reopened.get(m.id, A)).expiresAt, null); assert.equal(reopened.expire(), 0);
  } finally { reopened?.close(); f.close(); }
});

for (const registered of [false, true]) test(`direct ${registered ? 'registered' : 'plain'} restore clock/overflow/conflict/invalid expiry failures precede DML with atomic expectations`, async () => {
  const f = await fixture(registered);
  try {
    const m = (await f.store.store({ category: 'session', title: 'Restore failure', body: 'Restore failure body', ttlDays: 1 }, A)).memory;
    f.clock.value = m.expiresAt!; f.store.expire();
    let dml = 0;
    const observed: SqliteSession = { read: (fn) => f.session.read(fn), close() {}, transaction: (fn) => f.session.transaction((db) => {
      const prepare = db.prepare;
      db.prepare = function (sql) { if (/^(UPDATE memories|INSERT INTO memory_events)/.test(sql)) dml++; return prepare.call(this, sql); };
      try { return fn(db); } finally { db.prepare = prepare; }
    }) };
    const state = f.state(); const generation = f.generation();
    for (const value of [NaN, Infinity, -1, 0.5, 8_640_000_000_000_001, 8_640_000_000_000_000]) {
      const bad = new SqliteMemoryStore(observed, { ...f.deps, now: () => value });
      await assert.rejects(bad.update(m.id, { status: 'active' }, 2, A), code('unavailable'));
      assert.equal(dml, 0); assert.deepEqual(f.state(), state); assert.equal(f.generation(), generation);
    }
    let ticks = 0;
    const atomic = new SqliteMemoryStore(observed, { ...f.deps, now() { ticks++; throw Error('must not sample on refused row/version'); } });
    await f.store.update(m.id, { body: 'Committed archived edit' }, 2, A);
    const current = f.state(); const currentGeneration = f.generation();
    await assert.rejects(atomic.update(m.id, { status: 'active' }, 2, A), (e) => code('conflict')(e) && (e as MemoryError).current === 3);
    await assert.rejects(atomic.update(m.id, { status: 'active' }, 3, B), code('not_found'));
    assert.equal(ticks, 0); assert.equal(dml, 0); assert.deepEqual(f.state(), current); assert.equal(f.generation(), currentGeneration);
    await f.store.store({ category: 'session', title: m.title, body: 'Committed archived edit' }, A);
    const duplicate = f.state(); const duplicateGeneration = f.generation();
    await assert.rejects(atomic.update(m.id, { status: 'active' }, 3, A), code('conflict'));
    assert.equal(ticks, 0); assert.equal(dml, 0); assert.deepEqual(f.state(), duplicate); assert.equal(f.generation(), duplicateGeneration);
    let version = 3;
    for (const value of ['invalid-expiry', new Uint8Array([49]), 0.5, -1, 8_640_000_000_000_001]) {
      f.session.transaction((db) => db.prepare('UPDATE memories SET expires_at=? WHERE id=?').run(value, m.id));
      const stored = f.state(); const g = f.generation();
      const safe = new SqliteMemoryStore(observed, f.deps);
      await assert.rejects(safe.update(m.id, { status: 'active', body: 'Distinct restored body' }, version, A), code('unavailable'));
      assert.equal(dml, 0); assert.deepEqual(f.state(), stored); assert.equal(f.generation(), g);
      const edited = await f.store.update(m.id, { title: 'Ordinary archived edit' }, version, A); assert.equal(edited.version, ++version);
    }
  } finally { f.close(); }
});
