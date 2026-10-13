import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SqliteDatabase } from '../src/platform/sqlite.ts';
import { sandbox, fresh, gitRepo } from './helpers.ts';
import { BosunError } from '../src/core/errors.ts';
import { quotaIdentity, quotaObservation, quotaDecision, mergeQuota, QUOTA_LIMITS, type QuotaBinding, type QuotaObservation } from '../src/core/domain/quota.ts';
import type { QuotaObservationEntry, SupportedQuotaSource } from '../src/core/use-cases/quota.ts';
import type { JobInput } from '../src/core/domain/job.ts';
import type { AgentRunner } from '../src/core/ports/runner.ts';
import { decodeCodexQuota, decodeCodexQuotaBatch } from '../src/adapters/hosts/codex/quota.ts';
import { decodeClaudeQuota } from '../src/adapters/hosts/claude/quota.ts';
import { openDaemonJobs } from '../src/app/jobs.ts';
import { startDaemon } from '../src/app/daemon.ts';
import { setupRuntime } from '../src/app/setup.ts';
import { main } from '../src/app/cli.ts';
import { runtimePaths } from '../src/platform/paths.ts';
import { parseRuntimeConfig } from '../src/platform/config.ts';
import { methodParams } from '../src/contracts/methods.ts';
import { callLocalRpc } from '../src/adapters/transport/local-rpc.ts';

const MODEL = 'gpt-6.1-sol'; const ACCOUNT = 'ACCOUNT_PRIVATE_CANARY'; const scope = { projectId: 'project_fixture' };
const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const binding = (model = MODEL): QuotaBinding => ({ source: 'codex-app-server', unit: 'work-codex', accountId: ACCOUNT, bucketId: 'codex', model, scope: 'pool' });
function observation(at: number, short = 60, weekly = 60, extra: Partial<QuotaObservation> = {}): QuotaObservation {
  return { ...binding(), observedAt: at, complete: true, ordinaryUsageAllowed: true,
    windows: [{ id: 'short', durationMinutes: 300, remainingPercent: short, resetsAt: at + 300000 },
      { id: 'weekly', durationMinutes: 10080, remainingPercent: weekly, resetsAt: at + 600000 }], ...extra };
}
const batch = (value: QuotaObservation): QuotaObservationEntry[] => [{ binding: { ...value }, observation: value }];
const code = (expected: string, unknown = false) => (e: unknown) => {
  assert.ok(e instanceof BosunError); assert.equal(e.code, expected); assert.equal(e.details?.outcome, unknown ? 'unknown' : undefined);
  assert.doesNotMatch(JSON.stringify(e), /CANARY|secret|email|password/); return true;
};
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const caps: AgentRunner['caps'] = { vendor: 'synthetic', readOnly: 'verified', sandbox: 'tool-allowlist', effort: 'verified', mcpInject: 'unsupported', localBackend: 'unsupported', billing: 'unknown' };
const input = (requestId: string, extra: Partial<JobInput> = {}): JobInput => ({ privacy: 'public', requestId, taskId: 'task_fixture', runnerId: 'selected', prompt: 'TASK_PRIVATE_CANARY',
  cwd: '/synthetic/project', model: MODEL, effort: 'high', access: 'read', ...extra });
function fixture(source?: SupportedQuotaSource, extra: Partial<Parameters<typeof openDaemonJobs>[0]> = {}) {
  const sb = sandbox(); const dir = path.join(sb.root, 'state'); fs.mkdirSync(dir, { mode: 0o700 });
  const files = { stateFile: path.join(dir, 'state.db'), ownerFile: path.join(dir, 'owner.db') }; let at = 1000000; let ids = 0; let runs = 0;
  const runners = { selected: () => ({ id: 'selected', caps, detect: async () => ({ installed: true }), async *run() { runs++; yield { t: 'done' as const, code: 0, result: 'Public completed result' }; } }) };
  const options = { ...files, runners, now: () => at, id: () => `job_${++ids}`, hash, ...(source ? { quotaSources: { selected: source } } : {}), ...extra };
  const jobs = openDaemonJobs(options); jobs.recover();
  return { sb, files, options, jobs, time: () => at, setTime(value: number) { at = value; }, runs: () => runs,
    async close() { await jobs.close(); sb.cleanup(); } };
}
const selected = { runnerId: 'selected', model: MODEL }; const signal = () => new AbortController().signal;

