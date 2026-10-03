import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, fresh, bosun, gitRepo, mcpSession as session, BIN } from './helpers.ts';
import { load, P } from '../lib/config.ts';
import { MemoryService } from '../lib/memory/service.ts';
import { openDb } from '../lib/memory/sqlite.ts';
import * as wire from '../lib/wire.ts';

const names = ['context_retrieve', 'memory_delete', 'memory_get', 'memory_search', 'memory_store', 'memory_update', 'project_knowledge_search'];

test('mcp: initialize echoes supported versions and falls back; tools/list schemas; ping; protocol errors; stdout carries only JSON', async () => {
  const sb = sandbox();
  try {
    const repo = gitRepo(sb, 'shop', 'git@github.com:org/shop.git');
    const s = session(sb.env(), repo);
    let r = await s.rpc(0, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(r.id, 0, 'id 0 is echoed');
    assert.equal(r.result.protocolVersion, '2025-06-18');
    assert.deepEqual(r.result.capabilities, { tools: {} });
    assert.equal(r.result.serverInfo.name, 'bosun');
    assert.match(r.result.instructions, /memory_search/);
    s.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    r = await s.rpc('a-1', 'initialize', { protocolVersion: '2024-01-01' });
    assert.deepEqual([r.id, r.result.protocolVersion], ['a-1', '2025-11-25']);
    assert.deepEqual((await s.rpc(2, 'ping')).result, {});
    const tools = (await s.rpc(3, 'tools/list')).result.tools;
    assert.deepEqual(tools.map((t: any) => t.name).sort(), names);
    for (const t of tools) {
      assert.ok(t.description.length < 300, t.name);
      assert.equal(t.inputSchema.type, 'object');
      assert.equal(t.inputSchema.additionalProperties, false);
      assert.equal(t.annotations.openWorldHint, false);
    }
    const ann = Object.fromEntries(tools.map((t: any) => [t.name, t.annotations]));
    for (const n of ['memory_search', 'memory_get', 'context_retrieve', 'project_knowledge_search']) assert.equal(ann[n].readOnlyHint, true, n);
    assert.deepEqual([ann.memory_store.readOnlyHint, ann.memory_store.destructiveHint], [false, false]);
    for (const n of ['memory_update', 'memory_delete']) assert.deepEqual([ann[n].destructiveHint, ann[n].idempotentHint], [true, true], n);
    assert.equal((await s.rpc(4, 'server/discover')).error.code, -32601);
    assert.equal((await s.rpc(5, 'resources/list')).error.code, -32601);
    s.send('[{"jsonrpc":"2.0","id":6,"method":"ping"}]');
    r = await s.next();
    assert.deepEqual([r.id, r.error.code], [null, -32600]);
    s.send('{not json');
    r = await s.next();
    assert.deepEqual([r.id, r.error.code], [null, -32700]);
    assert.equal((await s.rpc(7, 'tools/call', { name: 'nope', arguments: {} })).error.code, -32602);
    const done = await s.close();
    assert.equal(done.code, 0);
    for (const l of done.lines) JSON.parse(l);
  } finally { sb.cleanup(); }
});

test('mcp: every tool works, before initialize too; isError paths; private redaction; arguments cannot change the project; output cap', async () => {
  const sb = sandbox();
  try {
    const repo = gitRepo(sb, 'shop', 'git@github.com:org/shop.git');
    fs.writeFileSync(path.join(repo, 'README.md'), '# Shop\n\nThe checkout page lives in web/checkout.\n');
    fresh(sb);
    const other = new MemoryService(openDb(P.DB), load());
    const foreign = (await other.store({ category: 'project', title: 'Other repo', body: 'pnpm elsewhere' }, { projectId: 'p_other', sessionId: null, linked: [] })).memory;
    other.close();
    const s = session(sb.env(), repo);
    let r = await s.call('memory_store', { category: 'project', title: 'Use pnpm', body: 'pnpm only; npm breaks the lockfile', tags: ['tooling'] });
    const m = r.result.structuredContent.memory;
    assert.equal(r.result.isError, undefined);
    assert.deepEqual(JSON.parse(r.result.content[0].text), r.result.structuredContent);
    assert.equal((await s.call('memory_search', { query: 'lockfile' })).result.structuredContent.hits[0].id, m.id);
    assert.match((await s.call('memory_get', { id: m.id })).result.structuredContent.memory.body, /lockfile/);
    assert.equal((await s.call('memory_update', { id: m.id, expectedVersion: 1, body: 'pnpm only.' })).result.structuredContent.memory.version, 2);
    r = await s.call('memory_update', { id: m.id, expectedVersion: 1, body: 'x' });
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /current version is 2/);
    assert.match((await s.call('context_retrieve', { task: 'pnpm lockfile install' })).result.structuredContent.text, /Use pnpm/);
    assert.match(JSON.stringify((await s.call('project_knowledge_search', { query: 'checkout page' })).result.structuredContent.hits), /README\.md/);
    assert.equal((await s.call('memory_delete', { id: m.id })).result.structuredContent.status, 'archived');
    assert.equal((await s.call('memory_delete', { id: m.id })).result.structuredContent.status, 'archived', 'idempotent');
    r = await s.call('memory_store', { category: 'project', title: '', body: 'SECRET-VALUE' });
    assert.equal(r.result.isError, true);
    assert.doesNotMatch(r.result.content[0].text, /SECRET-VALUE/);
    assert.equal((await s.call('memory_get', { id: foreign.id })).result.isError, true, 'another project\'s id is not found');
    r = await s.call('memory_search', { query: 'pnpm', projectId: 'p_other' });
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /unknown field/);
    r = await s.call('memory_store', { category: 'project', title: 'Secret', body: 'PRIVATE-BODY token', private: true });
    const p = r.result.structuredContent.memory;
    assert.equal(p.body, '[private]');
    assert.equal((await s.call('memory_get', { id: p.id })).result.structuredContent.memory.body, '[private]');
    assert.equal((await s.call('memory_search', { query: 'token' })).result.structuredContent.hits.length, 0);
    assert.doesNotMatch((await s.call('context_retrieve', { task: 'private body token' })).result.structuredContent.text, /PRIVATE-BODY/);
    await s.close();
    const small = session(sb.env({ MCP_MAX_CHARS: '400' }), repo);
    for (let i = 0; i < 5; i++) await small.call('memory_store', { category: 'project', title: `cap ${i}`, body: `capped result number ${i} ${'x'.repeat(80)}` });
    r = await small.call('memory_search', { query: 'capped result' });
    assert.equal(r.result.structuredContent.truncated, true);
    assert.ok(r.result.content[0].text.length <= 400);
    await small.close();
  } finally { sb.cleanup(); }
});

