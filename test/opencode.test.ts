import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mock, REPO } from './helpers.ts';
import { BosunError } from '../src/core/errors.ts';
import { requireManagedControl } from '../src/core/managed-policy.ts';
import { createOpenCodeProbe } from '../src/adapters/hosts/opencode/probe.ts';
import { OPENCODE2_MANAGED_CAPS } from '../src/adapters/hosts/opencode/v2-protocol.ts';
import {
  contextCandidate,
  decodeHealth,
  decodeSession,
  decodeMessages,
  decodeFreshRoot,
  decodeMessageFrame,
  freshRootRequest,
  noReplyRequest,
  OPENCODE_MANAGED_CAPS,
} from '../src/adapters/hosts/opencode/protocol.ts';

const fixture = () =>
  JSON.parse(fs.readFileSync(path.join(REPO, 'test/fixtures/opencode-v1.18.34.json'), 'utf8'));
const fixture2 = () =>
  JSON.parse(fs.readFileSync(path.join(REPO, 'test/fixtures/opencode-v2.0.27.json'), 'utf8'));
const PUBLIC = { privacy: 'public' as const };
const SELECTED = { providerID: 'openai', modelID: 'gpt-6.1-sol', variant: 'high' };
const INPUT = { ...PUBLIC, sessionID: 'ses_fixture', selection: SELECTED, generation: 1 };
const SIGNAL = new AbortController().signal;
const safeFailure = (code: string, expected?: string) => (error: unknown) => {
  assert.ok(error instanceof BosunError);
  assert.equal(error.code, code);
  if (expected) assert.equal(error.message, expected);
  assert.doesNotMatch(error.message, /PRIVATE-|ECHO-/);
  assert.doesNotMatch(JSON.stringify(error), /PRIVATE-|ECHO-/);
  return true;
};
function decoded(value = fixture()) {
  return {
    session: decodeSession(value.session, PUBLIC),
    messages: decodeMessages(value.messages, 'ses_fixture', PUBLIC),
  };
}

test('OpenCode pinned v1 codecs retain model/variant and omit content, paths, cost and accumulated tokens', () => {
  const f = fixture();
  f.session.title = 'PRIVATE-TITLE';
  f.session.metadata = { secret: 'PRIVATE-METADATA' };
  f.messages[3].info.structured = { echo: 'PRIVATE-STRUCTURED' };
  f.messages[3].parts[2].text = 'PRIVATE-TRANSCRIPT';
  const result = decoded(f);
  assert.deepEqual(decodeHealth(f.health), { hostId: 'opencode', version: '1.18.34' });
  assert.deepEqual(result.session.selection, SELECTED);
  assert.deepEqual(result.messages[3].selection, SELECTED);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-|directory|cwd|cost|500000|900000/);
});

test('OpenCode exact version/metadata mismatches fail with fixed actual coded errors', () => {
  for (const version of ['2.0.0', '1.18.35', 'PRIVATE-VERSION']) {
    assert.throws(
      () => decodeHealth({ healthy: true, version }),
      safeFailure('unsupported', 'OpenCode protocol version is not pinned'),
    );
    assert.throws(
      () => decodeSession({ ...fixture().session, version }, PUBLIC),
      safeFailure('unsupported', 'OpenCode session schema version is not pinned'),
    );
  }
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => {
      delete f.session.slug;
    },
    (f: ReturnType<typeof fixture>) => {
      f.messages[3].info.tokens.cache.read = NaN;
    },
    (f: ReturnType<typeof fixture>) => {
      f.messages[3].info.time.completed = 1;
    },
    (f: ReturnType<typeof fixture>) => {
      f.messages[3].info.sessionID = 'ses_foreign';
    },
    (f: ReturnType<typeof fixture>) => {
      f.messages[3].parts[0].messageID = 'msg_foreign';
    },
    (f: ReturnType<typeof fixture>) => {
      f.messages.push(f.messages[3]);
    },
  ]) {
    const f = fixture();
    mutate(f);
    assert.throws(
      () => decoded(f),
      safeFailure('invalid', 'Invalid OpenCode v1 protocol response'),
    );
  }
  assert.throws(
    () => decodeMessages(Array(129).fill({}), 'ses_fixture', PUBLIC),
    safeFailure('invalid'),
  );
});

