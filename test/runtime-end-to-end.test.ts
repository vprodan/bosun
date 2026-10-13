import './bootstrap.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { BIN, bosun, claudeMemDb, mock, REPO } from './helpers.ts';
import { parseRuntimeConfig } from '../src/platform/config.ts';
import { setupRuntime } from '../src/app/setup.ts';
import { main } from '../src/app/cli.ts';
import { callLocalRpc } from '../src/adapters/transport/local-rpc.ts';
import { project } from '../src/platform/project.ts';
import { runtimeFixture as fixture } from './runtime-fixture.ts';
import type { AgentRunner } from '../src/core/ports/runner.ts';
import { DaemonOwner } from '../src/platform/daemon-owner.ts';
import { openDaemonJobs } from '../src/app/jobs.ts';
import { BosunError } from '../src/core/errors.ts';

let sequence = 0;

test('new setup, actual daemon and Commander CLI share authoritative data and pinned queued execution', async () => {
  const f = await fixture();
  try {
    assert.equal(f.manifest.state, 'ready'); assert.equal(fs.statSync(f.paths.manifest).mode & 0o777, 0o600);
    const status = await f.cli(['status']); assert.equal(status.code, 0, status.err); assert.equal(JSON.parse(status.out).state, 'running');
    const add = await f.cli(['memory', 'add', '--category', 'project', '--title', 'Zebra strategy', '--body', 'Zebra strategy uses pnpm']);
    assert.equal(add.code, 0, add.err); const note = JSON.parse(add.out).memory;
    const get = await f.cli(['memory', 'get', note.id]); assert.equal(get.code, 0); assert.equal(JSON.parse(get.out).memory.body, note.body);
    const search = await f.cli(['memory', 'search', 'zebra strategy']); assert.equal(search.code, 0); assert.equal(JSON.parse(search.out).hits[0].id, note.id);
    const context = await f.cli(['context', 'zebra strategy']); assert.equal(context.code, 0); assert.ok(JSON.parse(context.out).text.includes('pnpm'));
    const run = await f.cli(['run', '-e', 'codex', '--model', 'PINNED', '--read-only', '--request-id', 'stable_request', 'Public task']);
    assert.equal(run.code, 0, run.err); const queued = JSON.parse(run.out).job;
    let job = await f.rpc('job.get', { id: queued.id });
    for (let n = 0; n < 100 && ['queued', 'running'].includes(job.state); n++) { await new Promise(r => setTimeout(r, 10)); job = await f.rpc('job.get', { id: queued.id }); }
    assert.equal(job.state, 'succeeded'); assert.equal(f.calls(), 1);
    const usage = await f.cli(['usage']); assert.equal(usage.code, 0, usage.err);
    const attempt = JSON.parse(usage.out).attempts.find((row: { jobId: string }) => row.jobId === job.id);
    assert.equal(attempt.model, 'PINNED'); assert.equal(attempt.runnerId, 'codex'); assert.equal(attempt.state, 'succeeded'); assert.equal(attempt.kind, 'unknown'); assert.equal(attempt.vendor, null);
    assert.equal(attempt.tokensIn, null); assert.equal(attempt.tokensOut, null); assert.equal(JSON.stringify(attempt).includes('Public task'), false);
    const deniedUsage = await main(['usage'], { env: { ...f.env, BOSUN_CALLER: 'model' }, cwd: f.workspace, stdout() {}, stderr() {} }); assert.notEqual(deniedUsage, 0);
    const retention = await f.cli(['job', 'retention']); assert.equal(retention.code, 0, retention.err); const policy = JSON.parse(retention.out);
    assert.equal(policy.days, 30); assert.equal(policy.eligibleJobs, 0); assert.ok(policy.scopedJobs >= 1);
    const prune = await f.cli(['job', 'prune', '--limit', '10']); assert.equal(prune.code, 0, prune.err); assert.equal(JSON.parse(prune.out).jobs, 0);
    const daily = await f.cli(['usage', '--daily']); assert.equal(daily.code, 0, daily.err); assert.deepEqual(JSON.parse(daily.out), { coverage: 'archived-attempts', days: [] });
    const deniedRetention = await main(['job', 'prune'], { env: { ...f.env, BOSUN_CALLER: 'model' }, cwd: f.workspace, stdout() {}, stderr() {} }); assert.notEqual(deniedRetention, 0);
    await assert.rejects(f.rpc('usage.daily', {}, { ...f.scope, audience: 'model' }));
    const notifications = await f.cli(['notifications', 'status']); assert.equal(notifications.code, 0, notifications.err);
    assert.deepEqual(JSON.parse(notifications.out), { enabled: false, state: 'disabled', reason: null, ui: 'unverified', records: null });
    const duplicate = await f.cli(['run', '-e', 'codex', '--model', 'PINNED', '--request-id', 'stable_request', 'Public task']); assert.equal(JSON.parse(duplicate.out).duplicate, true); assert.equal(f.calls(), 1);
    assert.equal((await f.cli(['job', 'result', queued.id])).out.includes('Completed public task'), true);
    assert.equal((await f.cli(['config', 'validate'])).code, 0); assert.deepEqual(f.sb.calls(), []);
    await assert.rejects(setupRuntime(f.paths, parseRuntimeConfig('')), /already contains data/);
  } finally { await f.close(); }
});

