import './bootstrap.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { createElement } from 'react';
import { renderToString } from 'ink';
import { sandbox, fresh, gitRepo } from './helpers.ts';
import { BosunError } from '../src/core/errors.ts';
import { dashboardSnapshot, DashboardView, readDashboard, runDashboard, performDashboardAction, reconcileDashboardAction } from '../src/app/dashboard.ts';
import { serveLocalRpc } from '../src/adapters/transport/local-rpc-server.ts';
import { RPC_LIMITS } from '../src/contracts/rpc.ts';
import { runtimePaths } from '../src/platform/paths.ts';
import { defaultConfig } from '../src/core/domain/config.ts';
import { setupRuntime } from '../src/app/setup.ts';
import { startDaemon } from '../src/app/daemon.ts';
import { callLocalRpc } from '../src/adapters/transport/local-rpc.ts';
import { main } from '../src/app/cli.ts';
import { project } from '../src/platform/project.ts';
import type { AgentRunner } from '../src/core/ports/runner.ts';

const code = (value: string) => (error: unknown) => error instanceof BosunError && error.code === value;
const metadata = () => ({ status: { state: 'running', primaryHost: 'opencode', version: '0.2.0', prompt: 'STATUS_CANARY' },
  jobs: { jobs: [{ id: 'job_a', runnerId: 'codex', state: 'unknown', reason: 'runner_lost', prompt: 'PROMPT_CANARY' }] },
  usage: { attempts: [{ jobId: 'job_a', model: 'selected-model', effort: 'high', generation: 1, tokensIn: null, tokensOut: 5, kind: 'api', qualification: 'unverified', result: 'RESULT_CANARY' }] },
  quota: { state: 'blocked', buckets: [{ source: 'codex-app-server', unit: 'work-codex', state: 'blocked', model: null, accountId: 'ACCOUNT_CANARY',
    windows: [{ id: 'short', durationMinutes: 300, remainingPercent: 80, resetsAt: 1000000, blocked: false }, { id: 'weekly', durationMinutes: 10080, remainingPercent: 5, resetsAt: 2000000, blocked: true }] }] },
  artifacts: { artifacts: [{ id: 'artifact_a', createdAt: 1000, objective: 'OBJECTIVE_CANARY' }] } });

test('actual Ink views render stable closed metadata, preserve unknown counts/billing and distinguish weekly holds without terminal injection', () => {
  const value = metadata(); let accesses = 0;
  Object.defineProperty(value.jobs.jobs[0], 'prompt', { enumerable: true, get() { accesses++; throw Error('PROMPT_CANARY'); } });
  value.usage.attempts[0].model = '\x1b[2Jselected-model\n';
  const snapshot = dashboardSnapshot(value); assert.equal(accesses, 0); assert.equal(JSON.stringify(snapshot).includes('CANARY'), false);
  assert.equal(snapshot.usage.attempts[0].model.includes('\x1b'), false); assert.equal(snapshot.usage.attempts[0].model.includes('\n'), false);
  const render = (tab: number) => renderToString(createElement(DashboardView, { value: { connection: 'connected', stream: 'live', snapshot }, tab }));
  for (let tab = 0; tab < 4; tab++) { assert.equal(render(tab), render(tab)); assert.equal(render(tab).includes('CANARY'), false); }
  assert.ok(render(0).includes('unknown')); assert.ok(render(1).includes('weekly (10080 min): 5%')); assert.ok(render(1).includes('held'));
  assert.ok(render(2).includes('in unknown')); assert.ok(render(2).includes('billing unknown')); assert.equal(render(2).includes('billing api'), false);
  const secret = metadata(); secret.usage.attempts[0].model = 'api_key=' + 'x'.repeat(40);
  assert.equal(dashboardSnapshot(secret).usage.attempts[0].model, 'withheld');
  const dense = metadata(); dense.quota.buckets = Array.from({ length: 128 }, () => metadata().quota.buckets[0]);
  const denseSnapshot = dashboardSnapshot(dense); const atEnd = renderToString(createElement(DashboardView, { value: { connection: 'disconnected', stream: 'ended', snapshot: denseSnapshot }, tab: 1, offset: 512, rows: 10 }));
  assert.ok(atEnd.includes('last snapshot')); assert.ok(atEnd.includes('of 385')); assert.ok(atEnd.split('\n').length <= 10);
});

