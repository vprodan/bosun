import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SqliteDatabase } from '../src/platform/sqlite.ts';
import { spawn, spawnSync } from 'node:child_process';
import { sandbox, fresh, bosun, gitRepo, REPO, type Sandbox } from './helpers.ts';
import { terms } from '../src/core/text.ts';
import { MEMORY_MIGRATIONS } from '../src/adapters/memory/sqlite-schema.ts';
import { CutoverWriter, cutoverMemory, type CutoverPaths } from '../src/adapters/memory/sqlite-cutover.ts';
import { normalizeOrigin, project } from '../src/platform/project.ts';
import { MemoryError } from '../src/core/errors.ts';
import type { Ctx } from '../src/core/domain/memory.ts';
import { benchmarkHookOutcome } from '../src/core/memory-benchmark.ts';
import { createTestMemoryStore, openSchemaOneMemory, prepareTestRuntime, testCutoverPaths } from './memory-store-fixture.ts';
import type { SqliteMemoryStore } from '../src/adapters/memory/sqlite-store.ts';

const A: Ctx = { projectId: 'p_a', sessionId: 's1', linked: [] };
const B: Ctx = { projectId: 'p_b', sessionId: 's2', linked: [] };
const DAY = 86400000;
function svc(sb: Sandbox): SqliteMemoryStore {
  fresh(sb);
  const paths = prepareTestRuntime();
  return createTestMemoryStore(openSchemaOneMemory(paths.memory));
}
const code = (c: string) => (e: unknown) => e instanceof MemoryError && e.code === c;
const spawnSyncGit = (cwd: string, ...a: string[]) =>
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd });

test('memory: store/get/search round trip, FTS ranking, tags filter, limit cap and explicit access tracking', async () => {
  const sb = sandbox();
  try {
    const s = svc(sb);
    const a = await s.store(
      {
        category: 'project',
        title: 'Cart uses pnpm',
        body: 'Always run pnpm install in cart-service; npm breaks the lockfile.',
        tags: ['tooling'],
      },
      A,
    );
    assert.equal(a.duplicate, false);
    assert.match(a.memory.id, /^m_[0-9a-v]{9}[0-9a-f]{8}$/);
    assert.deepEqual(await s.get(a.memory.id, A), a.memory);
    await s.store(
      {
        category: 'project',
        title: 'Deploys',
        body: 'Deploys go through ArgoCD; pnpm is not involved.',
        tags: ['deploy'],
      },
      A,
    );
    assert.deepEqual(
      (await s.search({ text: 'pnpm lockfile' }, A)).map((h) => h.title),
      ['Cart uses pnpm', 'Deploys'],
      'more matching terms rank first',
    );
    assert.deepEqual(
      (await s.search({ text: 'pnpm', tags: ['deploy'] }, A)).map((h) => h.title),
      ['Deploys'],
    );
    assert.equal((await s.get(a.memory.id, A)).accessCount, 0, 'queries do not mutate access metadata');
    s.touch([a.memory.id]);
    assert.equal((await s.get(a.memory.id, A)).accessCount, 1, 'explicit touch tracks access');
    for (let i = 0; i < 60; i++)
      await s.store({ category: 'project', title: `note ${i}`, body: `pnpm note number ${i}` }, A);
    assert.equal((await s.search({ text: 'pnpm', limit: 50 }, A)).length, 50);
    await assert.rejects(s.search({ text: 'pnpm', limit: 51 }, A), code('invalid'));
    assert.equal((await s.search({}, A)).length, 10, 'no text lists the newest');
    s.close();
  } finally {
    sb.cleanup();
  }
});

