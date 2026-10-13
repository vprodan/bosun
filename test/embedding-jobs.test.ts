import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SqliteDatabase } from '../src/platform/sqlite.ts';
import { mock, gitRepo } from './helpers.ts';
import { runtimeFixture } from './runtime-fixture.ts';
import { mcpFixture } from './mcp-fixture.ts';
import { methodParams } from '../src/contracts/methods.ts';
import { SqliteEmbeddings } from '../src/adapters/memory/sqlite-embedding.ts';
import { BosunError } from '../src/core/errors.ts';

const MODEL = 'embeddinggemma:fixture',
  DIGEST = 'a'.repeat(64);
const code = (name: string) => (error: unknown) =>
  error instanceof BosunError && error.code === name;
type Fixture = Awaited<ReturnType<typeof runtimeFixture>>;
async function fixture(
  options: {
    vectors?: boolean;
    backend?: string;
    onTags?(): Promise<void>;
    onEmbed?(): Promise<void>;
    slow?: boolean;
    cacheSize?: number;
    cacheTtlMs?: number;
  } = {},
) {
  const server = await mock({
    '/api/tags': async () => {
      await options.onTags?.();
      return { json: { models: [{ model: MODEL, digest: DIGEST }] } };
    },
    '/api/show': () => ({ json: { capabilities: ['embedding'] } }),
    '/api/embed': async (body) => {
      await options.onEmbed?.();
      return {
        ...(options.slow ? { delayMs: 300 } : {}),
        json: {
          model: MODEL,
          embeddings: body.input.map((input: string) =>
            input.includes('unrelated weather') ? [0, 1, 0] : [1, 0, 0],
          ),
          prompt_eval_count: 7,
        },
      };
    },
  });
  let f: Fixture;
  try {
    f = await runtimeFixture(
      `[graph]\nvectors=${options.vectors ?? true}\n[graph.embedding]\nmodel="${MODEL}"\nurl="${server.url}"\ndigest="${DIGEST}"\ndimensions=3\ntransform="embeddinggemma-v1"\nbackend="${options.backend ?? 'reference'}"\ntimeoutMs=2000\nminCosine=0.6\nqueryCacheSize=${options.cacheSize ?? 0}\nqueryCacheTtlMs=${options.cacheTtlMs ?? 5000}\n`,
    );
  } catch (error) {
    await server.close();
    throw error;
  }
  const observer = new SqliteDatabase(f.paths.memory, { readOnly: true });
  return {
    ...f,
    server,
    observer,
    rows: () => observer.prepare('SELECT COUNT(*) n FROM memory_embeddings').get()!.n,
    async close() {
      observer.close();
      try {
        await f.close();
      } finally {
        await server.close();
      }
    },
  };
}
async function terminal(f: Fixture, id: string) {
  let job = await f.rpc('job.get', { id });
  for (let n = 0; n < 200 && ['queued', 'running'].includes(job.state); n++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    job = await f.rpc('job.get', { id });
  }
  assert.ok(!['queued', 'running'].includes(job.state), 'bounded job completion');
  return job;
}
const request = (id: string, requestId = 'index') => ({ privacy: 'public', requestId, ids: [id] });
const query = {
  task: 'Which manager installs dependencies?',
  sources: ['vectors'],
  privacy: 'public',
  includeCandidates: true,
};
const store = async (f: Fixture, extra: Record<string, unknown> = {}, scope = f.scope) =>
  (
    await f.rpc(
      'memory.store',
      {
        category: 'project',
        title: 'Build rules',
        body: 'Use pnpm for package installation.',
        ...extra,
      },
      scope,
    )
  ).memory;

