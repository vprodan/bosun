import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox } from './helpers.ts';
import { BosunError } from '../src/core/errors.ts';
import { openDaemonJobs } from '../src/app/jobs.ts';
import { createOpenCodeRunner, openCodePermissions } from '../src/adapters/hosts/opencode/runner.ts';
import type { RunEvent, RunSpec } from '../src/core/ports/runner.ts';
import { CWD, MODEL, native, type NativeOptions } from './opencode-runner-fixture.ts';

// Invented public fixtures follow the pinned native routes, never a provider/model or live host.
const spec = (extra: Partial<RunSpec> = {}): RunSpec => ({ privacy: 'public', prompt: 'PUBLIC TASK CANARY', cwd: CWD,
  access: 'read', model: `ollama/${MODEL}`, effort: 'high', signal: new AbortController().signal, ...extra });
async function collect(source: AsyncIterable<RunEvent>) { const events: RunEvent[] = []; for await (const event of source) events.push(event); return events; }
const safe = (code: string, unknown = false) => (e: unknown) => {
  assert.ok(e instanceof BosunError); assert.equal(e.code, code);
  assert.doesNotMatch(JSON.stringify(e), /SECRET-|PRIVATE-|CANARY|password|authorization/);
  assert.equal(e.details?.outcome, unknown ? 'unknown' : undefined); return true;
};
test('OpenCode runner is inert; private/unknown classification precedes prompt/config/HTTP getters', async () => {
  let reads = 0; const runner = createOpenCodeRunner({ get url(): string { reads++; throw Error('PRIVATE-URL'); },
    get env(): never { reads++; throw Error('PRIVATE-ENV'); } });
  assert.equal(reads, 0);
  for (const privacy of ['private', 'unknown', undefined]) {
    await assert.rejects(collect(runner.run({ ...spec(), privacy, get prompt(): never { reads++; throw Error('PRIVATE-PROMPT'); } } as RunSpec)), safe('private_input'));
  }
  await assert.rejects(collect(runner.run(Object.create(spec()))), safe('private_input'));
  await assert.rejects(collect(runner.run({ ...spec(), get privacy() { reads++; return 'public' as const; } })), safe('private_input'));
  assert.equal(reads, 0);
});

test('native OpenCode 2 HTTP run binds an explicit root, model colons, cwd/variant and deny-all permissions; V2 step usage is exclusive', async () => {
  const n = await native();
  try {
    assert.equal(n.requests.length, 0); const runner = n.runner();
    assert.equal(runner.caps.sandbox, 'tool-allowlist'); assert.equal(runner.caps.readOnly, 'verified');
    const events = await collect(runner.run(spec()));
    assert.deepEqual(events, [{ t: 'tool', name: 'read' }, { t: 'text', text: 'Public bounded result' },
      { t: 'usage', tokensIn: 97, tokensOut: 9 }, { t: 'done', code: 0, result: 'Public bounded result' }]);
    assert.doesNotMatch(JSON.stringify(events), /SECRET-|CANARY|session|directory|cost|path|metadata/);
    const create = n.requests.find((r) => r.method === 'POST' && r.path === '/api/session')!;
    const prompt = n.requests.find((r) => r.path === `/api/session/${n.sessionID}/prompt`)!;
    assert.deepEqual(create.body, { id: n.sessionID, agent: 'build', location: { directory: CWD },
      model: { id: MODEL, providerID: 'ollama', variant: 'high' }, permissions: openCodePermissions('read'), metadata: create.body.metadata });
    assert.match(create.body.id, /^ses_[a-f0-9]+$/); assert.match(create.body.metadata.bosun.association, /^[a-f0-9-]{36}$/);
    assert.deepEqual(prompt.body, { id: prompt.body.id, text: spec().prompt, delivery: 'queue', resume: true });
    assert.match(prompt.body.id, /^msg_[a-f0-9]+$/);
    assert.equal(Object.hasOwn(prompt.body, 'tools'), false); assert.equal(Object.hasOwn(prompt.body, 'noReply'), false);
    assert.ok(n.requests.every((r) => r.path.startsWith('/api/') && !new URL(r.path, n.url).searchParams.has('directory')));
    assert.ok(n.requests.filter((r) => r.path.startsWith('/api/model')).every((r) => new URL(r.path, n.url).searchParams.get('location[directory]') === CWD));
    assert.ok(n.requests.filter((r) => r.path === '/api/session/active').length >= 3);
    assert.equal(n.requests.filter((r) => r.path.includes('/interrupt')).length, 0);
  } finally { await n.close(); }
});