test('memory: update checks the version and recomputes the hash; duplicates conflict; delete archives; purge only archived; events audit it all', async () => {
  const sb = sandbox();
  try {
    const s = svc(sb);
    const m = (await s.store({ category: 'project', title: 'T1', body: 'first body' }, A)).memory;
    const n = (await s.store({ category: 'project', title: 'T2', body: 'second body' }, A)).memory;
    await assert.rejects(
      s.update(m.id, { body: 'x' }, 2, A),
      (e) => code('conflict')(e) && (e as MemoryError).current === 1,
    );
    const u = await s.update(m.id, { body: 'first body, edited' }, 1, A);
    assert.equal(u.version, 2);
    assert.notEqual(u.hash, m.hash);
    await assert.rejects(
      s.update(n.id, { title: 'T1', body: 'first body, edited' }, 1, A),
      (e) => code('conflict')(e) && /duplicate of m_/.test((e as Error).message),
    );
    await assert.rejects(s.purge(n.id, A), code('invalid'));
    const d = await s.delete(n.id, A);
    assert.equal(d.status, 'archived');
    assert.equal((await s.delete(n.id, A)).version, d.version, 'delete is idempotent');
    await s.purge(n.id, A);
    await assert.rejects(s.get(n.id, A), code('not_found'));
    assert.deepEqual(
      (await s.get(m.id, A, { events: true })).events!.map((e) => e.op),
      ['store', 'update'],
    );
    const ops = (
      s.db.prepare('SELECT op FROM memory_events WHERE memory_id = ? ORDER BY id').all(n.id) as {
        op: string;
      }[]
    ).map((r) => r.op);
    assert.deepEqual(ops, ['store', 'archive', 'purge'], 'the audit trail outlives the content');
    s.close();
  } finally {
    sb.cleanup();
  }
});

test('memory: an exact duplicate returns the existing memory; the hash ignores case and whitespace; category is part of the key', async () => {
  const sb = sandbox();
  try {
    const s = svc(sb);
    const a = await s.store(
      { category: 'personal', title: 'Indent', body: 'I prefer  two-space\nindentation' },
      A,
    );
    const b = await s.store(
      { category: 'personal', title: 'indent', body: 'i prefer two-space indentation' },
      B,
    );
    assert.equal(b.duplicate, true);
    assert.equal(b.memory.id, a.memory.id, 'personal memories dedupe across projects');
    assert.equal(
      (
        await s.store(
          { category: 'project', title: 'Indent', body: 'I prefer two-space indentation' },
          A,
        )
      ).duplicate,
      false,
    );
    s.close();
  } finally {
    sb.cleanup();
  }
});

test('memory: isolation — own project, personal, shared and linked are readable; other ids are not found; writes stay in scope', async () => {
  const sb = sandbox();
  try {
    const s = svc(sb);
    const pa = (
      await s.store({ category: 'project', title: 'A plan', body: 'alpha project detail' }, A)
    ).memory;
    const pb = (
      await s.store({ category: 'project', title: 'B plan', body: 'beta project detail' }, B)
    ).memory;
    const me = (
      await s.store({ category: 'personal', title: 'Me', body: 'personal project detail' }, A)
    ).memory;
    const sh = (
      await s.store(
        { category: 'project', title: 'Shared B', body: 'shared project detail', shared: true },
        B,
      )
    ).memory;
    const ids = async (ctx: Ctx) =>
      (await s.search({ text: 'project detail' }, ctx)).map((h) => h.id).sort();
    assert.deepEqual(await ids(A), [pa.id, me.id, sh.id].sort());
    assert.deepEqual(await ids(B), [pb.id, me.id, sh.id].sort());
    await assert.rejects(
      s.get(pb.id, A),
      (e) => code('not_found')(e) && (e as Error).message === 'memory not found',
    );
    await assert.rejects(s.update(pb.id, { body: 'x' }, 1, A), code('not_found'));
    assert.ok(
      (await ids({ ...A, linked: ['p_b'] })).includes(pb.id),
      'linked projects are readable',
    );
    await assert.rejects(s.update(sh.id, { body: 'x' }, 1, A), /another project/);
    await assert.rejects(
      s.store({ category: 'project', title: 't', body: 'b' }, { ...A, projectId: null }),
      code('invalid'),
    );
    s.close();
  } finally {
    sb.cleanup();
  }
});

