import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SqliteDatabase } from '../src/platform/sqlite.ts';
import { MEMORY_MIGRATIONS } from '../src/adapters/memory/sqlite-schema.ts';
import { normalize } from '../src/adapters/memory/sqlite-public-protocol.ts';
import { sandbox, fresh } from './helpers.ts';
import { footprint } from './read-view-prototype.ts';
import { initializeMemory } from '../src/adapters/memory/sqlite-initialize.ts';
import { CutoverWriter, cutoverMemory, publishMemoryView } from '../src/adapters/memory/sqlite-cutover.ts';
import { openDaemonJobs } from '../src/app/jobs.ts';
import { openDaemonMemory } from '../src/app/memory.ts';
import { contentHash } from '../src/platform/content-hash.ts';
import { BosunError, MemoryError } from '../src/core/errors.ts';
import type { Ctx, Memory } from '../src/core/domain/memory.ts';
import type { GraphArtifact, GraphInput, GraphSupport } from '../src/core/domain/graph.ts';

const A: Ctx = { projectId: 'p_a', sessionId: 's_a', linked: [], audience: 'owner' };
const B: Ctx = { projectId: 'p_b', sessionId: 's_b', linked: [], audience: 'owner' };
const model = (ctx: Ctx): Ctx => ({ ...ctx, audience: 'model' });
const ref = (m: Memory): GraphSupport => ({ memoryId: m.id, version: m.version, hash: m.hash });
const notFound = (e: unknown) => e instanceof MemoryError && e.code === 'not_found';
async function fixture({ oldSchema = false, legacySecret = false, graphContext = false } = {}) {
  const sb = sandbox(); fresh(sb); const root = path.join(sb.root, 'graph'); fs.mkdirSync(root, { mode: 0o700 });
  const primaryDir = path.join(root, 'primary'); const viewDir = path.join(root, 'view'); const backups = path.join(root, 'backups');
  for (const dir of [primaryDir, viewDir, backups]) fs.mkdirSync(dir, { mode: 0o700 });
  const paths = { primary: path.join(primaryDir, 'memory.db'), view: path.join(viewDir, 'public.db'), backups };
  const jobs = openDaemonJobs({ stateFile: path.join(root, 'state.db'), ownerFile: path.join(root, 'owner.db'), runners: {}, admit: async () => ({ allowed: false, reason: 'approval' }) }); jobs.recover();
  const clock = { value: 1800000000000 }; let ids = 0;
  const options = { paths, assertOwner: jobs.assertOwner, memory: { now: () => clock.value, retention: { sessionTtlDays: 1, purgeAfterDays: 1 },
    id: (now: number) => `m_${now.toString(32).padStart(9, '0')}${(++ids).toString(16).padStart(8, '0')}`, hash: contentHash, monotonic: () => 1, measure() {} },
    context: { now: () => clock.value, hash: contentHash, monotonic: () => 1, dateLabel: (at: number) => new Date(at).toISOString().slice(0, 10), measure() {} },
    docsIndex: { monotonic: () => 1, measure() {} }, publicationId: crypto.randomUUID, graphContext: { enabled: graphContext } };
  if (oldSchema) {
    fs.closeSync(fs.openSync(paths.primary, 'wx', 0o600)); const db = new SqliteDatabase(paths.primary);
    try { db.exec('PRAGMA journal_mode=WAL; CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)'); db.exec(MEMORY_MIGRATIONS[0]); db.prepare('INSERT INTO schema_migrations VALUES(1,?)').run(clock.value); }
    finally { db.close(); }
  } else initializeMemory({ file: paths.primary, assertOwner: jobs.assertOwner, now: options.memory.now });
  if (legacySecret) {
    const db = new SqliteDatabase(paths.primary); const secret = 'api_key=' + 'z'.repeat(40); const memoryId = 'm_00000000100000001';
    try {
      db.prepare(`INSERT INTO memories(id,category,project_id,title,body,tags,status,shared,private,source,hash,created_at,updated_at)
        VALUES(?,'project','p_a','Legacy source',?,'[]','active',0,0,'legacy',?,?,?)`).run(memoryId, secret, contentHash('Legacy source', secret), clock.value, clock.value);
      db.prepare(`INSERT INTO graph_artifacts(id,level,kind,title,text,status,project_id,private,shared,recorded_at,hash,producer_kind,producer_version)
        VALUES('g_legacy',2,'entity','Derivative canary','Derived private content','active','p_a',0,0,?,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','owner','1')`).run(clock.value);
      db.prepare('INSERT INTO graph_supports VALUES(?,?,1,?,NULL,NULL)').run('g_legacy', memoryId, contentHash('Legacy source', secret));
      db.prepare("INSERT INTO graph_aliases VALUES('g_legacy','canaryalias')").run();
    } finally { db.close(); }
  }
  await cutoverMemory({ paths, now: options.memory.now, id: crypto.randomUUID }); await publishMemoryView({ paths, now: options.memory.now, id: crypto.randomUUID });
  const runtime = openDaemonMemory(options); const observer = new SqliteDatabase(paths.primary, { readOnly: true });
  return { sb, root, paths, clock, jobs, options, runtime, observer,
    files: () => [footprint(primaryDir), footprint(viewDir), footprint(backups)],
    generation: () => observer.prepare('SELECT generation FROM bosun_source_floor').get()!.generation,
    async close() { await runtime.close(); observer.close(); await jobs.close(); sb.cleanup(); } };
}
async function memory(f: Awaited<ReturnType<typeof fixture>>, title: string, body = `${title} source evidence`, context = A) {
  return (await f.runtime.memory.store({ category: 'project', title, body }, context)).memory;
}
function entity(m: Memory, key: string, aliases: string[] = []): GraphInput {
  return { kind: 'entity', title: key, text: `Reviewed concept ${key}`, supports: [ref(m)], entity: { type: 'concept', key, aliases } };
}
function accept(f: Awaited<ReturnType<typeof fixture>>, input: GraphInput, ctx = A): GraphArtifact {
  const proposed = f.runtime.graph.create(input, ctx); return f.runtime.graph.review(proposed.id, proposed.version, 'accept', ctx) as GraphArtifact;
}