test('edit access uses the native edit rule, default selection prevents inherited variants, supported API providers remain selectable', async () => {
  const n = await native({ provider: 'openai' });
  try {
    const events = await collect(n.runner().run(spec({ access: 'edit', model: `openai/${MODEL}`, effort: undefined, prompt: 'edit fixture' })));
    assert.deepEqual(events[0], { t: 'tool', name: 'patch' });
    const create = n.requests.find((r) => r.method === 'POST' && r.path === '/api/session')!;
    assert.equal(create.body.model.variant, 'default'); assert.equal(create.body.model.providerID, 'openai');
    assert.deepEqual(create.body.permissions, openCodePermissions('edit'));
    assert.ok(n.requests.every((r) => !r.path.startsWith('/auth')));
    assert.doesNotMatch(JSON.stringify(n.requests.map((r) => r.body)), /credential|apiKey|password/);
  } finally { await n.close(); }
});

test('Basic auth uses only explicit username/passwordEnv; detect is selected and auth/provider errors remain finite', async () => {
  const n = await native(); const secret = 'SECRET-AUTH-PASSWORD';
  try {
    const runner = n.runner({ username: 'opencode', passwordEnv: 'OPENCODE_PASSWORD', env: { OPENCODE_PASSWORD: secret } });
    assert.equal((await runner.detect({ OPENCODE_PASSWORD: secret })).installed, true);
    assert.deepEqual(n.requests.map((r) => [r.method, r.path]), [['GET', '/api/info']]);
    await collect(runner.run(spec()));
    assert.ok(n.requests.every((r) => r.headers.authorization === `Basic ${Buffer.from(`opencode:${secret}`).toString('base64')}`));
    const before = n.requests.length;
    await assert.rejects(collect(n.runner({ url: n.url.replace('http://', 'http://user:SECRET-PASSWORD@') }).run(spec())), safe('invalid'));
    await assert.rejects(collect(n.runner({ username: 'opencode', passwordEnv: 'OPENCODE_PASSWORD' }).run(spec())), safe('unavailable'));
    assert.equal(n.requests.length, before);
  } finally { await n.close(); }
  const denied = await native({ healthStatus: 401 });
  try {
    const runner = denied.runner({ username: 'opencode', passwordEnv: 'OPENCODE_PASSWORD', env: { OPENCODE_PASSWORD: secret } });
    await assert.rejects(collect(runner.run(spec())), safe('unavailable'));
    assert.doesNotMatch(JSON.stringify(await runner.detect({ OPENCODE_PASSWORD: secret })), /SECRET-|Basic|authorization/);
    assert.ok(denied.requests.every((r) => r.path === '/api/info')); assert.equal(denied.requests.length, 2);
  } finally { await denied.close(); }
});

test('completed native message remains buffered until idle; early consumer return leaves no active native request', async () => {
  const n = await native({ holdCompletion: true }); const iterator = n.runner().run(spec())[Symbol.asyncIterator]();
  let yielded = false; const first = iterator.next().then((event) => { yielded = true; return event; });
  try {
    await n.started; await n.statusRead;
    assert.ok(n.idlePolls > 0); assert.equal(yielded, false);
    n.finishAbort(); assert.deepEqual((await first).value, { t: 'tool', name: 'read' });
    const end = await iterator.return?.(); assert.ok(end); assert.equal(end.done, true);
    assert.equal(n.requests.filter((r) => r.path.includes('/interrupt?')).length, 0);
  } finally { n.finishAbort(); await first; await iterator.return?.(); await n.close(); }
});

