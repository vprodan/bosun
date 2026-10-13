import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { mock, REPO } from './helpers.ts';
import { createClefReadiness } from '../src/adapters/routers/ollama-clef-status.ts';
import { createRouteService } from '../src/app/route.ts';
import { defaultConfig } from '../src/core/domain/config.ts';
import { BosunError } from '../src/core/errors.ts';
import { planRouterMigration, type RouterMigrationInput } from '../src/core/router-migration.ts';

const SIGNAL = new AbortController().signal; const NOW = 1800000000000; const DIGEST = 'a'.repeat(64); const CHILD = 'b'.repeat(64);
function metadata({ version = '0.35.1', loaded = true, multi = false } = {}) {
  const tag: Record<string, any> = { name: 'clef-flash:9b', model: 'clef-flash:9b', digest: DIGEST, size: 11000000000 };
  const show: Record<string, any> = { capabilities: ['decision', 'vision'], details: { format: multi ? 'safetensors' : 'gguf' }, model_info: { 'general.architecture': 'qwen35', 'qwen35.context_length': 65536 } };
  if (multi) show.manifests = [{ digest: `sha256:${CHILD}`, runner: 'mlx', format: 'safetensors', selected: true }, { digest: 'c'.repeat(64), runner: 'ggml', format: 'gguf', selected: false }];
  const running: Record<string, any> = { name: tag.name, model: tag.model, digest: multi ? CHILD : DIGEST, size: tag.size, size_vram: 9000000000,
    expires_at: '2099-01-01T00:00:00Z', context_length: 32768, ...(multi ? { runner: 'mlx' } : {}) };
  return { version: { version }, tags: { models: [tag] }, show, ps: { models: loaded ? [running] : [] } };
}
async function native(value = metadata(), decision?: () => Record<string, any>) {
  return mock({ '/api/version': () => ({ json: value.version }), '/api/tags': () => ({ json: value.tags }), '/api/show': () => ({ json: value.show }), '/api/ps': () => ({ json: value.ps }),
    '/v1/systemone': () => ({ json: decision ? decision() : JSON.parse(fs.readFileSync(path.join(REPO, 'test/fixtures/clef-systemone.json'), 'utf8')) }) });
}
const noLeaks = (value: unknown) => assert.doesNotMatch(JSON.stringify(value), /PRIVATE_|private-canary|api_key|template-secret/);

test('readiness construction is inert and probes only metadata, projecting no other models/templates/messages/auth', async () => {
  let reads = 0; createClefReadiness({ get url(): string { reads++; throw Error('PRIVATE_CONFIG'); } }); assert.equal(reads, 0);
  const data = metadata(); data.show.template = 'template-secret'; data.show.system = 'PRIVATE_SYSTEM'; data.show.messages = [{ content: 'PRIVATE_HISTORY' }];
  data.tags.models.push({ name: 'PRIVATE_OTHER_MODEL', model: 'PRIVATE_OTHER_MODEL', digest: DIGEST }); data.ps.models.push({ name: 'PRIVATE_LOADED_MODEL' });
  const m = await native(data);
  try {
    const probe = createClefReadiness({ url: m.url }, { now: () => NOW }); assert.equal(m.requests.length, 0);
    const result = await probe.status(SIGNAL); assert.equal(result.state, 'ready'); assert.equal(result.version, '0.35.1'); assert.equal(result.digest, DIGEST);
    assert.equal(result.model, 'clef-flash:9b'); assert.equal(result.catalogContextTokens, 65536); assert.equal(result.loaded.contextTokens, 32768);
    assert.equal(result.loaded.vramBytes, 9000000000); assert.equal(result.automaticDispatch, false); assert.equal(result.qualification.calibration, 'unverified'); noLeaks(result);
    assert.deepEqual(m.requests.map((r) => r.path), ['/api/version', '/api/tags', '/api/show', '/api/ps']); assert.deepEqual(m.requests[2].body, { model: 'clef-flash:9b', verbose: false });
    assert.ok(m.requests.every((r) => !r.headers.authorization));
  } finally { await m.close(); }
});