test('final graph schema fingerprint', () => {
  const db = new SqliteDatabase(':memory:');
  try {
    db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
    for (const migration of MEMORY_MIGRATIONS) db.exec(migration);
    const rows = db.prepare("SELECT name,type,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE 'bosun_%' ORDER BY name").all();
    const digest = crypto.createHash('sha256').update(JSON.stringify(rows.map((r) => [r.name, r.type, r.tbl_name, normalize(r.sql)]))).digest('hex');
    assert.equal(digest, '6ff81a0129ab188ee178c3e0b82397815f5970f7b8529ef56386b2fe9d0dd713');
  } finally { db.close(); }
});

test('same registered writer creates reviewed L0/L2/L3/L4, preserves source rows/audit and performs query without writes', async () => {
  const f = await fixture();
  try {
    assert.equal(f.runtime.schemaVersion, 2); assert.equal(f.runtime.graph.enabled, true);
    const fact = await memory(f, 'Zebra package manager', 'Zebra project uses pnpm'); const before = await f.runtime.memory.get(fact.id, A, { events: true });
    assert.deepEqual(f.runtime.graph.backfill(A), { created: 1, skipped: 0 }); assert.deepEqual(f.runtime.graph.backfill(A), { created: 0, skipped: 0 });
    const proposal = f.runtime.graph.create(entity(fact, 'package tooling', ['zebra-tools']), A);
    assert.equal(f.runtime.graph.query({ text: 'zebra-tools' }, model(A)).items.length, 0); assert.throws(() => f.runtime.graph.get(proposal.id, model(A)), notFound);
    assert.throws(() => f.runtime.graph.review(proposal.id, 1, 'accept', model(A)), (e: unknown) => e instanceof MemoryError && e.code === 'invalid');
    const node = f.runtime.graph.review(proposal.id, 1, 'accept', A) as GraphArtifact;
    const summary = accept(f, { kind: 'summary', title: 'Zebra summary', text: 'Zebra tooling uses pnpm', supports: [ref(fact)], parents: [{ id: node.id, version: node.version }], producer: { kind: 'model', model: 'exact:test', version: 'fixture1' } });
    const profile = accept(f, { kind: 'profile', title: 'Zebra reviewed profile', text: 'Prefer pnpm for Zebra', supports: [ref(fact)], parents: [{ id: summary.id, version: summary.version }] });
    const generation = f.generation(); const files = f.files();
    assert.equal(f.runtime.graph.query({ text: 'zebra-tools' }, model(A)).items[0].id, node.id);
    assert.ok(f.runtime.graph.query({ text: 'zebra' }, model(A)).items.some((a) => a.id === profile.id));
    assert.deepEqual(f.runtime.graph.explain(profile.id, A).supports, [ref(fact)]); assert.deepEqual(f.runtime.graph.explain(profile.id, A).parents, [{ id: summary.id, version: summary.version }]);
    assert.deepEqual(await f.runtime.memory.get(fact.id, A, { events: true }), before); assert.equal(f.generation(), generation); assert.deepEqual(f.files(), files);
    const source = f.observer.prepare("SELECT title,text FROM graph_artifacts WHERE kind='source'").get()!; assert.equal(source.text, ''); assert.equal(source.title, `Evidence ${fact.id}`);
    assert.equal(f.runtime.graph.query({ text: 'zebra', levels: [4] }, A).items[0].id, profile.id);
    assert.deepEqual(f.runtime.graph.exportProfile(profile.id, A), { schema: 1, title: profile.title, text: profile.text, recordedAt: profile.recordedAt, citations: [ref(fact)] });
    assert.equal((await f.runtime.retrieve('zebra', model(A), { budgetTokens: 400, minScore: 0, itemChars: 500 })).items.some((a) => a.source === 'graph'), false);
  } finally { await f.close(); }
});