test('unsupported version/provider/variant never creates a session or falls back; unsupported controls fail before HTTP', async () => {
  const unavailable: NativeOptions[] = [{ version: '1.18.34' }, { version: '2.0.28' }, { provider: 'another' },
    { modelEnabled: false }, { variants: { low: {} } }, { variants: { default: {} } }];
  for (const options of unavailable) {
    const n = await native(options);
    try {
      await assert.rejects(collect(n.runner().run(spec(options.variants?.default ? { effort: undefined } : {}))), safe('unsupported'));
      assert.ok(n.requests.every((r) => r.method === 'GET'));
      assert.equal(n.requests.length, options.version ? 1 : 2);
    } finally { await n.close(); }
  }
  const n = await native();
  try {
    for (const extra of [{ maxTurns: 4 }, { mcp: [] }, { env: { HOME: '/other' } }]) await assert.rejects(collect(n.runner().run(spec(extra))), safe('unsupported'));
    for (const extra of [{ cwd: 'relative' }, { model: 'no-provider' }, { access: 'shell' as never }]) await assert.rejects(collect(n.runner().run(spec(extra))), safe('invalid'));
    let reads = 0; await assert.rejects(collect(n.runner().run({ ...spec(), get effort(): never { reads++; throw Error('SECRET-GETTER'); } })), safe('invalid'));
    assert.equal(reads, 0); assert.deepEqual(n.requests, []);
  } finally { await n.close(); }
});

test('fresh session model/cwd/permission must match before any prompt; uncertain create response never adopts or aborts a foreign session', async () => {
  for (const modifySession of [(s: any) => { s.location.directory = '/foreign'; }, (s: any) => { s.model.id = 'other'; },
    (s: any) => { s.permissions = [{ action: '*', resource: '*', effect: 'allow' }]; }, (s: any) => { s.parentID = 'ses_foreign'; },
    (s: any) => { s.agent = 'other'; }, (s: any) => { s.id = 'ses_foreign'; }, (s: any) => { s.metadata = {}; }]) {
    const n = await native({ modifySession });
    try {
      await assert.rejects(collect(n.runner().run(spec())), safe('unsupported', true));
      assert.equal(n.requests.filter((r) => r.method === 'POST').length, 1);
      assert.ok(n.requests.every((r) => !r.path.includes('/prompt') && !r.path.includes('/interrupt')));
    } finally { await n.close(); }
  }
});

test('missing/failed/malformed/foreign/unfinished completion never fabricates done; native cleanup is single-attempt and independently scoped', async () => {
  const modifiers = [
    (r: any) => { delete r.assistant.time.completed; }, (r: any) => { r.assistant.error = { message: 'SECRET-PROVIDER-ERROR' }; },
    (r: any) => { r.user.id = 'msg_foreign'; }, (r: any) => { r.assistant.model = { ...r.assistant.model, variant: 'low' }; },
    (r: any) => { r.assistant.agent = 'other'; },
    (r: any) => { r.assistant.finish = 'tool-calls'; }, (r: any) => { r.tool.state.status = 'running'; },
    (r: any) => { r.tool.name = 'shell'; }, (r: any) => { r.assistant.content[0].text = 'é'.repeat(32769); },
  ];
  for (const modifyCompletion of modifiers) {
    const n = await native({ modifyCompletion }); const events: RunEvent[] = [];
    try {
      await assert.rejects(async () => { for await (const e of n.runner().run(spec())) events.push(e); }, safe('unavailable', true));
      assert.deepEqual(events, []);
      assert.equal(n.requests.filter((r) => r.path.endsWith('/prompt')).length, 1);
      assert.equal(n.requests.filter((r) => r.path.includes('/interrupt?')).length, 1);
      assert.ok(n.requests.some((r) => r.method === 'GET' && r.path === `/api/session/${n.sessionID}`));
      assert.ok(n.requests.some((r) => r.path === '/api/session/active'));
    } finally { await n.close(); }
  }
});

