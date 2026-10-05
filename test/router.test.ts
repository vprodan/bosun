import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { registerHooks } from 'node:module';
import { mock, REPO } from './helpers.ts';
import { createAdapterRegistry } from '../src/app/registry.ts';
import { createRoutePrompt } from '../src/core/use-cases/route-prompt.ts';
import { BosunError } from '../src/core/errors.ts';
import { requireCapability } from '../src/core/policy.ts';
import { routerContract } from './router-contract.ts';

const fixture = () => JSON.parse(fs.readFileSync(path.join(REPO, 'test/fixtures/clef-systemone.json'), 'utf8'));
const SIGNAL = new AbortController().signal;
const PUBLIC = { text: 'implement refund in payment-service', privacy: 'public' as const };
function safeFailure(code: string, message?: string) {
  return (error: unknown) => {
    assert.ok(error instanceof BosunError);
    assert.equal(error.code, code);
    if (message) assert.equal(error.message, message);
    assert.doesNotMatch(error.message, /PRIVATE-|ECHO-/);
    assert.doesNotMatch(JSON.stringify(error), /PRIVATE-|ECHO-/);
    return true;
  };
}

test('Clef registry is lazy and construction/private classification accesses no config or transport', async () => {
  let loads = 0;
  let reads = 0;
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (specifier.includes('/adapters/routers/ollama-clef.ts')) loads++;
    return next(specifier, context);
  } });
  try {
    const registry = createAdapterRegistry();
    assert.equal(loads, 0);
    const router = await registry.router('ollama-clef', {
      get url(): string { reads++; throw Error('PRIVATE-CONFIG'); },
      get model(): string { reads++; throw Error('PRIVATE-CONFIG'); },
    });
    assert.ok(loads > 0);
    assert.equal(reads, 0);
    for (const privacy of ['private', 'unknown', undefined, 'malformed']) {
      await assert.rejects(router.classify({ privacy, get text(): string { throw Error('PRIVATE-TEXT'); } } as never, SIGNAL), safeFailure('private_input', 'Inference requires explicitly public input'));
    }
    const inherited = Object.assign(Object.create({ privacy: 'public' }), { text: 'PRIVATE-INHERITED' });
    await assert.rejects(router.classify(inherited, SIGNAL), safeFailure('private_input'));
    await assert.rejects(router.classify({ get privacy(): 'public' { throw Error('PRIVATE-GETTER'); }, text: 'PRIVATE-TEXT' }, SIGNAL), safeFailure('private_input'));
    const throwing = new Proxy({}, { getOwnPropertyDescriptor() { throw Error('PRIVATE-DESCRIPTOR'); } });
    await assert.rejects(router.classify(throwing as never, SIGNAL), safeFailure('private_input', 'Inference requires explicitly public input'));
    const revoked = Proxy.revocable({ privacy: 'public', text: 'PRIVATE-REVOKED' }, {}); revoked.revoke();
    await assert.rejects(router.classify(revoked.proxy as never, SIGNAL), safeFailure('private_input'));
    assert.equal(reads, 0);
  } finally { hooks.deregister(); }
});

test('Clef sends exact ordered decision questions and preserves an explicitly selected trusted model', async () => {
  const m = await mock({ '/v1/systemone': () => ({ json: { ...fixture(), model: 'selected/model:tag', prompt: 'ECHO-PROMPT', latency_ms: 'ECHO-LATENCY', extra: { private: 'ECHO-CONTENT' } } }) });
  try {
    const router = await createAdapterRegistry().router('ollama-clef', { url: m.url, model: 'selected/model:tag' });
    assert.equal(m.requests.length, 0);
    const result = await createRoutePrompt({ router, minConfidence: 0.7 })(PUBLIC, SIGNAL);
    assert.equal(result?.final, 'main');
    assert.equal(result?.decision.router, 'selected/model:tag');
    assert.doesNotMatch(JSON.stringify(result), /ECHO-/);
    const body = m.requests[0].body;
    assert.deepEqual(Object.keys(body), ['model', 'state', 'questions']);
    assert.equal(body.state, PUBLIC.text);
    assert.equal(body.model, 'selected/model:tag');
    assert.deepEqual(Object.keys(body.questions), ['lane', 'risk']);
    assert.deepEqual(Object.keys(body.questions.lane.criteria), ['main', 'worker', 'local', 'scout']);
    assert.deepEqual(Object.keys(body.questions.risk.criteria), ['high', 'low']);
    assert.ok(Buffer.byteLength(JSON.stringify(body), 'utf8') <= 64 * 1024);
  } finally { await m.close(); }
});

