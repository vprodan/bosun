import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { SqliteDatabase } from '../src/platform/sqlite.ts';
import { sandbox } from './helpers.ts';
import { openDaemonJobs } from '../src/app/jobs.ts';
import { DaemonOwner } from '../src/platform/daemon-owner.ts';
import { BosunError } from '../src/core/errors.ts';
import type { AgentRunner } from '../src/core/ports/runner.ts';
import type { JobInput } from '../src/core/domain/job.ts';
import type { BillingQualification } from '../src/core/domain/usage.ts';

const DAY = 86400000; const A = { projectId: 'p_aaaaaaaaaaaaaaaa', audience: 'owner' as const }; const B = { projectId: 'p_bbbbbbbbbbbbbbbb', audience: 'owner' as const };
const caps: AgentRunner['caps'] = { vendor: 'synthetic', readOnly: 'verified', sandbox: 'tool-allowlist', effort: 'verified', mcpInject: 'unsupported', localBackend: 'unverified', billing: 'unknown' };
const runner = (run: AgentRunner['run']): AgentRunner => ({ id: 'selected', caps, detect: async () => ({ installed: true }), run });
const input = (id: string, extra: Partial<JobInput> = {}): JobInput => ({ privacy: 'public', requestId: id, taskId: 'task_a', runnerId: 'selected', prompt: 'PROMPT_CANARY',
  cwd: '/synthetic/WORKSPACE_CANARY', access: 'read', model: 'exact-model', effort: 'high', ...extra });
const code = (expected: string) => (error: unknown) => error instanceof BosunError && error.code === expected;
const unknown = (error: unknown) => error instanceof BosunError && error.details?.outcome === 'unknown';
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function fixture(extra: Partial<Parameters<typeof openDaemonJobs>[0]> = {}) {
  const sb = sandbox(); const dir = path.join(sb.root, 'retention'); fs.mkdirSync(dir, { mode: 0o700 }); let count = 0;
  const clock = { value: 60 * DAY }; let calls = 0;
  const options = { stateFile: path.join(dir, 'state.db'), ownerFile: path.join(dir, 'owner.db'), now: () => clock.value, id: () => `job_${++count}`,
    maxQueue: 16, maxJobs: 32, maxEvents: 512, admit: async () => ({ allowed: true as const }),
    runners: { selected: () => runner(async function* () { calls++; yield { t: 'usage', tokensIn: 7, tokensOut: 3 }; yield { t: 'done', code: 0, result: 'RESULT_CANARY' }; }) }, ...extra };
  const jobs = openDaemonJobs(options); jobs.recover(); const observer = new SqliteDatabase(options.stateFile, { readOnly: true });
  return { sb, dir, clock, options, jobs, observer, calls: () => calls, async close() { observer.close(); await jobs.close(); sb.cleanup(); } };
}

