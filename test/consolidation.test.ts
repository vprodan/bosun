import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { SqliteDatabase } from '../src/platform/sqlite.ts';
import { sandbox, fresh, gitRepo, mock } from './helpers.ts';
import { extractConsolidation } from '../src/core/use-cases/extract-consolidation.ts';
import type { ConsolidationWindow } from '../src/core/domain/consolidation.ts';
import type { ModelProvider, GenRequest } from '../src/core/ports/model.ts';
import { BosunError } from '../src/core/errors.ts';
import { contentHash } from '../src/platform/content-hash.ts';
import { setupRuntime } from '../src/app/setup.ts';
import { openDaemonJobs } from '../src/app/jobs.ts';
import { openDaemonMemory } from '../src/app/memory.ts';
import { runtimePaths } from '../src/platform/paths.ts';
import { defaultConfig } from '../src/core/domain/config.ts';
import { modelProviders } from '../src/app/model-providers.ts';
import { createConsolidationService, CONSOLIDATION_RUNNER } from '../src/app/consolidation.ts';
import { createConsolidationScheduler } from '../src/app/consolidation-scheduler.ts';
import { project } from '../src/platform/project.ts';
import { localOllamaSelection } from '../src/adapters/models/own-inference-policy.ts';
import type { ConsolidationRequest } from '../src/core/domain/consolidation.ts';

const MODEL = 'selected:model:tag'; const signal = new AbortController().signal;
const window = (): ConsolidationWindow => ({ cursor: 0, through: 1, outstanding: 0, state: 'ready', parents: [], sources: [
  { privacy: 'public', id: 'm_one', version: 1, hash: contentHash('Project package manager', 'The project uses pnpm.'), title: 'Project package manager', text: 'The project uses pnpm.' },
] });
const fact = (id = 'm_one', quote = 'uses pnpm') => ({ kind: 'fact', title: 'Package manager preference', text: 'Use pnpm for this project.', citations: [{ evidenceId: id, quote }], parents: [], entity: null, relation: null });
function provider(calls: GenRequest[], output: unknown = { items: [fact()] }): ModelProvider {
  return { id: 'selected-provider', caps: { structured: 'verified', local: 'unverified', toolFree: 'verified', numCtx: 'verified' }, health: async () => true,
    async generate(request) { calls.push(request); return { model: MODEL, text: JSON.stringify(output), tokensIn: 20, tokensOut: 10 }; } };
}
const options = (value: ModelProvider) => ({ provider: value, providerId: 'selected-provider', model: MODEL, transport: 'ollama' as const, maxInputBytes: 24576, maxProposals: 4, signal });
const error = (code: string) => (value: unknown) => value instanceof BosunError && value.code === code;

test('consolidation source classification, full credential screening and native-plan policy precede provider access', async () => {
  let reads = 0; const unread = { get caps(): never { reads++; throw Error('PROVIDER_CANARY'); } } as unknown as ModelProvider;
  for (const privacy of ['private', 'unknown', undefined]) await assert.rejects(extractConsolidation({ privacy, get window(): never { reads++; throw Error('PRIVATE_WINDOW'); } } as never, options(unread)), error('private_input'));
  const denied = { privacy: 'private', get id(): never { reads++; throw Error('PRIVATE_BODY'); }, get text(): never { reads++; throw Error('PRIVATE_BODY'); } };
  await assert.rejects(extractConsolidation({ privacy: 'public', window: { ...window(), sources: [denied] } } as never, options(unread)), error('private_input'));
  const late = window(); late.sources[0].text += ' api_key=' + 'z'.repeat(40);
  await assert.rejects(extractConsolidation({ privacy: 'public', window: late }, options(unread)), error('private_input'));
  await assert.rejects(extractConsolidation({ privacy: 'public', window: window() }, { ...options(unread), transport: 'codex-cli' }), error('unsupported'));
  assert.equal(reads, 0);
});

