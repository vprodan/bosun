import "./bootstrap.ts";
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { sandbox, fresh, bosun, gitRepo, REPO, type Sandbox } from './helpers.ts';
import { load, P } from '../lib/config.ts';
import { log } from '../lib/log.ts';
import { MemoryService } from '../lib/memory/service.ts';
import { openDb, schemaVersion, MIGRATIONS, terms } from '../lib/memory/sqlite.ts';
import { makeCtx, normalizeOrigin, project } from '../lib/memory/project.ts';
import { MemoryError, type Ctx } from '../lib/memory/types.ts';
import { hookObservation } from '../lib/memory/bench.ts';

const A: Ctx = { projectId: 'p_a', sessionId: 's1', linked: [] };
const B: Ctx = { projectId: 'p_b', sessionId: 's2', linked: [] };
const DAY = 86400000;
function svc(sb: Sandbox): MemoryService { fresh(sb); return new MemoryService(openDb(P.DB), load()); }   // P.DB read after fresh()
const code = (c: string) => (e: unknown) => e instanceof MemoryError && e.code === c;
const spawnSyncGit = (cwd: string, ...a: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd });

test('memory: store/get/search round trip, FTS ranking, tags filter, limit cap, access counted', async () => {
  const sb = sandbox();
  try {
    const s = svc(sb);
    const a = await s.store({ category: 'project', title: 'Cart uses pnpm', body: 'Always run pnpm install in cart-service; npm breaks the lockfile.', tags: ['tooling'] }, A);
    assert.equal(a.duplicate, false);
    assert.match(a.memory.id, /^m_[0-9a-v]{9}[0-9a-f]{8}$/);
    assert.deepEqual(await s.get(a.memory.id, A), a.memory);
    await s.store({ category: 'project', title: 'Deploys', body: 'Deploys go through ArgoCD; pnpm is not involved.', tags: ['deploy'] }, A);
    assert.deepEqual((await s.search({ text: 'pnpm lockfile' }, A)).map((h) => h.title), ['Cart uses pnpm', 'Deploys'], 'more matching terms rank first');
    assert.deepEqual((await s.search({ text: 'pnpm', tags: ['deploy'] }, A)).map((h) => h.title), ['Deploys']);
    assert.ok((await s.get(a.memory.id, A)).accessCount >= 1, 'a search counts as access');
    for (let i = 0; i < 60; i++) await s.store({ category: 'project', title: `note ${i}`, body: `pnpm note number ${i}` }, A);
    assert.equal((await s.search({ text: 'pnpm', limit: 50 }, A)).length, 50);
    await assert.rejects(s.search({ text: 'pnpm', limit: 51 }, A), code('invalid'));
    assert.equal((await s.search({}, A)).length, 10, 'no text lists the newest');
    s.close();
  } finally { sb.cleanup(); }
});

test('memory: update checks the version and recomputes the hash; duplicates conflict; delete archives; purge only archived; events audit it all', async () => {
  const sb = sandbox();
  try {
    const s = svc(sb);
    const m = (await s.store({ category: 'project', title: 'T1', body: 'first body' }, A)).memory;
    const n = (await s.store({ category: 'project', title: 'T2', body: 'second body' }, A)).memory;
    await assert.rejects(s.update(m.id, { body: 'x' }, 2, A), (e) => code('conflict')(e) && (e as MemoryError).current === 1);
    const u = await s.update(m.id, { body: 'first body, edited' }, 1, A);
    assert.equal(u.version, 2);
    assert.notEqual(u.hash, m.hash);
    await assert.rejects(s.update(n.id, { title: 'T1', body: 'first body, edited' }, 1, A), (e) => code('conflict')(e) && /duplicate of m_/.test((e as Error).message));
    await assert.rejects(s.purge(n.id, A), code('invalid'));
    const d = await s.delete(n.id, A);
    assert.equal(d.status, 'archived');
    assert.equal((await s.delete(n.id, A)).version, d.version, 'delete is idempotent');
    await s.purge(n.id, A);
    await assert.rejects(s.get(n.id, A), code('not_found'));
    assert.deepEqual((await s.get(m.id, A, { events: true })).events!.map((e) => e.op), ['store', 'update']);
    const ops = (s.db.prepare('SELECT op FROM memory_events WHERE memory_id = ? ORDER BY id').all(n.id) as { op: string }[]).map((r) => r.op);
    assert.deepEqual(ops, ['store', 'archive', 'purge'], 'the audit trail outlives the content');
    s.close();
  } finally { sb.cleanup(); }
});

