import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SqliteDatabase } from '../src/platform/sqlite.ts';
import { sandbox, fresh, gitRepo } from './helpers.ts';
import { footprint } from './read-view-prototype.ts';
import { openDaemonJobs } from '../src/app/jobs.ts';
import { openDaemonMemory, type DaemonMemoryOptions } from '../src/app/memory.ts';
import { initializeMemory } from '../src/adapters/memory/sqlite-initialize.ts';
import { MEMORY_MIGRATIONS } from '../src/adapters/memory/sqlite-schema.ts';
import { cutoverMemory, publishMemoryView } from '../src/adapters/memory/sqlite-cutover.ts';
import { createCuratedSource } from '../src/core/memory-source.ts';
import { contentHash } from '../src/platform/content-hash.ts';
import { BosunError, MemoryError } from '../src/core/errors.ts';
import type { Ctx } from '../src/core/domain/memory.ts';

const A: Ctx = { projectId: 'p_a', sessionId: 's_a', linked: [] };
const B: Ctx = { projectId: 'p_b', sessionId: 's_b', linked: [] };
const DAY = 86400000;
const unavailable = (e: unknown) => e instanceof BosunError && e.code === 'unavailable' || e instanceof MemoryError && e.code === 'unavailable';
const unknown = (e: unknown) => e instanceof BosunError && e.details?.outcome === 'unknown' && e.message === 'Daemon memory unavailable';
async function fixture({ publish = true, legacySecret = false }: { publish?: boolean; legacySecret?: boolean } = {}) {
  const sb = sandbox(); fresh(sb, { MEMORY_URL: 'https://unusable.invalid', MEMORY_SESSION_TTL_DAYS: 'unusable', MEMORY_PURGE_AFTER_DAYS: 'unusable' });
  const repo = gitRepo(sb, 'repo');
  const root = path.join(sb.root, 'storage'); const primaryDir = path.join(root, 'primary'); const viewDir = path.join(root, 'view'); const backups = path.join(root, 'backups');
  for (const dir of [root, primaryDir, viewDir, backups]) fs.mkdirSync(dir, { mode: 0o700 });
  const paths = { primary: path.join(primaryDir, 'memory.db'), view: path.join(viewDir, 'public.db'), backups };
  const jobs = openDaemonJobs({ stateFile: path.join(root, 'state.db'), ownerFile: path.join(root, 'owner.db'), runners: {}, admit: async () => ({ allowed: false, reason: 'approval' }) }); jobs.recover();
  const clock = { value: 1_800_000_000_000 }; let ids = 0; const measures: object[] = [];
  const options: DaemonMemoryOptions = { paths, assertOwner: jobs.assertOwner,
    memory: { now: () => clock.value, retention: { sessionTtlDays: 3, purgeAfterDays: 5 },
      id: (now) => `m_${now.toString(32).padStart(9, '0')}${(++ids).toString(16).padStart(8, '0')}`, hash: contentHash,
      monotonic: () => 1, measure: (value) => measures.push(value) },
    context: { now: () => clock.value, monotonic: () => 1, hash: contentHash, dateLabel: (at) => new Date(at).toISOString().slice(0, 10), measure: (value) => measures.push(value) },
    docsIndex: { monotonic: () => 1, measure: (value) => measures.push(value) }, publicationId: crypto.randomUUID,
  };
  assert.deepEqual(initializeMemory({ file: paths.primary, assertOwner: jobs.assertOwner, now: options.memory.now }), { schema: 2 });
  if (legacySecret) {
    const legacy = new SqliteDatabase(paths.primary);
    try { legacy.prepare(`INSERT INTO memories(id,category,project_id,title,body,tags,status,shared,private,source,hash,created_at,updated_at)
      VALUES(?,?,?,?,?,?,'active',0,0,'legacy',?,?,?)`).run('m_00000000100000001', 'project', 'p_a', 'Zebra credentials', 'api_key=' + 'x'.repeat(40), '[]',
        contentHash('Zebra credentials', 'api_key=' + 'x'.repeat(40)), clock.value, clock.value); }
    finally { legacy.close(); }
  }
  await cutoverMemory({ paths, now: options.memory.now, id: crypto.randomUUID });
  if (publish) await publishMemoryView({ paths, now: options.memory.now, id: crypto.randomUUID });
  const runtime = openDaemonMemory(options); const observer = new SqliteDatabase(paths.primary, { readOnly: true });
  return { sb, repo, root, primaryDir, viewDir, backups, paths, jobs, options, clock, measures, runtime, observer,
    generation() { return observer.prepare('SELECT generation FROM bosun_source_floor').get()!.generation; },
    files() { return [footprint(primaryDir), footprint(viewDir), footprint(backups)]; },
    async close() { await runtime.close(); observer.close(); await jobs.close(); sb.cleanup(); },
  };
}

