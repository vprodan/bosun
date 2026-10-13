import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { SqliteDatabase } from '../src/platform/sqlite.ts';
import { sandbox, REPO } from './helpers.ts';
import { footprint } from './read-view-prototype.ts';
import { BosunError } from '../src/core/errors.ts';
import { openDaemonJobs } from '../src/app/jobs.ts';
import { SqliteJobStore } from '../src/adapters/jobs/sqlite-jobs.ts';
import { DaemonOwner } from '../src/platform/daemon-owner.ts';
import { JOB_LIMITS, type JobInput } from '../src/core/domain/job.ts';
import type { AgentRunner, RunSpec } from '../src/core/ports/runner.ts';

const A = { projectId: 'p_a' }; const B = { projectId: 'p_b' };
const code = (name: string) => (e: unknown) => e instanceof BosunError && e.code === name;
const unknown = (e: unknown) => e instanceof BosunError && e.code === 'unavailable' && e.details?.outcome === 'unknown' && !e.message.includes('PRIVATE');
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
const caps: AgentRunner['caps'] = { vendor: 'synthetic', readOnly: 'verified', sandbox: 'tool-allowlist', mcpInject: 'unsupported', effort: 'verified', localBackend: 'unsupported', billing: 'unknown' };
function runner(run: AgentRunner['run'], id = 'selected'): AgentRunner { return { id, caps, detect: async () => ({ installed: true, version: 'fixture' }), run }; }
const input = (requestId = 'request_a'): JobInput => ({ privacy: 'public', requestId, taskId: 'task_a', runnerId: 'selected', prompt: 'PUBLIC TASK CONTENT CANARY', cwd: '/synthetic/project', access: 'read', model: 'explicit-model', effort: 'high', maxTurns: 4 });
function layout() {
  const sb = sandbox(); const dir = path.join(sb.root, 'daemon-state'); fs.mkdirSync(dir, { mode: 0o700 });
  return { sb, dir, stateFile: path.join(dir, 'state.db'), ownerFile: path.join(dir, 'owner.db') };
}
test('replaced native owner file cannot leave a cached writer authoritative beside a newly acquired owner', () => {
  const f = layout(); const owner = new DaemonOwner(f.ownerFile); const storage = new SqliteJobStore({ file: f.stateFile, assertOwner: () => owner.assert() });
  let replacement: DaemonOwner | undefined; let newStorage: SqliteJobStore | undefined;
  try {
    storage.create(A, 'existing_job', input('existing_request'), 1000);
    fs.renameSync(f.ownerFile, path.join(f.dir, 'retained-owner.db'));
    replacement = new DaemonOwner(f.ownerFile);
    assert.throws(() => owner.assert(), code('unavailable')); assert.throws(() => storage.create(A, 'old_writer_job', input('old_writer_request'), 1001), code('unavailable'));
    newStorage = new SqliteJobStore({ file: f.stateFile, assertOwner: () => replacement!.assert() });
    assert.equal(newStorage.list(A).length, 1); assert.equal(newStorage.get(A, 'existing_job').state, 'queued');
    assert.equal(newStorage.create(A, 'new_writer_job', input('new_writer_request'), 1002).job.id, 'new_writer_job');
  } finally { newStorage?.close(); replacement?.close(); storage.close(); owner.close(); f.sb.cleanup(); }
});
function setup(options: Partial<Parameters<typeof openDaemonJobs>[0]> = {}) {
  const f = layout(); let sequence = 0; let time = 123456;
  const jobs = openDaemonJobs({ ...f, runners: { selected: () => runner(async function* () { yield { t: 'done', code: 0, result: 'PUBLIC RESULT CANARY' }; }) },
    admit: async () => ({ allowed: true }), now: () => ++time, id: () => `job_${++sequence}`, ...options });
  return { ...f, jobs, async close() { await jobs.close(); f.sb.cleanup(); } };
}