test('memory: an exact duplicate returns the existing memory; the hash ignores case and whitespace; category is part of the key', async () => {
  const sb = sandbox();
  try {
    const s = svc(sb);
    const a = await s.store({ category: 'personal', title: 'Indent', body: 'I prefer  two-space\nindentation' }, A);
    const b = await s.store({ category: 'personal', title: 'indent', body: 'i prefer two-space indentation' }, B);
    assert.equal(b.duplicate, true);
    assert.equal(b.memory.id, a.memory.id, 'personal memories dedupe across projects');
    assert.equal((await s.store({ category: 'project', title: 'Indent', body: 'I prefer two-space indentation' }, A)).duplicate, false);
    s.close();
  } finally { sb.cleanup(); }
});

test('memory: isolation — own project, personal, shared and linked are readable; other ids are not found; writes stay in scope', async () => {
  const sb = sandbox();
  try {
    const s = svc(sb);
    const pa = (await s.store({ category: 'project', title: 'A plan', body: 'alpha project detail' }, A)).memory;
    const pb = (await s.store({ category: 'project', title: 'B plan', body: 'beta project detail' }, B)).memory;
    const me = (await s.store({ category: 'personal', title: 'Me', body: 'personal project detail' }, A)).memory;
    const sh = (await s.store({ category: 'project', title: 'Shared B', body: 'shared project detail', shared: true }, B)).memory;
    const ids = async (ctx: Ctx) => (await s.search({ text: 'project detail' }, ctx)).map((h) => h.id).sort();
    assert.deepEqual(await ids(A), [pa.id, me.id, sh.id].sort());
    assert.deepEqual(await ids(B), [pb.id, me.id, sh.id].sort());
    await assert.rejects(s.get(pb.id, A), (e) => code('not_found')(e) && (e as Error).message === 'memory not found');
    await assert.rejects(s.update(pb.id, { body: 'x' }, 1, A), code('not_found'));
    assert.ok((await ids({ ...A, linked: ['p_b'] })).includes(pb.id), 'linked projects are readable');
    await assert.rejects(s.update(sh.id, { body: 'x' }, 1, A), /another project/);
    await assert.rejects(s.store({ category: 'project', title: 't', body: 'b' }, { ...A, projectId: null }), code('invalid'));
    s.close();
  } finally { sb.cleanup(); }
});

