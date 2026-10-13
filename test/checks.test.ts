import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SqliteDatabase } from '../src/platform/sqlite.ts';
import { sandbox, fresh, gitRepo } from './helpers.ts';
import { gitEnvelope } from './git-fixture.ts';
import { runtimeFixture } from './runtime-fixture.ts';
import { project } from '../src/platform/project.ts';
import { openDaemonJobs } from '../src/app/jobs.ts';
import { createReviewService } from '../src/app/review.ts';
import { createCheckService } from '../src/app/checks.ts';
import type { CheckInput } from '../src/app/checks.ts';
import { CHECK_RUNNER } from '../src/core/domain/check.ts';
import { BosunError } from '../src/core/errors.ts';
import type { AgentRunner } from '../src/core/ports/runner.ts';
import type { AdmissionMetadata, JobSnapshot } from '../src/core/domain/job.ts';

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
function script(file: string, body: string) {
  fs.writeFileSync(file, `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
  return file;
}
function fixture(extra: Partial<Parameters<typeof openDaemonJobs>[0]> = {}) {
  const sb = sandbox();
  fresh(sb);
  const root = gitRepo(sb, 'project');
  fs.writeFileSync(path.join(root, 'change.ts'), 'export const value=true;');
  const home = path.join(sb.home, 'authority');
  fs.mkdirSync(home, { mode: 0o700 });
  let checks: ReturnType<typeof createCheckService>;
  let reviews: ReturnType<typeof createReviewService>;
  const settings = {
    stateFile: path.join(home, 'state.db'),
    ownerFile: path.join(home, 'owner.db'),
    internalRunnerIds: [CHECK_RUNNER],
    runners: {
      codex: () => ({
        id: 'codex',
        caps,
        detect: async () => ({ installed: true }),
        async *run() {
          yield { t: 'done' as const, code: 0, result: 'Owner finding proposal' };
        },
      }),
      [CHECK_RUNNER]: () => checks.runner(),
    },
    admit: async () => ({ allowed: true as const }),
    reviewAdmit: (job: Readonly<JobSnapshot>, signal: AbortSignal, metadata: AdmissionMetadata) =>
      reviews.admit(job, signal, metadata),
    checkAdmit: (job: Readonly<JobSnapshot>, signal: AbortSignal, metadata: AdmissionMetadata) =>
      checks.admit(job, signal, metadata),
    ...extra,
  };
  const jobs = openDaemonJobs(settings);
  jobs.recover();
  checks = createCheckService({ jobs, env: sb.env(), home, schedule() {} });
  reviews = createReviewService({ jobs, env: sb.env(), checks, schedule() {} });
  const scope = { projectId: project(root).id, audience: 'owner' as const };
  return {
    sb,
    root,
    home,
    settings,
    jobs,
    checks,
    reviews,
    scope,
    async review() {
      const result = await reviews.submit(
        { privacy: 'public', requestId: 'review', runnerId: 'codex', model: 'PINNED' },
        scope,
        root,
      );
      assert.ok(result.record && result.job);
      await jobs.runQueued();
      return result.record;
    },
    async close() {
      try {
        await checks.close();
        await reviews.close();
        await jobs.close();
      } finally {
        sb.cleanup();
      }
    },
  };
}
const input = (reviewId: string, command: string, requestId = 'check') => ({
  privacy: 'public' as const,
  reviewId,
  command,
  requestId,
  args: [],
});

test('native successful verification fingerprints executable/args/environment, stores only outcome/digest and contributes current recorded evidence', async () => {
  const f = fixture();
  try {
    await gitEnvelope(f.sb, async (calls) => {
      const marker = path.join(f.sb.root, 'executed');
      const command = script(
        path.join(f.sb.bin, 'bun'),
        `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(marker)},'ran');if(process.env.OPENAI_API_KEY)throw Error('auth');if(!process.env.HOME.includes('/checks/chk_'))throw Error('home');process.stdout.write('STDOUT_PRIVATE_CANARY');`,
      );
      const review = await f.review();
      const result = await f.checks.submit(input(review.id, command), f.scope, f.root);
      assert.equal(result.record.jobId, result.job.id);
      assert.equal(result.job.ownerOnly, true);
      await f.jobs.runQueued();
      const status = await f.checks.get(f.scope, f.root, result.record.id);
      assert.equal(status.job!.state, 'succeeded');
      assert.equal(status.usable, true);
      assert.equal(status.record.outcome!.phase, 'closed');
      assert.equal(fs.readFileSync(marker, 'utf8'), 'ran');
      assert.equal((await f.reviews.get(f.scope, f.root, review.id)).checks, 'passed');
      const duplicate = await f.checks.submit(
        {
          ...input(review.id, command),
          get command(): never {
            throw Error('NO_REPLAY_COMMAND');
          },
        },
        f.scope,
        f.root,
      );
      assert.equal(duplicate.duplicate, true);
      assert.equal(duplicate.job.id, result.job.id);
      assert.equal(fs.readFileSync(marker, 'utf8'), 'ran');
      const db = new SqliteDatabase(f.settings.stateFile, { readOnly: true });
      try {
        assert.doesNotMatch(
          JSON.stringify(db.prepare('SELECT payload FROM check_artifacts').all()),
          /STDOUT_PRIVATE_CANARY/,
        );
        assert.doesNotMatch(f.jobs.result(f.scope, result.job.id)!, /STDOUT_PRIVATE_CANARY/);
      } finally {
        db.close();
      }
      const invocation = calls.find(
        (call) => call.args.length === 0 && call.env.HOME?.includes('/checks/chk_'),
      );
      assert.ok(invocation);
      assert.equal(invocation.env.OPENAI_API_KEY, undefined);
      assert.equal(invocation.env.CODEX_HOME, undefined);
      assert.equal(invocation.env.NODE_OPTIONS, undefined);
      assert.equal(invocation.env.GIT_CONFIG_GLOBAL, '/dev/null');
      assert.throws(
        () => f.jobs.get({ ...f.scope, audience: 'model' }, result.job.id),
        code('not_found'),
      );
    });
  } finally {
    await f.close();
  }
});

test('nonzero native exits remain failed evidence while a positive command that changes checkout is never usable for the original revision', async () => {
  const f = fixture();
  try {
    await gitEnvelope(f.sb, async () => {
      const review = await f.review();
      const failure = script(path.join(f.sb.bin, 'fail'), 'process.exit(7);');
      const failed = await f.checks.submit(input(review.id, failure, 'failed'), f.scope, f.root);
      await f.jobs.runQueued();
      const status = await f.checks.get(f.scope, f.root, failed.record.id);
      assert.equal(status.job!.state, 'failed');
      assert.equal(status.record.outcome!.phase, 'closed');
      assert.equal(status.usable, false);
      assert.equal((await f.reviews.get(f.scope, f.root, review.id)).checks, 'failed');
      const file = path.join(f.root, 'change.ts');
      const mutate = script(
        path.join(f.sb.bin, 'mutate'),
        `require('node:fs').writeFileSync(${JSON.stringify(file)},'changed by check');`,
      );
      const changed = await f.checks.submit(input(review.id, mutate, 'mutated'), f.scope, f.root);
      await f.jobs.runQueued();
      const evidence = await f.checks.get(f.scope, f.root, changed.record.id);
      assert.equal(evidence.job!.state, 'succeeded');
      assert.equal(evidence.freshness, 'stale');
      assert.equal(evidence.usable, false);
      assert.equal(evidence.record.outcome!.phase, 'closed');
      if (evidence.record.outcome!.phase === 'closed')
        assert.equal(evidence.record.outcome!.checkout, 'stale');
    });
  } finally {
    await f.close();
  }
});

test('changed executable contents with restored mtime hold queued verification and invalidate previous command evidence without another process', async () => {
  const f = fixture();
  try {
    await gitEnvelope(f.sb, async () => {
      const marker = path.join(f.sb.root, 'ran');
      const command = script(
        path.join(f.sb.bin, 'verify'),
        `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran');`,
      );
      const review = await f.review();
      const result = await f.checks.submit(input(review.id, command), f.scope, f.root);
      const stat = fs.statSync(command);
      fs.appendFileSync(command, '// changed version\n');
      fs.utimesSync(command, stat.atime, stat.mtime);
      await f.jobs.runQueued();
      assert.equal(f.jobs.get(f.scope, result.job.id).state, 'held');
      assert.equal(fs.existsSync(marker), false);
      assert.equal((await f.jobs.release(f.scope, result.job.id)).state, 'held');
      const status = await f.checks.get(f.scope, f.root, result.record.id);
      assert.equal(status.command, 'changed');
      assert.equal(status.usable, false);
    });
  } finally {
    await f.close();
  }
});

