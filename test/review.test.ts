import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sandbox, fresh, gitRepo } from './helpers.ts';
import { gitEnvelope } from './git-fixture.ts';
import { createGitReviewSource } from '../src/adapters/review/git.ts';
import { BosunError } from '../src/core/errors.ts';
import { openDaemonJobs } from '../src/app/jobs.ts';
import { createReviewService } from '../src/app/review.ts';
import { project } from '../src/platform/project.ts';
import { runtimeFixture } from './runtime-fixture.ts';
import { SqliteDatabase } from '../src/platform/sqlite.ts';
import type { AgentRunner } from '../src/core/ports/runner.ts';

const code = (value: string) => (error: unknown) =>
  error instanceof BosunError && error.code === value;
function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
function fixture() {
  const sb = sandbox();
  fresh(sb);
  const root = gitRepo(sb, 'review');
  const source = createGitReviewSource({ env: sb.env() });
  return {
    sb,
    root,
    source,
    capture: (includeDiff = true) =>
      source.capture({ privacy: 'public' }, root, AbortSignal.timeout(10000), includeDiff),
  };
}
const caps: AgentRunner['caps'] = {
  vendor: 'fixture',
  readOnly: 'verified',
  sandbox: 'tool-allowlist',
  mcpInject: 'unsupported',
  effort: 'verified',
  localBackend: 'unsupported',
  billing: 'unknown',
};
function authority(extra: Partial<Parameters<typeof openDaemonJobs>[0]> = {}) {
  const f = fixture();
  const home = path.join(f.sb.home, 'authority');
  fs.mkdirSync(home, { mode: 0o700 });
  let reviews: ReturnType<typeof createReviewService>;
  let calls = 0;
  const settings = {
    stateFile: path.join(home, 'state.db'),
    ownerFile: path.join(home, 'owner.db'),
    runners: {
      codex: () => ({
        id: 'codex',
        caps,
        detect: async () => ({ installed: true }),
        async *run(spec: Parameters<AgentRunner['run']>[0]) {
          calls++;
          assert.equal(spec.access, 'read');
          assert.equal(spec.model, 'PINNED');
          assert.match(spec.prompt, /Revision: [a-f0-9]{64}/);
          yield { t: 'done' as const, code: 0, result: 'Finding proposal for owner verification' };
        },
      }),
    },
    admit: async () => ({ allowed: true as const }),
    reviewAdmit: (
      job: Parameters<NonNullable<Parameters<typeof openDaemonJobs>[0]['reviewAdmit']>>[0],
      signal: AbortSignal,
      metadata: Parameters<NonNullable<Parameters<typeof openDaemonJobs>[0]['reviewAdmit']>>[2],
    ) => reviews.admit(job, signal, metadata),
    ...extra,
  };
  const jobs = openDaemonJobs(settings);
  jobs.recover();
  reviews = createReviewService({ jobs, env: f.sb.env(), schedule() {} });
  const scope = { projectId: project(f.root).id, audience: 'owner' as const };
  return {
    ...f,
    settings,
    jobs,
    reviews,
    scope,
    calls: () => calls,
    async close() {
      try {
        await reviews.close();
        await jobs.close();
      } finally {
        f.sb.cleanup();
      }
    },
  };
}
const request = (requestId = 'review') => ({
  privacy: 'public' as const,
  requestId,
  runnerId: 'codex' as const,
  model: 'PINNED',
  effort: 'high',
  sourceHost: 'claude' as const,
});

