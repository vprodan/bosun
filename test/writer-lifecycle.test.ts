import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { SqliteDatabase } from '../src/platform/sqlite.ts';
import { sandbox, fresh, gitRepo, bosun, mcpSession } from './helpers.ts';
import { createTestMemoryStore, openSchemaOneMemory, openTestLocalMemory, prepareTestRuntime, testCutoverPaths } from './memory-store-fixture.ts';
import { MemoryError } from '../src/core/errors.ts';
import type { Ctx } from '../src/core/domain/memory.ts';
import { memoryLifecycleFixture, completedMemoryJob } from './memory-lifecycle-fixture.ts';
import { remoteFixture } from './remote-fixture.ts';
import { BosunError } from '../src/core/errors.ts';
import { project } from '../src/platform/project.ts';
import { startDaemon } from '../src/app/daemon.ts';
import {
  cutoverMemory,
  CutoverWriter,
  CutoverError,
  type CutoverPaths,
} from '../src/adapters/memory/sqlite-cutover.ts';

const DAY = 86400000;
const domain = (code: string) => (e: unknown) => e instanceof MemoryError && e.code === code;
const writerBusy = (e: unknown) =>
  e instanceof CutoverError && e.code === 'unavailable' && e.reason === 'busy' &&
  e.message === 'memory cutover unavailable (busy)' && e.cause === undefined;
function storageTree(file: string): unknown {
  const stat = fs.lstatSync(file, { bigint: true });
  return {
    mode: String(stat.mode),
    ino: String(stat.ino),
    size: String(stat.size),
    mtime: String(stat.mtimeNs),
    ctime: String(stat.ctimeNs),
    ...(stat.isDirectory()
      ? {
          entries: Object.fromEntries(
            fs
              .readdirSync(file)
              .sort()
              .map((name) => [name, storageTree(path.join(file, name))]),
          ),
        }
      : { hash: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }),
  };
}
async function fixture({ override = false, floor = true } = {}) {
  const sb = sandbox();
  fresh(sb);
  const runtime = prepareTestRuntime();
  // Explicit preparation of synthetic permissions, never a runtime chmod/adoption.
  const repo = gitRepo(sb, 'writer-repo', 'git@github.com:org/writer-repo.git');
  const ctx: Ctx = { projectId: project(repo).id, sessionId: 's_a', linked: [], source: 'test' };
  const defaults = testCutoverPaths(runtime);
  const paths: CutoverPaths = override ? { ...defaults, view: path.join(sb.root, 'chosen-view', 'chosen.db'), backups: path.join(sb.root, 'chosen-backups') } : defaults;
  fs.mkdirSync(path.dirname(paths.view), { mode: 0o700 });
  fs.mkdirSync(paths.backups, { mode: 0o700 });
  const db = openSchemaOneMemory(paths.primary);
  const old = createTestMemoryStore(db);
  const publicNote = (
    await old.store(
      {
        category: 'project',
        title: 'Admission zebra',
        body: 'Admission zebra public body',
        tags: ['zebra'],
      },
      ctx,
    )
  ).memory;
  const privateNote = (
    await old.store(
      {
        category: 'personal',
        title: 'PRIVATE title canary',
        body: 'PRIVATE body canary',
        tags: ['private-tag'],
        private: true,
        source: 'PRIVATE source canary',
        sourceRef: 'PRIVATE ref canary',
      },
      ctx,
    )
  ).memory;
  const expired = (
    await old.store(
      { category: 'session', title: 'Expired constructor', body: 'Expired body', ttlDays: 1 },
      ctx,
    )
  ).memory;
  db.prepare('UPDATE memories SET expires_at=? WHERE id=?').run(Date.now() - 1, expired.id);
  if (floor) await cutoverMemory({ paths, now: Date.now, id: crypto.randomUUID });
  return {
    sb,
    repo,
    ctx,
    paths,
    db,
    old,
    publicNote,
    privateNote,
    expired,
    generation() {
      return Number(db.prepare('SELECT generation FROM bosun_source_floor').get()!.generation);
    },
    close() {
      old.close();
      sb.cleanup();
    },
  };
}

