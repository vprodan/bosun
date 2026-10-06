import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { sandbox, fresh, gitRepo, bosun, mcpSession, REPO } from './helpers.ts';
import { Docs } from '../lib/memory/docs.ts';
import { MIGRATIONS } from '../lib/memory/sqlite.ts';
import { project } from '../lib/memory/project.ts';
import { footprint } from './read-view-prototype.ts';
import { SqliteDocs } from '../src/adapters/memory/sqlite-docs.ts';
import { SqliteDocsIndex, DOCS_MAX_BYTES, DOCS_MAX_TOTAL_BYTES, type DocsIndexDependencies, type DocsMeasurement } from '../src/adapters/memory/sqlite-docs-index.ts';
import { checkDocsStorage, enumerateDocs, inspectDoc, resolveDocsRoot } from '../src/adapters/memory/docs-filesystem.ts';
import { plainSession, type SqliteSession } from '../src/adapters/memory/sqlite-session.ts';
import { cutoverMemory, CutoverWriter, publishMemoryView } from '../src/adapters/memory/sqlite-cutover.ts';
import type { ContextSource } from '../src/core/ports/context-source.ts';
import { BosunError, MemoryError, modelMemoryError } from '../src/core/errors.ts';

const CTX = { projectId: 'p_a', sessionId: null, linked: [] as string[] };
function baseline() {
  const sb = sandbox(); fresh(sb); const repo = gitRepo(sb, 'repo');
  const db = new DatabaseSync(':memory:'); db.exec(MIGRATIONS[0]);
  const docs = new Docs(db, repo, CTX.projectId);
  return { sb, repo, db, docs, close() { docs.close(); sb.cleanup(); } };
}
test('docs complete enumeration: native failed ls-files after root success preserves indexed rows', () => {
  const f = baseline();
  try {
    fs.writeFileSync(path.join(f.repo, 'guide.md'), '# Zebra\nZebra retained document'); f.docs.index();
    const before = f.db.prepare('SELECT * FROM docs').all();
    fs.writeFileSync(path.join(f.repo, '.git/index'), 'invalid native git index');
    assert.deepEqual(f.docs.index(), { changed: 0, removed: 0 });
    assert.deepEqual(f.db.prepare('SELECT * FROM docs').all(), before);
  } finally { f.close(); }
});
test('docs complete enumeration: 2001 files holds without deleting an unvisited existing row', () => {
  const f = baseline();
  try {
    fs.writeFileSync(path.join(f.repo, 'zzz.md'), '# Zebra\nZebra retained document'); f.docs.index();
    const before = f.db.prepare('SELECT * FROM docs').all();
    for (let i = 0; i < 2000; i++) fs.writeFileSync(path.join(f.repo, `a${String(i).padStart(4, '0')}.md`), '# Short\nShort document');
    assert.deepEqual(f.docs.index(), { changed: 0, removed: 0 });
    assert.deepEqual(f.db.prepare('SELECT * FROM docs').all(), before);
  } finally { f.close(); }
});
for (const registered of [false, true]) test(`docs timestamp-preserving edit: ${registered ? 'registered' : 'plain'} refreshes content without writing unchanged snapshots`, async () => {
  const f = await fixture(registered);
  const docs = new Docs(f.session, f.repo, 'p_a');
  try {
    const file = path.join(f.repo, 'guide.md');
    fs.writeFileSync(file, '# Zebra\nZebra previous content');
    fs.utimesSync(file, 1_800_000_000, 1_800_000_000);
    assert.deepEqual(docs.index(), { changed: 1, removed: 0 });
    const initial = f.rows()[0];
    const generation = f.generation();
    assert.deepEqual(docs.index(), { changed: 0, removed: 0 });
    assert.equal(f.generation(), generation);
    fs.writeFileSync(file, '# Zebra\nZebra freshword content');
    fs.utimesSync(file, 1_800_000_000, 1_800_000_000);
    assert.deepEqual(docs.index(), { changed: 1, removed: 0 });
    const refreshed = f.rows()[0];
    assert.equal(refreshed.seq, initial.seq);
    assert.equal(refreshed.mtime, initial.mtime);
    assert.equal(refreshed.body, '# Zebra\nZebra freshword content');
    assert.equal((await docs.search('freshword', CTX, 10))[0].id, 'guide.md');
    const stable = { rows: f.rows(), generation: f.generation(), files: f.files() };
    assert.deepEqual(docs.index(), { changed: 0, removed: 0 });
    assert.deepEqual({ rows: f.rows(), generation: f.generation(), files: f.files() }, stable);
  } finally { f.close(); }
});
test('docs descriptor close failure holds indexing and retries only its still-open source descriptor', async () => {
  const f = await fixture();
  const open = fs.openSync; const close = fs.closeSync;
  let watched: number | undefined; let failed = false;
  try {
    const file = path.join(f.repo, 'guide.md'); fs.writeFileSync(file, '# Zebra\nZebra source');
    fs.openSync = ((target, flags, mode) => { const fd = open(target, flags, mode); if (String(target) === file) watched = fd; return fd; }) as typeof open;
    fs.closeSync = ((fd) => { if (fd === watched && !failed) { failed = true; throw new Error('PRIVATE descriptor close failure'); } return close(fd); }) as typeof close;
    assert.equal(f.index.index().state, 'held');
    assert.equal(failed, true); assert.deepEqual(f.rows(), []);
    assert.throws(() => fs.fstatSync(watched!));
    assert.doesNotMatch(JSON.stringify(f.metrics), /PRIVATE|guide|repo/);
  } finally {
    fs.openSync = open; fs.closeSync = close;
    if (watched !== undefined) try { close(watched); } catch {}
    f.close();
  }
});
test('docs regular source: outside symlink is rejected before reading private bytes', async () => {
  const f = baseline(); const read = fs.readFileSync; let outsideReads = 0;
  const outside = path.join(f.sb.root, 'PRIVATE-file.md');
  try {
    fs.writeFileSync(outside, '# PRIVATE title\nPRIVATE-BODY-CANARY zebra');
    fs.symlinkSync(outside, path.join(f.repo, 'guide.md'));
    fs.readFileSync = ((file: any, ...args: any[]) => { if (file === outside || file === path.join(f.repo, 'guide.md')) outsideReads++; return (read as any)(file, ...args); }) as typeof read;
    assert.deepEqual(await f.docs.search('zebra', CTX, 10), []);
    assert.equal(outsideReads, 0);
  } finally { fs.readFileSync = read; f.close(); }
});
test('docs scope: query and parent index preserve another configured project beneath the root', async () => {
  const f = baseline();
  try {
    const foreign = path.join(f.repo, 'nested', 'foreign.md');
    f.db.prepare('INSERT INTO docs(path,project_id,mtime,title,body) VALUES(?,?,?,?,?)').run(foreign, 'p_b', 1, 'PRIVATE title', 'PRIVATE-CANARY zebra');
    assert.deepEqual(f.docs.index(), { changed: 0, removed: 0 });
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM docs WHERE project_id=?').get('p_b')!.n, 1);
    assert.deepEqual(await f.docs.search('zebra', CTX, 10), []);
  } finally { f.close(); }
});

