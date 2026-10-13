import './bootstrap.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mock } from './helpers.ts';
import { BosunError } from '../src/core/errors.ts';
import { createOllamaModelProvider, type OllamaModelSettings } from '../src/adapters/models/ollama.ts';
import type { GenRequest } from '../src/core/ports/model.ts';
import { createCompatibleModelProvider } from '../src/adapters/models/openai-compatible.ts';
import { modelProviders } from '../src/app/model-providers.ts';
import { defaultConfig } from '../src/core/domain/config.ts';

const MODEL = 'qwen3.6:35b-a3b-coding-nvfp4';
const OUTPUT = { next: 'Continue the approved task', constraints: ['Keep explicit model selection'] };
const SCHEMA = { type: 'object', properties: { next: { type: 'string' }, constraints: { type: 'array', items: { type: 'string' } } }, required: ['next', 'constraints'], additionalProperties: false };
const settings = (url: string): OllamaModelSettings => ({ url, model: MODEL, contextTokens: 65536, maxOutputTokens: 4096, timeoutMs: 1000 });
const request = (): GenRequest => ({ privacy: 'public', task: 'handoff-summary', messages: [{ role: 'system', content: 'Preserve constraints.' }, { role: 'user', content: 'Public source task.' }], schema: SCHEMA, signal: new AbortController().signal });
const reply = (extra: Record<string, unknown> = {}) => ({ model: MODEL, message: { role: 'assistant', content: JSON.stringify(OUTPUT), thinking: 'THINKING_CANARY' }, done: true, done_reason: 'stop', prompt_eval_count: 500, eval_count: 40, providerSecret: 'PROVIDER_CANARY', ...extra });
const unknown = (error: unknown) => error instanceof BosunError && error.code === 'unavailable' && error.details?.outcome === 'unknown';

test('generative construction is inert and denied classification precedes content/config/schema getters', async () => {
  let reads = 0;
  const provider = createOllamaModelProvider({ get url(): never { reads++; throw Error('URL_CANARY'); } } as unknown as OllamaModelSettings);
  assert.equal(reads, 0);
  for (const privacy of ['private', 'unknown', undefined]) {
    const input = { ...request(), privacy, get messages(): never { reads++; throw Error('INPUT_CANARY'); }, get schema(): never { reads++; throw Error('SCHEMA_CANARY'); } } as GenRequest;
    await assert.rejects(provider.generate(input), (error: unknown) => error instanceof BosunError && error.code === 'private_input');
  }
  await assert.rejects(provider.generate(Object.create(request())), (error: unknown) => error instanceof BosunError && error.code === 'private_input');
  assert.equal(reads, 0);
});

test('Ollama wire preserves explicit model/schema/context/output bounds and projects validated text/JSON/usage', async () => {
  const server = await mock({ '/api/chat': () => ({ json: reply() }) });
  try {
    const provider = createOllamaModelProvider(settings(server.url)); const result = await provider.generate(request());
    assert.deepEqual(result, { text: JSON.stringify(OUTPUT), json: OUTPUT, model: MODEL, tokensIn: 500, tokensOut: 40 });
    assert.equal(JSON.stringify(result).includes('CANARY'), false); assert.equal(server.requests.length, 1);
    assert.equal(server.requests[0]!.method, 'POST'); assert.deepEqual(server.requests[0]!.body, { model: MODEL, messages: request().messages, stream: false, think: false, format: SCHEMA, options: { num_ctx: 65536, num_predict: 4096, temperature: 0 } });
    assert.equal('tools' in server.requests[0]!.body, false); assert.equal(provider.caps.local, 'unverified');
  } finally { await server.close(); }
});

test('explicit model override is preserved; metadata health does not generate, download or switch models', async () => {
  const chosen = 'custom-model:exact:tag';
  const server = await mock({ '/api/tags': () => ({ json: { models: [{ name: MODEL, details: { ignored: 'CANARY' } }] } }), '/api/chat': () => ({ json: reply({ model: chosen }) }) });
  try {
    const provider = createOllamaModelProvider(settings(server.url)); assert.equal(await provider.health(new AbortController().signal), true);
    assert.equal(server.requests.length, 1); assert.equal(server.requests[0]!.method, 'GET');
    const result = await provider.generate({ ...request(), model: chosen }); assert.equal(result.model, chosen); assert.equal(server.requests[1]!.body.model, chosen);
    assert.equal(server.requests.some(row => /pull|create|show|generate/.test(row.path)), false);
  } finally { await server.close(); }
});

