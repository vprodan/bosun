import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import childProcess, { type SpawnOptions } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { SqliteDatabase } from '../src/platform/sqlite.ts';
import { sandbox } from './helpers.ts';
import { openDaemonJobs } from '../src/app/jobs.ts';
import { createNotificationService } from '../src/app/notifications.ts';
import { createMacNotificationSink } from '../src/adapters/notifications/macos.ts';
import { DaemonOwner } from '../src/platform/daemon-owner.ts';
import { BosunError } from '../src/core/errors.ts';
import type { AgentRunner } from '../src/core/ports/runner.ts';
import type { JobInput } from '../src/core/domain/job.ts';
import type { NotificationPayload, NotificationSink } from '../src/core/domain/notifications.ts';

const A = { projectId: 'p_a', audience: 'owner' as const }; const B = { projectId: 'p_b', audience: 'owner' as const };
const input = (id = 'first'): JobInput => ({ privacy: 'public', requestId: id, taskId: 'task_a', runnerId: 'selected',
  model: 'MODEL_CANARY', prompt: 'PROMPT_CANARY', cwd: '/synthetic/FILE_CANARY', access: 'read' });
const caps: AgentRunner['caps'] = { vendor: 'ACCOUNT_CANARY', readOnly: 'verified', sandbox: 'tool-allowlist', effort: 'verified', mcpInject: 'unsupported', localBackend: 'unverified', billing: 'unknown' };
const ref = (id: string) => 'job_' + crypto.createHash('sha256').update(id).digest('hex').slice(0, 24);
const unknown = (error: unknown) => error instanceof BosunError && error.details?.outcome === 'unknown';
const code = (name: string) => (error: unknown) => error instanceof BosunError && error.code === name;
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const acknowledged = (calls: NotificationPayload[]): NotificationSink => ({ availability: () => ({ available: true }), async deliver(payload) { calls.push(payload); return { phase: 'submitted', reason: null, ui: 'unverified' }; } });
function fixture(options: { enabled?: boolean; sink?: () => NotificationSink; jobOptions?: Partial<Parameters<typeof openDaemonJobs>[0]> } = {}) {
  const sb = sandbox(); const dir = path.join(sb.root, 'notifications'); fs.mkdirSync(dir, { mode: 0o700 }); let ids = 0; let notifications!: ReturnType<typeof createNotificationService>;
  const settings = { stateFile: path.join(dir, 'state.db'), ownerFile: path.join(dir, 'owner.db'), id: () => `job_${++ids}`, now: () => 1000,
    runners: { selected: () => ({ id: 'selected', caps, detect: async () => ({ installed: true }), async *run() { yield { t: 'done' as const, code: 0, result: 'RESULT_CANARY' }; } }) },
    admit: async () => ({ allowed: true as const }), ...options.jobOptions, stateChanged: job => notifications?.observe(job) } satisfies Parameters<typeof openDaemonJobs>[0];
  const jobs = openDaemonJobs(settings); jobs.recover(); const observer = new SqliteDatabase(settings.stateFile, { readOnly: true });
  notifications = createNotificationService({ enabled: options.enabled ?? true, jobs, sink: options.sink }); notifications.start();
  return { sb, dir, settings, jobs, observer, notifications, async close() { await notifications.close(); observer.close(); await jobs.close(); sb.cleanup(); } };
}

test('default disabled notification flow never reads/reserves/recovers/probes/delivers, including hostile event/sink/storage getters', async () => {
  let reads = 0; const unread = { get notifications(): never { reads++; throw Error('STORAGE_CANARY'); } } as unknown as ReturnType<typeof openDaemonJobs>;
  const service = createNotificationService({ enabled: false, jobs: unread, sink() { reads++; throw Error('SINK_CANARY'); } });
  const event = { get id(): never { reads++; throw Error('PRIVATE_PROMPT_CANARY'); } }; service.start(); service.observe(event); assert.equal(service.status(A).state, 'disabled'); await service.settled(); await service.close(); assert.equal(reads, 0);
  const f = fixture({ enabled: false, sink() { reads++; throw Error('NO_PROBE'); } });
  try { f.jobs.submit(input(), A); await f.jobs.runQueued(); assert.equal(f.observer.prepare('SELECT count(*) AS n FROM notification_events').get()!.n, 0); assert.equal(reads, 0); }
  finally { await f.close(); }
});