test('wire: registers the MCP server with Claude and every Codex home; unwire removes it; doctor checks it', async () => {
  const sb = sandbox();
  try {
    const orcaHome = path.join(sb.home, 'Library/Application Support/orca/codex-runtime-home/home');
    fs.mkdirSync(orcaHome, { recursive: true });
    fresh(sb);
    const cfg = load();
    wire.wireClaude(cfg);
    wire.wireCodex(cfg);
    const add = sb.calls().find((c) => c.bin === 'claude' && c.argv[1] === 'add');
    assert.deepEqual(add!.argv, ['mcp', 'add', '--scope', 'user', 'bosun', '--', process.execPath, BIN, 'mcp']);
    const cx = sb.calls().filter((c) => c.bin === 'codex' && c.argv[1] === 'add');
    assert.deepEqual(cx.map((c) => c.env.CODEX_HOME), [path.join(sb.home, '.codex'), orcaHome]);
    assert.deepEqual(cx[0].argv, ['mcp', 'add', 'bosun', '--', process.execPath, BIN, 'mcp']);
    sb.reset();
    wire.unwire();
    const rm = sb.calls().map((c) => `${c.bin} ${c.argv.join(' ')}`);
    assert.ok(rm.includes('claude mcp remove --scope user bosun'));
    assert.equal(rm.filter((c) => c === 'codex mcp remove bosun').length, 2);
    assert.match((await bosun(['doctor'], { env: sb.env({ OLLAMA_URL: 'http://127.0.0.1:1', ROUTER_PORT: '1' }) })).out, /bosun MCP server in Claude Code/);
    const missing = await bosun(['doctor'], { env: sb.env({ OLLAMA_URL: 'http://127.0.0.1:1', ROUTER_PORT: '1', STUB_MAP: JSON.stringify({ 'claude mcp': { code: 1 }, 'codex mcp': { code: 1 } }) }) });
    assert.match(missing.out, /MCP server missing in Claude Code: bosun install/);
    assert.match(missing.out, /memory .*memory\.db \(schema v1\)/);
  } finally { sb.cleanup(); }
});

test('mcp: memory_update cannot make a private memory public (the reply would carry its body)', async () => {
  const sb = sandbox();
  try {
    const repo = gitRepo(sb, 'shop', 'git@github.com:org/shop.git');
    const s = session(sb.env(), repo);
    try {
    const p = (await s.call('memory_store', { category: 'project', title: 'Bank', body: 'my PIN hint is PRIVATE-XYZ', private: true })).result.structuredContent.memory;
    const r = await s.call('memory_update', { id: p.id, expectedVersion: 1, private: false });
    assert.equal(r.result.isError, true);
    assert.doesNotMatch(JSON.stringify(r), /PRIVATE-XYZ/);
    assert.equal((await s.call('memory_get', { id: p.id })).result.structuredContent.memory.body, '[private]');
    const t = await s.call('memory_update', { id: p.id, expectedVersion: 1, title: 'Bank hint' });
    assert.equal(t.result.structuredContent.memory.body, '[private]');
    } finally { await s.close(); }
  } finally { sb.cleanup(); }
});
