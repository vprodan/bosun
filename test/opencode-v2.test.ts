import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mock } from './helpers.ts';
import { BosunError } from '../src/core/errors.ts';
import { requireManagedControl } from '../src/core/managed-policy.ts';
import { createOpenCodeProbe } from '../src/adapters/hosts/opencode/probe.ts';
import { OPENCODE2_MANAGED_CAPS, decodeServerInfo,
decodeSession, decodeMessagePage, decodeActive, contextCandidate, freshRootRequest,
parkedSeedRequest, decodeFreshRoot, } from '../src/adapters/hosts/opencode/v2-protocol.ts'

const fixture = () => JSON.parse(fs.readFileSync(new URL('./fixtures/opencode-v2.0.27.json', import.meta.url), 'utf8'));
const PUBLIC = { privacy: 'public' as const };
const SELECTED = { providerID: 'openai', modelID: 'gpt-6.1-sol', variant: 'high' };
const INPUT = { ...PUBLIC, sessionID: 'ses_fixture', selection: SELECTED, generation: 1 };
const SIGNAL = new AbortController().signal;
const failure = (code: string) => (error: unknown) => {
  assert.ok(error instanceof BosunError);
  assert.equal(error.code, code);
  assert.doesNotMatch(JSON.stringify(error), /PRIVATE-|ECHO-/);
  return true;
};
function decoded(f = fixture()) {
  return { session: decodeSession(f.session, PUBLIC),
    page: decodeMessagePage(f.page, 'ses_fixture', PUBLIC), active: decodeActive(f.active, 'ses_fixture', PUBLIC) };
}
function observe(f = fixture(), extra = {}) {
  const d = decoded(f);
  return contextCandidate(d.session, d.page.messages, {
    now: 100001, generation: 1, selection: SELECTED, running: d.active.running, ...extra,
  });
}

test('OpenCode 2 metadata projections omit native content, paths and billing', () => {
  const f = fixture();
  f.session.data.title = 'PRIVATE-TITLE';
  f.session.data.metadata = { echo: 'PRIVATE-METADATA' };
  f.page.data[1].content[0].text = 'PRIVATE-TRANSCRIPT';
  f.page.data[1].content[1].text = 'PRIVATE-REASONING';
  f.page.data[1].content[2].state.input = { echo: 'PRIVATE-TOOL' };
  f.page.data[1].providerState = { echo: 'PRIVATE-STATE' };
  assert.deepEqual(decodeServerInfo(f.server), { hostId: 'opencode', version: f.server.version, pid: 4242 });
  const d = decoded(f);
  assert.deepEqual(d.session.selection, SELECTED);
  assert.deepEqual(d.page.messages[1].selection, SELECTED);
  assert.match(d.session.bindingHash, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(d.session), /PRIVATE-|directory|cost|tokens|500000|900000/);
  assert.doesNotMatch(JSON.stringify(d.page), /PRIVATE-|providerState|content|cost/);
  assert.equal(d.page.messages[1].pendingTools, 0);
});

test('OpenCode 2 does not accept a V1 health, session or WithParts message envelope', () => {
  const old = JSON.parse(fs.readFileSync(new URL('./fixtures/opencode-v1.18.34.json', import.meta.url), 'utf8'));
  assert.throws(() => decodeServerInfo(old.health), failure('unsupported'));
  assert.throws(() => decodeSession(old.session, PUBLIC), failure('invalid'));
  assert.throws(() => decodeMessagePage(old.messages, 'ses_fixture', PUBLIC), failure('invalid'));
  for (const version of ['1.18.34', '3.0.0', '2.1', '2.1.0-preview', '2.1.0+build', '02.1.0', 'PRIVATE-VERSION'])
    assert.throws(() => decodeServerInfo({ ...fixture().server, version }), failure('unsupported'));
});

test('OpenCode 2 admits release versions throughout its major without replacing observed identity or qualifying controls', () => {
  for (const version of ['2.0.0', '2.0.26', '2.0.28', '2.17.4']) {
    const info = decodeServerInfo({ ...fixture().server, version });
    assert.deepEqual(info, { hostId: 'opencode', version, pid: 4242 });
    assert.ok(Object.values(OPENCODE2_MANAGED_CAPS).every(value => value === 'unverified'));
  }
});