test('final daemon shutdown stops queued dispatch before waiting on notification callbacks and retains native ownership until every settlement', async () => {
  function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => resolve = done); return { promise, resolve }; }
  const began = deferred(); const complete = deferred(); const iteratorClosed = deferred(); const notifying = deferred(); const notificationAborted = deferred(); const notified = deferred();
  let runs = 0; let ended = false;
  const runner: AgentRunner = { id: 'codex', caps: { vendor: 'synthetic', readOnly: 'verified', sandbox: 'none', mcpInject: 'unsupported', effort: 'verified', localBackend: 'unsupported', billing: 'unknown' },
    detect: async () => ({ installed: true }), async *run() { runs++; began.resolve(); await complete.promise; yield { t: 'done', code: 0, result: 'Completed public task' }; iteratorClosed.resolve(); } };
  const f = await fixture('[daemon]\ndrainMs = 1000\n[notifications]\nenabled = true\ntimeoutMs = 2000\n', { runner, notificationSink: () => ({ availability: () => ({ available: true }),
    async deliver(payload, signal) { assert.deepEqual(Object.keys(payload).sort(), ['jobRef', 'state']); assert.match(payload.jobRef, /^job_[a-f0-9]{24}$/);
      notifying.resolve(); if (signal.aborted) notificationAborted.resolve(); else signal.addEventListener('abort', notificationAborted.resolve, { once: true });
      await notified.promise; return { phase: 'unknown', reason: 'cancelled', ui: 'unverified' }; } }) });
  let closing: Promise<void> | undefined; let reopened: ReturnType<typeof openDaemonJobs> | undefined;
  const submit = (requestId: string) => f.rpc('job.submit', { privacy: 'public', requestId, taskId: requestId, runnerId: 'codex', model: 'PINNED', access: 'read', prompt: 'Public task' });
  try {
    const first = (await submit('drain_first')).job; await began.promise; await notifying.promise;
    const second = (await submit('drain_second')).job; assert.equal((await f.rpc('job.get', { id: second.id })).state, 'queued');
    closing = f.runtime.close().then(() => { ended = true; }); await notificationAborted.promise;
    complete.resolve(); await iteratorClosed.promise; await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(runs, 1, 'queued work must not start while an auxiliary callback delays shutdown'); assert.equal(ended, false);
    assert.throws(() => new DaemonOwner(f.paths.owner), (error: unknown) => error instanceof BosunError && error.code === 'unavailable');
    notified.resolve(); await closing; assert.equal(ended, true);
    reopened = openDaemonJobs({ stateFile: f.paths.state, ownerFile: f.paths.owner, runners: { codex() { throw Error('Must not replay'); } } }); reopened.recover();
    const scope = { projectId: project(f.workspace).id, audience: 'owner' as const };
    assert.equal(reopened.get(scope, first.id).state, 'succeeded'); assert.equal(reopened.get(scope, second.id).state, 'queued'); assert.equal(runs, 1);
  } finally { complete.resolve(); notified.resolve(); await closing; await reopened?.close(); await f.close(); }
});