test('explicit later checks of a changed executable keep prior receipts visible and count the latest version with exact literal arguments', async () => {
  const f = fixture();
  try {
    await gitEnvelope(f.sb, async () => {
      const command = script(
        path.join(f.sb.bin, 'args'),
        `require('node:assert/strict').deepEqual(process.argv.slice(2),['literal value','$(not-a-shell)']);process.exit(0);`,
      );
      const review = await f.review();
      const args = ['literal value', '$(not-a-shell)'];
      const first = await f.checks.submit(
        { ...input(review.id, command, 'first'), args },
        f.scope,
        f.root,
      );
      await f.jobs.runQueued();
      assert.equal((await f.checks.get(f.scope, f.root, first.record.id)).usable, true);
      fs.appendFileSync(command, '// new command version\n');
      assert.equal((await f.checks.get(f.scope, f.root, first.record.id)).usable, false);
      const second = await f.checks.submit(
        { ...input(review.id, command, 'second'), args },
        f.scope,
        f.root,
      );
      await f.jobs.runQueued();
      assert.notEqual(first.record.commandHash, second.record.commandHash);
      assert.equal((await f.checks.get(f.scope, f.root, second.record.id)).usable, true);
      const evidence = (await f.reviews.get(f.scope, f.root, review.id)).checkEvidence;
      assert.equal(evidence.state, 'passed');
      assert.equal(evidence.items.length, 2);
      assert.equal(evidence.items[0].current, false);
      assert.equal(evidence.items[0].state, 'stale');
      assert.equal(evidence.items[1].current, true);
      assert.equal(evidence.items[1].state, 'passed');
    });
  } finally {
    await f.close();
  }
});