test('one bounded generation produces source-version/hash citations and exact selected-model provenance, without accepted fact mutation', async () => {
  const calls: GenRequest[] = []; const original = window(); const before = JSON.stringify(original);
  const result = await extractConsolidation({ privacy: 'public', window: original }, options(provider(calls)));
  assert.equal(calls.length, 1); assert.equal(calls[0].model, MODEL); assert.equal(calls[0].task, 'memory-consolidation'); assert.equal(result.tokensIn, 20);
  assert.equal(result.proposals[0].kind, 'fact'); assert.deepEqual(result.proposals[0].input.supports, [{ memoryId: 'm_one', version: 1, hash: original.sources[0].hash }]);
  assert.deepEqual(result.proposals[0].citations[0], { ...result.proposals[0].input.supports[0], start: 12, end: 21 });
  assert.equal(result.proposals[0].input.producer!.model, MODEL); assert.equal(result.proposals[0].input.producer!.kind, 'model'); assert.equal(JSON.stringify(original), before);
  assert.ok(Buffer.byteLength(calls[0].messages.map((m) => m.content).join('')) <= 24576);
  const empty = await extractConsolidation({ privacy: 'public', window: window() }, options(provider([], { items: [] }))); assert.deepEqual(empty.proposals, []);
});

test('invented quote/reference/parent/authority, extra fields, model substitution and malformed output remain unknown with no retry', async () => {
  const outputs = [ { items: [fact('foreign')] }, { items: [fact('m_one', 'Invented source assertion')] }, { items: [{ ...fact(), parents: ['private_parent'] }] },
    { items: [{ ...fact(), permission: 'allow' }] }, { items: [{ ...fact(), kind: 'merge' }] }, { items: [{ ...fact(), entity: { type: 'concept', key: 'unexpected', aliases: [] } }] },
    { items: [fact(), fact(), fact(), fact(), fact()] }, { items: [{ ...fact(), text: 'api_key=' + 'x'.repeat(40) }] }, { items: [fact()], tools: [] } ];
  for (const output of outputs) {
    const calls: GenRequest[] = []; await assert.rejects(extractConsolidation({ privacy: 'public', window: window() }, options(provider(calls, output))), (value: unknown) => value instanceof BosunError && ['unavailable', 'private_input'].includes(value.code)); assert.equal(calls.length, 1);
  }
  const calls: GenRequest[] = []; const selected = provider(calls); const generate = selected.generate.bind(selected); selected.generate = async (request) => ({ ...await generate(request), model: 'hidden-substitute' });
  await assert.rejects(extractConsolidation({ privacy: 'public', window: window() }, options(selected)), error('unavailable')); assert.equal(calls.length, 1);
});

test('reviewed merge/duplicate suggestions cite two sources and preserve both source versions rather than modifying originals', async () => {
  const sources = window(); sources.sources.push({ ...sources.sources[0], id: 'm_two', version: 2 }); const before = JSON.stringify(sources);
  for (const kind of ['merge', 'duplicate']) {
    const calls: GenRequest[] = []; const output = { items: [{ ...fact(), kind, citations: [{ evidenceId: 'm_one', quote: 'uses pnpm' }, { evidenceId: 'm_two', quote: 'uses pnpm' }] }] };
    const result = await extractConsolidation({ privacy: 'public', window: sources }, options(provider(calls, output)));
    assert.equal(result.proposals[0].kind, kind); assert.equal(result.proposals[0].input.kind, 'fact'); assert.equal(result.proposals[0].input.supports[1].version, 2); assert.equal(JSON.stringify(sources), before);
  }
});

