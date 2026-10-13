import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { BosunError } from '../src/core/errors.ts';
import type { ManagedSession } from '../src/core/domain/session.ts';
import {
  createOpenCodeControl,
  type OpenCodeCreate,
  type OpenCodeControlSettings,
  type OpenCodeControlDependencies,
} from '../src/adapters/hosts/opencode/control.ts';
import { openCodePermissions } from '../src/adapters/hosts/opencode/v2-native.ts';
import {
  captureOpenCodeEvidence,
  OPENCODE_EVIDENCE_LIMITS,
} from '../src/adapters/hosts/opencode/evidence.ts';
import { summarizeEvidence } from '../src/core/use-cases/summarize-evidence.ts';
import { nativeOpenCodeFixture, fixture } from './opencode-native-fixture.ts';

const CWD = '/fixture/project';
const EVIDENCE_BINDING = { cwd: CWD, association: 'owned_fixture_1', serverVersion: fixture.server.version };
const MODEL = 'openai/gpt-6.1-sol';
const SEED = 'Public synthetic bootstrap instructions';
const hash = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
const signal = () => new AbortController().signal;
const input = (extra: Partial<OpenCodeCreate> = {}): OpenCodeCreate => ({
  privacy: 'public',
  ownerId: 'owner_fixture',
  generation: 5,
  requestId: 'create_fixture',
  cwd: CWD,
  model: MODEL,
  effort: 'high',
  access: 'read',
  ...extra,
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function safe(code: string, unknown = false) {
  return (e: unknown) => {
    assert.ok(e instanceof BosunError);
    assert.equal(e.code, code);
    assert.equal(e.details?.outcome, unknown ? 'unknown' : undefined);
    assert.doesNotMatch(
      JSON.stringify(e),
      /SECRET|PRIVATE|CANARY|password|authorization|bootstrap/,
    );
    return true;
  };
}
const native = nativeOpenCodeFixture;
const lastAssistant = (session: any) => session.messages.filter((row: any) => row.type === 'assistant').at(-1);
const lastTool = (session: any) => lastAssistant(session).content.findLast((part: any) => part.type === 'tool');
async function boot(
  n: Awaited<ReturnType<typeof native>>,
  settings: Partial<OpenCodeControlSettings> = {},
  injected: Partial<OpenCodeControlDependencies> = {},
) {
  const driver = n.driver(settings, injected);
  const session = await driver.create(input(), signal());
  await driver.seed(session, { privacy: 'public', text: SEED, hash: hash(SEED) }, signal());
  await driver.ready(session, { seedHash: hash(SEED), model: MODEL, access: 'read' }, signal());
  return { driver, session };
}
function stagedAuthority(n: Awaited<ReturnType<typeof native>>) {
  let selected: ManagedSession | undefined;
  let claim = { ownerId: 'destination_fixture', generation: 6 };
  const dependencies: Partial<OpenCodeControlDependencies> = {
    assertOwner(expected) {
      if (expected.ownerId === 'destination_fixture' && expected.generation === 6) return;
      n.deps.assertOwner(expected);
    },
    freshClaim(source) {
      assert.equal(source.ownerId, 'owner_fixture');
      assert.equal(source.generation, 5);
      return claim;
    },
    assertDispatchOwner(expected) {
      if (
        !selected ||
        expected.ownerId !== selected.ownerId ||
        expected.generation !== selected.generation ||
        expected.sessionId !== selected.sessionId
      )
        throw new BosunError('unverified', 'Dispatch owner unavailable');
    },
  };
  return {
    dependencies,
    select(session: ManagedSession) {
      selected = { ...session };
    },
    setClaim(value: typeof claim) {
      claim = value;
    },
  };
}

test('OpenCode 2 same-major managed sessions retain actual version through repeated captures without qualifying controls', async () => {
  for (const version of ['2.0.0', '2.0.28', '2.17.4']) {
    const n = await native({ version });
    try {
      const { driver, session } = await boot(n);
      assert.ok(Object.values(driver.caps).every(value => value === 'unverified'));
      await driver.run(session, { privacy: 'public', turnId: 'version_turn', text: 'Inspect approved public fixture.' }, signal());
      const first = await driver.capture(session, { privacy: 'public', afterCursor: null }, signal());
      const repeated = await driver.capture(session, { privacy: 'public', afterCursor: null }, signal());
      assert.equal(first.sourceBindingHash, repeated.sourceBindingHash);
      assert.equal(first.snapshotHash, repeated.snapshotHash);
      const root = n.sessions.get(session.sessionId)!;
      assert.equal(first.sourceBindingHash, hash(JSON.stringify({
        session, cwd: CWD, association: root.value.metadata.bosun.association, serverVersion: version,
        seed: { key: root.entries[0].key, hash: hash(SEED) },
      })));
      const before = n.requests.length;
      n.options.version = '2.18.0';
      await assert.rejects(driver.capture(session, { privacy: 'public', afterCursor: null }, signal()), safe('unverified'));
      assert.deepEqual(n.requests.slice(before).map(request => [request.method, request.path]), [['GET', '/api/info']]);
      assert.equal(n.requests.filter(request => request.path.endsWith('/prompt')).length, 1);
    } finally { await n.close(); }
  }
});

test('managed OpenCode constructor and denied create/seed/turn inputs touch no getters, ownership, auth or HTTP', async () => {
  let reads = 0;
  const driver = createOpenCodeControl(
    {
      get url(): never {
        reads++;
        throw Error('PRIVATE-URL');
      },
      get env(): never {
        reads++;
        throw Error('PRIVATE-AUTH');
      },
    },
    {
      get assertOwner(): never {
        reads++;
        throw Error('PRIVATE-OWNER');
      },
      get hash(): never {
        reads++;
        throw Error('PRIVATE-HASH');
      },
      get now(): never {
        reads++;
        throw Error('PRIVATE-TIME');
      },
      get id(): never {
        reads++;
        throw Error('PRIVATE-ID');
      },
    },
  );
  assert.equal(reads, 0);
  const unknownSession = {
    get sessionId(): never {
      reads++;
      throw Error('PRIVATE-SESSION');
    },
  } as unknown as ManagedSession;
  for (const privacy of ['private', 'unknown', undefined]) {
    const denied = {
      privacy,
      get text(): never {
        reads++;
        throw Error('PRIVATE-SEED');
      },
      get hash(): never {
        reads++;
        throw Error('PRIVATE-HASH');
      },
    };
    await assert.rejects(
      driver.create(
        {
          ...input(),
          privacy,
          get cwd(): never {
            reads++;
            throw Error('PRIVATE-CWD');
          },
        } as OpenCodeCreate,
        signal(),
      ),
      safe('private_input'),
    );
    await assert.rejects(
      driver.seed(unknownSession, denied as never, signal()),
      safe('private_input'),
    );
    await assert.rejects(
      driver.run(unknownSession, denied as never, signal()),
      safe('private_input'),
    );
  }
  await assert.rejects(
    driver.seed(
      unknownSession,
      { ...Object.create({ privacy: 'public' }), text: SEED, hash: hash(SEED) },
      signal(),
    ),
    safe('private_input'),
  );
  assert.equal(reads, 0);
});

test('V2 managed creation proves an owned empty root; API instruction seeding has exact idle/hash readback without an inference or inbox item', async () => {
  const n = await native();
  try {
    const driver = n.driver();
    assert.equal(n.requests.length, 0);
    const session = await driver.create(input(), signal());
    assert.deepEqual(session, {
      hostId: 'opencode',
      sessionId: 'ses_fixture_1',
      ownerId: 'owner_fixture',
      generation: 5,
      model: MODEL,
      access: 'read',
    });
    assert.ok(Object.values(driver.caps).every((cap) => cap === 'unverified'));
    const create = n.requests.find((r) => r.method === 'POST')!;
    assert.deepEqual(create.body.model, {
      id: 'gpt-6.1-sol',
      providerID: 'openai',
      variant: 'high',
    });
    assert.equal(create.body.agent, 'build');
    assert.deepEqual(create.body.permissions, openCodePermissions('read'));
    assert.equal(create.body.metadata.bosun.ownerId, 'owner_fixture');
    assert.equal(create.body.metadata.bosun.generation, 5);
    assert.match(create.body.metadata.bosun.association, /^owned_fixture_/);
    assert.ok(
      n.requests.some(
        (r) => r.method === 'GET' && r.path.startsWith('/api/session/ses_fixture_1/message?'),
      ),
    );
    await assert.rejects(
      driver.run(
        session,
        { privacy: 'public', text: 'premature turn', turnId: 'premature' },
        signal(),
      ),
      safe('unverified'),
    );
    await driver.seed(session, { privacy: 'public', text: SEED, hash: hash(SEED) }, signal());
    const seed = n.requests.find((r) => r.method === 'PUT')!;
    assert.deepEqual(seed.body, { value: SEED });
    assert.match(seed.path, /\/instructions\/entries\/bosun\.seed\.[a-f0-9]{64}$/);
    assert.ok(
      n.requests.some(
        (r) => r.method === 'GET' && r.path.endsWith('/instructions/entries'),
      ),
    );
    assert.equal(
      n.sessions.get(session.sessionId)!.messages.length,
      0,
      'no assistant/inference was manufactured by seed',
    );
    assert.deepEqual(
      await driver.ready(session, { seedHash: hash(SEED), model: MODEL, access: 'read' }, signal()),
      {
        sessionId: session.sessionId,
        root: true,
        idle: true,
        seedHash: hash(SEED),
        model: MODEL,
        access: 'read',
        generation: 5,
      },
    );
    assert.ok(
      n.requests.every((r) => r.path.startsWith('/api/') && !new URL(r.path, 'http://fixture').searchParams.has('directory')),
    );
    assert.equal(n.requests.filter((r) => r.path.endsWith('/prompt')).length, 0);
    assert.deepEqual(n.sessions.get(session.sessionId)!.entries.map((entry) => entry.value), [SEED]);
  } finally {
    await n.close();
  }
});

test('native owned turns preserve selection, read-tool limits, completion/idle and bounded output projection', async () => {
  const n = await native();
  try {
    const { driver, session } = await boot(n);
    const events = await driver.run(
      session,
      { privacy: 'public', text: 'public controlled turn', turnId: 'turn_one' },
      signal(),
    );
    assert.deepEqual(
      events.filter((e) => e.t === 'tool'),
      [{ t: 'tool', name: 'read' }],
    );
    assert.equal(events.at(-1)!.t, 'done');
    assert.doesNotMatch(JSON.stringify(events), /SECRET|metadata|ownerId|sessionID/);
    assert.equal(
      n.requests.filter((r) => r.method === 'POST' && r.path === '/api/session').length,
      1,
      'turn reuses its owned root',
    );
    const request = n.requests
      .filter((r) => r.method === 'POST' && r.path.endsWith('/prompt'))
      .at(-1)!;
    assert.equal(Object.hasOwn(request.body, 'noReply'), false);
    assert.equal(request.body.delivery, 'queue');
    assert.equal(request.body.resume, true);
    const before = n.requests.length;
    await assert.rejects(
      driver.run(session, { privacy: 'public', text: 'repeat', turnId: 'turn_one' }, signal()),
      safe('unverified'),
    );
    assert.equal(n.requests.length, before, 'same turn never repeats native effects');
    const sample = await driver.observeContext(session, signal());
    assert.equal(sample.usedTokens, null);
    assert.equal(sample.windowTokens, null);
    assert.equal(sample.scope, 'unknown');
    assert.equal(sample.quality, 'unknown');
    assert.equal(sample.generation, 5);
    assert.match(sample.turnId, /^msg_idle_/);
    assert.equal(driver.caps.contextTelemetry, 'unverified');
  } finally {
    await n.close();
  }
});

test('root/model/cwd/agent/permissions/owner/generation/nonce mismatches and nonempty root never admit a seed', async () => {
  const modifiers = [
    (s: any) => {
      s.parentID = 'ses_foreign';
    },
    (s: any) => {
      s.model.id = 'foreign';
    },
    (s: any) => {
      s.location.directory = '/foreign';
    },
    (s: any) => {
      s.agent = 'foreign';
    },
    (s: any) => {
      s.permissions = [{ action: '*', resource: '*', effect: 'allow' }];
    },
    (s: any) => {
      s.metadata.bosun.ownerId = 'foreign';
    },
    (s: any) => {
      s.metadata.bosun.generation++;
    },
    (s: any) => {
      s.metadata.bosun.association = 'foreign';
    },
  ];
  for (const modifyCreate of modifiers) {
    const n = await native({ modifyCreate });
    try {
      await assert.rejects(n.driver().create(input(), signal()), (e) => {
        assert.ok(e instanceof BosunError);
        assert.equal(e.details?.outcome, 'unknown');
        return true;
      });
      assert.equal(n.requests.filter((r) => r.method === 'POST').length, 1);
      assert.ok(
        n.requests.every((r) => !r.path.includes('/interrupt') && !r.path.includes('/message?')),
      );
    } finally {
      await n.close();
    }
  }
  const n = await native({
    modifyHistory(rows) {
      rows.push({ id: 'msg_foreign', type: 'user', time: { created: 1 }, text: 'Foreign public input' });
    },
  });
  try {
    await assert.rejects(n.driver().create(input(), signal()), safe('unverified', true));
    assert.equal(n.requests.filter((r) => r.method === 'POST').length, 1);
  } finally {
    await n.close();
  }
});

test('arbitrary native/UI sessions and stale owner/generation/model/access handles are rejected before HTTP', async () => {
  const n = await native();
  try {
    const { driver, session } = await boot(n);
    for (const extra of [
      { sessionId: 'ses_foreign' },
      { hostId: 'codex' },
      { ownerId: 'foreign' },
      { generation: 6 },
      { model: 'openai/foreign' },
      { access: 'edit' as const },
    ]) {
      const before = n.requests.length;
      await assert.rejects(
        driver.observeContext({ ...session, ...extra }, signal()),
        safe('unverified'),
      );
      assert.equal(n.requests.length, before);
    }
    n.changeOwner();
    const before = n.requests.length;
    await assert.rejects(
      driver.run(session, { privacy: 'public', text: 'stale owner', turnId: 'stale' }, signal()),
      safe('unverified'),
    );
    assert.equal(n.requests.length, before);
  } finally {
    await n.close();
  }
});

test('wrong seed hash is rejected before HTTP; altered/foreign readback cannot acknowledge and never retries seed', async () => {
  const n = await native();
  try {
    const driver = n.driver();
    const session = await driver.create(input(), signal());
    const before = n.requests.length;
    await assert.rejects(
      driver.seed(session, { privacy: 'public', text: SEED, hash: hash('wrong') }, signal()),
      safe('invalid'),
    );
    assert.equal(n.requests.length, before);
  } finally {
    await n.close();
  }
  for (const modifyReadback of [
    (r: any) => {
      r.value = 'SECRET-CHANGED-SEED';
    },
    (r: any) => {
      r.sessionID = 'ses_foreign';
    },
    (r: any) => {
      r.key = 'foreign.seed';
    },
    (r: any) => {
      r.privacy = 'private';
    },
  ]) {
    const n = await native({ modifyReadback });
    try {
      const driver = n.driver();
      const session = await driver.create(input(), signal());
      await assert.rejects(
        driver.seed(session, { privacy: 'public', text: SEED, hash: hash(SEED) }, signal()),
        safe('unverified', true),
      );
      const before = n.requests.length;
      await assert.rejects(
        driver.seed(session, { privacy: 'public', text: SEED, hash: hash(SEED) }, signal()),
        safe('unverified'),
      );
      await assert.rejects(
        driver.ready(session, { seedHash: hash(SEED), model: MODEL, access: 'read' }, signal()),
        safe('unverified'),
      );
      assert.equal(n.requests.length, before);
      assert.equal(n.requests.filter((r) => r.method === 'PUT').length, 1);
      assert.equal(n.sessions.size, 1);
      assert.ok(n.requests.every((r) => r.method !== 'DELETE'));
    } finally {
      await n.close();
    }
  }
});

test('readiness rechecks native owner/model/access/history/idle and exact seed, rather than accepting local seed receipts', async () => {
  for (const change of [
    (s: any) => {
      s.value.permissions = [];
    },
    (s: any) => {
      s.value.model.variant = 'low';
    },
    (s: any) => {
      s.value.metadata.bosun.generation++;
    },
    (s: any) => {
      s.entries[0].value = 'SECRET-ALTERED';
    },
    (s: any) => {
      s.busy = true;
    },
  ]) {
    const n = await native();
    try {
      const driver = n.driver();
      const session = await driver.create(input(), signal());
      await driver.seed(session, { privacy: 'public', text: SEED, hash: hash(SEED) }, signal());
      change(n.sessions.get(session.sessionId)!);
      await assert.rejects(
        driver.ready(session, { seedHash: hash(SEED), model: MODEL, access: 'read' }, signal()),
        (e) => {
          assert.ok(e instanceof BosunError);
          return true;
        },
      );
      await assert.rejects(
        driver.run(
          session,
          { privacy: 'public', text: 'must remain blocked', turnId: 'blocked' },
          signal(),
        ),
        safe('unverified'),
      );
      assert.equal(n.requests.filter((r) => r.method === 'POST').length, 1);
    } finally {
      await n.close();
    }
  }
});

test('local fence stops admissions before native probing; quiescence waits for bound idle AND terminal tool parts', async () => {
  const n = await native();
  try {
    const { driver, session } = await boot(n, { quiesceMode: 'wait' });
    await driver.run(
      session,
      { privacy: 'public', text: 'completed public turn', turnId: 'one' },
      signal(),
    );
    const nativeSession = n.sessions.get(session.sessionId)!;
    lastTool(nativeSession).state.status = 'running';
    const pendingFence = driver.fenceAdmission(session, signal());
    const before = n.requests.length;
    await assert.rejects(
      driver.run(session, { privacy: 'public', text: 'fenced', turnId: 'two' }, signal()),
      safe('unverified'),
    );
    const fence = await pendingFence;
    assert.equal(driver.caps.promptAdmission, 'unverified');
    assert.ok(n.requests.length >= before);
    let settled = false;
    const waiting = driver.quiesce(session, fence, signal()).then((v) => {
      settled = true;
      return v;
    });
    await tick();
    await tick();
    assert.equal(settled, false, 'idle status alone cannot prove stopped tool');
    n.finish();
    assert.deepEqual(await waiting, {
      sessionId: session.sessionId,
      generation: 5,
      pendingTools: 0,
      idle: true,
    });
    assert.equal(n.requests.filter((r) => r.path.includes('/interrupt?')).length, 0);
  } finally {
    await n.close();
  }
});

test('owned turn cancellation/quiescence share one native abort and wait past HTTP close until tool/idle proof', async () => {
  const n = await native({ holdTurn: true, holdAbort: true });
  try {
    const { driver, session } = await boot(n);
    const ctl = new AbortController();
    let runSettled = false;
    const running = driver
      .run(session, { privacy: 'public', text: 'held public turn', turnId: 'held' }, ctl.signal)
      .catch((e) => e)
      .finally(() => {
        runSettled = true;
      });
    await n.started;
    const fence = await driver.fenceAdmission(session, signal());
    let quiet = false;
    const waiting = driver.quiesce(session, fence, signal()).then((v) => {
      quiet = true;
      return v;
    });
    await n.aborted;
    await tick();
    assert.equal(runSettled, false);
    assert.equal(quiet, false);
    n.finish();
    assert.equal((await waiting).pendingTools, 0);
    safe('cancelled', true)(await running);
    assert.equal(n.requests.filter((r) => r.path.includes('/interrupt?')).length, 1);
    assert.equal(
      n.requests.filter(
        (r) => r.method === 'POST' && r.path.endsWith('/prompt'),
      ).length,
      1,
    );
  } finally {
    n.finish();
    await n.close();
  }
});

test('uncertain create/seed/turn effects are held without deletion or automatic effect replay', async () => {
  for (const fault of ['createFault', 'seedFault', 'turnFault'] as const) {
    const n = await native({ [fault]: true });
    try {
      const driver = n.driver();
      if (fault === 'createFault') {
        await assert.rejects(driver.create(input(), signal()), safe('unavailable', true));
        const before = n.requests.length;
        await assert.rejects(driver.create(input(), signal()), safe('unverified'));
        assert.equal(n.requests.length, before);
      } else {
        const session = await driver.create(input(), signal());
        if (fault === 'seedFault') {
          await assert.rejects(
            driver.seed(session, { privacy: 'public', text: SEED, hash: hash(SEED) }, signal()),
            safe('unavailable', true),
          );
          const before = n.requests.length;
          await assert.rejects(
            driver.seed(session, { privacy: 'public', text: SEED, hash: hash(SEED) }, signal()),
            safe('unverified'),
          );
          assert.equal(n.requests.length, before);
        } else {
          await driver.seed(session, { privacy: 'public', text: SEED, hash: hash(SEED) }, signal());
          await driver.ready(
            session,
            { seedHash: hash(SEED), model: MODEL, access: 'read' },
            signal(),
          );
          await assert.rejects(
            driver.run(
              session,
              { privacy: 'public', text: 'lost public turn', turnId: 'lost' },
              signal(),
            ),
            safe('unavailable', true),
          );
          const before = n.requests.length;
          await assert.rejects(
            driver.run(
              session,
              { privacy: 'public', text: 'lost public turn', turnId: 'lost' },
              signal(),
            ),
            safe('unverified'),
          );
          assert.equal(n.requests.length, before);
        }
      }
      assert.equal(n.sessions.size, 1);
      assert.ok(
        n.requests.every((r) => r.method !== 'DELETE' && !/fork|summarize|revert/.test(r.path)),
      );
    } finally {
      await n.close();
    }
  }
});

test('fresh destination is a separate empty root association; failed creation/seed/ack leaves fenced source history intact', async () => {
  for (const failure of ['none', 'create', 'seed', 'ack', 'foreign'] as const) {
    const n = await native();
    try {
      const staged = stagedAuthority(n);
      const { driver, session: source } = await boot(n, {}, staged.dependencies);
      staged.select(source);
      await driver.run(
        source,
        { privacy: 'public', text: 'source public task', turnId: 'source' },
        signal(),
      );
      const before = structuredClone(n.sessions.get(source.sessionId));
      const fence = await driver.fenceAdmission(source, signal());
      if (failure === 'create') n.options.createFault = true;
      if (failure === 'foreign')
        n.options.modifyCreate = (s, index) => {
          if (index === 2) s.id = source.sessionId;
        };
      if (failure === 'create' || failure === 'foreign')
        await assert.rejects(driver.startFresh(source, signal()), (e) => {
          assert.ok(e instanceof BosunError);
          assert.equal(e.details?.outcome, 'unknown');
          return true;
        });
      else {
        const destination = await driver.startFresh(source, signal());
        assert.notEqual(destination.sessionId, source.sessionId);
        assert.equal(destination.generation, 6);
        assert.equal(destination.ownerId, 'destination_fixture');
        assert.equal(n.sessions.get(destination.sessionId)!.messages.length, 0);
        assert.equal(n.sessions.get(destination.sessionId)!.value.parentID, undefined);
        assert.notEqual(
          n.sessions.get(destination.sessionId)!.value.metadata.bosun.association,
          n.sessions.get(source.sessionId)!.value.metadata.bosun.association,
        );
        if (failure === 'seed') n.options.seedFault = true;
        if (failure === 'ack')
          n.options.modifyReadback = (r) => {
            if (r.key === n.sessions.get(destination.sessionId)!.entries[0].key) r.value = 'SECRET-FOREIGN-SEED';
          };
        const seed = driver.seed(
          destination,
          { privacy: 'public', text: SEED, hash: hash(SEED) },
          signal(),
        );
        if (failure === 'seed' || failure === 'ack')
          await assert.rejects(seed, safe(failure === 'seed' ? 'unavailable' : 'unverified', true));
        else await seed;
      }
      assert.deepEqual(n.sessions.get(source.sessionId), before);
      assert.ok(n.requests.every((r) => r.method !== 'DELETE'));
      const count = n.requests.length;
      await assert.rejects(driver.startFresh(source, signal()), safe('unverified'));
      assert.equal(n.requests.length, count);
      assert.equal((await driver.quiesce(source, fence, signal())).idle, true);
    } finally {
      await n.close();
    }
  }
});

test('staged next-generation destination can seed/ack but dispatch requires exact native session selection after CAS', async () => {
  const n = await native();
  try {
    const staged = stagedAuthority(n);
    const { driver, session: source } = await boot(n, {}, staged.dependencies);
    staged.select(source);
    const fence = await driver.fenceAdmission(source, signal());
    const destination = await driver.startFresh(source, signal());
    assert.equal(destination.generation, source.generation + 1);
    assert.equal(n.sessions.get(destination.sessionId)!.value.metadata.bosun.generation, 6);
    await driver.seed(destination, { privacy: 'public', text: SEED, hash: hash(SEED) }, signal());
    assert.equal(
      (
        await driver.ready(
          destination,
          { seedHash: hash(SEED), model: MODEL, access: 'read' },
          signal(),
        )
      ).generation,
      6,
    );
    const count = n.requests.length;
    await assert.rejects(
      driver.run(
        destination,
        { privacy: 'public', text: 'staged work', turnId: 'staged' },
        signal(),
      ),
      safe('unverified'),
    );
    assert.equal(n.requests.length, count, 'bootstrap authorization does not permit work I/O');
    staged.select({ ...destination, sessionId: 'ses_foreign' });
    await assert.rejects(
      driver.run(
        destination,
        { privacy: 'public', text: 'foreign dispatch', turnId: 'foreign' },
        signal(),
      ),
      safe('unverified'),
    );
    assert.equal(n.requests.length, count, 'dispatch identity includes the exact native session');
    staged.select(destination); // Synthetic durable ownership CAS selects the acknowledged destination.
    const events = await driver.run(
      destination,
      { privacy: 'public', text: 'selected destination work', turnId: 'selected' },
      signal(),
    );
    assert.equal(events.at(-1)!.t, 'done');
    const after = n.requests.length;
    await assert.rejects(
      driver.run(
        source,
        { privacy: 'public', text: 'retired source', turnId: 'retired' },
        signal(),
      ),
      safe('unverified'),
    );
    await assert.rejects(driver.resumeFenced(source, fence, signal()), safe('unverified'));
    assert.equal(
      n.requests.length,
      after,
      'source cannot resume after destination selection even with metadata access',
    );
    assert.equal(driver.caps.promptAdmission, 'unverified');
  } finally {
    await n.close();
  }
});

test('fresh preparation needs an authorized staged next generation and dispatch gate before any new root creation', async () => {
  const n = await native();
  try {
    const { driver, session } = await boot(n);
    await driver.fenceAdmission(session, signal());
    const count = n.requests.length;
    await assert.rejects(driver.startFresh(session, signal()), safe('unverified'));
    assert.equal(n.requests.length, count, 'manual driver cannot guess a transfer claim');
  } finally {
    await n.close();
  }
  for (const claim of [
    { ownerId: '', generation: 6 },
    { ownerId: 'destination_fixture', generation: 5 },
    { ownerId: 'destination_fixture', generation: 7 },
    { ownerId: 'foreign', generation: 6 },
  ]) {
    const n = await native();
    try {
      const staged = stagedAuthority(n);
      staged.setClaim(claim);
      const { driver, session } = await boot(n, {}, staged.dependencies);
      staged.select(session);
      const fence = await driver.fenceAdmission(session, signal());
      const count = n.requests.length;
      await assert.rejects(driver.startFresh(session, signal()), safe('unverified'));
      assert.equal(n.requests.length, count);
      assert.equal(n.sessions.size, 1);
      await driver.resumeFenced(session, fence, signal());
      assert.equal(
        (
          await driver.run(
            session,
            {
              privacy: 'public',
              text: 'source after known preparation refusal',
              turnId: 'resumed',
            },
            signal(),
          )
        ).at(-1)!.t,
        'done',
      );
    } finally {
      await n.close();
    }
  }
});

test('source resume clears only its matching local fence after current ownership, full native history, idle and stopped tools', async () => {
  const n = await native();
  try {
    const { driver, session } = await boot(n);
    await driver.run(
      session,
      { privacy: 'public', text: 'known source turn', turnId: 'source' },
      signal(),
    );
    const fence = await driver.fenceAdmission(session, signal());
    const count = n.requests.length;
    await assert.rejects(
      driver.resumeFenced(session, { ...fence, token: 'foreign' }, signal()),
      safe('unverified'),
    );
    assert.equal(n.requests.length, count);
    const nativeSession = n.sessions.get(session.sessionId)!;
    lastTool(nativeSession).state.status = 'running';
    await assert.rejects(driver.resumeFenced(session, fence, signal()), safe('unverified'));
    const after = n.requests.length;
    await assert.rejects(
      driver.run(session, { privacy: 'public', text: 'still fenced', turnId: 'fenced' }, signal()),
      safe('unverified'),
    );
    assert.equal(n.requests.length, after);
    n.finish();
    await driver.resumeFenced(session, fence, signal());
    assert.equal(
      (
        await driver.run(
          session,
          { privacy: 'public', text: 'explicit next source turn', turnId: 'next' },
          signal(),
        )
      ).at(-1)!.t,
      'done',
    );
    await assert.rejects(driver.resumeFenced(session, fence, signal()), safe('unverified'));
  } finally {
    await n.close();
  }
  const unknown = await native({ holdTurn: true });
  try {
    const { driver, session } = await boot(unknown);
    const running = driver
      .run(session, { privacy: 'public', text: 'uncertain turn', turnId: 'uncertain' }, signal())
      .catch((e) => e);
    await unknown.started;
    const fence = await driver.fenceAdmission(session, signal());
    await driver.quiesce(session, fence, signal());
    safe('cancelled', true)(await running);
    const count = unknown.requests.length;
    await assert.rejects(driver.resumeFenced(session, fence, signal()), safe('unverified'));
    assert.equal(unknown.requests.length, count, 'unknown source never reopens');
  } finally {
    await unknown.close();
  }
  const invalid = await native();
  try {
    const { driver, session } = await boot(invalid);
    const fence = await driver.fenceAdmission(session, signal());
    invalid.sessions.get(session.sessionId)!.value.model.id = 'foreign';
    assert.equal((await driver.observeContext(session, signal())).generation, 6);
    const count = invalid.requests.length;
    await assert.rejects(driver.resumeFenced(session, fence, signal()), safe('unverified'));
    assert.equal(invalid.requests.length, count, 'invalid source never reopens');
  } finally {
    await invalid.close();
  }
});

test('fresh creation rechecks a source made unknown by in-flight native abort and cannot reopen it during preparation', async () => {
  const n = await native({ holdTurn: true });
  try {
    const staged = stagedAuthority(n);
    const { driver, session: source } = await boot(n, {}, staged.dependencies);
    staged.select(source);
    const running = driver
      .run(
        source,
        { privacy: 'public', text: 'source interrupted during preparation', turnId: 'interrupted' },
        signal(),
      )
      .catch((e) => e);
    await n.started;
    await driver.fenceAdmission(source, signal());
    await assert.rejects(driver.startFresh(source, signal()), safe('unverified'));
    safe('cancelled', true)(await running);
    assert.equal(n.sessions.size, 1);
    assert.equal(
      n.requests.filter((r) => r.method === 'POST' && r.path === '/api/session').length,
      1,
    );
    assert.ok(n.requests.every((r) => r.method !== 'DELETE'));
  } finally {
    n.finish();
    await n.close();
  }
});

test('managed completion errors/foreign/tool violations remain unknown with one abort and no projected partial result', async () => {
  const modifiers = [
    (r: any) => {
      delete r.time.completed;
    },
    (r: any) => {
      r.error = { message: 'SECRET-ERROR' };
    },
    (r: any) => {
      r.model = { ...r.model, id: 'foreign' };
    },
    (r: any) => {
      r.content.at(-1).name = 'shell';
    },
    (r: any) => {
      r.content.at(-1).state.status = 'running';
    },
    (r: any) => {
      r.content.find((p: any) => p.type === 'text').text = 'x'.repeat(65537);
    },
  ];
  for (const [index, modifyCompletion] of modifiers.entries()) {
    const n = await native({ modifyCompletion });
    try {
      const { driver, session } = await boot(n);
      await assert.rejects(
        driver.run(
          session,
          { privacy: 'public', text: 'public failed completion', turnId: 'failed' },
          signal(),
        ),
        safe(index === 2 || index === 3 ? 'unverified' : 'unavailable', true),
      );
      assert.equal(n.requests.filter((r) => r.path.includes('/interrupt?')).length, 1);
      const count = n.requests.length;
      await assert.rejects(
        driver.run(session, { privacy: 'public', text: 'no replay', turnId: 'another' }, signal()),
        safe('unverified'),
      );
      assert.equal(n.requests.length, count);
    } finally {
      await n.close();
    }
  }
});

test('concurrent denied admissions cannot release an active owned turn lock or submit a second native prompt', async () => {
  const n = await native({ holdTurn: true });
  try {
    const { driver, session } = await boot(n);
    const ctl = new AbortController();
    const active = driver
      .run(session, { privacy: 'public', text: 'held owner turn', turnId: 'active' }, ctl.signal)
      .catch((e) => e);
    await n.started;
    for (const turnId of ['second', 'third'])
      await assert.rejects(
        driver.run(session, { privacy: 'public', text: 'concurrent turn', turnId }, signal()),
        safe('unverified'),
      );
    assert.equal(
      n.requests.filter(
        (r) => r.method === 'POST' && r.path.endsWith('/prompt'),
      ).length,
      1,
    );
    ctl.abort();
    safe('cancelled', true)(await active);
    assert.equal(n.requests.filter((r) => r.path.includes('/interrupt?')).length, 1);
  } finally {
    n.finish();
    await n.close();
  }
});

test('native compaction/model/generation changes invalidate samples; catalog maximum/billed totals never become trigger-ready occupancy', async () => {
  for (const mutate of [
    (s: any) => {
      s.value.model.id = 'foreign';
    },
    (s: any) => {
      s.value.time.archived = 100001;
    },
    (s: any) => {
      s.value.metadata.bosun.generation++;
    },
    (s: any) => {
      lastAssistant(s).type = 'compaction';
    },
  ]) {
    const n = await native();
    try {
      const { driver, session } = await boot(n);
      await driver.run(
        session,
        { privacy: 'public', text: 'sample public turn', turnId: 'sample' },
        signal(),
      );
      mutate(n.sessions.get(session.sessionId)!);
      const sample = await driver.observeContext(session, signal());
      assert.equal(sample.generation, 6);
      assert.equal(sample.usedTokens, null);
      assert.equal(sample.windowTokens, null);
      assert.equal(sample.quality, 'unknown');
      const before = n.requests.length;
      await assert.rejects(
        driver.run(
          session,
          { privacy: 'public', text: 'invalidated turn', turnId: 'later' },
          signal(),
        ),
        safe('unverified'),
      );
      assert.equal(n.requests.length, before);
      assert.equal(driver.caps.contextTelemetry, 'unverified');
      assert.equal(driver.caps.promptAdmission, 'unverified');
    } finally {
      await n.close();
    }
  }
});

test('unsupported selections/input limits and native version mismatch fail without unintended mutations', async () => {
  const n = await native();
  try {
    const driver = n.driver();
    for (const extra of [
      { cwd: 'relative' },
      { access: 'shell' as never },
      { model: 'missing-provider' },
      { generation: -1 },
    ])
      await assert.rejects(driver.create(input(extra), signal()), safe('invalid'));
    await assert.rejects(
      driver.create({ ...input(), maxTurns: 1 } as OpenCodeCreate, signal()),
      safe('unsupported'),
    );
    assert.equal(n.requests.length, 0);
    const session = await driver.create(input(), signal());
    const before = n.requests.length;
    await assert.rejects(
      driver.seed(
        session,
        { privacy: 'public', text: 'a'.repeat(16385), hash: hash('a'.repeat(16385)) },
        signal(),
      ),
      safe('invalid'),
    );
    await assert.rejects(
      driver.run(
        session,
        { privacy: 'public', text: 'a'.repeat(32769), turnId: 'large' },
        signal(),
      ),
      safe('invalid'),
    );
    assert.equal(n.requests.length, before);
  } finally {
    await n.close();
  }
  const mismatch = await native({ version: '1.18.34' });
  try {
    await assert.rejects(mismatch.driver().create(input(), signal()), safe('unsupported'));
    assert.deepEqual(
      mismatch.requests.map((r) => r.path),
      ['/api/info'],
    );
  } finally {
    await mismatch.close();
  }
});

test('owned native capture preserves public inputs/answers and exact references without tool payloads, reasoning or new inference', async () => {
  const n = await native();
  try {
    const { driver, session } = await boot(n);
    await driver.run(
      session,
      { privacy: 'public', text: 'Do not change the selected model.', turnId: 'capture-one' },
      signal(),
    );
    const row = lastAssistant(n.sessions.get(session.sessionId));
    row.content.push({
      type: 'reasoning',
      sessionID: session.sessionId,
      text: 'PRIVATE-REASONING-CANARY',
      metadata: { signature: 'SECRET-SIGNATURE' },
    });
    const writes = n.requests.filter((request) => request.method !== 'GET').length;
    const captured = await driver.capture(
      session,
      { privacy: 'public', afterCursor: null },
      signal(),
    );
    assert.equal(captured.coverage, 'admitted-public-text-and-native-references');
    assert.equal(captured.complete, true);
    assert.equal(captured.totalEvents, 4);
    assert.deepEqual(
      captured.evidence.slice(0, 3).map((event) => event.text),
      [SEED, 'Do not change the selected model.', 'Synthetic fixture response only.'],
    );
    assert.equal(captured.references.at(-1)!.kind, 'tool-reference');
    assert.doesNotMatch(
      JSON.stringify(captured),
      /PRIVATE|SECRET|SIGNATURE|TOOL-INPUT|TOOL-OUTPUT/,
    );
    assert.equal(n.requests.filter((request) => request.method !== 'GET').length, writes);
    const again = await driver.capture(session, { privacy: 'public', afterCursor: null }, signal());
    assert.deepEqual(again, captured);
    const empty = await driver.capture(
      session,
      { privacy: 'public', afterCursor: captured.completedEventCursor },
      signal(),
    );
    assert.equal(empty.complete, true);
    assert.deepEqual(empty.evidence, []);
    assert.equal(empty.completedEventCursor, captured.completedEventCursor);
    assert.equal((await driver.observeContext(session, signal())).modelId, MODEL);
    assert.equal(driver.caps.contextTelemetry, 'unverified');
    let calls = 0;
    const result = await summarizeEvidence(
      { privacy: 'public', evidence: captured.evidence },
      {
        providerId: 'synthetic',
        model: 'pinned-summary',
        maxInputBytes: 24576,
        signal: signal(),
        hash,
        provider: {
          id: 'synthetic',
          caps: {
            structured: 'verified',
            toolFree: 'verified',
            local: 'verified',
            numCtx: 'verified',
          },
          async health() {
            return true;
          },
          async generate(spec) {
            calls++;
            const payload = JSON.parse(spec.messages[1].content);
            assert.equal(spec.model, 'pinned-summary');
            assert.doesNotMatch(JSON.stringify(payload), /PRIVATE|SECRET|SIGNATURE/);
            return {
              model: 'pinned-summary',
              text: JSON.stringify({
                items: [
                  {
                    evidenceId: payload.evidence[1].id,
                    quote: 'Do not change the selected model.',
                  },
                ],
              }),
            };
          },
        },
      },
    );
    assert.equal(calls, 1);
    assert.equal(result.summary.coverage.lastCursor, captured.completedEventCursor);
    assert.match(result.summary.text, /Do not change the selected model/);
  } finally {
    await n.close();
  }
});

test('incremental capture starts after an exact retained prefix and refuses changed, foreign or missing cursors', async () => {
  const n = await native();
  try {
    const { driver, session } = await boot(n);
    await driver.run(
      session,
      { privacy: 'public', text: 'First admitted public task', turnId: 'first-capture' },
      signal(),
    );
    const first = await driver.capture(session, { privacy: 'public', afterCursor: null }, signal());
    await driver.run(
      session,
      {
        privacy: 'public',
        text: 'New accepted constraint after the first window.',
        turnId: 'second-capture',
      },
      signal(),
    );
    const second = await driver.capture(
      session,
      { privacy: 'public', afterCursor: first.completedEventCursor },
      signal(),
    );
    assert.equal(second.evidence.length, 3);
    assert.equal(second.totalEvents, 7);
    assert.equal(second.complete, true);
    assert.equal(second.evidence[0].text, 'New accepted constraint after the first window.');
    assert.ok(second.evidence.every((event) => !first.evidence.some((old) => old.id === event.id)));
    const source = n.sessions.get(session.sessionId)!;
    lastAssistant({ messages: source.messages.slice(0, 3) }).content.find((part: any) => part.type === 'text').text =
      'Earlier public answer changed';
    await assert.rejects(
      driver.capture(
        session,
        { privacy: 'public', afterCursor: first.completedEventCursor },
        signal(),
      ),
      safe('conflict'),
    );
    const other = await driver.create(input({ requestId: 'other-capture' }), signal());
    await driver.seed(other, { privacy: 'public', text: SEED, hash: hash(SEED) }, signal());
    await driver.ready(other, { seedHash: hash(SEED), model: MODEL, access: 'read' }, signal());
    await assert.rejects(
      driver.capture(
        other,
        { privacy: 'public', afterCursor: first.completedEventCursor },
        signal(),
      ),
      safe('conflict'),
    );
  } finally {
    await n.close();
  }
});

test('capture privacy and native ownership gates precede cursor/source getters and all HTTP', async () => {
  const n = await native();
  let reads = 0;
  try {
    const { driver, session } = await boot(n);
    const before = n.requests.length;
    for (const privacy of ['private', 'unknown', undefined]) {
      const input = {
        privacy,
        get afterCursor(): never {
          reads++;
          throw Error('PRIVATE-CURSOR');
        },
      } as never;
      await assert.rejects(driver.capture(session, input, signal()), safe('private_input'));
    }
    await assert.rejects(
      driver.capture(
        { ...session, ownerId: 'foreign' },
        { privacy: 'public', afterCursor: null },
        signal(),
      ),
      safe('unverified'),
    );
    assert.equal(reads, 0);
    assert.equal(n.requests.length, before);
    const bound = { ...session };
    const row = {
      privacy: 'private',
      get info(): never {
        reads++;
        throw Error('PRIVATE-PAYLOAD');
      },
    };
    assert.throws(() => captureOpenCodeEvidence(bound, [row], null, hash, EVIDENCE_BINDING));
    const privateInfo = {
      info: { privacy: 'private' },
      get parts(): never {
        reads++;
        throw Error('PRIVATE-PARTS');
      },
    };
    assert.throws(() =>
      captureOpenCodeEvidence(bound, [privateInfo], null, hash, EVIDENCE_BINDING),
    );
    assert.equal(reads, 0);
  } finally {
    await n.close();
  }
});

test('capture rejects unfinished, failed, private, synthetic, foreign and unsupported native evidence without returning a partial window', async () => {
  for (const change of [
    (row: any) => {
      row.content.at(-1).state.status = 'running';
    },
    (row: any) => {
      row.content.at(-1).state.status = 'error';
    },
    (row: any) => {
      row.content.find((part: any) => part.type === 'text').privacy = 'private';
    },
    (row: any) => {
      row.content.find((part: any) => part.type === 'text').synthetic = true;
    },
    (row: any) => {
      row.content.find((part: any) => part.type === 'text').text = 'sk-proj-' + 'A'.repeat(64);
    },
    (row: any) => {
      row.content.at(-1).name = 'mcp_private';
    },
    (row: any) => {
      row.content.at(-1).type = 'subtask';
    },
  ]) {
    const n = await native();
    try {
      const { driver, session } = await boot(n);
      await driver.run(
        session,
        { privacy: 'public', text: 'Capture a completed public task', turnId: 'denied-capture' },
        signal(),
      );
      change(lastAssistant(n.sessions.get(session.sessionId)));
      const writes = n.requests.filter((request) => request.method !== 'GET').length;
      await assert.rejects(
        driver.capture(session, { privacy: 'public', afterCursor: null }, signal()),
        (error) => {
          assert.ok(error instanceof BosunError);
          assert.ok(['unverified', 'private_input'].includes(error.code));
          return true;
        },
      );
      assert.equal(n.requests.filter((request) => request.method !== 'GET').length, writes);
    } finally {
      await n.close();
    }
  }
});

test('bounded UTF8 windows never skip an event at a byte boundary or advance beyond unprocessed evidence', () => {
  const session = {
    hostId: 'opencode',
    sessionId: 'ses_chunks',
    ownerId: 'owner_fixture',
    generation: 5,
    model: MODEL,
    access: 'read' as const,
  };
  const text = '🙂'.repeat(40000);
  const rows = [
    {
      id: 'msg_chunks', type: 'assistant', time: { completed: 1 },
      content: [
        { type: 'text', text },
        {
          type: 'text',
          text: 'Important short constraint after the large evidence.',
        },
      ],
    },
  ];
  const first = captureOpenCodeEvidence(session, rows, null, hash, EVIDENCE_BINDING);
  assert.equal(first.complete, false);
  assert.ok(
    first.evidence.every(
      (event) => Buffer.byteLength(event.text) <= OPENCODE_EVIDENCE_LIMITS.chunkBytes,
    ),
  );
  assert.ok(first.evidence.every((event) => !event.text.includes('short constraint')));
  const second = captureOpenCodeEvidence(
    session,
    rows,
    first.completedEventCursor,
    hash,
    EVIDENCE_BINDING,
  );
  assert.throws(
    () =>
      captureOpenCodeEvidence(session, rows, first.completedEventCursor, hash, {
        ...EVIDENCE_BINDING,
        cwd: '/fixture/foreign',
      }),
    (error) => error instanceof BosunError && error.code === 'conflict',
  );
  assert.throws(
    () =>
      captureOpenCodeEvidence(session, rows, first.completedEventCursor, hash, {
        ...EVIDENCE_BINDING,
        association: 'foreign-native-instance',
      }),
    (error) => error instanceof BosunError && error.code === 'conflict',
  );
  assert.throws(
    () =>
      captureOpenCodeEvidence(session, rows, first.completedEventCursor, hash, {
        ...EVIDENCE_BINDING,
        serverVersion: '2.1.0',
      }),
    (error) => error instanceof BosunError && error.code === 'conflict',
  );
  assert.equal(second.complete, true);
  assert.equal(
    [...first.evidence, ...second.evidence].map((event) => event.text).join(''),
    text + 'Important short constraint after the large evidence.',
  );
  const ids = [...first.evidence, ...second.evidence].map((event) => event.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('paired native snapshots detect source drift during capture; malformed/repeated/missing page cursors never silently truncate history', async () => {
  const n = await native();
  try {
    const { driver, session } = await boot(n);
    await driver.run(
      session,
      { privacy: 'public', text: 'Stable public source', turnId: 'stable-source' },
      signal(),
    );
    let reads = 0;
    n.options.modifyHistory = (rows) => {
      if (++reads > 3)
        lastAssistant({ messages: rows }).content.find((part: any) => part.type === 'text').text = 'Changed during capture';
    };
    await assert.rejects(
      driver.capture(session, { privacy: 'public', afterCursor: null }, signal()),
      safe('unverified'),
    );
    n.options.modifyHistory = undefined;
    for (const nextCursor of ['https://foreign.invalid/private', 'c_0', 'x'.repeat(2049)]) {
      n.options.nextCursor = nextCursor;
      await assert.rejects(
        driver.capture(session, { privacy: 'public', afterCursor: null }, signal()),
        safe('unverified'),
      );
    }
    n.options.nextCursor = undefined;
    n.options.hideCursor = true;
    await assert.rejects(
      driver.capture(session, { privacy: 'public', afterCursor: null }, signal()),
      safe('unverified'),
    );
    assert.ok(n.requests.every((request) => {
      assert.ok(request.path.startsWith('/api/'));
      if (!request.path.includes('/message?')) return true;
      const params = new URL(request.path, n.url).searchParams;
      return params.has('cursor') ? !params.has('order') : params.get('order') === 'asc';
    }));
  } finally {
    await n.close();
  }
});

test('paged owned history exceeds the former whole-response limit while keeping per-page and source budgets and exact source coverage', async () => {
  const n = await native();
  try {
    const { driver, session } = await boot(n, { requestTimeoutMs: 10000, runTimeoutMs: 10000 });
    n.options.modifyCompletion = (row) => {
      row.content.at(-1).state.content = [{ type: 'text', text: 'untransferred tool payload '.repeat(5000) }];
    };
    for (let i = 0; i < 10; i++)
      await driver.run(
        session,
        { privacy: 'public', text: `Public bounded turn ${i}`, turnId: `paged_${i}` },
        signal(),
      );
    assert.ok(
      Buffer.byteLength(JSON.stringify(n.sessions.get(session.sessionId)!.messages)) > 1024 * 1024,
    );
    const captured = await driver.capture(
      session,
      { privacy: 'public', afterCursor: null },
      signal(),
    );
    assert.equal(captured.complete, true);
    assert.equal(captured.totalEvents, 31);
    assert.doesNotMatch(JSON.stringify(captured), /untransferred tool payload/);
    assert.ok(n.requests.some((request) => request.path.includes('cursor=c_')));
    assert.equal(
      n.requests.filter(
        (request) =>
          request.method === 'POST' && request.path.endsWith('/prompt'),
      ).length,
      10,
    );
  } finally {
    await n.close();
  }
});

test('V2 seed PUT requires exact 204 acknowledgement and independent native readback; failures never fall back to prompt or retry', async () => {
  for (const seedStatus of [200, 202, 401, 413]) {
    const n = await native({ seedStatus });
    try {
      const driver = n.driver(), session = await driver.create(input(), signal());
      await assert.rejects(driver.seed(session, { privacy: 'public', text: SEED, hash: hash(SEED) }, signal()),
        safe(seedStatus < 300 ? 'invalid' : 'unavailable', true));
      const before = n.requests.length;
      await assert.rejects(driver.seed(session, { privacy: 'public', text: SEED, hash: hash(SEED) }, signal()), safe('unverified'));
      await assert.rejects(driver.ready(session, { seedHash: hash(SEED), model: MODEL, access: 'read' }, signal()), safe('unverified'));
      assert.equal(n.requests.length, before);
      assert.equal(n.requests.filter((req) => req.method === 'PUT').length, 1);
      assert.equal(n.requests.filter((req) => req.path.endsWith('/prompt') || req.path.endsWith('/synthetic')).length, 0);
      assert.equal(n.sessions.get(session.sessionId)!.messages.length, 0);
    } finally { await n.close(); }
  }
});

test('V2 acknowledgement cannot accept another instruction entry, parked inbox input, changed seed key or a busy root', async () => {
  for (const arm of ['extra-entry', 'inbox', 'key', 'busy'] as const) {
    const n = await native();
    try {
      const driver = n.driver(), session = await driver.create(input(), signal());
      await driver.seed(session, { privacy: 'public', text: SEED, hash: hash(SEED) }, signal());
      if (arm === 'extra-entry') n.options.extraEntries = [{ key: 'foreign', value: 'PRIVATE-FOREIGN-CONTEXT' }];
      if (arm === 'inbox') n.options.pendingInbox = [{ id: 'msg_foreign', sessionID: session.sessionId, type: 'user',
        payload: { text: 'PRIVATE-PARKED-INPUT' }, delivery: 'queue', time: { created: 100000 } }];
      if (arm === 'key') n.sessions.get(session.sessionId)!.entries[0].key = 'foreign';
      if (arm === 'busy') n.sessions.get(session.sessionId)!.busy = true;
      await assert.rejects(driver.ready(session, { seedHash: hash(SEED), model: MODEL, access: 'read' }, signal()), safe('unverified'));
      const count = n.requests.length;
      await assert.rejects(driver.run(session, { privacy: 'public', text: 'must stay held', turnId: 'held' }, signal()), safe('unverified'));
      assert.equal(n.requests.length, count);
      assert.equal(n.requests.filter((req) => req.path.endsWith('/prompt')).length, 0);
    } finally { await n.close(); }
  }
});

test('V2 instruction-entry seed identity participates in incremental evidence without inventing native user-message IDs', async () => {
  const n = await native();
  try {
    const { driver, session } = await boot(n);
    const captured = await driver.capture(session, { privacy: 'public', afterCursor: null }, signal());
    const key = n.sessions.get(session.sessionId)!.entries[0].key;
    assert.equal(captured.totalEvents, 1);
    assert.equal(captured.evidence[0].text, SEED);
    assert.equal(captured.references[0].messageId, 'api_' + key);
    assert.equal(captured.references[0].partId, 'value');
    assert.equal(n.sessions.get(session.sessionId)!.messages.length, 0);
    await driver.run(session, { privacy: 'public', text: 'Next public task', turnId: 'first' }, signal());
    const next = await driver.capture(session, { privacy: 'public', afterCursor: captured.completedEventCursor }, signal());
    assert.equal(next.totalEvents, 4);
    assert.equal(next.evidence.length, 3);
    assert.equal(next.evidence.some((e) => e.text === SEED), false);
    assert.ok(next.references.every((r) => !r.messageId.startsWith('api_')));
  } finally { await n.close(); }
});

test('V2 process replacement holds native controls before seeding, dispatch, capture or interruption', async () => {
  const n = await native();
  try {
    const { driver, session } = await boot(n);
    n.options.pid = 4243;
    const writes = n.requests.filter((r) => r.method !== 'GET').length;
    await assert.rejects(driver.run(session, { privacy: 'public', text: 'replaced process', turnId: 'held' }, signal()), safe('unverified'));
    await assert.rejects(driver.capture(session, { privacy: 'public', afterCursor: null }, signal()), safe('unverified'));
    assert.equal(n.requests.filter((r) => r.method !== 'GET').length, writes);
    assert.equal(n.requests.filter((r) => r.path.includes('/interrupt')).length, 0);
  } finally { await n.close(); }
  const m = await native();
  try {
    const driver = m.driver(), session = await driver.create(input(), signal()); m.options.pid = 4243;
    await assert.rejects(driver.seed(session, { privacy: 'public', text: SEED, hash: hash(SEED) }, signal()), safe('unverified'));
    assert.equal(m.requests.filter((r) => r.method === 'PUT').length, 0);
  } finally { await m.close(); }
});

test('V2 known prior context cannot change between prompt admission and completion without holding the new turn', async () => {
  const n = await native();
  try {
    const { driver, session } = await boot(n);
    await driver.run(session, { privacy: 'public', text: 'First stable turn', turnId: 'first' }, signal());
    n.options.modifyCompletion = () => { lastAssistant(n.sessions.get(session.sessionId)).content[0].text = 'PRIVATE-CHANGED-PRIOR-TURN'; };
    await assert.rejects(driver.run(session, { privacy: 'public', text: 'Second turn', turnId: 'second' }, signal()), safe('unverified', true));
    const count = n.requests.length;
    await assert.rejects(driver.run(session, { privacy: 'public', text: 'No replay', turnId: 'second' }, signal()), safe('unverified'));
    assert.equal(n.requests.length, count);
    assert.equal(n.requests.filter((r) => r.path.endsWith('/prompt')).length, 2);
    assert.equal(n.requests.filter((r) => r.path.includes('/interrupt')).length, 1);
  } finally { await n.close(); }
});
