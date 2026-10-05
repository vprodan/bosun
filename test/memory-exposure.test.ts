import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, fresh, bosun, mock, gitRepo, mcpSession } from './helpers.ts';
import { load, P } from '../lib/config.ts';
import { tools, handle, type Tool } from '../lib/mcp.ts';
import { curated, retrieve } from '../lib/context.ts';
import { memoryServer, listen } from '../lib/serve.ts';
import { MemoryError, type Memory, type MemoryApi, type Found, type Ctx } from '../lib/memory/types.ts';
import { mayExposeMemory } from '../src/core/memory-policy.ts';

const CTX: Ctx = { projectId: 'p_fixture', sessionId: null, linked: [] };
const O = { budgetTokens: 400, minScore: 0, itemChars: 400 };
const OPAQUE = { memory: { private: true } };
const CANARY = 'PRIVATE-CONTENT-CANARY-4289';
const FIELDS = ['id', 'title', 'body', 'tags', 'category', 'status', 'projectId', 'sessionId', 'source', 'sourceRef',
  'hash', 'events', 'version', 'createdAt', 'updatedAt', 'expiresAt', 'accessedAt', 'accessCount', 'rank', 'matched', 'shared', 'derivative', 'toJSON'];
const ARGS: Record<string, object> = {
  memory_get: { id: 'm_fixture' }, memory_store: { category: 'project', title: 'Public title', body: 'Public body' },
  memory_update: { id: 'm_fixture', expectedVersion: 1, title: 'Public edit' }, memory_delete: { id: 'm_fixture' },
  memory_search: { query: 'Public' }, context_retrieve: { task: 'Public' },
};
const publicRecord = (): Found => ({
  private: false, id: 'm_public', category: 'project', projectId: CTX.projectId, sessionId: null,
  title: 'Public title', body: 'Public body', tags: ['public'], status: 'active', shared: false,
  source: 'owner', sourceRef: null, hash: 'public-hash', createdAt: 1, updatedAt: Date.now(), expiresAt: null,
  accessedAt: null, accessCount: 0, version: 1, rank: -1, matched: 1,
});
function denied(flag: unknown, omit = false, throws = false) {
  const reads: string[] = [];
  const m: Record<string, unknown> = {};
  if (!omit) Object.defineProperty(m, 'private', { get() { reads.push('private'); if (throws) throw Error(CANARY); return flag; } });
  for (const field of FIELDS) Object.defineProperty(m, field, { enumerable: true, get() { reads.push(field); throw Error(`${CANARY}-${field}`); } });
  return { m: m as unknown as Found, reads };
}
function storeFor(m: Memory, rows: Found[] = [m as Found]): MemoryApi {
  return {
    store: async () => ({ memory: m, duplicate: true }), search: async () => rows, get: async () => m,
    update: async () => m, delete: async () => m, accept: async () => m, reject: async () => m, close() {},
  };
}
function listFor(api: MemoryApi) { return tools(load(), process.env.HOME!, () => api); }
async function call(list: Tool[], name: string, args = ARGS[name]): Promise<any> {
  let reply: any;
  await handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }), list, load(), (r) => { reply = r; });
  // Exercise final serialization too: no returned adapter object should survive the projection.
  return JSON.parse(JSON.stringify(reply)).result;
}
function noCanary(value: unknown) { assert.doesNotMatch(JSON.stringify(value), /PRIVATE-CONTENT-CANARY/); }