test('memory: legacy SQLite privacy/sharing flags are classified conservatively without rewriting stored flags', async () => {
  const sb = sandbox(); const s = svc(sb);
  const values = [0, 1, '', ' ', 'false', -1, 2, 0.5, new Uint8Array(), new Uint8Array([48]), '0', '1'];
  try {
    for (const [i, flag] of values.entries()) {
      const input = { category: 'project' as const, title: `Legacy flag ${i}`, body: `Legacy constellation fixture ${i}`, tags: ['legacy'], source: 'owner-fixture', sourceRef: 'fixture-ref' };
      const m = (await s.store(input, A)).memory;
      s.db.prepare('UPDATE memories SET private=?, shared=? WHERE id=?').run(flag, flag, m.id);
      const raw = () => s.db.prepare('SELECT typeof(private) AS privacyType, hex(private) AS privacyBytes, typeof(shared) AS sharingType, hex(shared) AS sharingBytes FROM memories WHERE id=?').get(m.id)!;
      const flags = raw();
      const publicFlag = flags.privacyType === 'integer' && flags.privacyBytes === '30';
      const sharedFlag = flags.sharingType === 'integer' && flags.sharingBytes === '31';
      const owner = await s.get(m.id, A, { events: true });
      assert.equal(owner.private, !publicFlag, `private ${i}/${flags.privacyType}`);
      assert.equal(owner.shared, sharedFlag, `shared ${i}/${flags.sharingType}`);
      assert.equal(owner.id, m.id); assert.equal(owner.body, input.body); assert.equal(owner.sourceRef, input.sourceRef);
      const dup = await s.store({ ...input, private: false, shared: true }, A);
      assert.equal(dup.duplicate, true); assert.equal(dup.memory.id, m.id); assert.equal(dup.memory.version, 1);
      assert.equal(dup.memory.private, !publicFlag); assert.equal(dup.memory.shared, sharedFlag);
      assert.deepEqual(raw(), flags, 'duplicate does not adopt requested public/shared flags');
      const edited = await s.update(m.id, { body: `${input.body} edited` }, 1, A);
      assert.equal(edited.id, m.id); assert.equal(edited.version, 2); assert.equal(edited.private, !publicFlag); assert.equal(edited.shared, sharedFlag);
      assert.notEqual(edited.hash, m.hash); assert.deepEqual(raw(), flags, 'omitted flags preserve exact SQLite storage');
      const archived = await s.delete(m.id, A);
      assert.equal(archived.id, m.id); assert.equal(archived.version, 3); assert.equal(archived.private, !publicFlag);
      assert.equal((await s.delete(m.id, A)).version, 3); assert.deepEqual(raw(), flags);
      assert.deepEqual((await s.get(m.id, A, { events: true })).events!.map((e) => e.op), ['store', 'update', 'archive']);
      const reclassified = await s.update(m.id, { status: 'active', private: false, shared: false }, 3, A);
      assert.equal(reclassified.id, m.id); assert.equal(reclassified.version, 4); assert.equal(reclassified.private, false); assert.equal(reclassified.shared, false);
      assert.equal(raw().privacyType, 'integer'); assert.equal(raw().privacyBytes, '30');
      assert.equal((await s.search({ includePrivate: false, touch: false, limit: 50 }, A)).find((hit) => hit.id === m.id)?.id, m.id);
    }
  } finally { s.close(); sb.cleanup(); }
});

test('memory: legacy flag filtering precedes DTO/tag projection and grants sharing only for stored integer one', async () => {
  const sb = sandbox(); const s = svc(sb);
  try {
    const publicNote = (await s.store({ category: 'project', title: 'Constellation public', body: 'Constellation public scope' }, A)).memory;
    const protectedIds: string[] = []; const sharedIds: string[] = []; const unsharedIds: string[] = [];
    for (const [i, flag] of ['', 'false', -1, 2, 0.5, new Uint8Array(), new Uint8Array([48])].entries()) {
      const note = (await s.store({ category: 'project', title: `Constellation protected ${i}`, body: `Constellation protected scope ${i}` }, A)).memory;
      s.db.prepare('UPDATE memories SET private=? WHERE id=?').run(flag, note.id); protectedIds.push(note.id);
      assert.equal((await s.get(note.id, A)).private, true);
      const foreign = (await s.store({ category: 'project', title: `Constellation foreign ${i}`, body: `Constellation foreign scope ${i}` }, B)).memory;
      s.db.prepare('UPDATE memories SET shared=? WHERE id=?').run(flag, foreign.id); unsharedIds.push(foreign.id);
      assert.equal((await s.get(foreign.id, B)).shared, false);
      await assert.rejects(s.get(foreign.id, A), code('not_found'));
      assert.equal((await s.get(foreign.id, { ...A, linked: ['p_b'] })).id, foreign.id);
      await assert.rejects(s.update(foreign.id, { body: 'foreign edit' }, 1, { ...A, linked: ['p_b'] }), code('invalid'));
    }
    for (const flag of [1, '1']) {
      const note = (await s.store({ category: 'project', title: `Constellation shared ${sharedIds.length}`, body: `Constellation shared scope ${sharedIds.length}` }, B)).memory;
      s.db.prepare('UPDATE memories SET shared=? WHERE id=?').run(flag, note.id); sharedIds.push(note.id);
      assert.equal(s.db.prepare('SELECT typeof(shared) AS type FROM memories WHERE id=?').get(note.id)!.type, 'integer', 'INTEGER affinity normalizes numeric text');
      assert.equal((await s.get(note.id, A)).shared, true);
    }
    const ids = async (text?: string, includePrivate = false, ctx = A) => (await s.search({ text, includePrivate, touch: false, limit: 50 }, ctx)).map((h) => h.id).sort();
    for (const text of [undefined, 'constellation']) {
      assert.deepEqual(await ids(text), [publicNote.id, ...sharedIds].sort());
      assert.deepEqual(await ids(text, true), [publicNote.id, ...sharedIds, ...protectedIds].sort(), 'owner can inspect protected records');
      assert.deepEqual(await ids(text, false, { ...A, linked: ['p_b'] }), [publicNote.id, ...sharedIds, ...unsharedIds].sort());
    }
    // Payload parsing is forbidden for records rejected by the public SQL query.
    s.db.prepare('UPDATE memories SET tags=? WHERE id IN (SELECT value FROM json_each(?))').run('PRIVATE-LEGACY-TAG-PROJECTION-CANARY', JSON.stringify(protectedIds));
    for (const text of [undefined, 'constellation']) assert.deepEqual(await ids(text), [publicNote.id, ...sharedIds].sort());
  } finally { s.close(); sb.cleanup(); }
});