test('late cancellation discards provider output and missing native usage stays unknown', async () => {
  const calls: GenRequest[] = []; const selected = provider(calls); const controller = new AbortController(); const generate = selected.generate.bind(selected);
  selected.generate = async (request) => { const result = await generate(request); controller.abort(); return result; };
  await assert.rejects(extractConsolidation({ privacy: 'public', window: window() }, { ...options(selected), signal: controller.signal }), error('cancelled')); assert.equal(calls.length, 1);
  const missing = provider([]); missing.generate = async () => ({ model: MODEL, text: JSON.stringify({ items: [fact()] }) });
  const result = await extractConsolidation({ privacy: 'public', window: window() }, options(missing)); assert.equal(result.tokensIn, undefined); assert.equal(result.tokensOut, undefined);
});

async function fixture(mode: 'valid' | 'invented' | 'slow' | 'empty' = 'valid') {
  const server = await mock({ '/api/tags': () => ({ json: { models: [{ name: MODEL, model: MODEL }] } }), '/api/show': () => ({ json: { capabilities: ['completion'] } }),
    '/api/chat': (body) => {
      const payload = JSON.parse(body.messages[1].content); const source = payload.evidence[0]; const item = fact(source.id, mode === 'invented' ? 'Invented assertion' : source.text.slice(0, 100));
      return { ...(mode === 'slow' ? { delayMs: 300 } : {}), json: { model: MODEL, done: true, done_reason: 'stop', prompt_eval_count: 30, eval_count: 10,
        message: { role: 'assistant', content: JSON.stringify({ items: mode === 'empty' ? [] : [item] }) } } };
    } });
  const sb = sandbox(); fresh(sb); const workspace = gitRepo(sb, 'workspace'); const env = sb.env(); const paths = runtimePaths(env); const config = defaultConfig();
  config.graph.extraction = true; config.providers.default = { kind: 'ollama', model: MODEL, url: server.url, timeoutMs: 1000 };
  await setupRuntime(paths, config); let service: ReturnType<typeof createConsolidationService>;
  const jobs = openDaemonJobs({ stateFile: paths.state, ownerFile: paths.owner, runners: { [CONSOLIDATION_RUNNER]: () => service.runner() }, internalRunnerIds: [CONSOLIDATION_RUNNER] }); jobs.recover();
  const clock = { value: Date.now() }; let ids = 0; const context = { now: () => clock.value, monotonic: () => 1, hash: contentHash, dateLabel: (at: number) => new Date(at).toISOString().slice(0, 10), measure() {} };
  const options = { paths: { primary: paths.memory, view: paths.view, backups: paths.backups }, assertOwner: jobs.assertOwner,
    memory: { ...context, retention: { sessionTtlDays: 1, purgeAfterDays: 1 }, id: (at: number) => `m_${at.toString(32).padStart(9, '0')}${(++ids).toString(16).padStart(8, '0')}` },
    context, docsIndex: { monotonic: () => 1, measure() {} }, publicationId: crypto.randomUUID };
  const runtime = openDaemonMemory(options); const scope = { projectId: project(workspace).id, audience: 'owner' as const }; const ctx = { ...scope, sessionId: null, linked: [] };
  service = createConsolidationService({ config, providers: modelProviders(config, env), storage: runtime.graph.consolidation(), jobs, schedule() {}, publish: async () => { await runtime.publish(); } });
  const observer = new SqliteDatabase(paths.memory, { readOnly: true });
  return { server, sb, env, paths, workspace, config, jobs, runtime, service, observer, scope, ctx, clock, options,
    useService(value: ReturnType<typeof createConsolidationService>) { service = value; },
    async store(title = 'Owned fact', body = 'The project uses pnpm.', extra: Record<string, any> = {}) { return (await runtime.memory.store({ category: 'project', title, body, ...extra }, ctx)).memory; },
    async close() { await jobs.drain(); await runtime.close(); observer.close(); await jobs.close(); await server.close(); sb.cleanup(); } };
}