test('owner CLI indexes native source chunks once and actual MCP queries return original IDs with negative abstention', async () => {
  const f = await fixture();
  try {
    const note = await store(f);
    const before = await f.rpc('memory.get', { id: note.id, events: true });
    const cli = await f.cli([
      'memory',
      'embed',
      note.id,
      '--public',
      '--request-id',
      'owner-index',
    ]);
    assert.equal(cli.code, 0, cli.err);
    const queued = JSON.parse(cli.out);
    const job = await terminal(f, queued.job.id);
    assert.equal(job.state, 'succeeded');
    assert.equal(job.runnerId, 'bosun-embedding-index');
    assert.equal(f.rows(), 1);
    assert.deepEqual(await f.rpc('memory.get', { id: note.id, events: true }), before);
    const stored = f.observer.prepare('SELECT * FROM memory_embeddings').get()!;
    assert.equal(stored.memory_id, note.id);
    assert.equal(stored.memory_version, note.version);
    assert.equal(stored.model_digest, DIGEST);
    assert.equal(stored.dimensions, 3);
    assert.equal(stored.private, 0);
    assert.equal(stored.end, note.body.length);
    const metadata = JSON.stringify(await f.rpc('job.result', { id: job.id }));
    assert.ok(!metadata.includes(note.body), 'source bodies are absent from job metadata');
    const calls = f.server.requests.length;
    const duplicate = await f.rpc('memory.embed', request(note.id, 'owner-index'));
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.job.id, job.id);
    assert.equal(f.server.requests.length, calls);
    const mcp = await mcpFixture(f.env, f.workspace);
    try {
      const tools = (await mcp.client.listTools()).tools;
      assert.ok(!tools.some((tool) => tool.name === 'memory_embed'));
      const reply = await mcp.call('context_retrieve', query);
      assert.equal(reply.isError, undefined);
      const text = reply.content.find((item) => item.type === 'text');
      assert.ok(text && text.type === 'text');
      const value = JSON.parse(text.text);
      assert.deepEqual(value.ids, [note.id]);
      assert.deepEqual(value.candidates, [{ id: note.id, source: 'vectors' }]);
      assert.match(value.text, /pnpm/);
      const negative = await f.rpc('context.retrieve', { ...query, task: 'unrelated weather' });
      assert.deepEqual(negative.ids, []);
    } finally {
      await mcp.close();
    }
    const embeddings = f.server.requests.filter((r) => r.path === '/api/embed');
    assert.equal(embeddings.length, 3);
    assert.deepEqual(embeddings[0].body.input, [
      'title: Build rules | text: Use pnpm for package installation.',
    ]);
    assert.equal(f.calls(), 0, 'native agent runner is never selected for embeddings');
  } finally {
    await f.close();
  }
});

test('classification precedes payload getters; owner indexing rejects private, proposed and foreign IDs before model metadata', async () => {
  let touched = 0;
  for (const privacy of ['private', 'unknown', undefined]) {
    assert.throws(
      () =>
        methodParams({
          version: 1,
          id: 'private',
          method: 'context.retrieve',
          params: {
            privacy,
            sources: ['vectors'],
            get task() {
              touched++;
              throw Error('payload');
            },
          },
          scope: { workspace: '/', audience: 'model', sessionId: null },
        }),
      code('private_input'),
    );
  }
  assert.equal(touched, 0);
  const f = await fixture();
  try {
    const privateNote = await store(f, { private: true });
    const proposed = await store(f, { title: 'Proposal', status: 'proposed' });
    const foreign = await store(
      f,
      { title: 'Foreign' },
      { ...f.scope, workspace: gitRepo(f.sb, 'foreign') },
    );
    for (const note of [privateNote, proposed, foreign])
      await assert.rejects(f.rpc('memory.embed', request(note.id)), code('not_found'));
    await assert.rejects(
      f.rpc('memory.embed', request(privateNote.id), { ...f.scope, audience: 'model' }),
      code('unsupported'),
    );
    await assert.rejects(
      f.rpc('context.retrieve', { ...query, privacy: 'private' }),
      code('private_input'),
    );
    await assert.rejects(
      f.rpc('job.submit', {
        privacy: 'public',
        requestId: 'reserved',
        taskId: 'reserved',
        runnerId: 'bosun-embedding-index',
        model: MODEL,
        prompt: 'public',
        access: 'edit',
      }),
      code('unsupported'),
    );
    assert.deepEqual(f.server.requests, []);
    assert.deepEqual(
      (await f.rpc('job.list', {})).jobs.filter(
        (job: { runnerId: string }) => job.runnerId === 'bosun-embedding-index',
      ),
      [],
    );
    assert.equal(f.rows(), 0);
  } finally {
    await f.close();
  }
});