test('actual CLI/daemon portable handoff preserves constraints, exports without overwrite and requires manual import review', async () => {
  const f = await fixture();
  try {
    const facts = { objective: 'Continue the approved task', latestSteering: ['One final commit'],
      constraints: { permissions: ['Project dependencies only'], prohibitions: ['Never run Bun tests'], pendingApprovals: [] },
      decisions: [{ fact: 'Preserve the selected native model', source: 'Owner request' }], questions: [],
      progress: { completed: ['Final runtime'], remaining: ['Native qualification'], nextAction: 'Check adapter capabilities' },
      source: { hostId: 'opencode', sessionId: 'ses_fixture', model: 'provider/selected-model', access: 'edit', generation: 0, completedEventCursor: 'completed_2', uncertainEffects: [] },
      repository: { projectId: project(f.workspace).id, branch: 'main', commit: 'a'.repeat(40), files: [] }, verification: [], runningJobs: [], parentId: null };
    const file = path.join(f.sb.root, 'facts.json'); fs.writeFileSync(file, JSON.stringify(facts));
    const created = await f.cli(['handoff', 'create', '--facts', file, '--request-id', 'portable_fixture']); assert.equal(created.code, 0, created.err);
    const artifact = JSON.parse(created.out).artifact;
    const retrieved = await f.cli(['handoff', 'get', artifact.id]); assert.equal(retrieved.code, 0, retrieved.err); assert.deepEqual(JSON.parse(retrieved.out).manifest.facts, facts);
    const listed = await f.cli(['handoff', 'list']); assert.equal(listed.code, 0, listed.err); assert.deepEqual(JSON.parse(listed.out).artifacts.map((value: { id: string }) => value.id), [artifact.id]);
    const exportedFile = path.join(f.sb.root, 'portable.json'); const exported = await f.cli(['handoff', 'export', artifact.id, '--output', exportedFile]);
    assert.equal(exported.code, 0, exported.err); assert.equal(fs.statSync(exportedFile).mode & 0o777, 0o600); const bytes = fs.readFileSync(exportedFile);
    assert.notEqual((await f.cli(['handoff', 'export', artifact.id, '--output', exportedFile])).code, 0); assert.deepEqual(fs.readFileSync(exportedFile), bytes);
    const imported = await f.cli(['handoff', 'import', exportedFile, '--request-id', 'portable_fixture']); assert.equal(imported.code, 0, imported.err);
    assert.equal(JSON.parse(imported.out).continuation, 'manual-review-required'); assert.equal(JSON.parse(imported.out).duplicate, true);
    assert.equal(JSON.parse(imported.out).checkout.base, 'mismatch'); assert.equal(JSON.parse(imported.out).checkout.branch, 'matches');
    assert.equal(f.calls(), 0); assert.deepEqual(f.sb.calls(), []);
    const denied = await main(['handoff', 'get', artifact.id], { env: { ...f.env, BOSUN_CALLER: 'model' }, cwd: f.workspace, stdout() {}, stderr() {} }); assert.notEqual(denied, 0);
  } finally { await f.close(); }
});

