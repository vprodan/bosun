import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { sandbox, fresh, mock } from './helpers.ts';
import { BosunError, MemoryError, BOSUN_ERROR_CODES } from '../src/core/errors.ts';
import { MemoryError as LegacyMemoryError } from '../lib/memory/types.ts';
import { BosunError as LegacyBosunError } from '../lib/util.ts';
import { terms, norm, words, jaccard } from '../src/core/text.ts';
import { terms as legacyTerms } from '../lib/memory/sqlite.ts';
import { decide } from '../src/core/route-policy.ts';
import { decide as legacyDecide } from '../lib/route.ts';
import { createRoutePrompt } from '../src/core/use-cases/route-prompt.ts';
import { requireCapability } from '../src/core/policy.ts';
import { requireManagedControl } from '../src/core/managed-policy.ts';
import { mayExposeMemory } from '../src/core/memory-policy.ts';
import type { Router } from '../src/core/ports/router.ts';
import type { ManagedSessionControl } from '../src/core/ports/host.ts';
import { createAdapterRegistry } from '../src/app/registry.ts';
import { retrieve } from '../lib/context.ts';
import { log } from '../lib/log.ts';
import { routerContract } from './router-contract.ts';

const RAW = { lane: 'local' as const, conf: 0.9, risk: 'low' as const, risk_conf: 0.3, ms: 12 };
const SIGNAL = new AbortController().signal;
const coded = (code: string) => (error: unknown) => error instanceof BosunError && error.code === code;
const fake = (classify: Router['classify']): Router => ({ id: 'fixture:any-provider', label: 'configured-model', classify });

test('core extraction retains class/function identity and deterministic Unicode text behavior', () => {
  assert.equal(MemoryError, LegacyMemoryError);
  assert.equal(BosunError, LegacyBosunError);
  assert.equal(terms, legacyTerms);
  assert.equal(decide, legacyDecide);
  const error = new LegacyMemoryError('conflict', 'version conflict', 3);
  assert.ok(error instanceof MemoryError);
  assert.deepEqual([error.code, error.current], ['conflict', 3]);
  assert.deepEqual(terms('fetchCart get_cart HTTPServer the 日本語'), ['fetchcart', 'fetch', 'cart', 'get_cart', 'get', 'httpserver', 'http', 'server', '日本語']);
  assert.equal(norm('  TWO\n words  '), 'two words');
  assert.equal(jaccard(words('one two'), words('two three')), 1 / 3);
  assert.equal(jaccard(new Set(), new Set()), 1);
});

test('coded errors preserve causes/legacy exits but constrain untyped codes/details and finite logs', () => {
  const sb = sandbox();
  try {
    fresh(sb);
    const cause = new Error('PRIVATE-CAUSE');
    for (const code of BOSUN_ERROR_CODES) {
      const error = new BosunError(code, 'PRIVATE-MESSAGE', { cause, details: { currentVersion: 2, outcome: 'unknown', body: 'PRIVATE-DETAIL' } as never });
      assert.equal(error.cause, cause);
      assert.deepEqual(error.details, { currentVersion: 2, outcome: 'unknown' });
      log('warn', 'hook.memory', { err: error });
    }
    const unknown = new BosunError('PRIVATE-CODE' as never, 'PRIVATE-MESSAGE');
    assert.equal(unknown.code, 'internal');
    log('warn', 'hook.memory', { err: unknown });
    const content = fs.readFileSync(path.join(sb.home, '.bosun/bosun.log'), 'utf8');
    assert.doesNotMatch(content, /PRIVATE-/);
    assert.deepEqual(content.trim().split('\n').slice(0, -1).map((row) => JSON.parse(row).error_code), BOSUN_ERROR_CODES);
    assert.equal(new LegacyBosunError('bad usage', 2).exitCode, 2);
    assert.equal(new LegacyMemoryError('UNKNOWN' as never, 'safe').code, 'unavailable');
  } finally { sb.cleanup(); }
});