test('disabled or empty vector sources leave defaults intact and make no model calls', async () => {
  for (const options of [{ vectors: false }, { backend: 'disabled' }, {}]) {
    const f = await fixture(options);
    try {
      assert.deepEqual((await f.rpc('context.retrieve', query)).ids, []);
      await f.rpc('context.retrieve', { task: 'public question' });
      assert.deepEqual(f.server.requests, []);
      if (options.vectors === false) {
        const note = await store(f);
        await assert.rejects(f.rpc('memory.embed', request(note.id)), code('unsupported'));
      }
    } finally {
      await f.close();
    }
  }
});

test('source revocation during metadata or embedding prevents storage and preserves sticky original job receipt', async () => {
  for (const phase of ['onTags', 'onEmbed'] as const) {
    let f: Awaited<ReturnType<typeof fixture>>,
      note: any,
      changed = false;
    f = await fixture({
      [phase]: async () => {
        if (changed) return;
        changed = true;
        await f.rpc('memory.update', {
          id: note.id,
          expectedVersion: note.version,
          patch: { private: true },
        });
      },
    });
    try {
      note = await store(f);
      const queued = await f.rpc('memory.embed', request(note.id));
      assert.equal((await terminal(f, queued.job.id)).state, 'unknown');
      assert.equal(f.rows(), 0);
      assert.equal(
        f.server.requests.filter((r) => r.path === '/api/embed').length,
        phase === 'onTags' ? 0 : 1,
      );
      const count = f.server.requests.length;
      const again = await f.rpc('memory.embed', request(note.id));
      assert.equal(again.job.id, queued.job.id);
      assert.equal(again.duplicate, true);
      assert.equal(f.server.requests.length, count);
      assert.equal((await f.rpc('memory.get', { id: note.id })).memory.private, true);
    } finally {
      await f.close();
    }
  }
});

test('workspace origin drift during embedding holds without derived data or replay', async () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  f = await fixture({
    onEmbed: async () => {
      const config = path.join(f.workspace, '.git', 'config');
      fs.writeFileSync(
        config,
        fs.readFileSync(config, 'utf8') +
          '\n[remote "origin"]\nurl = https://example.invalid/changed.git\n',
      );
    },
  });
  try {
    const note = await store(f);
    const queued = await f.rpc('memory.embed', request(note.id));
    // Scope changes with Git origin, so inspect the original receipt through its
    // existing native metadata rather than rebinding the request to another project.
    let state: unknown;
    for (let n = 0; n < 200; n++) {
      const row = new SqliteDatabase(f.paths.state, { readOnly: true });
      try {
        state = row.prepare('SELECT state FROM jobs WHERE id=?').get(queued.job.id)?.state;
      } finally {
        row.close();
      }
      if (state === 'unknown') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(state, 'unknown', 'original durable receipt remains unknown');
    assert.equal(f.rows(), 0);
    assert.equal(f.server.requests.filter((r) => r.path === '/api/embed').length, 1);
  } finally {
    await f.close();
  }
});