test('mismatched/unfinished/truncated/tool-bearing/bad-schema responses never become summaries or retries', async () => {
  let value: unknown; const server = await mock({ '/api/chat': () => ({ json: value }) });
  try {
    const cases = [reply({ model: 'different-model' }), reply({ done: false }), reply({ done_reason: 'length' }), reply({ message: { role: 'assistant', content: JSON.stringify(OUTPUT), tool_calls: [{ function: { name: 'PRIVATE_CANARY' } }] } }), reply({ message: { role: 'assistant', content: '{malformed' } }), reply({ message: { role: 'assistant', content: '{"next":"missing constraints"}' } }), reply({ message: { role: 'assistant', content: JSON.stringify({ ...OUTPUT, privateExtra: 'CANARY' }) } }), reply({ eval_count: -1 })];
    for (const candidate of cases) {
      value = candidate; const before = server.requests.length;
      await assert.rejects(createOllamaModelProvider(settings(server.url)).generate(request()), (error: unknown) => unknown(error) && !(error as Error).message.includes('CANARY'));
      assert.equal(server.requests.length, before + 1);
    }
  } finally { await server.close(); }
});

test('input/model/schema bounds and explicit loopback policy fail before HTTP with finite errors', async () => {
  const server = await mock({ '/api/chat': () => ({ json: reply() }) });
  try {
    const provider = createOllamaModelProvider(settings(server.url)); const cyclic: Record<string, unknown> = {}; cyclic.cycle = cyclic;
    for (const input of [{ ...request(), model: 'bad\nmodel' }, { ...request(), messages: [{ role: 'user' as const, content: 'x'.repeat(32769) }] }, { ...request(), schema: cyclic }, { ...request(), schema: { type: 'unrecognized' } }]) {
      await assert.rejects(provider.generate(input), (error: unknown) => error instanceof BosunError && error.code === 'invalid');
    }
    await assert.rejects(createOllamaModelProvider({ ...settings('https://remote.example.invalid'), loopbackOnly: true }).generate(request()), (error: unknown) => error instanceof BosunError && error.code === 'invalid');
    await assert.rejects(createOllamaModelProvider({ ...settings(server.url), contextTokens: 2048, maxOutputTokens: 500 }).generate({ ...request(), messages: [{ role: 'user', content: 'x'.repeat(1000) }] }), code('invalid'));
    assert.equal(server.requests.length, 0);
  } finally { await server.close(); }
});

test('timeout preserves one finite unknown generation; absent native token counters remain unknown', async () => {
  const server = await mock({ '/api/chat': () => ({ delayMs: 50, json: reply() }) });
  try {
    await assert.rejects(createOllamaModelProvider({ ...settings(server.url), timeoutMs: 10 }).generate(request()), (error: unknown) => error instanceof BosunError && error.code === 'timeout' && error.details?.outcome === 'unknown');
    assert.equal(server.requests.length, 1);
  } finally { await server.close(); }
  const missing = await mock({ '/api/chat': () => ({ json: reply({ prompt_eval_count: undefined, eval_count: undefined }) }) });
  try { const result = await createOllamaModelProvider(settings(missing.url)).generate(request()); assert.equal(Object.hasOwn(result, 'tokensIn'), false); assert.equal(Object.hasOwn(result, 'tokensOut'), false); }
  finally { await missing.close(); }
});

test('deterministic credential screening withholds explicitly public inputs before any generation', async () => {
  const server = await mock({ '/api/chat': () => ({ json: reply() }) });
  try {
    for (const content of ['-----BEGIN OPENSSH PRIVATE KEY-----', 'api_key=' + 'x'.repeat(40), 'sk-proj-' + 'a'.repeat(40)]) {
      await assert.rejects(createOllamaModelProvider(settings(server.url)).generate({ ...request(), messages: [{ role: 'user', content }] }), code('private_input'));
    }
    assert.equal(server.requests.length, 0);
  } finally { await server.close(); }
});
const code = (name: string) => (error: unknown) => error instanceof BosunError && error.code === name;
const compatibleReply = (extra: Record<string, unknown> = {}) => ({ object: 'chat.completion', model: 'explicit-api-model:exact', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(OUTPUT) } }], usage: { prompt_tokens: 12, completion_tokens: 5 }, ...extra });