async function fixture(registered = false) {
  const sb = sandbox(); fresh(sb); const repo = gitRepo(sb, 'repo');
  const storage = path.join(sb.root, 'storage');
  const primaryDir = path.join(storage, 'primary'); const viewDir = path.join(storage, 'view'); const backups = path.join(storage, 'backups');
  for (const dir of [storage, primaryDir, viewDir, backups]) fs.mkdirSync(dir, { mode: 0o700 });
  const paths = { primary: path.join(primaryDir, 'memory.db'), view: path.join(viewDir, 'public.db'), backups };
  const db = new DatabaseSync(paths.primary); fs.chmodSync(paths.primary, 0o600);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA busy_timeout=0;');
  db.exec(MIGRATIONS[0]); db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL); INSERT INTO schema_migrations VALUES(1,0);');
  if (registered) await cutoverMemory({ paths, now: () => 1_800_000_000_000, id: crypto.randomUUID });
  const session: SqliteSession = registered ? new CutoverWriter(paths) : plainSession(db);
  const metrics: DocsMeasurement[] = []; let ticks = 0;
  const deps: DocsIndexDependencies = { enumerate: enumerateDocs, inspect: inspectDoc, checkStorage: checkDocsStorage, monotonic: () => ++ticks, measure: (value) => metrics.push(value) };
  const scope = { root: repo, projectId: CTX.projectId }; const query = new SqliteDocs(session, scope); const index = new SqliteDocsIndex(session, scope, deps);
  return { sb, repo, paths, db, session, scope, query, index, deps, metrics,
    rows() { return session.read((native) => native.prepare('SELECT * FROM docs ORDER BY seq').all()); },
    generation() { return registered ? Number(db.prepare('SELECT generation FROM bosun_source_floor').get()!.generation) : 0; },
    files() { return [footprint(primaryDir), footprint(viewDir), footprint(backups)]; },
    close() { session.close(); if (registered) db.close(); sb.cleanup(); },
  };
}