test('native snapshot binds base/head/branch, staged version, working bytes/mode and untracked bodies without changing checkout', async () => {
  const f = fixture();
  try {
    await gitEnvelope(f.sb, async (calls) => {
      fs.writeFileSync(path.join(f.root, 'file.ts'), 'export const value=1;\n');
      git(f.root, 'add', 'file.ts');
      git(f.root, 'commit', '-qm', 'file');
      fs.writeFileSync(path.join(f.root, 'file.ts'), 'export const value=2;\n');
      git(f.root, 'add', 'file.ts');
      fs.writeFileSync(path.join(f.root, 'file.ts'), 'export const value=3;\n');
      fs.writeFileSync(path.join(f.root, 'new.ts'), 'export const untracked=true;\n');
      const before = git(f.root, 'status', '--porcelain=v1', '-z');
      const captured = await f.capture();
      assert.equal(captured.snapshot.files.length, 2);
      assert.match(captured.snapshot.revision, /^[a-f0-9]{64}$/);
      assert.match(captured.diff, /STAGED:.*value=2/s);
      assert.match(captured.diff, /WORKING:.*value=3/s);
      assert.match(captured.diff, /UNTRACKED.*untracked=true/s);
      assert.equal(git(f.root, 'status', '--porcelain=v1', '-z'), before);
      const repeated = await f.capture();
      assert.equal(repeated.snapshot.revision, captured.snapshot.revision);
      assert.equal(repeated.diff, captured.diff);
      assert.doesNotMatch(JSON.stringify(captured.snapshot), /value=|untracked=true/);
      for (const call of calls) {
        assert.equal(call.env.GIT_CONFIG_GLOBAL, '/dev/null');
        assert.equal(call.env.GIT_CONFIG_VALUE_1, 'false');
      }
    });
  } finally {
    f.sb.cleanup();
  }
});

test('content changes invalidate revision even with restored mtime and the same Git status; staged-only, mode, untracked and branch changes also invalidate', async () => {
  const f = fixture();
  try {
    await gitEnvelope(f.sb, async () => {
      const file = path.join(f.root, 'file.ts');
      fs.writeFileSync(file, 'base');
      git(f.root, 'add', 'file.ts');
      git(f.root, 'commit', '-qm', 'base');
      fs.writeFileSync(file, 'AAAA');
      const first = await f.capture(false);
      const stat = fs.statSync(file);
      fs.writeFileSync(file, 'BBBB');
      fs.utimesSync(file, stat.atime, stat.mtime);
      const changed = await f.capture(false);
      assert.notEqual(changed.snapshot.revision, first.snapshot.revision);
      assert.equal(changed.snapshot.statusHash, first.snapshot.statusHash);
      git(f.root, 'add', 'file.ts');
      const staged = await f.capture(false);
      assert.notEqual(staged.snapshot.indexHash, changed.snapshot.indexHash);
      assert.notEqual(staged.snapshot.revision, changed.snapshot.revision);
      fs.chmodSync(file, 0o755);
      const mode = await f.capture(false);
      assert.notEqual(mode.snapshot.revision, staged.snapshot.revision);
      fs.writeFileSync(path.join(f.root, 'extra.ts'), 'new');
      const untracked = await f.capture(false);
      assert.notEqual(untracked.snapshot.revision, mode.snapshot.revision);
      git(f.root, 'worktree', 'add', '-b', 'topic', path.join(f.sb.root, 'topic'));
      const branch = await f.source.capture(
        { privacy: 'public' },
        path.join(f.sb.root, 'topic'),
        AbortSignal.timeout(10000),
        false,
      );
      assert.equal(branch.snapshot.branch, 'topic');
      assert.notEqual(branch.snapshot.revision, first.snapshot.revision);
    });
  } finally {
    f.sb.cleanup();
  }
});

test('private classification precedes base getters/Git and known credentials or credential-store paths never enter review material', async () => {
  const f = fixture();
  try {
    await gitEnvelope(f.sb, async (calls) => {
      const privateInput = {
        privacy: 'private',
        get base(): never {
          throw Error('PRIVATE_BASE');
        },
      };
      await assert.rejects(
        f.source.capture(privateInput as any, f.root, AbortSignal.timeout(1000)),
        code('private_input'),
      );
      assert.equal(calls.length, 0);
      fs.writeFileSync(path.join(f.root, 'public.ts'), 'api_key=' + 'x'.repeat(40));
      await assert.rejects(f.capture(), code('private_input'));
      fs.unlinkSync(path.join(f.root, 'public.ts'));
      fs.writeFileSync(path.join(f.root, '.env'), 'unclassified');
      await assert.rejects(f.capture(), code('private_input'));
      assert.equal(fs.readFileSync(path.join(f.root, '.env'), 'utf8'), 'unclassified');
    });
  } finally {
    f.sb.cleanup();
  }
});