test('final CLI/UDS graph review and explicit graph context keep source lineage, scope and revocation in the registered writer', async () => {
  const f = await fixture();
  try {
    assert.equal(f.manifest.memorySchema, 2);
    const note = (await f.rpc('memory.store', { category: 'project', title: 'Zebra package tooling', body: 'The task uses pnpm for package commands.' })).memory;
    const file = path.join(f.sb.root, 'entity.json');
    fs.writeFileSync(file, JSON.stringify({ kind: 'entity', title: 'Reviewed package tool', text: 'Reviewed graph records the package-manager choice.',
      supports: [{ memoryId: note.id, version: note.version, hash: note.hash }], entity: { type: 'tool', key: 'pnpm', aliases: ['zephyr'] } }));
    const created = await f.cli(['graph', 'create', file]); assert.equal(created.code, 0, created.err); const proposed = JSON.parse(created.out).artifact;
    assert.equal(proposed.status, 'proposed');
    const modelScope = { workspace: f.workspace, sessionId: null, audience: 'model' as const };
    const model = <T = any>(method: string, params: Record<string, unknown>) => callLocalRpc<T>({ socket: f.paths.socket,
      request: { version: 1, id: `g${++sequence}`, method, params, scope: modelScope } });
    await assert.rejects(model('graph.get', { id: proposed.id }));
    const accepted = await f.cli(['graph', 'accept', proposed.id, '--version', String(proposed.version)]); assert.equal(accepted.code, 0, accepted.err);
    const artifact = JSON.parse(accepted.out).artifact; assert.equal(artifact.status, 'active');
    const query = await f.cli(['graph', 'query', 'zephyr']); assert.equal(query.code, 0, query.err); assert.equal(JSON.parse(query.out).items[0].id, artifact.id);
    const explanation = await model('graph.explain', { id: artifact.id }); assert.deepEqual(explanation.supports, [{ memoryId: note.id, version: note.version, hash: note.hash }]);
    const ordinary = await f.cli(['context', 'zephyr']); assert.equal(ordinary.code, 0); assert.equal(JSON.parse(ordinary.out).ids.includes(artifact.id), false);
    const explicit = await f.cli(['context', 'zephyr', '--sources', 'graph']); assert.equal(explicit.code, 0, explicit.err);
    assert.ok(JSON.parse(explicit.out).ids.includes(artifact.id)); assert.ok(JSON.parse(explicit.out).text.includes('package-manager'));
    await assert.rejects(model('graph.create', JSON.parse(fs.readFileSync(file, 'utf8'))));
    await f.rpc('memory.update', { id: note.id, expectedVersion: note.version, patch: { private: true } });
    assert.deepEqual((await model('graph.query', { text: 'zephyr', expand: true, depth: 2 })).items, []);
    await assert.rejects(model('graph.get', { id: artifact.id })); assert.deepEqual((await f.rpc('context.retrieve', { task: 'zephyr', sources: ['graph'] })).ids, []);
    assert.equal((await f.rpc('memory.get', { id: note.id })).memory.private, true); assert.deepEqual(f.sb.calls(), []);
  } finally { await f.close(); }
});

test('disabled graph configuration keeps explicit graph retrieval empty without graph setup or native inference', async () => {
  const f = await fixture('[graph]\nenabled = false\n');
  try {
    assert.deepEqual((await f.rpc('graph.query', { text: 'anything' })).items, []);
    assert.deepEqual((await f.rpc('context.retrieve', { task: 'anything', sources: ['graph'] })).ids, []);
    const result = await f.cli(['graph', 'backfill']); assert.notEqual(result.code, 0); assert.equal(f.calls(), 0); assert.deepEqual(f.sb.calls(), []);
  } finally { await f.close(); }
});