for (const registered of [false, true]) test(`ContextSource docs acceptance: ${registered ? 'registered' : 'plain'} actual query snapshot and admitted index`, async () => {
  const f = await fixture(registered); const source: ContextSource = f.query;
  try {
    assert.equal(source.id, 'docs'); assert.equal(source.trust, 'verified'); assert.equal(source.weight, 0.8); assert.equal(source.halfLifeDays, 90);
    if (registered) assert.throws(() => f.query.db, (error) => error instanceof MemoryError && error.code === 'unavailable');
    else assert.equal(f.query.db, f.db);
    const file = path.join(f.repo, 'guide with spaces.md');
    fs.writeFileSync(file, '# Zebra migration\nZebra migration deployment alpha beta.');
    assert.deepEqual(await source.search('zebra', CTX, 10), [], 'direct queries do not index live files');
    assert.equal(f.index.index().changed, 1);
    const row = f.rows()[0];
    const expected = f.session.read((native) => native.prepare(`SELECT d.path,d.title,d.mtime,snippet(docs_fts,1,'','','…',32) AS text,bm25(docs_fts) AS rank
      FROM docs_fts JOIN docs d ON d.seq=docs_fts.rowid WHERE docs_fts MATCH '"zebra"' ORDER BY bm25(docs_fts)`).get()!);
    const before = { rows: f.rows(), files: f.files(), generation: f.generation(), metrics: [...f.metrics], calls: f.sb.calls() };
    const hits = await source.search('zebra', CTX, 10);
    assert.deepEqual(hits, [{ source: 'docs', id: 'guide with spaces.md', title: expected.title, text: expected.text, category: 'doc', rank: expected.rank, at: expected.mtime, accessCount: 0 }]);
    assert.deepEqual(await source.search('zebra', { ...CTX, projectId: 'p_b' }, 10), []);
    assert.deepEqual(await source.search('zebra', { ...CTX, projectId: 'p_b', linked: ['p_a'] }, 10), hits);
    assert.deepEqual(await source.search('the a of', CTX, 10), []);
    assert.deepEqual({ rows: f.rows(), files: f.files(), generation: f.generation(), metrics: f.metrics, calls: f.sb.calls() }, before);
    fs.writeFileSync(file, '# Revised zebra\nRevised zebra content.'); fs.utimesSync(file, new Date(), new Date(Date.now() + 1000));
    assert.deepEqual(await source.search('zebra', CTX, 10), hits, 'snapshot is not a live filesystem revocation lease');
    const update = f.index.index(); assert.equal(update.changed, 1); assert.equal(f.rows()[0].seq, row.seq, 'UPSERT preserves seq/FTS identity');
    assert.equal((await source.search('revised', CTX, 10))[0].title, 'Revised zebra');
    fs.unlinkSync(file); assert.equal(f.index.index().removed, 1); assert.deepEqual(await source.search('zebra', CTX, 10), []);
    assert.ok(f.metrics.every((metric) => Object.keys(metric).sort().join(',') === 'ms,n,ok,op,removed'));
  } finally { f.close(); }
});

for (const registered of [false, true]) test(`docs disposition: ${registered ? 'registered' : 'plain'} stable rejects remove owned rows only; transient/race holds all`, async () => {
  const f = await fixture(registered);
  try {
    for (const file of ['deleted.md', 'oversized.md', 'directory.md', 'linked.md', 'ignored.md', 'keep.md']) fs.writeFileSync(path.join(f.repo, file), '# Zebra\nZebra document');
    assert.equal(f.index.index().changed, 6);
    fs.unlinkSync(path.join(f.repo, 'deleted.md'));
    fs.writeFileSync(path.join(f.repo, 'oversized.md'), Buffer.alloc(DOCS_MAX_BYTES + 1, 120));
    fs.unlinkSync(path.join(f.repo, 'directory.md')); fs.mkdirSync(path.join(f.repo, 'directory.md'));
    fs.unlinkSync(path.join(f.repo, 'linked.md')); fs.symlinkSync(path.join(f.sb.root, 'missing-private.md'), path.join(f.repo, 'linked.md'));
    fs.writeFileSync(path.join(f.repo, '.gitignore'), 'ignored.md\n');
    assert.equal(f.index.index().removed, 5);
    assert.deepEqual((await f.query.search('zebra', CTX, 10)).map((hit) => hit.id), ['keep.md']);
    const before = { rows: f.rows(), generation: f.generation(), files: f.files() };
    fs.writeFileSync(path.join(f.repo, 'new.md'), '# New zebra\nNew zebra document');
    const failing = new SqliteDocsIndex(f.session, f.scope, { ...f.deps, inspect(root, relative, mtime, read) {
      return relative === 'keep.md' ? { state: 'held' } : inspectDoc(root, relative, mtime, read);
    } });
    assert.equal(failing.index().state, 'held'); assert.deepEqual({ rows: f.rows(), generation: f.generation(), files: f.files() }, before);
    let checked = 0;
    const session: SqliteSession = { read: (fn) => f.session.read(fn), transaction: (fn) => {
      fs.appendFileSync(path.join(f.repo, 'new.md'), '\nRace changes approved source bytes'); return f.session.transaction(fn);
    }, close() {} };
    const racing = new SqliteDocsIndex(session, f.scope, { ...f.deps, inspect(...args) { checked++; return inspectDoc(...args); } });
    assert.equal(racing.index().state, 'held'); assert.ok(checked > 0);
    assert.deepEqual(f.rows(), before.rows); assert.equal(f.generation(), before.generation);
  } finally { f.close(); }
});