test('project: ssh, https and other origin spellings are one project; worktrees share an id; fallbacks without a remote', () => {
  const sb = sandbox();
  try {
    fresh(sb);
    for (const u of ['git@github.com:Org/Repo.git', 'https://github.com/org/repo', 'https://user:tok@github.com/org/repo.git/', 'ssh://git@github.com:22/org/repo.git', 'github.com:org/repo']) {
      assert.equal(normalizeOrigin(u), 'github.com/org/repo', u);
    }
    const r1 = gitRepo(sb, 'one', 'git@github.com:org/repo.git');
    const r2 = gitRepo(sb, 'two', 'https://github.com/Org/Repo');
    assert.equal(project(r1).id, project(r2).id, 'a clone on another machine is the same project');
    assert.equal(project(r1).name, 'repo');
    fs.mkdirSync(path.join(r1, 'src'));
    assert.equal(project(path.join(r1, 'src')).id, project(r1).id, 'subdirectories too');
    const r3 = gitRepo(sb, 'three');
    const wt = path.join(sb.root, 'three-wt');
    spawnSyncGit(r3, 'worktree', 'add', '-q', wt);
    assert.equal(project(wt).id, project(r3).id, 'a worktree of a repo without a remote shares its id');
    assert.equal(project(wt).name, 'three');
    const plain = path.join(sb.root, 'plain');
    fs.mkdirSync(plain);
    assert.match(project(plain).id, /^p_[0-9a-f]{16}$/);
    assert.equal(project(plain).name, 'plain');
  } finally { sb.cleanup(); }
});

test('memory: session memories expire into archived on open; prune purges old archived ones', async () => {
  const sb = sandbox();
  try {
    const s1 = svc(sb);
    const m = (await s1.store({ category: 'session', title: 'wip', body: 'session scratch' }, A)).memory;
    assert.equal(m.expiresAt, m.createdAt + 7 * DAY);
    assert.equal(m.sessionId, 's1');
    s1.db.prepare('UPDATE memories SET expires_at = ? WHERE id = ?').run(Date.now() - 1, m.id);
    s1.close();
    const s2 = svc(sb);
    const g = await s2.get(m.id, A, { events: true });
    assert.equal(g.status, 'archived');
    assert.equal(g.events!.at(-1)!.op, 'expire');
    s2.db.prepare('UPDATE memories SET updated_at = ? WHERE id = ?').run(Date.now() - 91 * DAY, m.id);
    assert.deepEqual(s2.prune(), { archived: 0, purged: 1 });
    await assert.rejects(s2.get(m.id, A), code('not_found'));
    s2.close();
  } finally { sb.cleanup(); }
});