test('actual consolidation CLI and daemon retain reviewed proposals, stable requests and private source isolation in the final runtime', async () => {
  const model = 'selected:consolidation:tag';
  const externalCanary = 'CM_UNREVIEWED_SOURCE_CANARY';
  const externalRoot = fs.mkdtempSync(path.join(process.env.BOSUN_TEST_RUN_ROOT!, 'ambient-claude-mem-'));
  const external = path.join(externalRoot, 'claude-mem.db');
  claudeMemDb(external, {
    sums: [{ project: 'workspace', request: externalCanary, learned: externalCanary }],
  });
  const externalBefore = fs.readFileSync(external);
  const server = await mock({
    '/api/tags': () => ({ json: { models: [{ name: model, model }] } }), '/api/show': () => ({ json: { capabilities: ['completion'] } }),
    '/api/chat': body => {
      const payload = JSON.parse(body.messages[1].content); assert.equal(payload.evidence.length, 1);
      assert.equal(JSON.stringify(body).includes('PRIVATE_CANARY'), false); assert.equal(body.model, model);
      return { json: { model, done: true, done_reason: 'stop', prompt_eval_count: 31, eval_count: 11,
        message: { role: 'assistant', content: JSON.stringify({ items: [{ kind: 'fact', title: 'Reviewed zebra package choice', text: 'Use pnpm for the zebra project.',
          citations: [{ evidenceId: payload.evidence[0].id, quote: 'uses pnpm' }], parents: [], entity: null, relation: null }] }) } } };
    },
  });
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    f = await fixture(
      '[graph]\nextraction = true\n[providers.default]\nkind = "ollama"\nmodel = "' +
        model +
        '"\nurl = "' +
        server.url +
        '"\ntimeoutMs = 1000\n',
      { env: { CLAUDE_MEM_DB: external } },
    );
    const note = (await f.rpc('memory.store', { category: 'project', title: 'Zebra package choice', body: 'The zebra project uses pnpm.' })).memory;
    await f.rpc('memory.store', { category: 'project', title: 'PRIVATE_CANARY', body: 'Private source PRIVATE_CANARY', private: true });
    const before = await f.rpc('memory.get', { id: note.id, events: true });
    const requested = await f.cli(['consolidation', 'run', '--request', 'reviewed_window']); assert.equal(requested.code, 0, requested.err);
    const queued = JSON.parse(requested.out).job; assert.equal(queued.ownerOnly, true);
    let job = await f.rpc('job.get', { id: queued.id });
    for (let n = 0; n < 200 && ['queued', 'running'].includes(job.state); n++) { await new Promise(resolve => setTimeout(resolve, 10)); job = await f.rpc('job.get', { id: queued.id }); }
    assert.equal(job.state, 'succeeded');
    const list = await f.cli(['consolidation', 'proposals']); assert.equal(list.code, 0, list.err);
    const proposals = JSON.parse(list.out).proposals; assert.equal(proposals.length, 1); const artifact = proposals[0].artifact;
    assert.equal(proposals[0].kind, 'fact'); assert.equal(artifact.status, 'proposed'); assert.deepEqual(artifact.supports, [{ memoryId: note.id, version: note.version, hash: note.hash }]);
    const modelScope = { workspace: f.workspace, sessionId: null, audience: 'model' as const };
    await assert.rejects(callLocalRpc({ socket: f.paths.socket, request: { version: 1, id: 'deny_proposal', method: 'graph.get', params: { id: artifact.id }, scope: modelScope } }));
    const denied = await main(['consolidation', 'status'], { env: { ...f.env, BOSUN_CALLER: 'model' }, cwd: f.workspace, stdout() {}, stderr() {} }); assert.notEqual(denied, 0);
    await assert.rejects(f.rpc('job.submit', { privacy: 'public', requestId: 'reserved', taskId: 'reserved', runnerId: 'bosun-consolidation', prompt: 'Public task', model, access: 'read' }));
    assert.deepEqual(await f.rpc('memory.get', { id: note.id, events: true }), before);
    const accepted = await f.cli(['graph', 'accept', artifact.id, '--version', String(artifact.version)]); assert.equal(accepted.code, 0, accepted.err);
    assert.equal(JSON.parse(accepted.out).artifact.status, 'active');
    const duplicate = await f.cli(['consolidation', 'run', '--request', 'reviewed_window']); assert.equal(duplicate.code, 0, duplicate.err);
    assert.equal(JSON.parse(duplicate.out).duplicate, true); assert.equal(JSON.parse(duplicate.out).job.id, queued.id);
    const status = await f.cli(['consolidation', 'status']); assert.equal(status.code, 0, status.err);
    assert.equal(JSON.parse(status.out).claim, null); assert.equal(JSON.parse(status.out).outstanding, 0);
    assert.equal(JSON.stringify(server.requests).includes(externalCanary), false);
    assert.deepEqual(fs.readFileSync(external), externalBefore, 'unreviewed ambient source is never read or modified');
    assert.equal(server.requests.filter(request => request.path === '/api/chat').length, 1); assert.equal(f.calls(), 0); assert.deepEqual(f.sb.calls(), []);
  } finally {
    try {
      await f?.close();
      await server.close();
    } finally {
      fs.rmSync(externalRoot, { recursive: true, force: true });
    }
  }
});

