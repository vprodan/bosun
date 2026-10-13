import './bootstrap.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { sandbox, fresh, gitRepo } from './helpers.ts';
import { runtimePaths } from '../src/platform/paths.ts';
import { project, memoryScope } from '../src/platform/project.ts';
import { contentHash } from '../src/platform/content-hash.ts';
import { parseRuntimeConfig } from '../src/platform/config.ts';
import { openDaemonJobs } from '../src/app/jobs.ts';
import { openDaemonMemory } from '../src/app/memory.ts';
import { initializeMemory } from '../src/adapters/memory/sqlite-initialize.ts';
import { cutoverMemory, publishMemoryView } from '../src/adapters/memory/sqlite-cutover.ts';
import { createDispatcher } from '../src/app/dispatcher.ts';
import { callLocalRpc } from '../src/adapters/transport/local-rpc.ts';
import { serveLocalRpc } from '../src/adapters/transport/local-rpc-server.ts';
import { methodParams, METHODS } from '../src/contracts/methods.ts';
import type { RpcRequest, RpcScope } from '../src/contracts/rpc.ts';
import { BosunError } from '../src/core/errors.ts';
import { modelMemoryReply } from '../src/core/memory-presentation.ts';
import type { AgentRunner } from '../src/core/ports/runner.ts';
import { ADMIN_RUNNER, createAdminRunner } from '../src/app/admin-jobs.ts';

let counter = 0;
async function fixture() {
  const sb = sandbox(); fresh(sb); const workspace = gitRepo(sb, 'workspace'); const other = gitRepo(sb, 'other');
  const paths = runtimePaths({ BOSUN_HOME: path.join(sb.home, '.bosun'), BOSUN_SOCKET: path.join(process.env.BOSUN_TEST_RUN_ROOT!, `d${process.pid}_${++counter}`) });
  for (const dir of [paths.home, paths.run, path.dirname(paths.view), paths.backups]) fs.mkdirSync(dir, { mode: 0o700 });
  const config = parseRuntimeConfig(''); let calls = 0; let scheduled = 0;
  const runner: AgentRunner = { id: 'selected', caps: { vendor: 'synthetic', readOnly: 'verified', sandbox: 'tool-allowlist', mcpInject: 'unsupported', effort: 'verified', localBackend: 'unsupported', billing: 'unknown' },
    detect: async () => ({ installed: true }), async *run(spec) { calls++; assert.equal(spec.model, 'PINNED_MODEL'); assert.equal(spec.cwd, workspace); yield { t: 'done', code: 0, result: 'Public result' }; } };
  const jobs = openDaemonJobs({ stateFile: paths.state, ownerFile: path.join(paths.run, 'owner.db'), runners: { selected: () => runner,
    [ADMIN_RUNNER]: () => createAdminRunner(memory, (root, id) => dispatcher.indexWorkspace(root, id)) }, admit: async () => ({ allowed: true }) }); jobs.recover();
  const cutoverPaths = { primary: paths.memory, view: paths.view, backups: paths.backups };
  initializeMemory({ file: paths.memory, assertOwner: jobs.assertOwner, now: Date.now });
  await cutoverMemory({ paths: cutoverPaths, now: Date.now, id: crypto.randomUUID }); await publishMemoryView({ paths: cutoverPaths, now: Date.now, id: crypto.randomUUID });
  const context = { now: Date.now, monotonic: () => performance.now(), hash: contentHash, dateLabel: (at: number) => new Date(at).toISOString().slice(0, 10), measure() {} };
  const memory = openDaemonMemory({ paths: cutoverPaths, assertOwner: jobs.assertOwner,
    memory: { now: Date.now, monotonic: () => performance.now(), retention: { sessionTtlDays: 7, purgeAfterDays: 90 }, id: now => `m_${now.toString(32).padStart(9, '0')}${(++counter).toString(16).padStart(8, '0')}`, hash: contentHash, measure() {} },
    context, docsIndex: { monotonic: () => performance.now(), measure() {} }, publicationId: crypto.randomUUID });
  const dispatcher = createDispatcher({ jobs, memory, config, context, status: () => ({ state: 'running' }), schedule() { scheduled++; } });
  const server = await serveLocalRpc({ socket: paths.socket, assertOwner: jobs.assertOwner, dispatch: dispatcher.dispatch });
  const scope = (audience: RpcScope['audience'], root = workspace): RpcScope => ({ workspace: root, sessionId: null, audience });
  async function call<T = any>(method: string, params: Record<string, unknown>, audience: RpcScope['audience'] = 'owner', root = workspace): Promise<T> {
    return callLocalRpc<T>({ socket: paths.socket, request: { version: 1, id: `request_${++counter}`, method, params, scope: scope(audience, root) } });
  }
  return { sb, paths, workspace, other, jobs, memory, dispatcher, scope, call, calls: () => calls, scheduled: () => scheduled,
    async close() { server.stopAdmission(); await jobs.drain(); await server.close(); dispatcher.close(); await memory.close(); await jobs.close(); sb.cleanup(); } };
}