test('background owner work follows queued interactive, admin and summary work while preserving FIFO within each class', async () => {
  const order: string[] = [];
  const queued = (id: string) => () => runner(async function* (spec) { order.push(spec.prompt); yield { t: 'done', code: 0, result: 'Completed' }; }, id);
  const f = setup({ runners: { background: queued('background'), selected: queued('selected'), admin: queued('admin'), summary: queued('summary') },
    internalRunnerIds: ['background', 'admin', 'summary'], backgroundRunnerIds: ['background'] });
  try {
    assert.equal(f.jobs.idle(), false); f.jobs.recover(); assert.equal(f.jobs.idle(), true);
    for (const [requestId, runnerId, ownerOnly] of [
      ['background_first', 'background', true], ['background_second', 'background', true],
      ['interactive', 'selected', false], ['maintenance', 'admin', true], ['summary', 'summary', true],
    ] as const) f.jobs.submit({ ...input(requestId), runnerId, ownerOnly, prompt: requestId }, A);
    assert.equal(f.jobs.idle(), false); await f.jobs.runQueued();
    assert.deepEqual(order, ['interactive', 'maintenance', 'summary', 'background_first', 'background_second']);
    assert.equal(f.jobs.idle(), true); assert.equal(f.jobs.list(A).every(job => job.state === 'succeeded'), true);
    await f.jobs.drain(); assert.equal(f.jobs.idle(), false);
  } finally { await f.close(); }
});

test('public classification cannot admit known credentials; a tainted native result preserves successful owner outcome but is withheld from model', async () => {
  const secret = 'api_key=' + 'x'.repeat(40);
  const f = setup({ runners: { selected: () => runner(async function* () { yield { t: 'done', code: 0, result: secret }; }) } });
  try {
    f.jobs.recover(); assert.throws(() => f.jobs.submit({ ...input(), prompt: secret }, A), code('private_input')); assert.deepEqual(f.jobs.list(A), []);
    const job = f.jobs.submit(input('screened_result'), A).job; await f.jobs.runQueued();
    assert.equal(f.jobs.get(A, job.id).state, 'succeeded'); assert.equal(f.jobs.result(A, job.id), secret);
    assert.equal(f.jobs.result({ ...A, audience: 'model' }, job.id), null); assert.equal(JSON.stringify(f.jobs.events(A, 0)).includes(secret), false);
  } finally { await f.close(); }
});

test('known credentials in job selection/identity/path metadata are refused before persistence, admission, callbacks or dispatch', async () => {
  let effects = 0; const f = setup({ admit: async () => { effects++; return { allowed: true }; }, stateChanged() { effects++; } });
  const credential = 'sk-proj-' + 'x'.repeat(40);
  try {
    f.jobs.recover();
    for (const field of ['model', 'effort', 'runnerId', 'requestId', 'taskId', 'cwd'] as const) {
      const value = { ...input(`metadata_${field}`), [field]: field === 'cwd' ? '/synthetic/' + credential : credential };
      assert.throws(() => f.jobs.submit(value, A), code('private_input'), field);
    }
    assert.equal(effects, 0); assert.deepEqual(f.jobs.list(A), []); assert.deepEqual(f.jobs.events(A, 0).events, []);
  } finally { await f.close(); }
});