test('registered real store covers explicit expiry, reads/touch, mutations, scopes, versions, dedupe and retained audit', async () => {
  const f = await fixture();
  let local: ReturnType<typeof openTestLocalMemory> | undefined;
  try {
    local = openTestLocalMemory(f.paths);
    assert.equal(local.expire(), 1, 'expiry is explicit and admitted by the registered writer');
    assert.throws(
      () => local!.db,
      domain('unavailable'),
      'registered native handles do not escape',
    );
    const expired = await local.get(f.expired.id, f.ctx, { events: true });
    assert.equal(expired.status, 'archived');
    assert.equal(expired.version, 2);
    assert.deepEqual(
      expired.events!.map((e) => e.op),
      ['store', 'expire'],
    );
    assert.equal(f.generation(), 2, 'expiry event and row are both admitted');
    assert.deepEqual(
      await local.get(f.privateNote.id, f.ctx),
      f.privateNote,
      'owner retains private fields/IDs',
    );
    await assert.rejects(
      local.get(f.publicNote.id, { ...f.ctx, projectId: 'p_other' }),
      domain('not_found'),
    );
    const prior = f.generation();
    assert.equal((await local.search({ text: 'admission zebra' }, f.ctx)).length, 1);
    assert.equal((await local.get(f.publicNote.id, f.ctx)).accessCount, 0, 'search is read-only');
    local.touch([f.publicNote.id]);
    assert.equal((await local.get(f.publicNote.id, f.ctx)).accessCount, 1);
    assert.equal(f.generation(), prior + 1);
    const duplicate = await local.store(
      { category: 'project', title: 'ADMISSION ZEBRA', body: 'admission zebra public body' },
      f.ctx,
    );
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.memory.id, f.publicNote.id);
    assert.equal(f.generation(), prior + 1);
    await assert.rejects(
      local.update(f.publicNote.id, { body: 'no conflict write' }, 99, f.ctx),
      (e: unknown) => {
        assert.ok(e instanceof MemoryError);
        assert.equal(e.code, 'conflict');
        assert.equal(e.current, 1);
        return true;
      },
    );
    await assert.rejects(local.purge(f.publicNote.id, f.ctx), domain('invalid'));
    const updated = await local.update(
      f.publicNote.id,
      { body: 'updated admission zebra', shared: true },
      1,
      f.ctx,
    );
    assert.equal(updated.version, 2);
    assert.notEqual(updated.hash, f.publicNote.hash);
    assert.equal((await local.get(updated.id, { ...f.ctx, projectId: 'p_other' })).id, updated.id);
    await assert.rejects(
      local.update(updated.id, { body: 'wrong project' }, 2, { ...f.ctx, projectId: 'p_other' }),
      domain('invalid'),
    );
    const proposal = (
      await local.store(
        { category: 'project', title: 'Accept me', body: 'accept proposal', status: 'proposed' },
        f.ctx,
      )
    ).memory;
    assert.equal((await local.accept(proposal.id, f.ctx)).status, 'active');
    const rejected = (
      await local.store(
        { category: 'project', title: 'Reject me', body: 'reject proposal', status: 'proposed' },
        f.ctx,
      )
    ).memory;
    assert.equal((await local.reject(rejected.id, f.ctx)).status, 'archived');
    await local.purge(rejected.id, f.ctx);
    await assert.rejects(local.get(rejected.id, f.ctx), domain('not_found'));
    assert.deepEqual(
      f.db
        .prepare('SELECT op FROM memory_events WHERE memory_id=? ORDER BY id')
        .all(rejected.id)
        .map((r) => r.op),
      ['propose', 'reject', 'purge'],
    );
    const archived = await local.delete(updated.id, f.ctx);
    assert.equal(archived.status, 'archived');
    assert.equal((await local.delete(updated.id, f.ctx)).version, archived.version);
    local.close();
    local = undefined;
    const reopened = openTestLocalMemory(f.paths);
    try {
      assert.equal((await reopened.get(f.privateNote.id, f.ctx)).body, f.privateNote.body);
    } finally {
      reopened.close();
    }
    assert.throws(
      () => f.db.prepare('UPDATE memories SET private=1 WHERE id=?').run(f.privateNote.id),
      /no such function/,
    );
    await assert.rejects(
      f.old.store({ category: 'personal', title: 'Old writer', body: 'must fail' }, f.ctx),
      /no such function/,
    );
  } finally {
    local?.close();
    f.close();
  }
});