test('complete source versions are required and source changes revoke all levels inside the memory mutation transaction', async () => {
  const f = await fixture();
  try {
    const m = await memory(f, 'Zebra revocation'); const node = accept(f, entity(m, 'Zebra node'));
    const summary = accept(f, { kind: 'summary', title: 'Zebra summary', text: 'Zebra fact summary', supports: [ref(m)], parents: [{ id: node.id, version: node.version }] });
    const profile = accept(f, { kind: 'profile', title: 'Zebra profile', text: 'Zebra preferences', supports: [ref(m)], parents: [{ id: summary.id, version: summary.version }] });
    const other = await memory(f, 'Other evidence');
    assert.throws(() => f.runtime.graph.create({ kind: 'summary', title: 'Missing lineage', text: 'Missing lineage body', supports: [ref(other)], parents: [{ id: node.id, version: node.version }] }, A), (e: unknown) => e instanceof MemoryError && e.code === 'invalid');
    const changed = await f.runtime.memory.update(m.id, { private: true }, m.version, A); assert.equal(changed.private, true);
    for (const artifact of [node, summary, profile]) { assert.equal(f.observer.prepare('SELECT status FROM graph_artifacts WHERE id=?').get(artifact.id)!.status, 'dirty'); assert.throws(() => f.runtime.graph.get(artifact.id, A), notFound); }
    assert.equal(f.runtime.graph.query({ text: 'zebra', expand: true }, model(A)).items.length, 0);
    assert.equal(Number(f.observer.prepare("SELECT COUNT(*) AS n FROM graph_events WHERE op='source_changed'").get()!.n), 3);
    assert.equal(f.observer.prepare("SELECT COUNT(*) AS n FROM graph_fts WHERE graph_fts MATCH 'zebra'").get()!.n, 0);
    assert.equal((await f.runtime.memory.get(m.id, A)).id, m.id); assert.equal((await f.runtime.memory.get(m.id, A, { events: true })).events!.length, 2);
    await f.runtime.memory.update(m.id, { private: false }, changed.version, A);
    assert.equal(f.runtime.graph.query({ text: 'zebra' }, model(A)).items.length, 0); // Old hashes/versions never revive automatically.
    assert.throws(() => f.runtime.graph.create(entity(m, 'Stale source'), A), notFound);
  } finally { await f.close(); }
});