test('docs native count boundary: exactly 2000 accepted, incomplete/overflow listings hold; no content telemetry', async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 2000; i++) fs.writeFileSync(path.join(f.repo, `a${String(i).padStart(4, '0')}.md`), '# Zebra\nShort zebra document');
    assert.equal(f.index.index().changed, 2000);
    const before = { rows: f.rows(), files: f.files() };
    assert.equal(new SqliteDocsIndex(f.session, f.scope, { ...f.deps, enumerate: () => ({ complete: false }) }).index().state, 'held');
    assert.deepEqual({ rows: f.rows(), files: f.files() }, before);
    fs.writeFileSync(path.join(f.repo, 'overflow.md'), '# PRIVATE title\nPRIVATE body canary');
    assert.equal(f.index.index().state, 'held'); assert.deepEqual({ rows: f.rows(), files: f.files() }, before);
    assert.doesNotMatch(JSON.stringify(f.metrics), /PRIVATE|repo|zebra|\.md|body|title/i);
  } finally { f.close(); }
});

test('docs native file bound and aggregate hold are atomic; metrics failure cannot change committed receipt', async () => {
  const f = await fixture();
  try {
    fs.writeFileSync(path.join(f.repo, 'exact.md'), Buffer.alloc(DOCS_MAX_BYTES, 120));
    assert.equal(f.index.index().changed, 1);
    const seq = f.rows()[0].seq;
    fs.writeFileSync(path.join(f.repo, 'short.md'), '# Zebra\nShort zebra document');
    const throwing = new SqliteDocsIndex(f.session, f.scope, { ...f.deps, monotonic() { throw Error('PRIVATE clock'); }, measure() { throw Error('PRIVATE sink'); } });
    assert.equal(throwing.index().changed, 1); assert.equal(f.rows()[0].seq, seq);
    const before = { rows: f.rows(), files: f.files() };
    for (let i = 0; i < Math.ceil(DOCS_MAX_TOTAL_BYTES / DOCS_MAX_BYTES); i++) fs.writeFileSync(path.join(f.repo, `large-${i}.md`), Buffer.alloc(DOCS_MAX_BYTES, 120));
    assert.equal(f.index.index().state, 'held'); assert.deepEqual({ rows: f.rows(), files: f.files() }, before);
  } finally { f.close(); }
});

