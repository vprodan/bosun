import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { sandbox, bosun } from './helpers.ts';
import { parseRuntimeConfig } from '../src/platform/config.ts';
import { runtimeFixture } from './runtime-fixture.ts';

const NAMES = ['architect', 'debugger', 'reviewer', 'scout', 'tester', 'worker'];

test('final configuration preserves explicit role/operator aliases, prefers canonical fields and never reads unrelated authentication', () => {
  let touched = 0;
  const env = {
    ROLE_SCOUT_CLAUDE: 'sonnet:low',
    ROLE_WORKER_CODEX: 'old-worker',
    WORKER_BY_CODEX: 'old-executor:high',
    REVIEW_BY_CLAUDE: 'opus:high',
    BOSUN_ROLE_EXECUTOR_CODEX_MODEL: 'PINNED',
    BOSUN_ROLE_EXECUTOR_CODEX_EFFORT: 'medium',
    get OPENAI_API_KEY(): string {
      touched++;
      throw Error('AUTH CANARY');
    },
    get ROLE_UNKNOWN_AUTH_CLAUDE(): string {
      touched++;
      throw Error('AUTH CANARY');
    },
  };
  const cfg = parseRuntimeConfig('[roles.scout.claude]\nmodel="haiku"\neffort="high"\n', env);
  assert.deepEqual(cfg.roles.scout.claude, { model: 'sonnet', effort: 'low' });
  assert.equal(cfg.roles.worker.codex?.model, 'old-worker');
  assert.equal(
    cfg.roles.worker.codex?.effort,
    undefined,
    'an omitted legacy effort is not silently substituted',
  );
  assert.deepEqual(cfg.roles.executor.codex, { model: 'PINNED', effort: 'medium' });
  assert.deepEqual(cfg.roles['cross-reviewer'].claude, { model: 'opus', effort: 'high' });
  assert.equal(touched, 0);
  const before = Object.getOwnPropertyDescriptor(Object, 'claude');
  assert.throws(
    () =>
      parseRuntimeConfig('', {
        get BOSUN_ROLE_CONSTRUCTOR_CLAUDE_MODEL(): string {
          touched++;
          throw Error('AUTH CANARY');
        },
      }),
    (error: unknown) => (error as { code?: string }).code === 'invalid',
  );
  assert.equal(touched, 0, 'invalid configuration paths are rejected before reading their value');
  assert.deepEqual(
    Object.getOwnPropertyDescriptor(Object, 'claude'),
    before,
    'metadata reads cannot mutate a constructor through an inherited path',
  );
  for (const value of ['private secret value', 'model:effort:CANARY', ':CANARY', 'model\nCANARY'])
    assert.throws(
      () => parseRuntimeConfig('', { ROLE_WORKER_CODEX: value }),
      (error: unknown) =>
        (error as { code?: string }).code === 'invalid' &&
        !(error as Error).message.includes('CANARY'),
    );
});

test('final run dispatches the explicitly selected executor model through its owner job without changing role configuration', async () => {
  const f = await runtimeFixture('', {
    env: { ROLE_WORKER_CODEX: 'other-worker:low', WORKER_BY_CODEX: 'PINNED:high' },
  });
  try {
    const result = await f.cli([
      'run',
      'Public bounded native task',
      '--host',
      'codex',
      '--read-only',
      '--request-id',
      'legacy-model-binding',
    ]);
    assert.equal(result.code, 0, result.err);
    const queued = JSON.parse(result.out);
    let job = await f.rpc('job.get', { id: queued.job.id });
    for (let n = 0; n < 200 && ['queued', 'running'].includes(job.state); n++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      job = await f.rpc('job.get', { id: job.id });
    }
    assert.equal(job.state, 'succeeded');
    assert.equal(
      f.calls(),
      1,
      'the existing fixture runner asserts PINNED, not the default worker model',
    );
    const repeated = await f.cli([
      'run',
      'Public bounded native task',
      '--host',
      'codex',
      '--read-only',
      '--request-id',
      'legacy-model-binding',
    ]);
    assert.equal(repeated.code, 0, repeated.err);
    assert.equal(JSON.parse(repeated.out).job.id, job.id);
    assert.equal(f.calls(), 1);
  } finally {
    await f.close();
  }
});

test('roles: bosun roles --json prints the resolved table', async () => {
  const sb = sandbox();
  try {
    const r = await bosun(['roles', '--json'], {
      env: sb.env({ ROLE_SCOUT_CLAUDE: 'sonnet:low' }),
    });
    assert.equal(r.code, 0, r.err);
    const rows = JSON.parse(r.out);
    assert.deepEqual(
      rows.map((x: any) => x.id),
      NAMES,
    );
    assert.deepEqual(rows.find((x: any) => x.id === 'architect').bindings.codex, {
      model: 'gpt-6-astra',
      effort: 'high',
    });
    assert.deepEqual(
      rows.find((x: any) => x.id === 'scout').bindings.claude,
      { model: 'sonnet', effort: 'low' },
      'explicit legacy env overrides config',
    );
    assert.deepEqual(sb.calls(), [], 'listing configured bindings starts no native host');
  } finally {
    sb.cleanup();
  }
});
