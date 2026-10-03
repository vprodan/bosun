import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, fresh, bosun, mock, gitRepo, claudeMemDb } from './helpers.ts';
import { load, P } from '../lib/config.ts';
import { generate } from '../lib/llm.ts';
import { consolidate } from '../lib/consolidate.ts';
import { ClaudeMem } from '../lib/memory/claudemem.ts';
import { MemoryService } from '../lib/memory/service.ts';
import { openDb } from '../lib/memory/sqlite.ts';
import type { Schema } from '../lib/util.ts';

const SCHEMA: Schema = { type: 'object', required: ['title'], properties: { title: { type: 'string', maxLength: 20 } } };
const msg = [{ role: 'user' as const, content: 'SECRET-PROMPT summarize' }];
const chat = (content: string) => () => ({ json: { message: { content }, prompt_eval_count: 12, eval_count: 5 } });

test('llm: Ollama success sends the schema and context size and reads token counts', async () => {
  const sb = sandbox();
  const m = await mock({ '/api/chat': chat('{"title":"ok"}') });
  try {
    fresh(sb);
    const r = await generate({ ...load(), OLLAMA_URL: m.url }, { task: 't', messages: msg, schema: SCHEMA });
    assert.deepEqual([r.ok, r.provider, r.model, r.json, r.tokensIn, r.tokensOut], [true, 'ollama', load().LOCAL_MODEL, { title: 'ok' }, 12, 5]);
    const req = m.requests.find((q) => q.path === '/api/chat')!;
    assert.deepEqual([req.body.stream, req.body.format, req.body.options.num_ctx], [false, SCHEMA, 65536]);
  } finally { await m.close(); sb.cleanup(); }
});

test('llm: timeout, retry then success, bad JSON and schema violations fail without retrying', async () => {
  const sb = sandbox();
  let calls = 0;
  const m = await mock({
    '/slow/api/chat': () => ({ delayMs: 3000, json: {} }),
    '/api/chat': (b) => (b.messages[0].content === 'flaky' && calls++ === 0 ? { destroy: true } : { json: { message: { content: b.messages[0].content === 'bad' ? 'not json' : b.messages[0].content === 'wrong' ? '{"title": 5}' : '{"title":"ok"}' } } }),
  });
  try {
    fresh(sb);
    const cfg = { ...load(), OLLAMA_URL: m.url, LLM_TIMEOUT_S: '0.3' };
    const t = Date.now();
    const slow = await generate({ ...cfg, OLLAMA_URL: `${m.url}/slow`, LLM_RETRIES: '0' }, { task: 't', messages: msg });
    assert.deepEqual([slow.ok, slow.error], [false, 'timeout']);
    assert.ok(Date.now() - t < 2500);
    const flaky = await generate(cfg, { task: 't', messages: [{ role: 'user', content: 'flaky' }], schema: SCHEMA });
    assert.equal(flaky.ok, true, 'a dropped connection is retried');
    assert.equal(calls, 2);
    const n = m.requests.length;
    assert.equal((await generate(cfg, { task: 't', messages: [{ role: 'user', content: 'bad' }], schema: SCHEMA })).error, 'bad_json');
    assert.equal((await generate(cfg, { task: 't', messages: [{ role: 'user', content: 'wrong' }], schema: SCHEMA })).error, 'invalid');
    assert.equal(m.requests.length - n, 2, 'invalid output is not retried');
  } finally { await m.close(); sb.cleanup(); }
});

test('llm: fallback chain; the remote provider only when opted in, allowed, and not private; the usage log has no content', async () => {
  const sb = sandbox();
  const m = await mock({ '/v1/chat/completions': () => ({ json: { choices: [{ message: { content: '{"title":"oa"}' } }], usage: { prompt_tokens: 3, completion_tokens: 2 } } }) });
  try {
    fresh(sb, { STUB_MAP: JSON.stringify({ claude: { out: { result: '{"title":"cc"}', usage: { input_tokens: 1, output_tokens: 1 } } } }) });
    const down = { ...load(), OLLAMA_URL: 'http://127.0.0.1:1', LLM_RETRIES: '0' };
    const oa = await generate({ ...down, LLM_PROVIDERS: 'ollama,openai', LLM_OPENAI_URL: m.url }, { task: 't', messages: msg, schema: SCHEMA });
    assert.deepEqual([oa.ok, oa.provider, oa.json.title, oa.tokensIn], [true, 'openai', 'oa', 3]);
    assert.equal(m.requests.find((q) => q.path === '/v1/chat/completions')!.body.response_format.type, 'json_schema');
    const claudeCalls = () => sb.calls().filter((c) => c.bin === 'claude');
    assert.equal((await generate(down, { task: 't', messages: msg, allowRemote: true })).ok, false);
    assert.equal(claudeCalls().length, 0, 'remote is off by default');
    const remote = { ...down, LLM_REMOTE: 'claude' };
    assert.equal((await generate(remote, { task: 't', messages: msg })).ok, false);
    assert.equal(claudeCalls().length, 0, 'the caller must allow remote');
    assert.equal((await generate(remote, { task: 't', messages: msg, allowRemote: true, private: true })).ok, false);
    assert.equal(claudeCalls().length, 0, 'never for private content');
    const cc = await generate(remote, { task: 't', messages: msg, allowRemote: true, schema: SCHEMA });
    assert.deepEqual([cc.ok, cc.provider, cc.model, cc.json.title], [true, 'claude-cli', 'haiku', 'cc']);
    const call = claudeCalls()[0];
    assert.ok(call.argv.includes('--restricted') && call.argv.includes('--strict-mcp-config'));
    assert.equal(call.env.BOSUN_DEPTH, '1');
    const usage = fs.readFileSync(path.join(P.BOSUN, 'llm-usage.jsonl'), 'utf8');
    assert.doesNotMatch(usage, /SECRET-PROMPT/);
    for (const row of usage.trim().split('\n').map((l) => JSON.parse(l))) {
      assert.deepEqual(Object.keys(row).sort(), ['error_kind', 'model', 'ms', 'ok', 'provider', 'task', 'tokensIn', 'tokensOut', 'ts']);
    }
  } finally { await m.close(); sb.cleanup(); }
});

