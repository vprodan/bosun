import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SqliteDatabase } from '../src/platform/sqlite.ts';
import { sandbox, fresh, claudeMemDb, gitRepo } from './helpers.ts';
import { footprint } from './read-view-prototype.ts';
import { ClaudeMemSource, claudeMemRevision, type ClaudeMemReviewedRef } from '../src/adapters/memory/claude-mem.ts';
import { initializeMemory } from '../src/adapters/memory/sqlite-initialize.ts';
import { cutoverMemory, publishMemoryView } from '../src/adapters/memory/sqlite-cutover.ts';
import { openDaemonMemory } from '../src/app/memory.ts';
import { contentHash } from '../src/platform/content-hash.ts';
import type { Ctx } from '../src/core/domain/memory.ts';
import { BosunError } from '../src/core/errors.ts';
import type { ContextSource } from '../src/core/ports/context-source.ts';

const NOW = 1_800_000_000_000;
const A: Ctx = { projectId: 'p_a', sessionId: 's_a', linked: [] };
function fixture() {
  const sb = sandbox(); fresh(sb); const external = path.join(sb.root, 'external'); fs.mkdirSync(external);
  const file = path.join(external, 'claude-mem.db');
  claudeMemDb(file, { obs: [
    { project: 'shop', title: 'Zebra public tooling', narrative: 'Zebra uses pnpm public tooling', at: NOW },
    { project: 'shop', title: 'PRIVATE title zebra', narrative: 'PRIVATE body zebra', at: NOW },
    { project: 'other', title: 'FOREIGN zebra', narrative: 'FOREIGN project zebra', at: NOW },
    { project: 'shop', title: 'SESSION zebra', narrative: 'SESSION scoped zebra', at: NOW },
    { project: 'Shop', title: 'CASE zebra', narrative: 'CASE project zebra', at: NOW },
  ], sums: [{ project: 'shop', request: 'Zebra public migration', learned: 'Zebra public learned migration', completed: 'Zebra public completed migration', at: NOW + 1 }] });
  const native = new SqliteDatabase(file);
  native.exec("CREATE TABLE schema_versions(id INTEGER PRIMARY KEY,version INTEGER UNIQUE NOT NULL,applied_at TEXT NOT NULL); INSERT INTO schema_versions(version,applied_at) VALUES(40,'synthetic');");
  native.prepare('UPDATE observations SET memory_session_id=?').run('mem_a');
  native.prepare('UPDATE observations SET memory_session_id=? WHERE id=3').run('mem_b');
  native.prepare('UPDATE observations SET memory_session_id=? WHERE id=4').run('mem_session');
  native.prepare('UPDATE session_summaries SET memory_session_id=?').run('mem_a'); native.close();
  const ref = (id: number, overrides: Partial<ClaudeMemReviewedRef> = {}): ClaudeMemReviewedRef => ({
    kind: 'observation', id, projectId: 'p_a', nativeProject: 'shop', nativeSessionId: 'mem_a', createdAt: NOW, privacy: 'public', scope: 'project', ...overrides,
  });
  const records: ClaudeMemReviewedRef[] = [ref(1), ref(3, { projectId: 'p_b', nativeProject: 'other', nativeSessionId: 'mem_b' }),
    ref(4, { scope: 'session', callerSessionId: 's_b', nativeSessionId: 'mem_session' }), ref(5, { nativeProject: 'Shop' }),
    ref(1, { kind: 'summary', createdAt: NOW + 1 })];
  const revision = claudeMemRevision(file)!;
  const options = { file, projects: [{ projectId: 'p_a', nativeProjects: ['shop'] }, { projectId: 'p_b', nativeProjects: ['other'] }],
    review: () => ({ revision, records }), monotonic: () => 1 };
  const source = new ClaudeMemSource(options);
  return { sb, external, file, records, options, source, ref,
    rows() { const db = new SqliteDatabase(file, { readOnly: true }); try { return { observations: db.prepare('SELECT * FROM observations ORDER BY id').all(), summaries: db.prepare('SELECT * FROM session_summaries ORDER BY id').all() }; } finally { db.close(); } },
    close() { source.close(); sb.cleanup(); },
  };
}