test('cancelled embedding and successful native store with lost return retain unknown and never resubmit', async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const slow = await fixture({ slow: true, onEmbed: async () => entered() });
  try {
    const note = await store(slow);
    const queued = await slow.rpc('memory.embed', request(note.id));
    await started;
    await slow.rpc('job.cancel', { id: queued.job.id });
    assert.equal((await terminal(slow, queued.job.id)).state, 'unknown');
    assert.equal(slow.rows(), 0);
    assert.equal((await slow.rpc('memory.embed', request(note.id))).job.id, queued.job.id);
    assert.equal(slow.server.requests.filter((r) => r.path === '/api/embed').length, 1);
  } finally {
    await slow.close();
  }
  const f = await fixture(),
    original = SqliteEmbeddings.prototype.store;
  try {
    SqliteEmbeddings.prototype.store = function (...args) {
      original.apply(this, args);
      throw new BosunError('unavailable', 'lost store return', { details: { outcome: 'unknown' } });
    };
    const note = await store(f);
    const before = await f.rpc('memory.get', { id: note.id, events: true });
    const queued = await f.rpc('memory.embed', request(note.id));
    assert.equal((await terminal(f, queued.job.id)).state, 'unknown');
    assert.equal(f.rows(), 1, 'actual committed derived data survives the lost return');
    assert.deepEqual(await f.rpc('memory.get', { id: note.id, events: true }), before);
    assert.equal((await f.rpc('memory.embed', request(note.id))).job.id, queued.job.id);
    assert.equal(f.rows(), 1);
    assert.equal(f.server.requests.filter((r) => r.path === '/api/embed').length, 1);
  } finally {
    SqliteEmbeddings.prototype.store = original;
    await f.close();
  }
});

test('multi-batch indexing preserves Unicode spans and commits only after every source remains public', async () => {
  for (const revoke of [false, true]) {
    let f: Awaited<ReturnType<typeof fixture>>,
      notes: any[] = [],
      calls = 0;
    f = await fixture({
      onEmbed: async () => {
        if (++calls === 2 && revoke)
          await f.rpc('memory.update', {
            id: notes[2].id,
            expectedVersion: notes[2].version,
            patch: { private: true },
          });
      },
    });
    try {
      const body = 'x'.repeat(999) + '😺' + 'y'.repeat(1020);
      for (let n = 0; n < 3; n++)
        notes.push(await store(f, { title: `Unicode source ${n}`, body }));
      const before = await f.rpc('memory.get', { id: notes[0].id, events: true });
      const queued = await f.rpc('memory.embed', {
        privacy: 'public',
        requestId: 'chunks',
        ids: notes.map((note) => note.id),
      });
      const job = await terminal(f, queued.job.id);
      assert.equal(job.state, revoke ? 'unknown' : 'succeeded');
      assert.equal(
        f.rows(),
        revoke ? 0 : 9,
        'one final admitted store, never partial batch writes',
      );
      assert.equal(calls, 2);
      const inputs = f.server.requests
        .filter((row) => row.path === '/api/embed')
        .flatMap((row) => row.body.input);
      assert.equal(inputs.length, 9);
      assert.ok(
        inputs.every((text: string) => text.isWellFormed()),
        'chunk boundaries retain surrogate pairs',
      );
      assert.deepEqual(await f.rpc('memory.get', { id: notes[0].id, events: true }), before);
      if (!revoke) {
        const rows = f.observer
          .prepare('SELECT start,end,chunk FROM memory_embeddings WHERE memory_id=? ORDER BY chunk')
          .all(notes[0].id);
        assert.deepEqual(
          rows.map((row) => [row.start, row.end]),
          [
            [0, 999],
            [999, 1999],
            [1999, body.length],
          ],
        );
        const result = JSON.parse((await f.rpc('job.result', { id: job.id })).result);
        assert.equal(result.tokensIn, 14);
        assert.equal(result.chunks, 9);
        assert.equal(result.sources, 3);
        assert.equal(result.model, MODEL);
        assert.equal(result.digest, DIGEST);
      }
    } finally {
      await f.close();
    }
  }
});