test('default30-day boundary compacts only settled scoped content and preserves original receipt/version/request without payload reads or replay after reopen', async () => {
  const f = fixture(); let reopened: ReturnType<typeof openDaemonJobs> | undefined;
  try {
    const a = f.jobs.submit(input('first'), A).job; await f.jobs.runQueued(); const terminal = f.jobs.get(A, a.id); const eventCursor = f.jobs.events(A, 0, 100).cursor;
    f.clock.value += 30 * DAY - 1; assert.deepEqual(f.jobs.retention.prune(A), { jobs: 0, attempts: 0, capacityHeld: false }); assert.equal(f.jobs.result(A, a.id), 'RESULT_CANARY');
    f.clock.value++; assert.equal(f.jobs.retention.status(A).eligibleJobs, 1); assert.deepEqual(f.jobs.retention.prune(A), { jobs: 1, attempts: 1, capacityHeld: false });
    const receipt = f.jobs.get(A, a.id); assert.deepEqual(receipt, { ...terminal, retained: 'receipt' }); assert.equal(f.jobs.result(A, a.id), null);
    for (const table of ['jobs', 'job_usage', 'job_events', 'job_results']) assert.equal(f.observer.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n, 0);
    const retained = JSON.stringify(f.observer.prepare('SELECT * FROM job_receipts').all()); assert.doesNotMatch(retained, /PROMPT_CANARY|RESULT_CANARY|WORKSPACE_CANARY|payload|cwd/);
    assert.equal(f.jobs.usage.list(A).length, 0); assert.equal(f.jobs.usage.daily(A)[0].tokensIn, 7); assert.equal(f.jobs.retention.status(A).scopedReceipts, 1);
    assert.throws(() => f.jobs.get(B, a.id), code('not_found')); assert.deepEqual(f.jobs.usage.daily(B), []);
    for (const method of [() => f.jobs.retention.status({ ...A, audience: 'model' }), () => f.jobs.retention.prune({ ...A, audience: 'model' }), () => f.jobs.usage.daily({ ...A, audience: 'model' })]) assert.throws(method, code('unsupported'));
    await f.jobs.close(); reopened = openDaemonJobs(f.options); assert.equal(reopened.recover(), 0); let reads = 0;
    const duplicate = reopened.submit({ ...input('first'), get prompt(): never { reads++; throw Error('DO_NOT_READ_OLD_PROMPT'); } }, A);
    assert.equal(duplicate.duplicate, true); assert.deepEqual(duplicate.job, receipt); assert.equal(reads, 0); await reopened.runQueued(); assert.equal(f.calls(), 1);
    const next = reopened.submit(input('new'), A).job; await reopened.runQueued(); assert.equal(reopened.get(A, next.id).state, 'succeeded');
    assert.ok(reopened.events(A, eventCursor).events[0].seq > eventCursor); assert.equal(reopened.usage.daily(A)[0].attempts, 1);
  } finally { await reopened?.close(); await f.close(); }
});

test('daily aggregates keep scope/day/exact model/effort/billing vendor and observed account pools separate and expose incomplete totals honestly', async () => {
  let pool = 'a'.repeat(64); let kind: BillingQualification['kind'] = 'api'; let vendor: BillingQualification['vendor'] = 'openai';
  const f = fixture({ billing: () => ({ kind, vendor, qualification: 'verified', poolKey: pool }), runners: { selected: () => runner(async function* (spec) {
    if (spec.prompt === 'partial') yield { t: 'usage', tokensIn: 5 };
    else if (spec.prompt === 'ambiguous') { yield { t: 'usage', tokensIn: 8, tokensOut: 4 }; yield { t: 'usage', tokensIn: 8, tokensOut: 4 }; }
    else if (spec.prompt !== 'missing') yield { t: 'usage', tokensIn: 7, tokensOut: 3 };
    yield { t: 'done', code: 0, result: 'RESULT_CANARY' };
  }) } });
  try {
    for (const [id, prompt] of [['reported', 'reported'], ['partial', 'partial'], ['ambiguous', 'ambiguous'], ['missing', 'missing']]) { f.jobs.submit(input(id, { prompt }), A); await f.jobs.runQueued(); }
    pool = 'b'.repeat(64); f.jobs.submit(input('pool_b'), A); await f.jobs.runQueued();
    pool = 'a'.repeat(64); f.jobs.submit(input('foreign'), B); await f.jobs.runQueued();
    f.jobs.submit(input('other_model', { model: 'other-model' }), A); f.jobs.submit(input('other_effort', { effort: 'low' }), A); await f.jobs.runQueued();
    kind = 'subscription'; f.jobs.submit(input('subscription'), A); await f.jobs.runQueued(); kind = 'api'; vendor = 'anthropic'; f.jobs.submit(input('vendor'), A); await f.jobs.runQueued(); vendor = 'openai';
    f.clock.value += DAY; f.jobs.submit(input('day_two'), A); await f.jobs.runQueued(); f.clock.value += 30 * DAY;
    assert.equal(f.jobs.retention.prune(A).jobs, 10); const rows = f.jobs.usage.daily(A); assert.equal(rows.length, 7); assert.equal(f.jobs.usage.daily(B).length, 0);
    const mixed = rows.find(row => row.poolKey === 'a'.repeat(64) && row.model === 'exact-model' && row.effort === 'high' && row.kind === 'api' && row.vendor === 'openai' && row.day === 60 * DAY)!;
    assert.equal(mixed.attempts, 4); assert.equal(mixed.reportedAttempts, 1); assert.equal(mixed.partialAttempts, 1); assert.equal(mixed.ambiguousAttempts, 1); assert.equal(mixed.unavailableAttempts, 1);
    assert.equal(mixed.tokensIn, null); assert.equal(mixed.tokensOut, null); assert.equal(mixed.knownTokensIn, 12); assert.equal(mixed.knownTokensOut, 3); assert.equal(mixed.missingInputAttempts, 2); assert.equal(mixed.missingOutputAttempts, 3);
    assert.equal(mixed.cachedTokens, null); assert.equal(mixed.reasoningTokens, null); assert.doesNotMatch(JSON.stringify(rows), /PROMPT_CANARY|RESULT_CANARY|WORKSPACE_CANARY|currency|usd|cost/i);
    assert.equal(f.jobs.retention.prune(B).jobs, 1); assert.equal(f.jobs.usage.daily(B)[0].tokensIn, 7);
  } finally { await f.close(); }
});