test('actual portable profile CLI exports selected models and reviewed instructions, then previews imports without auth, installs or configuration writes', async () => {
  const f = await fixture('[roles.worker.codex]\nmodel = "gpt-6.1-sol"\neffort = "high"\n[roles.worker.opencode]\nmodel = "provider/chosen:tag"\n[providers.default]\nkind = "openai-compatible"\nurl = "https://PRIVATE_ENDPOINT_CANARY.example"\napiKeyEnv = "PRIVATE_AUTH_ENV_CANARY"\n');
  try {
    const note = (await f.rpc('memory.store', { category: 'project', title: 'Reviewed profile support', body: 'The project uses pnpm.' })).memory;
    const created = (await f.rpc('graph.create', { kind: 'profile', title: 'Portable project preferences',
      text: 'Use pnpm for this project.\nworkspace=/Users/private-person/private-project', supports: [{ memoryId: note.id, version: note.version, hash: note.hash }] })).artifact;
    const selected = ['profile', 'export', '--name', 'project-preferences', '--description', 'Use reviewed project preferences when selecting package tools and explicitly configured models.',
      '--roles', 'worker', '--providers', 'default', '--router', '--reviewed-profile', created.id, '--version', String(created.version)];
    assert.notEqual((await f.cli(selected)).code, 0, 'proposed L4 instructions cannot be exported as reviewed');
    const reviewed = JSON.parse((await f.cli(['graph', 'accept', created.id, '--version', String(created.version)])).out).artifact;
    selected[selected.length - 1] = String(reviewed.version);
    const configuration = fs.readFileSync(f.paths.config); const exported = await f.cli(selected); assert.equal(exported.code, 0, exported.err); const bundle = JSON.parse(exported.out);
    assert.equal(bundle.profile.choices.roles.find((binding: { host: string }) => binding.host === 'codex').model, 'gpt-6.1-sol');
    assert.equal(bundle.profile.choices.roles.find((binding: { host: string }) => binding.host === 'opencode').model, 'provider/chosen:tag');
    assert.match(bundle.profile.reviewed.instructions, /Use pnpm/); assert.match(bundle.profile.reviewed.instructions, /RECONFIGURE_LOCALLY/);
    assert.doesNotMatch(exported.out, /PRIVATE_ENDPOINT_CANARY|PRIVATE_AUTH_ENV_CANARY|private-person|private-project/); assert.equal(exported.out.includes(f.workspace), false);
    assert.equal(bundle.profile.choices.providers[0].endpoint, 'RECONFIGURE_LOCALLY'); assert.equal(bundle.profile.choices.providers[0].credential, 'RECONFIGURE_LOCALLY');
    assert.equal(bundle.skill.path, 'project-preferences/SKILL.md'); assert.match(bundle.skill.content, /^---\nname: project-preferences\ndescription:/);
    for (const [format, content] of [['toml', bundle.toml], ['skill', bundle.skill.content]] as const) {
      const raw = await f.cli([...selected, '--format', format]); assert.equal(raw.code, 0, raw.err); assert.equal(raw.out, content);
      const file = path.join(f.sb.root, `portable.${format}`); fs.writeFileSync(file, content);
      const inspected = await f.cli(['profile', 'inspect', file, '--format', format]); assert.equal(inspected.code, 0, inspected.err);
      assert.deepEqual(JSON.parse(inspected.out).profile, bundle.profile); assert.equal(JSON.parse(inspected.out).applies, false);
      const preview = await f.cli(['profile', 'preview', file, '--format', format]); assert.equal(preview.code, 0, preview.err);
      const plan = JSON.parse(preview.out); assert.equal(plan.applies, false); assert.equal(plan.dryRun, true); assert.equal(plan.state, 'held');
      assert.ok(plan.requirements.some((requirement: { state: string }) => requirement.state === 'unverified')); assert.ok(plan.reconfigure.length > 0);
      assert.doesNotMatch(preview.out, /PRIVATE_ENDPOINT_CANARY|PRIVATE_AUTH_ENV_CANARY|private-person/);
    }
    const denied = await main(['profile', 'export', '--name', 'x', '--description', 'Denied export', '--roles', 'worker'],
      { env: { ...f.env, BOSUN_CALLER: 'model' }, cwd: f.workspace, stdout() {}, stderr() {} }); assert.notEqual(denied, 0);
    const malformed = await f.cli(['profile', 'export', '--name', 'x', '--description', 'Invalid selection', '--reviewed-profile', reviewed.id]); assert.notEqual(malformed.code, 0);
    await f.rpc('memory.update', { id: note.id, expectedVersion: note.version, patch: { private: true } }); assert.notEqual((await f.cli(selected)).code, 0);
    assert.deepEqual(fs.readFileSync(f.paths.config), configuration); assert.equal(f.calls(), 0); assert.deepEqual(f.sb.calls(), []);
  } finally { await f.close(); }
});