test('model record policy denies malformed flags and throwing classifiers before reading any payload', () => {
  for (const flag of [true, undefined, null, 'true', 'false', 0, 1, {}, [], NaN]) {
    const r = denied(flag);
    assert.equal(mayExposeMemory(r.m, 'model'), false);
    assert.deepEqual(r.reads, ['private']);
  }
  const missing = denied(undefined, true);
  assert.equal(mayExposeMemory(missing.m, 'model'), false);
  assert.deepEqual(missing.reads, []);
  const throwing = denied(undefined, false, true);
  assert.equal(mayExposeMemory(throwing.m, 'model'), false);
  assert.deepEqual(throwing.reads, ['private']);
  const inherited = Object.create({ private: false });
  Object.defineProperty(inherited, 'title', { get() { throw Error(CANARY); } });
  assert.equal(mayExposeMemory(inherited, 'model'), false);
  for (const malformed of [null, undefined, false, 'false', [], () => false]) assert.equal(mayExposeMemory(malformed, 'model'), false);
});

test('MCP get/store/update/delete return the same opaque receipt for private and unclassified adapter records', async () => {
  const sb = sandbox();
  try {
    fresh(sb);
    for (const flag of [true, undefined, null, 'true', 'false', 0, 1, {}, []]) for (const name of ['memory_get', 'memory_store', 'memory_update', 'memory_delete']) {
      const r = denied(flag);
      const api = storeFor(r.m);
      api.store = async () => ({ memory: r.m, get duplicate(): boolean { throw Error(`${CANARY}-duplicate`); } });
      const root = listFor(api);
      try {
        const result = await call(root.list, name);
        assert.deepEqual(result.structuredContent, OPAQUE, `${name}/${typeof flag}`);
        assert.deepEqual(JSON.parse(result.content[0].text), OPAQUE);
        assert.deepEqual(r.reads, ['private']);
        noCanary(result);
      } finally { root.close(); }
    }
    const inherited = denied(undefined, true);
    Object.setPrototypeOf(inherited.m, { private: false });
    for (const r of [denied(undefined, true), denied(undefined, false, true), inherited]) {
      const root = listFor(storeFor(r.m));
      try { for (const name of ['memory_get', 'memory_store', 'memory_update', 'memory_delete']) assert.deepEqual((await call(root.list, name)).structuredContent, OPAQUE); }
      finally { root.close(); }
      assert.ok(r.reads.every((field) => field === 'private'));
    }
    for (const malformed of [null, undefined, [], () => false]) {
      const root = listFor(storeFor(malformed as never));
      try { for (const name of ['memory_get', 'memory_store', 'memory_update', 'memory_delete']) assert.deepEqual((await call(root.list, name)).structuredContent, OPAQUE); }
      finally { root.close(); }
    }
  } finally { sb.cleanup(); }
});

test('explicit private store/update receipts do not inspect a buggy adapter reply or duplicate state', async () => {
  const sb = sandbox();
  try {
    fresh(sb);
    let reads = 0;
    const api = storeFor(publicRecord());
    api.store = async () => ({ get memory(): Memory { reads++; throw Error(CANARY); }, get duplicate(): boolean { reads++; throw Error(CANARY); } });
    api.update = async () => new Proxy(publicRecord(), { get(_target, field) { if (field === 'then') return undefined; reads++; throw Error(CANARY); } });
    const root = listFor(api);
    try {
      assert.deepEqual((await call(root.list, 'memory_store', { ...ARGS.memory_store, private: true })).structuredContent, OPAQUE);
      assert.deepEqual((await call(root.list, 'memory_update', { ...ARGS.memory_update, private: true })).structuredContent, OPAQUE);
      assert.equal(reads, 0);
    } finally { root.close(); }
  } finally { sb.cleanup(); }
});