test('Clef bounds full UTF-8 payload, including multibyte state and questions, without silent truncation', async () => {
  const m = await mock({ '/v1/systemone': () => ({ json: fixture() }) });
  try {
    const router = await createAdapterRegistry().router('ollama-clef', { url: m.url });
    const text = '日本語'.repeat(1000);
    await router.classify({ text, privacy: 'public' }, SIGNAL);
    assert.equal(m.requests[0].body.state, text);
    assert.ok(Buffer.byteLength(JSON.stringify(m.requests[0].body), 'utf8') > text.length);
    await assert.rejects(router.classify({ text: '界'.repeat(24_000), privacy: 'public' }, SIGNAL), safeFailure('invalid', 'Decision request exceeds byte limit'));
    await assert.rejects(router.classify({ text: 'x'.repeat(24_001), privacy: 'public' }, SIGNAL), safeFailure('invalid', 'Decision input exceeds text limit or is empty'));
    await assert.rejects(router.classify({ text: ' ', privacy: 'public' }, SIGNAL), safeFailure('invalid'));
    assert.equal(m.requests.length, 1);
  } finally { await m.close(); }
});

test('Clef rejects malformed/foreign responses with fixed actual messages and no retries/fallback', async () => {
  const mutations: ((value: ReturnType<typeof fixture>) => unknown)[] = [
    (v) => ({ ...v, model: 'PRIVATE-FOREIGN-MODEL' }), (v) => ({ ...v, usage: undefined }),
    (v) => { delete v.answers.risk; return v; }, (v) => { v.answers.extra = v.answers.risk; return v; },
    (v) => { v.answers.lane.type = 'score'; return v; }, (v) => { v.answers.lane.confidence = 'PRIVATE-CONFIDENCE'; return v; },
    (v) => { v.answers.lane.choice = 'PRIVATE-OUTCOME'; return v; }, (v) => { v.answers.lane.probabilities.worker = -1; return v; },
    (v) => { v.answers.lane.probabilities.worker = 0.1; return v; }, (v) => { v.answers.lane.probabilities.foreign = 0; return v; },
    (v) => { v.answers.risk.confidence = 1.1; return v; }, (v) => { v.usage.input_tokens = 'PRIVATE-USAGE'; return v; },
    () => ({ error: 'PRIVATE-UPSTREAM-ERROR' }), () => null,
  ];
  for (const mutate of mutations) {
    const m = await mock({ '/v1/systemone': () => ({ json: mutate(fixture()) }) });
    try {
      const router = await createAdapterRegistry().router('ollama-clef', { url: m.url });
      await assert.rejects(router.classify(PUBLIC, SIGNAL), safeFailure('invalid', 'Invalid decision protocol response'));
      assert.equal(m.requests.length, 1);
    } finally { await m.close(); }
  }
});