test('missing model, old/unknown/prerelease versions, absent capability and cloud/unsupported weights are finite held states without start/pull/inference', async () => {
  const arms: [string, (v: ReturnType<typeof metadata>) => void][] = [
    ['unsupported_version', (v) => v.version.version = '0.34.4'], ['version_unverified', (v) => v.version.version = '0.40.0-rc3'],
    ['version_unverified', (v) => v.version.version = '0.41.0'], ['metadata_invalid', (v) => v.version.version = 'PRIVATE_VERSION'],
    ['model_missing', (v) => v.tags.models = []], ['capability_missing', (v) => v.show.capabilities = ['completion']],
    ['unsupported_model', (v) => v.tags.models[0].remote_host = 'https://PRIVATE_CLOUD'], ['unsupported_model', (v) => v.show.remote_model = 'PRIVATE_REMOTE'],
    ['unsupported_model', (v) => v.show.details.format = 'safetensors'], ['metadata_invalid', (v) => v.tags.models[0].digest = 'PRIVATE_DIGEST'],
    ['metadata_invalid', (v) => v.tags.models.push({ ...v.tags.models[0] })], ['metadata_invalid', (v) => v.tags.models[0].name = 'different-model:9b'],
    ['unsupported_version', (v) => v.show.requires = '0.40.0'], ['metadata_invalid', (v) => v.show.requires = 'PRIVATE_REQUIRED_VERSION'],
  ];
  for (const [reason, mutate] of arms) {
    const value = metadata(); mutate(value); const m = await native(value);
    try { const result = await createClefReadiness({ url: m.url }).status(SIGNAL); assert.equal(result.reason, reason); assert.equal(result.state, 'held'); noLeaks(result); assert.ok(m.requests.every((r) => r.path.startsWith('/api/'))); }
    finally { await m.close(); }
  }
});

test('Ollama0.40 selected MLX child digest is distinct from the catalog tag; loaded runner/child must match without an invented runner override', async () => {
  const value = metadata({ version: '0.40.0', multi: true }); const m = await native(value);
  try {
    const probe = createClefReadiness({ url: m.url, digest: `sha256:${CHILD}` }); const result = await probe.status(SIGNAL);
    assert.equal(result.state, 'ready'); assert.equal(result.tagDigest, DIGEST); assert.equal(result.digest, CHILD); assert.equal(result.runner, 'mlx'); assert.equal(result.format, 'safetensors');
    assert.equal(result.expectedDigest, CHILD); assert.equal(result.loaded.digest, CHILD); assert.equal(m.requests[2].body.runner, undefined);
    value.ps.models.push({ ...value.ps.models[0], digest: 'c'.repeat(64), runner: 'ggml' }); assert.equal((await probe.status(SIGNAL)).state, 'ready');
    value.ps.models[0].digest = DIGEST; assert.equal((await probe.status(SIGNAL)).reason, 'loaded_identity_mismatch');
    value.ps.models[0].digest = CHILD; value.show.manifests[0].selected = false; assert.equal((await probe.status(SIGNAL)).reason, 'metadata_invalid');
    value.show.manifests[0].selected = true; value.ps.models[0].runner = 'ggml'; assert.equal((await probe.status(SIGNAL)).reason, 'loaded_identity_mismatch');
  } finally { await m.close(); }
});