test('private/model/credential inputs are refused before command getters or execution, and automatic package runners stay held', async () => {
  const f = fixture();
  try {
    await gitEnvelope(f.sb, async () => {
      const hidden = {
        ...input('rev_' + 'a'.repeat(32), 'ignored'),
        privacy: 'private',
        get command(): never {
          throw Error('PRIVATE_COMMAND');
        },
      };
      assert.throws(() => f.checks.submit(hidden as unknown as CheckInput, f.scope, f.root), code('private_input'));
      assert.throws(
        () => f.checks.submit(hidden as unknown as CheckInput, { ...f.scope, audience: 'model' }, f.root),
        code('unsupported'),
      );
      const review = await f.review();
      await assert.rejects(
        f.checks.submit({ ...input(review.id, 'sk-proj-' + 'x'.repeat(40)) }, f.scope, f.root),
        code('private_input'),
      );
      const bunx = script(path.join(f.sb.bin, 'bunx'), 'process.exit(0)');
      await assert.rejects(
        f.checks.submit(input(review.id, bunx, 'bunx'), f.scope, f.root),
        code('unsupported'),
      );
      assert.equal(f.jobs.checks.list(f.scope, review.id).length, 0);
    });
  } finally {
    await f.close();
  }
});

test('native timeout retains unknown receipts, block new requests for unsettled command effects and never replay on reopen', async () => {
  const f = fixture();
  let reopened: ReturnType<typeof openDaemonJobs> | undefined;
  let resumed: ReturnType<typeof createCheckService> | undefined;
  try {
    await gitEnvelope(f.sb, async () => {
      const marker = path.join(f.sb.root, 'ran');
      const command = script(
        path.join(f.sb.bin, 'slow'),
        `require('node:fs').appendFileSync(${JSON.stringify(marker)},'ran');process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`,
      );
      const review = await f.review();
      const result = await f.checks.submit(
        { ...input(review.id, command), timeoutMs: 1000 },
        f.scope,
        f.root,
      );
      await f.jobs.runQueued();
      assert.equal(f.jobs.get(f.scope, result.job.id).state, 'unknown');
      assert.equal(f.jobs.checks.get(f.scope, result.record.id).outcome!.phase, 'unknown');
      await assert.rejects(
        f.checks.submit(
          { ...input(review.id, command, 'different'), timeoutMs: 1000 },
          f.scope,
          f.root,
        ),
        code('conflict'),
      );
      const count = fs.readFileSync(marker, 'utf8');
      await f.checks.close();
      await f.reviews.close();
      await f.jobs.close();
      reopened = openDaemonJobs({
        ...f.settings,
        runners: {},
        checkAdmit: () => Promise.resolve(false),
      });
      reopened.recover();
      resumed = createCheckService({
        jobs: reopened,
        env: f.sb.env(),
        home: f.home,
        schedule() {},
      });
      const duplicate = await resumed.submit(
        {
          ...input(review.id, command),
          get command(): never {
            throw Error('NO_REPLAY');
          },
        },
        f.scope,
        f.root,
      );
      assert.equal(duplicate.duplicate, true);
      assert.equal(duplicate.job.state, 'unknown');
      assert.equal(fs.readFileSync(marker, 'utf8'), count);
    });
  } finally {
    await resumed?.close();
    await reopened?.close();
    await f.close();
  }
});