test('new secret ingress is rejected before FTS; existing credential rows keep owner IDs/flags but never enter model packs or the public view', async () => {
  const f = await fixture({ legacySecret: true }); const secret = 'api_key=' + 'x'.repeat(40);
  try {
    const legacy = await f.runtime.memory.get('m_00000000100000001', A); assert.equal(legacy.body, secret); assert.equal(legacy.private, false);
    const before = f.generation(); const rows = Number(f.observer.prepare('SELECT COUNT(*) AS n FROM memories').get()!.n);
    await assert.rejects(f.runtime.memory.store({ category: 'project', title: 'new credentials', body: secret }, A), (error: unknown) => error instanceof BosunError && error.code === 'private_input');
    assert.equal(f.generation(), before); assert.equal(Number(f.observer.prepare('SELECT COUNT(*) AS n FROM memories').get()!.n), rows);
    assert.equal((await f.runtime.retrieve('zebra credentials', A, { budgetTokens: 1000, minScore: 0, itemChars: 1000 })).items.length, 0);
    const view = new SqliteDatabase(f.paths.view, { readOnly: true }); try { assert.equal(Number(view.prepare('SELECT COUNT(*) AS n FROM public_memories').get()!.n), 0); } finally { view.close(); }
    const hidden = await f.runtime.memory.update(legacy.id, { private: true }, legacy.version, A); assert.equal(hidden.private, true); assert.equal(hidden.body, secret);
    await assert.rejects(f.runtime.memory.update(legacy.id, { private: false }, hidden.version, A), (error: unknown) => error instanceof BosunError || error instanceof MemoryError);
    assert.equal((await f.runtime.memory.get(legacy.id, A)).private, true);
    const docs = f.runtime.project({ root: f.repo, projectId: 'p_a' }); const file = path.join(f.repo, 'guide.md');
    fs.writeFileSync(file, '# Zebra public guide\nZebra public guide content'); assert.equal(docs.index().state, 'indexed');
    fs.writeFileSync(file, '# Zebra credential guide\n' + secret); assert.equal(docs.index().state, 'indexed');
    assert.equal((await docs.docs.search('zebra', A, 20)).length, 0); assert.equal(Number(f.observer.prepare('SELECT COUNT(*) AS n FROM docs').get()!.n), 0);
    docs.close();
  } finally { await f.close(); }
});

test('final memory composition preserves actual registered store/FTS/audit/scope and runs queries without maintenance', async () => {
  const f = await fixture();
  try {
    const memory = f.runtime.memory;
    const m = (await memory.store({ category: 'project', title: 'Zebra constellation', body: 'Zebra constellation uses pnpm', tags: ['tools'] }, A)).memory;
    assert.equal(m.hash, contentHash(m.title, m.body)); assert.match(m.id, /^m_[0-9a-v]{9}[0-9a-f]{8}$/);
    assert.equal((await memory.store({ category: 'project', title: m.title.toUpperCase(), body: m.body.toUpperCase() }, A)).duplicate, true);
    assert.deepEqual(await memory.get(m.id, A), m); assert.throws(() => memory.db, unavailable);
    assert.equal((await f.runtime.retrieve('zebra constellation', A, { budgetTokens: 300, minScore: 0, itemChars: 300 })).items[0].id, m.id);
    await assert.rejects(memory.get(m.id, B), (e) => e instanceof MemoryError && e.code === 'not_found');
    const before = f.generation(); const files = f.files();
    assert.equal((await memory.search({ text: 'zebra constellation', touch: true }, A))[0].id, m.id);
    assert.equal((await memory.get(m.id, A)).accessCount, 0); assert.equal(f.generation(), before); assert.deepEqual(f.files(), files);
    const edited = await memory.update(m.id, { body: 'Revised zebra constellation', shared: true }, 1, A); assert.equal(edited.version, 2);
    assert.equal((await memory.get(m.id, B)).id, m.id);
    await assert.rejects(memory.update(m.id, { body: 'wrong scope' }, 2, B), (e) => e instanceof MemoryError && e.code === 'invalid');
    await assert.rejects(memory.update(m.id, { body: 'wrong version' }, 1, A), (e) => e instanceof MemoryError && e.code === 'conflict');
    assert.equal((await memory.delete(m.id, A)).status, 'archived');
    assert.deepEqual((await memory.get(m.id, A, { events: true })).events!.map((e) => e.op), ['store', 'update', 'archive']);
    assert.ok(!JSON.stringify(f.measures).includes(m.id)); assert.ok(!JSON.stringify(f.measures).includes(m.body));
    f.jobs.assertOwner();
  } finally { await f.close(); }
});