test('legacy credential source and aliases are withheld before any graph payload read while raw owner records remain intact', async () => {
  const f = await fixture({ legacySecret: true }); const prepare = SqliteDatabase.prototype.prepare; let payloadReads = 0;
  try {
    SqliteDatabase.prototype.prepare = function (sql) { if (this.location() === f.paths.primary && /SELECT \* FROM graph_artifacts/i.test(sql)) payloadReads++; return prepare.call(this, sql); };
    assert.equal(f.runtime.graph.query({ text: 'derivative canary', expand: true }, model(A)).items.length, 0);
    assert.equal(f.runtime.graph.query({ text: 'canaryalias' }, model(A)).items.length, 0); assert.throws(() => f.runtime.graph.get('g_legacy', A), notFound); assert.equal(payloadReads, 0);
    assert.equal((await f.runtime.memory.get('m_00000000100000001', A)).private, false); assert.match((await f.runtime.memory.get('m_00000000100000001', A)).body, /^api_key=/);
    assert.deepEqual(f.runtime.graph.backfill(A), { created: 0, skipped: 1 }); assert.equal(f.observer.prepare('SELECT COUNT(*) AS n FROM graph_artifacts').get()!.n, 1);
  } finally { SqliteDatabase.prototype.prepare = prepare; await f.close(); }
});

test('scope, linked/shared eligibility and session/expiry are checked on every source and derived read', async () => {
  const f = await fixture();
  try {
    const foreign = await memory(f, 'Foreign Zebra', 'Foreign Zebra source', B); const node = accept(f, entity(foreign, 'Foreign Zebra'), B);
    assert.equal(f.runtime.graph.query({ text: 'zebra' }, A).items.length, 0); assert.throws(() => f.runtime.graph.get(node.id, A), notFound);
    assert.equal(f.runtime.graph.query({ text: 'zebra' }, { ...A, linked: ['p_b'] }).items[0].id, node.id);
    assert.throws(() => f.runtime.graph.create(entity(foreign, 'Copy foreign'), { ...A, linked: ['p_b'] }), (e: unknown) => e instanceof MemoryError && e.code === 'invalid');
    const shared = await f.runtime.memory.update(foreign.id, { shared: true }, 1, B); const sharedNode = accept(f, entity(shared, 'Shared Zebra'), B);
    assert.equal(f.runtime.graph.get(sharedNode.id, A).id, sharedNode.id);
    const session = (await f.runtime.memory.store({ category: 'session', title: 'Session Zebra', body: 'Session Zebra source', ttlDays: 1 }, A)).memory;
    const sessionNode = accept(f, entity(session, 'Session Zebra')); assert.equal(f.runtime.graph.get(sessionNode.id, A).sessionId, A.sessionId);
    assert.throws(() => f.runtime.graph.get(sessionNode.id, { ...A, sessionId: 'other' }), notFound);
    const temporal = accept(f, { kind: 'summary', title: 'Temporal Zebra', text: 'Temporal zebra summary', supports: [ref(shared)], validTo: f.clock.value + 100 }, B);
    f.clock.value += 101; assert.throws(() => f.runtime.graph.get(temporal.id, B), notFound);
    f.clock.value += 86400000; assert.throws(() => f.runtime.graph.get(sessionNode.id, A), notFound); assert.equal(f.observer.prepare('SELECT status FROM graph_artifacts WHERE id=?').get(sessionNode.id)!.status, 'active');
  } finally { await f.close(); }
});