test('dashboard refuses model audience and noninteractive live mode before filesystem/socket/terminal effects', async () => {
  const scope = { workspace: '/', sessionId: null, audience: 'model' as const };
  await assert.rejects(readDashboard({ socket: '/outside/socket', scope }), code('unsupported'));
  await assert.rejects(runDashboard({ socket: '/outside/socket', scope, once: true, write() { throw Error('OUTPUT_CANARY'); } }), code('unsupported'));
  await assert.rejects(runDashboard({ socket: '/outside/socket', scope: { ...scope, audience: 'owner' }, stdin: { isTTY: false } as NodeJS.ReadStream, stdout: { isTTY: false } as NodeJS.WriteStream }), code('invalid'));
});

let sequence = 0;
async function fixture(options: { admit?: Parameters<typeof startDaemon>[0]['admit']; runner?: AgentRunner } = {}) {
  const sb = sandbox(); fresh(sb); const workspace = gitRepo(sb, 'workspace'); const other = gitRepo(sb, 'other');
  const env = sb.env({ BOSUN_SOCKET: path.join(process.env.BOSUN_TEST_RUN_ROOT!, `d${process.pid}_${++sequence}`) }); const paths = runtimePaths(env); const config = defaultConfig();
  const runner: AgentRunner = options.runner ?? { id: 'codex', caps: { vendor: 'synthetic', readOnly: 'verified', sandbox: 'none', mcpInject: 'unsupported', effort: 'verified', localBackend: 'unsupported', billing: 'unknown' },
    detect: async () => ({ installed: true }), async *run() { yield { t: 'usage', tokensOut: 5 }; yield { t: 'done', code: 0, result: 'RESULT_CANARY' }; } };
  let runtime: Awaited<ReturnType<typeof startDaemon>>;
  try { await setupRuntime(paths, config); runtime = await startDaemon({ paths, config, runners: { codex: () => runner }, admit: options.admit ?? (async () => ({ allowed: true })) }); }
  catch (error) { sb.cleanup(); throw error; }
  const scope = { workspace, sessionId: null, audience: 'owner' as const };
  async function rpc<T = any>(method: string, params: Record<string, unknown>, location = workspace, audience: 'owner' | 'model' = 'owner') {
    return callLocalRpc<T>({ socket: paths.socket, request: { version: 1, id: `r${++sequence}`, method, params, scope: { ...scope, workspace: location, audience } } });
  }
  async function add(location = workspace) {
    const submitted = await rpc('job.submit', { privacy: 'public', requestId: `request_${++sequence}`, taskId: `task_${++sequence}`, runnerId: 'codex', model: 'PINNED_MODEL', access: 'read', prompt: 'PROMPT_CANARY' }, location);
    let job = await rpc('job.get', { id: submitted.job.id }, location);
    for (let n = 0; n < 200 && ['queued', 'running'].includes(job.state); n++) { await new Promise(resolve => setTimeout(resolve, 5)); job = await rpc('job.get', { id: job.id }, location); }
    assert.equal(job.state, 'succeeded'); return job;
  }
  const facts = (location: string) => ({ objective: 'OBJECTIVE_CANARY', latestSteering: [], constraints: { permissions: [], prohibitions: [], pendingApprovals: [] }, decisions: [], questions: [],
    progress: { completed: [], remaining: [], nextAction: 'Inspect current checkout' }, source: { hostId: 'opencode', sessionId: 'session', model: 'native/model', generation: 0, access: 'edit', completedEventCursor: 'completed', uncertainEffects: [] },
    repository: { projectId: project(location).id, branch: 'main', commit: 'a'.repeat(40), files: [] }, verification: [], runningJobs: [], parentId: null });
  return { sb, workspace, other, env, paths, runtime, scope, rpc, add, facts, async close() { try { await runtime.close(); } finally { sb.cleanup(); } } };
}