test('pure quota windows independently latch: short reset, sparse/stale/null data and clock passage never clear weekly exhaustion', () => {
  const b = binding(); const identity = quotaIdentity(b, hash); let at = 1000000;
  const merge = (prior: ReturnType<typeof mergeQuota> | null, obs: QuotaObservation) => mergeQuota(prior, identity, quotaObservation(obs, b, at), at);
  let state = merge(null, observation(at, 0, 0)); assert.equal(quotaDecision([state], at), 'blocked');
  at += 600001; assert.equal(quotaDecision([state], at), 'blocked');
  state = merge(state, observation(at, 80, 0)); assert.equal(state.windows[0].blocked, false); assert.equal(state.windows[1].blocked, true);
  at++; state = merge(state, observation(at, 100, 100, { complete: false })); assert.equal(quotaDecision([state], at), 'blocked');
  at++; state = merge(state, observation(at, 100, 100, { ordinaryUsageAllowed: null,
    windows: [{ id: 'weekly', durationMinutes: 10080, remainingPercent: null, resetsAt: at + 600000 }] }));
  assert.equal(quotaDecision([state], at), 'blocked');
  const before = state; assert.equal(merge(state, observation(at - 1)), before);
  at++; state = merge(state, observation(at, 10, 90)); assert.equal(quotaDecision([state], at), 'available');
  assert.equal(quotaDecision([state], at + QUOTA_LIMITS.freshnessMs + 1), 'unknown');
  assert.throws(() => quotaObservation(observation(at + 1), b, at), code('invalid'));
  assert.equal(quotaIdentity({ ...b, model: 'other-model' }, hash).poolKey, identity.poolKey);
  const api = quotaIdentity({ ...b, source: 'opencode', unit: 'api' }, hash); const local = quotaIdentity({ ...b, source: 'opencode', unit: 'local' }, hash);
  assert.notEqual(api.poolKey, identity.poolKey); assert.notEqual(local.poolKey, api.poolKey);
  assert.throws(() => quotaIdentity(b, () => { throw Error('PROVIDER_PRIVATE_CANARY'); }), code('unavailable'));
});

test('native quota codecs preserve actual durations, separate generic/model buckets, require account/access evidence, and omit source payload/credits', () => {
  let content = 0; const at = 1000000;
  const win = (usedPercent: number, windowDurationMins = 15) => ({ usedPercent, windowDurationMins, resetsAt: 2000 });
  const raw = { accountId: ACCOUNT, ordinaryUsageAllowed: true, rateLimits: { limitId: 'codex', primary: win(20), secondary: win(30, 60),
    get limitName() { content++; throw Error('CANARY'); }, get credits() { content++; throw Error('CANARY'); } },
  rateLimitsByLimitId: { model: { limitId: 'model', normalModelSlug: MODEL, primary: win(100), secondary: win(20, 10080) },
    other: { normalModelSlug: 'other-model', get primary() { content++; throw Error('CANARY'); } } },
  get rateLimitResetCredits() { content++; throw Error('CANARY'); }, get rateLimitUpsell() { content++; throw Error('CANARY'); } };
  const decoded = decodeCodexQuotaBatch(raw, { accountId: ACCOUNT, model: MODEL }, at);
  assert.equal(decoded.length, 2); assert.equal(decoded[0].binding.scope, 'pool'); assert.equal(decoded[1].binding.scope, 'model');
  assert.deepEqual(decoded[0].observation!.windows.map(w => [w.id, w.durationMinutes]), [['primary', 15], ['secondary', 60]]);
  assert.equal(decoded[1].observation!.windows[0].remainingPercent, 0); assert.equal(content, 0);
  assert.throws(() => decodeCodexQuotaBatch({ rateLimits: raw.rateLimits, rateLimitsByLimitId: raw.rateLimitsByLimitId,
    ordinaryUsageAllowed: true, accountId: 'foreign' }, { accountId: ACCOUNT, model: MODEL }, at), code('invalid'));
  const sparse = decodeCodexQuota({ rateLimits: { primary: win(0), secondary: null } }, binding(), at, 'update');
  assert.equal(sparse.complete, false); assert.equal(sparse.ordinaryUsageAllowed, null);
  const noAccess = decodeCodexQuota({ rateLimits: { primary: win(0), secondary: win(0) }, accountId: ACCOUNT }, binding(), at);
  assert.equal(noAccess.ordinaryUsageAllowed, null);
  const claudeBinding: QuotaBinding = { ...binding(), source: 'claude-statusline', unit: 'claude-subscription' };
  const claude = decodeClaudeQuota({ model: { id: MODEL }, rate_limits: { five_hour: { used_percentage: 23.5, resets_at: 2000 }, seven_day: { used_percentage: 100, resets_at: 9000 } },
    get transcript_path() { content++; throw Error('CANARY'); } }, claudeBinding, at);
  assert.equal(claude.ordinaryUsageAllowed, null); assert.equal(claude.windows[0].remainingPercent, 76.5); assert.equal(claude.windows[1].remainingPercent, 0); assert.equal(content, 0);
});