test('MCP public replies retain known fields and duplicate/version behavior without record or tag-array toJSON', async () => {
  const sb = sandbox();
  try {
    fresh(sb);
    const m = publicRecord();
    let reads = 0;
    for (const field of ['toJSON', 'events', 'derivative']) Object.defineProperty(m, field, { enumerable: true, get() { reads++; throw Error(CANARY); } });
    Object.defineProperty(m.tags, 'toJSON', { get() { reads++; throw Error(CANARY); } });
    const root = listFor(storeFor(m));
    try {
      for (const name of ['memory_get', 'memory_store', 'memory_update']) {
        const r = (await call(root.list, name)).structuredContent;
        assert.equal(r.memory.id, m.id);
        assert.equal(r.memory.body, m.body);
        assert.equal(r.memory.version, 1);
        assert.deepEqual(r.memory.tags, ['public']);
        assert.equal(r.memory.private, false);
        assert.ok(!('events' in r.memory) && !('derivative' in r.memory) && !('rank' in r.memory));
        if (name === 'memory_store') assert.equal(r.duplicate, true);
      }
      assert.deepEqual((await call(root.list, 'memory_delete')).structuredContent, { id: 'm_public', status: 'active' });
      assert.equal((await call(root.list, 'memory_search')).structuredContent.hits[0].snippet, 'Public body');
      assert.equal(reads, 0);
    } finally { root.close(); }
  } finally { sb.cleanup(); }
});

test('MCP search and curated packing reject private/unknown hits before getters; returned Array species/toJSON is ignored', async () => {
  const sb = sandbox();
  try {
    fresh(sb);
    const deniedRecords = [true, undefined, null, 'false', 0].map((flag) => denied(flag));
    let hooks = 0;
    class ReturnedRows extends Array<Found> {
      static get [Symbol.species](): ArrayConstructor { hooks++; throw Error(`${CANARY}-species`); }
      get toJSON(): never { hooks++; throw Error(`${CANARY}-collection`); }
    }
    const rows = new ReturnedRows(...deniedRecords.map((r) => r.m), publicRecord());
    const api = storeFor(publicRecord(), rows);
    const queries: unknown[] = [];
    api.search = async (query) => { queries.push(query.includePrivate); return rows; };
    const root = listFor(api);
    try {
      const search = await call(root.list, 'memory_search');
      assert.deepEqual(search.structuredContent.hits.map((h: any) => h.id), ['m_public']);
      const context = await call(root.list, 'context_retrieve', { task: 'Public', sources: ['curated'] });
      assert.deepEqual(context.structuredContent.ids, ['m_public']);
      assert.deepEqual(context.structuredContent.sources, { curated: 1 });
      const r = await retrieve('Public', [curated(api)], CTX, O);
      assert.deepEqual(r.items.map((h) => h.id), ['m_public']);
      assert.deepEqual(r.sources, { curated: 1 });
      noCanary([search, context, r]);
      assert.equal(hooks, 0);
      assert.deepEqual(queries, [false, false, false]);
      for (const deniedRecord of deniedRecords) assert.deepEqual(deniedRecord.reads, ['private', 'private', 'private']);
    } finally { root.close(); }
  } finally { sb.cleanup(); }
});

test('MCP errors carry only finite codes/text, never provider messages, current versions, causes or serialization hooks', async () => {
  const sb = sandbox();
  try {
    fresh(sb);
    for (const code of ['invalid', 'not_found', 'conflict', 'unavailable', `${CANARY}-code`]) {
      let reads = 0;
      const error = new MemoryError(code as never, CANARY, 987654321);
      for (const field of ['message', 'current', 'cause', 'toJSON']) Object.defineProperty(error, field, { get() { reads++; throw Error(CANARY); } });
      const api = storeFor(publicRecord());
      for (const name of ['store', 'search', 'get', 'update', 'delete'] as const) api[name] = (async () => { throw error; }) as never;
      const root = listFor(api);
      try {
        for (const name of Object.keys(ARGS)) {
          const r = await call(root.list, name, name === 'context_retrieve' ? { task: 'Public', sources: ['curated'] } : ARGS[name]);
          assert.equal(r.isError, true);
          assert.deepEqual(r.structuredContent, { error: { code: code.startsWith('PRIVATE-') ? 'unavailable' : code } });
          assert.doesNotMatch(JSON.stringify(r), /987654321|PRIVATE-CONTENT-CANARY/);
        }
        assert.equal(reads, 0);
      } finally { root.close(); }
    }
    const error = new MemoryError('conflict', CANARY);
    Object.defineProperty(error, 'code', { get() { throw Error(CANARY); } });
    const api = storeFor(publicRecord()); api.get = async () => { throw error; };
    const root = listFor(api);
    try { assert.deepEqual((await call(root.list, 'memory_get')).structuredContent, { error: { code: 'unavailable' } }); }
    finally { root.close(); }
  } finally { sb.cleanup(); }
});