test('readiness reports unloaded/unknown residency and never substitutes a catalog context or fabricates GPU percentages', async () => {
  const value = metadata({ loaded: false }); const m = await native(value);
  try {
    const probe = createClefReadiness({ url: m.url }); const cold = await probe.status(SIGNAL); assert.equal(cold.state, 'cold'); assert.equal(cold.loaded.contextTokens, null); assert.equal(cold.catalogContextTokens, 65536);
    value.ps = metadata().ps; value.ps.models[0].context_length = 0; assert.equal((await probe.status(SIGNAL)).reason, 'residency_unknown');
    value.ps.models[0].context_length = 32768; delete value.ps.models[0].size_vram; assert.equal((await probe.status(SIGNAL)).loaded.vramBytes, null);
    value.ps.models[0].size_vram = 0; value.ps.models[0].expires_at = '2000-01-01T00:00:00Z'; assert.equal((await probe.status(SIGNAL)).reason, 'residency_unknown');
    value.ps.models[0].expires_at = '2099-01-01T00:00:00Z'; assert.equal((await probe.status(SIGNAL)).state, 'ready');
  } finally { await m.close(); }
});

test('configured digest mismatch and hot tag/selected-child changes remain held without accepting another selection', async () => {
  const value = metadata(); const m = await native(value);
  try {
    assert.equal((await createClefReadiness({ url: m.url, digest: CHILD }).status(SIGNAL)).reason, 'digest_mismatch');
    const probe = createClefReadiness({ url: m.url }); assert.equal((await probe.status(SIGNAL)).state, 'ready');
    value.tags.models[0].digest = CHILD; value.ps.models[0].digest = CHILD; const changed = await probe.status(SIGNAL); assert.equal(changed.reason, 'digest_changed'); assert.equal(changed.expectedDigest, DIGEST);
    value.tags.models[0].digest = DIGEST; value.ps.models[0].digest = DIGEST; assert.equal((await probe.status(SIGNAL)).state, 'ready');
  } finally { await m.close(); }
});

test('native default latest/display canonicalization preserves the actual requested model and never picks a different tag', async () => {
  const value = metadata(); value.tags.models[0].name = value.tags.models[0].model = 'clef-flash:latest'; value.ps.models[0].name = value.ps.models[0].model = 'clef-flash:latest';
  const m = await native(value);
  try {
    const probe = createClefReadiness({ url: m.url, model: 'library/clef-flash' }); const result = await probe.status(SIGNAL); assert.equal(result.model, 'library/clef-flash'); assert.equal(result.resolvedModel, 'clef-flash:latest');
    assert.equal(m.requests[2].body.model, 'library/clef-flash'); value.tags.models[0].model = value.tags.models[0].name = 'clef-flash:9b'; assert.equal((await probe.status(SIGNAL)).reason, 'model_missing');
  } finally { await m.close(); }
});

test('final explicit classification validates privacy/bounds before metadata, binds before/after digest and never authorizes automatic work', async () => {
  const value = metadata(); const m = await native(value); const config = defaultConfig(); config.router.url = m.url; const service = createRouteService(config);
  try {
    for (const privacy of ['private', 'unknown']) await assert.rejects(service.classify({ privacy, get text(): string { throw Error('PRIVATE_GETTER'); } } as never, SIGNAL), (e: unknown) => e instanceof BosunError && e.code === 'private_input');
    await assert.rejects(service.classify({ text: 'api_key=' + 'z'.repeat(40), privacy: 'public' }, SIGNAL), (e: unknown) => e instanceof BosunError && e.code === 'private_input');
    await assert.rejects(service.classify({ text: '界'.repeat(24000), privacy: 'public' }, SIGNAL), (e: unknown) => e instanceof BosunError && e.code === 'invalid'); assert.equal(m.requests.length, 0);
    const result = await service.classify({ text: 'Implement refund handling', privacy: 'public' }, SIGNAL); assert.equal(result.route!.final, 'main'); assert.equal(result.automaticDispatch, false); assert.equal(result.qualification.calibration, 'unverified');
    assert.deepEqual(m.requests.map((r) => r.path), ['/api/version', '/api/tags', '/api/show', '/api/ps', '/v1/systemone', '/api/version', '/api/tags', '/api/show', '/api/ps']);
    assert.equal(m.requests[4].body.model, 'clef-flash:9b'); assert.equal(m.requests[4].body.keep_alive, undefined);
  } finally { await m.close(); }
});