test('jobs persist selected runner/model/effort/access/cwd and bounded owner result; events contain no source payload', async () => {
  let selected = 0; let other = 0; const calls: RunSpec[] = [];
  const f = setup({ runners: {
    selected() { selected++; return runner(async function* (spec) { calls.push(spec); yield { t: 'text', text: 'PUBLIC STREAM CANARY' }; yield { t: 'tool', name: 'PUBLIC TOOL CANARY', target: 'PUBLIC TARGET CANARY' }; yield { t: 'file', path: 'PUBLIC FILE CANARY', op: 'edit' }; yield { t: 'usage', tokensIn: 2, tokensOut: 3 }; yield { t: 'done', code: 0, result: 'PUBLIC RESULT CANARY' }; }); },
    other() { other++; throw Error('unselected runner must stay lazy'); },
  } });
  try {
    assert.equal(selected + other, 0); f.jobs.assertOwner(); assert.equal(f.jobs.recover(), 0);
    const created = f.jobs.submit(input(), A); assert.equal(created.job.state, 'queued');
    assert.equal(f.jobs.result(A, created.job.id), null); assert.equal(selected + other, 0);
    const one = f.jobs.runQueued(); const same = f.jobs.runQueued(); assert.equal(one, same); await one;
    assert.equal(selected, 1); assert.equal(other, 0); assert.equal(calls.length, 1);
    const spec = calls[0]; assert.equal(spec.model, 'explicit-model'); assert.equal(spec.effort, 'high'); assert.equal(spec.access, 'read'); assert.equal(spec.cwd, '/synthetic/project'); assert.equal(spec.maxTurns, 4); assert.equal(spec.privacy, 'public'); assert.equal(spec.prompt, input().prompt);
    const done = f.jobs.get(A, created.job.id); assert.equal(done.state, 'succeeded'); assert.equal(f.jobs.result(A, done.id), 'PUBLIC RESULT CANARY');
    const first = f.jobs.events(A, 0, 2); assert.equal(first.events.length, 2);
    const next = f.jobs.events(A, first.cursor, 100); assert.equal(next.events.at(-1)!.state, 'succeeded');
    assert.deepEqual([...first.events, ...next.events].map((e) => e.kind), ['created', 'state', 'text', 'tool', 'file', 'usage', 'state']);
    const metadata = JSON.stringify(f.jobs.events(A, 0, 100));
    for (const text of ['CANARY', 'explicit-model', 'synthetic/project', 'request_a', 'task_a']) assert.ok(!metadata.includes(text), text);
    assert.throws(() => f.jobs.get(B, done.id), code('not_found')); assert.throws(() => f.jobs.result(B, done.id), code('not_found')); assert.deepEqual(f.jobs.events(B, 0).events, []);
    assert.throws(() => f.jobs.events(A, -1), code('invalid')); assert.throws(() => f.jobs.events(A, 0, 101), code('invalid'));
    assert.equal(fs.statSync(f.stateFile).mode & 0o777, 0o600); assert.equal(fs.statSync(f.dir).mode & 0o777, 0o700);
  } finally { await f.close(); }
});

test('request idempotency and scope survive native reopen without reading duplicate prompt getters or dispatching', async () => {
  const f = setup(); let reopened: ReturnType<typeof openDaemonJobs> | undefined;
  try {
    f.jobs.recover(); const a = f.jobs.submit(input(), A); const b = f.jobs.submit(input(), B); assert.notEqual(a.job.id, b.job.id);
    await f.jobs.runQueued(); await f.jobs.close();
    let calls = 0; reopened = openDaemonJobs({ ...f, runners: { selected: () => { calls++; throw Error('must not replay'); } }, admit: async () => ({ allowed: true }), now: () => 999999, id: () => 'new_id' });
    assert.equal(reopened.recover(), 0);
    let getters = 0; const duplicate = { ...input(), get prompt(): string { getters++; throw Error('PRIVATE duplicate payload'); } };
    const existing = reopened.submit(duplicate, A); assert.equal(existing.duplicate, true); assert.equal(existing.job.id, a.job.id); assert.equal(existing.job.state, 'succeeded'); assert.equal(getters, 0);
    assert.equal(reopened.result(A, a.job.id), 'PUBLIC RESULT CANARY'); assert.equal(reopened.list(A).length, 1); assert.equal(reopened.list(B).length, 1);
    await reopened.runQueued(); assert.equal(calls, 0);
  } finally { await reopened?.close(); await f.close(); }
});

test('native owner jobs deny model payload/result/metadata access and owner-only creation before prompt getters', async () => {
  const f = setup(); const model = { ...A, audience: 'model' as const };
  try {
    f.jobs.recover(); const job = f.jobs.submit({ ...input('owner_request'), ownerOnly: true }, A).job;
    assert.equal(job.ownerOnly, true); await f.jobs.runQueued();
    assert.throws(() => f.jobs.get(model, job.id), code('not_found')); assert.throws(() => f.jobs.result(model, job.id), code('not_found'));
    assert.throws(() => f.jobs.cancel(model, job.id), code('not_found')); assert.deepEqual(f.jobs.list(model), []); assert.deepEqual(f.jobs.events(model, 0).events, []);
    let reads = 0; const forbidden = { ...input('new_owner'), ownerOnly: true, get prompt(): string { reads++; throw Error('PRIVATE owner payload'); } };
    assert.throws(() => f.jobs.submit(forbidden, model), code('unsupported')); assert.equal(reads, 0);
    assert.equal(f.jobs.submit({ ...input('public_request'), ownerOnly: false }, model).job.ownerOnly, false);
  } finally { await f.close(); }
});