test('native SQLite persists shared-pool exhaustion across restart/source absence; owner unknown opt-in cannot bypass it or change model pools', async () => {
  let f!: ReturnType<typeof fixture>; let reads = 0; let short = 0; let sparse = false;
  f = fixture({ async read(choice) { reads++; return batch(observation(f.time(), short, sparse ? 90 : 0, { model: choice.model, complete: !sparse })); } });
  let reopened: ReturnType<typeof openDaemonJobs> | undefined;
  try {
    await f.jobs.quota.refresh(selected, signal());
    short = 80; f.setTime(f.time() + 300001); await f.jobs.quota.refresh(selected, signal());
    assert.equal(f.jobs.quota.status().buckets[0].windows[0].blocked, false); assert.equal(f.jobs.quota.status().buckets[0].windows[1].blocked, true);
    sparse = true; f.setTime(f.time() + 1); await f.jobs.quota.refresh(selected, signal());
    assert.equal(f.jobs.quota.status().state, 'blocked');
    const job = f.jobs.submit(input('known', { allowUnknownQuota: true }), scope).job; await f.jobs.runQueued();
    assert.equal(f.jobs.get(scope, job.id).state, 'held'); assert.equal(f.jobs.get(scope, job.id).reason, 'quota'); assert.equal(f.runs(), 0);
    const persisted = new SqliteDatabase(f.files.stateFile, { readOnly: true });
    try { assert.equal(persisted.prepare('SELECT COUNT(*) AS n FROM quota_state').get()!.n, 1);
      assert.doesNotMatch(JSON.stringify(persisted.prepare('SELECT * FROM quota_state').all()), /ACCOUNT_PRIVATE|TASK_PRIVATE|password|credits/);
      const payload = JSON.parse(String(persisted.prepare('SELECT payload FROM jobs').get()!.payload)); assert.equal(payload.allowUnknownQuota, true);
    } finally { persisted.close(); }
    await f.jobs.close(); reopened = openDaemonJobs({ ...f.options, quotaSources: undefined }); reopened.recover();
    assert.equal(reopened.quota.status().state, 'blocked');
    const other = reopened.submit(input('other', { model: 'gpt-6-luna', allowUnknownQuota: true }), scope).job;
    await reopened.runQueued(); assert.equal(reopened.get(scope, other.id).reason, 'quota'); assert.equal(f.runs(), 0);
    assert.equal((await reopened.release(scope, job.id)).state, 'held'); assert.equal(reads, 3);
  } finally { await reopened?.close(); await f.close(); }
});

