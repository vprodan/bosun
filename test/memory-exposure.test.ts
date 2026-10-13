import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { runtimeFixture } from './runtime-fixture.ts';
import { mcpFixture } from './mcp-fixture.ts';
import { mayExposeMemory } from '../src/core/memory-policy.ts';
import {
  modelMemoryReply,
  modelMemoryStoreReply,
  modelMemoryHits,
  publicMemory,
} from '../src/core/memory-presentation.ts';
import { createCuratedSource } from '../src/core/memory-source.ts';
import { createRetrieveContext } from '../src/core/use-cases/retrieve-context.ts';
import type { Memory, Found, Ctx } from '../src/core/domain/memory.ts';
import { MemoryError } from '../src/core/errors.ts';
import { rpcError } from '../src/contracts/rpc.ts';
import { contentHash } from '../src/platform/content-hash.ts';
import { project } from '../src/platform/project.ts';
import { DaemonOwner } from '../src/platform/daemon-owner.ts';
import { CutoverWriter } from '../src/adapters/memory/sqlite-cutover.ts';
import { version } from '../src/platform/assets.ts';

const CANARY = 'PRIVATE-CONTENT-CANARY-4289',
  OPAQUE = { memory: { private: true } },
  CTX: Ctx = { projectId: 'p_fixture', sessionId: null, linked: [] };
const FIELDS =
  'id title body tags category status projectId sessionId source sourceRef hash events version createdAt updatedAt expiresAt accessedAt accessCount rank matched shared derivative toJSON'.split(
    ' ',
  );
const data = (value: { structuredContent?: unknown }): any => value.structuredContent;
function noCanary(value: unknown) {
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE-CONTENT-CANARY|987654321/);
}
function publicRecord(projectId = CTX.projectId): Found {
  return {
    private: false,
    id: 'm_public',
    category: 'project',
    projectId,
    sessionId: null,
    title: 'Public title',
    body: 'Public body',
    tags: ['public'],
    status: 'active',
    shared: false,
    source: 'owner',
    sourceRef: null,
    hash: contentHash('Public title', 'Public body'),
    createdAt: 1,
    updatedAt: Date.now(),
    expiresAt: null,
    accessedAt: null,
    accessCount: 0,
    version: 1,
    rank: -1,
    matched: 1,
  };
}
function denied(flag: unknown, omit = false, throws = false) {
  const reads: string[] = [],
    value: Record<string, unknown> = {};
  if (!omit)
    Object.defineProperty(value, 'private', {
      get() {
        reads.push('private');
        if (throws) throw Error(CANARY);
        return flag;
      },
    });
  for (const field of FIELDS)
    Object.defineProperty(value, field, {
      enumerable: true,
      get() {
        reads.push(field);
        throw Error(CANARY + '-' + field);
      },
    });
  return { value: value as unknown as Found, reads };
}