test('privacy classification precedes every prompt/task getter, storage write, admission and runner call', async () => {
  let getters = 0; let ports = 0; const f = setup({ runners: { selected() { ports++; throw Error('PRIVATE runner'); } }, admit: async () => { ports++; return { allowed: true }; } });
  try {
    f.jobs.recover();
    const variants = ['private', 'unknown', undefined, 'malformed'].map((privacy) => ({ privacy, get requestId() { getters++; throw Error('PRIVATE request'); }, get prompt() { getters++; throw Error('PRIVATE prompt'); } }));
    variants.push(Object.create({ privacy: 'public' }));
    for (const value of variants) assert.throws(() => f.jobs.submit(value as never, A), (e) => code('private_input')(e) && !(e as Error).message.includes('PRIVATE'));
    assert.equal(getters, 0); assert.equal(ports, 0); assert.deepEqual(f.jobs.list(A), []); assert.deepEqual(f.jobs.events(A, 0).events, []);
    assert.throws(() => f.jobs.submit({ ...input(), prompt: 'é'.repeat(16385) }, A), code('invalid')); assert.deepEqual(f.jobs.list(A), []);
    const owner = new DaemonOwner(path.join(f.dir, 'second-owner.db'));
    const store = new SqliteJobStore({ file: path.join(f.dir, 'private-state.db'), assertOwner: () => owner.assert() });
    try { assert.throws(() => store.create(A, 'private_job', variants[0] as never, 1), code('private_input')); assert.equal(getters, 0); assert.deepEqual(store.list(A), []); }
    finally { store.close(); owner.close(); }
  } finally { await f.close(); }
});

test('bounded queue and admission holds are durable, explicit release preserves selection, cancellation is known before dispatch', async () => {
  let allow = false; let loads = 0; const f = setup({ maxQueue: 2, maxJobs: 4, maxEvents: 100,
    admit: async () => allow ? { allowed: true } : { allowed: false, reason: 'quota' }, runners: { selected() { loads++; return runner(async function* (spec) { assert.equal(spec.model, 'explicit-model'); yield { t: 'done', code: 0, result: 'selected result' }; }); } } });
  try {
    f.jobs.recover(); const a = f.jobs.submit(input('first'), A).job; const b = f.jobs.submit(input('second'), A).job;
    assert.throws(() => f.jobs.submit(input('third'), A), code('unavailable')); assert.equal(f.jobs.submit(input('first'), A).duplicate, true);
    await f.jobs.runQueued(); assert.equal(loads, 0); assert.equal(f.jobs.get(A, a.id).state, 'held'); assert.equal(f.jobs.get(A, a.id).reason, 'quota');
    assert.equal(f.jobs.cancel(A, b.id).state, 'cancelled'); assert.equal(f.jobs.cancel(A, b.id).state, 'cancelled'); await assert.rejects(f.jobs.release(A, b.id), code('conflict'));
    allow = true; assert.equal((await f.jobs.release(A, a.id)).state, 'queued'); await f.jobs.runQueued(); assert.equal(loads, 1); assert.equal(f.jobs.get(A, a.id).state, 'succeeded');
    const c = f.jobs.submit(input('third'), A).job; assert.equal(f.jobs.cancel(A, c.id).state, 'cancelled'); assert.equal(loads, 1);
  } finally { await f.close(); }
});