test('OpenCode 2 malformed metadata, counts, message types, cursors and duplicate IDs fail closed', () => {
  for (const mutate of [
    (f: any) => { f.session.data.time.updated = 0; },
    (f: any) => { f.session.data.location.directory = 'relative'; },
    (f: any) => { f.page.data[1].model = { providerID: 'openai', modelID: 'wrong-v1-field' }; },
    (f: any) => { f.page.data[1].tokens.cache.read = -1; },
    (f: any) => { f.page.data[1].tokens.output = NaN; },
    (f: any) => { f.page.data[1].tokens.reasoning = Number.MAX_SAFE_INTEGER + 1; },
    (f: any) => { f.page.data[1].time.completed = 1; },
    (f: any) => { f.page.data[1].time.streamed = 100001; },
    (f: any) => { f.page.data[1].content[2].state.status = 'pending'; },
    (f: any) => { f.page.data[1].sessionID = 'ses_foreign'; },
    (f: any) => { f.page.data[0].outcome = 'unknown'; },
    (f: any) => { f.page.data[0].type = 'future.message'; },
    (f: any) => { f.page.data.push(f.page.data[1]); },
    (f: any) => { f.page.cursor.next = '../PRIVATE-CURSOR\n'; },
    (f: any) => { f.active.data.ses_fixture = { type: 'idle' }; },
  ]) {
    const f = fixture(); mutate(f);
    assert.throws(() => decoded(f), failure('invalid'));
  }
  assert.throws(() => decodeMessagePage({ data: Array(129).fill({}), cursor: {} }, 'ses_fixture', PUBLIC), failure('invalid'));
  assert.throws(() => decodeServerInfo({ ...fixture().server, pid: 0 }), failure('invalid'));
});

test('OpenCode 2 idle marker binds a completed turn; latest inference input is a candidate, never active occupancy', () => {
  const f = fixture(), result = observe(f);
  assert.equal(result.candidateInputTokens, 4600);
  assert.equal(result.reason, 'active_total_unverified');
  assert.deepEqual(result.sample, {
    sessionId: 'ses_fixture', turnId: 'msg_idle_new', modelId: 'openai/gpt-6.1-sol',
    usedTokens: null, windowTokens: null, scope: 'unknown', quality: 'unknown', observedAt: 100001, generation: 1,
  });
  f.session.data.tokens.input = 7000000;
  f.page.data[1].tokens.output = 7000000;
  f.page.data[1].tokens.reasoning = 6000000;
  assert.equal(observe(f).candidateInputTokens, 4600);
  f.page.data[1].tokens.input = Number.MAX_SAFE_INTEGER;
  assert.throws(() => observe(f), failure('invalid'));
});

test('OpenCode 2 pending, streaming, failed, incomplete and inactive-without-idle turns remain unknown', () => {
  for (const mutate of [
    (f: any) => { f.active.data.ses_fixture = { type: 'running' }; },
    (f: any) => { delete f.page.data[1].time.completed; },
    (f: any) => { f.page.data[1].content[2].state.status = 'running'; },
    (f: any) => { f.page.data[1].content[2].state.status = 'streaming'; },
    (f: any) => { f.page.data.shift(); },
  ]) {
    const f = fixture(); mutate(f);
    assert.equal(observe(f).reason, 'turn_in_progress');
  }
  for (const mutate of [
    (f: any) => { f.page.data[0].outcome = 'interrupted'; },
    (f: any) => { f.page.data[0].outcome = 'failed'; },
    (f: any) => { f.page.data[1].error = { echo: 'PRIVATE-ERROR' }; },
    (f: any) => { f.page.data[1].finish = 'length'; },
    (f: any) => { f.page.data[1].content[2].state.status = 'error'; },
  ]) {
    const f = fixture(); mutate(f);
    assert.equal(observe(f).reason, 'reset_or_failed_turn');
  }
  const f = fixture(); delete f.page.data[1].tokens;
  assert.equal(observe(f).reason, 'missing_usage');
  f.page.data = [];
  assert.equal(observe(f).reason, 'no_completed_turn');
});

