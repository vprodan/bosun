import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SqliteDatabase, type SqliteStatement } from '../src/platform/sqlite.ts';
import { sandbox, fresh, gitRepo } from './helpers.ts';
import { runtimePaths } from '../src/platform/paths.ts';
import { parseRuntimeConfig } from '../src/platform/config.ts';
import { setupRuntime } from '../src/app/setup.ts';
import { startDaemon } from '../src/app/daemon.ts';
import { main } from '../src/app/cli.ts';
import { callLocalRpc } from '../src/adapters/transport/local-rpc.ts';
import { createOpenCodeRunner } from '../src/adapters/hosts/opencode/runner.ts';
import { nativeOpenCodeFixture } from './opencode-native-fixture.ts';
import { MANAGED_START_RUNNER, MANAGED_HANDOFF_RUNNER } from '../src/core/domain/managed.ts';
import type { RpcScope } from '../src/contracts/rpc.ts';
import type { HandoffFacts } from '../src/contracts/handoff.ts';
import type { ContextSample, ManagedSession, FreshReadiness } from '../src/core/domain/session.ts';
import type { GenRequest, ModelProvider } from '../src/core/ports/model.ts';
import type { ManagedFactories } from '../src/app/managed.ts';
import { gitEnvelope } from './git-fixture.ts';

const MODEL = 'openai/gpt-6.1-sol';
const SEED =
  'Only work on the accepted public task. Preserve the selected model and do not install anything.';