for (const positiveDone of [false, true]) test(`active cancellation ${positiveDone ? 'retains positive actual runner outcome' : 'becomes unknown without runner completion'}`, async () => {
  const started = deferred(); let aborted = false;
  const f = setup({ runners: { selected: () => runner(async function* (spec) {
    started.resolve(); yield { t: 'tool', name: 'PUBLIC TOOL EFFECT' };
    await new Promise<void>((resolve) => { if (spec.signal.aborted) resolve(); else spec.signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }); });
    if (positiveDone) yield { t: 'done', code: 0, result: 'actual finished result' };
  }) } });
  try {
    f.jobs.recover(); const job = f.jobs.submit(input(), A).job; const running = f.jobs.runQueued(); await started.promise;
    const cancelled = f.jobs.cancel(A, job.id); assert.equal(cancelled.state, 'running'); assert.equal(cancelled.cancelRequested, true);
    await running; assert.ok(aborted || cancelled.cancelRequested);
    assert.equal(f.jobs.get(A, job.id).state, positiveDone ? 'succeeded' : 'unknown'); assert.equal(f.jobs.result(A, job.id), positiveDone ? 'actual finished result' : null);
    await f.jobs.runQueued(); assert.equal(f.jobs.get(A, job.id).cancelRequested, true);
  } finally { await f.close(); }
});

test('nonzero native done is failed; provider loss/oversize produces finite unknown metadata without provider text', async () => {
  const f = setup({ runners: { selected: () => runner(async function* (spec) {
    if (spec.prompt === 'failed') yield { t: 'done', code: 7, result: 'owner failure detail' };
    else if (spec.prompt === 'oversize') yield { t: 'text', text: 'x'.repeat(JOB_LIMITS.resultBytes + 1) };
    else throw new BosunError('unavailable', 'PRIVATE provider exception');
  }) } });
  try {
    f.jobs.recover();
    const a = f.jobs.submit({ ...input('failed'), prompt: 'failed' }, A).job;
    const b = f.jobs.submit({ ...input('lost'), prompt: 'lost' }, A).job;
    const c = f.jobs.submit({ ...input('oversize'), prompt: 'oversize' }, A).job;
    await f.jobs.runQueued();
    assert.equal(f.jobs.get(A, a.id).state, 'failed'); assert.equal(f.jobs.result(A, a.id), 'owner failure detail');
    assert.equal(f.jobs.get(A, b.id).state, 'unknown'); assert.equal(f.jobs.get(A, c.id).reason, 'output_limit');
    assert.ok(!JSON.stringify(f.jobs.events(A, 0, 100)).includes('PRIVATE')); assert.equal(f.jobs.result(A, b.id), null);
  } finally { await f.close(); }
});

test('drain closes neither jobs nor native authority while late runner completion is still pending', async () => {
  const started = deferred(); const finish = deferred(); let signals = 0;
  const f = setup({ runners: { selected: () => runner(async function* (spec) {
    spec.signal.addEventListener('abort', () => { signals++; }); started.resolve(); yield { t: 'tool', name: 'PUBLIC tool' };
    await finish.promise; yield { t: 'done', code: 0, result: 'late positive completion' };
  }) } });
  let closed = false;
  try {
    f.jobs.recover(); const job = f.jobs.submit(input(), A).job; const run = f.jobs.runQueued(); await started.promise;
    const closing = f.jobs.close().then(() => { closed = true; });
    await Promise.resolve(); assert.equal(closed, false); assert.equal(signals, 1); assert.throws(() => f.jobs.submit(input('new'), A), code('unavailable'));
    assert.throws(() => new DaemonOwner(f.ownerFile), code('unavailable'), 'authority remains held');
    assert.equal(f.jobs.get(A, job.id).state, 'running');
    finish.resolve(); await run; await closing; assert.equal(closed, true);
    assert.throws(() => f.jobs.assertOwner(), code('unavailable'));
    assert.throws(() => f.jobs.get(A, job.id), code('unavailable'));
    const owner = new DaemonOwner(f.ownerFile); const store = new SqliteJobStore({ file: f.stateFile, assertOwner: () => owner.assert() });
    try { assert.equal(store.get(A, job.id).state, 'succeeded'); assert.equal(store.result(A, job.id), 'late positive completion'); }
    finally { store.close(); owner.close(); }
  } finally { finish.resolve(); await f.close(); }
});