test('real queued consolidation persists only references, publishes before generation, and atomically stores proposals/cursor without changing L1 facts', async () => {
  const f = await fixture();
  try {
    const memory = await f.store(); const before = await f.runtime.memory.get(memory.id, f.ctx, { events: true });
    const submitted = await f.service.submit({ requestId: 'first' }, f.scope, f.workspace, null); assert.equal(submitted.state, 'queued'); if (!('job' in submitted)) throw Error('job missing');
    assert.equal(f.observer.prepare('SELECT COUNT(*) AS n FROM graph_consolidation_cursors').get()!.n, 0);
    const state = new SqliteDatabase(f.paths.state, { readOnly: true }); try { const stored = String(state.prepare('SELECT payload FROM jobs WHERE id=?').get(submitted.job.id)!.payload);
      assert.ok(stored.includes(memory.id)); assert.ok(!stored.includes(memory.body)); assert.ok(!stored.includes(memory.title)); } finally { state.close(); }
    await f.jobs.runQueued(); const terminal = f.jobs.get(f.scope, submitted.job.id); assert.equal(terminal.state, 'succeeded');
    const result = JSON.parse(f.jobs.result(f.scope, submitted.job.id)!); assert.equal(result.ids.length, 1); assert.equal(result.processed, 1);
    assert.deepEqual(await f.runtime.memory.get(memory.id, f.ctx, { events: true }), before); assert.equal(f.runtime.graph.get(result.ids[0], f.ctx).status, 'proposed');
    assert.deepEqual(f.runtime.graph.query({ text: 'package manager' }, { ...f.ctx, audience: 'model' }).items, []); assert.equal(f.service.proposals(f.scope, null)[0].kind, 'fact');
    assert.equal(f.service.status(f.scope, null).claim, null); assert.equal(f.service.status(f.scope, null).cursor, result.cursor);
    assert.deepEqual(f.server.requests.map((r) => r.path), ['/api/tags', '/api/show', '/api/chat']); assert.equal(f.server.requests[2].body.model, MODEL);
    const publicView = new SqliteDatabase(f.paths.view, { readOnly: true }); try { assert.equal(publicView.prepare('SELECT state FROM bosun_public_state').get()!.state, 'READY'); } finally { publicView.close(); }
    const duplicate = await f.service.submit({ requestId: 'next_empty' }, f.scope, f.workspace, null); assert.equal(duplicate.state, 'idle'); assert.equal(f.server.requests.length, 3);
    await f.store('New source', 'New public knowledge'); const repeated = await f.service.submit({ requestId: 'first' }, f.scope, f.workspace, null);
    assert.equal(repeated.state, 'duplicate'); if ('job' in repeated) { assert.equal(repeated.job.id, submitted.job.id); assert.equal(repeated.job.state, 'succeeded'); } assert.equal(f.server.requests.length, 3);
    const usage = f.jobs.usage.list(f.scope).find((u) => u.jobId === submitted.job.id)!; assert.equal(usage.tokensIn, 30); assert.equal(usage.tokensOut, 10); assert.equal(usage.model, MODEL);
  } finally { await f.close(); }
});

