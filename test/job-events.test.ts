import './bootstrap.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { sandbox } from './helpers.ts';
import { openDaemonJobs } from '../src/app/jobs.ts';
import { serveLocalRpc, type RpcHandler } from '../src/adapters/transport/local-rpc-server.ts';
import { streamLocalJobEvents } from '../src/adapters/transport/local-rpc.ts';
import { projectJobEvent } from '../src/contracts/job-events.ts';
import { BosunError } from '../src/core/errors.ts';
import type { RpcRequest } from '../src/contracts/rpc.ts';
import type { JobEvent, JobInput } from '../src/core/domain/job.ts';

let serial = 0;
const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const request = (audience: 'model' | 'owner' = 'model', after = 0, workspace = '/synthetic/a'): RpcRequest => ({ version: 1, id: `stream_${++serial}`, method: 'job.events', params: { after, limit: 100 }, scope: { workspace, audience, sessionId: null } });
const event = (seq: number): JobEvent => ({ seq, jobId: 'job_public', state: 'queued', version: 1, at: 1000, kind: 'created', reason: null });
const input = (id: string, ownerOnly = false): JobInput => ({ privacy: 'public', requestId: id, taskId: id, runnerId: 'selected', prompt: 'SOURCE_PROMPT_CANARY', cwd: '/synthetic/a', model: 'selected', access: 'edit', ownerOnly });
async function fixture(handler?: RpcHandler, timing = { pollMs: 5, heartbeatMs: 20, stallMs: 200, lifetimeMs: 2000 }, authority?: () => void) {
  const sb = sandbox(); const dir = path.join(sb.root, 'events'); fs.mkdirSync(dir, { mode: 0o700 });
  const socket = path.join(process.env.BOSUN_TEST_RUN_ROOT!, `s${process.pid}_${++serial}`);
  const jobs = openDaemonJobs({ stateFile: path.join(dir, 'state.db'), ownerFile: path.join(dir, 'owner.db'), runners: {} }); jobs.recover();
  const ExistingRequest = globalThis.Request;
  const server = await serveLocalRpc({ socket, assertOwner() { jobs.assertOwner(); authority?.(); }, events: timing, dispatch: handler ?? (async query => {
    assert.equal(query.method, 'job.events'); return jobs.events({ projectId: query.scope!.workspace.endsWith('/a') ? 'p_a' : 'p_b', audience: query.scope!.audience }, Number(query.params.after), Number(query.params.limit));
  }) });
  assert.equal(globalThis.Request, ExistingRequest);
  return { sb, dir, socket, jobs, server, async close() { server.stopAdmission(); await server.close(); await jobs.close(); sb.cleanup(); } };
}
async function collect(socket: string, query: RpcRequest, count: number): Promise<JobEvent[]> {
  const result: JobEvent[] = [];
  for await (const row of streamLocalJobEvents({ socket, request: query, signal: AbortSignal.timeout(2000) })) { result.push(row); if (result.length === count) break; }
  return result;
}
async function raw(socket: string, query: RpcRequest): Promise<{ request: http.ClientRequest; response: http.IncomingMessage }> {
  const body = JSON.stringify(query);
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: socket, method: 'POST', path: '/events', agent: false, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, response => {
      response.on('error', () => {}); resolve({ request: req, response });
    }); req.on('error', reject); req.end(body);
  });
}

test('actual Hono SSE uses one native scoped writer, excludes owner rows/content, resumes exact cursor and disconnect never cancels jobs', async () => {
  const f = await fixture();
  try {
    const first = f.jobs.submit(input('public_a'), { projectId: 'p_a' }).job;
    const owner = f.jobs.submit(input('owner_a', true), { projectId: 'p_a' }).job;
    const second = f.jobs.submit(input('public_b'), { projectId: 'p_a' }).job;
    const other = f.jobs.submit(input('other_project'), { projectId: 'p_b' }).job;
    const model = await collect(f.socket, request(), 2); assert.deepEqual(model.map(row => row.jobId), [first.id, second.id]); assert.equal(JSON.stringify(model).includes('CANARY'), false);
    const resumed = await collect(f.socket, request('model', model[0].seq), 1); assert.deepEqual(resumed, [model[1]]);
    const all = await collect(f.socket, request('owner'), 3); assert.deepEqual(all.map(row => row.jobId), [first.id, owner.id, second.id]);
    const scoped = await collect(f.socket, request('model', 0, '/synthetic/b'), 1); assert.equal(scoped[0].jobId, other.id);
    await tick(); assert.equal(f.server.activeStreams(), 0); assert.equal(f.jobs.get({ projectId: 'p_a' }, first.id).state, 'queued'); assert.equal(f.jobs.get({ projectId: 'p_a' }, first.id).cancelRequested, false);
  } finally { await f.close(); }
  let owned = true;
  const lost = await fixture(undefined, undefined, () => { if (!owned) throw Error('PRIVATE_OWNER_CANARY'); });
  try {
    const connected = await raw(lost.socket, request()); owned = false;
    let body = '';
    try { for await (const chunk of connected.response) body += chunk; } catch { /* native peer close is also finite loss */ }
    await tick(); assert.equal(lost.server.activeStreams(), 0); assert.equal(body.includes('PRIVATE_OWNER_CANARY'), false);
    assert.equal(lost.jobs.list({ projectId: 'p_a' }).length, 0); connected.request.destroy();
  } finally { await lost.close(); }
});