test('OpenCode latest completed step is only an input candidate, never cumulative billed usage or verified occupancy', () => {
  const { session, messages } = decoded();
  const result = contextCandidate(session, messages, {
    now: 100001,
    generation: 1,
    selection: SELECTED,
  });
  assert.equal(result.candidateInputTokens, 4600);
  assert.equal(result.reason, 'active_total_unverified');
  assert.deepEqual(result.sample, {
    sessionId: 'ses_fixture',
    turnId: 'msg_assistant_new',
    modelId: 'openai/gpt-6.1-sol',
    usedTokens: null,
    windowTokens: null,
    scope: 'unknown',
    quality: 'unknown',
    observedAt: 100001,
    generation: 1,
  });
  messages[3].steps = [];
  assert.equal(
    contextCandidate(session, messages, { now: 100001, generation: 1, selection: SELECTED })
      .candidateInputTokens,
    4600,
  );
  for (const chosen of [
    undefined,
    { providerID: 'openai', modelID: { echo: 'PRIVATE-MODEL' } },
    { ...SELECTED, variant: { echo: 'PRIVATE-VARIANT' } },
  ]) {
    assert.throws(
      () =>
        contextCandidate(session, messages, {
          now: 100001,
          generation: 1,
          selection: chosen as never,
        }),
      safeFailure('invalid'),
    );
  }
});

test('OpenCode stale/future/pending/model-switch/reset samples are unknown rather than zero or safe to hand off', () => {
  const { session, messages } = decoded();
  const observe = (now: number, extra = {}) =>
    contextCandidate(session, messages, { now, generation: 2, selection: SELECTED, ...extra });
  assert.equal(observe(140001).reason, 'stale_or_future');
  assert.equal(observe(99999).reason, 'stale_or_future');
  assert.equal(observe(100001, { resetAfter: 100000 }).reason, 'reset_without_new_turn');
  assert.equal(
    observe(100001, { selection: { ...SELECTED, modelID: 'different-selected-model' } }).reason,
    'model_changed',
  );
  messages[3].summary = true;
  assert.equal(observe(100001).reason, 'reset_or_failed_turn');
  messages[3].summary = false;
  messages[3].failed = true;
  assert.equal(observe(100001).candidateInputTokens, null);
  messages[3].failed = false;
  messages.push({ ...messages[2], id: 'msg_next_user', created: 100001 });
  assert.equal(observe(100002).reason, 'turn_in_progress');
  const fresh = { ...session, id: 'ses_fresh', created: 100002, updated: 100002 };
  assert.equal(
    contextCandidate(fresh, [], { now: 100003, generation: 3, selection: SELECTED }).reason,
    'no_completed_turn',
  );
  assert.throws(
    () => contextCandidate(fresh, messages, { now: 100003, generation: 3, selection: SELECTED }),
    safeFailure('invalid'),
  );
});

test('OpenCode pure fresh-root/noReply recipes preserve explicit selections without proving readiness or sending HTTP', () => {
  const root = freshRootRequest({ ...PUBLIC, selection: SELECTED });
  assert.deepEqual(root, {
    method: 'POST',
    path: '/session',
    body: { model: { id: 'gpt-6.1-sol', providerID: 'openai', variant: 'high' } },
  });
  assert.equal(Object.hasOwn(root.body, 'parentID'), false);
  const seed = noReplyRequest({ ...INPUT, text: 'Synthetic public task state.' });
  assert.deepEqual(seed, {
    method: 'POST',
    path: '/session/ses_fixture/message',
    body: {
      model: { providerID: 'openai', modelID: 'gpt-6.1-sol' },
      variant: 'high',
      noReply: true,
      parts: [{ type: 'text', text: 'Synthetic public task state.' }],
    },
  });
  assert.deepEqual(decodeFreshRoot(fixture().session, { ...PUBLIC, selection: SELECTED }), {
    sessionID: 'ses_fixture',
    rootResponse: true,
    readiness: 'unverified',
  });
  assert.throws(
    () =>
      decodeFreshRoot(
        { ...fixture().session, parentID: 'ses_parent' },
        { ...PUBLIC, selection: SELECTED },
      ),
    safeFailure('unsupported'),
  );
  assert.throws(
    () => noReplyRequest({ ...INPUT, text: '界'.repeat(6000) }),
    safeFailure('invalid', 'OpenCode seed exceeds text limit or is empty'),
  );
});