test('registered explicit expiry and prune use synchronous admission, preserving archive/purge events', async () => {
  const f = await fixture();
  const local = openTestLocalMemory(f.paths);
  const now = Date.now;
  try {
    const a = (
      await local.store(
        { category: 'session', title: 'Get expiry', body: 'get expiry words', ttlDays: 1 },
        f.ctx,
      )
    ).memory;
    const b = (
      await local.store(
        { category: 'session', title: 'Search expiry', body: 'search expiry words', ttlDays: 2 },
        f.ctx,
      )
    ).memory;
    Date.now = () => a.createdAt + DAY + 1;
    assert.equal(local.expire(), 2, 'maintenance archives the pre-expired fixture and boundary-crossing session');
    assert.equal((await local.get(a.id, f.ctx)).status, 'archived');
    Date.now = () => b.createdAt + 2 * DAY + 1;
    assert.equal(local.expire(), 1);
    assert.deepEqual(await local.search({ text: 'search expiry words', touch: false }, f.ctx), []);
    Date.now = now;
    const r = local.prune(now() + 200 * DAY);
    assert.ok(r.purged >= 3);
    assert.deepEqual(
      f.db
        .prepare('SELECT op FROM memory_events WHERE memory_id=? ORDER BY id')
        .all(b.id)
        .map((r) => r.op),
      ['store', 'expire', 'purge'],
    );
    assert.equal(f.db.prepare('SELECT 1 FROM memories WHERE id=?').get(b.id), undefined);
  } finally {
    Date.now = now;
    local.close();
    f.close();
  }
});

test('final owner CLI uses its chosen runtime and retains private reads, deterministic auto fields, mutation and purge audit', async () => {
  const f = await memoryLifecycleFixture();
  try {
    const before = f.row('private-note');
    const got = await f.cli(['memory', 'get', 'private-note', '--events']);
    assert.equal(got.code, 0, got.err);
    assert.equal(JSON.parse(got.out).memory.body, before!.body);
    const added = await f.cli([
      'memory',
      'add',
      '--category',
      'personal',
      '--private',
      '--auto',
      '--title',
      'Owner override',
      '--body',
      'PRIVATE CLI body',
    ]);
    assert.equal(added.code, 0, added.err);
    const note = JSON.parse(added.out).memory;
    assert.equal(note.title, 'Owner override');
    assert.equal(note.private, true);
    const update = await f.cli([
      'memory',
      'update',
      note.id,
      '--version',
      String(note.version),
      '--patch',
      '{"body":"PRIVATE changed body"}',
    ]);
    assert.equal(update.code, 0, update.err);
    assert.equal(JSON.parse(update.out).memory.id, note.id);
    assert.equal((await f.cli(['memory', 'delete', note.id])).code, 0);
    assert.equal((await f.cli(['memory', 'purge', note.id])).code, 0);
    assert.equal(f.row(note.id), undefined);
    assert.deepEqual(
      f.events(note.id).map((event) => event.op),
      ['store', 'update', 'archive', 'purge'],
    );
    assert.deepEqual(f.row('private-note'), before);
    assert.deepEqual(f.sb.calls(), []);
  } finally {
    await f.close();
  }
});

for (const origin of ['fresh', 'upgraded'] as const)
  test(
    origin + ' final owner CLI unshares with exact CAS, linked access and retained original audit',
    async () => {
      const f = await memoryLifecycleFixture(origin);
      try {
        const shared = (
          await f.rpc('memory.update', {
            id: 'public-note',
            expectedVersion: 1,
            patch: { shared: true },
          })
        ).memory;
        const foreignScope = { ...f.scope, workspace: f.foreign };
        assert.equal(
          (await f.rpc('memory.get', { id: shared.id }, foreignScope)).memory.id,
          shared.id,
        );
        const response = await f.cli([
          'memory',
          'update',
          shared.id,
          '--version',
          String(shared.version),
          '--patch',
          '{"shared":false}',
        ]);
        assert.equal(response.code, 0, response.err);
        const current = JSON.parse(response.out).memory;
        assert.equal(current.shared, false);
        assert.equal(current.version, shared.version + 1);
        for (const key of [
          'id',
          'hash',
          'createdAt',
          'expiresAt',
          'source',
          'sourceRef',
          'body',
          'title',
          'tags',
          'private',
          'projectId',
          'sessionId',
          'accessCount',
          'accessedAt',
        ])
          assert.deepEqual(current[key], shared[key], key);
        const events = f.events(shared.id);
        assert.deepEqual(
          events.map((event) => event.op),
          ['store', 'update', 'update'],
        );
        assert.equal(events[0].source, 'cli');
        assert.equal(events.at(-1)!.source, 'rpc:owner');
        assert.equal(events.at(-1)!.hash_before, shared.hash);
        assert.equal(events.at(-1)!.hash_after, shared.hash);
        await assert.rejects(
          f.rpc('memory.get', { id: shared.id }, foreignScope),
          (e) => e instanceof BosunError && e.code === 'not_found',
        );
        await f.restart([project(f.workspace).id]);
        const linked = (await f.rpc('memory.get', { id: shared.id }, foreignScope)).memory;
        assert.equal(linked.id, current.id);
        assert.equal(linked.shared, false);
        await f.restart([]);
        await assert.rejects(
          f.rpc('memory.get', { id: shared.id }, foreignScope),
          (e) => e instanceof BosunError && e.code === 'not_found',
        );
        const before = f.row(shared.id),
          audit = f.events(shared.id);
        for (const patch of ['{"shared":"false"}', '{"unsupported":true}']) {
          const invalid = await f.cli([
            'memory',
            'update',
            shared.id,
            '--version',
            String(current.version),
            '--patch',
            patch,
          ]);
          assert.equal(invalid.code, 2);
          assert.deepEqual(f.row(shared.id), before);
          assert.deepEqual(f.events(shared.id), audit);
        }
        const stale = await f.cli([
          'memory',
          'update',
          shared.id,
          '--version',
          '99',
          '--patch',
          '{"shared":true}',
        ]);
        assert.equal(stale.code, 3);
        assert.equal(JSON.parse(stale.err).error.code, 'conflict');
        assert.deepEqual(f.row(shared.id), before);
        assert.deepEqual(f.events(shared.id), audit);
        const added = await f.cli([
          'memory',
          'add',
          '--category',
          'project',
          '--unshared',
          '--title',
          'Unshared creation',
          '--body',
          'Unshared creation body',
        ]);
        assert.equal(added.code, 0, added.err);
        assert.equal(f.row(JSON.parse(added.out).memory.id)!.shared, 0);
      } finally {
        await f.close();
      }
    },
  );