test('routing risk overrides low confidence, while ordinary uncertain decisions stay silent', async () => {
  for (const lane of ['local', 'worker'] as const) {
    const route = createRoutePrompt({ router: fake(async () => ({ ...RAW, lane, risk: 'high', conf: 0 })), minConfidence: 0.7 });
    assert.deepEqual(await route({ text: 'public fixture', privacy: 'public' }, SIGNAL), {
      decision: { ...RAW, lane, risk: 'high', conf: 0, router: 'configured-model' }, final: 'main', why: `risk=high overrides ${lane}`,
    });
  }
  const result = await createRoutePrompt({ router: fake(async () => ({ ...RAW, conf: 0.1 })), minConfidence: 0.7 })({ text: 'public fixture', privacy: 'public' }, SIGNAL);
  assert.deepEqual([result?.final, result?.why], [null, 'low confidence']);
});

test('new routing contract rejects private/unknown/unclassified input before text access or port calls', async () => {
  let calls = 0;
  const route = createRoutePrompt({ router: fake(async () => { calls++; return RAW; }), minConfidence: 0.7 });
  for (const privacy of ['private', 'unknown', undefined, 'malformed']) {
    const input = { privacy, get text(): string { throw Error('PRIVATE-TEXT accessed'); } };
    await assert.rejects(route(input as never, SIGNAL), coded('private_input'));
  }
  assert.equal(calls, 0);
});

test('routing sanitizes provider extras and uses only the trusted configured label', async () => {
  const route = createRoutePrompt({ router: fake(async () => ({ ...RAW,
    get router(): string { throw Error('PRIVATE-ECHO accessed'); }, prompt: 'PRIVATE-ECHO', cause: { text: 'PRIVATE-ECHO' },
  })), minConfidence: 0.7 });
  const result = await route({ text: 'public fixture', privacy: 'public' }, SIGNAL);
  assert.equal(result?.decision.router, 'configured-model');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-|prompt|cause/);
  assert.deepEqual(Object.keys(result!.decision).sort(), ['lane', 'conf', 'risk', 'risk_conf', 'ms', 'router'].sort());
});

test('routing rejects malformed decisions/config and respects abort/null without a fallback model', async () => {
  const invalid = [NaN, Infinity, -1, 1.1];
  for (const conf of invalid) {
    await assert.rejects(createRoutePrompt({ router: fake(async () => ({ ...RAW, conf })), minConfidence: 0.7 })({ text: 'public', privacy: 'public' }, SIGNAL), coded('invalid'));
    assert.throws(() => createRoutePrompt({ router: fake(async () => RAW), minConfidence: conf }), coded('invalid'));
  }
  await assert.rejects(createRoutePrompt({ router: fake(async () => ({ ...RAW, lane: 'PRIVATE-ECHO' } as never)), minConfidence: 0.7 })({ text: 'public', privacy: 'public' }, SIGNAL), coded('invalid'));
  assert.equal(await createRoutePrompt({ router: fake(async () => null), minConfidence: 0.7 })({ text: 'public', privacy: 'public' }, SIGNAL), null);
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  await assert.rejects(createRoutePrompt({ router: fake(async () => { calls++; return RAW; }), minConfidence: 0.7 })({ text: 'public', privacy: 'public' }, controller.signal), { name: 'AbortError' });
  assert.equal(calls, 0);
});

test('omitted/unsupported/unverified capabilities fail closed; selection does not probe a host', () => {
  for (const state of [undefined, 'unsupported', 'unverified', 'malformed']) {
    assert.throws(() => requireCapability(state as never, 'fixture'), coded(state === 'unverified' ? 'unverified' : 'unsupported'));
  }
  assert.doesNotThrow(() => requireCapability('verified', 'fixture'));
  let calls = 0;
  const method = async (): Promise<never> => { calls++; throw Error('must not run'); };
  const caps = { contextTelemetry: 'verified', promptAdmission: 'verified', toolQuiescence: 'verified', freshSession: 'verified', seedWithoutInference: 'verified', freshReadiness: 'verified' } as const;
  const control: ManagedSessionControl = { caps, observeContext: method, fenceAdmission: method, quiesce: method, startFresh: method, seed: method, ready: method };
  assert.equal(requireManagedControl({ control }), control);
  assert.throws(() => requireManagedControl({}), coded('unsupported'));
  for (const malformed of [undefined, null, 42, {}, { ...caps, toolQuiescence: 'unverified' }]) {
    assert.throws(() => requireManagedControl({ control: { ...control, caps: malformed } as never }), coded(malformed && typeof malformed === 'object' && 'toolQuiescence' in malformed ? 'unverified' : 'unsupported'));
  }
  assert.throws(() => requireManagedControl({ control: { ...control, ready: undefined } as never }), coded('unsupported'));
  assert.equal(calls, 0);
});