test('review, ranges, semantic shapes, normalized file keys and model provenance are validated before writes', async () => {
  const f = await fixture();
  try {
    const m = await memory(f, 'Zebra validation'); const before = f.generation();
    for (const input of [
      { ...entity(m, 'Empty supports'), supports: [] }, { ...entity(m, 'Duplicate refs'), supports: [ref(m), ref(m)] },
      { ...entity(m, 'Bad span'), supports: [{ ...ref(m), start: 0, end: 4000 }] }, { ...entity(m, 'Unsafe file'), entity: { type: 'file', key: '../outside' } },
      { ...entity(m, 'Wrong kind'), kind: 'profile' }, { ...entity(m, 'Missing model'), producer: { kind: 'model', model: null, version: '1' } },
      { kind: 'source', title: 'Duplicated evidence', text: m.body, supports: [ref(m)] },
    ]) assert.throws(() => f.runtime.graph.create(input as GraphInput, A), (e: unknown) => e instanceof MemoryError && ['invalid', 'not_found'].includes(e.code));
    assert.equal(f.generation(), before); assert.equal(f.observer.prepare('SELECT COUNT(*) AS n FROM graph_artifacts').get()!.n, 0);
    assert.throws(() => f.runtime.graph.create({ ...entity(m, 'Credential label'), text: 'api_key=' + 'q'.repeat(40) }, A), (e: unknown) => e instanceof BosunError && e.code === 'private_input');
    const proposal = f.runtime.graph.create(entity(m, 'Valid Zebra'), A); assert.throws(() => f.runtime.graph.review(proposal.id, 2, 'accept', A), (e: unknown) => e instanceof MemoryError && e.code === 'conflict');
    assert.equal((f.runtime.graph.review(proposal.id, 1, 'reject', A)).status, 'archived'); assert.equal(f.runtime.graph.query({ text: 'valid' }, A).items.length, 0);
  } finally { await f.close(); }
});

test('bounded graph expansion requires eligible edge/endpoints and explicit opt-in; parent revocation is atomic', async () => {
  const f = await fixture({ graphContext: true });
  try {
    const m = await memory(f, 'Seed source'); const from = accept(f, entity(m, 'Zebra seed', ['zebra'])); const to = accept(f, entity(m, 'Package tooling', ['package']));
    const edge = accept(f, { kind: 'relation', title: 'Tooling relation', text: 'The seed uses package tooling', supports: [ref(m)], relation: { from: from.id, to: to.id, predicate: 'uses', weight: 1 } });
    const plain = f.runtime.graph.query({ text: 'zebra' }, A); assert.ok(!plain.items.some((a) => a.id === to.id)); assert.equal(plain.edges, 0);
    const expanded = f.runtime.graph.query({ text: 'zebra', expand: true, depth: 2 }, A); assert.ok(expanded.items.some((a) => a.id === to.id)); assert.ok(expanded.items.some((a) => a.id === edge.id));
    assert.ok(expanded.visited <= 64); assert.ok(expanded.edges <= 128); assert.deepEqual(expanded.items.find((a) => a.id === to.id)!.paths[0], [from.id, edge.id, to.id]);
    assert.ok((await f.runtime.retrieve('zebra', model(A), { budgetTokens: 400, minScore: 0, itemChars: 500 })).items.some((a) => a.source === 'graph'));
    const revoked = f.runtime.graph.revoke(from.id, from.version, A); assert.equal(revoked.invalidated, 2); assert.equal(f.observer.prepare('SELECT status FROM graph_artifacts WHERE id=?').get(edge.id)!.status, 'dirty');
    assert.equal(f.runtime.graph.query({ text: 'zebra', expand: true }, A).items.length, 0); assert.equal(f.runtime.graph.get(to.id, A).id, to.id);
  } finally { await f.close(); }
});