test('Clef validates greatest/tied choices conservatively and risk still overrides zero confidence', async () => {
  const response = fixture();
  response.answers.lane = { type: 'choice', choice: 'local', probabilities: { main: 0.1, worker: 0.1, local: 0.7, scout: 0.1 }, confidence: 0 };
  response.answers.risk = { type: 'choice', choice: 'high', probabilities: { high: 0.5, low: 0.5 }, confidence: 0 };
  const m = await mock({ '/v1/systemone': () => ({ json: response }) });
  try {
    const router = await createAdapterRegistry().router('ollama-clef', { url: m.url });
    assert.equal((await createRoutePrompt({ router, minConfidence: 0.9 })(PUBLIC, SIGNAL))?.final, 'main');
    response.answers.risk.choice = 'low';
    await assert.rejects(router.classify(PUBLIC, SIGNAL), safeFailure('invalid'));
  } finally { await m.close(); }
});

test('Clef JSON/content/HTTP failures are content-free and a missing model never triggers a pull', async () => {
  for (const reply of [{ text: 'PRIVATE-NOT-JSON' }, { status: 404, text: 'PRIVATE-MODEL-MISSING' }, { destroy: true }]) {
    const m = await mock({ '/v1/systemone': () => reply });
    try {
      const router = await createAdapterRegistry().router('ollama-clef', { url: m.url });
      await assert.rejects(router.classify(PUBLIC, SIGNAL), safeFailure(reply.status || reply.destroy ? 'unavailable' : 'invalid'));
      assert.deepEqual(m.requests.map((r) => r.path), ['/v1/systemone']);
    } finally { await m.close(); }
  }
});

async function streamingFixture(body: (res: http.ServerResponse) => void) {
  const server = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); body(res); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}
test('Clef bounds streamed response bytes and aborts stalled bodies within its deadline', async () => {
  for (const arm of ['oversize', 'stall', 'bad-json', 'bad-utf8'] as const) {
    const m = await streamingFixture((res) => {
      if (arm === 'oversize') { res.write('{"echo":"'); res.end('x'.repeat(70_000) + '"}'); }
      else if (arm === 'stall') res.write('{');
      else if (arm === 'bad-json') res.end('PRIVATE-INVALID-JSON');
      else res.end(Buffer.from([0xff]));
    });
    try {
      const router = await createAdapterRegistry().router('ollama-clef', { url: m.url, timeoutMs: 50 });
      await assert.rejects(router.classify(PUBLIC, SIGNAL), safeFailure(arm === 'stall' ? 'timeout' : 'invalid'));
    } finally { await m.close(); }
  }
});

test('Clef caller cancellation and invalid configuration perform no inference or substitution', async () => {
  const m = await mock({ '/v1/systemone': () => ({ json: fixture() }) });
  try {
    const aborted = new AbortController(); aborted.abort();
    const router = await createAdapterRegistry().router('ollama-clef', { url: m.url });
    await assert.rejects(router.classify(PUBLIC, aborted.signal), safeFailure('cancelled', 'Protocol request interrupted'));
    for (const settings of [{ url: m.url, model: '' }, { url: m.url, timeoutMs: 0 }, { url: 'http://user:PRIVATE-AUTH@localhost' }]) {
      const candidate = await createAdapterRegistry().router('ollama-clef', settings);
      await assert.rejects(candidate.classify(PUBLIC, SIGNAL), safeFailure('invalid'));
    }
    assert.equal(m.requests.length, 0);
  } finally { await m.close(); }
});

test('Clef fixture/schema checks leave calibration and live readiness unverified', async () => {
  const { CLEF_QUALIFICATION } = await import('../src/adapters/routers/ollama-clef.ts');
  assert.deepEqual(CLEF_QUALIFICATION, { calibration: 'unverified', liveReadiness: 'unverified', autonomousDelegation: 'unsupported' });
  assert.throws(() => requireCapability(CLEF_QUALIFICATION.calibration, 'calibration'), (error) => error instanceof BosunError && error.code === 'unverified');
});

routerContract('Ollama Clef fixture', async () => {
  const m = await mock({ '/v1/systemone': () => ({ json: fixture() }) });
  return { router: await createAdapterRegistry().router('ollama-clef', { url: m.url }), calls: () => m.requests.length, close: m.close };
});