test('model memory exposure denies the entire private record and unknown classification, while owner reads remain eligible', () => {
  const record = { private: true, get title(): string { throw Error('PRIVATE-TITLE accessed'); }, tags: ['PRIVATE-TAG'], source: 'PRIVATE-SOURCE' };
  assert.equal(mayExposeMemory(record, 'model'), false);
  assert.equal(mayExposeMemory(record, 'owner'), true);
  assert.equal(mayExposeMemory({ private: false }, 'model'), true);
  for (const flag of [undefined, null, 'false', 0]) assert.equal(mayExposeMemory({ private: flag }, 'model'), false);
  assert.equal(mayExposeMemory({ private: false }, 'unexpected' as never), false);
  assert.equal(mayExposeMemory(null, 'model'), false);
});

test('legacy retrieval neither calls new/unverified source IDs nor admits mismatched source hits', async () => {
  const sb = sandbox();
  try {
    fresh(sb);
    let calls = 0;
    const hit = { source: 'curated', id: 'fixture', title: 't', text: 'public', category: 'project', rank: -1, at: Date.now(), accessCount: 0 };
    const result = await retrieve('public fixture', [
      { name: 'new:unverified', search: async () => { calls++; return [hit]; } },
      { name: '__proto__', search: async () => { calls++; return [hit]; } },
      { name: 'docs', search: async () => [hit] },
    ], { projectId: 'p_fixture', sessionId: null, linked: [] }, { budgetTokens: 400, minScore: 0, itemChars: 400 });
    assert.equal(calls, 0);
    assert.deepEqual(result.items, []);
  } finally { sb.cleanup(); }
});

test('static registry loads only the selected legacy adapter and performs no probe/inference at creation', async () => {
  let loads = 0;
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (specifier.includes('/adapters/routers/legacy-kev.ts')) loads++;
    return next(specifier, context);
  } });
  const m = await mock();
  try {
    const registry = createAdapterRegistry();
    assert.equal(loads, 0);
    await assert.rejects(registry.router('missing', { url: m.url }), coded('unsupported'));
    assert.equal(loads, 0);
    const router = await registry.router('legacy-kev', { url: m.url });
    assert.ok(loads > 0);
    assert.equal(m.requests.length, 0);
    const result = await createRoutePrompt({ router, minConfidence: 0.7 })({ text: 'rename a public fixture', privacy: 'public' }, SIGNAL);
    assert.equal(result?.final, 'local');
    assert.equal(result?.decision.router, 'kev-latest');
    assert.equal(m.requests[0].body.model, 'kev-latest');
    assert.deepEqual(Object.keys(m.requests[0].body.questions), ['lane', 'risk']);
  } finally { hooks.deregister(); await m.close(); }
});

test('legacy adapter contract independently refuses private/unknown input before HTTP', async () => {
  const m = await mock();
  try {
    const router = await createAdapterRegistry().router('legacy-kev', { url: m.url });
    for (const privacy of ['private', 'unknown'] as const) await assert.rejects(router.classify({ text: 'PRIVATE-CANARY', privacy }, SIGNAL), coded('private_input'));
    assert.equal(m.requests.length, 0);
    await router.classify({ text: 'rename ' + 'x'.repeat(5000), privacy: 'public' }, SIGNAL);
    assert.equal(m.requests[0].body.state.request.length, 4000);
  } finally { await m.close(); }
});

test('legacy wire contract rejects invalid outcomes and discards response echoes', async () => {
  const m = await mock({ '/v1/systemone': () => ({ json: { model: 'PRIVATE-ECHO', latency_ms: 12, prompt: 'PRIVATE-ECHO', answers: {
    lane: { choice: 'invalid', confidence: 0.9 }, risk: { choice: 'low', confidence: 0.3 },
  } } }) });
  try {
    const router = await createAdapterRegistry().router('legacy-kev', { url: m.url });
    await assert.rejects(router.classify({ text: 'public fixture', privacy: 'public' }, SIGNAL), (error) => coded('invalid')(error) && !JSON.stringify(error).includes('PRIVATE-ECHO'));
  } finally { await m.close(); }
});

routerContract('legacy Kev', async () => {
  const m = await mock();
  return { router: await createAdapterRegistry().router('legacy-kev', { url: m.url }), calls: () => m.requests.length, close: m.close };
});