test('unknown billing/account identity never merges independent attempts, while verified local totals may aggregate in the same authority', async () => {
  let verifiedLocal = false; const f = fixture({ billing: () => verifiedLocal ? { kind: 'local', vendor: 'ollama', qualification: 'verified' } : { kind: 'unknown', vendor: null, qualification: 'unverified' } });
  try {
    f.jobs.submit(input('unknown_a'), A); f.jobs.submit(input('unknown_b'), A); await f.jobs.runQueued(); verifiedLocal = true;
    f.jobs.submit(input('local_a'), A); f.jobs.submit(input('local_b'), A); await f.jobs.runQueued(); f.clock.value += 30 * DAY; f.jobs.retention.prune(A);
    const rows = f.jobs.usage.daily(A); assert.equal(rows.length, 3); assert.equal(rows.filter(row => row.kind === 'unknown').length, 2);
    assert.equal(rows.find(row => row.kind === 'local')!.attempts, 2); assert.equal(rows.find(row => row.kind === 'local')!.tokensIn, 14);
    assert.ok(rows.filter(row => row.kind === 'unknown').every(row => row.pool.startsWith('attempt:') && row.attempts === 1));
  } finally { await f.close(); }
});

test('bounded prune and permanent receipt/daily capacity hold without erasing uncertain effects, fresh jobs or replay evidence', async () => {
  const f = fixture({ maxQueue: 2, maxJobs: 2, maxReceipts: 1, maxDailyGroups: 1 });
  try {
    const a = f.jobs.submit(input('first'), A).job; const b = f.jobs.submit(input('second'), A).job; await f.jobs.runQueued();
    assert.throws(() => f.jobs.submit(input('fresh_capacity'), A), code('unavailable')); assert.equal(f.jobs.retention.status(A).pressure, true);
    f.clock.value += 30 * DAY; assert.deepEqual(f.jobs.retention.prune(A, 1), { jobs: 1, attempts: 1, capacityHeld: false });
    assert.deepEqual(f.jobs.retention.prune(A), { jobs: 0, attempts: 0, capacityHeld: true }); assert.equal(f.jobs.get(A, b.id).retained, undefined);
    const c = f.jobs.submit(input('third'), A).job; await f.jobs.runQueued(); assert.equal(f.jobs.get(A, c.id).state, 'succeeded');
    assert.throws(() => f.jobs.submit(input('fourth'), A), code('unavailable')); assert.equal(f.jobs.submit(input('first'), A).job.id, a.id);
    assert.equal(f.jobs.retention.status(A).scopedReceipts, 1); assert.equal(f.jobs.usage.daily(A).length, 1);
    assert.throws(() => f.jobs.retention.prune(A, 101), code('invalid')); assert.throws(() => f.jobs.retention.prune(A, 0), code('invalid'));
  } finally { await f.close(); }
});