const SUMMARY_MODEL = 'summary:exact:tag';
type HandoffFixture = {
  qualified?: boolean;
  automatic?: boolean;
  output?: unknown;
  sample?: (session: ManagedSession, count: number) => Partial<ContextSample>;
  onGenerate?: (request: GenRequest) => void | Promise<void>;
  bootstrapTurn?: boolean;
  bootstrapQuota?: 'available' | 'blocked' | 'unknown';
  bootstrapReady?: boolean;
  onReady?: (
    ready: FreshReadiness,
    session: ManagedSession,
  ) => FreshReadiness | Promise<FreshReadiness>;
};
let serial = 0;
async function fixture(
  nativeOptions: Parameters<typeof nativeOpenCodeFixture>[0] = {},
  quota?: boolean,
  handoff: HandoffFixture = {},
) {
  const sb = sandbox();
  fresh(sb);
  const workspace = gitRepo(sb, 'managed-repo', 'git@example.com:team/managed.git');
  const native = await nativeOpenCodeFixture(nativeOptions);
  try {
    const env = sb.env({
      BOSUN_SOCKET: path.join(process.env.BOSUN_TEST_RUN_ROOT!, `mg${process.pid}_${++serial}`),
    });
    const paths = runtimePaths(env),
      config = parseRuntimeConfig(
        `[hosts]\nprimary="opencode"\n[hosts.opencode]\nurl=${JSON.stringify(native.url)}\n[handoff]\nenabled=${handoff.automatic === true}\n[providers.default]\nmodel=${JSON.stringify(SUMMARY_MODEL)}\n`,
      );
    await setupRuntime(paths, config);
    const generations: GenRequest[] = [];
    const bootstrapCalls: ManagedSession[] = [];
    let observations = 0;
    const provider: ModelProvider = {
      id: 'synthetic',
      caps: { structured: 'verified', local: 'verified', numCtx: 'verified', toolFree: 'verified' },
      health: async () => true,
      async generate(request) {
        generations.push(request);
        assert.equal(request.model, SUMMARY_MODEL);
        const payload = JSON.parse(request.messages[1].content);
        assert.deepEqual(Object.keys(payload).sort(), ['evidence', 'retained']);
        assert.doesNotMatch(JSON.stringify(payload), /SECRET-TOOL/);
        await handoff.onGenerate?.(request);
        const items = [...payload.retained, ...payload.evidence]
          .slice(-16)
          .map((row: { id: string; text: string }) => ({
            evidenceId: row.id,
            quote: row.text.slice(0, 200),
          }));
        return {
          model: SUMMARY_MODEL,
          text: JSON.stringify(handoff.output ?? { items }),
          tokensIn: 10,
          tokensOut: 5,
        };
      },
    };
    const options = {
      paths,
      config,
      environment: env,
      providers: { default: provider },
      ...(handoff.qualified
        ? {
            managedFactories: {
              opencode: (gates: Parameters<NonNullable<ManagedFactories['opencode']>>[0]) => {
                const control = native.driver({}, gates);
                return {
                  ...control,
                  caps: {
                    contextTelemetry: 'verified' as const,
                    promptAdmission: 'verified' as const,
                    toolQuiescence: 'verified' as const,
                    freshSession: 'verified' as const,
                    seedWithoutInference: handoff.bootstrapTurn ? 'unsupported' as const : 'verified' as const,
                    ...(handoff.bootstrapTurn ? { isolatedBootstrapTurn: 'verified' as const } : {}),
                    freshReadiness: 'verified' as const,
                  },
                  async observeContext(session: ManagedSession): Promise<ContextSample> {
                    observations++;
                    const turnId =
                      native.sessions
                        .get(session.sessionId)!
                         .messages.filter((row) => row.type === 'idle')
                         .at(-1)?.id ?? '';
                    return {
                      sessionId: session.sessionId,
                      generation: session.generation,
                      modelId: session.model,
                      turnId,
                      quality: 'observed',
                      scope: 'active-total',
                      usedTokens: 700,
                      windowTokens: 1000,
                      observedAt: Date.now(),
                      ...handoff.sample?.(session, observations),
                    };
                  },
                  async seed(session: ManagedSession, input: Parameters<typeof control.seed>[1], signal: AbortSignal) {
                    if (handoff.bootstrapTurn) bootstrapCalls.push(session);
                    await control.seed(session, input, signal);
                    return handoff.bootstrapTurn ? { t: 'usage' as const, tokensIn: 8, tokensOut: 2 } : undefined;
                  },
                  async ready(
                    session: ManagedSession,
                    expected: Parameters<typeof control.ready>[1],
                    signal: AbortSignal,
                  ) {
                    const ready = await control.ready(session, expected, signal);
                    if (session.generation === 0 && handoff.bootstrapReady === false)
                      return { ...ready, idle: false } as unknown as FreshReadiness;
                    return handoff.onReady && session.generation > 0
                      ? handoff.onReady(ready, session)
                      : ready;
                  },
                };
              },
            },
          }
        : {}),
      runners: {
        opencode: () =>
          createOpenCodeRunner({
            url: native.url,
            pollIntervalMs: 5,
            requestTimeoutMs: 1000,
            runTimeoutMs: 2000,
          }),
      },
      ...(handoff.bootstrapTurn ? { quotaSources: { opencode: {
        async read(selection: { model: string }) {
          assert.equal(selection.model, MODEL);
          if (handoff.bootstrapQuota === 'unknown') return null;
          const binding = { source: 'opencode' as const, unit: 'api' as const,
            accountId: 'fixture_account', bucketId: 'fixture_pool', model: selection.model, scope: 'pool' as const };
          const at = Date.now();
          return [{ binding, observation: { ...binding, observedAt: at, complete: true,
            ordinaryUsageAllowed: true, windows: [
              { id: 'short' as const, durationMinutes: 300, remainingPercent: 80, resetsAt: at + 300000 },
              { id: 'weekly' as const, durationMinutes: 10080,
                remainingPercent: handoff.bootstrapQuota === 'blocked' ? 0 : 80, resetsAt: at + 600000 },
            ] } }];
        },
      } } } : {}),
      ...(quota === undefined
        ? {}
        : {
            admit: async () =>
              quota
                ? { allowed: true as const }
                : { allowed: false as const, reason: 'quota' as const },
          }),
    };
    let runtime = await startDaemon(options);
    const scope: RpcScope = { workspace, sessionId: null, audience: 'owner' };
    async function rpc(method: string, params: Record<string, unknown>, caller: RpcScope = scope) {
      return callLocalRpc<any>({
        socket: paths.socket,
        request: { version: 1, id: `mg_${++serial}`, method, params, scope: caller },
        mutation: [
          'managed.start',
          'managed.turn',
          'managed.retire',
          'managed.authorize',
          'managed.handoff',
          'quota.refresh',
        ].includes(method),
      });
    }
    async function cli(args: string[], environment = env, cwd = workspace) {
      let out = '',
        err = '';
      const code = await main(args, {
        env: environment,
        cwd,
        stdout: (t) => {
          out += t;
        },
        stderr: (t) => {
          err += t;
        },
      });
      return { code, out, err };
    }
    async function wait(id: string, state: string) {
      const deadline = Date.now() + 5000;
      for (;;) {
        const value = await rpc('job.get', { id });
        if (value.state === state) return value;
        if (Date.now() > deadline) assert.fail(JSON.stringify(value));
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    async function start(requestId = 'start_public', extra: Record<string, unknown> = {}) {
      const result = await rpc('managed.start', {
        privacy: 'public',
        requestId,
        hostId: 'opencode',
        model: MODEL,
        effort: 'high',
        access: 'read',
        seed: SEED,
        ...extra,
      });
      await wait(result.job.id, 'succeeded');
      return { ...result, ...(await rpc('managed.get', { id: result.id })) };
    }
    return {
      sb,
      native,
      env,
      paths,
      config,
      generations,
      bootstrapCalls,
      get observations() {
        return observations;
      },
      handoff,
      options,
      workspace,
      scope,
      rpc,
      cli,
      wait,
      start,
      get runtime() {
        return runtime;
      },
      async restart() {
        await runtime.close();
        runtime = await startDaemon(options);
      },
      async close() {
        try {
          await runtime.close();
        } finally {
          await native.close();
          sb.cleanup();
        }
      },
    };
  } catch (error) {
    await native.close();
    sb.cleanup();
    throw error;
  }
}

async function authority(f: Awaited<ReturnType<typeof fixture>>, started: any) {
  const facts: HandoffFacts = {
    objective: 'Complete the accepted public fixture task.',
    latestSteering: ['OWNER-AUTHORITY-MARKER: preserve this owner instruction exactly.'],
    constraints: {
      permissions: ['Inspect the public repository.'],
      prohibitions: ['Do not install anything.'],
      pendingApprovals: ['Obtain owner approval before any deployment.'],
    },
    decisions: [{ fact: 'Keep the explicit native model.', source: 'Owner fixture instruction.' }],
    questions: ['Which accepted task should run next?'],
    progress: {
      completed: ['Initial public task inspection.'],
      remaining: ['Complete the next public inspection.'],
      nextAction: 'Inspect the remaining public task.',
    },
    source: {
      hostId: 'claude',
      sessionId: 'owner-placeholder',
      model: 'owner-placeholder',
      generation: 99,
      access: 'edit',
      completedEventCursor: 'owner-placeholder',
      uncertainEffects: [],
    },
    repository: {
      projectId: started.ownership.projectId,
      branch: 'owner-placeholder',
      commit: '0'.repeat(40),
      files: [],
    },
    verification: [
      {
        command: 'fixture verification',
        outcome: 'unverified',
        revision: '0'.repeat(40),
        detail: 'No live verification claimed.',
      },
    ],
    runningJobs: [],
    parentId: null,
  };
  const result = await f.rpc('managed.authorize', {
    privacy: 'public',
    requestId: 'owner_authority',
    id: started.id,
    expectedVersion: started.ownership.version,
    facts,
  });
  assert.equal(result.ownership.version, started.ownership.version + 1);
  return { ...result, facts };
}
async function turn(
  f: Awaited<ReturnType<typeof fixture>>,
  id: string,
  expectedVersion: number,
  requestId = 'inspection',
) {
  const result = await f.rpc('managed.turn', {
    privacy: 'public',
    requestId,
    id,
    expectedVersion,
    text: 'Inspect the accepted public task.',
  });
  await f.wait(result.job.id, 'succeeded');
  return result;
}
async function transfer(
  f: Awaited<ReturnType<typeof fixture>>,
  id: string,
  expectedVersion: number,
  extra: Record<string, unknown> = {},
) {
  return f.rpc('managed.handoff', {
    privacy: 'public',
    requestId: 'handoff_public',
    id,
    expectedVersion,
    automatic: false,
    ...extra,
  });
}

test('owner authority is immutable and normalized; unqualified production handoff is held before summary or native effects', async () => {
  const f = await fixture({}, true, { automatic: true });
  try {
    const started = await f.start();
    const bound = await authority(f, started);
    const manifest = (await f.rpc('handoff.get', { id: bound.artifact })).manifest;
    assert.equal(manifest.facts.source.model, MODEL);
    assert.equal(manifest.facts.source.hostId, 'opencode');
    assert.equal(manifest.facts.source.generation, 0);
    assert.equal(manifest.facts.source.access, 'read');
    assert.equal(manifest.facts.source.effort, 'high');
    const duplicate = await f.rpc('managed.authorize', {
      privacy: 'public',
      requestId: 'owner_authority',
      id: started.id,
      expectedVersion: 3,
      facts: bound.facts,
    });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.artifact, bound.artifact);
    await assert.rejects(
      f.rpc(
        'managed.authorize',
        {
          privacy: 'public',
          requestId: 'model_authority',
          id: started.id,
          expectedVersion: 4,
          facts: bound.facts,
        },
        { ...f.scope, audience: 'model' },
      ),
    );
    await turn(f, started.id, 4);
    const before = f.native.requests.filter((req) => req.method === 'POST').length;
    const queued = await transfer(f, started.id, 4);
    await f.wait(queued.job.id, 'held');
    assert.equal(f.generations.length, 0);
    assert.equal(f.observations, 0);
    assert.equal(f.native.requests.filter((req) => req.method === 'POST').length, before);
    assert.equal((await f.rpc('managed.get', { id: started.id })).ownership.phase, 'active');
    const jobs = (await f.rpc('job.list', {})).jobs;
    assert.equal(jobs.filter((j: any) => j.runnerId === MANAGED_HANDOFF_RUNNER).length, 1);
    await assert.rejects(
      f.rpc('job.submit', {
        privacy: 'public',
        requestId: 'reserved_handoff',
        taskId: 'reserved_handoff',
        runnerId: MANAGED_HANDOFF_RUNNER,
        model: SUMMARY_MODEL,
        access: 'read',
        prompt: 'must not execute',
      }),
    );
  } finally {
    await f.close();
  }
});

test('synthetic qualified handoff uses the existing executor and exact artifact, then transfers native ownership without dispatching seed text', async () => {
  const f = await fixture({}, true, { qualified: true });
  try {
    await gitEnvelope(f.sb, async () => {
      const started = await f.start();
      await turn(f, started.id, 3);
      const bound = await authority(f, started);
      let acknowledged = false;
      f.handoff.onReady = async (ready, destination) => {
        acknowledged = true;
        const during = (await f.rpc('managed.get', { id: started.id })).ownership;
        assert.equal(during.phase, 'staged');
        assert.equal(during.session.sessionId, started.ownership.session.sessionId);
        assert.equal(during.stage.destination.sessionId, destination.sessionId);
        await assert.rejects(turn(f, started.id, during.version, 'before_cas'));
        return ready;
      };
      const queued = await transfer(f, started.id, bound.ownership.version);
      assert.equal(queued.job.runnerId, MANAGED_HANDOFF_RUNNER);
      assert.equal(queued.job.ownerOnly, true);
      await f.wait(queued.job.id, 'succeeded');
      assert.equal(acknowledged, true);
      const receipt = JSON.parse((await f.rpc('job.result', { id: queued.job.id })).result);
      assert.equal(receipt.state, 'transferred');
      const current = (await f.rpc('managed.get', { id: started.id })).ownership;
      assert.equal(current.phase, 'active');
      assert.equal(current.version, 8);
      assert.equal(current.activationJobId, queued.job.id);
      assert.equal(current.session.generation, 1);
      assert.equal(current.session.model, MODEL);
      assert.equal(current.session.access, 'read');
      assert.deepEqual(current.retired, {
        sessionId: started.ownership.session.sessionId,
        generation: 0,
      });
      assert.equal(f.native.sessions.size, 2);
      assert.equal(f.native.sessions.get(current.retired.sessionId)!.messages.length, 3);
      const destination = f.native.sessions.get(current.session.sessionId)!;
       assert.equal(destination.messages.length, 0);
       const seed = destination.entries[0].value;
      assert.match(seed, /OWNER-AUTHORITY-MARKER/);
      assert.match(seed, /Obtain owner approval before any deployment/);
      assert.match(seed, /effort: high; access: read; generation: 0/);
      assert.match(seed, /Evidence projection sha256: [a-f0-9]{64}/);
      assert.match(seed, /Checkout revision sha256: [a-f0-9]{64}/);
      assert.doesNotMatch(seed, /SECRET-TOOL/);
      assert.equal(f.generations.length, 1);
      const published = (await f.rpc('handoff.list', {})).artifacts;
      assert.equal(published.length, 2);
      const bundle = await f.rpc('handoff.get', {
        id: published.find((p: any) => p.id !== bound.artifact).id,
      });
      assert.equal(bundle.markdown, seed);
      assert.equal(bundle.markdownHash, current.seedHash);
      assert.deepEqual(bundle.manifest.facts.constraints, bound.facts.constraints);
      assert.equal(bundle.manifest.summary.coverage.events, 4);
      assert.ok(
        f.native.requests
           .filter((req) => req.method === 'POST' && req.path === '/api/session')
           .every((req) => req.body.model.variant === 'high'),
      );
      assert.equal((await transfer(f, started.id, 3)).job.id, queued.job.id);
      await assert.rejects(turn(f, started.id, 4, 'old_generation'));
      await turn(f, started.id, 8, 'new_generation');
      assert.equal(destination.messages.length, 3);
      assert.ok(f.native.requests.every((req) => req.method !== 'DELETE'));
    });
  } finally {
    await f.close();
  }
});

for (const failure of [
  'invented-summary',
  'seed-acknowledgement',
  'source-drift',
  'checkout-drift',
] as const) {
  test(`synthetic managed handoff ${failure} remains held without dispatch or retry`, async () => {
    const f = await fixture({}, true, { qualified: true });
    try {
      await gitEnvelope(f.sb, async () => {
        const started = await f.start();
        await turn(f, started.id, 3);
        const bound = await authority(f, started);
        if (failure === 'invented-summary')
          f.handoff.output = { items: [{ evidenceId: 'invented', quote: 'Unverified claim.' }] };
        if (failure === 'seed-acknowledgement')
          f.handoff.onReady = (ready) => ({ ...ready, seedHash: 'a'.repeat(64) });
        if (failure === 'source-drift')
          f.handoff.onGenerate = () => {
            f.native.sessions
              .get(started.ownership.session.sessionId)!
               .messages.find((row) => row.type === 'assistant').content.find((p: any) => p.type === 'text').text =
              'Changed public history.';
          };
        if (failure === 'checkout-drift')
          f.handoff.onGenerate = () => {
            fs.writeFileSync(
              path.join(f.workspace, 'new-public-file.txt'),
              'Changed public checkout.',
            );
          };
        const queued = await transfer(f, started.id, bound.ownership.version);
        await f.wait(queued.job.id, 'unknown');
        const value = (await f.rpc('managed.get', { id: started.id })).ownership;
        assert.equal(value.phase, 'held');
        assert.equal(value.session.sessionId, started.ownership.session.sessionId);
        assert.equal(value.session.generation, 0);
        assert.equal(f.generations.length, 1);
        assert.equal(f.native.sessions.size, failure === 'seed-acknowledgement' ? 2 : 1);
        const posts = f.native.requests.filter((req) => req.method === 'POST').length;
        assert.equal((await transfer(f, started.id, 3)).job.id, queued.job.id);
        await assert.rejects(f.rpc('job.release', { id: queued.job.id }));
        await f.restart();
        assert.equal((await f.rpc('managed.get', { id: started.id })).ownership.phase, 'held');
        assert.equal(f.native.requests.filter((req) => req.method === 'POST').length, posts);
        assert.equal(f.generations.length, 1);
      });
    } finally {
      await f.close();
    }
  });
}

test('automatic watcher schedules one handoff per generation after a completed native turn and rechecks telemetry', async () => {
  const f = await fixture({}, true, { qualified: true, automatic: true });
  try {
    await gitEnvelope(f.sb, async () => {
      const started = await f.start();
      await authority(f, started);
      await turn(f, started.id, 4);
      const deadline = Date.now() + 5000;
      let queued: any;
      while (!queued) {
        queued = (await f.rpc('job.list', {})).jobs.find(
          (j: any) => j.runnerId === MANAGED_HANDOFF_RUNNER,
        );
        if (Date.now() > deadline) assert.fail('Automatic handoff was not scheduled');
        if (!queued) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await f.wait(queued.id, 'succeeded');
      assert.equal(f.observations, 2);
      assert.equal(f.generations.length, 1);
      assert.equal(
        (await f.rpc('managed.get', { id: started.id })).ownership.session.generation,
        1,
      );
      assert.equal(
        (await f.rpc('job.list', {})).jobs.filter((j: any) => j.runnerId === MANAGED_HANDOFF_RUNNER)
          .length,
        1,
      );
    });
  } finally {
    await f.close();
  }
});

test('multiple captured windows publish one incremental chain with full cursor coverage and exact owner constraints', async () => {
  const f = await fixture(
    {
      modifyCompletion: (row) => {
         const text = row.content.find((p: any) => p.type === 'text');
         row.content.push({
          ...text,
          text: 'Additional public completed evidence.',
        });
      },
    },
    true,
    { qualified: true },
  );
  try {
    await gitEnvelope(f.sb, async () => {
      const started = await f.start();
      for (let n = 0; n < 26; n++) await turn(f, started.id, 3, `window_turn_${n}`);
      const bound = await authority(f, started);
      const captured = await f.rpc('managed.capture', {
        privacy: 'public',
        id: started.id,
        afterCursor: null,
      });
      assert.equal(captured.evidence.length, 100);
      assert.equal(captured.totalEvents, 105);
      assert.equal(captured.complete, false);
      const queued = await transfer(f, started.id, bound.ownership.version);
      await f.wait(queued.job.id, 'succeeded');
      const artifacts = (await f.rpc('handoff.list', {})).artifacts;
      const bundles = await Promise.all(
        artifacts.map((p: any) => f.rpc('handoff.get', { id: p.id })),
      );
      const final = bundles.find(
        (b: any) => b.manifest.summary?.coverage.events === captured.totalEvents,
      );
      assert.ok(final);
      assert.ok(final.manifest.facts.parentId);
      const parent = bundles.find((b: any) => b.manifest.id === final.manifest.facts.parentId);
      assert.equal(parent.manifest.summary.coverage.events, 100);
      assert.notEqual(
        final.manifest.facts.source.completedEventCursor,
        parent.manifest.facts.source.completedEventCursor,
      );
      assert.equal(
        final.manifest.facts.source.evidenceHash,
        parent.manifest.facts.source.evidenceHash,
      );
      assert.deepEqual(final.manifest.facts.constraints, bound.facts.constraints);
      const current = (await f.rpc('managed.get', { id: started.id })).ownership;
      assert.equal(
         f.native.sessions.get(current.session.sessionId)!.entries[0].value,
        final.markdown,
      );
      assert.equal(f.native.sessions.size, 2);
      assert.ok(f.generations.length > 1);
      const usage = (await f.rpc('usage.list', {})).attempts.find(
        (a: any) => a.jobId === queued.job.id,
      );
      assert.equal(usage.tokensIn, f.generations.length * 10);
      assert.equal(usage.tokensOut, f.generations.length * 5);
    });
  } finally {
    await f.close();
  }
});

test('a second handoff preserves owner authority and permanent retirements while reusing the same pinned native model', async () => {
  const f = await fixture({}, true, { qualified: true });
  try {
    await gitEnvelope(f.sb, async () => {
      const started = await f.start();
      await turn(f, started.id, 3);
      const bound = await authority(f, started);
      const first = await transfer(f, started.id, 4);
      await f.wait(first.job.id, 'succeeded');
      await turn(f, started.id, 8, 'second_generation_turn');
      const second = await transfer(f, started.id, 8, { requestId: 'second_handoff' });
      await f.wait(second.job.id, 'succeeded');
      const current = (await f.rpc('managed.get', { id: started.id })).ownership;
      assert.equal(current.version, 12);
      assert.equal(current.session.generation, 2);
      assert.equal(current.session.model, MODEL);
      assert.equal(current.authorityArtifactId, bound.artifact);
      assert.equal(current.activationJobId, second.job.id);
      assert.equal(f.native.sessions.size, 3);
       const seed = f.native.sessions.get(current.session.sessionId)!.entries[0].value;
      assert.match(seed, /OWNER-AUTHORITY-MARKER/);
      assert.match(seed, /Obtain owner approval before any deployment/);
      const db = new SqliteDatabase(f.paths.state, { readOnly: true });
      try {
        assert.equal(db.prepare('SELECT count(*) n FROM managed_retirements').get()!.n, 2);
      } finally {
        db.close();
      }
      assert.equal(f.generations.length, 2);
    });
  } finally {
    await f.close();
  }
});

test('actual CLI authority and handoff use owner-only shared contracts and refuse private, secret and unsettled facts before publication', async () => {
  const f = await fixture({}, true, { qualified: true });
  try {
    await gitEnvelope(f.sb, async () => {
      const started = await f.start();
      await turn(f, started.id, 3);
      const bound = await authority(f, started);
      const file = path.join(f.sb.root, 'public-authority.json');
      fs.writeFileSync(file, JSON.stringify(bound.facts));
      const args = [
        'managed',
        'authorize',
        started.id,
        '--facts',
        file,
        '--version',
        '4',
        '--request-id',
        'cli_authority',
      ];
      assert.equal((await f.cli(args)).code, 1);
      assert.equal(
        (await f.cli([...args, '--public'], { ...f.env, BOSUN_CALLER: 'model' })).code,
        1,
      );
      const input = {
        privacy: 'public',
        requestId: 'denied_authority',
        id: started.id,
        expectedVersion: 4,
        facts: bound.facts,
      };
      for (const denied of [
        { ...input, privacy: 'private' },
        { ...input, facts: { ...bound.facts, objective: 'api_key=' + 'x'.repeat(40) } },
        {
          ...input,
          facts: {
            ...bound.facts,
            source: { ...bound.facts.source, uncertainEffects: ['Unsettled native write.'] },
          },
        },
        {
          ...input,
          facts: {
            ...bound.facts,
            runningJobs: [
              {
                id: 'running_native',
                state: 'unknown',
                reconcile: 'Inspect the original native receipt.',
              },
            ],
          },
        },
      ])
        await assert.rejects(f.rpc('managed.authorize', denied));
      assert.equal((await f.rpc('handoff.list', {})).artifacts.length, 1);
      assert.equal((await f.rpc('managed.get', { id: started.id })).ownership.version, 4);
      const authorized = await f.cli([...args, '--public']);
      assert.equal(authorized.code, 0, authorized.err);
      assert.equal(JSON.parse(authorized.out).ownership.version, 5);
      const queued = await f.cli([
        'managed',
        'handoff',
        started.id,
        '--version',
        '5',
        '--request-id',
        'cli_handoff',
      ]);
      assert.equal(queued.code, 0, queued.err);
      await f.wait(JSON.parse(queued.out).job.id, 'succeeded');
      assert.equal(
        (await f.rpc('managed.get', { id: started.id })).ownership.session.generation,
        1,
      );
      assert.equal(f.generations.length, 1);
    });
  } finally {
    await f.close();
  }
});

test('cancellation during inline generation holds the fenced source and never publishes or seeds late provider output', async () => {
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture({}, true, {
    qualified: true,
    onGenerate: async () => {
      entered();
      await pending;
    },
  });
  try {
    await gitEnvelope(f.sb, async () => {
      const started = await f.start();
      await turn(f, started.id, 3);
      await authority(f, started);
      const queued = await transfer(f, started.id, 4);
      await reached;
      await f.rpc('job.cancel', { id: queued.job.id });
      release();
      await f.wait(queued.job.id, 'unknown');
      assert.equal((await f.rpc('managed.get', { id: started.id })).ownership.phase, 'held');
      assert.equal((await f.rpc('handoff.list', {})).artifacts.length, 1);
      assert.equal(f.native.sessions.size, 1);
      assert.equal(f.generations.length, 1);
      assert.equal((await transfer(f, started.id, 4)).job.id, queued.job.id);
    });
  } finally {
    release();
    await f.close();
  }
});

for (const lost of ['transfer', 'terminal-job'] as const) {
  test(`actual managed ${lost} COMMIT followed by lost return preserves native history and holds without replay`, async () => {
    const f = await fixture({}, true, { qualified: true });
    const prepare = SqliteDatabase.prototype.prepare,
      exec = SqliteDatabase.prototype.exec;
    let matching = false,
      fired = false,
      jobId: string | undefined;
    try {
      await gitEnvelope(f.sb, async () => {
        const started = await f.start();
        await turn(f, started.id, 3);
        await authority(f, started);
        SqliteDatabase.prototype.prepare = function (this: SqliteDatabase, sql: string) {
          const statement = prepare.call(this, sql);
          if (
            sql.startsWith('UPDATE managed_ownership SET version') ||
            sql.startsWith('UPDATE jobs SET state')
          ) {
            const run = statement.run;
            statement.run = function (this: SqliteStatement, ...args: any[]) {
              if (
                !fired &&
                ((lost === 'transfer' &&
                  sql.startsWith('UPDATE managed_ownership') &&
                  JSON.parse(args[1]).phase === 'active' &&
                  JSON.parse(args[1]).session.generation === 1) ||
                  (lost === 'terminal-job' &&
                    sql.startsWith('UPDATE jobs') &&
                    args[0] === 'succeeded' &&
                    args[5] === jobId))
              )
                matching = true;
              return run.apply(this, args as any);
            };
          }
          return statement;
        } as typeof SqliteDatabase.prototype.prepare;
        SqliteDatabase.prototype.exec = function (this: SqliteDatabase, sql: string) {
          const result = exec.call(this, sql);
          if (sql === 'COMMIT' && matching && !fired) {
            fired = true;
            matching = false;
            throw Error('Lost actual managed handoff receipt');
          }
          return result;
        };
        const queued = await transfer(f, started.id, 4);
        jobId = queued.job.id;
        const deadline = Date.now() + 5000;
        while ((await f.rpc('daemon.status', {})).state !== 'held') {
          if (Date.now() > deadline) assert.fail('Writer did not hold');
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(fired, true);
        assert.equal(f.native.sessions.size, 2);
        assert.equal(f.generations.length, 1);
        const posts = f.native.requests.filter((req) => req.method === 'POST').length;
        SqliteDatabase.prototype.prepare = prepare;
        SqliteDatabase.prototype.exec = exec;
        await f.restart();
        const current = (await f.rpc('managed.get', { id: started.id })).ownership;
        assert.equal(current.phase, 'held');
        assert.equal(current.session.generation, 1);
        assert.equal(current.activationJobId, jobId);
        assert.equal(
          (await f.rpc('job.get', { id: jobId })).state,
          lost === 'transfer' ? 'unknown' : 'succeeded',
        );
        assert.equal((await transfer(f, started.id, 4)).job.id, jobId);
        await assert.rejects(turn(f, started.id, current.version, 'unknown_destination_turn'));
        assert.equal(f.native.requests.filter((req) => req.method === 'POST').length, posts);
        assert.equal(f.generations.length, 1);
      });
    } finally {
      SqliteDatabase.prototype.prepare = prepare;
      SqliteDatabase.prototype.exec = exec;
      await f.close();
    }
  });
}

test('below-threshold, stale, future, fractional, estimated and native-preempted samples do not enqueue automatic handoffs', async () => {
  const changes: Partial<ContextSample>[] = [
    { usedTokens: 699 },
    { observedAt: 1 },
    { observedAt: Number.MAX_SAFE_INTEGER },
    { usedTokens: 700.5 },
    { windowTokens: 0 },
    { usedTokens: 1001 },
    { quality: 'estimated' },
    { scope: 'body-only' },
    { nativeAutoLimit: 700 },
  ];
  for (const change of changes) {
    const f = await fixture({}, true, { qualified: true, automatic: true, sample: () => change });
    try {
      await gitEnvelope(f.sb, async () => {
        const started = await f.start();
        await authority(f, started);
        await turn(f, started.id, 4);
        await f.runtime.close(); // joins the watcher instead of relying on a sleep
        assert.equal(f.observations, 1);
        assert.equal(f.generations.length, 0);
        assert.equal(f.native.sessions.size, 1);
        const db = new SqliteDatabase(f.paths.state, { readOnly: true });
        try {
          assert.equal(
            db.prepare('SELECT count(*) n FROM jobs WHERE runner_id=?').get(MANAGED_HANDOFF_RUNNER)!
              .n,
            0,
          );
        } finally {
          db.close();
        }
      });
    } finally {
      await f.close();
    }
  }
});

test('changed telemetry between scheduling and execution fails before fencing and keeps the source active', async () => {
  const f = await fixture({}, true, {
    qualified: true,
    automatic: true,
    sample: (_session, count) => (count === 1 ? {} : { quality: 'estimated' }),
  });
  try {
    await gitEnvelope(f.sb, async () => {
      const started = await f.start();
      await authority(f, started);
      await turn(f, started.id, 4);
      let queued: any;
      const deadline = Date.now() + 5000;
      while (!queued) {
        queued = (await f.rpc('job.list', {})).jobs.find(
          (j: any) => j.runnerId === MANAGED_HANDOFF_RUNNER,
        );
        if (Date.now() > deadline) assert.fail('Automatic handoff was not scheduled');
        if (!queued) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await f.wait(queued.id, 'failed');
      assert.equal(f.observations, 2);
      assert.equal((await f.rpc('managed.get', { id: started.id })).ownership.phase, 'active');
      assert.equal(f.generations.length, 0);
      assert.equal(f.native.sessions.size, 1);
      await turn(f, started.id, 4, 'after_rejected_sample');
    });
  } finally {
    await f.close();
  }
});

test('actual managed bootstrap creates and seeds one owned idle root without inference, then pinned turns use the existing native runner and capture flow', async () => {
  const f = await fixture({}, true);
  try {
    const started = await f.start();
    assert.equal(started.ownership.phase, 'active');
    assert.equal(started.ownership.version, 3);
    assert.equal(started.bootstrapJob.state, 'succeeded');
    assert.equal(started.nativeQualification, 'unverified');
    const posts = f.native.requests.filter((req) => req.method === 'POST');
     assert.equal(posts.length, 1);
     assert.deepEqual(f.native.requests.find((req) => req.method === 'PUT')!.body, { value: SEED });
     assert.equal(f.native.sessions.get(started.ownership.session.sessionId)!.messages.length, 0);
    assert.equal(posts[0].body.model.id, 'gpt-6.1-sol');
    const turn = await f.rpc('managed.turn', {
      privacy: 'public',
      id: started.id,
      expectedVersion: 3,
      requestId: 'first_turn',
      text: 'Inspect the accepted public task.',
    });
    assert.equal(turn.job.runnerId, 'opencode');
    await f.wait(turn.job.id, 'succeeded');
    const result = await f.rpc('job.result', { id: turn.job.id });
    assert.equal(result.result, 'Synthetic fixture response only.');
    const window = await f.rpc('managed.capture', {
      privacy: 'public',
      id: started.id,
      afterCursor: null,
    });
    assert.equal(window.complete, true);
    assert.equal(window.totalEvents, 4);
    assert.equal(window.source.model, MODEL);
    assert.doesNotMatch(JSON.stringify(window), /SECRET-TOOL/);
    const duplicate = await f.rpc('managed.turn', {
      privacy: 'public',
      id: started.id,
      expectedVersion: 1,
      requestId: 'first_turn',
      text: 'different ignored public text',
    });
    assert.equal(duplicate.job.id, turn.job.id);
    assert.equal(duplicate.duplicate, true);
    assert.equal(
      f.native.requests.filter(
         (req) => req.method === 'POST' && req.path.endsWith('/prompt'),
      ).length,
      1,
    );
    const denied = await f.rpc('job.submit', {
      privacy: 'public',
      requestId: 'unbound',
      taskId: 'unbound',
      runnerId: 'opencode',
      prompt: 'Must not run beside the owned source',
      access: 'read',
      model: MODEL,
      allowUnknownQuota: true,
    });
    await f.wait(denied.job.id, 'held');
    assert.equal((await f.rpc('job.policy', { id: denied.job.id })).allowed, true);
    await f.rpc('job.cancel', { id: denied.job.id });
    const retired = await f.rpc('managed.retire', { id: started.id, expectedVersion: 3 });
    assert.equal(retired.ownership.phase, 'retired');
    assert.equal(f.native.sessions.size, 1);
    assert.ok(f.native.requests.every((req) => req.method !== 'DELETE'));
    const again = await f.rpc('managed.retire', { id: started.id, expectedVersion: 3 });
    assert.equal(again.duplicate, true);
    await f.restart();
    assert.equal((await f.rpc('managed.get', { id: started.id })).ownership.phase, 'retired');
  } finally {
    await f.close();
  }
});

test('bootstrap bypasses no model quota; later turns remain held on known quota and source policy before native prompts', async () => {
  const f = await fixture({}, false);
  try {
    const started = await f.start();
    const before = f.native.requests.filter((req) => req.method === 'POST').length;
    const queued = await f.rpc('managed.turn', {
      privacy: 'public',
      id: started.id,
      expectedVersion: 3,
      requestId: 'quota_held',
      text: 'Public quota held task',
      allowUnknownQuota: true,
    });
    const held = await f.wait(queued.job.id, 'held');
    assert.equal(held.reason, 'quota');
    await f.rpc('job.release', { id: queued.job.id });
    await f.wait(queued.job.id, 'held');
    assert.equal(f.native.requests.filter((req) => req.method === 'POST').length, before);
    await assert.rejects(f.rpc('managed.retire', { id: started.id, expectedVersion: 3 }));
    await f.rpc('job.cancel', { id: queued.job.id });
    const policy = await f.rpc('managed.turn', {
      privacy: 'public',
      id: started.id,
      expectedVersion: 3,
      requestId: 'policy_held',
      text: 'Inspect without delegation',
      policy: { operation: 'inspect', files: ['src/example.ts'], noDelegation: true },
    });
    assert.equal((await f.wait(policy.job.id, 'held')).reason, 'approval');
    assert.equal(f.native.requests.filter((req) => req.method === 'POST').length, before);
  } finally {
    await f.close();
  }
});

for (const fault of ['createFault', 'seedFault', 'turnFault'] as const) {
  test(`lost native ${fault} remains held across duplicate requests and daemon restart without replay`, async () => {
    const f = await fixture({}, true);
    try {
      let id: string, jobId: string;
      if (fault === 'turnFault') {
        const started = await f.start();
        id = started.id;
        f.native.options.turnFault = true;
        const value = await f.rpc('managed.turn', {
          privacy: 'public',
          id,
          expectedVersion: 3,
          requestId: 'lost_turn',
          text: 'One original public task',
        });
        jobId = value.job.id;
      } else {
        f.native.options[fault] = true;
        const value = await f.rpc('managed.start', {
          privacy: 'public',
          requestId: 'lost_start',
          hostId: 'opencode',
          model: MODEL,
          effort: 'high',
          access: 'read',
          seed: SEED,
        });
        id = value.id;
        jobId = value.job.id;
      }
      await f.wait(jobId, 'unknown');
      assert.equal((await f.rpc('managed.get', { id })).ownership.phase, 'held');
      const posts = f.native.requests.filter((req) => req.method === 'POST').length;
      await f.restart();
      assert.equal((await f.rpc('managed.get', { id })).ownership.phase, 'held');
      assert.equal(f.native.requests.filter((req) => req.method === 'POST').length, posts);
      if (fault !== 'turnFault') {
        const duplicate = await f.rpc('managed.start', {
          privacy: 'public',
          requestId: 'lost_start',
          hostId: 'opencode',
          model: 'different/ignored',
          access: 'read',
          seed: 'Different ignored public instructions',
        });
        assert.equal(duplicate.job.id, jobId);
        assert.equal(duplicate.duplicate, true);
      }
      assert.equal(f.native.requests.filter((req) => req.method === 'POST').length, posts);
    } finally {
      await f.close();
    }
  });
}

test('owner/model/private/credential/malformed requests and reserved bootstrap runners refuse before source effects', async () => {
  const f = await fixture({}, true);
  try {
    const input = {
      privacy: 'public',
      requestId: 'blocked',
      hostId: 'opencode',
      model: MODEL,
      access: 'read',
      seed: SEED,
    };
    await assert.rejects(f.rpc('managed.start', input, { ...f.scope, audience: 'model' }));
    await assert.rejects(f.rpc('managed.start', { ...input, privacy: 'private' }));
    await assert.rejects(f.rpc('managed.start', { ...input, seed: 'sk-proj-' + 'a'.repeat(64) }));
    await assert.rejects(f.rpc('managed.start', { ...input, hostId: 'codex' }));
    await assert.rejects(
      f.rpc('job.submit', {
        privacy: 'public',
        requestId: 'reserved',
        taskId: 'reserved',
        runnerId: MANAGED_START_RUNNER,
        prompt: 'malformed',
        model: MODEL,
        access: 'read',
      }),
    );
    const seedFile = path.join(f.workspace, 'seed.md');
    fs.writeFileSync(seedFile, SEED);
    assert.equal(
      (
        await f.cli([
          'managed',
          'start',
          '--seed-file',
          seedFile,
          '--model',
          MODEL,
          '--request-id',
          'missing-public',
        ])
      ).code,
      1,
    );
    assert.equal(f.native.requests.length, 0);
    const actual = await f.cli([
      'managed',
      'start',
      '--public',
      '--seed-file',
      seedFile,
      '--model',
      MODEL,
      '--effort',
      'high',
      '--request-id',
      'cli-start',
    ]);
    assert.equal(actual.code, 0, actual.err);
    const started = JSON.parse(actual.out);
    await f.wait(started.job.id, 'succeeded');
    const get = await f.cli(['managed', 'get', started.id]);
    assert.equal(JSON.parse(get.out).ownership.phase, 'active');
    const capture = await f.cli(['managed', 'capture', started.id]);
    assert.equal(JSON.parse(capture.out).evidence[0].text, SEED);
    const denied = await f.cli(['managed', 'get', started.id], { ...f.env, BOSUN_CALLER: 'model' });
    assert.equal(denied.code, 1);
  } finally {
    await f.close();
  }
});

test('same-origin foreign checkouts cannot read original source/job bindings, and native directory rebinding holds before effects', async () => {
  const f = await fixture({}, true);
  try {
    const started = await f.start();
    const other = gitRepo(f.sb, 'foreign', 'git@example.com:team/managed.git');
    const foreign = { ...f.scope, workspace: other };
    await assert.rejects(f.rpc('managed.get', { id: started.id }, foreign));
    await assert.rejects(
      f.rpc(
        'managed.start',
        {
          privacy: 'public',
          requestId: 'start_public',
          hostId: 'opencode',
          model: MODEL,
          effort: 'high',
          access: 'read',
          seed: SEED,
        },
        foreign,
      ),
    );
    const before = f.native.requests.length;
    const sub = path.join(f.workspace, 'nested');
    fs.mkdirSync(sub);
    const capture = await f.rpc(
      'managed.capture',
      { privacy: 'public', id: started.id, afterCursor: null },
      { ...f.scope, workspace: sub },
    );
    assert.equal(capture.source.sessionId, started.ownership.session.sessionId);
    assert.ok(f.native.requests.length > before);
    const old = path.join(f.sb.root, 'old-checkout');
    fs.renameSync(f.workspace, old);
    fs.mkdirSync(f.workspace);
    const count = f.native.requests.length;
    await assert.rejects(
      f.rpc('managed.capture', { privacy: 'public', id: started.id, afterCursor: null }),
    );
    assert.equal(f.native.requests.length, count);
  } finally {
    await f.close();
  }
});

test('restart preserves an idle live source as held, original requests remain linked after content retention, and no ordinary task can bypass it', async () => {
  const f = await fixture({}, true);
  try {
    const started = await f.start();
    const count = f.native.requests.length;
    await f.restart();
    const value = await f.rpc('managed.get', { id: started.id });
    assert.equal(value.ownership.phase, 'held');
    const dup = await f.rpc('managed.start', {
      privacy: 'public',
      requestId: 'start_public',
      hostId: 'opencode',
      model: MODEL,
      access: 'read',
      seed: SEED,
    });
    assert.equal(dup.job.id, started.job.id);
    const ordinary = await f.rpc('job.submit', {
      privacy: 'public',
      requestId: 'held-root',
      taskId: 'held-root',
      runnerId: 'opencode',
      model: MODEL,
      access: 'read',
      prompt: 'Do not bypass the prior source',
    });
    await f.wait(ordinary.job.id, 'held');
    assert.equal(f.native.requests.length, count);
    const db = new SqliteDatabase(f.paths.state, { readOnly: true });
    try {
      assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM managed_jobs').get()!.n), 1);
    } finally {
      db.close();
    }
  } finally {
    await f.close();
  }
});

test('permanent managed job bindings and original request receipts survive actual content retention', async () => {
  const f = await fixture({}, true);
  try {
    const started = await f.start();
    await f.rpc('managed.retire', { id: started.id, expectedVersion: 3 });
    const db = new SqliteDatabase(f.paths.state);
    try {
      const old = Date.now() - 31 * 86400000;
      db.prepare('UPDATE jobs SET created_at=?,updated_at=? WHERE id=?').run(
        old,
        old,
        started.job.id,
      );
      db.prepare('UPDATE job_usage SET started_at=?,finished_at=? WHERE job_id=?').run(
        old,
        old,
        started.job.id,
      );
    } finally {
      db.close();
    }
    await f.rpc('job.prune', { limit: 10 });
    const original = await f.rpc('job.get', { id: started.job.id });
    assert.equal(original.retained, 'receipt');
    const count = f.native.requests.length;
    const duplicate = await f.rpc('managed.start', {
      privacy: 'public',
      requestId: 'start_public',
      hostId: 'opencode',
      model: 'ignored/other',
      access: 'edit',
      seed: 'Ignored public duplicate',
    });
    assert.equal(duplicate.id, started.id);
    assert.equal(duplicate.job.id, started.job.id);
    assert.equal(duplicate.duplicate, true);
    assert.equal(f.native.requests.length, count);
  } finally {
    await f.close();
  }
});

for (const stage of ['starting', 'seeding', 'active'] as const) {
  test(`actual ${stage} ownership COMMIT followed by lost return keeps original source intent without native replay`, async () => {
    const f = await fixture({}, true);
    const prepare = SqliteDatabase.prototype.prepare,
      exec = SqliteDatabase.prototype.exec;
    let matching = false,
      fired = false;
    try {
      SqliteDatabase.prototype.prepare = function (this: SqliteDatabase, sql: string) {
        const statement = prepare.call(this, sql);
        if (
          sql.startsWith('INSERT INTO managed_ownership') ||
          sql.startsWith('UPDATE managed_ownership SET version')
        ) {
          const run = statement.run;
          statement.run = function (this: SqliteStatement, ...args: any[]) {
            const text = sql.startsWith('INSERT') ? args.at(-1) : args[1];
            if (typeof text === 'string' && JSON.parse(text).phase === stage && !fired)
              matching = true;
            return run.apply(this, args as any);
          };
        }
        return statement;
      } as typeof SqliteDatabase.prototype.prepare;
      SqliteDatabase.prototype.exec = function (this: SqliteDatabase, sql: string) {
        const result = exec.call(this, sql);
        if (sql === 'COMMIT' && matching && !fired) {
          fired = true;
          matching = false;
          throw Error('Lost actual managed ownership receipt');
        }
        return result;
      };
      const started = await f.rpc('managed.start', {
        privacy: 'public',
        requestId: 'commit_lost',
        hostId: 'opencode',
        model: MODEL,
        effort: 'high',
        access: 'read',
        seed: SEED,
      });
      const deadline = Date.now() + 5000;
      for (;;) {
        if ((await f.rpc('daemon.status', {})).state === 'held') break;
        if (Date.now() > deadline) assert.fail('Writer did not hold');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(fired, true);
      const posts = f.native.requests.filter((request) => request.method === 'POST').length;
      assert.equal(posts, stage === 'starting' ? 0 : 1);
      const seedWrites = f.native.requests.filter((request) => request.method === 'PUT').length;
      assert.equal(seedWrites, stage === 'active' ? 1 : 0);
      SqliteDatabase.prototype.prepare = prepare;
      SqliteDatabase.prototype.exec = exec;
      await f.restart();
      const source = await f.rpc('managed.get', { id: started.id });
      assert.equal(source.ownership.phase, 'held');
      assert.equal((await f.rpc('job.get', { id: started.job.id })).state, 'unknown');
      const duplicate = await f.rpc('managed.start', {
        privacy: 'public',
        requestId: 'commit_lost',
        hostId: 'opencode',
        model: MODEL,
        effort: 'high',
        access: 'read',
        seed: SEED,
      });
      assert.equal(duplicate.job.id, started.job.id);
      assert.equal(f.native.requests.filter((request) => request.method === 'POST').length, posts);
      assert.equal(f.native.requests.filter((request) => request.method === 'PUT').length, seedWrites);
    } finally {
      SqliteDatabase.prototype.prepare = prepare;
      SqliteDatabase.prototype.exec = exec;
      await f.close();
    }
  });
}

test('model bootstrap admission checks the selected native quota, preserves usage and never bypasses weekly exhaustion', async () => {
  for (const mode of ['available', 'unknown', 'owner-unknown', 'blocked', 'readiness'] as const) {
    const f = await fixture({}, true, { qualified: true, bootstrapTurn: true,
      bootstrapQuota: mode === 'unknown' || mode === 'owner-unknown' ? 'unknown' : mode === 'blocked' ? 'blocked' : 'available',
      bootstrapReady: mode !== 'readiness' });
    try {
      const optIn = mode === 'owner-unknown' || mode === 'blocked';
      const started = await f.rpc('managed.start', { privacy: 'public', requestId: 'isolated_start',
        hostId: 'opencode', model: MODEL, effort: 'high', access: 'read', seed: SEED,
        ...(optIn ? { allowUnknownQuota: true } : {}) });
      const admitted = mode === 'available' || mode === 'owner-unknown' || mode === 'readiness';
      await f.wait(started.job.id, admitted && mode !== 'readiness' ? 'succeeded' : 'unknown');
      assert.equal(f.bootstrapCalls.length, admitted ? 1 : 0);
      assert.equal(f.native.sessions.size, admitted ? 1 : 0);
      const current = (await f.rpc('managed.get', { id: started.id })).ownership;
      assert.equal(current.phase, admitted && mode !== 'readiness' ? 'active' : 'held');
      const rows = (await f.rpc('usage.list', {})).attempts;
      const row = rows.find((entry: any) => entry.jobId === started.job.id);
      assert.equal(row.model, MODEL);
      assert.equal(row.tokensIn, admitted ? 8 : null);
      assert.equal(row.tokensOut, admitted ? 2 : null);
      assert.equal(row.usageQualification, mode === 'readiness' ? 'partial' : admitted ? 'reported' : 'unavailable');
      const duplicate = await f.rpc('managed.start', { privacy: 'public', requestId: 'isolated_start',
        hostId: 'opencode', model: MODEL, effort: 'high', access: 'read', seed: SEED,
        ...(optIn ? { allowUnknownQuota: true } : {}) });
      assert.equal(duplicate.job.id, started.job.id);
      assert.equal(f.bootstrapCalls.length, admitted ? 1 : 0);
    } finally { await f.close(); }
  }
});

test('isolated handoff keeps summary and native bootstrap costs separate and retains usage after readiness loss', async () => {
  for (const loseReadiness of [false, true]) {
    const f = await fixture({}, true, { qualified: true, bootstrapTurn: true, bootstrapQuota: 'available' });
    try {
      await gitEnvelope(f.sb, async () => {
        const started = await f.start();
        await turn(f, started.id, 3);
        const bound = await authority(f, started);
        if (loseReadiness) f.handoff.onReady = async ready => ({ ...ready, idle: false }) as unknown as FreshReadiness;
        const queued = await transfer(f, started.id, bound.ownership.version);
        await f.wait(queued.job.id, loseReadiness ? 'unknown' : 'succeeded');
        assert.equal(f.bootstrapCalls.length, 2);
        const row = (await f.rpc('usage.list', {})).attempts.find((entry: any) => entry.jobId === queued.job.id);
        assert.equal(row.usageEvents, 2);
        assert.equal(row.tokensIn, null);
        assert.equal(row.tokensOut, null);
        assert.equal(row.usageQualification, 'ambiguous');
        if (!loseReadiness) {
          const receipt = JSON.parse((await f.rpc('job.result', { id: queued.job.id })).result);
          assert.equal(receipt.usage.summary.model, SUMMARY_MODEL);
          assert.equal(receipt.usage.summary.tokensIn, 10);
          assert.equal(receipt.usage.bootstrap.model, MODEL);
          assert.equal(receipt.usage.bootstrap.tokensIn, 8);
        }
      });
    } finally { await f.close(); }
  }
});

test('weekly exhaustion before isolated handoff prevents native bootstrap even with owner unknown-quota opt-in', async () => {
  const f = await fixture({}, true, { qualified: true, bootstrapTurn: true, bootstrapQuota: 'available' });
  try {
    await gitEnvelope(f.sb, async () => {
      const started = await f.start();
      await turn(f, started.id, 3);
      const bound = await authority(f, started);
      f.handoff.bootstrapQuota = 'blocked';
      await f.rpc('quota.refresh', { runnerId: 'opencode', model: MODEL });
      const queued = await transfer(f, started.id, bound.ownership.version, { allowUnknownQuota: true });
      await f.wait(queued.job.id, 'unknown');
      assert.equal(f.bootstrapCalls.length, 1);
      assert.equal((await f.rpc('managed.get', { id: started.id })).ownership.phase, 'held');
      assert.equal(f.native.sessions.size, 2);
      assert.deepEqual([...f.native.sessions.values()].map(session => session.messages.length).sort(), [0, 3]);
      const row = (await f.rpc('usage.list', {})).attempts.find((entry: any) => entry.jobId === queued.job.id);
      assert.equal(row.tokensIn, 10);
      assert.equal(row.usageQualification, 'partial');
      assert.equal(row.usageEvents, 1);
      const duplicate = await transfer(f, started.id, bound.ownership.version, { allowUnknownQuota: true });
      assert.equal(duplicate.job.id, queued.job.id);
      assert.equal(f.bootstrapCalls.length, 1);
    });
  } finally { await f.close(); }
});