test('default unknown holds, explicit exact owner opt-in is durable, model setters deny before content getters; two-argument admits receive immutable metadata', async () => {
  const f = fixture(); let reads = 0;
  try {
    const normal = f.jobs.submit(input('normal'), scope).job; const owner = f.jobs.submit(input('owner', { allowUnknownQuota: true }), scope).job;
    await f.jobs.runQueued(); assert.equal(f.jobs.get(scope, normal.id).state, 'held'); assert.equal(f.jobs.get(scope, owner.id).state, 'succeeded'); assert.equal(f.runs(), 1);
    for (const flag of [true, false]) {
      const denied = { ...input('denied'), allowUnknownQuota: flag, get prompt(): never { reads++; throw Error('TASK_PRIVATE_CANARY'); } };
      assert.throws(() => f.jobs.submit(denied, { ...scope, audience: 'model' }), code('unsupported'));
      assert.throws(() => methodParams({ version: 1, id: 'r', method: 'job.submit', params: denied, scope: { workspace: '/synthetic', sessionId: null, audience: 'model' } }), code('unsupported'));
    }
    assert.equal(reads, 0);
    assert.throws(() => methodParams({ version: 1, id: 'r', method: 'quota.refresh', params: { ...selected, confidence: 'supported', windows: [] },
      scope: { workspace: '/synthetic', sessionId: null, audience: 'owner' } }), code('invalid'));
  } finally { await f.close(); }
  let calls = 0; const g = fixture(undefined, { async admit(job, _signal, metadata) {
    calls++; assert.ok(Object.isFrozen(job)); assert.ok(Object.isFrozen(metadata)); assert.deepEqual(Object.keys(metadata!).sort(), ['access', 'allowUnknownQuota', 'cwd', 'effort', 'model','submittedBy']);assert.equal(metadata!.submittedBy,'owner');
    assert.equal(metadata!.model, MODEL); assert.equal(metadata!.allowUnknownQuota, true); assert.equal('prompt' in metadata!, false); return { allowed: true }; } });
  try { g.jobs.submit(input('injected', { allowUnknownQuota: true }), scope); await g.jobs.runQueued(); assert.equal(calls, 1); assert.equal(g.runs(), 1); }
  finally { await g.close(); }
});

test('fresh supported matching state permits held release/dispatch; selected refreshes coalesce and unrelated sources are untouched', async () => {
  let f!: ReturnType<typeof fixture>; let healthy = false; let calls = 0; let other = 0;
  f = fixture({ async read(choice) { calls++; assert.deepEqual(Object.keys(choice).sort(), ['model', 'runnerId']);
    return batch(observation(f.time(), healthy ? 50 : 8, 50)); } }, { quotaSources: {
    selected: { async read(choice) { calls++; assert.equal(choice.model, MODEL); return batch(observation(f.time(), healthy ? 50 : 8, 50)); } },
    other: { async read() { other++; throw Error('PROVIDER_PRIVATE_CANARY'); } },
  } });
  try {
    const job = f.jobs.submit(input('held', { allowUnknownQuota: true }), scope).job; await f.jobs.runQueued(); assert.equal(f.jobs.get(scope, job.id).reason, 'quota');
    healthy = true; f.setTime(f.time() + 1); await Promise.all([f.jobs.quota.refresh(selected, signal()), f.jobs.quota.refresh(selected, signal())]);
    assert.equal(calls, 2); assert.equal(other, 0); assert.equal((await f.jobs.release(scope, job.id)).state, 'queued');
    await f.jobs.runQueued(); assert.equal(f.jobs.get(scope, job.id).state, 'succeeded'); assert.equal(calls, 2); assert.equal(f.runs(), 1);
  } finally { await f.close(); }
});