test('docs actual worktree roots and nested repositories preserve absolute keys and exclude ambiguous same-project descendants', async () => {
  const f = await fixture();
  try {
    const git = (...args: string[]) => { const result = spawnSync('git', ['-C', f.repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]); assert.equal(result.status, 0, String(result.stderr)); };
    fs.writeFileSync(path.join(f.repo, 'guide.md'), '# Zebra root\nZebra root document');
    fs.mkdirSync(path.join(f.repo, 'nested')); fs.writeFileSync(path.join(f.repo, 'nested/doc.md'), '# Zebra nested\nZebra nested document');
    git('add', 'guide.md', 'nested/doc.md'); git('commit', '-qm', 'synthetic documents');
    const other = path.join(f.sb.root, 'other-worktree'); git('worktree', 'add', '-q', '-b', 'other', other);
    assert.equal(f.index.index().changed, 2);
    const second = new SqliteDocsIndex(f.session, { root: other, projectId: 'p_a' }, f.deps); assert.equal(second.index().changed, 2);
    fs.unlinkSync(path.join(f.repo, 'guide.md')); assert.equal(f.index.index().removed, 1);
    assert.deepEqual((await new SqliteDocs(f.session, { root: other, projectId: 'p_a' }).search('zebra', CTX, 10)).map((hit) => hit.id).sort(), ['guide.md', 'nested/doc.md']);
    const nested = gitRepo(f.sb, 'repo/nested');
    const before = f.rows(); const result = f.index.index();
    assert.deepEqual(result.excludedRoots, [nested]); assert.deepEqual(f.rows(), before, 'same-project descendant ownership cannot be inferred from existing schema');
    assert.deepEqual(await new SqliteDocs(f.session, { ...f.scope, excludedRoots: result.excludedRoots }).search('zebra', CTX, 10), []);
    assert.equal((await new SqliteDocs(f.session, { root: nested, projectId: 'p_a' }).search('zebra', CTX, 10))[0].id, 'doc.md');
    const collision = new SqliteDocsIndex(f.session, { root: nested, projectId: 'p_b' }, f.deps);
    fs.appendFileSync(path.join(nested, 'doc.md'), '\nChanged nested document'); fs.utimesSync(path.join(nested, 'doc.md'), new Date(), new Date(Date.now() + 1000));
    assert.equal(collision.index().state, 'held'); assert.deepEqual(f.rows(), before, 'another project cannot adopt an existing absolute key');
  } finally { f.close(); }
});

test('docs native incomplete listing and process output overflow hold existing rows without source reads', async () => {
  const f = await fixture();
  try {
    fs.writeFileSync(path.join(f.repo, 'guide.md'), '# Zebra\nZebra retained snapshot'); f.index.index();
    const before = { rows: f.rows(), files: f.files() };
    const executable = path.join(f.sb.bin, 'git');
    const script = (output: string) => fs.writeFileSync(executable, `#!/usr/bin/env node\n${output}\n`, { mode: 0o755 });
    script("process.stdout.write('guide.md');");
    assert.deepEqual(enumerateDocs(f.repo), { complete: false }); assert.equal(f.index.index().state, 'held');
    script("process.stdout.write(Buffer.alloc(2*1024*1024+1,97));");
    assert.equal(f.index.index().state, 'held');
    assert.deepEqual({ rows: f.rows(), files: f.files() }, before);
  } finally { f.close(); }
});

test('docs native short read and file mutation during descriptor read hold before deletion, with no outside reads', async () => {
  const f = await fixture(); const read = fs.readSync;
  try {
    const old = path.join(f.repo, 'old.md'); const changing = path.join(f.repo, 'changing.md');
    fs.writeFileSync(old, '# Zebra\nZebra retained snapshot'); f.index.index(); fs.unlinkSync(old);
    fs.writeFileSync(changing, '# Zebra\nZebra changed source');
    const before = { rows: f.rows(), files: f.files() };
    fs.readSync = (() => 0) as typeof read;
    assert.equal(f.index.index().state, 'held'); fs.readSync = read;
    assert.deepEqual({ rows: f.rows(), files: f.files() }, before);
    let changed = false;
    fs.readSync = ((...args: any[]) => {
      const count = (read as any)(...args);
      if (!changed) { changed = true; fs.appendFileSync(changing, '\nPRIVATE race body'); }
      return count;
    }) as typeof read;
    assert.equal(f.index.index().state, 'held'); fs.readSync = read;
    assert.ok(changed); assert.deepEqual({ rows: f.rows(), files: f.files() }, before);
    const outside = path.join(f.sb.root, 'PRIVATE-directory'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'file.md'), '# PRIVATE title\nPRIVATE zebra body');
    fs.symlinkSync(outside, path.join(f.repo, 'link'));
    assert.equal(inspectDoc(f.repo, 'link/file.md').state, 'rejected');
    const configuredAlias = path.join(f.sb.root, 'alias'); fs.symlinkSync(f.repo, configuredAlias);
    assert.equal(resolveDocsRoot(configuredAlias), f.repo, 'configured alias resolves to the actual canonical root');
  } finally { fs.readSync = read; f.close(); }
});