test('external ClaudeMem ContextSource constructor is inert and native rollback queries leave every byte unchanged', async () => {
  const f = fixture(); const original = fs.lstatSync; let inspected = 0;
  try {
    fs.lstatSync = ((...args: any[]) => { inspected++; return (original as any)(...args); }) as typeof original;
    const source = new ClaudeMemSource(f.options); assert.equal(inspected, 0); fs.lstatSync = original;
    assert.equal(source.id, 'claude-mem'); assert.equal(source.trust, 'verified'); assert.equal(source.weight, 0.6); assert.equal(source.halfLifeDays, 30);
    const rows = f.rows(); const before = footprint(f.external);
    const hits = await source.search('zebra public tooling migration', A, 20);
    assert.deepEqual(hits.map((hit) => hit.id).sort(), ['cm_o1', 'cm_s1']); assert.ok(hits.every((hit) => hit.rank < 0 && hit.matched! > 0));
    assert.doesNotMatch(JSON.stringify(hits), /PRIVATE|FOREIGN|SESSION|CASE/); assert.equal(source.state(), 'ready');
    assert.deepEqual(footprint(f.external), before); assert.deepEqual(f.rows(), rows);
    source.close(); assert.deepEqual(await source.search('zebra', A, 10), []); assert.equal(source.state(), 'closed');
  } finally { fs.lstatSync = original; f.close(); }
});

test('external public classification and exact project/native-session scope precede payload; unreviewed and stale references stay held', async () => {
  const f = fixture();
  try {
    assert.deepEqual((await f.source.search('zebra', { ...A, linked: ['p_b'] }, 20)).map((hit) => hit.id).sort(), ['cm_o1', 'cm_o3', 'cm_s1']);
    assert.deepEqual((await f.source.search('zebra', { ...A, sessionId: 's_b' }, 20)).map((hit) => hit.id).sort(), ['cm_o1', 'cm_o4', 'cm_s1']);
    assert.deepEqual(await f.source.search('zebra', { ...A, projectId: 'p_unmapped' }, 20), []);
    const denied = { privacy: 'private', get id(): never { throw Error('PRIVATE metadata accessed'); } };
    const unknown = { get id(): never { throw Error('PRIVATE unclassified metadata accessed'); } };
    const inherited = Object.create({ privacy: 'public' }, { id: { get(): never { throw Error('PRIVATE inherited metadata accessed'); } } });
    const accessor = { get privacy(): never { throw Error('PRIVATE classification getter'); } };
    const revision = claudeMemRevision(f.file)!;
    const refs = [denied, unknown, inherited, accessor, f.ref(2, { nativeSessionId: 'wrong-session' }), f.ref(1, { createdAt: NOW + 1 })] as unknown as ClaudeMemReviewedRef[];
    const deniedSource = new ClaudeMemSource({ ...f.options, review: () => ({ revision, records: refs }) });
    assert.deepEqual(await deniedSource.search('zebra', A, 20), []);
    assert.deepEqual(await new ClaudeMemSource({ ...f.options, review: () => ({ revision, records: [f.ref(5)] }) }).search('zebra', A, 20), [], 'native project comparison is case-sensitive even for an approved ID');
    const unreviewed = new ClaudeMemSource({ file: f.file, projects: f.options.projects }); assert.deepEqual(await unreviewed.search('PRIVATE zebra', A, 20), []);
    const before = footprint(f.external);
    assert.deepEqual(await new ClaudeMemSource({ ...f.options, review: () => ({ revision: 'unknown revision', records: f.records }) }).search('zebra', A, 20), []);
    assert.deepEqual(footprint(f.external), before);
    const db = new SqliteDatabase(f.file); db.prepare("UPDATE observations SET narrative='PRIVATE changed formerly-public zebra' WHERE id=1").run(); db.close();
    const changed = footprint(f.external); assert.deepEqual(await f.source.search('zebra', A, 20), []); assert.deepEqual(footprint(f.external), changed);
  } finally { f.close(); }
});

test('external readOnly/query_only denies DML and avoids unclassified external FTS derivatives', async () => {
  const f = fixture(); const exec = SqliteDatabase.prototype.exec; const prepare = SqliteDatabase.prototype.prepare; let denied = 0;
  try {
    const before = footprint(f.external);
    SqliteDatabase.prototype.exec = function (sql) {
      const result = exec.call(this, sql);
      if (this.location() === f.file && sql.includes('query_only=ON')) {
        assert.throws(() => prepare.call(this, "UPDATE observations SET title='PRIVATE mutation'").run(), /readonly|read.only/i); denied++;
      }
      return result;
    };
    SqliteDatabase.prototype.prepare = function (sql) { assert.doesNotMatch(sql, /observations_fts|session_summaries_fts/); return prepare.call(this, sql); };
    assert.equal((await f.source.search('zebra', A, 20)).length, 2); assert.equal(denied, 1); assert.deepEqual(footprint(f.external), before);
  } finally { SqliteDatabase.prototype.exec = exec; SqliteDatabase.prototype.prepare = prepare; f.close(); }
});