test('memory: validation limits, and error messages never quote content', async () => {
  const sb = sandbox();
  try {
    const s = svc(sb);
    const ok = { category: 'project', title: 't', body: 'b' };
    const bad: object[] = [
      { ...ok, category: 'nope' }, { ...ok, title: '' }, { ...ok, title: '   ' }, { ...ok, title: 'x'.repeat(201) },
      { ...ok, body: 'x'.repeat(4001) }, { ...ok, tags: Array(13).fill('a') }, { ...ok, tags: ['Bad Tag'] },
      { ...ok, tags: ['x'.repeat(41)] }, { ...ok, ttlDays: 0 }, { ...ok, projectId: 'p_b' },
    ];
    for (const input of bad) await assert.rejects(s.store(input as never, A), code('invalid'), JSON.stringify(input).slice(0, 60));
    await assert.rejects(s.store({ category: 'project', title: `${'x'.repeat(201)}SECRET`, body: 'b' }, A), (e) => !(e as Error).message.includes('SECRET'));
    assert.equal((await s.store({ ...ok, tags: ['a', 'a'] } as never, A)).memory.tags.length, 1);
    s.close();
  } finally { sb.cleanup(); }
});

test('memory: user text never becomes FTS syntax', async () => {
  const sb = sandbox();
  try {
    const s = svc(sb);
    await s.store({ category: 'project', title: 'Quotes', body: 'he said "NEAR" and AND OR NOT then (x*) -y col:val 日本語 🚀' }, A);
    for (const q of ['"', '"unbalanced', 'a AND', 'NEAR(a b)', '(x*', '-y', 'col:val', 'title:hack', '*', '日本語', '🚀', 'OR OR', "'; DROP TABLE memories; --"]) {
      await s.search({ text: q }, A);
    }
    assert.equal((await s.search({ text: 'NEAR' }, A)).length, 1, 'NEAR is a plain word');
    assert.equal((await s.search({ text: '日本語' }, A)).length, 1);
    assert.equal((await s.search({ text: 'the a of' }, A)).length, 0, 'only stop words: no search, not a listing');
    assert.deepEqual(terms('fetchCart get_cart HTTPServer the a'), ['fetchcart', 'fetch', 'cart', 'get_cart', 'get', 'httpserver', 'http', 'server']);
    assert.equal(terms('word '.repeat(10) + Array.from({ length: 40 }, (_, i) => `t${i}x`).join(' ')).length, 24, 'capped');
    s.close();
  } finally { sb.cleanup(); }
});