test('committed ready/done generations are opaque, scoped, deduped across actual SQLite reopen and never copy previews into callbacks or state receipts', async () => {
  const calls: NotificationPayload[] = []; const f = fixture({ sink: () => acknowledged(calls) }); let reopened: ReturnType<typeof openDaemonJobs> | undefined; let resumed: ReturnType<typeof createNotificationService> | undefined;
  try {
    const job = f.jobs.submit(input(), A).job; await f.jobs.runQueued(); await f.notifications.settled(); assert.deepEqual(calls.map(call => call.state), ['ready', 'done']);
    assert.ok(calls.every(call => Object.keys(call).sort().join(',') === 'jobRef,state' && call.jobRef === ref(job.id)));
    const terminal = f.jobs.get(A, job.id); let previews = 0;
    f.notifications.observe({ ...terminal, get prompt(): never { previews++; throw Error('PRIVATE_PROMPT'); }, get model(): never { previews++; throw Error('PRIVATE_MODEL'); } }); await f.notifications.settled();
    assert.equal(previews, 0); assert.equal(calls.length, 2); assert.equal(f.notifications.status(A).records!.submitted, 2); assert.equal(f.notifications.status(B).records!.submitted, 0);
    const stored = JSON.stringify(f.observer.prepare('SELECT * FROM notification_events').all()); assert.doesNotMatch(stored, /PROMPT_CANARY|RESULT_CANARY|MODEL_CANARY|ACCOUNT_CANARY|FILE_CANARY|permission|tool/);
    assert.throws(() => f.notifications.status({ ...A, audience: 'model' }), code('unsupported'));
    await f.notifications.close(); await f.jobs.close(); reopened = openDaemonJobs(f.settings); reopened.recover(); resumed = createNotificationService({ enabled: true, jobs: reopened, sink: () => acknowledged(calls) }); resumed.start(); resumed.observe(terminal); await resumed.settled(); assert.equal(calls.length, 2);
  } finally { await resumed?.close(); await reopened?.close(); await f.close(); }
});

test('actual held/released/failed events notify exact state versions while preserving chosen job outcome and excluding model/permission previews', async () => {
  let allowed = false; const calls: NotificationPayload[] = [];
  const f = fixture({ sink: () => acknowledged(calls), jobOptions: { admit: async () => allowed ? { allowed: true } : { allowed: false, reason: 'quota' },
    runners: { selected: () => ({ id: 'selected', caps, detect: async () => ({ installed: true }), async *run() { yield { t: 'permission' as const, tool: 'PRIVATE_PERMISSION', decision: 'deny' as const }; yield { t: 'done' as const, code: 7, result: 'FAILED_RESULT_CANARY' }; } }) } } });
  try {
    const job = f.jobs.submit(input(), A).job; await f.jobs.runQueued(); await f.notifications.settled(); assert.equal(f.jobs.get(A, job.id).state, 'held');
    allowed = true; await f.jobs.release(A, job.id); await f.jobs.runQueued(); await f.notifications.settled();
    assert.deepEqual(calls.map(call => call.state), ['ready', 'held', 'ready', 'failed']); assert.equal(f.jobs.get(A, job.id).state, 'failed'); assert.equal(f.jobs.result(A, job.id), 'FAILED_RESULT_CANARY');
    assert.doesNotMatch(JSON.stringify(calls), /PRIVATE_PERMISSION|FAILED_RESULT|MODEL_CANARY|quota/);
  } finally { await f.close(); }
});

test('missing/unsupported sink is honestly held with a finite scoped reason and no callback attempt or automatic retry', async () => {
  for (const reason of ['sink_missing', 'platform_unsupported', 'command_missing'] as const) {
    let delivered = 0; const f = fixture({ ...(reason === 'sink_missing' ? {} : { sink: () => ({ availability: () => ({ available: false, reason }), async deliver() { delivered++; throw Error('NO_DELIVERY'); } }) }) });
    try {
      const job = f.jobs.submit(input(), A).job; await f.notifications.settled(); const status = f.notifications.status(A); assert.equal(status.state, 'held'); assert.equal(status.reason, reason); assert.equal(status.records!.held, 1); assert.equal(delivered, 0);
      f.notifications.observe(f.jobs.get(A, job.id)); await f.notifications.settled(); assert.equal(f.notifications.status(A).records!.held, 1); assert.equal(delivered, 0);
    } finally { await f.close(); }
  }
});