test('memory: legacy SQLite privacy/sharing flags are classified conservatively without rewriting stored flags', async () => {
  const sb = sandbox();
  const s = svc(sb);
  const values = [
    0,
    1,
    '',
    ' ',
    'false',
    -1,
    2,
    0.5,
    new Uint8Array(),
    new Uint8Array([48]),
    '0',
    '1',
  ];
  try {
    for (const [i, flag] of values.entries()) {
      const input = {
        category: 'project' as const,
        title: `Legacy flag ${i}`,
        body: `Legacy constellation fixture ${i}`,
        tags: ['legacy'],
        source: 'owner-fixture',
        sourceRef: 'fixture-ref',
      };
      const m = (await s.store(input, A)).memory;
      s.db.prepare('UPDATE memories SET private=?, shared=? WHERE id=?').run(flag, flag, m.id);
      const raw = () =>
        s.db
          .prepare(
            'SELECT typeof(private) AS privacyType, hex(private) AS privacyBytes, typeof(shared) AS sharingType, hex(shared) AS sharingBytes FROM memories WHERE id=?',
          )
          .get(m.id)!;
      const flags = raw();
      const publicFlag = flags.privacyType === 'integer' && flags.privacyBytes === '30';
      const sharedFlag = flags.sharingType === 'integer' && flags.sharingBytes === '31';
      const owner = await s.get(m.id, A, { events: true });
      assert.equal(owner.private, !publicFlag, `private ${i}/${flags.privacyType}`);
      assert.equal(owner.shared, sharedFlag, `shared ${i}/${flags.sharingType}`);
      assert.equal(owner.id, m.id);
      assert.equal(owner.body, input.body);
      assert.equal(owner.sourceRef, input.sourceRef);
      const dup = await s.store({ ...input, private: false, shared: true }, A);
      assert.equal(dup.duplicate, true);
      assert.equal(dup.memory.id, m.id);
      assert.equal(dup.memory.version, 1);
      assert.equal(dup.memory.private, !publicFlag);
      assert.equal(dup.memory.shared, sharedFlag);
      assert.deepEqual(raw(), flags, 'duplicate does not adopt requested public/shared flags');
      const edited = await s.update(m.id, { body: `${input.body} edited` }, 1, A);
      assert.equal(edited.id, m.id);
      assert.equal(edited.version, 2);
      assert.equal(edited.private, !publicFlag);
      assert.equal(edited.shared, sharedFlag);
      assert.notEqual(edited.hash, m.hash);
      assert.deepEqual(raw(), flags, 'omitted flags preserve exact SQLite storage');
      const archived = await s.delete(m.id, A);
      assert.equal(archived.id, m.id);
      assert.equal(archived.version, 3);
      assert.equal(archived.private, !publicFlag);
      assert.equal((await s.delete(m.id, A)).version, 3);
      assert.deepEqual(raw(), flags);
      assert.deepEqual(
        (await s.get(m.id, A, { events: true })).events!.map((e) => e.op),
        ['store', 'update', 'archive'],
      );
      const reclassified = await s.update(
        m.id,
        { status: 'active', private: false, shared: false },
        3,
        A,
      );
      assert.equal(reclassified.id, m.id);
      assert.equal(reclassified.version, 4);
      assert.equal(reclassified.private, false);
      assert.equal(reclassified.shared, false);
      assert.equal(raw().privacyType, 'integer');
      assert.equal(raw().privacyBytes, '30');
      assert.equal(
        (await s.search({ includePrivate: false, touch: false, limit: 50 }, A)).find(
          (hit) => hit.id === m.id,
        )?.id,
        m.id,
      );
    }
  } finally {
    s.close();
    sb.cleanup();
  }
});