for (const origin of ['fresh', 'upgraded'] as const)
  test(
    origin + ' final owner unsharing preserves the raw malformed privacy marker and model opacity',
    async () => {
      const f = await memoryLifecycleFixture(origin);
      try {
        const before = f.row('malformed-note')!;
        const response = await f.cli([
          'memory',
          'update',
          'malformed-note',
          '--version',
          String(before.version),
          '--patch',
          '{"shared":false}',
        ]);
        assert.equal(response.code, 0, response.err);
        const after = f.row('malformed-note')!;
        assert.equal(after.private, 'false');
        assert.equal(after.shared, 0);
        for (const key of [
          'id',
          'hash',
          'created_at',
          'source',
          'source_ref',
          'body',
          'title',
          'tags',
        ])
          assert.deepEqual(after[key], before[key], key);
        const owner = await f.cli(['memory', 'get', 'malformed-note']);
        assert.equal(owner.code, 0, owner.err);
        assert.equal(JSON.parse(owner.out).memory.body, before.body);
        assert.deepEqual(
          await f.rpc('memory.get', { id: 'malformed-note' }, { ...f.scope, audience: 'model' }),
          { memory: { private: true } },
        );
        await f.restart();
        assert.deepEqual(f.row('malformed-note'), after);
      } finally {
        await f.close();
      }
    },
  );

for (const origin of ['fresh', 'upgraded'] as const)
  test(
    origin +
      ' final owner status restore uses post-maintenance CAS and retains identity, TTL and audit across reopen',
    async () => {
      const f = await memoryLifecycleFixture(origin);
      try {
        const expired = await f.rpc('memory.maintain', { action: 'expire' });
        await completedMemoryJob(f, expired.job.id);
        const before = (await f.rpc('memory.get', { id: 'expired-note', events: true })).memory;
        assert.equal(before.status, 'archived');
        assert.equal(before.version, 2);
        const response = await f.cli([
          'memory',
          'update',
          before.id,
          '--version',
          String(before.version),
          '--patch',
          '{"status":"active"}',
        ]);
        assert.equal(response.code, 0, response.err);
        const memory = JSON.parse(response.out).memory,
          stored = f.row(before.id)!;
        assert.equal(memory.status, 'active');
        assert.equal(memory.version, 3);
        assert.equal(
          stored.expires_at,
          Number(stored.updated_at) + f.config.memory.sessionTtlDays * DAY,
        );
        for (const key of [
          'id',
          'hash',
          'createdAt',
          'source',
          'sourceRef',
          'body',
          'title',
          'tags',
        ])
          assert.deepEqual(memory[key], before[key], key);
        const audit = f.events(before.id);
        assert.deepEqual(
          audit.map((event) => event.op),
          ['store', 'expire', 'restore'],
        );
        assert.equal(audit[0].source, 'cli');
        assert.equal(audit.at(-1)!.source, 'rpc:owner');
        assert.equal(audit.at(-1)!.at, stored.updated_at);
        for (const [version, patch, expected] of [
          [2, '{"status":"archived"}', 3],
          [3, '{"status":"proposed"}', 2],
          [3, '{"status":"unknown"}', 2],
        ] as const) {
          assert.equal(
            (
              await f.cli([
                'memory',
                'update',
                before.id,
                '--version',
                String(version),
                '--patch',
                patch,
              ])
            ).code,
            expected,
          );
          assert.deepEqual(f.row(before.id), stored);
          assert.deepEqual(f.events(before.id), audit);
        }
        await f.restart();
        const reopened = (await f.rpc('memory.get', { id: before.id, events: true })).memory;
        assert.equal(reopened.status, 'active');
        assert.equal(reopened.version, 3);
        assert.deepEqual(
          reopened.events.map((event: any) => event.op),
          ['store', 'expire', 'restore'],
        );
      } finally {
        await f.close();
      }
    },
  );