test('lost, malformed and oversized native prompt responses stay unknown without retry or credential/error echoes', async () => {
  for (const messageFault of ['drop', 'malformed', 'oversize'] as const) {
    const n = await native({ messageFault }); const events: RunEvent[] = [];
    try {
      await assert.rejects(async () => { for await (const e of n.runner().run(spec())) events.push(e); }, safe(messageFault === 'drop' ? 'unavailable' : 'invalid', true));
      assert.deepEqual(events, []); assert.equal(n.requests.filter((r) => r.path.endsWith('/prompt')).length, 1);
      assert.equal(n.requests.filter((r) => r.path.includes('/interrupt?')).length, 1);
    } finally { await n.close(); }
  }
});

test('abort waits for positive native idle rather than releasing a client HTTP connection; absent completion remains unknown', async () => {
  const n = await native({ pending: true, holdAbort: true }); const control = new AbortController();
  let settled = false; const events: RunEvent[] = [];
  const running = (async () => { try { for await (const e of n.runner().run(spec({ signal: control.signal }))) events.push(e); } catch (e) { return e; } })()
    .finally(() => { settled = true; });
  try {
    await n.started; control.abort(); await n.aborted; await n.statusRead;
    assert.equal(settled, false); assert.deepEqual(events, []);
    n.finishAbort(); safe('cancelled', true)(await running);
    assert.ok(n.idlePolls >= 1); assert.equal(n.requests.filter((r) => r.path.includes('/interrupt?')).length, 1);
  } finally { n.finishAbort(); await running; await n.close(); }
});

test('timeout and unsupported abort receipt have finite unknown outcome and never repeat the prompt/abort', async () => {
  for (const abortReply of [true, false, 'SECRET-MALFORMED']) {
    const n = await native({ pending: true, abortReply });
    try {
      await assert.rejects(collect(n.runner({ runTimeoutMs: 80, abortTimeoutMs: 100 }).run(spec())), safe('timeout', true));
      assert.equal(n.requests.filter((r) => r.path.endsWith('/prompt')).length, 1);
      assert.equal(n.requests.filter((r) => r.path.includes('/interrupt?')).length, 1);
    } finally { await n.close(); }
  }
});

test('actual durable jobs close waits for native OpenCode abort/idle, persists unknown, and never redispatches after reopen', async () => {
  const n = await native({ pending: true, holdAbort: true }); const sb = sandbox();
  const dir = path.join(sb.root, 'jobs'); fs.mkdirSync(dir, { mode: 0o700 }); const files = { stateFile: path.join(dir, 'state.db'), ownerFile: path.join(dir, 'owner.db') };
  const scope = { projectId: 'project_fixture' }; let factories = 0; let time = 100;
  const options = { ...files, admit: async () => ({ allowed: true as const }), now: () => ++time, id: () => 'job_fixture',
    runners: { opencode: () => { factories++; return n.runner(); } } };
  const jobs = openDaemonJobs(options); let reopened: ReturnType<typeof openDaemonJobs> | undefined;
  let closing: Promise<void> | undefined;
  try {
    jobs.recover(); const job = jobs.submit({ privacy: 'public', prompt: spec().prompt, cwd: CWD, access: 'read', model: `ollama/${MODEL}`, effort: 'high',
      requestId: 'request_fixture', taskId: 'task_fixture', runnerId: 'opencode' }, scope).job;
    const running = jobs.runQueued(); await n.started;
    let closed = false; closing = jobs.close().then(() => { closed = true; }); await n.aborted;
    assert.equal(closed, false); jobs.assertOwner(); assert.equal(jobs.get(scope, job.id).state, 'running');
    n.finishAbort(); await closing; await running; assert.equal(factories, 1);
    reopened = openDaemonJobs(options); assert.equal(reopened.recover(), 0);
    assert.equal(reopened.get(scope, job.id).state, 'unknown'); assert.equal(reopened.get(scope, job.id).cancelRequested, true);
    assert.equal(reopened.result(scope, job.id), null); assert.doesNotMatch(JSON.stringify(reopened.events(scope, 0)), /CANARY|SECRET-|qwen|synthetic/);
    await reopened.runQueued(); assert.equal(factories, 1);
  } finally {
    n.finishAbort();
    const clean = await Promise.allSettled([closing, reopened?.close(), jobs.close()]);
    await n.close(); sb.cleanup();
    const failed = clean.find(result => result.status === 'rejected'); if (failed?.status === 'rejected') throw failed.reason;
  }
});