test('final project context uses reviewed public curated/docs sources and supplied linked scope with explicit indexing only', async () => {
  const f = await fixture();
  try {
    const guide = path.join(f.repo, 'guide.md'); fs.writeFileSync(guide, '# Zebra constellation guide\nZebra constellation documentation.');
    const project = f.runtime.project({ root: f.repo, projectId: A.projectId! });
    const publicNote = (await f.runtime.memory.store({ category: 'project', title: 'Zebra constellation tools', body: 'Zebra constellation uses pnpm' }, A)).memory;
    const foreign = (await f.runtime.memory.store({ category: 'project', title: 'Zebra constellation foreign', body: 'Zebra constellation uses yarn' }, B)).memory;
    const secret = (await f.runtime.memory.store({ category: 'project', title: 'PRIVATE title', body: 'Zebra constellation PRIVATE body', tags: ['private-tag'], private: true }, A)).memory;
    assert.equal((await f.runtime.memory.get(secret.id, A)).body, secret.body);
    const before = f.generation(); const files = f.files();
    assert.deepEqual(await project.docs.search('zebra constellation', A, 10), []); assert.equal(f.generation(), before); assert.deepEqual(f.files(), files);
    assert.equal(project.index().state, 'indexed'); assert.equal((await project.docs.search('zebra constellation', A, 10))[0].id, 'guide.md');
    const queryFiles = f.files(); const generation = f.generation();
    const result = await project.retrieve('zebra constellation', A, { budgetTokens: 500, minScore: 0, itemChars: 500 });
    assert.ok(result.items.some((h) => h.id === publicNote.id)); assert.ok(result.items.some((h) => h.source === 'docs'));
    assert.ok(!result.text.includes('PRIVATE')); assert.ok(!result.items.some((h) => h.id === foreign.id));
    const linked = await project.retrieve('zebra constellation', { ...A, linked: ['p_b'] }, { budgetTokens: 500, minScore: 0, itemChars: 500 });
    assert.ok(linked.items.some((h) => h.id === foreign.id));
    assert.deepEqual(await project.docs.search('zebra constellation', B, 10), []);
    assert.equal((await project.docs.search('zebra constellation', { ...B, linked: ['p_a'] }, 10)).length, 1);
    assert.equal(f.generation(), generation); assert.deepEqual(f.files(), queryFiles);
    fs.writeFileSync(guide, '# Changed falcon guide\nFalcon migration guide.');
    assert.equal((await project.docs.search('zebra constellation', A, 10)).length, 1, 'snapshot query does not reread source');
    project.index(); assert.deepEqual(await project.docs.search('zebra constellation', A, 10), []);
    assert.equal((await project.docs.search('falcon migration', A, 10)).length, 1);
    project.close(); await assert.rejects(project.docs.search('falcon', A, 10), unavailable);
    assert.equal((await f.runtime.memory.get(publicNote.id, A)).id, publicNote.id, 'closing a source does not close the shared owner');
  } finally { await f.close(); }
});

test('curated final source rejects private/unclassified payload getters before projection', async () => {
  let payload = 0;
  const denied = { private: true, get body(): string { payload++; throw Error('PRIVATE body getter'); }, get title(): string { payload++; throw Error('PRIVATE title getter'); }, get id(): string { payload++; throw Error('PRIVATE ID getter'); } };
  const unclassified = Object.create(null, Object.getOwnPropertyDescriptors(denied)); Object.defineProperty(unclassified, 'private', { value: undefined });
  const source = createCuratedSource({ search: async () => [denied, unclassified] as never });
  assert.deepEqual(await source.search('public query', A, 10), []); assert.equal(payload, 0);
});