test('external bounded approved payload, malformed storage and reference overflow stay excluded before projection', async () => {
  const f = fixture();
  try {
    const db = new SqliteDatabase(f.file);
    db.prepare('UPDATE observations SET narrative=? WHERE id=1').run('PRIVATE-OVERSIZE zebra '.repeat(1000));
    db.prepare('UPDATE session_summaries SET learned=? WHERE id=1').run(Buffer.from('PRIVATE-BLOB zebra'));
    db.close();
    const revision = claudeMemRevision(f.file)!;
    const source = new ClaudeMemSource({ ...f.options, review: () => ({ revision, records: f.records }) });
    const before = footprint(f.external); assert.deepEqual(await source.search('zebra', A, 20), []); assert.deepEqual(footprint(f.external), before);
    const overflowing = new ClaudeMemSource({ ...f.options, review: () => ({ revision, records: Array.from({ length: 201 }, () => f.ref(1)) }) });
    assert.deepEqual(await overflowing.search('zebra', A, 20), []); assert.deepEqual(footprint(f.external), before);
    const disabled = new ClaudeMemSource({ projects: [], review() { throw Error('PRIVATE absent source callback'); } });
    assert.deepEqual(await disabled.search('zebra', A, 20), []); assert.equal(disabled.state(), 'disabled');
    const callbackFailure = new ClaudeMemSource({ ...f.options, review() { throw Error('PRIVATE callback body/path'); } });
    assert.deepEqual(await callbackFailure.search('zebra', A, 20), []); assert.equal(callbackFailure.state(), 'held');
  } finally { f.close(); }
});

test('external source revision changes during native query hold the result without changing the external body', async () => {
  const f = fixture(); const prepare = SqliteDatabase.prototype.prepare; let changed = false;
  try {
    const beforeRows = f.rows();
    SqliteDatabase.prototype.prepare = function (sql) {
      const statement = prepare.call(this, sql);
      if (this.location() === f.file && sql.includes('SELECT DISTINCT') && !changed) {
        changed = true; fs.utimesSync(f.file, new Date(), new Date(Date.now() + 5000));
      }
      return statement;
    };
    assert.deepEqual(await f.source.search('zebra', A, 20), []); assert.ok(changed); assert.equal(f.source.state(), 'held');
    SqliteDatabase.prototype.prepare = prepare; assert.deepEqual(f.rows(), beforeRows);
    const after = footprint(f.external); assert.deepEqual(await f.source.search('zebra', A, 20), []); assert.deepEqual(footprint(f.external), after);
  } finally { SqliteDatabase.prototype.prepare = prepare; f.close(); }
});