test('consolidate: proposals with provenance; exact and near duplicates are skipped; invalid output writes nothing; review accepts', async () => {
  const sb = sandbox();
  const reply = { current: '' };
  const m = await mock({ '/api/chat': () => ({ json: { message: { content: reply.current } } }) });
  try {
    fresh(sb);
    const cfg = { ...load(), OLLAMA_URL: m.url };
    const file = path.join(sb.root, 'cm.db');
    claudeMemDb(file, { sums: [{ project: 'shop', request: 'fix checkout', learned: 'checkout needs the cart token' }, { project: 'shop', request: 'deploy', learned: 'deploys run through ArgoCD' }] });
    const svc = new MemoryService(openDb(P.DB), cfg);
    const ctx = { projectId: 'p_shop', sessionId: null, linked: [] };
    await svc.store({ category: 'project', title: 'Deploys', body: 'Deploys run through ArgoCD from main.' }, ctx);
    const cm = new ClaudeMem({ ...cfg, CLAUDE_MEM_DB: file }, ['shop']);
    reply.current = JSON.stringify({ candidates: [
      { summary_id: '1', category: 'project', title: 'Checkout token', body: 'Checkout needs the cart token.', tags: ['Checkout', 'cart token'] },
      { summary_id: '2', category: 'project', title: 'Deploys', body: 'Deploys run through ArgoCD from main!', tags: [] }] });
    const r = await consolidate(cfg, svc, ctx, cm, { since: 0, limit: 20 });
    assert.equal(r.error, undefined);
    assert.equal(r.summaries, 2);
    assert.deepEqual(r.proposed.map((p) => [p.title, p.status, p.sourceRef, p.tags]), [['Checkout token', 'proposed', 'claude-mem:summary:1', ['checkout', 'cart-token']]]);
    assert.match(r.proposed[0].source, /^consolidate:ollama\//);
    assert.match(r.skipped[0].why, /near-duplicate of m_/);
    reply.current = '{"candidates": "nope"}';
    const before = svc.counts();
    const bad = await consolidate(cfg, svc, ctx, cm, { since: 0, limit: 20 });
    assert.match(bad.error!, /nothing written/);
    assert.deepEqual(svc.counts(), before);
    assert.equal((await svc.accept(r.proposed[0].id, ctx)).status, 'active');
    svc.close();
  } finally { await m.close(); sb.cleanup(); }
});

test('memory cli: consolidate end to end, and add --auto takes the LLM title and tags unless given', async () => {
  const sb = sandbox();
  const m = await mock({ '/api/chat': (b) => ({ json: { message: { content: b.messages[0].content.startsWith('Suggest')
    ? '{"title":"Auto title","tags":["Auto Tag"]}'
    : JSON.stringify({ candidates: [{ summary_id: '1', category: 'project', title: 'Token rule', body: 'Checkout needs the cart token.', tags: [] }] }) } } }) });
  try {
    const repo = gitRepo(sb, 'shop', 'git@github.com:org/shop.git');
    const file = path.join(sb.root, 'cm.db');
    claudeMemDb(file, { sums: [{ project: 'shop', request: 'fix checkout', learned: 'checkout needs the cart token' }] });
    const env = sb.env({ OLLAMA_URL: m.url, CLAUDE_MEM_DB: file });
    let r = await bosun(['memory', 'consolidate'], { env, cwd: repo });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /1 session summaries → 1 proposals/);
    assert.match(r.out, /bosun memory review/);
    r = await bosun(['memory', 'add', '--auto', 'the payment webhook retries 3 times with backoff'], { env, cwd: repo });
    const id = r.out.match(/m_\w+/)![0];
    assert.match((await bosun(['memory', 'get', id], { env, cwd: repo })).out, /^Auto title\n[\s\S]*tags: auto-tag/);
    r = await bosun(['memory', 'add', '--auto', '-t', 'Mine', 'another note about webhooks'], { env, cwd: repo });
    assert.match((await bosun(['memory', 'get', r.out.match(/m_\w+/)![0]], { env, cwd: repo })).out, /^Mine\n/);
  } finally { await m.close(); sb.cleanup(); }
});