test('daily group capacity blocks a different model/account atomically without deleting its original attempt or result', async () => {
  const f = fixture({ maxDailyGroups: 1 });
  try {
    const a = f.jobs.submit(input('first'), A).job; const b = f.jobs.submit(input('second', { model: 'different-model' }), A).job; await f.jobs.runQueued(); f.clock.value += 30 * DAY;
    assert.deepEqual(f.jobs.retention.prune(A), { jobs: 1, attempts: 1, capacityHeld: true }); assert.equal(f.jobs.get(A, a.id).retained, 'receipt'); assert.equal(f.jobs.get(A, b.id).retained, undefined);
    assert.equal(f.jobs.result(A, b.id), 'RESULT_CANARY'); assert.equal(f.jobs.usage.list(A)[0].jobId, b.id); assert.equal(f.jobs.usage.daily(A).length, 1);
  } finally { await f.close(); }
});

test('queued/held/unknown jobs and their uncertainty payloads, quota latches, managed ownership and handoff references survive pruning', async () => {
  let allow = true; let f!: ReturnType<typeof fixture>;
  const binding = { source: 'codex-app-server' as const, unit: 'work-codex' as const, accountId: 'ACCOUNT_CANARY', bucketId: 'codex', model: 'exact-model', scope: 'pool' as const };
  f = fixture({ admit: async () => allow ? { allowed: true } : { allowed: false, reason: 'quota' }, quotaSources: { selected: { async read() { return [{ binding, observation: { ...binding, observedAt: f.clock.value, complete: true, ordinaryUsageAllowed: true,
    windows: [{ id: 'weekly', durationMinutes: 10080, remainingPercent: 0, resetsAt: f.clock.value + DAY }] } }]; } } },
    runners: { selected: () => runner(async function* (spec) { if (spec.prompt === 'unknown') throw Error('EFFECT_CANARY'); yield { t: 'done', code: 0, result: 'RESULT_CANARY' }; }) } });
  try {
    await f.jobs.quota.refresh({ runnerId: 'selected', model: 'exact-model' }, new AbortController().signal);
    const uncertain = f.jobs.submit(input('unknown', { prompt: 'unknown' }), A).job; const settled = f.jobs.submit(input('settled'), A).job; await f.jobs.runQueued();
    allow = false; const held = f.jobs.submit(input('held'), A).job; await f.jobs.runQueued(); const queued = f.jobs.submit(input('queued'), A).job;
    f.jobs.managed.registerOwnership({ id: 'managed_a', projectId: A.projectId, cwd: '/synthetic/project', session: { hostId: 'opencode', sessionId: 'session_a', ownerId: 'owner_a', generation: 0, model: 'exact-model', access: 'edit' } });
    f.jobs.handoffs.put(A, { id: 'handoff_a', requestId: 'handoff_request', projectId: A.projectId, createdAt: f.clock.value, manifestHash: 'a'.repeat(64), markdownHash: 'b'.repeat(64) });
    const durable = () => JSON.stringify(['quota_state', 'quota_bindings', 'managed_ownership', 'managed_retirements', 'handoff_artifacts'].map(table => f.observer.prepare(`SELECT * FROM ${table}`).all()));
    const before = durable(); f.clock.value += 90 * DAY; assert.equal(f.jobs.retention.prune(A).jobs, 1); assert.equal(f.jobs.get(A, settled.id).retained, 'receipt');
    assert.equal(f.jobs.get(A, uncertain.id).state, 'unknown'); assert.equal(f.jobs.get(A, held.id).state, 'held'); assert.equal(f.jobs.get(A, queued.id).state, 'queued'); assert.equal(durable(), before);
    assert.equal(f.jobs.retention.status(A).uncertainJobs, 1); assert.equal(f.jobs.quota.status().state, 'blocked');
    assert.equal(String(f.observer.prepare('SELECT payload FROM jobs WHERE id=?').get(uncertain.id)!.payload).includes('unknown'), true);
    assert.equal(f.jobs.usage.list(A)[0].state, 'unknown'); assert.equal(f.jobs.submit(input('unknown'), A).duplicate, true);
  } finally { await f.close(); }
});