test('lost terminal outcome COMMIT preserves job and evidence atomically and cannot rerun the native command after reopening', async () => {
  const f = fixture();
  const original = SqliteDatabase.prototype.exec;
  let armed = false;
  let commits = 0;
  let reopened: ReturnType<typeof openDaemonJobs> | undefined;
  let resumed: ReturnType<typeof createCheckService> | undefined;
  try {
    await gitEnvelope(f.sb, async () => {
      const marker = path.join(f.sb.root, 'ran');
      const command = script(
        path.join(f.sb.bin, 'verify'),
        `require('node:fs').appendFileSync(${JSON.stringify(marker)},'ran');`,
      );
      const review = await f.review();
      const result = await f.checks.submit(input(review.id, command), f.scope, f.root);
      armed = true;
      SqliteDatabase.prototype.exec = function (sql) {
        const value = original.call(this, sql);
        if (armed && sql === 'COMMIT' && ++commits === 2) {
          armed = false;
          throw Error('lost terminal receipt');
        }
        return value;
      };
      await assert.rejects(
        f.jobs.runQueued(),
        (error: any) => error.details?.outcome === 'unknown',
      );
      SqliteDatabase.prototype.exec = original;
      assert.equal(fs.readFileSync(marker, 'utf8'), 'ran');
      await f.checks.close();
      await f.reviews.close();
      await f.jobs.close();
      reopened = openDaemonJobs({
        ...f.settings,
        runners: {},
        checkAdmit: () => Promise.resolve(false),
      });
      reopened.recover();
      resumed = createCheckService({
        jobs: reopened,
        env: f.sb.env(),
        home: f.home,
        schedule() {},
      });
      const duplicate = await resumed.submit(input(review.id, command), f.scope, f.root);
      assert.equal(duplicate.job.id, result.job.id);
      assert.equal(duplicate.job.state, 'succeeded');
      assert.equal(duplicate.record.outcome!.phase, 'closed');
      assert.equal(fs.readFileSync(marker, 'utf8'), 'ran');
    });
  } finally {
    SqliteDatabase.prototype.exec = original;
    await resumed?.close();
    await reopened?.close();
    await f.close();
  }
});

