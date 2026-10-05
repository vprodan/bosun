import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, fresh, bosun, mock, gitRepo, type Sandbox } from './helpers.ts';
import { load } from '../lib/config.ts';
import { generate, suggest } from '../lib/llm.ts';
import { log } from '../lib/log.ts';
import { record, report } from '../lib/metrics.ts';

const BODY = 'private-body-canary-9d271b';
const TITLE = 'private-title-canary-8f614c';
const TAG = 'private-tag-canary-561cea';
const ECHO = 'provider-echo-canary-214b95';
const logs = ['route-log.jsonl', 'route-labels.jsonl', 'llm-usage.jsonl', 'bosun.log', 'metrics.jsonl'];
function noContent(sb: Sandbox, canaries = [BODY, TITLE, TAG, ECHO]): void {
  for (const name of logs) {
    const file = path.join(sb.home, '.bosun', name);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const canary of canaries) assert.equal(text.includes(canary), false, `${name} leaked ${canary}`);
  }
}
const modelReply = () => ({ json: { message: { content: '{"title":"Public suggestion","tags":["public tag"]}' },
  choices: [{ message: { content: '{"title":"Public suggestion","tags":["public tag"]}' } }] } });

test('privacy: direct private generate blocks every provider before config/messages/schema access', async () => {
  const sb = sandbox();
  const server = await mock({ '/api/chat': modelReply, '/v1/chat/completions': modelReply });
  try {
    fresh(sb, { STUB_MAP: JSON.stringify({ claude: { out: { result: JSON.stringify({ title: ECHO }) } } }) });
    const cfg = { ...load(), OLLAMA_URL: server.url, LLM_OPENAI_URL: server.url, LLM_PROVIDERS: 'ollama,openai,claude-cli', LLM_REMOTE: 'claude', LLM_RETRIES: '3' };
    for (const privateFlag of [true, 'true', 'unknown', null, 0, {}]) {
      const result = await generate(cfg, { private: privateFlag, task: TITLE, allowRemote: true, messages: [{ role: 'user', content: BODY }], schema: { type: 'object' } } as any);
      assert.deepEqual(result, { ok: false, text: '', provider: 'none', model: '', ms: 0, error: 'private' });
    }
    const denied = () => { throw new Error('private payload/config was inspected'); };
    assert.equal((await generate(new Proxy(cfg, { get: denied }), { private: true, task: TITLE, get messages() { return denied(); }, get schema() { return denied(); } })).error, 'private');
    assert.equal(server.requests.length, 0);
    assert.equal(sb.calls().length, 0);
    assert.equal(fs.existsSync(path.join(sb.home, '.bosun', 'llm-usage.jsonl')), false);
    noContent(sb);
  } finally { await server.close(); sb.cleanup(); }
});

test('privacy: private suggestions use only the first line and no model tags', async () => {
  const sb = sandbox();
  const server = await mock({ '/api/chat': modelReply, '/v1/chat/completions': modelReply });
  try {
    fresh(sb);
    const cfg = { ...load(), OLLAMA_URL: server.url, LLM_OPENAI_URL: server.url, LLM_PROVIDERS: 'ollama,openai', LLM_REMOTE: 'claude', LLM_RETRIES: '3' };
    assert.deepEqual(await suggest(cfg, `  ${TITLE}\n${BODY} ${TAG}`, true), { title: TITLE, tags: [] });
    assert.deepEqual(await suggest(cfg, TITLE, null as any), { title: TITLE, tags: [] });
    assert.equal(server.requests.length, 0);
    assert.equal(sb.calls().length, 0);
    noContent(sb);
  } finally { await server.close(); sb.cleanup(); }
});