test('wrong account/model and invalid clocks reject before atomic native quota/job changes', async () => {
  let f!: ReturnType<typeof fixture>; let wrong: 'account' | 'model' | 'none' = 'none';
  f = fixture({ async read() { const value = observation(f.time()); return [{ binding: binding(), observation: { ...value, ...(wrong === 'account' ? { accountId: 'wrong' } : wrong === 'model' ? { model: 'wrong' } : {}) } }]; } });
  try {
    await f.jobs.quota.refresh(selected, signal()); const before = f.jobs.quota.status();
    for (const kind of ['account', 'model'] as const) { wrong = kind; f.setTime(f.time() + 1); await assert.rejects(f.jobs.quota.refresh(selected, signal()), code('invalid')); assert.deepEqual(f.jobs.quota.status(), before); }
    f.setTime(NaN); await assert.rejects(f.jobs.quota.refresh(selected, signal()), code('unavailable'));
    const db = new SqliteDatabase(f.files.stateFile, { readOnly: true }); try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM quota_state').get()!.n, 1); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM jobs').get()!.n, 0); } finally { db.close(); }
  } finally { f.setTime(1000000); await f.close(); }
});

test('generic and exact model-specific quota restrictions share one atomic native batch without blocking unrelated models', async () => {
  let f!: ReturnType<typeof fixture>; const source: SupportedQuotaSource = { async read(choice) {
    const at = f.time(); const generic = observation(at, 60, 60, { model: choice.model });
    return choice.model === MODEL ? [...batch(generic), { binding: { ...binding(choice.model), bucketId: 'restricted', scope: 'model' },
      observation: { ...generic, bucketId: 'restricted', scope: 'model', windows: generic.windows.map(w => ({ ...w, remainingPercent: 0 })) } }] : batch(generic);
  } }; f = fixture(source);
  try {
    const limited = f.jobs.submit(input('limited'), scope).job; await f.jobs.runQueued(); assert.equal(f.jobs.get(scope, limited.id).reason, 'quota');
    f.setTime(f.time() + 1); const other = f.jobs.submit(input('other', { model: 'gpt-6-luna' }), scope).job;
    await f.jobs.runQueued(); assert.equal(f.jobs.get(scope, other.id).state, 'succeeded'); assert.equal(f.runs(), 1);
    const db = new SqliteDatabase(f.files.stateFile, { readOnly: true }); try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM quota_state').get()!.n, 2); } finally { db.close(); }
  } finally { await f.close(); }
});

test('actual quota batch COMMIT then error persists every bucket and mapping, fences admission, and never duplicates dispatch after reopen', async () => {
  let f!: ReturnType<typeof fixture>; f = fixture({ async read() { const base = observation(f.time(), 0, 0); return [...batch(base),
    { binding: { ...binding(), scope: 'model', bucketId: 'model' }, observation: { ...base, scope: 'model', bucketId: 'model' } }]; } });
  const exec = SqliteDatabase.prototype.exec; let commits = 0; let reopened: ReturnType<typeof openDaemonJobs> | undefined;
  try {
    const job = f.jobs.submit(input('uncertain'), scope).job;
    SqliteDatabase.prototype.exec = function(sql) { const value = exec.call(this, sql); if (sql === 'COMMIT') { commits++; throw Error('PROVIDER_PRIVATE_CANARY'); } return value; };
    await assert.rejects(f.jobs.runQueued(), code('unavailable', true)); assert.equal(commits, 1); assert.equal(f.runs(), 0);
    SqliteDatabase.prototype.exec = exec;
    const db = new SqliteDatabase(f.files.stateFile, { readOnly: true }); try {
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM quota_state').get()!.n, 2); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM quota_bindings').get()!.n, 1);
      assert.equal(db.prepare('SELECT state FROM jobs').get()!.state, 'queued'); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM job_events').get()!.n, 1);
    } finally { db.close(); }
    await f.jobs.close(); reopened = openDaemonJobs({ ...f.options, quotaSources: undefined }); assert.equal(reopened.recover(), 0);
    const duplicate = reopened.submit({ ...input('uncertain'), get prompt(): never { throw Error('TASK_PRIVATE_CANARY'); } }, scope); assert.equal(duplicate.duplicate, true); assert.equal(duplicate.job.id, job.id);
    await reopened.runQueued(); assert.equal(reopened.get(scope, job.id).reason, 'quota'); assert.equal(f.runs(), 0);
  } finally { SqliteDatabase.prototype.exec = exec; await reopened?.close(); await f.close(); }
});