test('one shared method table applies real schemas and privacy before prompt getters', () => {
  assert.ok(Object.hasOwn(METHODS, 'memory.store')); let payload = 0;
  const request: RpcRequest = { version: 1, id: 'r', method: 'job.submit', params: { privacy: 'private', get prompt() { payload++; throw Error('PRIVATE'); } } };
  assert.throws(() => methodParams(request), (e: unknown) => e instanceof BosunError && e.code === 'private_input'); assert.equal(payload, 0);
  assert.throws(() => methodParams({ ...request, method: 'memory.maintain', params: { action: 'expire' }, scope: { workspace: '/test', sessionId: null, audience: 'model' } }));
  const model: RpcScope = { workspace: '/test', sessionId: null, audience: 'model' };
  assert.throws(() => methodParams({ ...request, method: 'memory.search', params: { includePrivate: true }, scope: model }));
  assert.throws(() => methodParams({ ...request, method: 'memory.update', params: { id: 'm_one', expectedVersion: 1, patch: { private: false } }, scope: model }));
  const denied = { private: true, get title() { payload++; throw Error('PRIVATE'); }, get body() { payload++; throw Error('PRIVATE'); } };
  assert.deepEqual(modelMemoryReply(denied as never), { memory: { private: true } }); assert.equal(payload, 0);
});

test('actual UDS methods share scoped memory/context and keep private owner records out of model replies/mutations', async () => {
  const f = await fixture();
  try {
    const publicNote = (await f.call('memory.store', { category: 'project', title: 'Zebra strategy', body: 'Zebra strategy uses pnpm' })).memory;
    const privateNote = (await f.call('memory.store', { category: 'project', title: 'SECRET_CANARY', body: 'Zebra strategy PRIVATE_CANARY', private: true })).memory;
    assert.deepEqual(await f.call('memory.get', { id: privateNote.id }, 'model'), { memory: { private: true } });
    const hits = await f.call('memory.search', { text: 'zebra strategy' }, 'model'); assert.deepEqual(hits.hits.map((m: any) => m.id), [publicNote.id]);
    await assert.rejects(f.call('memory.get', { id: publicNote.id }, 'owner', f.other), (e: unknown) => e instanceof BosunError && e.code === 'not_found');
    const before = await f.call('memory.get', { id: privateNote.id, events: true });
    for (const [method, params] of [['memory.update', { id: privateNote.id, expectedVersion: 1, patch: { title: 'guess' } }], ['memory.delete', { id: privateNote.id }]] as const) {
      await assert.rejects(f.call(method, params, 'model'), (e: unknown) => e instanceof BosunError && e.code === 'not_found' && !e.message.includes('CANARY'));
    }
    assert.deepEqual(await f.call('memory.get', { id: privateNote.id, events: true }), before);
    const context = await f.call('context.retrieve', { task: 'zebra strategy', sources: ['curated'] }, 'model'); assert.ok(context.text.includes('pnpm')); assert.equal(JSON.stringify(context).includes('CANARY'), false);
    fs.writeFileSync(path.join(f.workspace, 'guide.md'), '# Falcon migration\nFalcon migration uses SQLite.');
    assert.deepEqual((await f.call('context.retrieve', { task: 'falcon migration', sources: ['docs'] }, 'model')).ids, []);
    const indexing = await f.call('docs.index', {}); assert.equal(indexing.job.ownerOnly, true); await f.jobs.runQueued();
    const docs = await f.call('context.retrieve', { task: 'falcon migration', sources: ['docs'] }, 'model'); assert.deepEqual(docs.ids, ['guide.md']); assert.equal(docs.sources.curated, undefined);
    await assert.rejects(f.call('docs.index', {}, 'model'), (e: unknown) => e instanceof BosunError && e.code === 'unsupported');
  } finally { await f.close(); }
});

test('actual job methods persist request dedupe, selected execution, scoped progress and explicit cancellation', async () => {
  const f = await fixture();
  try {
    const params = { privacy: 'public', requestId: 'same_request', taskId: 'one_task', runnerId: 'selected', prompt: 'Public task', access: 'read', model: 'PINNED_MODEL' };
    const submitted = await f.call('job.submit', params); const duplicate = await f.call('job.submit', params);
    assert.equal(duplicate.duplicate, true); assert.equal(duplicate.job.id, submitted.job.id); assert.equal(f.calls(), 0); assert.equal(f.scheduled(), 2);
    await f.jobs.runQueued(); assert.equal(f.calls(), 1);
    assert.equal((await f.call('job.get', { id: submitted.job.id })).state, 'succeeded'); assert.deepEqual(await f.call('job.result', { id: submitted.job.id }), { result: 'Public result' });
    const events = await f.call('job.events', { after: 0 }); assert.equal(events.events.at(-1).state, 'succeeded'); assert.equal(JSON.stringify(events).includes('Public task'), false);
    await assert.rejects(f.call('job.get', { id: submitted.job.id }, 'owner', f.other), (e: unknown) => e instanceof BosunError && e.code === 'not_found');
    const queued = await f.call('job.submit', { ...params, requestId: 'second_request' }); assert.equal((await f.call('job.cancel', { id: queued.job.id })).state, 'cancelled');
    await f.jobs.runQueued(); assert.equal(f.calls(), 1);
    const ctx = memoryScope(project(f.workspace), []); assert.equal(submitted.job.projectId, ctx.projectId);
  } finally { await f.close(); }
});