test('cursor progress is oldest-first/bounded, skips denied payloads, and processed versions do not starve newer public facts', async () => {
  const f = await fixture('empty');
  try {
    const denied = await f.store('Denied payload', 'PRIVATE_CURATED_CANARY', { private: true }); const first = await f.store('First old fact', 'Old first public fact'); const next = await f.store('Second old fact', 'Old second public fact');
    const newer = await f.store('Newer fact', 'Newer public fact'); const storage = f.runtime.graph.consolidation(); const window = storage.window(f.ctx, { maxSources: 1, maxInputBytes: 24576, maxOutstanding: 20 });
    assert.equal(window.sources.length, 1); assert.equal(window.sources[0].id, first.id); assert.equal(JSON.stringify(window).includes(denied.body), false);
    const request: ConsolidationRequest = { requestId: 'first_chunk', projectId: f.scope.projectId, sessionId: null, cursor: window.cursor, through: window.through, sources: [{ memoryId: first.id, version: first.version, hash: first.hash }], providerId: 'default', model: MODEL };
    const claimed = storage.claim(f.ctx, request); storage.commit(f.ctx, claimed.claim, [], 20);
    const second = storage.window(f.ctx, { maxSources: 1, maxInputBytes: 24576, maxOutstanding: 20 }); assert.equal(second.sources[0].id, next.id);
    const secondClaim = storage.claim(f.ctx, { ...request, requestId: 'second_chunk', cursor: second.cursor, through: second.through, sources: [{ memoryId: next.id, version: next.version, hash: next.hash }] }); storage.commit(f.ctx, secondClaim.claim, [], 20);
    assert.equal(storage.window(f.ctx, { maxSources: 1, maxInputBytes: 24576, maxOutstanding: 20 }).sources[0].id, newer.id);
    const altered = await f.runtime.memory.update(first.id, { body: 'Changed first public fact' }, 1, f.ctx);
    const updated = storage.window(f.ctx, { maxSources: 8, maxInputBytes: 24576, maxOutstanding: 20 }); assert.ok(updated.sources.some((s) => s.id === first.id && s.version === altered.version)); assert.ok(!updated.sources.some((s) => s.id === next.id));
  } finally { await f.close(); }
});

test('atomic output/backpressure races roll back all proposals and cursor progress, retaining the exact owner-visible reservation', async () => {
  const f = await fixture();
  try {
    const m = await f.store(); const storage = f.runtime.graph.consolidation(); const window = storage.window(f.ctx, { maxSources: 8, maxInputBytes: 24576, maxOutstanding: 20 });
    const request: ConsolidationRequest = { requestId: 'atomic_claim', projectId: f.scope.projectId, sessionId: null, cursor: window.cursor, through: window.through, sources: [{ memoryId: m.id, version: m.version, hash: m.hash }], providerId: 'default', model: MODEL };
    const claimed = storage.claim(f.ctx, request); const output = await extractConsolidation({ privacy: 'public', window: claimed.window }, { ...options(provider([], { items: [fact(m.id, 'uses pnpm')] })), providerId: 'default' });
    const wrong = { ...output.proposals[0], input: { ...output.proposals[0].input, producer: { ...output.proposals[0].input.producer!, model: 'changed:model' } } };
    assert.throws(() => storage.commit(f.ctx, claimed.claim, [output.proposals[0], wrong], 20)); assert.equal(f.observer.prepare('SELECT COUNT(*) AS n FROM graph_consolidation_proposals').get()!.n, 0); assert.equal(storage.status(f.ctx).cursor, 0);
    for (let i = 0; i < 20; i++) f.runtime.graph.create({ kind: 'fact', title: `Other pending ${i}`, text: 'Owner pending fact', supports: request.sources }, f.ctx);
    assert.throws(() => storage.commit(f.ctx, claimed.claim, output.proposals, 20)); assert.equal(f.observer.prepare('SELECT COUNT(*) AS n FROM graph_consolidation_proposals').get()!.n, 0); assert.equal(storage.status(f.ctx).claim!.id, 'atomic_claim');
  } finally { await f.close(); }
});