for (const origin of ['fresh', 'upgraded'] as const)
  test(
    origin +
      ' final stdio MCP restores archived public/private/malformed sessions without payload leaks or raw flag rewriting',
    async () => {
      const f = await memoryLifecycleFixture(origin);
      const session = mcpSession(f.env, f.workspace);
      try {
        for (const [n, flag] of [0, 1, 'false'].entries()) {
          const id = 'restore-session-' + n,
            before = f.row(id)!;
          const response = await session.call('memory_update', {
            id,
            expectedVersion: 2,
            patch: { status: 'active', shared: false },
          });
          if (flag !== 0) {
            assert.equal(response.result.isError, true);
            assert.equal(response.result.structuredContent.error.code, 'not_found');
            assert.deepEqual(f.row(id), before);
            const restored = await f.cli([
              'memory',
              'update',
              id,
              '--version',
              '2',
              '--patch',
              '{"status":"active","shared":false}',
            ]);
            assert.equal(restored.code, 0, restored.err);
            const hidden = await session.call('memory_get', { id });
            assert.deepEqual(hidden.result.structuredContent, { memory: { private: true } });
            assert.doesNotMatch(
              JSON.stringify(response) + JSON.stringify(hidden),
              /PRIVATE-LIFECYCLE|original-reference|expiresAt|version|restore-session/,
            );
          } else {
            assert.equal(response.result.isError, undefined);
            assert.equal(response.result.structuredContent.memory.id, id);
          }
          const stored = f.row(id)!;
          assert.equal(stored.version, 3);
          assert.equal(stored.status, 'active');
          assert.equal(stored.private, flag);
          assert.equal(stored.shared, 0);
          assert.equal(
            stored.expires_at,
            Number(stored.updated_at) + f.config.memory.sessionTtlDays * DAY,
          );
          for (const key of [
            'id',
            'hash',
            'created_at',
            'source',
            'source_ref',
            'body',
            'title',
            'tags',
          ])
            assert.deepEqual(stored[key], before[key], key);
          const events = f.events(id);
          assert.deepEqual(
            events.map((event) => event.op),
            ['store', 'archive', 'restore'],
          );
          assert.equal(events[0].source, 'cli');
          assert.equal(events.at(-1)!.source, flag === 0 ? 'rpc:model' : 'rpc:owner');
          assert.equal(events.at(-1)!.hash_after, stored.hash);
          const stale = await session.call('memory_update', {
            id,
            expectedVersion: 2,
            patch: { status: 'active' },
          });
          assert.equal(
            stale.result.structuredContent.error.code,
            flag === 0 ? 'conflict' : 'not_found',
          );
          assert.doesNotMatch(JSON.stringify(stale), /currentVersion|PRIVATE-LIFECYCLE/);
          assert.deepEqual(f.row(id), stored);
          const foreign = mcpSession(f.env, f.foreign);
          try {
            assert.equal(
              (await foreign.call('memory_get', { id })).result.structuredContent.error.code,
              'not_found',
            );
          } finally {
            await foreign.close();
          }
        }
        await session.close();
        await f.restart();
        for (const n of [0, 1, 2]) {
          const row = f.row('restore-session-' + n)!;
          assert.equal(row.status, 'active');
          assert.equal(row.version, 3);
          assert.deepEqual(
            f.events(String(row.id)).map((event) => event.op),
            ['store', 'archive', 'restore'],
          );
        }
      } finally {
        await session.close();
        await f.close();
      }
    },
  );