for (const phase of ['before', 'after'] as const) test(`native prune ${phase} COMMIT receipt loss preserves atomic originals or exactly one aggregate/receipt, fences and never replays on reopen`, async () => {
  const f = fixture(); const exec = SqliteDatabase.prototype.exec; let reopened: ReturnType<typeof openDaemonJobs> | undefined;
  try {
    const job = f.jobs.submit(input('retained'), A).job; await f.jobs.runQueued(); f.clock.value += 30 * DAY;
    SqliteDatabase.prototype.exec = function(sql) {
      if (this.location() === f.options.stateFile && sql === 'COMMIT') { if (phase === 'after') exec.call(this, sql); throw Error('RECEIPT_LOSS_CANARY'); }
      return exec.call(this, sql);
    };
    assert.throws(() => f.jobs.retention.prune(A), unknown); assert.throws(() => f.jobs.get(A, job.id), unknown); SqliteDatabase.prototype.exec = exec;
    assert.equal(f.observer.prepare('SELECT count(*) AS n FROM job_receipts').get()!.n, phase === 'after' ? 1 : 0);
    assert.equal(f.observer.prepare('SELECT count(*) AS n FROM jobs').get()!.n, phase === 'after' ? 0 : 1);
    await f.jobs.close(); reopened = openDaemonJobs(f.options); reopened.recover(); assert.equal(reopened.get(A, job.id).retained, 'receipt');
    assert.equal(reopened.usage.daily(A)[0].attempts, 1); assert.equal(reopened.usage.daily(A)[0].tokensIn, 7); assert.equal(reopened.submit(input('retained'), A).duplicate, true);
    await reopened.runQueued(); assert.equal(f.calls(), 1); assert.deepEqual(reopened.retention.prune(A), { jobs: 0, attempts: 0, capacityHeld: false });
  } finally { SqliteDatabase.prototype.exec = exec; await reopened?.close(); await f.close(); }
});

test('daily counter overflow rolls prune back and preserves original attempt/receipt capacity instead of manufacturing a total', async () => {
  const f = fixture({ billing: () => ({ kind: 'local', vendor: 'ollama', qualification: 'verified' }), runners: { selected: () => runner(async function* () { yield { t: 'usage', tokensIn: Number.MAX_SAFE_INTEGER, tokensOut: 1 }; yield { t: 'done', code: 0, result: 'RESULT_CANARY' }; }) } });
  try {
    f.jobs.submit(input('max_a'), A); f.jobs.submit(input('max_b'), A); await f.jobs.runQueued(); f.clock.value += 30 * DAY;
    assert.throws(() => f.jobs.retention.prune(A), code('unavailable')); assert.equal(f.jobs.usage.list(A).length, 2); assert.equal(f.jobs.usage.daily(A).length, 0); assert.equal(f.jobs.retention.status(A).scopedReceipts, 0);
    assert.equal(f.jobs.retention.prune(A, 1).jobs, 1); assert.equal(f.jobs.usage.daily(A)[0].tokensIn, Number.MAX_SAFE_INTEGER);
  } finally { await f.close(); }
});