test('final daemon/CLI uses configured Clef advice without autonomous delegation, private inference or model substitution', async () => {
  const reply = JSON.parse(fs.readFileSync(path.join(REPO, 'test/fixtures/clef-systemone.json'), 'utf8'));
  const digest = 'a'.repeat(64);
  const mockServer = await mock({
    '/api/version': () => ({ json: { version: '0.35.1' } }),
    '/api/tags': () => ({ json: { models: [{ name: 'clef-flash:9b', model: 'clef-flash:9b', digest }] } }),
    '/api/show': () => ({ json: { capabilities: ['decision'], details: { format: 'gguf' }, model_info: { 'general.architecture': 'qwen35', 'qwen35.context_length': 65536 } } }),
    '/api/ps': () => ({ json: { models: [{ name: 'clef-flash:9b', model: 'clef-flash:9b', digest, size: 11000000000, size_vram: 9000000000, context_length: 32768, expires_at: '2099-01-01T00:00:00Z' }] } }),
    '/v1/systemone': () => ({ json: reply }),
  });
  const f = await fixture(`[router]\nurl = ${JSON.stringify(mockServer.url)}\n`);
  try {
    const result = await f.cli(['route', 'Implement refund handling']); assert.equal(result.code, 0, result.err); const advice = JSON.parse(result.out);
    assert.equal(advice.route.decision.router, 'clef-flash:9b'); assert.equal(advice.automaticDispatch, false);
    assert.equal(advice.qualification.calibration, 'unverified'); assert.equal(advice.qualification.liveReadiness, 'unverified'); assert.equal(f.calls(), 0);
    assert.deepEqual(mockServer.requests.map(request => request.path), ['/api/version', '/api/tags', '/api/show', '/api/ps', '/v1/systemone', '/api/version', '/api/tags', '/api/show', '/api/ps']);
    assert.equal(mockServer.requests[4].body.model, 'clef-flash:9b');
    await assert.rejects(f.rpc('route.classify', { privacy: 'private', text: 'PRIVATE_ROUTE_CANARY' }));
    const denied = await f.cli(['route', 'api_key=' + 'x'.repeat(40)]); assert.notEqual(denied.code, 0); assert.equal(denied.err.includes('api_key'), false); assert.equal(mockServer.requests.length, 9);
    const status = await f.cli(['router', 'status']); assert.equal(status.code, 0, status.err); const state = JSON.parse(status.out);
    assert.equal(state.state, 'ready'); assert.equal(state.digest, digest); assert.equal(state.catalogContextTokens, 65536); assert.equal(state.loaded.contextTokens, 32768);
    assert.equal(mockServer.requests.length, 13); assert.equal(mockServer.requests.filter(request => request.path === '/v1/systemone').length, 1);
    const deniedStatus = await main(['router', 'status'], { env: { ...f.env, BOSUN_CALLER: 'model' }, cwd: f.workspace, stdout() {}, stderr() {} }); assert.notEqual(deniedStatus, 0);
    assert.deepEqual(f.sb.calls(), []);
  } finally { await f.close(); await mockServer.close(); }
});

