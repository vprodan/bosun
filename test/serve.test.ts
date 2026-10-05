import "./bootstrap.ts";
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { sandbox, fresh, bosun, mock, gitRepo, mcpSession, BIN } from './helpers.ts';
import { load, parse } from '../lib/config.ts';
import { RemoteStore } from '../lib/memory/remote.ts';
import { MemoryService } from '../lib/memory/service.ts';
import { openDb } from '../lib/memory/sqlite.ts';
import { MemoryError, type Ctx, type MemoryApi } from '../lib/memory/types.ts';
import { DEFAULT_ALLOW, allowed, bindAddress, kevServer, listen, memoryServer } from '../lib/serve.ts';

const A: Ctx = { projectId: 'p_a', sessionId: 's1', linked: [] };
// Servers close in finally, so a failing assertion can't leave the test process hanging on an open socket.
const cleanups: (() => void)[] = [];
const cleanup = () => { for (const f of cleanups.splice(0)) f(); };
const B: Ctx = { projectId: 'p_b', sessionId: null, linked: [] };

// The same script against any MemoryApi; ids and timestamps are left out so two stores compare equal.
async function script(api: MemoryApi) {
  const out: unknown[] = [];
  const err = async (p: Promise<unknown>) => { try { await p; return 'no error'; } catch (e) { return e instanceof MemoryError ? e.code : String(e); } };
  const a = await api.store({ category: 'project', title: 'Use pnpm', body: 'pnpm only; npm breaks the lockfile', tags: ['tooling'] }, A);
  out.push(['store', a.duplicate, a.memory.version, a.memory.status]);
  out.push(['dup', (await api.store({ category: 'project', title: 'Use pnpm', body: 'pnpm only; npm breaks the lockfile' }, A)).duplicate]);
  out.push(['search', (await api.search({ text: 'lockfile' }, A)).map((h) => h.title)]);
  out.push(['get', (await api.get(a.memory.id, A, { events: true })).events!.map((e) => e.op)]);
  out.push(['update', (await api.update(a.memory.id, { body: 'pnpm only.' }, 1, A)).version]);
  out.push(['conflict', await err(api.update(a.memory.id, { body: 'x' }, 1, A))]);
  out.push(['scope', await err(api.get(a.memory.id, B))]);
  out.push(['invalid', await err(api.store({ category: 'nope' } as never, A))]);
  const p = (await api.store({ category: 'project', title: 'Proposal', body: 'a proposal', status: 'proposed' }, A)).memory;
  out.push(['accept', (await api.accept(p.id, A)).status]);
  const q = (await api.store({ category: 'project', title: 'Other', body: 'another proposal', status: 'proposed' }, A)).memory;
  out.push(['reject', (await api.reject(q.id, A)).status]);
  out.push(['delete', (await api.delete(a.memory.id, A)).status]);
  return out;
}