test('final stdio MCP keeps private replies and stale conflicts finite while docs indexing runs in the owner admin job', async () => {
  const f = await memoryLifecycleFixture(),
    session = mcpSession(f.env, f.workspace);
  try {
    const privateGet = await session.call('memory_get', { id: 'private-note' });
    assert.deepEqual(privateGet.result.structuredContent, { memory: { private: true } });
    assert.doesNotMatch(JSON.stringify(privateGet), /PRIVATE-LIFECYCLE|sourceRef|hash|events/);
    const publicUpdate = await session.call('memory_update', {
      id: 'public-note',
      expectedVersion: 1,
      patch: { body: 'Updated public zebra policy.' },
    });
    assert.equal(publicUpdate.result.structuredContent.memory.version, 2);
    const stalePublic = await session.call('memory_update', {
      id: 'public-note',
      expectedVersion: 1,
      patch: { body: 'attempted body' },
    });
    assert.equal(stalePublic.result.structuredContent.error.code, 'conflict');
    assert.doesNotMatch(JSON.stringify(stalePublic), /currentVersion|attempted body/);
    const updated = await session.call('memory_update', {
      id: 'public-note',
      expectedVersion: 2,
      patch: { private: true },
    });
    assert.deepEqual(updated.result.structuredContent, { memory: { private: true } });
    const conflict = await session.call('memory_update', {
      id: 'public-note',
      expectedVersion: 1,
      patch: { body: 'attempted body' },
    });
    assert.equal(conflict.result.structuredContent.error.code, 'not_found');
    assert.doesNotMatch(
      JSON.stringify(conflict),
      /currentVersion|attempted body|PRIVATE-LIFECYCLE/,
    );
    fs.writeFileSync(
      path.join(f.workspace, 'mcp.md'),
      '# Admission zebra\nAdmission zebra MCP docs.',
    );
    const queued = await f.rpc('docs.index', {});
    await completedMemoryJob(f, queued.job.id);
    const docs = await session.call('context_retrieve', {
      task: 'admission zebra',
      sources: ['docs'],
    });
    assert.match(docs.result.structuredContent.text, /MCP docs/);
    assert.doesNotMatch(JSON.stringify(docs), /PRIVATE-LIFECYCLE|backup_hash/);
    const search = await session.call('memory_search', { text: 'public-note' });
    assert.deepEqual(search.result.structuredContent.hits, []);
  } finally {
    await session.close();
    await f.close();
  }
});

test('final authenticated authority ignores legacy URL redirection and preserves owner private data, IDs, finite conflicts and model-safe context', async () => {
  const f = await remoteFixture();
  try {
    const secret = (
      await f.rpc('client', 'memory.store', {
        category: 'project',
        title: 'PRIVATE authority zebra',
        body: 'PRIVATE authority body.',
        private: true,
      })
    ).memory;
    const env = { ...f.clientEnv, MEMORY_URL: 'http://127.0.0.1:1' };
    const read = await bosun(['memory', 'get', secret.id], { env, cwd: f.clientWorkspace });
    assert.equal(read.code, 0, read.err);
    assert.equal(JSON.parse(read.out).memory.body, secret.body);
    const created = (
      await f.rpc('client', 'memory.store', {
        category: 'project',
        title: 'Server zebra',
        body: 'Server zebra public body.',
      })
    ).memory;
    const bad = await bosun(
      ['memory', 'update', created.id, '--version', '99', '--patch', '{"body":"bad version"}'],
      { env, cwd: f.clientWorkspace },
    );
    assert.equal(bad.code, 3);
    assert.equal(JSON.parse(bad.err).error.code, 'conflict');
    assert.equal(
      (await f.rpc('server', 'memory.get', { id: created.id })).memory.body,
      created.body,
    );
    const context = await f.rpc(
      'client',
      'context.retrieve',
      { task: 'server zebra public body' },
      'model',
    );
    assert.ok(context.ids.includes(created.id));
    assert.doesNotMatch(JSON.stringify(context), /PRIVATE authority/);
    assert.deepEqual(await f.rpc('client', 'memory.get', { id: secret.id }, 'model'), {
      memory: { private: true },
    });
    const db = new SqliteDatabase(f.clientPaths.memory, { readOnly: true });
    try {
      assert.equal(db.prepare('SELECT COUNT(*) n FROM memories').get()!.n, 0);
    } finally {
      db.close();
    }
  } finally {
    await f.close();
  }
});