test('async held release cannot queue after concurrent cancellation or daemon close; late source completion cannot write closed SQLite', async () => {
  for (const closing of [false, true]) {
    let f!: ReturnType<typeof fixture>; let ready = false; const started = deferred(); const gate = deferred<readonly QuotaObservationEntry[] | null>();
    f = fixture({ async read() { if (!ready) return null; started.resolve(); return gate.promise; } });
    try {
      const job = f.jobs.submit(input(`race_${closing}`), scope).job; await f.jobs.runQueued(); ready = true;
      const releasing = f.jobs.release(scope, job.id); const rejected = assert.rejects(releasing, code(closing ? 'unavailable' : 'conflict'));
      await started.promise;
      if (closing) await f.jobs.close(); else f.jobs.cancel(scope, job.id);
      gate.resolve(batch(observation(f.time()))); await rejected;
      const db = new SqliteDatabase(f.files.stateFile, { readOnly: true }); try {
        assert.equal(db.prepare('SELECT state FROM jobs').get()!.state, closing ? 'held' : 'cancelled');
        if (closing) assert.equal(db.prepare('SELECT COUNT(*) AS n FROM quota_state').get()!.n, 0);
      } finally { db.close(); } assert.equal(f.runs(), 0);
    } finally { gate.resolve(null); await f.close(); }
  }
});

test('actual daemon UDS and CLI default quota holds, owner-only status/refresh and unknown opt-in use the shared method table', async () => {
  const sb = sandbox(); fresh(sb); const workspace = gitRepo(sb, 'workspace'); const socket = path.join(process.env.BOSUN_TEST_RUN_ROOT!, `q${process.pid}`);
  const env = sb.env({ BOSUN_SOCKET: socket }); const paths = runtimePaths(env); const config = parseRuntimeConfig(''); await setupRuntime(paths, config);
  let runs = 0; const runner: AgentRunner = { id: 'codex', caps, detect: async () => ({ installed: true }), async *run() { runs++; yield { t: 'done', code: 0, result: 'Public result' }; } };
  const daemon = await startDaemon({ paths, config, runners: { codex: () => runner } }); let seq = 0;
  const rpc = (method: string, params: Record<string, unknown>, audience: 'owner' | 'model' = 'owner') => callLocalRpc<any>({ socket, request: { version: 1, id: `r${++seq}`, method, params, scope: { workspace, sessionId: null, audience } } });
  const cli = async (args: string[], caller = 'owner') => { let out = ''; let err = ''; const code = await main(args, { env: { ...env, BOSUN_CALLER: caller }, cwd: workspace, stdout: t => out += t, stderr: t => err += t }); return { code, out, err }; };
  const wait = async (id: string) => { let job = await rpc('job.get', { id }); for (let n = 0; n < 100 && ['queued', 'running'].includes(job.state); n++) { await new Promise(r => setTimeout(r, 5)); job = await rpc('job.get', { id }); } return job; };
  try {
    const held = await cli(['run', '--host', 'codex', '--model', MODEL, '--request-id', 'default', 'Public task']); assert.equal(held.code, 0, held.err);
    assert.equal((await wait(JSON.parse(held.out).job.id)).state, 'held'); assert.equal(runs, 0);
    const allowed = await cli(['run', '--host', 'codex', '--model', MODEL, '--request-id', 'owner', '--allow-unknown-quota', 'Public task']);
    assert.equal(allowed.code, 0, allowed.err); assert.equal((await wait(JSON.parse(allowed.out).job.id)).state, 'succeeded'); assert.equal(runs, 1);
    assert.equal(JSON.parse((await cli(['quota', 'status'])).out).state, 'unknown');
    assert.equal(JSON.parse((await cli(['quota', 'refresh', '--host', 'codex', '--model', MODEL])).out).state, 'unknown');
    assert.notEqual((await cli(['run', '--allow-unknown-quota', 'Public task'], 'model')).code, 0);
    await assert.rejects(rpc('quota.status', {}, 'model'), code('unsupported'));
    await assert.rejects(rpc('quota.refresh', { runnerId: 'codex', model: MODEL, evidence: { confidence: 'supported' } }), code('invalid'));
    assert.deepEqual(sb.calls(), []);
  } finally { await daemon.close(); sb.cleanup(); }
});