test('cold classification may use its explicitly selected installed model, but metadata status alone never warms it', async () => {
  const value = metadata({ loaded: false }); const m = await native(value, () => { value.ps = metadata().ps; return JSON.parse(fs.readFileSync(path.join(REPO, 'test/fixtures/clef-systemone.json'), 'utf8')); });
  const config = defaultConfig(); config.router.url = m.url; const service = createRouteService(config);
  try { assert.equal((await service.status(SIGNAL)).state, 'cold'); assert.equal(m.requests.some((r) => r.path === '/v1/systemone'), false);
    const result = await service.classify({ privacy: 'public', text: 'Explicit public request' }, SIGNAL); assert.equal(result.status.state, 'ready'); assert.ok(result.route); }
  finally { await m.close(); }
});

test('metadata absence, malformed decision, loaded-context bound and post-decision digest drift conservatively return no routing advice', async () => {
  for (const arm of ['missing', 'malformed', 'context', 'drift'] as const) {
    const value = metadata(); if (arm === 'missing') value.tags.models = []; if (arm === 'context') value.ps.models[0].context_length = 1024;
    const m = await native(value, () => { if (arm === 'malformed') return { error: 'PRIVATE_UPSTREAM' }; if (arm === 'drift') { value.tags.models[0].digest = CHILD; value.ps.models[0].digest = CHILD; }
      return JSON.parse(fs.readFileSync(path.join(REPO, 'test/fixtures/clef-systemone.json'), 'utf8')); });
    const config = defaultConfig(); config.router.url = m.url;
    try { const result = await createRouteService(config).classify({ privacy: 'public', text: 'Explicit public request' }, SIGNAL); assert.equal(result.route, null); assert.equal(result.automaticDispatch, false); noLeaks(result);
      assert.equal(m.requests.filter((r) => r.path === '/v1/systemone').length, arm === 'missing' || arm === 'context' ? 0 : 1); }
    finally { await m.close(); }
  }
});