test('configured drain grace allows running native completion without cancellation and leaves queued work undispatched', async () => {
  const started = deferred(); const finish = deferred(); let aborts = 0; let calls = 0;
  const f = fixture({ drainMs: 1000, runners: { selected: () => runner(async function* (spec) { calls++; spec.signal.addEventListener('abort', () => { aborts++; }); started.resolve(); await finish.promise; yield { t: 'done', code: 0, result: 'grace completed' }; }) } });
  try {
    const a = f.jobs.submit(input('active'), A).job; const b = f.jobs.submit(input('queued'), A).job; const run = f.jobs.runQueued(); await started.promise;
    const drain = f.jobs.drain(); assert.throws(() => f.jobs.submit(input('during_drain'), A), code('unavailable')); assert.equal(aborts, 0);
    finish.resolve(); await drain; await run; assert.equal(aborts, 0); assert.equal(calls, 1); assert.equal(f.jobs.get(A, a.id).state, 'succeeded'); assert.equal(f.jobs.get(A, b.id).state, 'queued');
    assert.equal(f.jobs.get(A, a.id).cancelRequested, false); f.jobs.assertOwner();
  } finally { finish.resolve(); await f.close(); }
});

test('drain deadline requests cancellation but cannot release authority or settle until the synthetic native process positively exits', async () => {
  const started = deferred(); const cancelled = deferred(); const exit = deferred(); let child: ReturnType<typeof spawn> | undefined; let childDone: Promise<number | null> | undefined; let closingDone = false;
  const f = fixture({ drainMs: 15, runners: { selected: () => runner(async function* (spec) {
    child = spawn(process.execPath, ['-e', "process.stdout.write('READY\\n');process.stdin.resume();process.stdin.once('data',()=>process.exit(0))"], { cwd: f.sb.root, env: f.sb.env(), stdio: ['pipe', 'pipe', 'pipe'] });
    childDone = new Promise(resolve => child!.once('close', code => { exit.resolve(); resolve(code); }));
    await new Promise<void>(resolve => child!.stdout!.once('data', () => resolve())); spec.signal.addEventListener('abort', () => cancelled.resolve(), { once: true }); started.resolve();
    const code = await childDone; yield { t: 'done', code: code ?? 1, result: 'positive process close' };
  }) } });
  try {
    const job = f.jobs.submit(input('native_active'), A).job; const run = f.jobs.runQueued(); await started.promise;
    const closing = f.jobs.close().then(() => { closingDone = true; }); await cancelled.promise;
    assert.equal(closingDone, false); assert.equal(f.jobs.get(A, job.id).state, 'running'); assert.equal(f.jobs.get(A, job.id).cancelRequested, true);
    assert.throws(() => new DaemonOwner(f.options.ownerFile), code('unavailable')); f.jobs.assertOwner(); child!.stdin!.write('finish\n');
    await exit.promise; await run; await closing; assert.equal(closingDone, true);
    assert.equal(f.observer.prepare('SELECT state FROM jobs WHERE id=?').get(job.id)!.state, 'succeeded');
    const owner = new DaemonOwner(f.options.ownerFile); owner.close();
  } finally { if (child?.exitCode === null) { child.kill('SIGKILL'); await childDone; } await f.close(); }
});

test('positive configured grace never waits for unstarted admission or dispatches it after shutdown', async () => {
  const started = deferred(); let loaded = 0;
  const f = fixture({ drainMs: 1000, admit: async (_job, signal) => { started.resolve(); await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); return { allowed: true }; },
    runners: { selected: () => { loaded++; throw Error('NO_DISPATCH'); } } });
  try {
    const job = f.jobs.submit(input('admitting'), A).job; const run = f.jobs.runQueued(); await started.promise; await f.jobs.drain(); await run;
    assert.equal(loaded, 0); assert.equal(f.jobs.get(A, job.id).state, 'queued'); assert.equal(f.jobs.usage.list(A).length, 0);
  } finally { await f.close(); }
});