test('V2 inbox admission is not completion; changed ID/session/text/delivery/attachments remain unknown without replay', async () => {
  for (const modifyAdmission of [
    (r: any) => { r.id = 'msg_foreign'; }, (r: any) => { r.sessionID = 'ses_foreign'; },
    (r: any) => { r.payload.text = 'SECRET-ALTERED-PROMPT'; }, (r: any) => { r.delivery = 'steer'; },
    (r: any) => { r.payload.files = [{ path: 'SECRET-ATTACHMENT' }]; },
    (r: any) => { r.payload.agents = [{ id: 'SECRET-AGENT' }]; }, (r: any) => { r.type = 'synthetic'; },
  ]) {
    const n = await native({ modifyAdmission }), events: RunEvent[] = [];
    try {
      await assert.rejects(async () => { for await (const event of n.runner().run(spec())) events.push(event); }, safe('unavailable', true));
      assert.deepEqual(events, []);
      assert.equal(n.requests.filter((r) => r.path.endsWith('/prompt')).length, 1);
      assert.equal(n.requests.filter((r) => r.path.includes('/interrupt?resume=false')).length, 1);
      assert.ok(n.requests.every((r) => !r.path.includes('/revert') && r.method !== 'DELETE'));
    } finally { await n.close(); }
  }
});

test('lost V2 root receipt never adopts an arbitrary root, sends input, deletes history or retries creation', async () => {
  const n = await native({ createFault: true });
  try {
    await assert.rejects(collect(n.runner().run(spec())), safe('unavailable', true));
    assert.equal(n.requests.filter((r) => r.method === 'POST').length, 1);
    assert.equal(n.requests.filter((r) => r.path.includes('/prompt') || r.path.includes('/interrupt')).length, 0);
  } finally { await n.close(); }
});

test('V2 server identity, native catalog/variant overlay and owned session bindings repeat immediately before effects', async () => {
  for (const options of [
    { modifyInfo: (r: any, read: number) => { if (read >= 2) r.pid++; } },
    { modifyCatalog: (r: any, read: number) => { if (read >= 2) r.variants[0].settings = { changed: true }; } },
    { modifyCatalog: (r: any, read: number) => { if (read >= 2) r.modelID = 'different-backend'; } },
    { modifyReadback: (r: any, read: number) => { if (read >= 3) r.projectID = 'foreign'; } },
  ]) {
    const n = await native(options);
    try {
      const unknown = !('modifyInfo' in options);
      await assert.rejects(collect(n.runner().run(spec())), safe('unverified', unknown));
      assert.equal(n.requests.filter((r) => r.path.endsWith('/prompt')).length, 0);
      assert.equal(n.requests.filter((r) => r.path.includes('/interrupt')).length, 0);
      assert.equal(n.requests.filter((r) => r.method === 'POST').length, unknown ? 1 : 0);
    } finally { await n.close(); }
  }
});