test('privacy: memory --private --auto stores deterministic and explicit fields with zero provider calls', async () => {
  const sb = sandbox();
  const server = await mock({ '/api/chat': modelReply, '/v1/chat/completions': modelReply });
  try {
    const repo = gitRepo(sb, 'private-notes');
    const env = sb.env({ OLLAMA_URL: server.url, LLM_OPENAI_URL: server.url, LLM_PROVIDERS: 'ollama,openai', LLM_REMOTE: 'claude', LLM_RETRIES: '3' });
    for (const explicit of [false, true]) {
      const body = `${TITLE}\n${BODY} ${explicit ? 'explicit' : 'default'}`;
      const add = await bosun(['memory', 'add', '--private', '--auto', ...(explicit ? ['-t', TITLE + '-override', '--tags', TAG] : []), body], { env, cwd: repo });
      assert.equal(add.code, 0, add.err);
      assert.equal(add.err, '');
      assert.doesNotMatch(add.out, /canary/);
      const id = add.out.match(/m_[0-9a-v]{9}[0-9a-f]{8}/)![0];
      const get = await bosun(['memory', 'get', id, '--json'], { env, cwd: repo });
      assert.equal(get.code, 0, get.err);
      const memory = JSON.parse(get.out);
      assert.equal(memory.id, id);
      assert.equal(memory.private, true);
      assert.equal(memory.category, 'project');
      assert.equal(memory.body, body);
      assert.equal(memory.title, explicit ? TITLE + '-override' : TITLE);
      assert.deepEqual(memory.tags, explicit ? [TAG] : []);
    }
    assert.equal(server.requests.length, 0);
    assert.equal(sb.calls().length, 0);
    noContent(sb);
  } finally { await server.close(); sb.cleanup(); }
});

test('privacy: public suggestions keep the selected model and explicit CLI overrides', async () => {
  const sb = sandbox();
  const server = await mock({ '/api/chat': modelReply });
  try {
    fresh(sb);
    const model = 'owner-selected-public-model';
    const cfg = { ...load(), OLLAMA_URL: server.url, LLM_MODEL: model };
    assert.deepEqual(await suggest(cfg, 'Public note about coding conventions', false), { title: 'Public suggestion', tags: ['public tag'] });
    assert.equal(server.requests[0].body.model, model);
    const repo = gitRepo(sb, 'public-notes');
    const env = sb.env({ OLLAMA_URL: server.url, LLM_MODEL: model });
    const added = await bosun(['memory', 'add', '--auto', '-t', 'Explicit public title', 'Public note for the CLI'], { env, cwd: repo });
    assert.equal(added.code, 0, added.err);
    const id = added.out.match(/m_\w+/)![0];
    const memory = JSON.parse((await bosun(['memory', 'get', id, '--json'], { env, cwd: repo })).out);
    assert.equal(memory.title, 'Explicit public title');
    assert.deepEqual(memory.tags, ['public-tag']);
    assert.equal(memory.private, false);
    assert.equal(server.requests.length, 2);
    const explicit = await bosun(['memory', 'add', '--auto', '-t', 'Explicit all', '--tags', 'keep', 'Another public note'], { env, cwd: repo });
    assert.equal(explicit.code, 0, explicit.err);
    assert.equal(server.requests.length, 2, 'fully explicit flags need no suggestion');
    assert.equal(server.requests[1].body.model, model);
  } finally { await server.close(); sb.cleanup(); }
});

test('privacy: route flags/private or malformed hook markers skip inference and remote retrieval', async () => {
  const sb = sandbox();
  const server = await mock();
  try {
    const env = sb.env({ ROUTER_URL: server.url, MEMORY_URL: server.url });
    for (const marker of [{ private: true }, { private: 'true' }, { private: null }, { privacy: 'private' }, { privacy: 'unknown' }]) {
      const result = await bosun(['route', '--hook'], { env, input: JSON.stringify({ prompt: `${BODY} rename a to b`, ...marker }) });
      assert.deepEqual([result.code, result.out, result.err], [0, '', '']);
    }
    for (const args of [['route', '--private', BODY], ['route', '--hook', '--private']]) {
      const result = await bosun(args, { env, input: JSON.stringify({ prompt: `${BODY} rename a to b`, privacy: 'public' }) });
      assert.deepEqual([result.code, result.out, result.err], [0, '', '']);
    }
    assert.equal(server.requests.length, 0);
    assert.equal(sb.calls().length, 0);
    noContent(sb);
    const legacy = await bosun(['route', '--hook'], { env: sb.env({ ROUTER_URL: server.url }), input: JSON.stringify({ prompt: 'rename a to b in ordinary tooling' }) });
    assert.equal(legacy.code, 0, legacy.err);
    assert.match(legacy.out, /suggests: local/);
    assert.equal(server.requests.length, 1, 'unclassified legacy hook behavior remains compatible');
  } finally { await server.close(); sb.cleanup(); }
});