test('actual CLI/daemon dashboard snapshot uses scoped metadata only and handoff listing cannot disclose another project or model audience', async () => {
  const f = await fixture();
  try {
    const local = await f.add(); const foreign = await f.add(f.other);
    const artifact = (await f.rpc('handoff.create', { privacy: 'public', requestId: 'local_artifact', facts: f.facts(f.workspace) })).artifact;
    const otherArtifact = (await f.rpc('handoff.create', { privacy: 'public', requestId: 'foreign_artifact', facts: f.facts(f.other) }, f.other)).artifact;
    const snapshot = await readDashboard({ socket: f.paths.socket, scope: f.scope }); assert.deepEqual(snapshot.jobs.jobs.map(row => row.id), [local.id]);
    assert.deepEqual(snapshot.artifacts.artifacts.map(row => row.id), [artifact.id]); assert.equal(snapshot.usage.attempts[0].tokensIn, null); assert.equal(snapshot.usage.attempts[0].tokensOut, 5);
    let out = ''; let err = ''; assert.equal(await main(['dashboard', '--once'], { env: f.env, cwd: f.workspace, stdout: value => out += value, stderr: value => err += value }), 0, err);
    assert.ok(out.includes(local.id)); assert.equal(out.includes(foreign.id), false); assert.equal(out.includes('CANARY'), false);
    await assert.rejects(f.rpc('handoff.list', {}, f.workspace, 'model')); assert.equal(JSON.stringify(await f.rpc('handoff.list', {})).includes(otherArtifact.id), false);
    assert.deepEqual(f.sb.calls(), []);
  } finally { await f.close(); }
});

test('dashboard actions refuse model callers, disconnected/missing selections and unknown effects before any socket access', async () => {
  const snapshot = dashboardSnapshot(metadata()); const value = { connection: 'connected' as const, stream: 'idle' as const, snapshot };
  const options = { socket: '/outside/socket', scope: { workspace: '/', sessionId: null, audience: 'owner' as const }, value, jobId: 'job_a', action: 'release' as const };
  let getters = 0;
  await assert.rejects(performDashboardAction({ ...options, scope: { ...options.scope, audience: 'model' }, get value(): never { getters++; throw Error('PRIVATE_CANARY'); } }), code('unsupported'));
  assert.equal(getters, 0);
  assert.equal((await performDashboardAction({ ...options, value: { ...value, connection: 'disconnected' } })).reason, 'disconnected');
  assert.equal((await performDashboardAction({ ...options, jobId: 'absent' })).reason, 'selection_unavailable');
  assert.equal((await performDashboardAction(options)).reason, 'action_unavailable');
  assert.equal((await performDashboardAction({ ...options, action: 'cancel' })).reason, 'action_unavailable');
});

test('dashboard lost mutation receipt stays unknown, is never retried and needs a fresh observed version for manual reconciliation', async () => {
  const socket = path.join(process.env.BOSUN_TEST_RUN_ROOT!, `a${process.pid}_${++sequence}`); let effects = 0;
  const server = await serveLocalRpc({ socket, assertOwner() {}, async dispatch(request) {
    assert.equal(request.method, 'job.cancel'); assert.deepEqual(request.params, { id: 'job_a' }); assert.equal(request.scope!.audience, 'owner');
    effects++; return 'PROVIDER_CANARY' + 'x'.repeat(RPC_LIMITS.responseBytes);
  } });
  try {
    const data = metadata(); data.jobs.jobs[0].state = 'running';
    const snapshot = dashboardSnapshot(data); snapshot.jobs.jobs[0].version = 1;
    const options = { socket, scope: { workspace: process.env.BOSUN_TEST_RUN_ROOT!, sessionId: null, audience: 'owner' as const },
      value: { connection: 'connected' as const, stream: 'idle' as const, snapshot }, jobId: 'job_a', action: 'cancel' as const };
    const action = await performDashboardAction(options); assert.equal(action.state, 'unknown'); assert.equal(effects, 1); assert.equal(JSON.stringify(action).includes('CANARY'), false);
    const value = { ...options.value, action }; assert.deepEqual(await performDashboardAction({ ...options, value }), action); assert.equal(effects, 1);
    assert.equal(reconcileDashboardAction(value)!.state, 'unknown'); snapshot.jobs.jobs[0].version = 2; snapshot.jobs.jobs[0].state = 'unknown';
    assert.equal(reconcileDashboardAction(value)!.state, 'unknown'); snapshot.jobs.jobs[0].state = 'cancelled';
    assert.equal(reconcileDashboardAction(value)!.state, 'observed'); assert.equal(effects, 1);
  } finally { await server.close(); }
});