test('docs registered READY lease permits snapshot SELECT while holding index writes; release revokes HOLD and fences old writer', async () => {
  const f = await fixture(true); let current: CutoverWriter | undefined; let lease: DatabaseSync | undefined;
  try {
    fs.writeFileSync(path.join(f.repo, 'guide.md'), '# Zebra\nZebra retained snapshot'); f.index.index();
    await publishMemoryView({ paths: f.paths, now: () => 1_800_000_000_000, id: crypto.randomUUID });
    await assert.rejects(f.query.search('zebra', CTX, 10), (error) => error instanceof MemoryError && error.code === 'unavailable');
    current = new CutoverWriter(f.paths); const query = new SqliteDocs(current, f.scope); const index = new SqliteDocsIndex(current, f.scope, f.deps);
    lease = new DatabaseSync(f.paths.view, { readOnly: true }); lease.exec('BEGIN');
    assert.equal(lease.prepare('SELECT state FROM bosun_public_state').get()!.state, 'READY');
    const before = { rows: f.db.prepare('SELECT * FROM docs ORDER BY seq').all(), generation: f.generation(), files: f.files() };
    assert.equal((await query.search('zebra', CTX, 10))[0].id, 'guide.md');
    assert.deepEqual({ rows: f.db.prepare('SELECT * FROM docs ORDER BY seq').all(), generation: f.generation(), files: f.files() }, before);
    fs.writeFileSync(path.join(f.repo, 'new.md'), '# Zebra\nZebra new document');
    assert.throws(() => index.index(), (error) => error instanceof MemoryError && error.code === 'unavailable');
    assert.equal(f.generation(), before.generation); assert.equal(lease.prepare('SELECT state FROM bosun_public_state').get()!.state, 'READY');
    lease.exec('ROLLBACK'); lease.close(); lease = undefined;
    assert.equal(index.index().changed, 1);
    const gate = new DatabaseSync(f.paths.view, { readOnly: true });
    try { assert.equal(gate.prepare('SELECT state FROM bosun_public_state').get()!.state, 'HOLD'); } finally { gate.close(); }
    assert.equal((await query.search('zebra', CTX, 10)).length, 2);
  } finally { lease?.close(); current?.close(); f.close(); }
});

for (const registered of [false, true]) test(`docs storage reservation and post-DML check: ${registered ? 'registered' : 'plain'} hold/rollback and finite metadata`, async () => {
  const f = await fixture(registered);
  try {
    fs.writeFileSync(path.join(f.repo, 'guide.md'), '# Zebra\nZebra retained snapshot'); f.index.index();
    fs.unlinkSync(path.join(f.repo, 'guide.md')); fs.writeFileSync(path.join(f.repo, 'new.md'), '# Zebra\nZebra new document');
    const before = { rows: f.rows(), generation: f.generation() };
    const full = new SqliteDocsIndex(f.session, f.scope, { ...f.deps, checkStorage: () => false });
    assert.equal(full.index().state, 'held'); assert.deepEqual({ rows: f.rows(), generation: f.generation() }, before);
    let storageChecks = 0;
    const post = new SqliteDocsIndex(f.session, f.scope, { ...f.deps, checkStorage: () => ++storageChecks < 3 });
    assert.throws(() => post.index(), (error) => error instanceof MemoryError && error.code === 'unavailable' && error.message === 'docs index unavailable');
    assert.deepEqual({ rows: f.rows(), generation: f.generation() }, before);
    assert.ok(f.metrics.at(-1)?.ok === false); assert.doesNotMatch(JSON.stringify(f.metrics), /guide|new|Zebra|repo/);
    assert.equal(f.session.read((db) => checkDocsStorage(db, 64 * 1024 * 1024)), false);
  } finally { f.close(); }
});