test('guarded stdio MCP excludes remote private metadata across reads/mutations/search/context even when filtering is ignored', async () => {
  const sb = sandbox();
  const privateRecord = { ...publicRecord(), private: true, id: `${CANARY}-id`, title: `${CANARY}-title`, body: `${CANARY}-body`, tags: [`${CANARY}-tag`],
    source: `${CANARY}-source`, sourceRef: `${CANARY}-ref`, hash: `${CANARY}-hash`, events: [{ op: `${CANARY}-event` }],
    version: 987654321, createdAt: 987654321, derivative: CANARY };
  const records = [privateRecord, { ...privateRecord, private: 'false' }, { ...privateRecord, private: null }, { ...privateRecord, private: undefined }];
  const routes = Object.fromEntries(['get', 'store', 'update', 'delete', 'search'].map((name) => [`/v1/memory/${name}`, () => ({ json: { ok: true,
    data: name === 'search' ? [...records, publicRecord()] : name === 'store' ? { memory: privateRecord, duplicate: true } : privateRecord } })]));
  const remote = await mock(routes);
  try {
    const repo = gitRepo(sb, 'repo');
    const s = mcpSession(sb.env({ MEMORY_URL: remote.url }), repo);
    try {
      for (const name of ['memory_get', 'memory_store', 'memory_update', 'memory_delete']) {
        const r = await s.call(name, ARGS[name]);
        assert.deepEqual(r.result.structuredContent, OPAQUE);
        noCanary(r);
        assert.doesNotMatch(JSON.stringify(r), /987654321/);
      }
      assert.deepEqual((await s.call('memory_search', ARGS.memory_search)).result.structuredContent.hits.map((h: any) => h.id), ['m_public']);
      const r = await s.call('context_retrieve', { task: 'Public', sources: ['curated'] });
      assert.deepEqual(r.result.structuredContent.ids, ['m_public']);
      noCanary(r);
      assert.ok(remote.requests.filter((r) => r.path === '/v1/memory/search').every((r) => r.body.query.includePrivate === false));
    } finally { const done = await s.close(); assert.equal(done.code, 0); noCanary(done.lines); }
  } finally { await remote.close(); sb.cleanup(); }
});

test('guarded stdio MCP maps remote content-bearing errors and context transport errors without derivatives', async () => {
  const sb = sandbox();
  const remote = await mock(Object.fromEntries(['get', 'store', 'update', 'delete', 'search'].map((name) => [`/v1/memory/${name}`, () => ({ json: {
    ok: false, error: { code: 'conflict', message: `${CANARY}-title-body-source-hash`, current: { toJSON: CANARY, version: 987654321 } },
  } })])));
  try {
    const repo = gitRepo(sb, 'repo');
    const s = mcpSession(sb.env({ MEMORY_URL: remote.url }), repo);
    try {
      for (const name of Object.keys(ARGS)) {
        const r = await s.call(name, name === 'context_retrieve' ? { task: 'Public', sources: ['curated'] } : ARGS[name]);
        assert.equal(r.result.isError, true);
        assert.equal(r.result.content[0].text, 'memory version conflict');
        assert.deepEqual(r.result.structuredContent, { error: { code: 'conflict' } });
        noCanary(r);
        assert.doesNotMatch(JSON.stringify(r), /987654321/);
      }
    } finally { const done = await s.close(); assert.equal(done.code, 0); noCanary(done.lines); }
    const logFile = path.join(sb.home, '.bosun', 'bosun.log');
    if (fs.existsSync(logFile)) assert.doesNotMatch(fs.readFileSync(logFile, 'utf8'), /PRIVATE-CONTENT-CANARY|987654321/);
  } finally { await remote.close(); sb.cleanup(); }
});