test('real MCP v2 SDK stdio client uses the same methods with fixed model audience and protocol-only stdout', async () => {
  const f = await fixture(); let client: Client | undefined; let transport: StdioClientTransport | undefined;
  try {
    const publicNote = (await f.rpc('memory.store', { category: 'project', title: 'Zebra MCP tools', body: 'Zebra MCP tools use pnpm' })).memory;
    const privateNote = (await f.rpc('memory.store', { category: 'project', title: 'PRIVATE_CANARY', body: 'Zebra MCP PRIVATE_CANARY', private: true })).memory;
    transport = new StdioClientTransport({ command: process.execPath, args: [BIN, 'mcp'], cwd: f.workspace, env: f.env, stderr: 'pipe', maxBufferSize: 1048576 });
    let stderr = ''; transport.stderr?.on('data', chunk => stderr += chunk);
    client = new Client({ name: 'bosun-native-fixture', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } }); await client.connect(transport);
    assert.equal(client.getNegotiatedProtocolVersion(), '2026-07-28'); assert.equal(client.getProtocolEra(), 'modern');
    assert.equal(client.getServerVersion()!.name, 'bosun');
    const listed = await client.listTools(); assert.ok(listed.tools.some(tool => tool.name === 'memory_search'));
    assert.equal(listed.tools.some(tool => tool.name === 'docs_index'), false); assert.equal(listed.tools.some(tool => tool.name === 'memory_maintain'), false);
    const get = await client.callTool({ name: 'memory_get', arguments: { id: publicNote.id } }); assert.equal(get.isError, undefined); assert.ok(JSON.stringify(get).includes('pnpm'));
    const secret = await client.callTool({ name: 'memory_get', arguments: { id: privateNote.id } }); assert.equal(JSON.stringify(secret).includes('CANARY'), false); assert.ok(JSON.stringify(secret).includes('private'));
    const search = await client.callTool({ name: 'memory_search', arguments: { text: 'zebra mcp' } }); assert.ok(JSON.stringify(search).includes(publicNote.id)); assert.equal(JSON.stringify(search).includes(privateNote.id), false);
    const denied = await client.callTool({ name: 'memory_update', arguments: { id: privateNote.id, expectedVersion: 1, patch: { title: 'guess' } } }); assert.equal(denied.isError, true);
    assert.equal((await f.rpc('memory.get', { id: privateNote.id })).memory.title, 'PRIVATE_CANARY');
    assert.equal(stderr.includes('CANARY'), false); assert.deepEqual(f.sb.calls(), []);
  } finally { await client?.close(); await transport?.close(); await f.close(); }
});

test('final binary hook uses one local metadata call and bound read-only notes, with private/absent-daemon behavior', async () => {
  const f = await fixture();
  try {
    const note = (await f.rpc('memory.store', { category: 'project', title: 'Zebra strategy', body: 'Zebra strategy uses pnpm' })).memory;
    await f.rpc('memory.publish', {});
    const input = JSON.stringify({ prompt: 'Please inspect zebra strategy implementation', cwd: f.workspace });
    const hook = await bosun(['hook'], { env: f.env, cwd: f.workspace, input }); assert.equal(hook.code, 0, hook.err);
    assert.ok(JSON.parse(hook.out).hookSpecificOutput.additionalContext.includes('pnpm'));
    const offline = await bosun(['hook'], { env: { ...f.env, BOSUN_SOCKET: path.join(process.env.BOSUN_TEST_RUN_ROOT!, 'missing-socket') }, cwd: f.workspace, input });
    // An override cannot silently rebind a generated snapshot; fail closed.
    assert.equal(offline.code, 0); assert.equal(offline.out, '');
    const denied = await bosun(['hook'], { env: f.env, cwd: f.workspace, input: JSON.stringify({ prompt: 'PRIVATE_CANARY', private: true, cwd: f.workspace }) });
    assert.equal(denied.code, 0); assert.equal(denied.out, ''); assert.equal(denied.err.includes('CANARY'), false);
    await f.rpc('memory.update', { id: note.id, expectedVersion: 1, patch: { private: true } }); await f.rpc('memory.publish', {});
    const hidden = await bosun(['hook'], { env: f.env, cwd: f.workspace, input }); assert.equal(hidden.code, 0); assert.equal(hidden.out, '');
    await f.rpc('memory.store', { category: 'project', title: 'Zebra strategy fallback', body: 'Zebra strategy fallback uses yarn' }); await f.rpc('memory.publish', {});
    await f.runtime.close();
    const absent = await bosun(['hook'], { env: f.env, cwd: f.workspace, input }); assert.equal(absent.code, 0); assert.ok(absent.out.includes('yarn')); assert.equal(absent.out.includes('pnpm'), false);
    assert.deepEqual(f.sb.calls(), []);
  } finally { await f.close(); }
});