test('OpenCode 2 stale/future, explicit model/variant drift and resets stay held without reordering native sequence', () => {
  assert.equal(observe(fixture(), { now: 140001 }).reason, 'stale_or_future');
  assert.equal(observe(fixture(), { now: 99999 }).reason, 'stale_or_future');
  assert.equal(observe(fixture(), { resetAfter: 100000 }).reason, 'reset_without_new_turn');
  for (const mutate of [
    (f: any) => { f.session.data.model.variant = 'different'; },
    (f: any) => { f.page.data[1].model.providerID = 'different'; },
  ]) { const f = fixture(); mutate(f); assert.equal(observe(f).reason, 'model_changed'); }
  for (const type of ['compaction', 'model-switched', 'agent-switched', 'location-switched']) {
    const f = fixture();
    f.page.data.splice(2, 0, { id: 'msg_control', type, time: { created: 98500 }, model: f.session.data.model });
    assert.equal(observe(f).reason, 'reset_or_control_changed');
  }
  for (const field of ['fork', 'revert']) {
    const f = fixture(); f.session.data[field] = {};
    assert.equal(observe(f).reason, 'reset_or_control_changed');
  }
  const f = fixture(); f.page.data.reverse();
  assert.equal(observe(f).reason, 'turn_in_progress');
  const skewed = fixture();
  skewed.page.data[5].time.created = 100010; // Older sequence from before a clock adjustment.
  assert.equal(observe(skewed).candidateInputTokens, 4600);
  skewed.page.data[2].time.created = 100010; // Inconsistent current-turn timestamps stay held.
  assert.equal(observe(skewed).reason, 'stale_or_future');
});

test('OpenCode 2 native inactive scope is only this process foreground, never tool or background quiescence', () => {
  assert.deepEqual(decodeActive({ data: { ses_other: { type: 'running' } } }, 'ses_fixture', PUBLIC),
    { running: false, scope: 'server-process-foreground' });
  assert.deepEqual(decodeActive({ data: { ses_fixture: { type: 'running' } } }, 'ses_fixture', PUBLIC),
    { running: true, scope: 'server-process-foreground' });
});

test('OpenCode 2 opaque body cursors remain metadata, not followable URLs or evidence completeness', () => {
  const f = fixture();
  f.page.cursor = { previous: 'opaque:previous', next: 'https://example.invalid/PRIVATE-CURSOR' };
  const d = decoded(f);
  assert.equal(d.page.nextCursor, f.page.cursor.next);
  assert.equal(d.page.previousCursor, 'opaque:previous');
  assert.equal(observe(f).sample.quality, 'unknown');
});

test('OpenCode 2 fresh-root and parked seed recipes use only V2 fields and prove no readiness', () => {
  const root = freshRootRequest({ ...PUBLIC, selection: SELECTED, cwd: '/fixture/project', agent: 'build' });
  assert.deepEqual(root, { method: 'POST', path: '/api/session', body: {
    location: { directory: '/fixture/project' }, agent: 'build',
    model: { id: 'gpt-6.1-sol', providerID: 'openai', variant: 'high' },
  } });
  assert.equal(Object.hasOwn(root.body, 'parentID'), false);
  assert.deepEqual(parkedSeedRequest({ ...PUBLIC, sessionID: 'ses_fixture', messageID: 'msg_seed', text: 'Public state.' }), {
    method: 'POST', path: '/api/session/ses_fixture/prompt',
    body: { id: 'msg_seed', text: 'Public state.', delivery: 'queue', resume: false },
  });
  assert.deepEqual(decodeFreshRoot(fixture().session, { ...PUBLIC, selection: SELECTED }), {
    sessionID: 'ses_fixture', rootResponse: true, readiness: 'unverified',
  });
  for (const field of ['parentID', 'fork', 'revert']) {
    const f = fixture(); f.session.data[field] = field === 'parentID' ? 'ses_parent' : {};
    assert.throws(() => decodeFreshRoot(f.session, { ...PUBLIC, selection: SELECTED }), failure('unsupported'));
  }
  assert.throws(() => parkedSeedRequest({ ...PUBLIC, sessionID: 'ses_fixture', messageID: 'msg_seed', text: '界'.repeat(6000) }), failure('invalid'));
  assert.throws(() => parkedSeedRequest({ ...PUBLIC, sessionID: 'ses_fixture', messageID: 'msg_seed', text: 'Bearer sk-abcdefghijklmnopqrstuvwx' }), failure('private_input'));
});

test('OpenCode 2 private/unclassified codecs and recipes reject before record, model and text access', () => {
  const record = { get data(): never { throw Error('PRIVATE-RECORD'); } };
  for (const privacy of ['private', 'unknown', undefined]) {
    const input = { privacy, get selection(): never { throw Error('PRIVATE-MODEL'); },
      get text(): never { throw Error('PRIVATE-TEXT'); } } as never;
    assert.throws(() => decodeSession(record, input), failure('private_input'));
    assert.throws(() => decodeMessagePage(record, 'ses_fixture', input), failure('private_input'));
    assert.throws(() => decodeActive(record, 'ses_fixture', input), failure('private_input'));
    assert.throws(() => freshRootRequest(input), failure('private_input'));
    assert.throws(() => parkedSeedRequest(input), failure('private_input'));
    assert.throws(() => decodeFreshRoot(record, input), failure('private_input'));
  }
});