for (const registered of [false, true]) test(`docs actual CLI MCP/context: ${registered ? 'registered' : 'plain'} outside canaries, trusted projects, held enumeration and snapshots`, async () => {
  const f = await fixture(registered); let mcp: ReturnType<typeof mcpSession> | undefined;
  const env = f.sb.env({ BOSUN_HOME: path.dirname(f.paths.primary), CLAUDE_MEM: 'off', ...(registered ? { MEMORY_VIEW_PATH: f.paths.view, MEMORY_BACKUP_DIR: f.paths.backups } : {}) });
  try {
    const own = project(f.repo).id; const ownScope = { root: f.repo, projectId: own };
    const docs = new SqliteDocsIndex(f.session, ownScope, f.deps);
    fs.writeFileSync(path.join(f.repo, 'guide.md'), '# Zebra public\nZebra public deployment instructions'); assert.equal(docs.index().changed, 1);
    const outside = path.join(f.sb.root, 'PRIVATE-doc.md'); fs.writeFileSync(outside, '# PRIVATE-TITLE\nPRIVATE-BODY zebra');
    fs.symlinkSync(outside, path.join(f.repo, 'secret.md'));
    f.session.transaction((db) => db.prepare('INSERT INTO docs(path,project_id,mtime,title,body) VALUES(?,?,?,?,?)').run(path.join(f.repo, 'foreign.md'), 'p_foreign', 1, 'PRIVATE-FOREIGN-TITLE', 'PRIVATE-FOREIGN-BODY zebra'));
    const run = await bosun(['mcp'], { env, cwd: f.repo, input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'context_retrieve', arguments: { task: 'zebra deployment', sources: ['docs'] } } }) + '\n' });
    assert.equal(run.code, 0, run.err); assert.match(run.out, /Zebra public/); assert.doesNotMatch(run.out + run.err, /PRIVATE/);
    mcp = mcpSession(env, f.repo);
    assert.match((await mcp.call('project_knowledge_search', { query: 'zebra' })).result.structuredContent.hits[0].snippet, /public deployment/);
    const rejected = await mcp.call('context_retrieve', { task: 'zebra', sources: ['docs'], projectId: 'p_foreign' });
    assert.equal(rejected.result.isError, true); assert.doesNotMatch(JSON.stringify(rejected), /PRIVATE/);
    const before = f.rows(); fs.writeFileSync(path.join(f.repo, '.git/index'), 'invalid native git index');
    const held = await mcp.call('context_retrieve', { task: 'zebra', sources: ['docs'] });
    assert.equal(held.result.structuredContent.text, ''); assert.deepEqual(f.rows(), before);
    const direct = new SqliteDocs(f.session, ownScope);
    assert.equal((await direct.search('zebra', { ...CTX, projectId: own }, 10))[0].id, 'guide.md', 'explicit direct API serves the persisted snapshot without enumeration');
    const closed = await mcp.close(); mcp = undefined; assert.equal(closed.code, 0);
  } finally { await mcp?.close(); f.close(); }
});

test('docs direct child import has no ambient config, filesystem, git, indexing or measurement closure', () => {
  const sb = sandbox();
  try {
    const owner = path.join(sb.root, 'synthetic-owner'); fs.mkdirSync(owner); fs.writeFileSync(path.join(owner, 'PRIVATE-canary'), 'PRIVATE');
    const before = footprint(owner);
    const source = `import {DatabaseSync} from 'node:sqlite';
      import {SqliteDocs} from ${JSON.stringify(path.join(REPO, 'src/adapters/memory/sqlite-docs.ts'))};
      import {plainSession} from ${JSON.stringify(path.join(REPO, 'src/adapters/memory/sqlite-session.ts'))};
      const db=new DatabaseSync(':memory:');db.exec(${JSON.stringify(MIGRATIONS[0])});
      db.prepare('INSERT INTO docs(path,project_id,mtime,title,body) VALUES(?,?,?,?,?)').run('/synthetic/root/guide.md','p_a',100,'Zebra','Zebra native snapshot');
      const s=new SqliteDocs(plainSession(db),{root:'/synthetic/root',projectId:'p_a'});
      const hits=await s.search('zebra',{projectId:'p_a',sessionId:null,linked:[]},5);s.close();process.stdout.write(JSON.stringify(hits.map(h=>h.id)));`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { env: sb.env({ BOSUN_HOME: owner, MEMORY_SESSION_TTL_DAYS: 'PRIVATE BAD', MEMORY_VIEW_PATH: 'PRIVATE BAD' }), cwd: sb.root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), ['guide.md']);
    assert.deepEqual(footprint(owner), before); assert.deepEqual(sb.calls(), []);
  } finally { sb.cleanup(); }
});

test('docs compatibility refresh preserves ambiguous nested rows, replaces exclusion scope, and fails closed on a later hold', async () => {
  const f = await fixture(); const docs = new Docs(f.session, f.repo, 'p_a');
  try {
    fs.writeFileSync(path.join(f.repo, 'guide.md'), '# Zebra outer\nZebra outer public');
    fs.mkdirSync(path.join(f.repo, 'nested')); fs.writeFileSync(path.join(f.repo, 'nested/doc.md'), '# PRIVATE nested title\nPRIVATE nested zebra');
    assert.equal(docs.index().changed, 2);
    gitRepo(f.sb, 'repo/nested');
    assert.deepEqual((await docs.search('zebra', CTX, 10)).map((hit) => hit.id), ['guide.md']);
    const before = f.rows(); assert.equal(before.length, 2);
    fs.writeFileSync(path.join(f.repo, '.git/index'), 'invalid git index');
    assert.deepEqual(await docs.search('zebra', CTX, 10), []); assert.deepEqual(f.rows(), before);
  } finally { f.close(); }
});