test('unknown callback outcome is durably sticky and cannot be retried after restart or by duplicate current events', async () => {
  let calls = 0; const f = fixture({ sink: () => ({ availability: () => ({ available: true }), async deliver() { calls++; throw Error('UNKNOWN_PERMISSION_ACCOUNT_CANARY'); } }) });
  let reopened: ReturnType<typeof openDaemonJobs> | undefined; let resumed: ReturnType<typeof createNotificationService> | undefined;
  try {
    const job = f.jobs.submit(input(), A).job; await f.notifications.settled(); assert.equal(f.notifications.status(A).records!.unknown, 1); assert.equal(calls, 1);
    f.notifications.observe(f.jobs.get(A, job.id)); await f.notifications.settled(); assert.equal(calls, 1); await f.notifications.close(); await f.jobs.close();
    reopened = openDaemonJobs(f.settings); reopened.recover(); resumed = createNotificationService({ enabled: true, jobs: reopened, sink: () => acknowledged([]) }); resumed.start(); resumed.observe(reopened.get(A, job.id)); await resumed.settled();
    assert.equal(resumed.status(A).records!.unknown, 1); assert.equal(f.observer.prepare('SELECT count(*) AS n FROM notification_events').get()!.n, 1); assert.doesNotMatch(JSON.stringify(f.observer.prepare('SELECT * FROM notification_events').all()), /ACCOUNT_CANARY/);
  } finally { await resumed?.close(); await reopened?.close(); await f.close(); }
});

test('bounded durable notification pressure cannot erase deliveries or change successful jobs to make space', async () => {
  const calls: NotificationPayload[] = []; const f = fixture({ sink: () => acknowledged(calls), jobOptions: { maxNotifications: 2, maxPendingNotifications: 2 } });
  try {
    const a = f.jobs.submit(input('first'), A).job; await f.jobs.runQueued(); await f.notifications.settled(); assert.equal(calls.length, 2);
    const b = f.jobs.submit(input('second'), A).job; await f.jobs.runQueued(); await f.notifications.settled(); assert.equal(f.jobs.get(A, b.id).state, 'succeeded'); assert.equal(f.jobs.get(A, a.id).state, 'succeeded');
    assert.equal(f.notifications.status(A).reason, 'capacity'); assert.equal(f.notifications.status(A).records!.remaining, 0); assert.equal(calls.length, 2);
  } finally { await f.close(); }
});

test('pending-finalization enqueue race starts a bounded successor pump and settled waits for it without another event', async () => {
  const calls: NotificationPayload[] = []; const f = fixture({ enabled: false }); let injected = false;
  const next = f.jobs.notifications.next; f.jobs.notifications.next = () => { const value = next(); if (!value && !injected) { injected = true; queueMicrotask(() => { const job = f.jobs.submit(input('tail'), A).job; service.observe(job); }); } return value; };
  const service = createNotificationService({ enabled: true, jobs: f.jobs, sink: () => acknowledged(calls) });
  try { service.start(); await service.settled(); assert.equal(calls.length, 1); assert.equal(calls[0].state, 'ready'); assert.equal(service.status(A).records!.submitted, 1); }
  finally { await service.close(); await f.close(); }
});