test('lost native COMMIT preserves one batch/cursor with unknown receipt; restart never replays the reserved source window', async () => {
  const f = await fixture(); const exec = SqliteDatabase.prototype.exec;
  try {
    const m = await f.store(); const storage = f.runtime.graph.consolidation(); const window = storage.window(f.ctx, { maxSources: 8, maxInputBytes: 24576, maxOutstanding: 20 });
    const request: ConsolidationRequest = { requestId: 'lost_receipt', projectId: f.scope.projectId, sessionId: null, cursor: window.cursor, through: window.through, sources: [{ memoryId: m.id, version: m.version, hash: m.hash }], providerId: 'default', model: MODEL };
    const claimed = storage.claim(f.ctx, request); const output = await extractConsolidation({ privacy: 'public', window: claimed.window }, { ...options(provider([], { items: [fact(m.id, 'uses pnpm')] })), providerId: 'default' });
    SqliteDatabase.prototype.exec = function (sql) { const result = exec.call(this, sql); if (sql === 'COMMIT' && this.location() === f.paths.memory) throw Error('lost consolidation receipt'); return result; };
    assert.throws(() => storage.commit(f.ctx, claimed.claim, output.proposals, 20), (e: unknown) => e instanceof BosunError && e.details?.outcome === 'unknown'); SqliteDatabase.prototype.exec = exec;
    assert.equal(f.observer.prepare('SELECT COUNT(*) AS n FROM graph_consolidation_proposals').get()!.n, 1); assert.equal(f.observer.prepare('SELECT cursor FROM graph_consolidation_cursors').get()!.cursor, window.through);
    await f.runtime.close(); const restarted = openDaemonMemory(f.options);
    try { const current = restarted.graph.consolidation().window(f.ctx, { maxSources: 8, maxInputBytes: 24576, maxOutstanding: 20 }); assert.equal(current.sources.length, 0); assert.equal(current.cursor, window.through); }
    finally { await restarted.close(); }
  } finally { SqliteDatabase.prototype.exec = exec; await f.close(); }
});

test('retained source reservations survive a fresh memory runtime; explicit abandon skips unknown work without modifying accepted facts', async () => {
  const f = await fixture('invented');
  try { const m = await f.store(); const submitted = await f.service.submit({ requestId: 'held_restart' }, f.scope, f.workspace, null); if (!('job' in submitted)) throw Error('job missing'); await f.jobs.runQueued();
    const before = await f.runtime.memory.get(m.id, f.ctx); await f.runtime.close(); const restarted = openDaemonMemory(f.options);
    try { const storage = restarted.graph.consolidation(); const current = storage.status(f.ctx); assert.ok(current.claim); const claim = current.claim; assert.equal(storage.window(f.ctx, { maxSources: 8, maxInputBytes: 24576, maxOutstanding: 20 }).state, 'held');
      assert.throws(() => storage.abandon(f.ctx, claim.id, claim.version + 1)); storage.abandon(f.ctx, claim.id, claim.version); assert.equal(storage.status(f.ctx).claim, null);
      assert.deepEqual(await restarted.memory.get(m.id, f.ctx), before); assert.equal(storage.window(f.ctx, { maxSources: 8, maxInputBytes: 24576, maxOutstanding: 20 }).sources.length, 0); }
    finally { await restarted.close(); }
  } finally { await f.close(); }
});

test('source privacy changes during HTTP invalidate the entire batch atomically and retain a sticky reservation without replay', async () => {
  const f = await fixture('slow');
  try {
    const memory = await f.store(); const submitted = await f.service.submit({ requestId: 'stale' }, f.scope, f.workspace, null); if (!('job' in submitted) || !submitted.job) throw Error('job missing');
    const running = f.jobs.runQueued(); for (let n = 0; n < 100 && !f.server.requests.some((r) => r.path === '/api/chat'); n++) await new Promise((resolve) => setTimeout(resolve, 5));
    await f.runtime.memory.update(memory.id, { private: true }, 1, f.ctx); await running; assert.equal(f.jobs.get(f.scope, submitted.job.id).state, 'unknown');
    assert.equal(f.observer.prepare('SELECT COUNT(*) AS n FROM graph_consolidation_proposals').get()!.n, 0); const status = f.service.status(f.scope, null); assert.ok(status.claim); assert.equal(status.cursor, 0);
    assert.equal((await f.service.submit({ requestId: 'do_not_replay' }, f.scope, f.workspace, null)).state, 'held'); assert.equal(f.server.requests.filter((r) => r.path === '/api/chat').length, 1);
    assert.equal((await f.runtime.memory.get(memory.id, f.ctx)).private, true);
    await f.service.abandon(f.scope, null, status.claim.id, status.claim.version); assert.equal(f.service.status(f.scope, null).claim, null);
  } finally { await f.close(); }
});