test('caller cancellation, HTTP failures and oversize/stalled bodies obey one finite metadata deadline without raw provider text', async () => {
  const m = await mock({ '/api/version': () => ({ status: 500, text: 'PRIVATE_PROVIDER_ERROR' }) });
  try { const probe = createClefReadiness({ url: m.url }); const aborted = new AbortController(); aborted.abort(); assert.equal((await probe.status(aborted.signal)).reason, 'cancelled'); assert.equal(m.requests.length, 0);
    const failed = await probe.status(SIGNAL); assert.equal(failed.reason, 'endpoint_unavailable'); noLeaks(failed); }
  finally { await m.close(); }
  for (const arm of ['oversize', 'stall'] as const) {
    const server = http.createServer((_request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.write('{'); if (arm === 'oversize') response.end(' '.repeat(512 * 1024)); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try { const result = await createClefReadiness({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, timeoutMs: 50 }).status(SIGNAL); assert.equal(result.reason, arm === 'stall' ? 'timeout' : 'metadata_invalid'); }
    finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  }
});

test('the total classification deadline includes every pre/post metadata phase and produces no late/retried advice', async () => {
  const value = metadata(); const paths: string[] = []; const timers = new Set<ReturnType<typeof setTimeout>>();
  const server = http.createServer((request, response) => {
    paths.push(request.url!); request.resume(); const timer = setTimeout(() => {
      timers.delete(timer); response.writeHead(200, { 'content-type': 'application/json' });
      const key = request.url!.split('/').at(-1)!; response.end(JSON.stringify(value[key as keyof typeof value] ?? {}));
    }, 40); timers.add(timer);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const config = defaultConfig(); config.router.url = `http://127.0.0.1:${(server.address() as { port: number }).port}`; config.router.timeoutMs = 70;
  try { const result = await createRouteService(config).classify({ privacy: 'public', text: 'Bounded public request' }, SIGNAL);
    assert.equal(result.route, null); assert.equal(result.reason, 'timeout'); assert.equal(result.status.reason, 'timeout'); assert.deepEqual(paths, ['/api/version', '/api/tags']); }
  finally { for (const timer of timers) clearTimeout(timer); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('public input is captured once before asynchronous metadata and mutable caller/config objects cannot change the admitted model or state', async () => {
  const value = metadata(); const m = await native(value); const config = defaultConfig(); config.router.url = m.url; const service = createRouteService(config);
  let reads = 0; const input = { privacy: 'public' as const, get text(): string { reads++; return reads === 1 ? 'Admitted public input' : 'api_key=' + 'q'.repeat(40); } };
  try { const result = await service.classify(input, SIGNAL); assert.ok(result.route); assert.equal(reads, 1); assert.equal(m.requests.find((r) => r.path === '/v1/systemone')!.body.state, 'Admitted public input');
    config.router.model = 'different:model'; assert.equal((await service.status(SIGNAL)).model, 'clef-flash:9b'); }
  finally { await m.close(); }
});

test('legacy Kev retirement plan binds config/service fingerprints and requires real ownership or explicit reviewed adoption', () => {
  const input: RouterMigrationInput = { configHash: DIGEST, legacy: { routerUrl: 'http://legacy-router.invalid:8009', routerPort: 8009, trainingRun: 'owner/kev-run', minConfidence: 0.5, timeoutSeconds: 1.5 },
    target: { url: 'http://selected-ollama.invalid:11434', model: 'owner/clef-flash:9b', digest: CHILD, timeoutMs: 1000, minConfidence: 0.7 },
    service: { state: 'present', label: 'com.bosun.router', file: '/synthetic-owner/Library/LaunchAgents/com.bosun.router.plist', hash: CHILD,
      argv: ['/synthetic-bin/uv', 'run', '--extra', 'serve', 'python', '-m', 'kev.serve', '--run', 'owner/kev-run', '--port', '8009'], ownership: null } };
  const untouched = JSON.stringify(input); const held = planRouterMigration(input); assert.equal(held.state, 'held'); assert.equal(held.reason, 'service_unowned'); assert.deepEqual(held.steps.map((s) => s.op), ['backup-config']); assert.equal(JSON.stringify(input), untouched);
  assert.ok(input.service.state === 'present');
  input.service = { ...input.service, reviewedAdoptionHash: CHILD }; const ready = planRouterMigration(input); assert.equal(ready.state, 'prepared'); assert.equal(ready.router.url, input.target.url); assert.equal(ready.router.model, input.target.model);
  assert.equal(ready.router.minConfidence, 0.7); assert.equal(ready.confidence.calibration, 'unverified'); assert.equal(ready.confidence.legacyThresholdCarried, false);
  assert.deepEqual(ready.steps.map((s) => s.op), ['backup-config', 'record-reviewed-service-adoption', 'backup-launchagent', 'stop-legacy-router', 'archive-launchagent', 'write-router-config']);
  assert.ok(!JSON.stringify(ready).includes('owner/kev-run')); assert.ok(!JSON.stringify(ready).includes('legacy-router.invalid')); assert.ok(!ready.steps.some((s) => /ollama|pull|python|uv|delete/.test(s.op)));
  input.service.reviewedAdoptionHash = DIGEST; assert.equal(planRouterMigration(input).reason, 'service_changed');
  input.service.ownership = { installationId: '11111111-1111-4111-8111-111111111111', installedHash: CHILD }; assert.equal(planRouterMigration(input).state, 'prepared');
  input.service.ownership.installedHash = DIGEST; assert.equal(planRouterMigration(input).reason, 'service_changed');
  input.service.ownership.installedHash = CHILD; input.service.argv[6] = 'another.service'; assert.equal(planRouterMigration(input).reason, 'service_shape_unknown');
  input.service = { state: 'absent' }; assert.deepEqual(planRouterMigration(input).steps.map((s) => s.op), ['backup-config', 'write-router-config']);
});