test('OpenCode private/unknown recipes and codecs reject before text/selection/record property access', () => {
  const record = {
    get id(): string {
      throw Error('PRIVATE-RECORD');
    },
  };
  for (const privacy of ['private', 'unknown', undefined]) {
    const context = { privacy } as never;
    assert.throws(() => decodeSession(record, context), safeFailure('private_input'));
    assert.throws(
      () => decodeMessages(record, 'ses_fixture', context),
      safeFailure('private_input'),
    );
    const input = {
      privacy,
      get selection(): never {
        throw Error('PRIVATE-SELECTION');
      },
      get text(): string {
        throw Error('PRIVATE-TEXT');
      },
      sessionID: 'ses_fixture',
    };
    assert.throws(() => freshRootRequest(input as never), safeFailure('private_input'));
    assert.throws(() => noReplyRequest(input as never), safeFailure('private_input'));
  }
});

test('OpenCode SSE fixture uses pinned global envelope and message.updated properties sessionID/info, with no content replay', () => {
  const info = fixture().messages[3].info;
  const frame = (properties: object) =>
    'event: message\ndata: ' +
    JSON.stringify({
      directory: '/fixture/project',
      payload: { id: 'evt_fixture', type: 'message.updated', properties },
    }) +
    '\n\n';
  const result = decodeMessageFrame(
    frame({ sessionID: 'ses_fixture', info: { ...info, structured: 'PRIVATE-ECHO' } }),
    'ses_fixture',
    PUBLIC,
  );
  assert.equal(result?.id, 'msg_assistant_new');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-|directory|structured/);
  assert.throws(
    () => decodeMessageFrame(frame({ info }), 'ses_fixture', PUBLIC),
    safeFailure('invalid'),
  );
  assert.throws(
    () => decodeMessageFrame(frame({ sessionID: 'ses_foreign', info }), 'ses_fixture', PUBLIC),
    safeFailure('invalid'),
  );
  assert.throws(
    () => decodeMessageFrame('data: PRIVATE-BAD-JSON\n\n', 'ses_fixture', PUBLIC),
    safeFailure('invalid', 'Invalid OpenCode v1 protocol response'),
  );
  assert.throws(
    () =>
      decodeMessageFrame(
        'data: ' + JSON.stringify({ payload: { type: 'unknown.future.event' } }) + '\n\n',
        'ses_fixture',
        PUBLIC,
      ),
    safeFailure('unsupported'),
  );
  assert.equal(
    decodeMessageFrame('data: {"payload":{"type":"server.heartbeat"}}\n\n', 'ses_fixture', PUBLIC),
    null,
  );
});