test('native macOS command uses fixed script/closed argv and selected clean env; process exit0 acknowledges submission with UI unknown', async () => {
  const sb = sandbox(); let authReads = 0; const env = sb.env({ ANTHROPIC_API_KEY: 'AUTH_VALUE_CANARY', BOSUN_SECRET_CANARY: 'AUTH_VALUE_CANARY' });
  Object.defineProperty(env, 'OPENAI_API_KEY', { get() { authReads++; throw Error('DO_NOT_IMPORT_AUTH'); } });
  const sink = createMacNotificationSink({ enabled: true, env, cwd: sb.root, platform: 'darwin' });
  const guardedSpawn = childProcess.spawn; let selectedEnv: NodeJS.ProcessEnv | undefined;
  // Capture the production allowlist, then restore only this fixture's mandatory
  // containment envelope for its synthetic command. The actual spawn still
  // goes through the original guard; no external executable becomes allowed.
  const withFixtureEnvelope = (command: string, args: readonly string[] = [], options: SpawnOptions = {}) => {
    selectedEnv = options.env;
    return guardedSpawn(command, args, { ...options, env: { ...sb.env(), ...options.env } });
  };
  childProcess.spawn = withFixtureEnvelope as unknown as typeof childProcess.spawn; syncBuiltinESMExports();
  try {
    const payload = { jobRef: 'job_' + 'a'.repeat(24), state: 'ready' as const }; const result = await sink.deliver(payload, new AbortController().signal);
    assert.deepEqual(result, { phase: 'submitted', reason: null, ui: 'unverified' }); const calls = sb.calls(); assert.equal(calls.length, 1); assert.equal(calls[0].bin, 'osascript');
    assert.equal(calls[0].argv[0], '-e'); assert.ok(calls[0].argv[1].includes('display notification')); assert.equal(calls[0].argv[2], `${payload.jobRef}: Job queued`); assert.equal(calls[0].stdin, '');
    assert.deepEqual(Object.keys(selectedEnv!).sort(), ['HOME', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR']);
    assert.equal(authReads, 0); assert.doesNotMatch(JSON.stringify(calls), /AUTH_VALUE_CANARY|OPENAI_API_KEY|ANTHROPIC_API_KEY|sound name|do shell script/);
    const invalid = { ...payload, get prompt(): never { throw Error('PRIVATE_PREVIEW'); } }; await assert.rejects(sink.deliver(invalid, new AbortController().signal), code('invalid')); assert.equal(sb.calls().length, 1);
    const unsupported = createMacNotificationSink({ enabled: true, env, cwd: sb.root, platform: 'linux' }); assert.equal(unsupported.availability().available, false); assert.equal((await unsupported.deliver(payload, new AbortController().signal)).phase, 'held'); assert.equal(sb.calls().length, 1);
  } finally { childProcess.spawn = guardedSpawn; syncBuiltinESMExports(); sb.cleanup(); }
});

test('notification shutdown aborts/waits the pending callback while daemon owner remains held, preserving late positive acknowledgement', async () => {
  const started = deferred(); const abort = deferred(); const finish = deferred(); let closing = false;
  const f = fixture({ sink: () => ({ availability: () => ({ available: true }), async deliver(_payload, signal) { signal.addEventListener('abort', () => abort.resolve(), { once: true }); started.resolve(); await finish.promise; return { phase: 'submitted', reason: null, ui: 'unverified' }; } }) });
  try {
    f.jobs.submit(input(), A); await started.promise; const close = f.notifications.close().then(() => { closing = true; }); await abort.promise;
    assert.equal(closing, false); f.jobs.assertOwner(); assert.throws(() => new DaemonOwner(f.settings.ownerFile), code('unavailable')); finish.resolve(); await close;
    assert.equal(closing, true); assert.equal(f.observer.prepare('SELECT phase FROM notification_events').get()!.phase, 'submitted'); f.jobs.assertOwner();
  } finally { finish.resolve(); await f.close(); }
});

for (const phase of ['start', 'finish'] as const) test(`lost notification ${phase} COMMIT receipt never replays and cannot erase the original positive job outcome`, async () => {
  const f = fixture({ enabled: false }); const exec = SqliteDatabase.prototype.exec; let resumed: ReturnType<typeof createNotificationService> | undefined; let reopened: ReturnType<typeof openDaemonJobs> | undefined;
  try {
    const job = f.jobs.submit(input(), A).job; await f.jobs.runQueued(); const terminal = f.jobs.get(A, job.id); const receipt = f.jobs.notifications.reserve(terminal, ref(job.id)).receipt!;
    if (phase === 'finish') f.jobs.notifications.start(receipt.id);
    SqliteDatabase.prototype.exec = function(sql) { const result = exec.call(this, sql); if (this.location() === f.settings.stateFile && sql === 'COMMIT') throw Error('NOTIFICATION_RECEIPT_CANARY'); return result; };
    assert.throws(() => phase === 'start' ? f.jobs.notifications.start(receipt.id) : f.jobs.notifications.finish(receipt.id, { phase: 'submitted', reason: null, ui: 'unverified' }), unknown); SqliteDatabase.prototype.exec = exec;
    assert.equal(f.observer.prepare('SELECT state FROM jobs WHERE id=?').get(job.id)!.state, 'succeeded'); assert.equal(f.observer.prepare('SELECT phase FROM notification_events').get()!.phase, phase === 'start' ? 'submitting' : 'submitted');
    await f.jobs.close(); reopened = openDaemonJobs(f.settings); reopened.recover(); let sends = 0; resumed = createNotificationService({ enabled: true, jobs: reopened, sink: () => ({ availability: () => ({ available: true }), async deliver() { sends++; return { phase: 'submitted', reason: null, ui: 'unverified' }; } }) });
    resumed.start(); resumed.observe(terminal); await resumed.settled(); assert.equal(sends, 0); assert.equal(reopened.get(A, job.id).state, 'succeeded'); assert.equal(reopened.result(A, job.id), 'RESULT_CANARY'); assert.equal(resumed.status(A).records![phase === 'start' ? 'unknown' : 'submitted'], 1);
  } finally { SqliteDatabase.prototype.exec = exec; await resumed?.close(); await reopened?.close(); await f.close(); }
});