test('HTTP curated context rejects buggy private records and maps content-bearing errors while owner endpoints remain compatible', async () => {
  const sb = sandbox();
  try {
    fresh(sb);
    const r = denied(true);
    const api = storeFor(r.m, [r.m, publicRecord()]);
    const server = memoryServer(load(), api, ['127.0.0.1/32']);
    const port = await listen(server, 0, '127.0.0.1');
    const request = () => fetch(`http://127.0.0.1:${port}/v1/context/retrieve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ctx: CTX, task: 'Public' }) });
    try {
      const body = await (await request()).json();
      assert.deepEqual(body.data.items.map((h: any) => h.id), ['m_public']);
      noCanary(body); assert.deepEqual(r.reads, ['private']);
      const e = new MemoryError('conflict', CANARY, 987654321);
      Object.defineProperty(e, 'current', { get() { throw Error(CANARY); } });
      api.search = async () => { throw e; };
      const response = await request();
      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), { ok: false, error: { code: 'conflict', message: 'memory version conflict' } });
    } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  } finally { sb.cleanup(); }
});

test('owner CLI retains private IDs/content/provenance/events and mutations; MCP private receipts reveal no duplicate or status', async () => {
  const sb = sandbox();
  try {
    fresh(sb);
    const repo = gitRepo(sb, 'repo');
    const s = mcpSession(sb.env(), repo);
    try {
      const input = { category: 'project', title: `${CANARY}-title`, body: `${CANARY}-body`, tags: ['private-canary-tag'], private: true };
      for (let i = 0; i < 2; i++) assert.deepEqual((await s.call('memory_store', input)).result.structuredContent, OPAQUE);
      const hits = JSON.parse((await bosun(['memory', 'search', CANARY, '--json'], { env: sb.env(), cwd: repo })).out);
      assert.equal(hits.length, 1);
      const id = hits[0].id;
      assert.match(id, /^m_[0-9a-v]{9}[0-9a-f]{8}$/);
      const get = async () => JSON.parse((await bosun(['memory', 'get', id, '--json'], { env: sb.env(), cwd: repo })).out);
      const owner = await get();
      assert.equal(owner.title, input.title); assert.equal(owner.body, input.body); assert.deepEqual(owner.tags, input.tags);
      assert.equal(owner.private, true); assert.equal(owner.source, 'mcp'); assert.match(owner.hash, /^[a-f0-9]{32}$/);
      assert.deepEqual(owner.events.map((e: any) => e.op), ['store']);
      assert.equal((await s.call('memory_update', { id, expectedVersion: 1, private: false })).result.isError, true);
      assert.deepEqual((await s.call('memory_get', { id })).result.structuredContent, OPAQUE);
      assert.deepEqual((await s.call('memory_update', { id, expectedVersion: 1, body: `${CANARY}-edited` })).result.structuredContent, OPAQUE);
      assert.equal((await get()).version, 2);
      assert.deepEqual((await s.call('memory_delete', { id })).result.structuredContent, OPAQUE);
      assert.deepEqual((await s.call('memory_delete', { id })).result.structuredContent, OPAQUE);
      const archived = await get(); assert.equal(archived.status, 'archived'); assert.equal(archived.version, 3);
      const restore = await bosun(['memory', 'update', id, '--public', '--version', '3'], { env: sb.env(), cwd: repo });
      assert.equal(restore.code, 0); assert.equal((await get()).private, false);
    } finally { assert.equal((await s.close()).code, 0); }
    for (const name of ['bosun.log', 'metrics.jsonl', 'llm-usage.jsonl']) {
      const file = path.join(P.BOSUN, name);
      if (fs.existsSync(file)) assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /PRIVATE-CONTENT-CANARY|private-canary-tag/);
    }
  } finally { sb.cleanup(); }
});