test('split: bosun serve memory + RemoteStore give the same results as the local store, operation by operation', async () => {
  const sb = sandbox();
  try {
    fresh(sb);
    const cfg = load();
    const server = new MemoryService(openDb(path.join(sb.root, 'server.db')), cfg);
    const srv = memoryServer(cfg, server, ['127.0.0.1/32']);
    const local = new MemoryService(openDb(path.join(sb.root, 'local.db')), cfg);
    cleanups.push(() => { srv.closeAllConnections(); srv.close(); server.close(); local.close(); });
    const port = await listen(srv, 0, '127.0.0.1');
    const remote = new RemoteStore({ ...cfg, MEMORY_URL: `http://127.0.0.1:${port}` });
    assert.deepEqual(await script(remote), await script(local));
    const h = await remote.health();
    assert.equal(h.memory, true);
    const ctxRes = await fetch(`http://127.0.0.1:${port}/v1/context/retrieve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ctx: A, task: 'another proposal' }) });
    assert.equal((await ctxRes.json()).ok, true);
    const big = await fetch(`http://127.0.0.1:${port}/v1/memory/search`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ctx: A, query: { text: 'x'.repeat(70000) } }) });
    assert.equal(big.status, 413);
    const form = await fetch(`http://127.0.0.1:${port}/v1/memory/search`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' });
    assert.equal(form.status, 415);
  } finally { cleanup(); sb.cleanup(); }
});

test('split: the allowlist rejects other sources (403); bind never defaults to 0.0.0.0; CIDR matching', async () => {
  const sb = sandbox();
  try {
    fresh(sb);
    const cfg = load();
    const svc = new MemoryService(openDb(path.join(sb.root, 's.db')), cfg);
    const srv = memoryServer(cfg, svc, ['10.0.0.0/8']);
    cleanups.push(() => { srv.closeAllConnections(); srv.close(); svc.close(); });
    const port = await listen(srv, 0, '127.0.0.1');
    const r = await fetch(`http://127.0.0.1:${port}/v1/health`);
    assert.equal(r.status, 403);
    assert.deepEqual((await r.json()).ok, false);
    assert.ok(allowed('100.101.102.103', DEFAULT_ALLOW));
    assert.ok(allowed('::ffff:127.0.0.1', DEFAULT_ALLOW));
    assert.ok(allowed('::1', DEFAULT_ALLOW));
    assert.ok(!allowed('8.8.8.8', DEFAULT_ALLOW));
    assert.ok(!allowed('fe80::1', DEFAULT_ALLOW));
    assert.ok(!allowed(undefined, DEFAULT_ALLOW));
    assert.ok(allowed('192.168.1.77', ['192.168.1.5/24']) && !allowed('192.168.2.77', ['192.168.1.5/24']));
    assert.throws(() => bindAddress({ ...cfg, SERVE_BIND: '' }), /never binds 0\.0\.0\.0/);
    fresh(sb, { STUB_MAP: JSON.stringify({ 'tailscale ip': { out: '100.101.102.103\n' } }) });
    fs.writeFileSync(path.join(sb.bin, 'tailscale'), fs.readFileSync(path.join(sb.bin, 'claude')), { mode: 0o755 });
    assert.equal(bindAddress({ ...cfg, SERVE_BIND: '' }), '100.101.102.103');
    assert.equal(bindAddress({ ...cfg, SERVE_BIND: '0.0.0.0' }), '0.0.0.0', 'only when you set it');
    // Model unavailable Tailscale through its default stub; PATH never falls back to a real installation.
    const cli = await bosun(['serve', 'memory'], { env: sb.env({ STUB_MAP: JSON.stringify({ 'tailscale ip': { code: 1 } }) }) });
    assert.equal(cli.code, 1);
    assert.match(cli.err, /set SERVE_BIND/);
  } finally { cleanup(); sb.cleanup(); }
});

test('split: an unreachable, hanging or foreign memory server — the hook fails open in time, CLI and MCP say unavailable', async () => {
  const sb = sandbox();
  const kev = await mock();
  const html = await mock({ '/v1/memory/search': () => ({ status: 502, text: '<html>bad gateway</html>' }), '/v1/memory/store': () => ({ status: 502, text: '<html>bad gateway</html>' }) });
  const hang = http.createServer(() => { /* never answers */ });
  try {
    const hangPort = await listen(hang, 0, '127.0.0.1');
    const repo = gitRepo(sb, 'shop', 'git@github.com:org/shop.git');
    const hook = (url: string) => bosun(['route', '--hook'], { env: sb.env({ ROUTER_URL: kev.url, MEMORY_URL: url }), cwd: repo, input: JSON.stringify({ prompt: 'rename getCart to fetchCart in cart-service' }) });
    for (const url of ['http://127.0.0.1:1', `http://127.0.0.1:${hangPort}`, html.url]) {
      const t = Date.now();
      const r = await hook(url);
      assert.equal(r.code, 0);
      const c = JSON.parse(r.out).hookSpecificOutput.additionalContext;
      assert.doesNotMatch(c, /bosun memory/);
      assert.match(c, /suggests: local/, url);
      assert.ok(Date.now() - t < 2500, `${url}: ${Date.now() - t} ms`);
    }
    for (const url of ['http://127.0.0.1:1', html.url]) {
      const r = await bosun(['memory', 'search', 'x'], { env: sb.env({ MEMORY_URL: url }), cwd: repo });
      assert.equal(r.code, 1);
      assert.match(r.err, /memory server (unreachable at|at .* sent no bosun reply)/);
    }
    const s = mcpSession(sb.env({ MEMORY_URL: html.url }), repo);
    try {
      const res = await s.call('memory_store', { category: 'project', title: 't', body: 'b' });
      assert.equal(res.result.isError, true);
      assert.equal(res.result.content[0].text, 'memory unavailable');
      assert.deepEqual(res.result.structuredContent, { error: { code: 'unavailable' } });
    } finally { await s.close(); }
  } finally { hang.closeAllConnections(); hang.close(); await kev.close(); await html.close(); sb.cleanup(); }
});

test('split: doctor checks the memory server and warns on a version mismatch; the remote model is checked via /api/tags', async () => {
  const sb = sandbox();
  const m = await mock({ '/v1/health': () => ({ json: { ok: true, data: { version: '0.0.1', schema: 1, memory: true } } }) });
  try {
    const r = await bosun(['doctor'], { env: sb.env({ MEMORY_URL: m.url, OLLAMA_URL: m.url, ROUTER_URL: 'http://127.0.0.1:1' }) });
    assert.match(r.out, /memory server http:\/\/127\.0\.0\.1:\d+ \(bosun 0\.0\.1, schema v1\)/);
    assert.match(r.out, /memory server runs bosun 0\.0\.1, this is 0\.2\.0/);
    assert.match(r.out, /model \S+ missing on http:\/\/127\.0\.0\.1:\d+/);
    assert.match(r.out, /kev down/);
  } finally { await m.close(); sb.cleanup(); }
});

test('split: bosun serve kev forwards to Kev and applies the allowlist', async () => {
  const sb = sandbox();
  const kev = await mock();
  try {
    fresh(sb);
    const cfg = { ...load(), ROUTER_PORT: new URL(kev.url).port };
    const px = kevServer(cfg, ['127.0.0.1/32']);
    const deny = kevServer(cfg, ['10.0.0.0/8']);
    cleanups.push(() => { px.closeAllConnections(); px.close(); deny.closeAllConnections(); deny.close(); });
    const port = await listen(px, 0, '127.0.0.1');
    const body = JSON.stringify({ state: { request: 'rename a to b' } });
    const r = await fetch(`http://127.0.0.1:${port}/v1/systemone`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.equal((await r.json()).answers.lane.choice, 'local');
    assert.equal(kev.requests.length, 1);
    const dport = await listen(deny, 0, '127.0.0.1');
    assert.equal((await fetch(`http://127.0.0.1:${dport}/v1/systemone`, { method: 'POST', body })).status, 403);
    assert.equal(kev.requests.length, 1, 'nothing reached Kev');
  } finally { cleanup(); await kev.close(); sb.cleanup(); }
});

test('install --remote writes the URLs, skips local Ollama and Kev, registers MCP; uninstall restores the config; bad options change nothing', async () => {
  const sb = sandbox({ stubs: ['claude', 'codex', 'brew', 'launchctl', 'ollama'] });
  try {
    const env = sb.env({ BOSUN_OLLAMA_APP: path.join(sb.root, 'no-app') });
    for (const bad of [['--serve', 'bogus'], ['--remote', 'kev=ftp://x'], ['--remote', 'nope=http://x'], ['--serve', 'kev', '--remote', 'llm=http://x']]) {
      const r = await bosun(['install', ...bad], { env });
      assert.equal(r.code, 2, bad.join(' '));
    }
    assert.ok(!fs.existsSync(path.join(sb.home, '.claude')), 'nothing touched');
    const url = 'http://127.0.0.1:1';
    const r = await bosun(['install', '--host', 'claude', '--remote', `kev=${url},llm=${url},memory=${url}`], { env });
    assert.equal(r.code, 0, r.err);
    const cfg = parse(path.join(sb.home, '.bosun', 'config.env'));
    assert.deepEqual([cfg.ROUTER_URL, cfg.OLLAMA_URL, cfg.MEMORY_URL], [url, url, url]);
    const calls = sb.calls();
    assert.ok(!calls.some((c) => c.bin === 'ollama' && c.argv[0] === 'pull'), 'no model pull for a remote llm');
    assert.ok(!calls.some((c) => c.bin === 'launchctl' && c.argv[0] === 'bootstrap'), 'no local services');
    assert.ok(calls.some((c) => c.bin === 'claude' && c.argv.slice(0, 2).join(' ') === 'mcp add'));
    assert.equal((await bosun(['uninstall'], { env })).code, 0);
    const after = parse(path.join(sb.home, '.bosun', 'config.env'));
    assert.deepEqual([after.ROUTER_URL, after.OLLAMA_URL, after.MEMORY_URL], ['', 'http://127.0.0.1:11434', '']);
  } finally { sb.cleanup(); }
});

test('install --serve sets up only the listed services on the bind address; uninstall removes them', async () => {
  const sb = sandbox({ stubs: ['brew', 'launchctl', 'ollama', 'uv', 'git', 'curl'] });
  try {
    fs.mkdirSync(path.join(sb.home, '.local', 'share', 'bosun', 'kev', '.git'), { recursive: true });
    const env = sb.env({ SERVE_BIND: '127.0.0.1', BOSUN_OLLAMA_APP: path.join(sb.root, 'no-app'), STUB_MAP: JSON.stringify({ 'ollama --version': { out: 'ollama version is 0.34.4' } }) });
    const r = await bosun(['install', '--serve', 'kev,llm,memory'], { env });
    assert.equal(r.code, 0, r.err);
    const cfg = parse(path.join(sb.home, '.bosun', 'config.env'));
    assert.deepEqual([cfg.SERVE_BIND, cfg.OLLAMA_URL], ['127.0.0.1', 'http://127.0.0.1:11434']);
    const la = path.join(sb.home, 'Library', 'LaunchAgents');
    for (const n of ['memory', 'kev-proxy', 'router', 'ollama']) assert.ok(fs.existsSync(path.join(la, `com.bosun.${n}.plist`)), n);
    assert.match(fs.readFileSync(path.join(la, 'com.bosun.memory.plist'), 'utf8'), new RegExp(`<string>${BIN}</string><string>serve</string><string>memory</string>`));
    assert.ok(!fs.existsSync(path.join(sb.home, '.claude')), 'a server install wires no hosts');
    assert.match(r.out, /bosun install --remote kev=http:\/\/127\.0\.0\.1:8009,llm=http:\/\/127\.0\.0\.1:11434,memory=http:\/\/127\.0\.0\.1:8788/);
    assert.equal((await bosun(['uninstall'], { env })).code, 0);
    for (const n of ['memory', 'kev-proxy']) assert.ok(!fs.existsSync(path.join(la, `com.bosun.${n}.plist`)), n);
  } finally { sb.cleanup(); }
});

test('install: re-running a plain install on a split-setup client keeps the remote URLs and sets up no local Ollama or Kev', async () => {
  const sb = sandbox({ stubs: ['claude', 'brew', 'launchctl', 'ollama', 'uv', 'git', 'curl'] });
  try {
    const env = sb.env({ BOSUN_OLLAMA_APP: path.join(sb.root, 'no-app'), REMOTE_TIMEOUT_MS: '300', STUB_MAP: JSON.stringify({ 'ollama --version': { out: 'ollama version is 0.34.4' } }) });
    const far = 'http://100.1.2.3';
    const first = await bosun(['install', '--host', 'claude', '--remote', `kev=${far}:8009,llm=${far}:11434,memory=${far}:8788`], { env });
    assert.equal(first.code, 0, first.err);
    sb.reset();
    const again = await bosun(['install', '--host', 'claude'], { env });
    assert.equal(again.code, 0, again.err);
    const calls = sb.calls().map((c) => `${c.bin} ${c.argv.join(' ')}`);
    assert.ok(!calls.some((c) => c.startsWith('ollama pull')), 'no 22 GB pull for a remote llm');
    assert.ok(!calls.some((c) => c.startsWith('uv ') || c.startsWith('git clone')), 'no local Kev');
    assert.ok(!calls.some((c) => c.startsWith('launchctl setenv OLLAMA_HOST') || c.startsWith('launchctl bootstrap')), 'no local services');
    const cfg = parse(path.join(sb.home, '.bosun', 'config.env'));
    assert.deepEqual([cfg.ROUTER_URL, cfg.OLLAMA_URL, cfg.MEMORY_URL], [`${far}:8009`, `${far}:11434`, `${far}:8788`]);
  } finally { sb.cleanup(); }
});

test('split: a memory or Kev host that never replies — the hook still exits within its budget', async () => {
  const sb = sandbox();
  const hang = http.createServer(() => { /* synthetic endpoint never replies */ });
  const port = await listen(hang, 0, '127.0.0.1');
  try {
    const repo = gitRepo(sb, 'shop', 'git@github.com:org/shop.git');
    const t = Date.now();
    const r = await bosun(['route', '--hook'], { env: sb.env({ ROUTER_URL: `http://127.0.0.1:${port}`, MEMORY_URL: `http://127.0.0.1:${port}`, ROUTER_TIMEOUT: '0.3' }), cwd: repo, input: JSON.stringify({ prompt: 'rename getCart to fetchCart in cart-service' }) });
    assert.deepEqual([r.code, r.out], [0, '']);
    assert.ok(Date.now() - t < 3000, `exited after ${Date.now() - t} ms (Claude's hook timeout is 5 s)`);
  } finally { hang.closeAllConnections(); await new Promise<void>((resolve) => hang.close(() => resolve())); sb.cleanup(); }
});