test('V2 complete history reaches an empty terminal page and follows only encoded body cursors at the original endpoint', async () => {
  const n = await native({ pageSize: 1 });
  try {
    const events = await collect(n.runner().run(spec()));
    assert.equal(events.at(-1)?.t, 'done');
    const pages = n.requests.filter((r) => r.path.includes('/message?'));
    assert.ok(pages.length >= 11);
    assert.ok(pages.every((r) => {
      const params = new URL(r.path, n.url).searchParams;
      return params.get('limit') === '32' && (params.has('cursor') ? !params.has('order') : params.get('order') === 'asc');
    }));
  } finally { await n.close(); }
  for (const options of [{ hideCursor: true }, { nextCursor: 'https://example.invalid/SECRET-CURSOR' }]) {
    const broken = await native(options);
    try {
      await assert.rejects(collect(broken.runner().run(spec())), safe('unverified', true));
      assert.equal(broken.requests.filter((r) => r.path.endsWith('/prompt')).length, 1);
      assert.equal(broken.requests.filter((r) => r.path.includes('/interrupt')).length, 1);
      assert.ok(broken.requests.every((r) => r.path.startsWith('/api/')));
    } finally { await broken.close(); }
  }
});

test('V2 native inactivity without the original terminal remains unknown, even with completed assistant/tool records', async () => {
  const n = await native({ modifyCompletion: (r) => { r.rows.pop(); } });
  try {
    await assert.rejects(collect(n.runner({ runTimeoutMs: 150 }).run(spec())), safe('timeout', true));
    assert.equal(n.requests.filter((r) => r.path.endsWith('/prompt')).length, 1);
    assert.equal(n.requests.filter((r) => r.path.includes('/interrupt')).length, 1);
  } finally { await n.close(); }
});

test('V2 hidden native inputs/control changes and unallowed code-mode/MCP/shell tools cannot produce completion', async () => {
  const modifications = [
    ...['synthetic', 'system', 'skill', 'shell', 'compaction', 'model-switched', 'agent-switched', 'location-switched']
      .map((type) => (r: any) => { r.rows.splice(1, 0, { id: 'msg_extra', type, time: { created: 20 }, model: r.assistant.model }); }),
    ...['execute', 'bosun_memory_search', 'opencode_read_mcp_resource', 'shell', 'subagent', 'apply_patch']
      .map((name) => (r: any) => { r.tool.name = name; }),
  ];
  for (const modifyCompletion of modifications) {
    const n = await native({ modifyCompletion });
    try {
      await assert.rejects(collect(n.runner().run(spec())), safe('unavailable', true));
      assert.equal(n.requests.filter((r) => r.path.endsWith('/prompt')).length, 1);
      assert.equal(n.requests.filter((r) => r.path.includes('/interrupt')).length, 1);
    } finally { await n.close(); }
  }
  for (const access of ['read', 'edit'] as const) {
    const rules = openCodePermissions(access);
    assert.deepEqual(rules[0], { action: '*', resource: '*', effect: 'deny' });
    assert.ok(rules.every((r) => !['execute', 'shell', 'subagent', 'skill', 'external_directory'].includes(r.action)));
    assert.equal(rules.some((r) => r.action === 'edit'), access === 'edit');
  }
});

test('V2 repeated completed history catches native content drift before yielding any result', async () => {
  const n = await native({ modifyHistory: (rows, read) => {
    if (read >= 4) { const last = rows.find((r) => r.id === 'msg_step2'); if (last) last.content[0].text = 'SECRET-CHANGED-RESULT'; }
  } });
  const events: RunEvent[] = [];
  try {
    await assert.rejects(async () => { for await (const event of n.runner().run(spec())) events.push(event); }, safe('unverified', true));
    assert.deepEqual(events, []);
    assert.equal(n.requests.filter((r) => r.path.endsWith('/prompt')).length, 1);
    assert.equal(n.requests.filter((r) => r.path.includes('/interrupt')).length, 1);
  } finally { await n.close(); }
});

test('V2 interruption never targets a changed server process or native ownership binding', async () => {
  for (const options of [
    { messageFault: 'drop' as const, modifyInfo: (r: any, read: number) => { if (read >= 4) r.pid++; } },
    { messageFault: 'drop' as const, modifyReadback: (r: any, read: number) => { if (read >= 4) r.metadata = {}; } },
  ]) {
    const n = await native(options);
    try {
      await assert.rejects(collect(n.runner().run(spec())), safe('unavailable', true));
      assert.equal(n.requests.filter((r) => r.path.endsWith('/prompt')).length, 1);
      assert.equal(n.requests.filter((r) => r.path.includes('/interrupt')).length, 0);
    } finally { await n.close(); }
  }
});