test('memory: legacy flag filtering precedes DTO/tag projection and grants sharing only for stored integer one', async () => {
  const sb = sandbox();
  const s = svc(sb);
  try {
    const publicNote = (
      await s.store(
        { category: 'project', title: 'Constellation public', body: 'Constellation public scope' },
        A,
      )
    ).memory;
    const protectedIds: string[] = [];
    const sharedIds: string[] = [];
    const unsharedIds: string[] = [];
    for (const [i, flag] of [
      '',
      'false',
      -1,
      2,
      0.5,
      new Uint8Array(),
      new Uint8Array([48]),
    ].entries()) {
      const note = (
        await s.store(
          {
            category: 'project',
            title: `Constellation protected ${i}`,
            body: `Constellation protected scope ${i}`,
          },
          A,
        )
      ).memory;
      s.db.prepare('UPDATE memories SET private=? WHERE id=?').run(flag, note.id);
      protectedIds.push(note.id);
      assert.equal((await s.get(note.id, A)).private, true);
      const foreign = (
        await s.store(
          {
            category: 'project',
            title: `Constellation foreign ${i}`,
            body: `Constellation foreign scope ${i}`,
          },
          B,
        )
      ).memory;
      s.db.prepare('UPDATE memories SET shared=? WHERE id=?').run(flag, foreign.id);
      unsharedIds.push(foreign.id);
      assert.equal((await s.get(foreign.id, B)).shared, false);
      await assert.rejects(s.get(foreign.id, A), code('not_found'));
      assert.equal((await s.get(foreign.id, { ...A, linked: ['p_b'] })).id, foreign.id);
      await assert.rejects(
        s.update(foreign.id, { body: 'foreign edit' }, 1, { ...A, linked: ['p_b'] }),
        code('invalid'),
      );
    }
    for (const flag of [1, '1']) {
      const note = (
        await s.store(
          {
            category: 'project',
            title: `Constellation shared ${sharedIds.length}`,
            body: `Constellation shared scope ${sharedIds.length}`,
          },
          B,
        )
      ).memory;
      s.db.prepare('UPDATE memories SET shared=? WHERE id=?').run(flag, note.id);
      sharedIds.push(note.id);
      assert.equal(
        s.db.prepare('SELECT typeof(shared) AS type FROM memories WHERE id=?').get(note.id)!.type,
        'integer',
        'INTEGER affinity normalizes numeric text',
      );
      assert.equal((await s.get(note.id, A)).shared, true);
    }
    const ids = async (text?: string, includePrivate = false, ctx = A) =>
      (await s.search({ text, includePrivate, touch: false, limit: 50 }, ctx))
        .map((h) => h.id)
        .sort();
    for (const text of [undefined, 'constellation']) {
      assert.deepEqual(await ids(text), [publicNote.id, ...sharedIds].sort());
      assert.deepEqual(
        await ids(text, true),
        [publicNote.id, ...sharedIds, ...protectedIds].sort(),
        'owner can inspect protected records',
      );
      assert.deepEqual(
        await ids(text, false, { ...A, linked: ['p_b'] }),
        [publicNote.id, ...sharedIds, ...unsharedIds].sort(),
      );
    }
    // Payload parsing is forbidden for records rejected by the public SQL query.
    s.db
      .prepare('UPDATE memories SET tags=? WHERE id IN (SELECT value FROM json_each(?))')
      .run('PRIVATE-LEGACY-TAG-PROJECTION-CANARY', JSON.stringify(protectedIds));
    for (const text of [undefined, 'constellation'])
      assert.deepEqual(await ids(text), [publicNote.id, ...sharedIds].sort());
  } finally {
    s.close();
    sb.cleanup();
  }
});