test('optional query cache rechecks current source generation, keeps sessions separate and evicts at its bound', async () => {
  const f = await fixture({ cacheSize: 1 });
  try {
    const note = await store(f);
    const queued = await f.rpc('memory.embed', request(note.id));
    assert.equal((await terminal(f, queued.job.id)).state, 'succeeded');
    const embeds = () => f.server.requests.filter((row) => row.path === '/api/embed').length;
    const first = await f.rpc('context.retrieve', query);
    assert.deepEqual(first.ids, [note.id]);
    const count = f.server.requests.length;
    assert.deepEqual((await f.rpc('context.retrieve', query)).ids, first.ids);
    assert.equal(
      f.server.requests.length,
      count,
      'a verified hit makes no provider metadata or inference call',
    );
    await f.rpc('context.retrieve', query, { ...f.scope, sessionId: 'other_session' });
    assert.equal(embeds(), 3, 'another session cannot reuse the cached query');
    await f.rpc('context.retrieve', query);
    assert.equal(embeds(), 4, 'size1 evicted the previous session entry');
    const updated = (
      await f.rpc('memory.update', {
        id: note.id,
        expectedVersion: note.version,
        patch: { body: 'Use yarn for package installation.' },
      })
    ).memory;
    assert.deepEqual(
      (await f.rpc('context.retrieve', query)).ids,
      [],
      'source edit removes old derived rows before a cache hit',
    );
    assert.equal(embeds(), 4);
    const next = await f.rpc('memory.embed', request(note.id, 'reindex'));
    assert.equal((await terminal(f, next.job.id)).state, 'succeeded');
    const after = await f.rpc('context.retrieve', query);
    assert.match(after.text, /yarn/);
    assert.equal(embeds(), 6, 'a new generation cannot reuse the old query entry');
    assert.equal(updated.version, note.version + 1);
    await assert.rejects(
      f.rpc('context.retrieve', { ...query, privacy: 'private' }),
      code('private_input'),
    );
    assert.equal(embeds(), 6);
  } finally {
    await f.close();
  }
  for (const options of [{ cacheSize: 0 }, { cacheSize: 1, cacheTtlMs: 1 }]) {
    const f = await fixture(options);
    try {
      const note = await store(f);
      const queued = await f.rpc('memory.embed', request(note.id));
      assert.equal((await terminal(f, queued.job.id)).state, 'succeeded');
      await f.rpc('context.retrieve', query);
      await new Promise((resolve) => setTimeout(resolve, 10));
      await f.rpc('context.retrieve', query);
      assert.equal(
        f.server.requests.filter((row) => row.path === '/api/embed').length,
        3,
        'disabled or expired cache does not reuse vectors',
      );
    } finally {
      await f.close();
    }
  }
});

test('corpus revocation during a query holds the reply and cannot populate a cache from an uncertain result', async () => {
  let f: Awaited<ReturnType<typeof fixture>>,
    second: any,
    calls = 0;
  f = await fixture({
    cacheSize: 2,
    onEmbed: async () => {
      if (++calls === 2)
        await f.rpc('memory.update', {
          id: second.id,
          expectedVersion: second.version,
          patch: { private: true },
        });
    },
  });
  try {
    const first = await store(f);
    second = await store(f, { title: 'Revoked other source' });
    const queued = await f.rpc('memory.embed', {
      privacy: 'public',
      requestId: 'both',
      ids: [first.id, second.id],
    });
    assert.equal((await terminal(f, queued.job.id)).state, 'succeeded');
    await assert.rejects(
      f.rpc('context.retrieve', query),
      (error: unknown) =>
        code('unavailable')(error) && (error as BosunError).details?.outcome === 'unknown',
      'changed generation is held across the asynchronous query',
    );
    const reply = await f.rpc('context.retrieve', query);
    assert.deepEqual(reply.ids, [first.id]);
    assert.equal(calls, 3, 'uncertain query was never cached');
    assert.deepEqual((await f.rpc('context.retrieve', query)).ids, [first.id]);
    assert.equal(calls, 3);
  } finally {
    await f.close();
  }
});