test('final model policy rejects malformed/inherited/throwing classifications before payload getters', () => {
  for (const flag of [true, undefined, null, 'true', 'false', 0, 1, {}, [], NaN]) {
    const row = denied(flag);
    assert.equal(mayExposeMemory(row.value, 'model'), false);
    assert.deepEqual(row.reads, ['private']);
  }
  const missing = denied(undefined, true),
    throwing = denied(false, false, true),
    inherited = denied(undefined, true);
  Object.setPrototypeOf(inherited.value, { private: false });
  for (const row of [missing, throwing, inherited]) {
    assert.equal(mayExposeMemory(row.value, 'model'), false);
    assert.ok(row.reads.every((field) => field === 'private'));
  }
  for (const input of [null, undefined, false, 'false', [], () => false])
    assert.equal(mayExposeMemory(input, 'model'), false);
});
test('final mutation projections keep private and unclassified receipts opaque without duplicate or metadata getters', () => {
  for (const flag of [true, undefined, null, 'true', 'false', 0, 1, {}, []]) {
    const row = denied(flag);
    assert.deepEqual(modelMemoryReply(row.value), OPAQUE);
    assert.deepEqual(
      modelMemoryStoreReply({
        memory: row.value,
        get duplicate(): boolean {
          throw Error(CANARY);
        },
      }),
      OPAQUE,
    );
    assert.deepEqual(row.reads, ['private', 'private']);
    assert.deepEqual(modelMemoryReply(row.value, true), OPAQUE);
    assert.deepEqual(row.reads, ['private', 'private']);
  }
});
test('explicit private requests never inspect a buggy public adapter reply or duplicate state', () => {
  let reads = 0;
  const reply = {
    get memory(): Memory {
      reads++;
      throw Error(CANARY);
    },
    get duplicate(): boolean {
      reads++;
      throw Error(CANARY);
    },
  };
  assert.deepEqual(modelMemoryStoreReply(reply, true), OPAQUE);
  const row = new Proxy(publicRecord(), {
    get() {
      reads++;
      throw Error(CANARY);
    },
  });
  assert.deepEqual(modelMemoryReply(row, true), OPAQUE);
  assert.equal(reads, 0);
});
test('final public projection retains declared ID/hash/version and ignores serialization or derivative hooks', () => {
  const row = publicRecord();
  let hooks = 0;
  for (const field of ['toJSON', 'events', 'derivative'])
    Object.defineProperty(row, field, {
      enumerable: true,
      get() {
        hooks++;
        throw Error(CANARY);
      },
    });
  Object.defineProperty(row.tags, 'toJSON', {
    get() {
      hooks++;
      throw Error(CANARY);
    },
  });
  const result = modelMemoryStoreReply({ memory: row, duplicate: true }) as any;
  assert.equal(result.memory.id, row.id);
  assert.equal(result.memory.hash, row.hash);
  assert.equal(result.memory.version, 1);
  assert.equal(result.duplicate, true);
  assert.deepEqual(result.memory.tags, ['public']);
  noCanary(result);
  assert.equal(hooks, 0);
  assert.ok(!('events' in publicMemory(row)));
});
test('curated and model search classify first and ignore array species/toJSON during real packing', async () => {
  const hidden = [true, undefined, null, 'false', 0].map((flag) => denied(flag));
  let hooks = 0;
  class Rows extends Array<Found> {
    static get [Symbol.species](): ArrayConstructor {
      hooks++;
      throw Error(CANARY);
    }
    get toJSON(): never {
      hooks++;
      throw Error(CANARY);
    }
  }
  const rows = new Rows(...hidden.map((row) => row.value), publicRecord());
  assert.deepEqual(
    modelMemoryHits(rows).map((row) => row.id),
    ['m_public'],
  );
  const queries: unknown[] = [];
  const source = createCuratedSource({
    search: async (query) => {
      queries.push(query.includePrivate);
      return rows;
    },
  });
  assert.deepEqual(
    (await source.search('Public', CTX, 10)).map((hit) => hit.id),
    ['m_public'],
  );
  const result = await createRetrieveContext([source], {
    now: Date.now,
    monotonic: () => performance.now(),
    hash: contentHash,
    dateLabel: (at) => new Date(at).toISOString().slice(0, 10),
    measure() {},
  })('Public', CTX, { budgetTokens: 400, minScore: 0, itemChars: 400 });
  assert.deepEqual(
    result.items.map((hit) => hit.id),
    ['m_public'],
  );
  noCanary(result);
  assert.equal(hooks, 0);
  assert.deepEqual(queries, [false, false]);
  for (const row of hidden) assert.ok(row.reads.every((field) => field === 'private'));
});
test('finite storage errors never inspect messages, versions, causes or serialization hooks', () => {
  for (const code of ['invalid', 'not_found', 'conflict', 'unavailable', CANARY]) {
    let reads = 0;
    const error = new MemoryError(code as never, CANARY, 987654321);
    for (const field of ['message', 'current', 'cause', 'toJSON'])
      Object.defineProperty(error, field, {
        get() {
          reads++;
          throw Error(CANARY);
        },
      });
    noCanary(rpcError(error));
    assert.equal(reads, 0);
  }
  const error = new MemoryError('conflict', CANARY);
  Object.defineProperty(error, 'code', {
    get() {
      throw Error(CANARY);
    },
  });
  noCanary(rpcError(error));
});