test('privacy: route observations contain closed metadata and fresh IDs, never prompt hashes or echoed model fields', async () => {
  const sb = sandbox();
  const server = await mock({ '/v1/systemone': () => ({ json: { model: ECHO, latency_ms: ECHO, prompt: BODY,
    answers: { lane: { choice: 'local', confidence: 0.9 }, risk: { choice: 'low', confidence: 0.3 } } } }) });
  try {
    const env = sb.env({ ROUTER_URL: server.url });
    const prompt = `${BODY} rename title ${TITLE} tag ${TAG}`;
    for (let i = 0; i < 2; i++) {
      const result = await bosun(['route', prompt], { env });
      assert.equal(result.code, 0, result.err);
      assert.equal(JSON.parse(result.out).router, 'kev-latest');
      assert.equal(result.out.includes(ECHO), false);
    }
    const file = path.join(sb.home, '.bosun', 'route-log.jsonl');
    const records = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(records.length, 2);
    assert.notEqual(records[0].id, records[1].id);
    for (const row of records) {
      assert.match(row.id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
      assert.deepEqual(Object.keys(row).sort(), ['conf', 'final', 'id', 'lane', 'ms', 'risk', 'risk_conf', 'router', 'ts', 'why']);
    }
    noContent(sb, [BODY, TITLE, TAG, ECHO, crypto.createHash('sha1').update(prompt).digest('hex').slice(0, 10), crypto.createHash('sha256').update(prompt).digest('hex')]);
  } finally { await server.close(); sb.cleanup(); }
});

test('privacy: malformed router choices/confidence and provider parse errors produce no content-bearing telemetry', async () => {
  const sb = sandbox();
  let response: any;
  const server = await mock({ '/v1/systemone': () => response });
  try {
    const env = sb.env({ ROUTER_URL: server.url });
    const valid = { model: ECHO, answers: { lane: { choice: 'local', confidence: 0.9 }, risk: { choice: 'low', confidence: 0.3 } } };
    for (const field of ['lane', 'risk', 'confidence', 'parse']) {
      const data = structuredClone(valid);
      if (field === 'lane') data.answers.lane.choice = ECHO;
      if (field === 'risk') data.answers.risk.choice = ECHO;
      if (field === 'confidence') (data.answers.lane as any).confidence = ECHO;
      response = field === 'parse' ? { text: ECHO } : { json: data };
      const result = await bosun(['route', `${BODY} ordinary coding task`], { env });
      assert.equal(result.code, 1);
      assert.doesNotMatch(result.err, /canary/);
      assert.equal(result.out, '');
      const hook = await bosun(['route', '--hook'], { env, input: JSON.stringify({ prompt: `${BODY} ordinary coding task` }) });
      assert.deepEqual([hook.code, hook.out], [0, '']);
    }
    assert.equal(fs.existsSync(path.join(sb.home, '.bosun', 'route-log.jsonl')), false);
    noContent(sb);
  } finally { await server.close(); sb.cleanup(); }
});

test('privacy: metadata-only labels and legacy IDs work without redisplaying historical prompts or mutating logs', async () => {
  const sb = sandbox();
  try {
    const dir = path.join(sb.home, '.bosun'); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'route-log.jsonl');
    const legacy = { ts: 1, id: '0123456789', prompt: BODY, lane: 'local', conf: 0.9, risk: 'low', risk_conf: 0.3, ms: 12, router: ECHO, final: 'local', why: ECHO };
    const malformed = { ...legacy, id: TITLE };
    const original = JSON.stringify(legacy) + '\n' + JSON.stringify(malformed) + '\n';
    fs.writeFileSync(file, original);
    const first = await bosun(['label'], { env: sb.env(), input: 'l\n' });
    assert.equal(first.code, 0, first.err);
    assert.match(first.out, /observation 0123456789/);
    assert.doesNotMatch(first.out, /canary/);
    assert.equal(fs.readFileSync(file, 'utf8'), original, 'historical raw log content is never automatically rewritten/deleted');
    const id = crypto.randomUUID();
    fs.appendFileSync(file, JSON.stringify({ ...legacy, id, prompt: undefined }) + '\n');
    const second = await bosun(['label'], { env: sb.env(), input: 'w\n' });
    assert.equal(second.code, 0, second.err);
    assert.match(second.out, new RegExp(`observation ${id}`));
    assert.doesNotMatch(second.out, /canary/);
    const labels = fs.readFileSync(path.join(dir, 'route-labels.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(labels, [{ id: legacy.id, label: 'local' }, { id, label: 'worker' }]);
    const stats = await bosun(['stats'], { env: sb.env() });
    assert.match(stats.out, /2 decisions/);
    assert.doesNotMatch(stats.out, /canary/);
  } finally { sb.cleanup(); }
});

test('privacy: nested log objects, toJSON hooks, errors/causes and unknown metadata never serialize', () => {
  const sb = sandbox();
  try {
    fresh(sb);
    let serialized = false;
    const nested = { title: TITLE, details: [{ body: BODY, tags: [TAG] }], toJSON() { serialized = true; return ECHO; } };
    const error = Object.assign(new Error(BODY, { cause: nested }), { name: ECHO, code: nested });
    log('error', 'mcp.tool', { tool: TITLE, err: error, details: nested, event: TAG, ts: ECHO });
    log('warn', ECHO, { err: { name: ECHO, cause: nested }, details: nested });
    log('info', 'consolidate', { summaries: nested, proposed: NaN, skipped: 2, provider: ECHO });
    log('info', 'db.migrate', { version: 3, data: nested });
    record({ op: ECHO, ms: NaN, n: nested, provider: nested, ok: BODY, data: nested } as any);
    assert.equal(serialized, false);
    noContent(sb);
    const lines = fs.readFileSync(path.join(sb.home, '.bosun', 'bosun.log'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(lines[0].tool, 'unknown');
    assert.equal(lines[0].error_name, 'unknown');
    assert.equal(lines[1].event, 'other');
    assert.equal(lines[2].provider, 'unknown');
    assert.equal(lines[3].version, 3);
  } finally { sb.cleanup(); }
});

test('privacy: LLM usage ignores echoed model/token content and emits fixed error kinds', async () => {
  const sb = sandbox();
  let reply: any = { json: { model: ECHO, message: { content: JSON.stringify({ title: TITLE }) }, prompt_eval_count: BODY, eval_count: { content: TAG } } };
  const server = await mock({ '/api/chat': () => reply });
  try {
    fresh(sb);
    const cfg = { ...load(), OLLAMA_URL: server.url, LLM_MODEL: 'explicit-owner-model', LLM_RETRIES: '0' };
    const options = { task: BODY, messages: [{ role: 'user' as const, content: BODY }], schema: { type: 'object' as const } };
    const success = await generate(cfg, options);
    assert.equal(success.ok, true);
    assert.equal(success.model, cfg.LLM_MODEL);
    assert.equal(success.tokensIn, undefined);
    assert.equal(success.tokensOut, undefined);
    reply = { text: ECHO };
    assert.equal((await generate(cfg, options)).error, 'error');
    reply = { json: { message: { content: ECHO }, prompt_eval_count: TITLE } };
    assert.equal((await generate(cfg, options)).error, 'bad_json');
    const fetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => { throw new TypeError(ECHO, { cause: new Error(BODY) }); };
      assert.equal((await generate(cfg, options)).error, 'connection');
    } finally { globalThis.fetch = fetch; }
    const rows = fs.readFileSync(path.join(sb.home, '.bosun', 'llm-usage.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(rows.map((row) => row.error_kind), [null, 'error', 'bad_json', 'connection']);
    assert.ok(rows.every((row) => row.task === 'other' && row.provider === 'ollama' && row.model === cfg.LLM_MODEL));
    assert.ok(rows.every((row) => row.tokensIn === null && row.tokensOut === null));
    noContent(sb);
  } finally { await server.close(); sb.cleanup(); }
});

test('privacy: metrics reports never redisplay malformed historical metadata and leave files unchanged', () => {
  const sb = sandbox();
  try {
    fresh(sb);
    const dir = path.join(sb.home, '.bosun'); fs.mkdirSync(dir, { recursive: true });
    const metrics = JSON.stringify({ op: BODY, ms: TITLE, n: TAG }) + '\nnull\n';
    const usage = JSON.stringify({ task: BODY, provider: TITLE, model: TAG, tokensIn: ECHO, tokensOut: { text: BODY }, ms: TITLE }) + '\nnull\n';
    fs.writeFileSync(path.join(dir, 'metrics.jsonl'), metrics);
    fs.writeFileSync(path.join(dir, 'llm-usage.jsonl'), usage);
    const output = report().join('\n');
    assert.doesNotMatch(output, /canary/);
    assert.equal(fs.readFileSync(path.join(dir, 'metrics.jsonl'), 'utf8'), metrics);
    assert.equal(fs.readFileSync(path.join(dir, 'llm-usage.jsonl'), 'utf8'), usage);
  } finally { sb.cleanup(); }
});