test('drain aborts admission before payload/runner dispatch and leaves unstarted queued work persisted', async () => {
  const admitting = deferred(); let loads = 0;
  const f = setup({ admit: (_job, signal) => { admitting.resolve(); return new Promise((resolve) => signal.addEventListener('abort', () => resolve({ allowed: true }), { once: true })); },
    runners: { selected: () => { loads++; throw Error('must not load'); } } });
  try {
    f.jobs.recover(); const job = f.jobs.submit(input(), A).job; const run = f.jobs.runQueued(); await admitting.promise;
    await f.jobs.drain(); await run; assert.equal(loads, 0); assert.equal(f.jobs.get(A, job.id).state, 'queued');
  } finally { await f.close(); }
});

test('queued cancellation aborts pending admission and cannot later become a hold or dispatch', async () => {
  const admitting = deferred(); let calls = 0;
  const f = setup({ admit: (_job, signal) => { admitting.resolve(); return new Promise((resolve) => signal.addEventListener('abort', () => resolve({ allowed: true }), { once: true })); },
    runners: { selected: () => { calls++; throw Error('must not load'); } } });
  try {
    f.jobs.recover(); const job = f.jobs.submit(input(), A).job; const run = f.jobs.runQueued(); await admitting.promise;
    assert.equal(f.jobs.cancel(A, job.id).state, 'cancelled'); await run;
    assert.equal(f.jobs.get(A, job.id).state, 'cancelled'); assert.equal(calls, 0);
  } finally { await f.close(); }
});