test('schema1 remains exact/readable with graph disabled; no implicit graph creation or upgrade writes', async () => {
  const f = await fixture({ oldSchema: true });
  try {
    assert.equal(f.runtime.schemaVersion, 1); assert.equal(f.runtime.graph.enabled, false); const m = await memory(f, 'Legacy Zebra'); const generation = f.generation(); const files = f.files();
    assert.deepEqual(f.runtime.graph.query({ text: 'zebra' }, A), { items: [], visited: 0, edges: 0, truncated: false });
    assert.throws(() => f.runtime.graph.create(entity(m, 'No upgrade'), A), (e: unknown) => e instanceof MemoryError && e.code === 'unavailable');
    assert.equal(f.observer.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'graph_%'").get()!.n, 0); assert.equal(f.generation(), generation); assert.deepEqual(f.files(), files);
  } finally { await f.close(); }
});

test('dense native graph stops at64 artifacts and128 distinct edges, never starts an unbounded traversal', async () => {
  const f = await fixture();
  try {
    const m = await memory(f, 'Dense corpus evidence'); const origin = accept(f, entity(m, 'Origin', ['unique-origin']));
    const leaves: GraphArtifact[] = [];
    for (let i = 0; i < 70; i++) leaves.push(accept(f, entity(m, `Leaf ${i}`)));
    for (let i = 0; i < 140; i++) accept(f, { kind: 'relation', title: `Connection ${i}`, text: 'Reviewed connection evidence', supports: [ref(m)],
      relation: { from: origin.id, to: leaves[i % leaves.length].id, predicate: 'related_to', weight: 1 } });
    const generation = f.generation(); const result = f.runtime.graph.query({ text: 'unique-origin', expand: true, depth: 2, limit: 50 }, A);
    assert.equal(result.visited, 64); assert.equal(result.edges, 128); assert.equal(result.truncated, true); assert.equal(result.items.length, 50); assert.equal(f.generation(), generation);
    assert.equal(f.runtime.graph.query({ text: 'unique-origin', expand: false }, A).visited, 1);
  } finally { await f.close(); }
});

test('parent temporal deadlines, explicit archive and purge cannot leave readable summary/profile descendants', async () => {
  const f = await fixture();
  try {
    const m = await memory(f, 'Temporal lineage');
    const node = accept(f, { ...entity(m, 'Temporal node'), validTo: f.clock.value + 20 });
    const summary = accept(f, { kind: 'summary', title: 'Temporal summary', text: 'Reviewed temporal summary', supports: [ref(m)], parents: [{ id: node.id, version: node.version }] });
    const profile = accept(f, { kind: 'profile', title: 'Temporal profile', text: 'Reviewed temporal profile', supports: [ref(m)], parents: [{ id: summary.id, version: summary.version }] });
    assert.equal(summary.expiresAt, node.validTo); assert.equal(profile.expiresAt, node.validTo);
    f.clock.value += 21; assert.throws(() => f.runtime.graph.get(profile.id, A), notFound); assert.throws(() => f.runtime.graph.exportProfile(profile.id, A), notFound);
    await f.runtime.memory.delete(m.id, A); for (const artifact of [node, summary, profile]) assert.equal(f.observer.prepare('SELECT status FROM graph_artifacts WHERE id=?').get(artifact.id)!.status, 'dirty');
    await f.runtime.memory.purge(m.id, A); assert.equal(f.observer.prepare('SELECT COUNT(*) AS n FROM memories WHERE id=?').get(m.id)!.n, 0);
    assert.equal(f.observer.prepare('SELECT COUNT(*) AS n FROM graph_supports WHERE memory_id=?').get(m.id)!.n, 3); // Lineage/audit survive source removal.
    assert.equal(f.runtime.graph.query({ text: 'temporal' }, A).items.length, 0);
  } finally { await f.close(); }
});

test('graph writes use the existing UDF floor and lost COMMIT is unknown/fenced without replay', async () => {
  const f = await fixture(); const exec = SqliteDatabase.prototype.exec;
  try {
    const m = await memory(f, 'Commit Zebra'); const raw = new SqliteDatabase(f.paths.primary);
    try { assert.throws(() => raw.prepare("INSERT INTO graph_events(artifact_id,op,at,version) VALUES('g_unowned','fake',0,1)").run()); }
    finally { raw.close(); }
    SqliteDatabase.prototype.exec = function (sql) { const result = exec.call(this, sql); if (sql === 'COMMIT' && this.location() === f.paths.primary) throw Error('lost graph receipt'); return result; };
    assert.throws(() => f.runtime.graph.create(entity(m, 'Commit Zebra'), A), (e: unknown) => e instanceof BosunError && e.details?.outcome === 'unknown'); SqliteDatabase.prototype.exec = exec;
    assert.equal(f.observer.prepare('SELECT COUNT(*) AS n FROM graph_artifacts').get()!.n, 1); assert.equal(f.observer.prepare('SELECT COUNT(*) AS n FROM graph_supports').get()!.n, 1);
    assert.throws(() => f.runtime.graph.create(entity(m, 'Never replay'), A), (e: unknown) => e instanceof BosunError && e.details?.outcome === 'unknown'); assert.equal(f.observer.prepare('SELECT COUNT(*) AS n FROM graph_artifacts').get()!.n, 1);
  } finally { SqliteDatabase.prototype.exec = exec; await f.close(); }
});

test('canonical derivative hash covers sorted supports/parents/aliases and withholds independently changed derived payloads', async () => {
  const f = await fixture(); let tamper: CutoverWriter | undefined;
  try {
    const first = await memory(f, 'Zebra first'); const second = await memory(f, 'Zebra second');
    const node = accept(f, { ...entity(first, 'Zebra hash', ['zed', 'alpha', 'alpha']), supports: [ref(second), ref(first)] });
    assert.deepEqual(f.runtime.graph.get(node.id, A).supports, [ref(first), ref(second)]); assert.deepEqual(f.runtime.graph.get(node.id, A).entity!.aliases, ['alpha', 'zebra hash', 'zed']);
    const other = accept(f, entity(first, 'Another zebra')); const summary = accept(f, { kind: 'summary', title: 'Zebra hash summary', text: 'Zebra summary with complete reviewed lineage',
      supports: [ref(second), ref(first)], parents: [{ id: other.id, version: other.version }, { id: node.id, version: node.version }] });
    assert.equal(f.runtime.graph.get(summary.id, model(A)).hash, summary.hash);
    const caseBound = accept(f, { ...entity(first, 'Exact producer'), producer: { kind: 'owner', model: null, version: 'V1' } });
    // Synthetic admitted storage fault, preserving the recorded hash and original source. No personal database or unregistered write is involved.
    tamper = new CutoverWriter(f.paths);
    tamper.transaction((db) => db.prepare('UPDATE graph_artifacts SET producer_version=? WHERE id=?').run('v1', caseBound.id));
    assert.throws(() => f.runtime.graph.get(caseBound.id, model(A)), notFound);
    tamper.transaction((db) => db.prepare('UPDATE graph_artifacts SET text=? WHERE id=?').run('Tampered derivative canary', summary.id));
    assert.throws(() => f.runtime.graph.get(summary.id, model(A)), notFound); assert.ok(!f.runtime.graph.query({ text: 'zebra' }, model(A)).items.some((a) => a.id === summary.id));
    tamper.transaction((db) => db.prepare('INSERT INTO graph_aliases VALUES(?,?)').run(node.id, 'unexpectedalias'));
    assert.equal(f.runtime.graph.query({ text: 'unexpectedalias' }, model(A)).items.length, 0); assert.throws(() => f.runtime.graph.get(node.id, A), notFound);
    assert.equal((await f.runtime.memory.get(first.id, A)).body, first.body); assert.equal(f.observer.prepare('SELECT text FROM graph_artifacts WHERE id=?').get(summary.id)!.text, 'Tampered derivative canary');
  } finally { tamper?.close(); await f.close(); }
});