test('actual durable job executes V2 once, retains the selected model/variant and positive result, and deduplicates after restart', async () => {
  const n = await native(), sb = sandbox();
  const dir = path.join(sb.root, 'v2-jobs'); fs.mkdirSync(dir, { mode: 0o700 });
  const scope = { projectId: 'project_fixture' }; let factories = 0, time = 100;
  const options = { stateFile: path.join(dir, 'state.db'), ownerFile: path.join(dir, 'owner.db'),
    admit: async () => ({ allowed: true as const }), now: () => ++time, id: () => 'job_v2',
    runners: { opencode: () => { factories++; return n.runner(); } } };
  const input = { privacy: 'public' as const, prompt: spec().prompt, cwd: CWD, access: 'read' as const,
    model: `ollama/${MODEL}`, effort: 'high', requestId: 'request_v2', taskId: 'task_v2', runnerId: 'opencode' };
  const jobs = openDaemonJobs(options); let reopened: ReturnType<typeof openDaemonJobs> | undefined;
  try {
    jobs.recover(); const original = jobs.submit(input, scope).job;
    await jobs.runQueued();
    assert.equal(jobs.get(scope, original.id).state, 'succeeded');
    assert.equal(jobs.result(scope, original.id), 'Public bounded result');
    const create = n.requests.find((r) => r.path === '/api/session' && r.method === 'POST')!;
    assert.deepEqual(create.body.model, { id: MODEL, providerID: 'ollama', variant: 'high' });
    assert.doesNotMatch(JSON.stringify(jobs.events(scope, 0)), /CANARY|SECRET-|qwen|synthetic|Public bounded result/);
    await jobs.close();
    reopened = openDaemonJobs(options); assert.equal(reopened.recover(), 0);
    const duplicate = reopened.submit({ ...input, get prompt(): never { throw Error('SECRET-DUPLICATE-PAYLOAD'); } }, scope);
    assert.equal(duplicate.duplicate, true); assert.equal(duplicate.job.id, original.id);
    assert.equal(reopened.result(scope, original.id), 'Public bounded result');
    await reopened.runQueued();
    assert.equal(factories, 1); assert.equal(n.requests.filter((r) => r.path.endsWith('/prompt')).length, 1);
  } finally {
    await reopened?.close(); await jobs.close(); await n.close(); sb.cleanup();
  }
});

test('V2 useful multi-page history remains bounded; duplicate IDs and excessive source windows never truncate into success', async () => {
  for (const count of [40, 130]) {
    const n = await native({ modifyCompletion: (r) => {
      r.rows.splice(2, 0, ...Array.from({ length: count }, (_, i) => ({ ...structuredClone(r.step),
        id: 'msg_extra_' + i, content: [] })));
    } });
    try {
      if (count === 40) {
        const events = await collect(n.runner().run(spec()));
        assert.deepEqual(events.at(-2), { t: 'usage', tokensIn: 2097, tokensOut: 129 });
        assert.equal(events.at(-1)?.t, 'done');
      } else await assert.rejects(collect(n.runner().run(spec())), safe('unverified', true));
      assert.equal(n.requests.filter((r) => r.path.endsWith('/prompt')).length, 1);
    } finally { await n.close(); }
  }
  const duplicate = await native({ pageSize: 1, modifyCompletion: (r) => { r.rows.splice(2, 0, structuredClone(r.step)); } });
  try {
    await assert.rejects(collect(duplicate.runner().run(spec())), safe('unverified', true));
    assert.equal(duplicate.requests.filter((r) => r.path.endsWith('/prompt')).length, 1);
  } finally { await duplicate.close(); }
});