test('dashboard explicit release preserves quota holds, uses the selected scope only and never starts unknown or foreign jobs', async () => {
  let allow = false; let calls = 0;
  const runner: AgentRunner = { id: 'codex', caps: { vendor: 'synthetic', readOnly: 'verified', sandbox: 'none', mcpInject: 'unsupported', effort: 'verified', localBackend: 'unsupported', billing: 'unknown' },
    detect: async () => ({ installed: true }), async *run() { calls++; yield { t: 'done', code: 0, result: 'RESULT_CANARY' }; } };
  const f = await fixture({ runner, admit: async () => allow ? { allowed: true } : { allowed: false, reason: 'quota' } });
  const submit = (location: string) => f.rpc('job.submit', { privacy: 'public', requestId: `held_${++sequence}`, taskId: `task_${sequence}`, runnerId: 'codex',
    model: 'PINNED_MODEL', access: 'read', prompt: 'PROMPT_CANARY' }, location);
  try {
    const local = (await submit(f.workspace)).job; const foreign = (await submit(f.other)).job;
    for (let n = 0; n < 100 && (await f.rpc('job.get', { id: foreign.id }, f.other)).state === 'queued'; n++) await new Promise(resolve => setTimeout(resolve, 5));
    const options = { socket: f.paths.socket, scope: f.scope, value: { connection: 'connected' as const, stream: 'live' as const, snapshot: await readDashboard({ socket: f.paths.socket, scope: f.scope }) }, jobId: local.id, action: 'release' as const };
    const held = await performDashboardAction(options); assert.equal(held.state, 'held'); assert.equal(held.reason, 'quota'); assert.equal(calls, 0);
    const foreignAction = await performDashboardAction({ ...options, jobId: foreign.id }); assert.equal(foreignAction.reason, 'selection_unavailable'); assert.equal(calls, 0);
    allow = true; const released = await performDashboardAction(options); assert.equal(released.state, 'accepted');
    for (let n = 0; n < 100 && ['queued', 'running'].includes((await f.rpc('job.get', { id: local.id })).state); n++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal((await f.rpc('job.get', { id: local.id })).state, 'succeeded'); assert.equal(calls, 1);
    assert.equal((await f.rpc('job.get', { id: foreign.id }, f.other)).state, 'held'); assert.deepEqual(f.sb.calls(), []);
  } finally { await f.close(); }
});

test('dashboard explicit running cancellation is acknowledged without claiming positive completion or retrying unknown effects', async () => {
  let started!: () => void; const began = new Promise<void>(resolve => started = resolve);
  const runner: AgentRunner = { id: 'codex', caps: { vendor: 'synthetic', readOnly: 'verified', sandbox: 'none', mcpInject: 'unsupported', effort: 'verified', localBackend: 'unsupported', billing: 'unknown' },
    detect: async () => ({ installed: true }), async *run(spec) { started(); yield { t: 'tool', name: 'PRIVATE_TOOL_CANARY' };
      await new Promise<void>(resolve => { if (spec.signal.aborted) resolve(); else spec.signal.addEventListener('abort', () => resolve(), { once: true }); }); } };
  const f = await fixture({ runner });
  try {
    const submitted = await f.rpc('job.submit', { privacy: 'public', requestId: 'cancel_visible', taskId: 'task', runnerId: 'codex', model: 'PINNED_MODEL', access: 'read', prompt: 'PROMPT_CANARY' });
    await began; const value = { connection: 'connected' as const, stream: 'live' as const, snapshot: await readDashboard({ socket: f.paths.socket, scope: f.scope }) };
    const response = await performDashboardAction({ socket: f.paths.socket, scope: f.scope, value, jobId: submitted.job.id, action: 'cancel' });
    assert.equal(response.state, 'accepted'); assert.equal(response.reason, 'cancel_requested'); assert.equal(JSON.stringify(response).includes('CANARY'), false);
    for (let n = 0; n < 100 && (await f.rpc('job.get', { id: submitted.job.id })).state === 'running'; n++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal((await f.rpc('job.get', { id: submitted.job.id })).state, 'unknown');
    const final = { ...value, snapshot: await readDashboard({ socket: f.paths.socket, scope: f.scope }) };
    assert.equal((await performDashboardAction({ socket: f.paths.socket, scope: f.scope, value: final, jobId: submitted.job.id, action: 'release' })).reason, 'action_unavailable');
  } finally { await f.close(); }
});

test('live Ink dashboard reacts to native UDS job events and quits with synthetic streams restored and no job cancellation', async () => {
  const f = await fixture(); const input = new PassThrough(); let raw = false; let out = '';
  Object.assign(input, { isTTY: true, isRaw: false, setRawMode(value: boolean) { raw = value; return input; }, ref() { return input; }, unref() { return input; } });
  const output = new Writable({ write(chunk, _encoding, callback) { out += chunk.toString(); callback(); } });
  Object.assign(output, { isTTY: true, columns: 100, rows: 24 });
  const running = runDashboard({ socket: f.paths.socket, scope: f.scope, stdin: input as unknown as NodeJS.ReadStream, stdout: output as unknown as NodeJS.WriteStream, stderr: output as unknown as NodeJS.WriteStream });
  try {
    for (let n = 0; n < 200 && !out.includes('No jobs in this project'); n++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(out.includes('No jobs in this project')); const job = await f.add();
    for (let n = 0; n < 200 && !out.includes(job.id); n++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(out.includes(job.id)); input.write('3');
    for (let n = 0; n < 200 && !out.includes('Native attempt counts'); n++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(out.includes('Native attempt counts')); assert.equal(out.includes('CANARY'), false);
    input.write('q'); await running; assert.equal(raw, false); assert.equal((await f.rpc('job.get', { id: job.id })).state, 'succeeded');
    assert.deepEqual(f.sb.calls(), []);
  } finally { input.write('q'); try { await running; } finally { input.destroy(); output.destroy(); await f.close(); } }
});

test('live Ink keys bind cancel/release to the selected job, preserve a hold and restore the terminal after explicit actions', async () => {
  let allow = false; let calls = 0;
  const runner: AgentRunner = { id: 'codex', caps: { vendor: 'synthetic', readOnly: 'verified', sandbox: 'none', mcpInject: 'unsupported', effort: 'verified', localBackend: 'unsupported', billing: 'unknown' },
    detect: async () => ({ installed: true }), async *run() { calls++; yield { t: 'done', code: 0, result: 'RESULT_CANARY' }; } };
  const f = await fixture({ runner, admit: async () => allow ? { allowed: true } : { allowed: false, reason: 'quota' } });
  const input = new PassThrough(); let raw = false; let out = '';
  Object.assign(input, { isTTY: true, isRaw: false, setRawMode(value: boolean) { raw = value; return input; }, ref() { return input; }, unref() { return input; } });
  const output = new Writable({ write(chunk, _encoding, callback) { out += chunk.toString(); callback(); } }); Object.assign(output, { isTTY: true, columns: 200, rows: 24 });
  let running: Promise<void> | undefined;
  const wait = async (condition: () => boolean | Promise<boolean>) => { for (let n = 0; n < 300 && !await condition(); n++) await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(await condition(), true); };
  const submit = async () => (await f.rpc('job.submit', { privacy: 'public', requestId: `keys_${++sequence}`, taskId: `task_${sequence}`, runnerId: 'codex',
    model: 'PINNED_MODEL', access: 'read', prompt: 'PROMPT_CANARY' })).job;
  try {
    const first = await submit(); const second = await submit(); await wait(async () => (await f.rpc('job.get', { id: second.id })).state === 'held');
    running = runDashboard({ socket: f.paths.socket, scope: f.scope, stdin: input as unknown as NodeJS.ReadStream, stdout: output as unknown as NodeJS.WriteStream, stderr: output as unknown as NodeJS.WriteStream });
    await wait(() => out.includes(`> held       codex ${second.id}`)); input.write('\u001b[B');
    await wait(() => out.includes(`> held       codex ${first.id}`)); input.write('c');
    await wait(async () => (await f.rpc('job.get', { id: first.id })).state === 'cancelled'); assert.equal((await f.rpc('job.get', { id: second.id })).state, 'held'); assert.equal(calls, 0);
    input.write('\u001b[A'); await wait(() => out.includes(`cancel ${first.id} · accepted`)); input.write('l');
    await wait(() => out.includes(`release ${second.id} · held · quota`)); assert.equal(calls, 0); assert.equal((await f.rpc('job.get', { id: second.id })).state, 'held');
    // The first mutation and its metadata callbacks settle before a second
    // explicitly selected action; no automatic hold release or retry occurs.
    await new Promise(resolve => setTimeout(resolve, 150)); allow = true; input.write('l');
    await wait(async () => (await f.rpc('job.get', { id: second.id })).state === 'succeeded'); assert.equal(calls, 1);
    input.write('q'); await running; assert.equal(raw, false); assert.equal(out.includes('CANARY'), false); assert.deepEqual(f.sb.calls(), []);
  } finally { input.write('q'); try { await running; } finally { input.destroy(); output.destroy(); await f.close(); } }
});