test('durable runner failure refreshes the selected quota before the next dispatch despite a recent healthy cache', async () => {
  let f!: ReturnType<typeof fixture>; let sourceCalls = 0; let runs = 0;
  f = fixture({ async read() { sourceCalls++; return batch(observation(f.time() + sourceCalls - 1, sourceCalls === 1 ? 60 : 0, 60)); } },
    { now: () => 1000002, runners: { selected: () => ({ id: 'selected', caps, detect: async () => ({ installed: true }), async *run() {
      runs++; yield { t: 'done' as const, code: 1, result: 'Native request refused' };
    } }) } });
  try {
    const first = f.jobs.submit(input('failed-first'), scope).job; const second = f.jobs.submit(input('held-next', { allowUnknownQuota: true }), scope).job;
    await f.jobs.runQueued(); assert.equal(sourceCalls, 2); assert.equal(runs, 1);
    assert.equal(f.jobs.get(scope, first.id).state, 'failed'); assert.equal(f.jobs.result(scope, first.id), 'Native request refused');
    assert.equal(f.jobs.get(scope, second.id).state, 'held'); assert.equal(f.jobs.get(scope, second.id).reason, 'quota');
  } finally { await f.close(); }
});

test('unknown quota COMMIT after a durable runner failure fences later dispatch and preserves the native outcome across reopen', async () => {
  const exec = SqliteDatabase.prototype.exec; let sourceCalls = 0; let runs = 0; let armed = false; let f!: ReturnType<typeof fixture>;
  let reopened: ReturnType<typeof openDaemonJobs> | undefined;
  f = fixture({ async read() {
    sourceCalls++; if (sourceCalls === 2) armed = true;
    return batch(observation(1000000 + sourceCalls, sourceCalls === 1 ? 60 : 0, 60));
  } }, { now: () => 1000003, runners: { selected: () => ({ id: 'selected', caps, detect: async () => ({ installed: true }), async *run() {
    runs++; yield { t: 'done' as const, code: 1, result: 'Native failure already known' };
  } }) } });
  try {
    const first = f.jobs.submit(input('failure-commit'), scope).job; const second = f.jobs.submit(input('never-dispatched'), scope).job;
    SqliteDatabase.prototype.exec = function(sql) { const result = exec.call(this, sql);
      if (armed && sql === 'COMMIT') { armed = false; throw Error('PROVIDER_PRIVATE_CANARY'); } return result; };
    await assert.rejects(f.jobs.runQueued(), code('unavailable', true)); assert.equal(runs, 1);
    SqliteDatabase.prototype.exec = exec;
    const db = new SqliteDatabase(f.files.stateFile, { readOnly: true });
    try {
      assert.deepEqual({ ...db.prepare('SELECT j.state,r.result FROM jobs j JOIN job_results r ON r.job_id=j.id WHERE j.id=?').get(first.id)! }, { state: 'failed', result: 'Native failure already known' });
      assert.equal(db.prepare('SELECT state FROM jobs WHERE id=?').get(second.id)!.state, 'queued');
    } finally { db.close(); }
    await f.jobs.close(); reopened = openDaemonJobs({ ...f.options, quotaSources: undefined }); reopened.recover();
    assert.equal(reopened.get(scope, first.id).state, 'failed'); await reopened.runQueued();
    assert.equal(reopened.get(scope, second.id).reason, 'quota'); assert.equal(runs, 1);
  } finally { SqliteDatabase.prototype.exec = exec; await reopened?.close(); await f.close(); }
});