test('uncertain prune receipt synchronously aborts the existing active control and retains native authority until its positive settlement', async () => {
  const started = deferred(); const finish = deferred(); let aborted = false; let closed = false; const exec = SqliteDatabase.prototype.exec;
  const f = fixture({ runners: { selected: () => runner(async function* (spec) {
    if (spec.prompt === 'slow') { spec.signal.addEventListener('abort', () => { aborted = true; }); started.resolve(); await finish.promise; }
    yield { t: 'done', code: 0, result: 'RESULT_CANARY' };
  }) } }); let reopened: ReturnType<typeof openDaemonJobs> | undefined;
  try {
    const old = f.jobs.submit(input('old'), A).job; await f.jobs.runQueued(); const active = f.jobs.submit(input('active', { prompt: 'slow' }), A).job; const run = f.jobs.runQueued(); await started.promise;
    f.clock.value += 30 * DAY; SqliteDatabase.prototype.exec = function(sql) { const result = exec.call(this, sql); if (this.location() === f.options.stateFile && sql === 'COMMIT') throw Error('LOST_PRUNE_RECEIPT'); return result; };
    assert.throws(() => f.jobs.retention.prune(A), unknown); assert.equal(aborted, true); assert.throws(() => f.jobs.retention.status(A), unknown); SqliteDatabase.prototype.exec = exec;
    const closing = f.jobs.close().then(() => { closed = true; }, error => { assert.ok(unknown(error)); closed = true; }); await Promise.resolve(); assert.equal(closed, false); assert.throws(() => new DaemonOwner(f.options.ownerFile), code('unavailable'));
    finish.resolve(); await run; await closing; reopened = openDaemonJobs(f.options); assert.equal(reopened.recover(), 1);
    assert.equal(reopened.get(A, old.id).retained, 'receipt'); assert.equal(reopened.get(A, active.id).state, 'unknown'); assert.equal(reopened.submit(input('active'), A).duplicate, true);
    assert.equal(reopened.retention.status(A).scopedReceipts, 1);
  } finally { SqliteDatabase.prototype.exec = exec; finish.resolve(); await reopened?.close(); await f.close(); }
});

test('automatic bounded retention frees pressure only after age boundary and preserves owner-only receipt isolation', async () => {
  const f = fixture({ maxQueue: 1, maxJobs: 1, maxEvents: 10 });
  try {
    const old = f.jobs.submit(input('owner', { ownerOnly: true }), A).job; await f.jobs.runQueued(); assert.throws(() => f.jobs.submit(input('fresh'), A), code('unavailable'));
    f.clock.value += 30 * DAY; const next = f.jobs.submit(input('new'), A).job; assert.equal(f.jobs.get(A, old.id).retained, 'receipt');
    assert.throws(() => f.jobs.get({ ...A, audience: 'model' }, old.id), code('not_found')); assert.deepEqual(f.jobs.list({ ...A, audience: 'model' }).map(job => job.id), [next.id]);
    assert.equal(f.jobs.retention.status(A).capacity.queued, 0); assert.equal(f.jobs.retention.status(A).pressure, true);
    assert.equal(String(f.observer.prepare('SELECT payload FROM jobs WHERE id=?').get(next.id)!.payload).includes('PROMPT_CANARY'), true);
  } finally { await f.close(); }
});

test('invalid grace policies are finite and never acquire an owner lock or install a new runtime', () => {
  const sb = sandbox(); const dir = path.join(sb.root, 'invalid'); fs.mkdirSync(dir); const files = { stateFile: path.join(dir, 'state.db'), ownerFile: path.join(dir, 'owner.db') };
  try {
    for (const drainMs of [-1, NaN, 300001]) assert.throws(() => openDaemonJobs({ ...files, runners: {}, drainMs }), code('invalid'));
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally { sb.cleanup(); }
});