for (const situation of ['missing', 'corrupt', 'version', 'unknown-version', 'schema', 'view', 'journal', 'wal', 'symlink', 'oversized', 'locked', 'deadline'] as const) {
  test(`optional external source holds ${situation} with no repair, personal discovery or file changes`, async () => {
    const f = fixture(); let lock: SqliteDatabase | undefined;
    try {
      let file = f.file;
      if (situation === 'missing') fs.unlinkSync(file);
      if (situation === 'corrupt') fs.writeFileSync(file, Buffer.alloc(1024, 120));
      if (situation === 'oversized') fs.truncateSync(file, 64 * 1024 * 1024 + 1);
      if (situation === 'journal') fs.writeFileSync(file + '-journal', 'PRIVATE unknown journal');
      if (situation === 'symlink') { file = path.join(f.external, 'alias.db'); fs.symlinkSync(f.file, file); }
      if (['version', 'unknown-version', 'schema', 'view', 'wal'].includes(situation)) {
        const db = new SqliteDatabase(file);
        if (situation === 'version') db.prepare('UPDATE schema_versions SET version=41').run();
        if (situation === 'unknown-version') db.exec('DROP TABLE schema_versions');
        if (situation === 'schema') db.exec('ALTER TABLE observations RENAME COLUMN memory_session_id TO unsupported_session');
        if (situation === 'view') db.exec('ALTER TABLE observations RENAME TO private_observations; CREATE VIEW observations AS SELECT * FROM private_observations');
        if (situation === 'wal') db.exec('PRAGMA journal_mode=WAL');
        db.close();
      }
      const revision = claudeMemRevision(file) ?? 'unsupported';
      if (situation === 'locked') { lock = new SqliteDatabase(file); lock.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE;'); }
      let ticks = 0;
      const source = new ClaudeMemSource({ ...f.options, file, review: () => ({ revision, records: f.records }),
        monotonic: situation === 'deadline' ? () => ticks++ ? 251 : 0 : () => 1 });
      const before = footprint(f.external); assert.deepEqual(await source.search('zebra', A, 20), []);
      assert.deepEqual(footprint(f.external), before); assert.equal(source.state(), 'held'); source.close();
    } finally { lock?.close(); f.close(); }
  });
}

test('final memory composition retrieves external references without copying observations, and optional failures retain curated/docs', async () => {
  const f = fixture(); let runtime: ReturnType<typeof openDaemonMemory> | undefined; let owned = true;
  try {
    const repo = gitRepo(f.sb, 'repo'); const root = path.join(f.sb.root, 'storage');
    const primary = path.join(root, 'primary'); const view = path.join(root, 'view'); const backups = path.join(root, 'backups');
    for (const dir of [root, primary, view, backups]) fs.mkdirSync(dir, { mode: 0o700 });
    const paths = { primary: path.join(primary, 'memory.db'), view: path.join(view, 'public.db'), backups };
    const assertOwner = () => { if (!owned) throw Error('PRIVATE lost authority'); };
    initializeMemory({ file: paths.primary, assertOwner, now: () => NOW });
    await cutoverMemory({ paths, now: () => NOW, id: crypto.randomUUID }); await publishMemoryView({ paths, now: () => NOW, id: crypto.randomUUID });
    runtime = openDaemonMemory({ paths, assertOwner,
      memory: { now: () => NOW, retention: { sessionTtlDays: 7, purgeAfterDays: 90 }, id: () => 'm_external_fixture', hash: contentHash, monotonic: () => 1, measure() {} },
      context: { now: () => NOW, monotonic: () => 1, hash: contentHash, dateLabel: () => '2027-01-15', measure() {} },
      docsIndex: { monotonic: () => 1, measure() {} }, publicationId: crypto.randomUUID,
      externalSources: [{ trust: 'unsupported', get id(): never { throw Error('PRIVATE unsupported metadata'); } } as unknown as ContextSource, f.source],
    });
    await runtime.memory.store({ category: 'project', title: 'Zebra curated decision', body: 'Zebra independent curated decision' }, A);
    fs.writeFileSync(path.join(repo, 'guide.md'), '# Zebra documentation\nZebra documentation source');
    const project = runtime.project({ root: repo, projectId: 'p_a' }); project.index(); const sourceFiles = footprint(f.external);
    const retrieved = await project.retrieve('zebra public tooling migration', A, { budgetTokens: 1000, itemChars: 400, minScore: 0 });
    assert.ok(retrieved.items.some((hit) => hit.id === 'cm_o1')); assert.ok(retrieved.items.some((hit) => hit.id === 'm_external_fixture')); assert.ok(retrieved.items.some((hit) => hit.id === 'guide.md'));
    const local = new SqliteDatabase(paths.primary, { readOnly: true });
    try { assert.equal(local.prepare('SELECT count(*) AS n FROM memories').get()!.n, 1); assert.equal(local.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='observations'").get()!.n, 0); } finally { local.close(); }
    assert.deepEqual(footprint(f.external), sourceFiles);
    project.close(); assert.equal((await runtime.externalSources[0].search('zebra', A, 20)).length, 2);
    const db = new SqliteDatabase(f.file); db.prepare('UPDATE schema_versions SET version=999').run(); db.close();
    const result = await runtime.retrieve('zebra', A, { budgetTokens: 1000, itemChars: 400, minScore: 0 }); assert.deepEqual(result.items.map((hit) => hit.id), ['m_external_fixture']);
    const after = footprint(f.external); owned = false;
    await assert.rejects(runtime.externalSources[0].search('zebra', A, 20), (error) => error instanceof BosunError && error.code === 'unavailable');
    assert.deepEqual(footprint(f.external), after);
    await runtime.close(); runtime = undefined; assert.equal(f.source.state(), 'closed');
  } finally { await runtime?.close(); f.close(); }
});
