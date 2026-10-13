import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteDatabase } from '../src/platform/sqlite.ts';
import { gitRepo } from './helpers.ts';
import { project } from '../src/platform/project.ts';
import { runtimeFixture } from './runtime-fixture.ts';

test('final memory CLI preserves duplicates, versions, private flags, purge audit, explicit proposal review and scoped stats', async () => {
  const f = await runtimeFixture();
  try {
    const run = (...args: string[]) => f.cli(['memory', ...args]);
    const value = async (...args: string[]) => {
      const r = await run(...args);
      assert.equal(r.code, 0, r.err);
      return JSON.parse(r.out);
    };
    const first = await value(
      'add',
      '--category',
      'project',
      '--title',
      'Use pnpm',
      '--tags',
      'tooling,cart',
      '--body',
      'Always pnpm install; npm breaks the lockfile.',
    );
    const id = first.memory.id;
    assert.match(id, /^m_[0-9a-v]{9}[0-9a-f]{8}$/);
    const duplicate = await value(
      'add',
      '--category',
      'project',
      '--title',
      'Use pnpm',
      '--body',
      'Always pnpm install; npm breaks the lockfile.',
    );
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.memory.id, id);
    assert.equal((await value('search', 'lockfile')).hits[0].id, id);
    const inspected = (await value('get', id, '--events')).memory;
    assert.match(inspected.body, /Always pnpm install/);
    assert.equal(inspected.events[0].op, 'store');
    assert.equal(inspected.events[0].source, 'cli');
    const updated = await value(
      'update',
      id,
      '--version',
      '1',
      '--patch',
      JSON.stringify({ body: 'Always pnpm; never npm.' }),
    );
    assert.equal(updated.memory.version, 2);
    assert.equal(
      (await run('update', id, '--version', '1', '--patch', '{}')).code,
      3,
      'stale native version refuses mutation',
    );
    assert.notEqual((await run('purge', id)).code, 0, 'active memory cannot be purged');
    assert.equal((await value('delete', id)).memory.status, 'archived');
    assert.deepEqual(await value('purge', id), { purged: id });
    assert.equal((await run('get', id)).code, 1);
    const privateNote = await value(
      'add',
      '--category',
      'session',
      '--title',
      'Scratch',
      '--private',
      '--body',
      'PRIVATE OWNER NOTE CANARY',
    );
    assert.equal(privateNote.memory.category, 'session');
    assert.equal(privateNote.memory.private, true);
    const proposals = [];
    for (const word of ['one', 'two', 'three'])
      proposals.push(
        (
          await f.rpc<{ memory: { id: string } }>('memory.store', {
            category: 'project',
            title: `Proposal ${word}`,
            body: `${word} proposal body`,
            status: 'proposed',
            source: 'test',
          })
        ).memory,
      );
    assert.equal((await value('accept', proposals[0].id)).memory.status, 'active');
    assert.equal((await value('reject', proposals[1].id)).memory.status, 'archived');
    assert.equal((await run('accept', proposals[0].id)).code, 2, 'only proposals can be accepted');
    const review = await value('review');
    assert.deepEqual(
      review.hits.map((m: { id: string }) => m.id),
      [proposals[2].id],
    );
    assert.equal(review.hits[0].title, 'Proposal three');
    await value('accept', review.hits[0].id);
    assert.deepEqual((await value('review')).hits, []);
    const foreign = gitRepo(f.sb, 'foreign', 'git@github.com:other/foreign.git');
    const foreignScope = { workspace: foreign, sessionId: null, audience: 'owner' as const };
    const foreignNote = (
      await f.rpc<{ memory: { id: string } }>(
        'memory.store',
        { category: 'project', title: 'Foreign', body: 'FOREIGN OWNER CANARY' },
        foreignScope,
      )
    ).memory;
    assert.notEqual((await run('purge', foreignNote.id)).code, 0);
    const stats = await value('stats');
    assert.equal(stats.projectId, project(f.workspace).id);
    assert.equal(stats.total, 4);
    assert.deepEqual(stats.byCategory, { personal: 0, project: 3, session: 1 });
    assert.deepEqual(stats.byStatus, { active: 3, proposed: 0, archived: 1 });
    assert.deepEqual(stats.privacy, { public: 3, private: 1 });
    assert.doesNotMatch(JSON.stringify(stats), /OWNER|CANARY|Proposal|pnpm/);
    const modelScope = { ...f.scope, audience: 'model' as const };
    for (const method of ['memory.purge', 'memory.stats'])
      await assert.rejects(
        f.rpc(method, method === 'memory.purge' ? { id: privateNote.memory.id } : {}, modelScope),
      );
    assert.equal(
      (await f.rpc<{ memory: { body: string } }>('memory.get', { id: privateNote.memory.id }))
        .memory.body,
      'PRIVATE OWNER NOTE CANARY',
    );
    const db = new SqliteDatabase(f.paths.memory, { readOnly: true });
    try {
      assert.deepEqual(
        db
          .prepare('SELECT op FROM memory_events WHERE memory_id=? ORDER BY id')
          .all(id)
          .map((r) => r.op),
        ['store', 'update', 'archive', 'purge'],
      );
    } finally {
      db.close();
    }
    for (const args of [['bogus'], ['add'], ['search', '--nope']])
      assert.equal((await run(...args)).code, 2);
    assert.equal(f.calls(), 0);
  } finally {
    await f.close();
  }
});