test('expiry/touch/prune and publication are explicit, and runtime close leaves the supplied daemon authority alive', async () => {
  const f = await fixture();
  try {
    const m = (await f.runtime.memory.store({ category: 'session', title: 'Zebra expiry', body: 'Zebra expiry scratch', ttlDays: 1 }, A)).memory;
    f.clock.value = m.expiresAt!; const generation = f.generation();
    assert.deepEqual(await f.runtime.memory.search({ text: 'zebra expiry' }, A), []); assert.equal((await f.runtime.memory.get(m.id, A)).status, 'active'); assert.equal(f.generation(), generation);
    assert.equal(f.runtime.expire(), 1); assert.equal((await f.runtime.memory.get(m.id, A, { events: true })).events!.at(-1)!.op, 'expire');
    f.runtime.touch([m.id]); assert.equal((await f.runtime.memory.get(m.id, A)).accessCount, 1);
    f.clock.value += 5 * DAY + 1; assert.deepEqual(f.runtime.prune(), { archived: 0, purged: 1 });
    const ready = await f.runtime.publish(); assert.equal(ready.state, 'READY');
    const p = f.runtime.project({ root: f.repo, projectId: A.projectId! }); p.docs.close!(); p.close();
    const owned = (await f.runtime.memory.store({ category: 'personal', title: 'Still alive', body: 'Still alive storage' }, A)).memory;
    const pending = f.runtime.publish(); const closing = f.runtime.close(); await pending; await closing; await f.runtime.close();
    await assert.rejects(f.runtime.memory.get(owned.id, A), unavailable); f.jobs.assertOwner();
  } finally { await f.close(); }
});

test('lost daemon authority denies memory/docs/context/index/publication before effects and closes neither independently', async () => {
  const f = await fixture();
  try {
    const m = (await f.runtime.memory.store({ category: 'personal', title: 'Zebra authority', body: 'Zebra authority body' }, A)).memory;
    const project = f.runtime.project({ root: f.repo, projectId: A.projectId! }); const generation = f.generation();
    await f.jobs.close();
    await assert.rejects(f.runtime.memory.get(m.id, A), unavailable);
    await assert.rejects(f.runtime.memory.store({ category: 'personal', title: 'Lost authority', body: 'Lost authority body' }, A), unavailable);
    await assert.rejects(project.docs.search('zebra', A, 10), unavailable);
    await assert.rejects(project.retrieve('zebra', A, { budgetTokens: 100, minScore: 0, itemChars: 100 }), unavailable);
    assert.throws(() => project.index(), unavailable); assert.throws(() => f.runtime.publish(), unavailable);
    assert.equal(f.generation(), generation);
  } finally { await f.close(); }
});

test('native registered COMMIT then error forwards unknown and fences all further writes without reopening or replay', async () => {
  const f = await fixture(); const exec = SqliteDatabase.prototype.exec; let committed = 0;
  try {
    SqliteDatabase.prototype.exec = function (sql) {
      const result = exec.call(this, sql);
      if (sql === 'COMMIT' && this.location() === f.paths.primary) { committed++; throw new MemoryError('conflict', 'PRIVATE post-commit canary', 99); }
      return result;
    };
    await assert.rejects(f.runtime.memory.store({ category: 'personal', title: 'Committed zebra', body: 'Committed zebra body' }, A), unknown);
    assert.equal(committed, 1); SqliteDatabase.prototype.exec = exec;
    assert.equal(f.observer.prepare("SELECT count(*) AS n FROM memories WHERE title='Committed zebra'").get()!.n, 1);
    assert.equal(f.observer.prepare('SELECT count(*) AS n FROM memory_events').get()!.n, 1);
    await assert.rejects(f.runtime.memory.store({ category: 'personal', title: 'Committed zebra', body: 'Committed zebra body' }, A), unknown);
    assert.equal(f.observer.prepare('SELECT count(*) AS n FROM memories').get()!.n, 1);
    f.jobs.assertOwner();
  } finally { SqliteDatabase.prototype.exec = exec; await f.close(); }
});

test('startup dependency failure closes both registered handles without releasing shared daemon authority', async () => {
  const f = await fixture(); const close = SqliteDatabase.prototype.close; const closed: string[] = [];
  try {
    SqliteDatabase.prototype.close = function () { const file = this.location(); if (file && [f.paths.primary, f.paths.view].includes(file)) closed.push(file); return close.call(this); };
    assert.throws(() => openDaemonMemory({ ...f.options, memory: { ...f.options.memory, retention: { sessionTtlDays: NaN, purgeAfterDays: 5 } } }), (e) => e instanceof MemoryError && e.code === 'invalid');
    assert.equal(closed.filter((file) => file === f.paths.primary).length, 1); assert.equal(closed.filter((file) => file === f.paths.view).length, 1);
    f.jobs.assertOwner(); assert.equal((await f.runtime.memory.search({}, A)).length, 0);
  } finally { SqliteDatabase.prototype.close = close; await f.close(); }
});