test('project: ssh, https and other origin spellings are one project; worktrees share an id; fallbacks without a remote', () => {
  const sb = sandbox();
  try {
    fresh(sb);
    for (const u of [
      'git@github.com:Org/Repo.git',
      'https://github.com/org/repo',
      'https://user:tok@github.com/org/repo.git/',
      'ssh://git@github.com:22/org/repo.git',
      'github.com:org/repo',
    ]) {
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
    assert.equal(
      project(wt).id,
      project(r3).id,
      'a worktree of a repo without a remote shares its id',
    );
    assert.equal(project(wt).name, 'three');
    const plain = path.join(sb.root, 'plain');
    fs.mkdirSync(plain);
    assert.match(project(plain).id, /^p_[0-9a-f]{16}$/);
    assert.equal(project(plain).name, 'plain');
  } finally {
    sb.cleanup();
  }
});

test('memory: explicit retention archives expired sessions and prunes old archives', async () => {
  const sb = sandbox();
  try {
    const s1 = svc(sb);
    const m = (await s1.store({ category: 'session', title: 'wip', body: 'session scratch' }, A))
      .memory;
    assert.equal(m.expiresAt, m.createdAt + 7 * DAY);
    assert.equal(m.sessionId, 's1');
    s1.db.prepare('UPDATE memories SET expires_at = ? WHERE id = ?').run(Date.now() - 1, m.id);
    s1.close();
    const s2 = svc(sb);
    assert.equal(s2.expire(), 1);
    const g = await s2.get(m.id, A, { events: true });
    assert.equal(g.status, 'archived');
    assert.equal(g.events!.at(-1)!.op, 'expire');
    s2.db
      .prepare('UPDATE memories SET updated_at = ? WHERE id = ?')
      .run(Date.now() - 91 * DAY, m.id);
    assert.deepEqual(s2.prune(), { archived: 0, purged: 1 });
    await assert.rejects(s2.get(m.id, A), code('not_found'));
    s2.close();
  } finally {
    sb.cleanup();
  }
});

test('memory: validation limits, and error messages never quote content', async () => {
  const sb = sandbox();
  try {
    const s = svc(sb);
    const ok = { category: 'project', title: 't', body: 'b' };
    const bad: object[] = [
      { ...ok, category: 'nope' },
      { ...ok, title: '' },
      { ...ok, title: '   ' },
      { ...ok, title: 'x'.repeat(201) },
      { ...ok, body: 'x'.repeat(4001) },
      { ...ok, tags: Array(13).fill('a') },
      { ...ok, tags: ['Bad Tag'] },
      { ...ok, tags: ['x'.repeat(41)] },
      { ...ok, ttlDays: 0 },
      { ...ok, projectId: 'p_b' },
    ];
    for (const input of bad)
      await assert.rejects(
        s.store(input as never, A),
        code('invalid'),
        JSON.stringify(input).slice(0, 60),
      );
    await assert.rejects(
      s.store({ category: 'project', title: `${'x'.repeat(201)}SECRET`, body: 'b' }, A),
      (e) => !(e as Error).message.includes('SECRET'),
    );
    assert.equal((await s.store({ ...ok, tags: ['a', 'a'] } as never, A)).memory.tags.length, 1);
    s.close();
  } finally {
    sb.cleanup();
  }
});

test('memory: user text never becomes FTS syntax', async () => {
  const sb = sandbox();
  try {
    const s = svc(sb);
    await s.store(
      {
        category: 'project',
        title: 'Quotes',
        body: 'he said "NEAR" and AND OR NOT then (x*) -y col:val 日本語 🚀',
      },
      A,
    );
    for (const q of [
      '"',
      '"unbalanced',
      'a AND',
      'NEAR(a b)',
      '(x*',
      '-y',
      'col:val',
      'title:hack',
      '*',
      '日本語',
      '🚀',
      'OR OR',
      "'; DROP TABLE memories; --",
    ]) {
      await s.search({ text: q }, A);
    }
    assert.equal((await s.search({ text: 'NEAR' }, A)).length, 1, 'NEAR is a plain word');
    assert.equal((await s.search({ text: '日本語' }, A)).length, 1);
    assert.equal(
      (await s.search({ text: 'the a of' }, A)).length,
      0,
      'only stop words: no search, not a listing',
    );
    assert.deepEqual(terms('fetchCart get_cart HTTPServer the a'), [
      'fetchcart',
      'fetch',
      'cart',
      'get_cart',
      'get',
      'httpserver',
      'http',
      'server',
    ]);
    assert.equal(
      terms('word '.repeat(10) + Array.from({ length: 40 }, (_, i) => `t${i}x`).join(' ')).length,
      24,
      'capped',
    );
    s.close();
  } finally {
    sb.cleanup();
  }
});

test('memory: concurrent writers wait instead of failing', async () => {
  const sb = sandbox();
  try {
    fresh(sb);
    const file = path.join(sb.root, 'c.db');
    const node = (src: string, ...args: string[]) =>
      spawn(process.execPath, ['--input-type=module', '-e', src, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    const exit = (p: ReturnType<typeof spawn>) =>
      new Promise<number>((res) => p.on('close', (c) => res(c ?? 1)));
    const initial = openSchemaOneMemory(file); initial.close();
    const s = createTestMemoryStore(openSchemaOneMemory(file));
    const holder = node(
      `import { SqliteDatabase } from ${JSON.stringify(path.join(REPO, 'src/platform/sqlite.ts'))}; const db = new SqliteDatabase(process.argv[1]); db.exec('BEGIN IMMEDIATE'); console.log('locked'); setTimeout(() => db.exec('COMMIT'), 400);`,
      file,
    );
    await new Promise((res) => holder.stdout!.once('data', res));
    const t = Date.now();
    await s.store(
      { category: 'project', title: 'while locked', body: 'waits for the other writer' },
      A,
    );
    assert.ok(Date.now() - t >= 100, 'it waited for the lock');
    assert.equal(await exit(holder), 0);
    s.close();
  } finally {
    sb.cleanup();
  }
});

test('supported schema-1 owner upgrade commits schema 2 behind the cutover floor and preserves a schema-1 backup', async () => {
  const sb = sandbox();
  let writer: CutoverWriter | undefined;
  let db: SqliteDatabase | undefined;
  try {
    fresh(sb);
    const runtime = prepareTestRuntime();
    const paths: CutoverPaths = testCutoverPaths(runtime);
    fs.mkdirSync(path.dirname(paths.view), { recursive: true, mode: 0o700 });
    fs.mkdirSync(paths.backups, { recursive: true, mode: 0o700 });
    db = openSchemaOneMemory(paths.primary);
    db.prepare("INSERT INTO memories(id,category,title,body,source,hash,created_at,updated_at) VALUES('m_legacy','personal','Legacy','Preserved','owner','hash',1,1)").run();
    db.close(); db = undefined;
    const receipt = await cutoverMemory({ paths, now: Date.now, id: crypto.randomUUID, upgradeSchema: true });
    writer = new CutoverWriter(paths);
    assert.equal(writer.schemaVersion, 2);
    assert.equal(receipt.state, 'HOLD');
    assert.equal(MEMORY_MIGRATIONS.length, 2);
    assert.equal(fs.statSync(paths.primary).mode & 0o777, 0o600);
    db = new SqliteDatabase(paths.primary, { readOnly: true });
    assert.deepEqual(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((row) => row.version), [1, 2]);
    assert.deepEqual(db.prepare('SELECT id,title,body FROM memories').all().map((row) => ({ ...row })), [{ id: 'm_legacy', title: 'Legacy', body: 'Preserved' }]);
    const backupFile = path.join(paths.backups, receipt.attemptId + '.db');
    const backup = new SqliteDatabase(backupFile, { readOnly: true });
    try {
      assert.deepEqual(backup.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((row) => row.version), [1]);
      assert.deepEqual(backup.prepare('SELECT id,title,body FROM memories').all().map((row) => ({ ...row })), [{ id: 'm_legacy', title: 'Legacy', body: 'Preserved' }]);
      assert.equal(backup.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='graph_artifacts'").get()!.n, 0);
    } finally { backup.close(); }
  } finally {
    writer?.close(); db?.close();
    sb.cleanup();
  }
});

test('memory: private memories stay out of search unless asked', async () => {
  const sb = sandbox();
  try {
    const s = svc(sb);
    const p = (
      await s.store(
        {
          category: 'project',
          title: 'Private SECRET-TITLE',
          body: 'SECRET-BODY value',
          private: true,
        },
        A,
      )
    ).memory;
    assert.equal((await s.search({ text: 'value' }, A)).length, 0);
    assert.equal((await s.search({ text: 'value', includePrivate: true }, A)).length, 1);
    await s.get(p.id, A);
    await s.update(p.id, { body: 'SECRET-BODY two' }, 1, A);
    await assert.rejects(
      s.store({ category: 'project', title: 'SECRET-TITLE', body: 'x'.repeat(4001) }, A),
    );
    s.close();
  } finally {
    sb.cleanup();
  }
});

test('memory bench: measured numbers, no owner files or unsupported retrieval timings', async () => {
  const sb = sandbox();
  try {
    const repo = gitRepo(sb, 'shop', 'git@github.com:org/shop.git');
    const r = await bosun(['memory', 'bench', '--n', '300'], { env: sb.env(), cwd: repo });
    assert.equal(r.code, 0, r.err);
    const report = JSON.parse(r.out);
    for (const k of ['store', 'search', 'context']) {
      assert.ok(report[k].p50 >= 0 && report[k].p95 >= report[k].p50, k);
      assert.equal(report[k].samples, k === 'store' ? 300 : 200);
    }
    assert.equal(report.tokens.withinEstimate, 200);
    assert.ok(report.tokens.maximumEstimate <= 400);
    assert.equal(report.tokens.hostTokens, 'unverified');
    assert.deepEqual(report.hook.outcomes, { injected: 0, held: 20, failed: 0, unqualified: 0 });
    assert.equal(report.hook.wall.samples, 20);
    assert.deepEqual(report.hook.verifiedInjectionWall, { samples: 0, p50: null, p95: null });
    assert.equal(report.hook.componentLatency, null);
    assert.equal(report.hook.processCompletion, 'original-and-group-confirmed');
    assert.equal(report.ownerStorageOpened, false);
    assert.equal(report.modelsCalled, false);
    assert.ok(
      !fs.existsSync(path.join(sb.home, '.bosun')),
      'benchmark must not initialize owner state',
    );
    assert.ok(
      !fs.existsSync(path.join(sb.home, '.bosun', 'metrics.jsonl')),
      'bench metrics stay out of your stats',
    );
  } finally {
    sb.cleanup();
  }
});

test('benchmark requires a successful child, valid envelope and exact synthetic note identities', () => {
  const envelope = (body: string) =>
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: body },
    });
  const body =
    '[bosun memory: 1 note; memory_get <id> for details]\n- [curated project 2026-10-05 m_public] Public: public body';
  const stdout = envelope(body),
    ids = new Set(['m_public']);
  assert.equal(benchmarkHookOutcome({ status: 0, stdout }, ids), 'injected');
  assert.equal(
    benchmarkHookOutcome(
      {
        status: 1,
        get stdout(): string {
          throw Error('failed child output must not be consumed');
        },
      },
      ids,
    ),
    'failed',
  );
  for (const child of [
    { status: null, stdout, error: new Error('synthetic spawn failure') },
    { status: 0, stdout, signal: 'SIGTERM' },
  ])
    assert.equal(benchmarkHookOutcome(child, ids), 'failed');
  for (const output of [
    envelope(body.replace('1 note', '2 notes')),
    envelope(body.replace('m_public', 'm_foreign')),
    'not JSON',
    stdout + '\n' + stdout,
    envelope(
      body.replace('1 note', '2 notes') +
        '\n- [curated project 2026-10-05 m_public] Duplicate: public body',
    ),
    JSON.stringify({ hookSpecificOutput: { additionalContext: body } }),
  ])
    assert.equal(benchmarkHookOutcome({ status: 0, stdout: output }, ids), 'unqualified');
  assert.equal(benchmarkHookOutcome({ status: 0, stdout: '' }, ids), 'held');
});

// This explicit 10k diagnostic is not a two-minute performance SLA; retain
// its full corpus and assertions on slower contained hosted runners.
test('explicit 10k public-view bench delivers actual native hook notes while preserving owner paths, epoch and stats', { timeout: 600000 }, async () => {
  const sb = sandbox();
  try {
    const repo = gitRepo(sb, 'bench-public', 'git@github.com:org/bench-public.git');
    const owner = path.join(sb.root, 'owner-storage');
    fs.mkdirSync(owner);
    const primary = path.join(sb.home, '.bosun', 'memory.db');
    fs.mkdirSync(path.dirname(primary));
    const files = [primary, path.join(owner, 'public.db'), path.join(owner, 'claude-mem.db')];
    for (const file of files) fs.writeFileSync(file, 'OWNER STORAGE CANARY');
    const backups = path.join(owner, 'backups');
    fs.mkdirSync(backups);
    fs.writeFileSync(path.join(backups, 'untouched'), 'OWNER BACKUP CANARY');
    const env = sb.env({
      MEMORY_VIEW_PATH: files[1],
      MEMORY_BACKUP_DIR: backups,
      MEMORY_SOURCE_ID: '55555555-5555-4555-8555-555555555555',
      MEMORY_URL: 'http://owner.invalid',
      CLAUDE_MEM_DB: files[2],
      CLAUDE_PROJECT_DIR: path.join(sb.root, 'wrong-scope'),
    });
    const r = await bosun(['memory', 'bench', '--n', '10000', '--public-view'], { env, cwd: repo });
    assert.equal(r.code, 0, r.err);
    const report = JSON.parse(r.out);
    assert.deepEqual(report.corpus, { notes: 10000, seed: 42, synthetic: true });
    assert.equal(report.store.samples, 10000);
    assert.equal(report.corpusLoading.epochNotes, 256);
    assert.equal(report.corpusLoading.lifecycle.samples, 39);
    assert.equal(report.search.samples, 200);
    assert.equal(report.context.samples, 200);
    assert.equal(report.hook.firstRun.outcome, 'injected');
    assert.deepEqual(report.hook.outcomes, { injected: 20, held: 0, failed: 0, unqualified: 0 });
    assert.equal(report.hook.verifiedInjectionWall.samples, 20);
    assert.ok(report.hook.verifiedInjectionWall.p95 >= report.hook.verifiedInjectionWall.p50);
    assert.equal(report.hook.componentLatency, null);
    assert.equal(report.hook.processCompletion, 'original-and-group-confirmed');
    assert.equal(report.designatedMacLatency, 'unverified');
    assert.equal(report.publicView, 'ready-synthetic');
    assert.doesNotMatch(r.out + r.err, /OWNER|55555555|owner\.invalid/);
    for (const file of files) assert.equal(fs.readFileSync(file, 'utf8'), 'OWNER STORAGE CANARY');
    assert.equal(fs.readFileSync(path.join(backups, 'untouched'), 'utf8'), 'OWNER BACKUP CANARY');
    assert.ok(!fs.existsSync(path.join(sb.home, '.bosun', 'metrics.jsonl')));
    assert.deepEqual(
      fs.readdirSync(path.dirname(primary)),
      ['memory.db'],
      'entire owner footprint stays unchanged',
    );
    for (const args of [
      ['memory', 'bench', '--n', '10001', '--public-view'],
      ['memory', 'bench', '--n', '0'],
      ['memory', 'stats', '--public-view'],
    ]) {
      const invalid = await bosun(args, { env, cwd: repo });
      assert.equal(invalid.code, 2, invalid.err);
    }
    console.log(
      'Synthetic public-view bench qualification: 10000 generated memories, 20/20 verified native hook injections; timings are machine observations, designated-Mac p95 unqualified.',
    );
  } finally {
    sb.cleanup();
  }
});

test('memory: explicit retention archives expired sessions in a long-running process', async () => {
  const sb = sandbox();
  try {
    const s = svc(sb);
    const m = (await s.store({ category: 'session', title: 'wip', body: 'session scratch pad' }, A))
      .memory;
    s.db.prepare('UPDATE memories SET expires_at = ? WHERE id = ?').run(Date.now() - 1, m.id);
    assert.equal((await s.search({ text: 'scratch pad' }, A)).length, 0);
    assert.equal(s.expire(), 1);
    assert.equal((await s.get(m.id, A)).status, 'archived');
    s.close();
  } finally {
    sb.cleanup();
  }
});