test('OpenCode explicitly selected probe performs only GET metadata reads and never becomes native Codex/Claude', async () => {
  const f = fixture2();
  const m = await mock({
    '/api/info': () => ({ json: f.server }),
    '/api/session/ses_fixture': () => ({ json: f.session }),
    '/api/session/ses_fixture/message': () => ({ json: f.page }),
    '/api/session/active': () => ({ json: f.active }),
  });
  try {
    const probe = createOpenCodeProbe({ url: m.url, now: () => 100001 });
    assert.equal(m.requests.length, 0);
    const result = await probe.readSession(INPUT, SIGNAL);
    assert.equal(result.hostId, 'opencode');
    assert.equal(result.observation.candidateInputTokens, 4600);
    assert.deepEqual(
      m.requests.map((r) => [r.method, r.path]),
      [
        ['GET', '/api/info'],
        ['GET', '/api/session/ses_fixture'],
        ['GET', '/api/session/ses_fixture/message?limit=32&order=desc'],
        ['GET', '/api/session/active'],
        ['GET', '/api/session/ses_fixture'],
        ['GET', '/api/info'],
      ],
    );
    assert.equal(result.managedCapabilities, OPENCODE2_MANAGED_CAPS);
    assert.equal(Object.hasOwn(probe, 'startFresh'), false);
    assert.equal(Object.hasOwn(probe, 'seed'), false);
  } finally {
    await m.close();
  }
});

test('OpenCode probe rejects private/unknown/malformed selection and generation before config/HTTP', async () => {
  let reads = 0;
  const probe = createOpenCodeProbe({
    get url(): string {
      reads++;
      throw Error('PRIVATE-CONFIG');
    },
  });
  assert.equal(reads, 0);
  for (const privacy of ['private', 'unknown', undefined]) {
    await assert.rejects(
      probe.readSession(
        {
          privacy,
          get selection(): never {
            throw Error('PRIVATE-SELECTION');
          },
        } as never,
        SIGNAL,
      ),
      safeFailure('private_input'),
    );
  }
  for (const invalid of [
    { ...INPUT, selection: { ...SELECTED, modelID: { echo: 'PRIVATE-MODEL' } } },
    { ...INPUT, generation: -1 },
    { ...INPUT, sessionID: '../PRIVATE-PATH' },
  ]) {
    await assert.rejects(probe.readSession(invalid as never, SIGNAL), safeFailure('invalid'));
  }
  assert.equal(reads, 0);
});

test('OpenCode probe version/errors/foreign sessions/abort hold without retries or raw diagnostic echoes', async () => {
  for (const arm of ['version', 'error', 'foreign', 'abort', 'unauthorized'] as const) {
    const f = fixture2();
    const m = await mock({
      '/api/info': () => ({
        status: arm === 'unauthorized' ? 401 : 200,
        json:
          arm === 'version'
            ? { ...f.server, version: 'PRIVATE-VERSION' }
            : arm === 'error' || arm === 'unauthorized'
              ? { error: 'PRIVATE-AUTH-ERROR' }
              : f.server,
      }),
      '/api/session/ses_fixture': () => ({ json: { data: { ...f.session.data, id: 'ses_foreign' } } }),
    });
    try {
      const signal = new AbortController();
      if (arm === 'abort') signal.abort();
      const probe = createOpenCodeProbe({ url: m.url });
      await assert.rejects(
        probe.readSession(INPUT, signal.signal),
        safeFailure(
          arm === 'version'
            ? 'unsupported'
            : arm === 'abort'
              ? 'cancelled'
              : arm === 'unauthorized'
                ? 'unavailable'
                : 'invalid',
        ),
      );
      assert.equal(m.requests.length, arm === 'abort' ? 0 : arm === 'foreign' ? 2 : 1);
      assert.ok(m.requests.every((request) => request.headers.authorization === undefined));
    } finally {
      await m.close();
    }
  }
});

test('OpenCode fixture success leaves every managed capability held with no automatic handoff or control calls', () => {
  let calls = 0;
  const method = async (): Promise<never> => {
    calls++;
    throw Error('must not control a host');
  };
  assert.ok(Object.values(OPENCODE_MANAGED_CAPS).every((value) => value === 'unverified'));
  assert.throws(
    () =>
      requireManagedControl({
        control: {
          caps: OPENCODE_MANAGED_CAPS,
          observeContext: method,
          fenceAdmission: method,
          quiesce: method,
          startFresh: method,
          seed: method,
          ready: method,
        },
      }),
    safeFailure('unverified'),
  );
  assert.equal(calls, 0);
});