test('explicit running cancellation waits native closure, preserves unknown effects and keeps the owner until settlement', async () => {
  const f = fixture();
  try {
    await gitEnvelope(f.sb, async () => {
      const marker = path.join(f.sb.root, 'started');
      const command = script(
        path.join(f.sb.bin, 'cancel'),
        `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started');process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`,
      );
      const review = await f.review();
      const result = await f.checks.submit(input(review.id, command), f.scope, f.root);
      const running = f.jobs.runQueued();
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(marker)) {
        if (Date.now() > deadline) throw Error('native fixture did not start');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(f.jobs.get(f.scope, result.job.id).state, 'running');
      f.jobs.cancel(f.scope, result.job.id);
      f.jobs.assertOwner();
      await running;
      assert.equal(f.jobs.get(f.scope, result.job.id).state, 'unknown');
      assert.equal(f.jobs.checks.get(f.scope, result.record.id).outcome!.phase, 'unknown');
      assert.equal((await f.checks.get(f.scope, f.root, result.record.id)).usable, false);
    });
  } finally {
    await f.close();
  }
});

test('archived job telemetry preserves permanent verification outcome, original request/link and usable current evidence', async () => {
  let now = 1000;
  const f = fixture({ now: () => now, retentionDays: 1 });
  try {
    await gitEnvelope(f.sb, async () => {
      const review = await f.review();
      const command = script(path.join(f.sb.bin, 'verify'), 'process.exit(0);');
      const result = await f.checks.submit(input(review.id, command), f.scope, f.root);
      await f.jobs.runQueued();
      now += 86400001;
      f.jobs.prune(f.scope);
      const status = await f.checks.get(f.scope, f.root, result.record.id);
      assert.equal(status.job!.retained, 'receipt');
      assert.equal(status.usable, true);
      assert.equal(status.record.outcome!.phase, 'closed');
      assert.equal(f.jobs.result(f.scope, result.job.id), null);
    });
  } finally {
    await f.close();
  }
});

test('actual CLI verification uses the same owner authority, reports recorded-command evidence and protects the reserved runner/model tools', async () => {
  const f = await runtimeFixture('', {
    runner: {
      id: 'codex',
      caps,
      detect: async () => ({ installed: true }),
      async *run() {
        yield { t: 'done', code: 0, result: 'Owner proposal' };
      },
    },
  });
  try {
    await gitEnvelope(f.sb, async () => {
      fs.writeFileSync(path.join(f.workspace, 'change.ts'), 'public');
      const review = await f.cli([
        'review',
        '--public',
        '--host',
        'codex',
        '--model',
        'PINNED',
        '--request-id',
        'review',
      ]);
      assert.equal(review.code, 0, review.err);
      const parsed = JSON.parse(review.out);
      await f.cli(['job', 'wait', parsed.job.id]);
      const command = script(path.join(f.sb.bin, 'verify'), 'process.stdout.write("passed");');
      const created = await f.cli([
        'check',
        'run',
        parsed.record.id,
        '--command',
        command,
        '--args',
        '[]',
        '--request-id',
        'check',
      ]);
      assert.equal(created.code, 0, created.err);
      const saved = JSON.parse(created.out);
      assert.equal((await f.cli(['job', 'wait', saved.job.id])).code, 0);
      const inspected = await f.cli(['check', 'get', saved.record.id]);
      assert.equal(inspected.code, 0, inspected.err);
      assert.equal(JSON.parse(inspected.out).usable, true);
      const status = await f.cli(['review', 'get', parsed.record.id]);
      assert.equal(JSON.parse(status.out).checks, 'passed');
      assert.equal(JSON.parse(status.out).checkEvidence.coverage, 'recorded-commands');
      assert.equal(JSON.parse(status.out).decision, 'owner-review-required');
      await assert.rejects(
        f.rpc('check.get', { id: saved.record.id }, { ...f.scope, audience: 'model' }),
        code('unsupported'),
      );
      await assert.rejects(
        f.rpc('job.submit', {
          privacy: 'public',
          requestId: 'forbidden',
          taskId: 'task',
          runnerId: CHECK_RUNNER,
          prompt: '{}',
          access: 'edit',
          model: 'verification',
        }),
        code('unsupported'),
      );
    });
  } finally {
    await f.close();
  }
});