test('docs source mutation after the admitted preflight rolls back every source DML and keeps errors content-free', async () => {
  const f = await fixture(true);
  try {
    const file = path.join(f.repo, 'guide.md'); fs.writeFileSync(file, '# Zebra\nZebra retained snapshot'); f.index.index();
    const before = { rows: f.rows(), generation: f.generation() };
    fs.writeFileSync(file, '# Zebra\nZebra updated source'); fs.utimesSync(file, new Date(), new Date(Date.now() + 1000));
    const racing = new SqliteDocsIndex(f.session, f.scope, { ...f.deps, checkStorage(db, reserve) {
      const allowed = checkDocsStorage(db, reserve);
      if (reserve) fs.appendFileSync(file, '\nPRIVATE after-preflight source race');
      return allowed;
    } });
    assert.throws(() => racing.index(), (error) => error instanceof MemoryError && error.message === 'docs index unavailable');
    assert.deepEqual({ rows: f.rows(), generation: f.generation() }, before);
    assert.doesNotMatch(JSON.stringify(f.metrics), /PRIVATE|guide|repo/);
  } finally { f.close(); }
});

for (const registered of [false, true]) test(`docs actual oversized source plus WAL: ${registered ? 'registered' : 'plain'} existing 64MiB admission remains held`, async () => {
  const f = await fixture(registered);
  try {
    fs.writeFileSync(path.join(f.repo, 'guide.md'), '# Zebra\nZebra retained snapshot'); f.index.index();
    const before = f.db.prepare('SELECT * FROM docs ORDER BY seq').all();
    fs.writeFileSync(path.join(f.repo, 'new.md'), '# Zebra\nZebra new document');
    fs.truncateSync(f.paths.primary, 64 * 1024 * 1024 + 1);
    const files = f.files();
    let checks = 0; let inspected = 0;
    const index = new SqliteDocsIndex(f.session, f.scope, { ...f.deps,
      checkStorage(db, reserve) { checks++; return f.deps.checkStorage(db, reserve); },
      inspect(...args) { inspected++; return f.deps.inspect(...args); },
    });
    assert.equal(index.index().state, 'held');
    assert.equal(checks, registered ? 0 : 1, 'registered admission rejects before native read callback; plain uses its storage preflight');
    assert.equal(inspected, 0, 'both held paths precede source payload inspection');
    if (registered) assert.throws(() => new CutoverWriter(f.paths));
    assert.deepEqual(f.db.prepare('SELECT * FROM docs ORDER BY seq').all(), before); assert.deepEqual(f.files(), files);
  } finally { f.close(); }
});

test('docs native COMMIT followed by error preserves finite unknown receipt, committed row/FTS and fenced session', async () => {
  const f = await fixture(true); const exec = DatabaseSync.prototype.exec; let source: DatabaseSync | undefined; let commits = 0;
  try {
    fs.writeFileSync(path.join(f.repo, 'guide.md'), '# Zebra\nZebra committed document');
    const index = new SqliteDocsIndex(f.session, f.scope, { ...f.deps,
      checkStorage(db, reserved) { if (reserved) source = db; return f.deps.checkStorage(db, reserved); },
    });
    DatabaseSync.prototype.exec = function (sql) {
      const result = exec.call(this, sql);
      if (this === source && sql === 'COMMIT') { commits++; throw new MemoryError('conflict', 'PRIVATE docs commit canary', 99); }
      return result;
    };
    assert.throws(() => index.index(), (error: unknown) => {
      assert.ok(error instanceof BosunError); assert.equal(error.code, 'unavailable'); assert.equal(error.message, 'docs index unavailable');
      assert.equal(error.details?.outcome, 'unknown'); assert.equal(error.details?.currentVersion, undefined);
      assert.deepEqual(modelMemoryError(error), { code: 'unavailable', message: 'memory unavailable' }); return true;
    });
    assert.equal(commits, 1);
    const rows = f.db.prepare('SELECT path,title,body FROM docs').all(); assert.equal(rows.length, 1); assert.equal(rows[0].body, '# Zebra\nZebra committed document');
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM docs_fts WHERE docs_fts MATCH 'committed'").get()!.n, 1);
    assert.equal(f.generation(), 1); assert.equal(f.metrics.at(-1)?.ok, false); assert.doesNotMatch(JSON.stringify(f.metrics), /PRIVATE|guide|repo/);
    let replay = 0; assert.throws(() => f.session.transaction(() => { replay++; })); assert.equal(replay, 0);
    const reopened = new CutoverWriter(f.paths);
    try { assert.equal(reopened.read((db) => db.prepare('SELECT body FROM docs').get()!.body), '# Zebra\nZebra committed document'); }
    finally { reopened.close(); }
  } finally { DatabaseSync.prototype.exec = exec; f.close(); }
});