async function remoteFixture(errors = false) {
  const authorityId = crypto.randomUUID(),
    sourceId = crypto.randomUUID(),
    requests: any[] = [];
  let pid = '';
  const server = http.createServer((incoming, outgoing) => {
    let body = '';
    incoming.on('data', (bytes) => (body += bytes));
    incoming.on('end', () => {
      const input = body ? JSON.parse(body) : null;
      requests.push(input);
      outgoing.writeHead(200, {
        'content-type': 'application/json',
        'x-bosun-authority': authorityId,
      });
      if (incoming.url === '/v1/identity') {
        outgoing.end(
          JSON.stringify({
            protocol: 1,
            version,
            memorySchema: 2,
            authorityId,
            sourceId,
            projectId: pid,
            serverTime: Date.now(),
          }),
        );
        return;
      }
      if (errors) {
        outgoing.end(
          JSON.stringify({
            version: 1,
            id: input.id,
            ok: false,
            error: { code: 'conflict', message: CANARY, details: { currentVersion: 987654321 } },
          }),
        );
        return;
      }
      const publicRow = publicRecord(pid),
        privateRow = {
          ...publicRow,
          private: true,
          id: CANARY + '-id',
          title: CANARY,
          body: CANARY,
          tags: [CANARY],
          source: CANARY,
          sourceRef: CANARY,
          hash: CANARY,
          version: 987654321,
        };
      const result =
        input.method === 'memory.search'
          ? {
              hits: [
                privateRow,
                { ...privateRow, private: 'false' },
                { ...privateRow, private: null },
                { ...privateRow, private: undefined },
                publicRow,
              ],
            }
          : input.params.private === true || input.params.patch?.private === true
            ? { memory: publicRow, duplicate: true }
            : { memory: privateRow, duplicate: true };
      outgoing.end(JSON.stringify({ version: 1, id: input.id, ok: true, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  let f: Awaited<ReturnType<typeof runtimeFixture>> | undefined;
  try {
    f = await runtimeFixture(
      `[remote]\nauthority=${JSON.stringify(url)}\nauthorityId=${JSON.stringify(authorityId)}\n`,
      {
        env: {
          BOSUN_REMOTE_TOKEN: 'Owner_fixture_credential_'.repeat(3),
          BOSUN_REMOTE_MODEL_TOKEN: 'Model_fixture_credential_'.repeat(3),
        },
      },
    );
    pid = project(f.workspace).id;
    return {
      ...f,
      requests,
      async close() {
        await f!.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  } catch (error) {
    await f?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }
}
test('modern remote MCP filters private/unknown metadata and suppresses buggy public replies to explicit private requests', async () => {
  const f = await remoteFixture();
  let session: Awaited<ReturnType<typeof mcpFixture>> | undefined;
  try {
    session = await mcpFixture(f.env, f.workspace);
    for (const [name, args] of [
      ['memory_get', { id: 'm_fixture' }],
      ['memory_store', { category: 'project', title: 'Public', body: 'Public body' }],
      ['memory_update', { id: 'm_fixture', expectedVersion: 1, patch: { title: 'Public edit' } }],
      ['memory_delete', { id: 'm_fixture' }],
      [
        'memory_store',
        { category: 'project', title: 'Private request', body: 'Private body', private: true },
      ],
      ['memory_update', { id: 'm_fixture', expectedVersion: 1, patch: { private: true } }],
    ] as const) {
      const reply = await session.call(name, args);
      assert.deepEqual(data(reply), OPAQUE);
      noCanary(reply);
    }
    assert.deepEqual(
      data(await session.call('memory_search', { text: 'Public' })).hits.map((row: any) => row.id),
      ['m_public'],
    );
    const packed = await session.call('context_retrieve', { task: 'Public', sources: ['curated'] });
    assert.deepEqual(data(packed).ids, ['m_public']);
    noCanary(packed);
    assert.ok(
      f.requests
        .filter((input) => input?.method === 'memory.search')
        .every((input) => input.params.includePrivate === false),
    );
    assert.equal(f.calls(), 0);
    noCanary(session.stderr());
  } finally {
    await session?.close();
    await f.close();
  }
});
test('modern remote MCP normalizes content-bearing errors and excludes failed context derivatives', async () => {
  const f = await remoteFixture(true);
  let session: Awaited<ReturnType<typeof mcpFixture>> | undefined;
  try {
    session = await mcpFixture(f.env, f.workspace);
    for (const [name, args] of [
      ['memory_get', { id: 'm_fixture' }],
      ['memory_store', { category: 'project', title: 'Public', body: 'Public' }],
      ['memory_update', { id: 'm_fixture', expectedVersion: 1, patch: { title: 'Public' } }],
      ['memory_delete', { id: 'm_fixture' }],
      ['memory_search', { text: 'Public' }],
    ] as const) {
      const reply = await session.call(name, args);
      assert.equal(reply.isError, true);
      assert.equal(data(reply).error.code, 'conflict');
      assert.equal(data(reply).error.details, undefined);
      noCanary(reply);
    }
    const context = await session.call('context_retrieve', {
      task: 'Public',
      sources: ['curated'],
    });
    assert.deepEqual(data(context).ids, []);
    noCanary(context);
    noCanary(session.stderr());
  } finally {
    await session?.close();
    await f.close();
  }
});
test('owner CLI preserves private IDs/content/provenance/audit while modern MCP cannot expose duplicates or mutate hidden rows', async () => {
  const f = await runtimeFixture();
  let session: Awaited<ReturnType<typeof mcpFixture>> | undefined;
  try {
    session = await mcpFixture(f.env, f.workspace);
    const input = {
      category: 'project',
      title: CANARY + ' title',
      body: CANARY + ' body',
      tags: ['private-canary-tag'],
      private: true,
    };
    for (let n = 0; n < 2; n++)
      assert.deepEqual(data(await session.call('memory_store', input)), OPAQUE);
    const search = await f.cli(['memory', 'search', CANARY, '--private']);
    assert.equal(search.code, 0, search.err);
    const note = JSON.parse(search.out).hits[0];
    assert.match(note.id, /^m_[0-9a-v]{9}[0-9a-f]{8}$/);
    const read = async () =>
      JSON.parse((await f.cli(['memory', 'get', note.id, '--events'])).out).memory;
    const before = await read();
    assert.equal(before.body, input.body);
    assert.equal(before.source, 'rpc:model');
    assert.deepEqual(
      before.events.map((event: any) => event.op),
      ['store'],
    );
    assert.deepEqual(data(await session.call('memory_get', { id: note.id })), OPAQUE);
    for (const [name, args] of [
      ['memory_update', { id: note.id, expectedVersion: 1, patch: { private: false } }],
      ['memory_update', { id: note.id, expectedVersion: 1, patch: { body: CANARY + ' edit' } }],
      ['memory_delete', { id: note.id }],
    ] as const) {
      const reply = await session.call(name, args);
      assert.equal(reply.isError, true);
      noCanary(reply);
    }
    assert.deepEqual(await read(), before);
    const changed = await f.cli([
      'memory',
      'update',
      note.id,
      '--version',
      '1',
      '--patch',
      JSON.stringify({ body: CANARY + ' owner edit' }),
    ]);
    assert.equal(changed.code, 0, changed.err);
    assert.equal((await read()).version, 2);
    await f.rpc('memory.delete', { id: note.id });
    const archived = await read();
    assert.equal(archived.version, 3);
    assert.deepEqual(
      archived.events.map((event: any) => event.op),
      ['store', 'update', 'archive'],
    );
    await f.rpc('memory.update', { id: note.id, expectedVersion: 3, patch: { private: false } });
    assert.equal((await read()).private, false);
    noCanary(fs.readFileSync(path.join(f.paths.home, 'daemon.log'), 'utf8'));
    assert.equal(f.calls(), 0);
  } finally {
    await session?.close();
    await f.close();
  }
});
test('native malformed flags remain opaque, immutable to models and byte-preserved through owner edits', async () => {
  const notes: { id: string; title: string; body: string }[] = [];
  const f = await runtimeFixture('', {
    beforeStart(paths, workspace) {
      const owner = new DaemonOwner(paths.owner),
        writer = new CutoverWriter({
          primary: paths.memory,
          view: paths.view,
          backups: paths.backups,
        });
      try {
        writer.transaction((db) => {
          const pid = project(workspace).id,
            at = Date.now();
          for (const [i, flag] of [
            '',
            'false',
            -1,
            2,
            0.5,
            new Uint8Array(),
            new Uint8Array([48]),
          ].entries()) {
            const title = CANARY + ' title ' + i,
              body = CANARY + ' constellation ' + i,
              id = CANARY + '-id-' + i,
              hash = contentHash(title, body);
            db.prepare(
              'INSERT INTO memories(id,category,project_id,title,body,tags,private,shared,source,source_ref,hash,created_at,updated_at,version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,987654321)',
            ).run(
              id,
              'project',
              pid,
              title,
              body,
              '["private-canary-tag"]',
              flag,
              flag,
              CANARY,
              CANARY,
              hash,
              at,
              at,
            );
            db.prepare(
              'INSERT INTO memory_events(memory_id,op,at,source,hash_after) VALUES(?,?,?,?,?)',
            ).run(id, 'store', at, CANARY, CANARY);
            notes.push({ id, title, body });
          }
        });
      } finally {
        writer.close();
        owner.close();
      }
    },
  });
  let session: Awaited<ReturnType<typeof mcpFixture>> | undefined;
  const raw = (id: string) => {
    const writer = new CutoverWriter({
      primary: f.paths.memory,
      view: f.paths.view,
      backups: f.paths.backups,
    });
    try {
      return writer.read((db) =>
        db
          .prepare(
            'SELECT typeof(private) p,hex(private) pb,typeof(shared) s,hex(shared) sb FROM memories WHERE id=?',
          )
          .get(id),
      );
    } finally {
      writer.close();
    }
  };
  try {
    session = await mcpFixture(f.env, f.workspace);
    const publicNote = (
      await f.rpc('memory.store', {
        category: 'project',
        title: 'Constellation public',
        body: 'Constellation public fixture',
      })
    ).memory;
    for (const note of notes) {
      const before = raw(note.id),
        ownerBefore = await f.rpc('memory.get', { id: note.id, events: true });
      assert.deepEqual(data(await session.call('memory_get', { id: note.id })), OPAQUE);
      assert.deepEqual(
        data(
          await session.call('memory_store', {
            category: 'project',
            title: note.title,
            body: note.body,
            private: false,
            shared: true,
          }),
        ),
        OPAQUE,
      );
      for (const [name, args] of [
        ['memory_update', { id: note.id, expectedVersion: 987654321, patch: { private: false } }],
        [
          'memory_update',
          { id: note.id, expectedVersion: 987654321, patch: { body: note.body + ' edited' } },
        ],
        ['memory_delete', { id: note.id }],
      ] as const) {
        const reply = await session.call(name, args);
        assert.equal(reply.isError, true);
        noCanary(reply);
      }
      assert.deepEqual(await f.rpc('memory.get', { id: note.id, events: true }), ownerBefore);
      assert.deepEqual(raw(note.id), before);
      await f.rpc('memory.update', {
        id: note.id,
        expectedVersion: 987654321,
        patch: { body: note.body + ' owner edit' },
      });
      assert.deepEqual(raw(note.id), before);
      await f.rpc('memory.delete', { id: note.id });
      assert.deepEqual(raw(note.id), before);
      const archived = (await f.rpc('memory.get', { id: note.id, events: true })).memory;
      assert.equal(archived.id, note.id);
      assert.equal(archived.version, 987654323);
      assert.deepEqual(
        archived.events.map((event: any) => event.op),
        ['store', 'update', 'archive'],
      );
    }
    const search = await session.call('memory_search', { text: 'constellation', limit: 50 });
    assert.deepEqual(
      data(search).hits.map((row: any) => row.id),
      [publicNote.id],
    );
    noCanary(search);
    const context = await session.call('context_retrieve', {
      task: 'constellation',
      sources: ['curated'],
    });
    assert.deepEqual(data(context).ids, [publicNote.id]);
    noCanary(context);
  } finally {
    await session?.close();
    await f.close();
  }
});
test('native scoped context rejects caller project claims and keeps owner-only data out of model tools', async () => {
  const f = await runtimeFixture();
  let session: Awaited<ReturnType<typeof mcpFixture>> | undefined;
  try {
    const note = (
      await f.rpc('memory.store', {
        category: 'project',
        title: CANARY,
        body: CANARY,
        private: true,
      })
    ).memory;
    session = await mcpFixture(f.env, f.workspace);
    assert.equal((await f.rpc('memory.get', { id: note.id, events: true })).memory.body, CANARY);
    const reply = await session.call('context_retrieve', {
      task: 'Public',
      projectId: 'p_foreign',
      sources: ['curated'],
    });
    assert.equal(reply.isError, true);
    noCanary(reply);
    assert.ok(
      !(await session.client.listTools()).tools.some((tool) => tool.name === 'memory_accept'),
    );
    assert.deepEqual(
      data(await session.call('context_retrieve', { task: 'Public', sources: ['curated'] })).ids,
      [],
    );
    assert.deepEqual(data(await session.call('memory_get', { id: note.id })), OPAQUE);
  } finally {
    await session?.close();
    await f.close();
  }
});
test('completed mutation DTO retains captured privacy when later owner state becomes public', () => {
  const persisted = publicRecord(),
    captured = { ...persisted, private: true };
  persisted.private = false;
  assert.deepEqual(modelMemoryReply(captured), OPAQUE);
  assert.deepEqual(modelMemoryStoreReply({ memory: captured, duplicate: false }), OPAQUE);
  assert.equal(persisted.private, false);
});