test('registered gate lease blocks explicit maintenance and mutations while reads stay available', async () => {
  const f = await fixture();
  let local: ReturnType<typeof openTestLocalMemory> | undefined;
  const lease = new SqliteDatabase(f.paths.view, { readOnly: true });
  try {
    lease.exec('BEGIN');
    lease.prepare('SELECT * FROM bosun_cutover_gate').get();
    const prior = f.generation();
    local = openTestLocalMemory(f.paths);
    assert.throws(() => local!.expire(), writerBusy, 'expiry cannot bypass gate lease');
    assert.equal(f.generation(), prior);
    assert.equal(
      f.db.prepare('SELECT status FROM memories WHERE id=?').get(f.expired.id)!.status,
      'active',
    );
    lease.exec('ROLLBACK');
    lease.exec('BEGIN');
    lease.prepare('SELECT * FROM bosun_cutover_gate').get();
    const beforeTouch = f.generation();
    assert.equal((await local.search({ text: 'admission zebra' }, f.ctx)).length, 1);
    assert.equal(f.generation(), beforeTouch);
    assert.equal((await local.get(f.publicNote.id, f.ctx)).accessCount, 0);
    await assert.rejects(
      local.store({ category: 'personal', title: 'Held', body: 'held mutation' }, f.ctx),
      writerBusy,
    );
    lease.exec('ROLLBACK');
    await local.update(f.publicNote.id, { private: true }, 1, f.ctx);
    f.db.exec('BEGIN IMMEDIATE');
    f.db.exec('ROLLBACK');
  } finally {
    if (lease.isTransaction) lease.exec('ROLLBACK');
    lease.close();
    local?.close();
    f.close();
  }
});

test('registered final writer holds pending/unknown/mismatched roots without permission or schema changes', async () => {
  for (const kind of [
    'pending',
    'override',
    'mode',
    'unknown',
    'dangling',
    'directory',
    'ancestor',
  ]) {
    const f = await fixture({
      floor: !['pending', 'dangling', 'directory', 'ancestor'].includes(kind),
    });
    try {
      if (kind === 'pending')
        await assert.rejects(
          cutoverMemory({
            paths: f.paths,
            now: Date.now,
            id: crypto.randomUUID,
            checkpoint(phase) {
              if (phase === 'backup') throw Error('stop explicit operation');
            },
          }),
        );
      const candidatePaths =
        kind === 'override'
          ? { ...f.paths, view: path.join(f.sb.root, 'missing-view.db') }
          : f.paths;
      if (kind === 'mode') fs.chmodSync(f.paths.primary, 0o644);
      if (kind === 'unknown') f.db.exec('DROP TRIGGER bosun_floor_memories_update');
      if (kind === 'dangling')
        fs.symlinkSync(path.join(f.sb.root, 'never-created.db'), f.paths.view);
      if (kind === 'directory') fs.mkdirSync(f.paths.view);
      if (kind === 'ancestor') {
        fs.rmdirSync(path.dirname(f.paths.view));
        fs.symlinkSync(path.join(f.sb.root, 'never-created-dir'), path.dirname(f.paths.view));
      }
      const before = f.db.prepare('SELECT * FROM schema_migrations').all();
      assert.throws(
        () => openTestLocalMemory(candidatePaths),
        (e: unknown) => {
          assert.ok(e instanceof CutoverError);
          assert.equal(e.code, 'unavailable');
          assert.equal(e.message, `memory cutover unavailable (${e.reason})`);
          assert.equal(e.cause, undefined);
          assert.doesNotMatch(e.message, /missing-view|PRIVATE/);
          return true;
        },
      );
      assert.deepEqual(f.db.prepare('SELECT * FROM schema_migrations').all(), before);
      if (kind === 'mode')
        assert.equal(fs.statSync(f.paths.primary).mode & 0o777, 0o644, 'final writer never changes permissions');
    } finally {
      f.close();
    }
  }
});

