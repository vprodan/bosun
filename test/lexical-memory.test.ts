import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLexicalSource } from '../src/core/lexical-source.ts';
import { runtimeFixture } from './runtime-fixture.ts';
import type { GraphArtifact } from '../src/core/domain/graph.ts';
import type { Memory } from '../src/core/domain/memory.ts';

async function store(
  f: Awaited<ReturnType<typeof runtimeFixture>>,
  title: string,
  body: string,
  extra = {},
) {
  return (
    await f.rpc<{ memory: Memory }>('memory.store', { category: 'project', title, body, ...extra })
  ).memory;
}
async function entity(
  f: Awaited<ReturnType<typeof runtimeFixture>>,
  m: Memory,
  key: string,
  aliases: string[],
) {
  const created = await f.rpc<{ artifact: GraphArtifact }>('graph.create', {
    kind: 'entity',
    title: key,
    text: `Reviewed ${key}`,
    supports: [{ memoryId: m.id, version: m.version, hash: m.hash }],
    entity: { type: 'concept', key, aliases },
  });
  return (
    await f.rpc<{ artifact: GraphArtifact }>('graph.review', {
      id: created.artifact.id,
      expectedVersion: created.artifact.version,
      action: 'accept',
    })
  ).artifact;
}

test('native weighted FTS and actual excerpt packing expose supporting tail evidence with original IDs/hash and no mutation', async () => {
  const f = await runtimeFixture();
  try {
    const m = await store(
      f,
      'Build procedure',
      'ordinary padding '.repeat(60) + 'Nebula release uses pnpm with exact lockfile validation.',
    );
    const before = await f.rpc('memory.get', { id: m.id, events: true });
    const a = await f.cli(['context', 'Nebula release pnpm', '--sources', 'curated']);
    const b = await f.cli(['context', 'Nebula release pnpm', '--sources', 'lexical']);
    assert.equal(a.code, 0, a.err);
    assert.equal(b.code, 0, b.err);
    assert.doesNotMatch(a.out, /exact lockfile validation/);
    assert.match(b.out, /Nebula release uses pnpm with exact lockfile validation/);
    assert.ok(JSON.parse(b.out).ids.includes(m.id));
    assert.deepEqual(await f.rpc('memory.get', { id: m.id, events: true }), before);
    assert.equal(f.calls(), 0);
    assert.equal(
      (await f.cli(['context', 'Nebula release', '--sources', 'curated,lexical'])).code,
      2,
    );
  } finally {
    await f.close();
  }
});

test('reviewed aliases retain the original curated ID, stay scoped, and revoke on source privacy/version changes', async () => {
  const f = await runtimeFixture();
  try {
    const m = await store(f, 'Package policy', 'Use pnpm for reproducible builds.');
    await entity(f, m, 'package procedure', ['rockettool']);
    const ctx = await f.cli(['context', 'rockettool', '--sources', 'lexical']);
    assert.equal(ctx.code, 0, ctx.err);
    assert.deepEqual(JSON.parse(ctx.out).ids, [m.id]);
    assert.match(ctx.out, /Use pnpm for reproducible builds/);
    const hidden = await f.rpc<{ memory: Memory }>('memory.update', {
      id: m.id,
      expectedVersion: 1,
      patch: { private: true },
    });
    assert.equal(hidden.memory.private, true);
    const revoked = await f.cli(['context', 'rockettool', '--sources', 'lexical']);
    assert.deepEqual(JSON.parse(revoked.out).ids, []);
    assert.doesNotMatch(revoked.out, /pnpm|Package policy/);
    await assert.rejects(f.rpc('graph.get', { id: 'g_missing' }));
    assert.equal((await f.rpc<{ memory: Memory }>('memory.get', { id: m.id })).memory.id, m.id);
  } finally {
    await f.close();
  }
});

test('explicit reviewed graph context remains absent from ordinary context', async () => {
  const f = await runtimeFixture();
  try {
    const m = await store(f, 'Build policy', 'Use pnpm for reproducible builds.');
    const g = await entity(f, m, 'launch operations', ['rockettool']);
    const ordinary = await f.cli(['context', 'rockettool question']);
    const graph = await f.cli(['context', 'rockettool question', '--sources', 'graph']);
    assert.deepEqual(JSON.parse(ordinary.out).ids, []);
    assert.ok(JSON.parse(graph.out).ids.includes(g.id));
    assert.match(graph.out, /Reviewed launch operations/);
    assert.equal(f.calls(), 0);
  } finally {
    await f.close();
  }
});

test('lexical source denies private/unclassified records before identity, payload, ranking or provenance getters', async () => {
  for (const flag of [true, undefined, 0, 'false']) {
    const denied: Record<string, unknown> = { private: flag };
    for (const key of [
      'id',
      'title',
      'body',
      'tags',
      'category',
      'rank',
      'updatedAt',
      'hash',
      'matched',
      'version',
    ])
      Object.defineProperty(denied, key, {
        get() {
          throw Error('denied payload accessed');
        },
      });
    const source = createLexicalSource({
      searchLexical: async () => [
        denied as unknown as import('../src/core/domain/memory.ts').Found,
      ],
      get: async () => {
        throw Error('get called for denied source');
      },
    });
    assert.deepEqual(
      await source.search(
        'public query',
        { projectId: null, sessionId: null, linked: [], audience: 'model' },
        20,
      ),
      [],
    );
  }
});