test('deleted directories are captured as missing, external symlinks are withheld, and source payload budgets refuse partial reviews', async () => {
  const f = fixture();
  try {
    await gitEnvelope(f.sb, async () => {
      fs.mkdirSync(path.join(f.root, 'dir'));
      fs.writeFileSync(path.join(f.root, 'dir', 'file.ts'), 'base');
      git(f.root, 'add', 'dir');
      git(f.root, 'commit', '-qm', 'file');
      fs.rmSync(path.join(f.root, 'dir'), { recursive: true });
      const missing = await f.capture();
      assert.equal(missing.snapshot.files[0].kind, 'missing');
      assert.match(missing.diff, /deleted file mode/);
      fs.symlinkSync(path.join(f.sb.root, 'external'), path.join(f.root, 'link'));
      await assert.rejects(f.capture(), code('private_input'));
      fs.unlinkSync(path.join(f.root, 'link'));
      fs.writeFileSync(path.join(f.root, 'too-large.ts'), 'x'.repeat(25000));
      await assert.rejects(f.capture(), code('unavailable'));
      assert.equal(fs.statSync(path.join(f.root, 'too-large.ts')).size, 25000);
    });
  } finally {
    f.sb.cleanup();
  }
});

test('configured clean/process filters are rejected before native status/diff and never execute', async () => {
  const f = fixture();
  try {
    await gitEnvelope(f.sb, async (calls) => {
      fs.appendFileSync(
        path.join(f.root, '.git', 'config'),
        '\n[filter "unsafe"]\n\tprocess = execute-owner-command\n',
      );
      await assert.rejects(f.capture(), code('unsupported'));
      assert.equal(
        calls.some((call) => ['status', 'diff'].includes(call.args[0])),
        false,
      );
    });
  } finally {
    f.sb.cleanup();
  }
});

test('exact file batches bound the whole checkout but disclose only selected changes, use literal pathspecs and preserve coverage', async () => {
  const f = authority();
  try {
    await gitEnvelope(f.sb, async (calls) => {
      fs.writeFileSync(path.join(f.root, 'selected.ts'), 'export const SELECTED_ONLY=true;');
      fs.writeFileSync(path.join(f.root, 'other.ts'), 'OTHER_CHANGE_CANARY' + 'x'.repeat(25000));
      await assert.rejects(f.capture(), code('unavailable'));
      const selected = await f.source.capture(
        { privacy: 'public', paths: ['selected.ts'] },
        f.root,
        AbortSignal.timeout(10000),
      );
      assert.match(selected.diff, /SELECTED_ONLY/);
      assert.doesNotMatch(selected.diff, /OTHER_CHANGE_CANARY/);
      assert.equal(selected.snapshot.files.length, 2);
      const created = await f.reviews.submit(
        { ...request('batch'), paths: ['selected.ts'] },
        f.scope,
        f.root,
      );
      assert.ok(created.record && created.job);
      assert.deepEqual(created.record.paths, ['selected.ts']);
      const status = await f.reviews.get(f.scope, f.root, created.record.id);
      assert.deepEqual(status.coverage, { kind: 'selected-files', paths: ['selected.ts'] });
      assert.equal(status.freshness, 'matches');
      assert.ok(calls.some((call) => call.args.includes(':(literal)selected.ts')));
      fs.appendFileSync(path.join(f.root, 'other.ts'), 'changed');
      await f.jobs.runQueued();
      assert.equal(f.calls(), 0);
      assert.equal(f.jobs.get(f.scope, created.job.id).state, 'held');
      assert.equal((await f.reviews.get(f.scope, f.root, created.record.id)).freshness, 'stale');
      const db = new SqliteDatabase(f.settings.stateFile);
      try {
        const record = JSON.parse(
          String(
            db.prepare('SELECT payload FROM review_artifacts WHERE id=?').get(created.record.id)!
              .payload,
          ),
        );
        record.paths = null;
        db.prepare('UPDATE review_artifacts SET payload=? WHERE id=?').run(
          JSON.stringify(record),
          created.record.id,
        );
      } finally {
        db.close();
      }
      await assert.rejects(f.reviews.get(f.scope, f.root, created.record.id), code('unavailable'));
    });
  } finally {
    await f.close();
  }
});