test('invented output retains reservations, default20 backlog prevents generation, and empty output advances known completed sources', async () => {
  for (const mode of ['invented', 'empty'] as const) {
    const f = await fixture(mode);
    try { await f.store(); const submitted = await f.service.submit({ requestId: mode }, f.scope, f.workspace, null); if (!('job' in submitted) || !submitted.job) throw Error('job missing'); await f.jobs.runQueued();
      assert.equal(f.jobs.get(f.scope, submitted.job.id).state, mode === 'empty' ? 'succeeded' : 'unknown'); const status = f.service.status(f.scope, null);
      assert.equal(!!status.claim, mode !== 'empty'); assert.equal(f.observer.prepare('SELECT COUNT(*) AS n FROM graph_consolidation_proposals').get()!.n, 0); }
    finally { await f.close(); }
  }
  const f = await fixture();
  try {
    const m = await f.store(); for (let i = 0; i < 20; i++) f.runtime.graph.create({ kind: 'fact', title: `Pending ${i}`, text: `Pending review ${i}`, supports: [{ memoryId: m.id, version: m.version, hash: m.hash }] }, f.ctx);
    const held = await f.service.submit({ requestId: 'backpressure' }, f.scope, f.workspace, null); assert.equal(held.state, 'held'); if ('reason' in held) assert.equal(held.reason, 'proposal_backpressure'); assert.equal(f.server.requests.length, 0);
    assert.equal(f.jobs.list(f.scope).length, 0);
  } finally { await f.close(); }
});

test('native HTTP cancellation is unknown with a retained source reservation and no late publication or automatic retry', async () => {
  const f = await fixture('slow');
  try { await f.store(); const submitted = await f.service.submit({ requestId: 'cancel' }, f.scope, f.workspace, null); if (!('job' in submitted) || !submitted.job) throw Error('job missing');
    const running = f.jobs.runQueued(); for (let n = 0; n < 100 && !f.server.requests.some((r) => r.path === '/api/chat'); n++) await new Promise((resolve) => setTimeout(resolve, 5));
    await f.jobs.cancel(f.scope, submitted.job.id); await running; assert.equal(f.jobs.get(f.scope, submitted.job.id).state, 'unknown'); assert.ok(f.service.status(f.scope, null).claim);
    assert.equal(f.observer.prepare('SELECT COUNT(*) AS n FROM graph_consolidation_proposals').get()!.n, 0); assert.equal((await f.service.submit({ requestId: 'no_retry' }, f.scope, f.workspace, null)).state, 'held');
    assert.equal(f.server.requests.filter((r) => r.path === '/api/chat').length, 1);
  } finally { await f.close(); }
});

test('local model metadata rejects cloud aliases and disabled scheduling enqueues nothing; idle checks and close wait for the pending enqueue callback', async () => {
  const m = await mock({ '/api/tags': () => ({ json: { models: [{ name: MODEL, model: MODEL, remote_host: 'https://PRIVATE_REMOTE' }] } }) });
  try { assert.equal(await localOllamaSelection({ url: m.url, model: MODEL, timeoutMs: 1000 }, signal), false); assert.deepEqual(m.requests.map((r) => r.path), ['/api/tags']); } finally { await m.close(); }
  let calls = 0; const disabled = createConsolidationScheduler({ enabled: false, intervalMs: 60000, idle: () => true, poll: async () => { calls++; } }); await disabled.tick(); await disabled.close(); assert.equal(calls, 0);
  let idle = false; let finish!: () => void; const scheduler = createConsolidationScheduler({ enabled: true, intervalMs: 60000, idle: () => idle, poll: async () => { calls++; await new Promise<void>((resolve) => finish = resolve); } });
  await scheduler.tick(); assert.equal(calls, 0); idle = true; const running = scheduler.tick(); await new Promise((resolve) => setImmediate(resolve)); assert.equal(calls, 1);
  let closed = false; const closing = scheduler.close().then(() => closed = true); await new Promise((resolve) => setImmediate(resolve)); assert.equal(closed, false); finish(); await running; await closing; assert.equal(closed, true);
});