test('real killed daemon reopens running as persisted, explicit recovery marks unknown and never dispatches it', async () => {
  const f = layout(); let child: ReturnType<typeof spawn> | undefined; let reopened: ReturnType<typeof openDaemonJobs> | undefined;
  try {
    const source = `import {openDaemonJobs} from ${JSON.stringify(path.join(REPO, 'src/app/jobs.ts'))};
      const caps=${JSON.stringify(caps)};
      const jobs=openDaemonJobs({stateFile:${JSON.stringify(f.stateFile)},ownerFile:${JSON.stringify(f.ownerFile)},now:()=>1,id:()=> 'crashed_job',admit:async()=>({allowed:true}),runners:{selected:()=>({id:'selected',caps,detect:async()=>({installed:true}),async *run(){yield {t:'tool',name:'public effect'};process.stdout.write('RUNNING\\n');await new Promise(()=>{});}})}});
      jobs.recover();jobs.submit(${JSON.stringify(input())},${JSON.stringify(A)});setInterval(()=>{},1000);await jobs.runQueued();`;
    child = spawn(process.execPath, ['--input-type=module', '-e', source], { cwd: f.sb.root, env: f.sb.env(), stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise<void>((resolve, reject) => {
      let output = ''; let errors = ''; const timer = setTimeout(() => reject(Error(`synthetic crash fixture timeout ${errors}`)), 3000);
      child!.stdout!.on('data', (chunk) => { output += chunk; if (output.includes('RUNNING\n')) { clearTimeout(timer); resolve(); } });
      child!.stderr!.on('data', (chunk) => { errors += chunk; }); child!.on('exit', (value) => { clearTimeout(timer); if (!output.includes('RUNNING\n')) reject(Error(`synthetic child exit ${value}: ${errors}`)); });
    });
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; child = undefined;
    let calls = 0; reopened = openDaemonJobs({ ...f, now: () => 2, id: () => 'second_job', admit: async () => ({ allowed: true }), runners: { selected() { calls++; throw Error('must not replay'); } } });
    assert.equal(reopened.get(A, 'crashed_job').state, 'running', 'construction never implicitly recovers/replays');
    assert.throws(() => reopened!.runQueued(), code('unavailable')); assert.equal(reopened.recover(), 1);
    assert.equal(reopened.get(A, 'crashed_job').state, 'unknown'); assert.equal(reopened.get(A, 'crashed_job').reason, 'interrupted');
    assert.equal(reopened.submit(input(), A).duplicate, true); await reopened.runQueued(); assert.equal(calls, 0);
    assert.deepEqual(reopened.events(A, 0).events.map((e) => e.state), ['queued', 'running', 'running', 'unknown']);
  } finally { if (child) { const done = once(child, 'exit'); child.kill('SIGKILL'); await done; } await reopened?.close(); f.sb.cleanup(); }
});

test('actual native start COMMIT then error persists running and finite unknown, fences dispatch and recovers without replay', async () => {
  let runs = 0; const f = setup({ runners: { selected: () => runner(async function* () { runs++; yield { t: 'done', code: 0, result: 'must not run' }; }) } });
  let reopened: ReturnType<typeof openDaemonJobs> | undefined;
  const exec = SqliteDatabase.prototype.exec; let commits = 0;
  try {
    f.jobs.recover(); const job = f.jobs.submit(input(), A).job;
    SqliteDatabase.prototype.exec = function (sql) {
      const value = exec.call(this, sql);
      if (sql === 'COMMIT') { commits++; throw new BosunError('conflict', 'PRIVATE post-commit canary'); }
      return value;
    };
    await assert.rejects(f.jobs.runQueued(), unknown); assert.equal(commits, 1); assert.equal(runs, 0);
    assert.throws(() => f.jobs.submit(input(), A), unknown);
    SqliteDatabase.prototype.exec = exec;
    const observed = new SqliteDatabase(f.stateFile, { readOnly: true });
    try { assert.equal(observed.prepare('SELECT state FROM jobs WHERE id=?').get(job.id)!.state, 'running'); assert.equal(observed.prepare('SELECT COUNT(*) AS n FROM job_events').get()!.n, 2); }
    finally { observed.close(); }
    await f.jobs.close();
    reopened = openDaemonJobs({ ...f, runners: { selected: () => { runs++; throw Error('must not replay'); } }, admit: async () => ({ allowed: true }), now: () => 1000000, id: () => 'new_job' });
    assert.equal(reopened.recover(), 1); assert.equal(reopened.get(A, job.id).state, 'unknown'); await reopened.runQueued(); assert.equal(runs, 0);
  } finally { SqliteDatabase.prototype.exec = exec; await reopened?.close(); await f.close(); }
});

test('native queue CAS, rollback/busy proof, scope and close are enforced by the actual owned SQLite store', () => {
  const f = layout(); const owner = new DaemonOwner(f.ownerFile); const store = new SqliteJobStore({ file: f.stateFile, assertOwner: () => owner.assert(), maxQueue: 2 });
  let blocker: SqliteDatabase | undefined;
  try {
    const job = store.create(A, 'cas_job', input(), 1).job;
    assert.equal(store.create(A, 'ignored_job', input(), 2).duplicate, true);
    const running = store.change(A, job.id, 1, { state: 'running', kind: 'state' }, 2); assert.equal(running.version, 2);
    assert.throws(() => store.change(A, job.id, 1, { state: 'unknown', kind: 'state' }, 3), code('conflict')); assert.equal(store.events(A, 0).events.length, 2);
    assert.throws(() => store.get(B, job.id), code('not_found')); assert.throws(() => store.input(B, job.id), code('not_found'));
    blocker = new SqliteDatabase(f.stateFile); blocker.exec('BEGIN IMMEDIATE');
    assert.throws(() => store.change(A, job.id, 2, { state: 'unknown', kind: 'state' }, 3), (e) => code('unavailable')(e) && !(e as BosunError).details?.outcome);
    assert.equal(store.get(A, job.id).state, 'running'); assert.equal(store.events(A, 0).events.length, 2); blocker.exec('ROLLBACK'); blocker.close(); blocker = undefined;
    assert.equal(store.recover(4), 1); assert.equal(store.get(A, job.id).state, 'unknown');
    store.close(); assert.throws(() => store.get(A, job.id), code('unavailable')); assert.throws(() => store.create(A, 'closed_job', input('closed'), 5), code('unavailable'));
    assert.throws(() => new DaemonOwner(f.ownerFile), code('unavailable')); owner.close();
    const next = new DaemonOwner(f.ownerFile); next.close();
    fs.chmodSync(f.dir, 0o755); assert.throws(() => new DaemonOwner(path.join(f.dir, 'refused.db')), code('unavailable')); assert.equal(fs.existsSync(path.join(f.dir, 'refused.db')), false);
  } finally { try { blocker?.exec('ROLLBACK'); } catch {} blocker?.close(); store.close(); owner.close(); f.sb.cleanup(); }
});

test('native event capacity reserves terminal recovery instead of consuming it with runner progress', () => {
  const f = layout(); const owner = new DaemonOwner(f.ownerFile); const store = new SqliteJobStore({ file: f.stateFile, assertOwner: () => owner.assert(), maxQueue: 2, maxJobs: 2, maxEvents: 6 });
  try {
    let job = store.create(A, 'bounded_job', input(), 1).job;
    job = store.change(A, job.id, job.version, { state: 'running', kind: 'state' }, 2);
    for (let i = 0; i < 3; i++) job = store.change(A, job.id, job.version, { state: 'running', kind: 'tool' }, 3 + i);
    assert.throws(() => store.change(A, job.id, job.version, { state: 'running', kind: 'tool' }, 6), code('unavailable'));
    assert.equal(store.get(A, job.id).version, job.version); assert.equal(store.recover(7), 1);
    assert.equal(store.get(A, job.id).state, 'unknown'); assert.equal(store.events(A, 0).events.length, 6);
    assert.throws(() => store.create(A, 'capacity_job', input('capacity'), 8), code('unavailable')); assert.equal(store.list(A).length, 1);
  } finally { store.close(); owner.close(); f.sb.cleanup(); }
});

test('native BEGIN then error positively rolls back and leaves the store usable with no job/events', () => {
  const f = layout(); const owner = new DaemonOwner(f.ownerFile); const store = new SqliteJobStore({ file: f.stateFile, assertOwner: () => owner.assert() });
  const exec = SqliteDatabase.prototype.exec; let transaction: SqliteDatabase | undefined; let begins = 0;
  try {
    SqliteDatabase.prototype.exec = function (sql) { const result = exec.call(this, sql); if (sql === 'BEGIN IMMEDIATE') { transaction = this; begins++; throw Error('PRIVATE after BEGIN'); } return result; };
    assert.throws(() => store.create(A, 'begin_job', input(), 1), (e) => code('unavailable')(e) && !(e as BosunError).details?.outcome);
    assert.equal(begins, 1); assert.equal(transaction!.isTransaction, false); assert.deepEqual(store.list(A), []); assert.deepEqual(store.events(A, 0).events, []);
    SqliteDatabase.prototype.exec = exec;
    assert.equal(store.create(A, 'begin_job', input(), 2).job.state, 'queued');
  } finally { SqliteDatabase.prototype.exec = exec; store.close(); owner.close(); f.sb.cleanup(); }
});

test('unrelated job/authority layouts are rejected before journal or schema writes', () => {
  const f = layout(); const unknownFile = path.join(f.dir, 'unrelated.db');
  const db = new SqliteDatabase(unknownFile); db.exec('CREATE TABLE unrelated (body TEXT); INSERT INTO unrelated VALUES(\'PRIVATE unrelated fixture\');'); db.close(); fs.chmodSync(unknownFile, 0o600);
  const owner = new DaemonOwner(f.ownerFile); const before = footprint(f.dir);
  try {
    assert.throws(() => new SqliteJobStore({ file: unknownFile, assertOwner: () => owner.assert() }), code('unavailable'));
    assert.deepEqual(footprint(f.dir), before);
    assert.throws(() => new DaemonOwner(unknownFile), code('unavailable')); assert.deepEqual(footprint(f.dir), before);
    const inspect = new SqliteDatabase(unknownFile, { readOnly: true });
    try { assert.equal(inspect.prepare('PRAGMA journal_mode').get()!.journal_mode, 'delete'); assert.equal(inspect.prepare('SELECT body FROM unrelated').get()!.body, 'PRIVATE unrelated fixture'); }
    finally { inspect.close(); }
  } finally { owner.close(); f.sb.cleanup(); }
});