test('review queues an exact public read-only owner job, links atomically and preserves original selection on duplicate requests', async () => {
  const f = authority();
  try {
    await gitEnvelope(f.sb, async () => {
      fs.writeFileSync(path.join(f.root, 'new.ts'), 'export const publicChange=true;');
      const result = await f.reviews.submit(request(), f.scope, f.root);
      assert.ok(result.record && result.job);
      assert.equal(result.job.ownerOnly, true);
      assert.equal(result.record.jobId, result.job.id);
      assert.equal(result.record.version, 2);
      await f.jobs.runQueued();
      assert.equal(f.calls(), 1);
      assert.equal(f.jobs.get(f.scope, result.job.id).state, 'succeeded');
      const status = await f.reviews.get(f.scope, f.root, result.record.id);
      assert.equal(status.freshness, 'matches');
      assert.equal(status.reviewerCompleted, true);
      assert.equal(status.checks, 'unverified');
      assert.equal(status.decision, 'owner-review-required');
      assert.equal(status.nativeHarness, 'different');
      assert.equal(status.effectiveVendor, 'unverified');
      const duplicate = await f.reviews.submit(
        {
          ...request(),
          get model(): never {
            throw Error('DUPLICATE_MODEL');
          },
        },
        f.scope,
        f.root,
      );
      assert.equal(duplicate.duplicate, true);
      assert.equal(duplicate.job!.id, result.job.id);
      assert.equal(f.calls(), 1);
      assert.throws(
        () => f.jobs.result({ ...f.scope, audience: 'model' }, result.job!.id),
        code('not_found'),
      );
      const db = new SqliteDatabase(f.settings.stateFile, { readOnly: true });
      try {
        assert.equal(db.prepare('SELECT count(*) AS n FROM review_artifacts').get()!.n, 1);
        const payload = JSON.parse(
          String(db.prepare('SELECT payload FROM jobs WHERE id=?').get(result.job.id)!.payload),
        );
        assert.equal(payload.reviewId, result.record.id);
        assert.equal(payload.access, 'read');
        assert.equal(payload.model, 'PINNED');
        assert.equal(payload.effort, 'high');
        assert.doesNotMatch(
          String(db.prepare('SELECT payload FROM review_artifacts').get()!.payload),
          /export const publicChange/,
        );
      } finally {
        db.close();
      }
    });
  } finally {
    await f.close();
  }
});

test('changed content before dispatch holds a review without inference or replay, and stale evidence cannot be released by a quota override', async () => {
  const f = authority();
  try {
    await gitEnvelope(f.sb, async () => {
      const file = path.join(f.root, 'new.ts');
      fs.writeFileSync(file, 'AAAA');
      const result = await f.reviews.submit(
        { ...request(), allowUnknownQuota: true },
        f.scope,
        f.root,
      );
      assert.ok(result.record && result.job);
      const stat = fs.statSync(file);
      fs.writeFileSync(file, 'BBBB');
      fs.utimesSync(file, stat.atime, stat.mtime);
      await f.jobs.runQueued();
      assert.equal(f.calls(), 0);
      assert.equal(f.jobs.get(f.scope, result.job.id).state, 'held');
      assert.equal(f.jobs.get(f.scope, result.job.id).reason, 'approval');
      const status = await f.reviews.get(f.scope, f.root, result.record.id);
      assert.equal(status.freshness, 'stale');
      assert.equal(status.reviewerCompleted, false);
      assert.equal((await f.jobs.release(f.scope, result.job.id)).state, 'held');
      assert.equal(f.calls(), 0);
    });
  } finally {
    await f.close();
  }
});