test('OpenCode 2 repeated session/process bindings hold read-only observations on drift with no retry', async () => {
  for (const arm of ['process', 'location', 'model', 'permissions', 'updated', 'idle', 'outcome', 'foreign', 'version']) {
    const f = fixture(); let infos = 0, sessions = 0;
    const m = await mock({
      '/api/info': () => ({ json: ++infos === 1 ? f.server : {
        ...f.server, pid: arm === 'process' ? 4243 : 4242, version: arm === 'version' ? '2.17.4' : f.server.version,
      } }),
      '/api/session/ses_fixture': () => {
        if (++sessions > 1) {
          if (arm === 'location') f.session.data.location.directory = '/fixture/other';
          if (arm === 'model') f.session.data.model.variant = 'different';
          if (arm === 'permissions') f.session.data.permissions = [];
          if (arm === 'updated') f.session.data.time.updated++;
          if (arm === 'idle') f.session.data.time.idle++;
          if (arm === 'outcome') f.session.data.outcome = 'failed';
          if (arm === 'foreign') f.session.data.id = 'ses_foreign';
        }
        return { json: f.session };
      },
      '/api/session/ses_fixture/message': () => ({ json: f.page }),
      '/api/session/active': () => ({ json: f.active }),
    });
    try {
      await assert.rejects(createOpenCodeProbe({ url: m.url, now: () => 100001 }).readSession(INPUT, SIGNAL),
        failure('unverified'));
      assert.equal(m.requests.length, 6);
      assert.ok(m.requests.every((r) => r.method === 'GET' && r.path.startsWith('/api/')));
    } finally { await m.close(); }
  }
});

test('OpenCode 2 a server-supplied cursor or connection URL is never followed by the metadata probe', async () => {
  const f = fixture();
  f.server.version = '2.17.4';
  f.server.urls = ['https://example.invalid/PRIVATE-URL'];
  f.page.cursor.next = 'https://example.invalid/PRIVATE-CURSOR';
  const m = await mock({
    '/api/info': () => ({ json: f.server }), '/api/session/ses_fixture': () => ({ json: f.session }),
    '/api/session/ses_fixture/message': () => ({ json: f.page }), '/api/session/active': () => ({ json: f.active }),
  });
  try {
    const result = await createOpenCodeProbe({ url: m.url, now: () => 100001 }).readSession(INPUT, SIGNAL);
    assert.equal(result.version, f.server.version);
    assert.ok(Object.values(result.managedCapabilities).every(value => value === 'unverified'));
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE-|directory|paths|urls|cursor|cost/);
    assert.equal(result.observation.sample.quality, 'unknown');
    assert.equal(m.requests.length, 6);
  } finally { await m.close(); }
});

test('OpenCode 2 response/deadline/page limits stop a single attempt without exposing endpoint diagnostics', async () => {
  for (const arm of ['deadline', 'bytes', 'page']) {
    const f = fixture();
    if (arm === 'bytes') f.server.paths.tmp = 'PRIVATE-LARGE'.repeat(30000);
    if (arm === 'page') f.page.data = Array.from({ length: 33 }, (_, i) => ({
      ...f.page.data[0], id: 'msg_' + i,
    }));
    const m = await mock({
      '/api/info': () => ({ json: f.server, ...(arm === 'deadline' ? { delayMs: 150 } : {}) }),
      '/api/session/ses_fixture': () => ({ json: f.session }),
      '/api/session/ses_fixture/message': () => ({ json: f.page }),
    });
    try {
      await assert.rejects(createOpenCodeProbe({ url: m.url, timeoutMs: arm === 'deadline' ? 50 : 1000 })
        .readSession(INPUT, SIGNAL), failure(arm === 'deadline' ? 'timeout' : 'invalid'));
      assert.ok(m.requests.length <= (arm === 'page' ? 3 : 1));
      assert.ok(m.requests.every((r) => r.method === 'GET'));
    } finally { await m.close(); }
  }
});

test('OpenCode 2 successful metadata fixtures cannot authorize automatic handoff or any control method', () => {
  assert.ok(Object.values(OPENCODE2_MANAGED_CAPS).every((cap) => cap === 'unverified'));
  let calls = 0;
  const method = async (): Promise<never> => { calls++; throw Error('control must stay held'); };
  assert.throws(() => requireManagedControl({ control: {
    caps: OPENCODE2_MANAGED_CAPS, observeContext: method, fenceAdmission: method, quiesce: method,
    startFresh: method, seed: method, ready: method,
  } }), failure('unverified'));
  assert.equal(calls, 0);
});