test('configured compatible provider sends one tool-free schema request with only the declared credential and exact model', async () => {
  const server = await mock({ '/v1/chat/completions': () => ({ json: compatibleReply() }), '/v1/models': () => ({ json: { data: [{ id: 'explicit-api-model:exact' }] } }) });
  try {
    const provider = createCompatibleModelProvider({ url: server.url + '/v1', model: 'explicit-api-model:exact', timeoutMs: 1000, maxOutputTokens: 400,
      apiKeyEnv: 'SELECTED_API_KEY', env: { SELECTED_API_KEY: 'synthetic-authorized-key', UNRELATED_API_KEY: 'UNRELATED_CANARY' } });
    assert.equal(server.requests.length, 0); assert.equal(await provider.health(new AbortController().signal), true);
    const result = await provider.generate(request()); assert.deepEqual(result, { text: JSON.stringify(OUTPUT), json: OUTPUT, model: 'explicit-api-model:exact', tokensIn: 12, tokensOut: 5 });
    const row = server.requests[1]; assert.equal(row.headers.authorization, 'Bearer synthetic-authorized-key');
    assert.deepEqual(row.body, { model: 'explicit-api-model:exact', messages: request().messages, stream: false, store: false, n: 1, tool_choice: 'none', max_completion_tokens: 400,
      response_format: { type: 'json_schema', json_schema: { name: 'bosun_output', strict: true, schema: SCHEMA } } });
    assert.equal(JSON.stringify(row.body).includes('KEY'), false); assert.equal(JSON.stringify(result).includes('CANARY'), false);
  } finally { await server.close(); }
});

test('compatible refusals, truncation, tools, model drift and invalid outputs are finite unknown and never retried', async () => {
  let value: unknown; const server = await mock({ '/v1/chat/completions': () => ({ json: value }) });
  try {
    const provider = createCompatibleModelProvider({ url: server.url, model: 'explicit-api-model:exact', timeoutMs: 1000, maxOutputTokens: 400, env: {} });
    for (const candidate of [compatibleReply({ model: 'silent-fallback' }), compatibleReply({ choices: [{ index: 0, finish_reason: 'length', message: { role: 'assistant', content: '{}' } }] }),
      compatibleReply({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(OUTPUT), refusal: 'PRIVATE_CANARY' } }] }),
      compatibleReply({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{}', tool_calls: [{ function: { name: 'PRIVATE_CANARY' } }] } }] }),
      compatibleReply({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{bad' } }] }), compatibleReply({ usage: { prompt_tokens: -1, completion_tokens: 5 } })]) {
      value = candidate; const before = server.requests.length; await assert.rejects(provider.generate(request()), unknown); assert.equal(server.requests.length, before + 1);
    }
  } finally { await server.close(); }
});

test('compatible denied input precedes credential access; missing credentials never silently become anonymous or borrowed authentication', async () => {
  let accesses = 0; const env = { get SELECTED_API_KEY(): never { accesses++; throw Error('CREDENTIAL_CANARY'); } };
  const provider = createCompatibleModelProvider({ url: 'https://configured.example.invalid', model: 'selected', timeoutMs: 1000, maxOutputTokens: 100, apiKeyEnv: 'SELECTED_API_KEY', env });
  await assert.rejects(provider.generate({ ...request(), privacy: 'private' }), code('private_input')); assert.equal(accesses, 0);
  await assert.rejects(createCompatibleModelProvider({ url: 'https://configured.example.invalid', model: 'selected', timeoutMs: 1000, maxOutputTokens: 100, apiKeyEnv: 'SELECTED_API_KEY', env: {} }).generate(request()), code('unavailable'));
  await assert.rejects(createCompatibleModelProvider({ url: 'http://configured.example.invalid', model: 'selected', timeoutMs: 1000, maxOutputTokens: 100, apiKeyEnv: 'SELECTED_API_KEY', env: { SELECTED_API_KEY: 'synthetic' } }).generate(request()), code('invalid'));
});

test('final provider registry is inert, loads only configured selection and refuses unqualified native summary isolation', async () => {
  const config = defaultConfig(); config.providers.native = { kind: 'codex-cli', model: 'gpt-6.1-sol', timeoutMs: 1000 };
  const providers = modelProviders(config, { get OPENAI_API_KEY(): never { throw Error('UNRELATED_CREDENTIAL_CANARY'); } });
  assert.deepEqual(Object.keys(providers), ['default', 'native']); assert.equal(providers.native.caps.toolFree, 'unverified');
  assert.equal(await providers.native.health(new AbortController().signal), false);
  await assert.rejects(providers.native.generate({ ...request(), privacy: 'private' }), code('private_input'));
  await assert.rejects(providers.native.generate(request()), code('unverified'));
  assert.equal(config.providers.default.model, MODEL);
});