test('positive review outcome is preserved while later source changes invalidate its evidence instead of approving or rerunning it', async () => {
  const f = authority();
  try {
    await gitEnvelope(f.sb, async () => {
      const file = path.join(f.root, 'new.ts');
      fs.writeFileSync(file, 'public before');
      const result = await f.reviews.submit(request(), f.scope, f.root);
      assert.ok(result.record && result.job);
      await f.jobs.runQueued();
      fs.writeFileSync(file, 'public after');
      const status = await f.reviews.get(f.scope, f.root, result.record.id);
      assert.equal(status.reviewerCompleted, true);
      assert.equal(status.freshness, 'stale');
      assert.equal(status.decision, 'owner-review-required');
      assert.equal(
        f.jobs.result(f.scope, result.job.id),
        'Finding proposal for owner verification',
      );
      assert.equal(f.calls(), 1);
      fs.writeFileSync(file, 'api_key=' + 'x'.repeat(40));
      assert.equal((await f.reviews.get(f.scope, f.root, result.record.id)).freshness, 'withheld');
      assert.equal(f.calls(), 1);
    });
  } finally {
    await f.close();
  }
});

test('owner/model/privacy boundaries refuse getters before payload and same-origin clone status is denied before foreign content capture', async () => {
  const f = authority();
  try {
    await gitEnvelope(f.sb, async (calls) => {
      const hidden = {
        ...request(),
        privacy: 'private',
        get model(): never {
          throw Error('PRIVATE_MODEL');
        },
      };
      assert.throws(() => f.reviews.submit(hidden as any, f.scope, f.root), code('private_input'));
      assert.throws(
        () => f.reviews.submit(hidden as any, { ...f.scope, audience: 'model' }, f.root),
        code('unsupported'),
      );
      assert.equal(calls.length, 0);
      git(f.root, 'remote', 'add', 'origin', 'https://example.invalid/source.git');
      const scope = { ...f.scope, projectId: project(f.root).id };
      fs.writeFileSync(path.join(f.root, 'new.ts'), 'public');
      const result = await f.reviews.submit(request(), scope, f.root);
      assert.ok(result.record);
      const clone = gitRepo(f.sb, 'clone', 'https://example.invalid/source.git');
      fs.writeFileSync(path.join(clone, 'PRIVATE_FOREIGN_BODY'), 'api_key=' + 'x'.repeat(40));
      calls.length = 0;
      await assert.rejects(f.reviews.get(scope, clone, result.record.id), code('not_found'));
      assert.equal(
        calls.some((call) => ['ls-files', 'status', 'diff'].includes(call.args[0])),
        false,
      );
    });
  } finally {
    await f.close();
  }
});

test('lost review job/link COMMIT retains one original queued request across reopen without another model or artifact', async () => {
  const f = authority();
  const original = SqliteDatabase.prototype.exec;
  let commits = 0;
  let reopened: ReturnType<typeof openDaemonJobs> | undefined;
  let resumed: ReturnType<typeof createReviewService> | undefined;
  try {
    await gitEnvelope(f.sb, async () => {
      fs.writeFileSync(path.join(f.root, 'new.ts'), 'public');
      SqliteDatabase.prototype.exec = function (sql) {
        const result = original.call(this, sql);
        if (sql === 'COMMIT' && ++commits === 2) throw Error('lost job/link receipt');
        return result;
      };
      await assert.rejects(
        f.reviews.submit(request(), f.scope, f.root),
        (error: any) => error.details?.outcome === 'unknown',
      );
      SqliteDatabase.prototype.exec = original;
      assert.equal(f.calls(), 0);
      assert.throws(() => f.jobs.list(f.scope), code('unavailable'));
      await f.reviews.close();
      await f.jobs.close();
      reopened = openDaemonJobs({
        ...f.settings,
        reviewAdmit: (job, signal, metadata) => resumed!.admit(job, signal, metadata),
      });
      reopened.recover();
      resumed = createReviewService({ jobs: reopened, env: f.sb.env(), schedule() {} });
      const duplicate = await resumed.submit(
        {
          ...request(),
          get model(): never {
            throw Error('NO_REPLAY_MODEL');
          },
        },
        f.scope,
        f.root,
      );
      assert.equal(duplicate.duplicate, true);
      assert.ok(duplicate.record && duplicate.job);
      assert.equal(duplicate.job.state, 'queued');
      assert.equal(duplicate.record.jobId, duplicate.job.id);
      assert.equal(reopened.list(f.scope).length, 1);
      assert.equal(f.calls(), 0);
    });
  } finally {
    SqliteDatabase.prototype.exec = original;
    await resumed?.close();
    await reopened?.close();
    await f.close();
  }
});