test('registered final writer preserves domain errors after rollback and keeps hostile callback errors finite', async () => {
  const f = await fixture();
  const writer = new CutoverWriter(f.paths);
  try {
    for (const error of [
      new MemoryError('not_found', 'memory not found'),
      new MemoryError('invalid', 'invalid owner request'),
      new MemoryError('conflict', 'owner conflict', 7),
    ]) {
      assert.throws(
        () =>
          writer.transaction(() => {
            throw error;
          }),
        (e: unknown) => e === error && e instanceof MemoryError,
      );
    }
    const proxy = () =>
      new Proxy(
        {},
        {
          getPrototypeOf() {
            throw Error('PRIVATE prototype canary');
          },
          get() {
            throw Error('PRIVATE getter canary');
          },
        },
      );
    const typed = new CutoverError('storage');
    typed.message = 'PRIVATE typed error canary';
    typed.cause = { body: 'PRIVATE cause canary' };
    for (const operation of ['transaction', 'read'] as const) for (const failure of [typed, proxy()]) {
      const invoke = () => writer[operation](() => { throw failure; });
      assert.throws(invoke, (e: unknown) => {
        assert.ok(e instanceof CutoverError);
        assert.equal(e.message, `memory cutover unavailable (${e.reason})`);
        assert.equal(e.cause, undefined);
        assert.doesNotMatch(e.message + JSON.stringify(e), /PRIVATE/);
        return true;
      });
    }
    assert.throws(() => writer.read((db) => db), CutoverError);
    assert.throws(() => writer.read((db) => db.prepare('SELECT id FROM memories')), CutoverError);
    assert.throws(() => writer.transaction((db) => db), CutoverError);
    assert.throws(() => writer.read(async () => []), CutoverError);
    const epoch = crypto.randomUUID();
    f.db.prepare('UPDATE bosun_source_floor SET source_id=?').run(epoch);
    const gate = new SqliteDatabase(f.paths.view);
    try {
      gate.prepare('UPDATE bosun_cutover_gate SET source_id=?').run(epoch);
    } finally {
      gate.close();
    }
    assert.throws(
      () => writer.read((db) => db.prepare('SELECT title FROM memories').all()),
      CutoverError,
    );
  } finally {
    writer.close();
    f.close();
  }
});

test('final doctor leaves absent runtime and prepared WAL database/sidecars unchanged without native or database probes', async () => {
  const sb = sandbox();
  fresh(sb);
  try {
    const home = path.join(sb.root, 'missing-runtime'),
      env = sb.env({ BOSUN_HOME: home });
    const result = await bosun(['doctor'], { env });
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.out).checks[0].state, 'missing');
    assert.equal(fs.existsSync(home), false);
    assert.deepEqual(sb.calls(), []);
  } finally {
    sb.cleanup();
  }
  const f = await memoryLifecycleFixture();
  try {
    await f.rpc('memory.store', {
      category: 'project',
      title: 'Doctor WAL activity',
      body: 'Make an actual owner WAL write.',
    });
    const files = [f.paths.memory, f.paths.memory + '-wal', f.paths.memory + '-shm'];
    const snapshot = () =>
      files.map((file) =>
        fs.existsSync(file)
          ? {
              bytes: fs.readFileSync(file),
              mode: fs.statSync(file).mode,
              mtime: fs.statSync(file, { bigint: true }).mtimeNs,
              ctime: fs.statSync(file, { bigint: true }).ctimeNs,
            }
          : null,
      );
    const before = snapshot(),
      held = await f.cli(['doctor']);
    assert.equal(held.code, 0, held.err);
    const report = JSON.parse(held.out);
    assert.equal(report.prepared, true);
    assert.equal(report.coverage, 'filesystem-metadata');
    assert.equal(report.schemaQualification, 'unverified');
    assert.equal(report.databaseOpened, false);
    assert.equal(report.nativeCalls, false);
    assert.ok(
      report.checks.some(
        (check: any) =>
          check.id === 'memory.database' &&
          check.state === 'ready' &&
          check.detail.includes('WAL held'),
      ),
    );
    assert.deepEqual(snapshot(), before);
    assert.deepEqual(f.sb.calls(), []);
  } finally {
    await f.close();
  }
});

test('failed final daemon listen closes its registered writer and owner authority; unchanged notes reopen successfully', async () => {
  const f = await memoryLifecycleFixture();
  const originalListen = http.Server.prototype.listen,
    originalClose = CutoverWriter.prototype.close;
  try {
    await f.runtime.close();
    const before = f.row('public-note'),
      audit = f.events('public-note');
    let closed = 0;
    http.Server.prototype.listen = function () {
      throw Error('synthetic listen failure');
    };
    CutoverWriter.prototype.close = function () {
      closed++;
      return originalClose.call(this);
    };
    try {
      await assert.rejects(
        startDaemon({ paths: f.paths, config: f.config, environment: f.env, runners: {} }),
        /synthetic listen failure/,
      );
      assert.equal(closed, 1);
    } finally {
      http.Server.prototype.listen = originalListen;
      CutoverWriter.prototype.close = originalClose;
    }
    await f.restart();
    assert.deepEqual(f.row('public-note'), before);
    assert.deepEqual(f.events('public-note'), audit);
    assert.equal((await f.rpc('memory.get', { id: 'public-note' })).memory.id, 'public-note');
  } finally {
    http.Server.prototype.listen = originalListen;
    CutoverWriter.prototype.close = originalClose;
    await f.close();
  }
});