test('memory: concurrent writers wait instead of failing; a new database opened by three processes at once migrates once', async () => {
  const sb = sandbox();
  try {
    fresh(sb);
    const file = path.join(sb.root, 'c.db');
    const node = (src: string, ...args: string[]) => spawn(process.execPath, ['--input-type=module', '-e', src, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const exit = (p: ReturnType<typeof spawn>) => new Promise<number>((res) => p.on('close', (c) => res(c ?? 1)));
    const opener = `import { openDb } from ${JSON.stringify(path.join(REPO, 'lib', 'memory', 'sqlite.ts'))}; openDb(process.argv[1]).close();`;
    assert.deepEqual(await Promise.all([0, 1, 2].map(() => exit(node(opener, file)))), [0, 0, 0]);
    const s = new MemoryService(openDb(file), load());
    assert.equal(schemaVersion(s.db), MIGRATIONS.length);
    const holder = node(`import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(process.argv[1]); db.exec('BEGIN IMMEDIATE'); console.log('locked'); setTimeout(() => db.exec('COMMIT'), 400);`, file);
    await new Promise((res) => holder.stdout!.once('data', res));
    const t = Date.now();
    await s.store({ category: 'project', title: 'while locked', body: 'waits for the other writer' }, A);
    assert.ok(Date.now() - t >= 100, 'it waited for the lock');
    assert.equal(await exit(holder), 0);
    s.close();
  } finally { sb.cleanup(); }
});

test('migrations: fresh → latest; v1 → v2; a failing migration rolls back and leaves the database as it was; file mode 0600', () => {
  const sb = sandbox();
  try {
    fresh(sb);
    const file = path.join(sb.root, 'm.db');
    const db = openDb(file);
    assert.equal(schemaVersion(db), MIGRATIONS.length);
    db.close();
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const v2 = [...MIGRATIONS, 'CREATE TABLE extra (x INTEGER)'];
    const db2 = openDb(file, v2);
    assert.equal(schemaVersion(db2), 2);
    db2.close();
    assert.throws(() => openDb(file, [...v2, 'CREATE TABLE ok_part (x INTEGER); CREATE TABLE memories (x INTEGER);']), /already exists/);
    const db3 = openDb(file, v2);
    assert.equal(schemaVersion(db3), 2);
    assert.equal((db3.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'ok_part'").get() as { n: number }).n, 0, 'rolled back');
    db3.close();
  } finally { sb.cleanup(); }
});

test('memory: private memories stay out of search unless asked; logs and metrics never hold content', async () => {
  const sb = sandbox();
  try {
    const s = svc(sb);
    const p = (await s.store({ category: 'project', title: 'Private SECRET-TITLE', body: 'SECRET-BODY value', private: true }, A)).memory;
    assert.equal((await s.search({ text: 'value' }, A)).length, 0);
    assert.equal((await s.search({ text: 'value', includePrivate: true }, A)).length, 1);
    await s.get(p.id, A);
    await s.update(p.id, { body: 'SECRET-BODY two' }, 1, A);
    await assert.rejects(s.store({ category: 'project', title: 'SECRET-TITLE', body: 'x'.repeat(4001) }, A));
    log('warn', 'test', { title: 'SECRET-TITLE', err: new SyntaxError('Unexpected token S, "SECRET-BODY" is not valid JSON') });
    for (const f of ['bosun.log', 'metrics.jsonl']) assert.doesNotMatch(fs.readFileSync(path.join(P.BOSUN, f), 'utf8'), /SECRET/, f);
    s.close();
  } finally { sb.cleanup(); }
});

test('memory cli: add, duplicate, search, get with events, update, delete, purge, proposals, stats, bad usage', async () => {
  const sb = sandbox();
  try {
    const repo = gitRepo(sb, 'shop', 'git@github.com:org/shop.git');
    const run = (...a: string[]) => bosun(['memory', ...a], { env: sb.env(), cwd: repo });
    let r = await run('add', '-t', 'Use pnpm', '--tags', 'tooling,cart', 'Always pnpm install; npm breaks the lockfile.');
    assert.equal(r.code, 0, r.err);
    const id = r.out.match(/m_[0-9a-v]{9}[0-9a-f]{8}/)![0];
    assert.match((await run('add', '-t', 'Use pnpm', 'Always pnpm install; npm breaks the lockfile.')).out, new RegExp(`duplicate of ${id}`));
    r = await run('search', 'lockfile', '--json');
    assert.equal(JSON.parse(r.out)[0].id, id);
    r = await run('get', id);
    assert.match(r.out, /Always pnpm install/);
    assert.match(r.out, /store\s+cli/, 'the audit trail shows who stored it');
    assert.match((await run('update', id, '-b', 'Always pnpm; never npm.')).out, /version 2/);
    assert.match((await run('delete', id)).out, /archived/);
    assert.equal((await run('purge', id)).code, 0);
    assert.equal((await run('get', id)).code, 1);
    r = await run('add', '-c', 'session', '--private', 'scratch note for today');
    assert.match(r.out, /session, private/);

    fresh(sb);
    const s = new MemoryService(openDb(P.DB), load());
    const ctx = makeCtx(load(), project(repo));
    const p1 = (await s.store({ category: 'project', title: 'Proposal one', body: 'first proposal', status: 'proposed', source: 'test' }, ctx)).memory;
    const p2 = (await s.store({ category: 'project', title: 'Proposal two', body: 'second proposal', status: 'proposed', source: 'test' }, ctx)).memory;
    const p3 = (await s.store({ category: 'project', title: 'Proposal three', body: 'third proposal', status: 'proposed', source: 'test' }, ctx)).memory;
    s.close();
    assert.match((await run('accept', p1.id)).out, /accepted/);
    assert.match((await run('reject', p2.id)).out, /rejected/);
    assert.equal((await run('accept', p1.id)).code, 1, 'only proposals can be accepted');
    r = await bosun(['memory', 'review'], { env: sb.env(), cwd: repo, input: 'a\n' });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Proposal three/);
    assert.match((await run('get', p3.id)).out, /active/);
    assert.match((await bosun(['memory', 'review'], { env: sb.env(), cwd: repo })).out, /no proposals/);

    r = await run('stats');
    assert.match(r.out, /memory\.store/);
    assert.match(r.out, new RegExp(`project ${project(repo).id} \\(shop\\)`));
    assert.equal((await run('bogus')).code, 2);
    assert.equal((await run('add')).code, 2);
    assert.equal((await run('search', '--nope')).code, 2);
  } finally { sb.cleanup(); }
});

test('memory bench and eval: measured numbers, nothing in your own stats', async () => {
  const sb = sandbox();
  try {
    const repo = gitRepo(sb, 'shop', 'git@github.com:org/shop.git');
    const r = await bosun(['memory', 'bench', '--n', '300'], { env: sb.env(), cwd: repo });
    assert.equal(r.code, 0, r.err);
    for (const k of ['store', 'search', 'context', 'hook']) assert.match(r.out, new RegExp(`${k}\\s.*p50 [\\d.]+ ms\\s+p95 [\\d.]+ ms`), k);
    assert.match(r.out, /budget\s+200\/200 within ~400 tokens/);
    assert.match(r.out, /outcomes 0 verified memory injections, 20 no-memory\/held, 0 failed, 0 unqualified/);
    assert.match(r.out, /hook mem unqualified: no verified memory injection; no retrieval latency reported/);
    assert.doesNotMatch(r.out, /hook mem\s+p50|the memory part inside the hook/);
    assert.ok(!fs.existsSync(path.join(sb.home, '.bosun', 'metrics.jsonl')), 'bench metrics stay out of your stats');
    fresh(sb);
    const s = new MemoryService(openDb(P.DB), load());
    const ctx = makeCtx(load(), project(repo));
    const a = (await s.store({ category: 'project', title: 'Deploys', body: 'ArgoCD deploys main to production' }, ctx)).memory;
    const b = (await s.store({ category: 'project', title: 'Tests', body: 'run pnpm test before pushing' }, ctx)).memory;
    s.close();
    const q = path.join(sb.root, 'q.jsonl');
    fs.writeFileSync(q, [{ query: 'how do deploys work', relevant: [a.id] }, { query: 'pnpm test', relevant: [b.id] }, { query: 'nothing matches', relevant: [a.id] }].map((x) => JSON.stringify(x)).join('\n'));
    const e = await bosun(['memory', 'eval', q], { env: sb.env(), cwd: repo });
    assert.match(e.out, /3 queries\s+recall@5 0\.667\s+MRR 0\.667/);
  } finally { sb.cleanup(); }
});

test('benchmark hook evidence rejects failed children and mismatched/missing outcomes before claiming retrieval timing', () => {
  const stdout = JSON.stringify({ hookSpecificOutput: { additionalContext: '[bosun memory: 1 note; memory_get <id> for details]\n- [curated project 2026-10-05 m_public] Public: public body' } });
  const metric = { op: 'hook', ms: 3, n: 1, estTokens: 30 };
  assert.deepEqual(hookObservation({ status: 0, stdout }, metric), { outcome: 'injected', ms: 3 });
  assert.deepEqual(hookObservation({ status: 1, get stdout(): string { throw Error('failed child output must not be consumed as retrieval'); } }, metric), { outcome: 'failed' });
  for (const child of [{ status: null, stdout, error: new Error('synthetic spawn failure') }, { status: 0, stdout, signal: 'SIGTERM' }]) {
    assert.deepEqual(hookObservation(child, metric), { outcome: 'failed' });
  }
  for (const result of [hookObservation({ status: 0, stdout }, null), hookObservation({ status: 0, stdout }, { ...metric, n: 2 }),
    hookObservation({ status: 0, stdout: '' }, metric), hookObservation({ status: 0, stdout: 'not JSON' }, metric)]) {
    assert.deepEqual(result, { outcome: 'unqualified' });
  }
  assert.deepEqual(hookObservation({ status: 0, stdout: '' }, { ...metric, n: 0, estTokens: 0 }), { outcome: 'no-memory' });
});

test('explicit 10k public-view bench delivers actual native hook notes while preserving owner paths, epoch and stats', async () => {
  const sb = sandbox();
  try {
    const repo = gitRepo(sb, 'bench-public', 'git@github.com:org/bench-public.git');
    const owner = path.join(sb.root, 'owner-storage'); fs.mkdirSync(owner);
    const primary = path.join(sb.home, '.bosun', 'memory.db'); fs.mkdirSync(path.dirname(primary));
    const files = [primary, path.join(owner, 'public.db'), path.join(owner, 'claude-mem.db')];
    for (const file of files) fs.writeFileSync(file, 'OWNER STORAGE CANARY');
    const backups = path.join(owner, 'backups'); fs.mkdirSync(backups); fs.writeFileSync(path.join(backups, 'untouched'), 'OWNER BACKUP CANARY');
    const env = sb.env({ MEMORY_VIEW_PATH: files[1], MEMORY_BACKUP_DIR: backups, MEMORY_SOURCE_ID: '55555555-5555-4555-8555-555555555555',
      MEMORY_URL: 'http://owner.invalid', CLAUDE_MEM_DB: files[2] });
    const r = await bosun(['memory', 'bench', '--n', '10000', '--public-view'], { env, cwd: repo });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /10000 memories \(synthetic, seed 42\)/);
    assert.match(r.out, /outcomes 20 verified memory injections, 0 no-memory\/held, 0 failed, 0 unqualified/);
    assert.match(r.out, /hook mem\s+p50 [\d.]+ ms\s+p95 [\d.]+ ms\s+\(verified injected runs only, 20 runs\)/);
    assert.match(r.out, /public\s+READY \(explicit synthetic apply\/publish\/binding\)/);
    assert.doesNotMatch(r.out + r.err, /OWNER|55555555|owner\.invalid/);
    for (const file of files) assert.equal(fs.readFileSync(file, 'utf8'), 'OWNER STORAGE CANARY');
    assert.equal(fs.readFileSync(path.join(backups, 'untouched'), 'utf8'), 'OWNER BACKUP CANARY');
    assert.ok(!fs.existsSync(path.join(sb.home, '.bosun', 'metrics.jsonl')));
    assert.deepEqual(fs.readdirSync(path.dirname(primary)).sort(), ['bosun.log', 'config.env', 'memory.db'], 'normal CLI config/content-free logging creates no other owner memory artifacts');
    assert.doesNotMatch(fs.readFileSync(path.join(path.dirname(primary), 'bosun.log'), 'utf8'), /OWNER|PRIVATE|55555555/);
    for (const args of [['memory', 'bench', '--n', '10001', '--public-view'], ['memory', 'bench', '--n', '0'], ['memory', 'stats', '--public-view']]) {
      const invalid = await bosun(args, { env, cwd: repo }); assert.equal(invalid.code, 2, invalid.err);
    }
    console.log('Synthetic public-view bench qualification: 10000 generated memories, 20/20 verified native hook injections; timings are machine observations, designated-Mac p95 unqualified.');
  } finally { sb.cleanup(); }
});

test('memory: an expired session memory leaves search in a long-running process, not only on the next open', async () => {
  const sb = sandbox();
  try {
    const s = svc(sb);
    const m = (await s.store({ category: 'session', title: 'wip', body: 'session scratch pad' }, A)).memory;
    s.db.prepare('UPDATE memories SET expires_at = ? WHERE id = ?').run(Date.now() - 1, m.id);
    assert.equal((await s.search({ text: 'scratch pad' }, A)).length, 0);
    assert.equal((await s.get(m.id, A)).status, 'archived');
    s.close();
  } finally { sb.cleanup(); }
});