test('tampered stored snapshot hash is withheld before inference without rewriting the original evidence or manufacturing freshness', async () => {
  const f = authority();
  try {
    await gitEnvelope(f.sb, async () => {
      fs.writeFileSync(path.join(f.root, 'new.ts'), 'public');
      const result = await f.reviews.submit(request(), f.scope, f.root);
      assert.ok(result.record && result.job);
      const db = new SqliteDatabase(f.settings.stateFile);
      try {
        const record = JSON.parse(
          String(
            db.prepare('SELECT payload FROM review_artifacts WHERE id=?').get(result.record.id)!
              .payload,
          ),
        );
        record.snapshot.files[0].sha256 = 'b'.repeat(64);
        db.prepare('UPDATE review_artifacts SET payload=? WHERE id=?').run(
          JSON.stringify(record),
          result.record.id,
        );
      } finally {
        db.close();
      }
      await f.jobs.runQueued();
      assert.equal(f.calls(), 0);
      assert.equal(f.jobs.get(f.scope, result.job.id).state, 'held');
      await assert.rejects(f.reviews.get(f.scope, f.root, result.record.id), code('unavailable'));
      const stored = f.jobs.reviews.get(f.scope, result.record.id);
      assert.equal(stored.snapshot.files[0].sha256, 'b'.repeat(64));
    });
  } finally {
    await f.close();
  }
});

test('actual review CLI/UDS requires public classification, uses exact read-only selection and reports source staleness without approval', async () => {
  let calls = 0;
  const f = await runtimeFixture('', {
    runner: {
      id: 'codex',
      caps,
      detect: async () => ({ installed: true }),
      async *run(spec) {
        calls++;
        assert.equal(spec.model, 'PINNED');
        assert.equal(spec.access, 'read');
        yield { t: 'done', code: 0, result: 'Owner finding proposal' };
      },
    },
  });
  try {
    await gitEnvelope(f.sb, async () => {
      const file = path.join(f.workspace, 'new.ts');
      fs.writeFileSync(file, 'public');
      const denied = await f.cli(['review', '--host', 'codex', '--model', 'PINNED']);
      assert.notEqual(denied.code, 0);
      assert.equal(calls, 0);
      const result = await f.cli([
        'review',
        '--public',
        '--host',
        'codex',
        '--model',
        'PINNED',
        '--source-host',
        'claude',
        '--request-id',
        'actual-review',
      ]);
      assert.equal(result.code, 0, result.err);
      const created = JSON.parse(result.out);
      assert.ok(created.record && created.job);
      assert.equal((await f.cli(['job', 'wait', created.job.id])).code, 0);
      assert.equal(calls, 1);
      const inspected = await f.cli(['review', 'get', created.record.id]);
      assert.equal(inspected.code, 0, inspected.err);
      assert.equal(JSON.parse(inspected.out).freshness, 'matches');
      assert.equal(JSON.parse(inspected.out).checks, 'unverified');
      fs.writeFileSync(file, 'changed');
      const stale = await f.cli(['review', 'get', created.record.id]);
      assert.equal(stale.code, 0, stale.err);
      assert.equal(JSON.parse(stale.out).freshness, 'stale');
      await assert.rejects(
        f.rpc('review.get', { id: created.record.id }, { ...f.scope, audience: 'model' }),
        code('unsupported'),
      );
    });
  } finally {
    await f.close();
  }
});