test('explicit docs COMMIT receipt loss preserves indexed rows/unknown and never replays or refreshes storage', async () => {
  const f = await fixture(); const exec = SqliteDatabase.prototype.exec;
  try {
    fs.writeFileSync(path.join(f.repo, 'guide.md'), '# Committed zebra guide\nCommitted zebra guide body.');
    const project = f.runtime.project({ root: f.repo, projectId: A.projectId! });
    SqliteDatabase.prototype.exec = function (sql) { const result = exec.call(this, sql); if (sql === 'COMMIT' && this.location() === f.paths.primary) throw Error('PRIVATE docs receipt loss'); return result; };
    assert.throws(() => project.index(), (e) => e instanceof BosunError && e.details?.outcome === 'unknown' && e.message === 'docs index unavailable');
    SqliteDatabase.prototype.exec = exec;
    assert.equal(f.observer.prepare('SELECT count(*) AS n FROM docs').get()!.n, 1);
    assert.throws(() => project.index(), unknown); assert.equal(f.observer.prepare('SELECT count(*) AS n FROM docs').get()!.n, 1);
  } finally { SqliteDatabase.prototype.exec = exec; await f.close(); }
});

test('explicit format1 publication retains cached writer fencing and requires explicit runtime restart', async () => {
  const f = await fixture({ publish: false }); let restarted: ReturnType<typeof openDaemonMemory> | undefined;
  try {
    const m = (await f.runtime.memory.store({ category: 'personal', title: 'Format zebra', body: 'Format zebra body' }, A)).memory;
    assert.equal((await f.runtime.publish()).state, 'READY');
    const generation = f.generation(); await assert.rejects(f.runtime.memory.update(m.id, { body: 'old format mutation' }, 1, A), unavailable); assert.equal(f.generation(), generation);
    await f.runtime.close(); restarted = openDaemonMemory(f.options);
    assert.equal((await restarted.memory.update(m.id, { body: 'new format mutation' }, 1, A)).version, 2);
    f.jobs.assertOwner();
  } finally { await restarted?.close(); await f.close(); }
});

test('explicit new initializer preserves the exact supported schema and refuses every existing file; normal open never initializes', async () => {
  const f = await fixture();
  try {
    assert.equal(MEMORY_MIGRATIONS.length, 2); const before = f.files();
    assert.throws(() => initializeMemory({ file: f.paths.primary, assertOwner: f.jobs.assertOwner, now: f.options.memory.now }), unavailable); assert.deepEqual(f.files(), before);
    const missing = path.join(f.primaryDir, 'missing.db');
    assert.throws(() => openDaemonMemory({ ...f.options, paths: { ...f.paths, primary: missing } }), unavailable); assert.equal(fs.existsSync(missing), false);
    const bare = path.join(f.primaryDir, 'bare.db'); initializeMemory({ file: bare, assertOwner: f.jobs.assertOwner, now: f.options.memory.now });
    assert.throws(() => openDaemonMemory({ ...f.options, paths: { ...f.paths, primary: bare } }), unavailable);
    const inspect = new SqliteDatabase(bare, { readOnly: true });
    try { assert.deepEqual(inspect.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r) => r.version), [1, 2]); assert.equal(inspect.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'bosun_%'").get()!.n, 0); }
    finally { inspect.close(); }
    const empty = path.join(f.primaryDir, 'empty.db'); fs.writeFileSync(empty, '', { mode: 0o600 });
    assert.throws(() => initializeMemory({ file: empty, assertOwner: f.jobs.assertOwner, now: f.options.memory.now }), unavailable); assert.equal(fs.statSync(empty).size, 0);
    const orphan = path.join(f.primaryDir, 'refused.db'); fs.writeFileSync(orphan + '-wal', 'unrelated fixture', { mode: 0o600 });
    assert.throws(() => initializeMemory({ file: orphan, assertOwner: f.jobs.assertOwner, now: f.options.memory.now }), unavailable); assert.equal(fs.existsSync(orphan), false); assert.equal(fs.readFileSync(orphan + '-wal', 'utf8'), 'unrelated fixture');
  } finally { await f.close(); }
});
