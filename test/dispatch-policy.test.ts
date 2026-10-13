import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, fresh, gitRepo } from './helpers.ts';
import { runtimeFixture } from './runtime-fixture.ts';
import { openDaemonJobs } from '../src/app/jobs.ts';
import { project } from '../src/platform/project.ts';
import { assessDispatch, dispatchPolicy } from '../src/core/dispatch-policy.ts';
import { BosunError } from '../src/core/errors.ts';
import type { AgentRunner } from '../src/core/ports/runner.ts';

const code = (value: string) => (error: unknown) =>
  error instanceof BosunError && error.code === value;
const caps: AgentRunner['caps'] = {
  vendor: 'fixture',
  readOnly: 'verified',
  sandbox: 'tool-allowlist',
  mcpInject: 'unsupported',
  effort: 'verified',
  localBackend: 'unsupported',
  billing: 'unknown',
};
function fixture() {
  const sb = sandbox();
  fresh(sb);
  const root = gitRepo(sb, 'project');
  const home = path.join(sb.home, 'authority');
  fs.mkdirSync(home, { mode: 0o700 });
  let admitted = 0,
    ran = 0;
  const settings = {
    stateFile: path.join(home, 'state.db'),
    ownerFile: path.join(home, 'owner.db'),
    runners: {
      selected: () => ({
        id: 'selected',
        caps,
        detect: async () => ({ installed: true }),
        async *run() {
          ran++;
          yield { t: 'done' as const, code: 0, result: 'Completed public task' };
        },
      }),
    },
    admit: async () => {
      admitted++;
      return { allowed: true as const };
    },
  };
  const jobs = openDaemonJobs(settings);
  jobs.recover();
  const owner = { projectId: project(root).id, audience: 'owner' as const };
  return {
    sb,
    root,
    jobs,
    settings,
    owner,
    counts: () => ({ admitted, ran }),
    async close() {
      try {
        await jobs.close();
      } finally {
        sb.cleanup();
      }
    },
  };
}
const input = (cwd: string, requestId = 'task') => ({
  privacy: 'public' as const,
  requestId,
  taskId: 'task',
  runnerId: 'selected',
  prompt: 'Public bounded task',
  cwd,
  access: 'edit' as const,
  model: 'PINNED',
});

test('deterministic policy uses operations and narrow paths; no delegation and exact model restrictions precede risk or read-only allowance', () => {
  for (const file of [
    'src/auth/login.ts',
    'billing/invoice.ts',
    'migrations/001.sql',
    'infra/main.tf',
    'production/config.yml',
  ]) {
    const result = assessDispatch({
      access: 'edit',
      model: 'PINNED',
      submittedBy: 'owner',
      policy: { operation: 'mechanical', files: [file] },
    });
    assert.equal(result.allowed, false, file);
    assert.equal(result.risk, 'high');
    assert.equal(result.reason, 'main_planning_required');
  }
  assert.equal(
    assessDispatch({
      access: 'read',
      model: 'PINNED',
      submittedBy: 'model',
      policy: { operation: 'migration', files: ['migrations/001.sql'] },
    }).allowed,
    true,
  );
  assert.equal(
    assessDispatch({
      access: 'read',
      model: 'PINNED',
      submittedBy: 'owner',
      policy: { operation: 'inspect', files: [], noDelegation: true },
    }).reason,
    'no_delegation',
  );
  assert.equal(
    assessDispatch({
      access: 'read',
      model: 'PINNED',
      submittedBy: 'owner',
      policy: { operation: 'inspect', files: [], exactModel: 'OTHER' },
    }).reason,
    'exact_model',
  );
  assert.equal(
    assessDispatch({ access: 'edit', model: 'PINNED', submittedBy: 'model' }).allowed,
    false,
  );
  assert.equal(
    assessDispatch({ access: 'edit', model: 'PINNED', submittedBy: 'owner' }).allowed,
    true,
  );
  assert.equal(
    assessDispatch({
      access: 'edit',
      model: 'PINNED',
      submittedBy: 'model',
      policy: { operation: 'implementation', files: ['src/button.ts'] },
    }).risk,
    'low',
  );
});

test('policy validation denies accessors and credential-shaped scope without getter effects', () => {
  let read = 0;
  assert.throws(
    () =>
      dispatchPolicy({
        operation: 'inspect',
        get files() {
          read++;
          throw Error('getter');
        },
      }),
    code('invalid'),
  );
  assert.equal(read, 0);
  assert.throws(
    () => dispatchPolicy({ operation: 'implementation', files: ['src/sk-proj-' + 'x'.repeat(40)] }),
    code('private_input'),
  );
  assert.throws(
    () => dispatchPolicy({ operation: 'implementation', files: ['../outside'] }),
    code('invalid'),
  );
});