test('configured native-plan providers are refused; compatible API needs explicit opt-in and independent positive admission', async () => {
  const f = await fixture();
  try {
    await f.store(); f.config.providers.default.kind = 'codex-cli'; await assert.rejects(f.service.submit({ requestId: 'native_plan' }, f.scope, f.workspace, null), error('unsupported'));
    f.config.providers.default.kind = 'openai-compatible'; await assert.rejects(f.service.submit({ requestId: 'default_api' }, f.scope, f.workspace, null), error('unsupported'));
    const calls: GenRequest[] = []; const api = provider(calls); api.generate = async (request) => { calls.push(request); const src = JSON.parse(request.messages[1].content).evidence[0]; return { model: MODEL, text: JSON.stringify({ items: [fact(src.id, src.text.slice(0, 100))] }) }; };
    const service = createConsolidationService({ config: f.config, providers: { default: api }, storage: f.runtime.graph.consolidation(), jobs: f.jobs, schedule() {}, publish: async () => { await f.runtime.publish(); }, policy: { allowRemoteApi: true } });
    const held = await service.submit({ requestId: 'unknown_api_quota' }, f.scope, f.workspace, null); assert.equal(held.state, 'held'); if ('reason' in held) assert.equal(held.reason, 'admission_unavailable');
    assert.equal(f.jobs.list(f.scope).length, 0); assert.equal(calls.length, 0); assert.equal(f.server.requests.length, 0);
    let admissions = 0; const approved = createConsolidationService({ config: f.config, providers: { default: api }, storage: f.runtime.graph.consolidation(), jobs: f.jobs, schedule() {},
      publish: async () => { await f.runtime.publish(); }, policy: { allowRemoteApi: true }, admit: async () => { admissions++; return { allowed: true }; } });
    const queued = await approved.submit({ requestId: 'positive_api_quota' }, f.scope, f.workspace, null); assert.equal(queued.state, 'queued'); assert.equal(admissions, 1); assert.equal(calls.length, 0);
    if (!('job' in queued)) throw Error('job missing'); f.useService(approved); await f.jobs.runQueued(); assert.equal(f.jobs.get(f.scope, queued.job.id).state, 'succeeded'); assert.equal(calls.length, 1); assert.equal(admissions, 2);
  } finally { await f.close(); }
});

test('source changes between publication and provider dispatch are rechecked without sending any model payload', async () => {
  const f = await fixture();
  try { const m = await f.store(); const service = createConsolidationService({ config: f.config, providers: modelProviders(f.config, f.env), storage: f.runtime.graph.consolidation(), jobs: f.jobs, schedule() {},
      publish: async () => { await f.runtime.publish(); await f.runtime.memory.update(m.id, { private: true }, 1, f.ctx); } });
    const storage = f.runtime.graph.consolidation(); const window = storage.window(f.ctx, { maxSources: 8, maxInputBytes: 24576, maxOutstanding: 20 });
    const request: ConsolidationRequest = { requestId: 'before_dispatch', projectId: f.scope.projectId, sessionId: null, cursor: window.cursor, through: window.through, sources: [{ memoryId: m.id, version: m.version, hash: m.hash }], providerId: 'default', model: MODEL };
    const runner = service.runner(); await assert.rejects(async () => { for await (const _event of runner.run({ privacy: 'public', prompt: JSON.stringify(request), cwd: f.workspace, model: MODEL, access: 'read', signal })) {} });
    assert.equal(f.server.requests.some((r) => r.path === '/api/chat'), false); assert.equal(storage.status(f.ctx).cursor, 0); assert.ok(storage.status(f.ctx).claim); assert.equal(f.observer.prepare('SELECT COUNT(*) AS n FROM graph_consolidation_proposals').get()!.n, 0);
  } finally { await f.close(); }
});