test('closed SSE projection ignores unknown content/getters, rejects malformed metadata, and never serializes raw callback errors', async () => {
  let reads = 0; let failure = false;
  const f = await fixture(async query => {
    if (failure) throw Error('PRIVATE_PROVIDER_ERROR_CANARY');
    const seq = Number(query.params.after) + 1;
    return { cursor: seq, events: [{ ...event(seq), get prompt(): never { reads++; throw Error('PRIVATE_GETTER_CANARY'); }, providerSecret: 'PRIVATE_EXTRA_CANARY' }] };
  });
  try {
    const rows = await collect(f.socket, request(), 1); assert.deepEqual(rows, [event(1)]); assert.equal(reads, 0);
    assert.throws(() => projectJobEvent({ ...event(1), state: 'PRIVATE_STATE_CANARY' }), (error: unknown) => error instanceof BosunError && !error.message.includes('CANARY'));
    failure = true;
    await assert.rejects(collect(f.socket, request(), 1), (error: unknown) => error instanceof BosunError && error.code === 'unavailable' && !error.message.includes('CANARY'));
  } finally { await f.close(); }
});

test('invalid event mutation/body is refused before dispatch and native subscriptions are capped, closed by admission stop', async () => {
  let calls = 0; const f = await fixture(async query => { calls++; return { cursor: query.params.after, events: [] }; });
  const clients: Awaited<ReturnType<typeof raw>>[] = [];
  try {
    const rejected = await raw(f.socket, { ...request(), method: 'job.cancel', params: { id: 'job_a' } });
    let text = ''; for await (const part of rejected.response) text += part; assert.equal(JSON.parse(text).error.code, 'invalid'); assert.equal(calls, 0);
    for (let i = 0; i < 16; i++) { const client = await raw(f.socket, request()); clients.push(client); client.response.resume(); }
    assert.equal(f.server.activeStreams(), 16);
    const capped = await raw(f.socket, request()); let body = ''; for await (const part of capped.response) body += part; assert.equal(JSON.parse(body).error.code, 'unavailable');
    f.server.stopAdmission(); await tick(); assert.equal(f.server.activeStreams(), 0);
  } finally { clients.forEach(client => { client.response.destroy(); client.request.destroy(); }); await f.close(); }
});

test('event lifetime terminates finite producers, stops polling, and creates no job effects', async () => {
  let calls = 0;
  const f = await fixture(async query => { calls++; return { cursor: query.params.after, events: [] }; }, { pollMs: 5, heartbeatMs: 10, stallMs: 100, lifetimeMs: 80 });
  try {
    await assert.rejects(collect(f.socket, request(), 1), (error: unknown) => error instanceof BosunError && error.code === 'unavailable');
    assert.equal(f.server.activeStreams(), 0); const completed = calls; await tick(30); assert.equal(calls, completed); assert.equal(f.jobs.list({ projectId: 'p_a' }).length, 0);
  } finally { await f.close(); }
});

test('drain retains native authority until an in-flight SSE callback positively settles after disconnect', async () => {
  const entered = deferred(); const finish = deferred(); let aborted = false;
  const f = await fixture(async (query, signal) => { entered.resolve(); await finish.promise; aborted = signal.aborted; return { cursor: query.params.after, events: [] }; });
  const query = request(); const body = JSON.stringify(query);
  const req = http.request({ socketPath: f.socket, method: 'POST', path: '/events', agent: false, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }); req.on('error', () => {}); req.end(body);
  try {
    await entered.promise; f.server.stopAdmission(); let closed = false; const operation = f.server.close().then(() => { closed = true; });
    await tick(); assert.equal(closed, false); f.jobs.assertOwner(); finish.resolve(); await operation; assert.equal(aborted, true); assert.equal(f.server.activeStreams(), 0);
  } finally { finish.resolve(); req.destroy(); await f.close(); }
});

test('actual paused native SSE consumer reaches bounded backpressure hold before lifetime expiry and polling stops', async () => {
  let calls = 0;
  const f = await fixture(async query => {
    calls++; const after = Number(query.params.after); const size = Number(query.params.limit);
    return { cursor: after + size, events: Array.from({ length: size }, (_, i) => event(after + i + 1)) };
  }, { pollMs: 5, heartbeatMs: 20, stallMs: 50, lifetimeMs: 2000 });
  let connected: Awaited<ReturnType<typeof raw>> | undefined;
  try {
    connected = await raw(f.socket, request()); connected.response.pause();
    const deadline = Date.now() + 1000;
    while (f.server.activeStreams() && Date.now() < deadline) await tick(10);
    assert.equal(f.server.activeStreams(), 0); assert.ok(calls > 1 && calls < 1000);
    const count = calls; await tick(30); assert.equal(calls, count); assert.equal(f.jobs.list({ projectId: 'p_a' }).length, 0);
  } finally { connected?.response.destroy(); connected?.request.destroy(); await f.close(); }
});