test('high-risk, no-delegation and exact-model rules hold before quota/runner callbacks and remain held through explicit release', async () => {
  const f = fixture();
  try {
    const policies = [
      { operation: 'migration' as const, files: ['db/change.sql'] },
      { operation: 'implementation' as const, files: ['src/auth.ts'] },
      { operation: 'implementation' as const, files: ['src/ok.ts'], noDelegation: true },
      { operation: 'implementation' as const, files: ['src/ok.ts'], exactModel: 'OTHER' },
    ];
    for (let i = 0; i < policies.length; i++) {
      const job = f.jobs.submit(
        { ...input(f.root, `blocked_${i}`), policy: policies[i], allowUnknownQuota: true },
        f.owner,
      ).job;
      await f.jobs.runQueued();
      assert.equal(f.jobs.get(f.owner, job.id).state, 'held');
      assert.equal(f.jobs.get(f.owner, job.id).reason, 'approval');
      assert.equal((await f.jobs.release(f.owner, job.id)).state, 'held');
      assert.equal(f.jobs.policy(f.owner, job.id).allowed, false);
    }
    assert.deepEqual(f.counts(), { admitted: 0, ran: 0 });
    const ownerOnly = f.jobs.submit(
      {
        ...input(f.root, 'owner_only_native'),
        ownerOnly: true,
        policy: { operation: 'auth', files: ['src/auth.ts'] },
      },
      f.owner,
    ).job;
    await f.jobs.runQueued();
    assert.equal(f.jobs.get(f.owner, ownerOnly.id).state, 'held');
    assert.deepEqual(f.counts(), { admitted: 0, ran: 0 });
  } finally {
    await f.close();
  }
});

test('model editing needs declared scope and cannot spoof owner origin; explicit owner task and scoped low-risk model task preserve chosen model', async () => {
  const f = fixture();
  try {
    const model = { ...f.owner, audience: 'model' as const };
    const held = f.jobs.submit(input(f.root, 'model_unknown'), model).job;
    await f.jobs.runQueued();
    assert.equal(f.jobs.get(model, held.id).state, 'held');
    assert.equal(f.jobs.policy(f.owner, held.id).reason, 'scope_unknown');
    assert.deepEqual(f.counts(), { admitted: 0, ran: 0 });
    assert.throws(
      () =>
        f.jobs.submit(
          {
            ...input(f.root, 'spoof'),
            submittedBy: 'owner',
            get prompt(): never {
              throw Error('ORIGIN_PROMPT');
            },
          },
          model,
        ),
      code('unsupported'),
    );
    const declared = f.jobs.submit(
      {
        ...input(f.root, 'model_scoped'),
        policy: { operation: 'implementation', files: ['src/button.ts'] },
      },
      model,
    ).job;
    const explicit = f.jobs.submit(input(f.root, 'owner_explicit'), f.owner).job;
    await f.jobs.runQueued();
    assert.equal(f.jobs.get(model, declared.id).state, 'succeeded');
    assert.equal(f.jobs.get(f.owner, explicit.id).state, 'succeeded');
    assert.deepEqual(f.counts(), { admitted: 2, ran: 2 });
    assert.throws(() => f.jobs.policy(model, declared.id), code('unsupported'));
  } finally {
    await f.close();
  }
});

test('actual CLI run policy controls are enforced in the same durable executor, independent of quota opt-in or model selection', async () => {
  let ran = 0;
  const f = await runtimeFixture('', {
    runner: {
      id: 'codex',
      caps,
      detect: async () => ({ installed: true }),
      async *run(spec) {
        ran++;
        assert.equal(spec.model, 'PINNED');
        yield { t: 'done', code: 0, result: 'Completed' };
      },
    },
  });
  try {
    const blocked = await f.cli([
      'run',
      'public task',
      '--host',
      'codex',
      '--model',
      'PINNED',
      '--operation',
      'mechanical',
      '--files',
      'src/auth.ts',
      '--request-id',
      'blocked',
      '--allow-unknown-quota',
    ]);
    assert.equal(blocked.code, 0, blocked.err);
    const job = JSON.parse(blocked.out).job;
    const waited = await f.cli(['job', 'wait', job.id]);
    assert.equal(waited.code, 0, waited.err);
    assert.equal(JSON.parse(waited.out).state, 'held');
    const policy = await f.cli(['job', 'policy', job.id]);
    assert.equal(policy.code, 0, policy.err);
    assert.equal(JSON.parse(policy.out).reason, 'main_planning_required');
    assert.equal(ran, 0);
    const allowed = await f.cli([
      'run',
      'public task',
      '--host',
      'codex',
      '--model',
      'PINNED',
      '--operation',
      'implementation',
      '--files',
      'src/button.ts',
      '--request-id',
      'allowed',
    ]);
    assert.equal(allowed.code, 0, allowed.err);
    assert.equal((await f.cli(['job', 'wait', JSON.parse(allowed.out).job.id])).code, 0);
    assert.equal(ran, 1);
  } finally {
    await f.close();
  }
});
