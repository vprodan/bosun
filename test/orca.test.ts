import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SqliteDatabase } from '../src/platform/sqlite.ts';
import { bosun, gitRepo } from './helpers.ts';
import { gitEnvelope } from './git-fixture.ts';
import {
  watchFixture,
  watchedRuntime,
  WATCH_TASK,
  watchCaps,
  syntheticObserver,
} from './orca-fixture.ts';
import { openDaemonJobs } from '../src/app/jobs.ts';
import { createWatchService } from '../src/app/watches.ts';
import { BosunError } from '../src/core/errors.ts';
import { METHODS } from '../src/contracts/methods.ts';
import { WATCH_LIMITS } from '../src/core/domain/watch.ts';

const code = (name: string) => (e: unknown) => e instanceof BosunError && e.code === name;
const effects = (f: ReturnType<typeof watchFixture>) =>
  f.native.calls().filter((row) => ['create', 'split'].includes(row.args[1]));

test('owned split watches one existing job; only IDs enter commands and UI metadata; duplicate requests never replay', async () => {
  const f = watchFixture();
  try {
    await gitEnvelope(f.sb, async (calls) => {
      const job = f.submit();
      const [first, repeated] = await Promise.all([
        f.watches.submit({ id: job.id, near: 'term_source' }, f.scope, f.root, 'source_session'),
        f.watches.submit({ id: job.id, near: 'term_source' }, f.scope, f.root, 'source_session'),
      ]);
      assert.ok([first.record?.state, repeated.record?.state].includes('opened'));
      assert.ok(
        [first.record?.state, repeated.record?.state].every(
          (state) => state === 'opened' || state === 'pending',
        ),
      );
      assert.equal((await f.watches.get(f.scope, f.root, job.id)).record?.state, 'opened');
      assert.equal(effects(f).length, 1);
      const args = effects(f)[0].args;
      assert.deepEqual(args.slice(0, 6), [
        'terminal',
        'split',
        '--terminal',
        'term_source',
        '--direction',
        'horizontal',
      ]);
      const command = args[args.indexOf('--command') + 1];
      assert.match(command, /job wait '.*' --timeout 300000 --progress$/);
      assert.doesNotMatch(command, /rename|PINNED|TOOL|OUTPUT|_exec|job submit|run /);
      assert.ok(command.includes("'BOSUN_SESSION_ID=source_session'"));
      assert.equal(effects(f)[0].cwd, f.root);
      assert.ok(
        calls.every(
          (call) =>
            !call.env.ANTHROPIC_AUTH_TOKEN && !call.env.CODEX_HOME && !call.env.ORCA_RUNTIME_URL,
        ),
      );
      const again = await f.watches.submit(
        {
          id: job.id,
          get near(): string {
            throw Error('duplicate getter');
          },
        },
        f.scope,
        f.root,
        null,
      );
      assert.equal(again.duplicate, true);
      assert.equal(again.record?.sourceSessionId, 'source_session');
      assert.equal(again.record?.requestId, job.requestId);
      assert.equal(again.record?.projectId, job.projectId);
      assert.equal(f.jobs.list(f.scope).length, 1);
      const db = new SqliteDatabase(f.paths.state, { readOnly: true });
      try {
        assert.doesNotMatch(
          String(db.prepare('SELECT payload FROM watch_receipts').get()!.payload),
          /rename|CONTENT CANARY|TOOL|OUTPUT|PINNED/,
        );
      } finally {
        db.close();
      }
      await f.jobs.runQueued();
      assert.equal(f.calls(), 1);
      assert.equal(f.jobs.result(f.scope, job.id), 'FINAL RESULT');
      assert.equal(f.jobs.get(f.scope, job.id).state, 'succeeded');
      assert.ok(f.jobs.events(f.scope, 0).events.some((row) => row.kind === 'tool'));
    });
  } finally {
    await f.close();
  }
});

test('standalone terminal creation uses a host-qualified workspace and never launches a native agent', async () => {
  const f = watchFixture();
  try {
    await gitEnvelope(f.sb, async () => {
      const result = await f.watches.submit({ id: f.submit().id }, f.scope, f.root, null);
      assert.equal(result.record?.state, 'opened');
      assert.deepEqual(effects(f)[0].args.slice(0, 6), [
        'terminal',
        'create',
        '--worktree',
        `identity:local|repo-test::${f.root}`,
        '--title',
        'bosun job observer',
      ]);
      assert.equal(f.calls(), 0);
    });
  } finally {
    await f.close();
  }
});

for (const mode of ['lost', 'malformed'])
  test(`native ${mode} receipt stays held across restart; late pane observation never runs a second job`, async () => {
    const f = watchFixture();
    let resumed: ReturnType<typeof openDaemonJobs> | undefined;
    try {
      await gitEnvelope(f.sb, async () => {
        const job = f.submit();
        f.native.change({ mode });
        const result = await f.watches.submit(
          { id: job.id, near: 'term_source' },
          f.scope,
          f.root,
          null,
        );
        assert.equal(result.record?.state, 'unknown');
        assert.equal(result.record?.handle, null);
        await f.jobs.runQueued();
        assert.equal(f.calls(), 1);
        await f.watches.close();
        await f.jobs.close();
        resumed = openDaemonJobs(f.settings);
        resumed.recover();
        const watches = createWatchService({
          jobs: resumed,
          env: f.env,
          paths: f.paths,
          driver: f.driver,
          observer: f.observer,
        });
        try {
          const repeated = await watches.submit(
            { id: job.id, near: 'term_source' },
            f.scope,
            f.root,
            null,
          );
          assert.equal(repeated.duplicate, true);
          assert.equal(repeated.record?.state, 'unknown');
          assert.equal((await watches.get(f.scope, f.root, job.id, true)).record?.state, 'unknown');
          await resumed.runQueued();
          assert.equal(f.calls(), 1);
          assert.equal(effects(f).length, 1);
        } finally {
          await watches.close();
        }
      });
    } finally {
      await resumed?.close();
      await f.close();
    }
  });

test('missing, remote, changed or unsupported terminal preflight leaves a concrete existing-job observation path and no pane effect', async () => {
  const f = watchFixture();
  try {
    await gitEnvelope(f.sb, async () => {
      const job = f.submit();
      for (const patch of [
        { version: '9.0.0' },
        { version: '1.4.222', host: 'ssh_fixture' },
        { host: 'local', wrongPath: '/different' },
      ]) {
        f.native.change(patch);
        const result = await f.watches.submit(
          { id: job.id, near: 'term_source' },
          f.scope,
          f.root,
          null,
        );
        assert.equal(result.record, null);
        assert.equal('state' in result && result.state, 'not_started');
        assert.deepEqual(result.observation.wait, ['bosun', 'job', 'wait', job.id]);
      }
      assert.equal(effects(f).length, 0);
      assert.equal(f.jobs.get(f.scope, job.id).state, 'queued');
      await f.jobs.runQueued();
      assert.equal(f.calls(), 1);
    });
  } finally {
    await f.close();
  }
});

test('closed or uncertain pane observation preserves the original job state and never changes execution ownership', async () => {
  const f = watchFixture();
  try {
    await gitEnvelope(f.sb, async () => {
      const job = f.submit();
      await f.watches.submit({ id: job.id, near: 'term_source' }, f.scope, f.root, null);
      f.native.change({ connected: false });
      const closed = await f.watches.get(f.scope, f.root, job.id, true);
      assert.equal('pane' in closed && closed.pane, 'closed');
      assert.equal(closed.record?.state, 'opened');
      assert.equal(closed.job.state, 'queued');
      assert.equal(closed.job.cancelRequested, false);
      f.native.change({ host: 'ssh_fixture' });
      const unavailable = await f.watches.get(f.scope, f.root, job.id, true);
      assert.equal('pane' in unavailable && unavailable.pane, 'unavailable');
      await f.jobs.runQueued();
      assert.equal(f.calls(), 1);
      assert.equal(effects(f).length, 1);
    });
  } finally {
    await f.close();
  }
});

test('watch rejects model callers, missing jobs, other projects/checkouts and credential-bearing source IDs before native discovery', async () => {
  const f = watchFixture();
  try {
    await gitEnvelope(f.sb, async () => {
      const job = f.submit();
      assert.throws(
        () => f.watches.submit({ id: job.id }, { ...f.scope, audience: 'model' }, f.root, null),
        code('unsupported'),
      );
      await assert.rejects(
        () => f.watches.submit({ id: 'missing' }, f.scope, f.root, null),
        code('not_found'),
      );
      const other = gitRepo(f.sb, 'other', 'https://example.invalid/orca-watch.git');
      await assert.rejects(
        () => f.watches.submit({ id: job.id }, f.scope, other, null),
        code('conflict'),
      );
      await assert.rejects(
        () => f.watches.submit({ id: job.id }, f.scope, f.root, 'sk-proj-' + 'x'.repeat(40)),
        code('private_input'),
      );
      await assert.rejects(
        () => f.watches.submit({ id: job.id, near: 'not-a-handle' }, f.scope, f.root, null),
        code('invalid'),
      );
      assert.equal(f.native.calls().length, 0);
      for (const name of ['job.watch', 'job.watchGet', 'job.watchReconcile'] as const)
        assert.equal(METHODS[name].ownerOnly, true);
      assert.equal('inference' in METHODS['job.watch'], false);
    });
  } finally {
    await f.close();
  }
});

for (const commit of [1, 2])
  test(`lost watch ${commit === 1 ? 'intent' : 'completion'} COMMIT preserves the finite original receipt without replay`, async () => {
    const f = watchFixture();
    const original = SqliteDatabase.prototype.exec;
    let resumed: ReturnType<typeof openDaemonJobs> | undefined;
    try {
      await gitEnvelope(f.sb, async () => {
        const job = f.submit();
        let count = 0;
        SqliteDatabase.prototype.exec = function (sql) {
          const result = original.call(this, sql);
          if (sql === 'COMMIT' && ++count === commit) throw Error('lost receipt');
          return result;
        };
        await assert.rejects(
          () => f.watches.submit({ id: job.id }, f.scope, f.root, null),
          (e) => e instanceof BosunError && e.details?.outcome === 'unknown',
        );
        SqliteDatabase.prototype.exec = original;
        await f.watches.close();
        await f.jobs.close();
        resumed = openDaemonJobs(f.settings);
        resumed.recover();
        const watches = createWatchService({
          jobs: resumed,
          env: f.env,
          paths: f.paths,
          driver: f.driver,
          observer: f.observer,
        });
        try {
          const duplicate = await watches.submit({ id: job.id }, f.scope, f.root, null);
          assert.equal(duplicate.record?.state, commit === 1 ? 'unknown' : 'opened');
          assert.equal(duplicate.duplicate, true);
          assert.equal(effects(f).length, commit === 1 ? 0 : 1);
          await resumed.runQueued();
          assert.equal(f.calls(), 1);
        } finally {
          await watches.close();
        }
      });
    } finally {
      SqliteDatabase.prototype.exec = original;
      await resumed?.close();
      await f.close();
    }
  });

test('owner drift after async preflight rejects the native effect; durable pending intent recovers as unknown without replay', async () => {
  const f = watchFixture();
  let resumed: ReturnType<typeof openDaemonJobs> | undefined;
  try {
    await gitEnvelope(f.sb, async () => {
      const job = f.submit(),
        open = f.driver.open;
      f.driver.open = (binding, near, command, signal, entered) =>
        open(binding, near, command, signal, () => {
          fs.chmodSync(f.paths.owner, 0o400);
          entered();
        });
      await assert.rejects(
        () => f.watches.submit({ id: job.id }, f.scope, f.root, null),
        code('unavailable'),
      );
      fs.chmodSync(f.paths.owner, 0o600);
      assert.equal(effects(f).length, 0);
      assert.equal(f.jobs.watches.find(f.scope, job.id)?.state, 'pending');
      await f.watches.close();
      await f.jobs.close();
      resumed = openDaemonJobs(f.settings);
      resumed.recover();
      const watches = createWatchService({
        jobs: resumed,
        env: f.env,
        paths: f.paths,
        driver: f.driver,
        observer: f.observer,
      });
      try {
        assert.equal(
          (await watches.submit({ id: job.id }, f.scope, f.root, null)).record?.state,
          'unknown',
        );
        assert.equal(effects(f).length, 0);
      } finally {
        await watches.close();
      }
    });
  } finally {
    fs.chmodSync(f.paths.owner, 0o600);
    await resumed?.close();
    await f.close();
  }
});

test('watch shutdown joins the bounded native CLI process and records unknown without cancelling or repeating the job', async () => {
  const f = watchFixture();
  try {
    await gitEnvelope(f.sb, async () => {
      const job = f.submit();
      f.native.change({ mode: 'wait' });
      const pending = f.watches.submit({ id: job.id }, f.scope, f.root, null);
      const deadline = performance.now() + 4000;
      while (!effects(f).length) {
        assert.ok(performance.now() < deadline);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const pid = effects(f)[0].pid;
      await f.watches.close();
      assert.equal((await pending).record?.state, 'unknown');
      assert.throws(
        () => process.kill(pid, 0),
        (e) => (e as NodeJS.ErrnoException).code === 'ESRCH',
      );
      assert.equal(f.jobs.get(f.scope, job.id).cancelRequested, false);
      await f.jobs.runQueued();
      assert.equal(f.calls(), 1);
    });
  } finally {
    await f.close();
  }
});

test('job binding drift at terminal effect entry rejects the pane and preserves the original durable task', async () => {
  const f = watchFixture();
  try {
    await gitEnvelope(f.sb, async () => {
      const job = f.submit(),
        open = f.driver.open;
      const db = new SqliteDatabase(f.paths.state);
      const original = String(
        db.prepare('SELECT payload FROM jobs WHERE id=?').get(job.id)!.payload,
      );
      try {
        f.driver.open = (binding, near, command, signal, entered) =>
          open(binding, near, command, signal, () => {
            db.prepare('UPDATE jobs SET payload=? WHERE id=?').run(
              JSON.stringify({ ...JSON.parse(original), cwd: '/changed' }),
              job.id,
            );
            entered();
          });
        const result = await f.watches.submit({ id: job.id }, f.scope, f.root, null);
        assert.equal(result.record?.state, 'not_started');
        assert.equal(effects(f).length, 0);
      } finally {
        db.prepare('UPDATE jobs SET payload=? WHERE id=?').run(original, job.id);
        db.close();
      }
      await f.jobs.runQueued();
      assert.equal(f.calls(), 1);
    });
  } finally {
    await f.close();
  }
});

test('finite durable watch receipt capacity holds another pane before its native effect and leaves the job queued', async () => {
  const f = watchFixture();
  try {
    await gitEnvelope(f.sb, async () => {
      const first = f.submit();
      await f.watches.submit({ id: first.id }, f.scope, f.root, null);
      const record = f.jobs.watches.find(f.scope, first.id)!;
      const db = new SqliteDatabase(f.paths.state);
      try {
        db.exec('BEGIN IMMEDIATE');
        const insert = db.prepare(
          'INSERT INTO watch_receipts(job_id,project_key,request_id,version,payload) VALUES(?,?,?,?,?)',
        );
        for (let n = 1; n < WATCH_LIMITS.records; n++) {
          const retained = {
            ...record,
            jobId: `retained_${n}`,
            requestId: `retained_request_${n}`,
          };
          insert.run(
            retained.jobId,
            retained.projectId,
            retained.requestId,
            retained.version,
            JSON.stringify(retained),
          );
        }
        db.exec('COMMIT');
      } finally {
        db.close();
      }
      const second = f.submit('capacity');
      await assert.rejects(
        () => f.watches.submit({ id: second.id }, f.scope, f.root, null),
        code('unavailable'),
      );
      assert.equal(effects(f).length, 1);
      assert.equal(f.jobs.get(f.scope, second.id).state, 'queued');
      assert.equal(f.jobs.watches.find(f.scope, second.id), null);
    });
  } finally {
    await f.close();
  }
});

test('observer entry drift during async terminal preflight holds the pane before the native effect', async () => {
  const f = watchFixture();
  try {
    await gitEnvelope(f.sb, async () => {
      const job = f.submit(),
        open = f.driver.open;
      f.driver.open = (binding, near, command, signal, entered) =>
        open(binding, near, command, signal, () => {
          fs.appendFileSync(
            path.join(f.paths.home, 'fixture-observer.js'),
            '// source entry changed',
          );
          entered();
        });
      const result = await f.watches.submit({ id: job.id }, f.scope, f.root, null);
      assert.equal(result.record?.state, 'not_started');
      assert.equal(effects(f).length, 0);
      assert.equal(result.job.state, 'queued');
      await f.jobs.runQueued();
      assert.equal(f.calls(), 1);
    });
  } finally {
    await f.close();
  }
});

test('unknown executor outcomes remain held when a pane opens or closes; observation supplies no retry path', async () => {
  let calls = 0;
  const f = watchFixture({
    runners: {
      codex: () => ({
        id: 'codex',
        caps: watchCaps,
        detect: async () => ({ installed: true }),
        async *run() {
          calls++;
          yield { t: 'tool' as const, name: 'Edit' };
          throw Error('lost native outcome');
        },
      }),
    },
  });
  try {
    await gitEnvelope(f.sb, async () => {
      const job = f.submit();
      await f.jobs.runQueued();
      assert.equal(f.jobs.get(f.scope, job.id).state, 'unknown');
      await f.watches.submit({ id: job.id }, f.scope, f.root, null);
      f.native.change({ connected: false });
      assert.equal((await f.watches.get(f.scope, f.root, job.id, true)).job.state, 'unknown');
      await f.jobs.runQueued();
      assert.equal(calls, 1);
      assert.equal(effects(f).length, 1);
    });
  } finally {
    await f.close();
  }
});

test('source observer safely quotes literal paths and refuses entry drift; idle daemon never discovers Orca', async () => {
  const f = await watchedRuntime();
  try {
    assert.equal(f.native.calls().length, 0);
    const directory = path.join(f.sb.home, "literal ' $(text) `tick`");
    fs.mkdirSync(directory, { mode: 0o700 });
    const observer = syntheticObserver({ ...f.paths, home: directory });
    const command = observer.command('job_1', f.workspace, null);
    assert.ok(command.includes("'\\''"));
    assert.doesNotMatch(command, /_exec|job submit|run /);
    fs.appendFileSync(path.join(directory, 'fixture-observer.js'), '// entry drift');
    assert.throws(() => observer.command('job_1', f.workspace, null), code('unavailable'));
    const second = syntheticObserver({ ...f.paths, home: directory });
    fs.chmodSync(path.join(directory, 'fixture-bun'), 0o600);
    assert.throws(() => second.command('job_1', f.workspace, null), code('unavailable'));
    const result = await bosun(['job', 'watch', 'missing'], { env: f.env, cwd: f.workspace });
    assert.equal(result.code, 1);
    assert.equal(f.native.calls().length, 0);
  } finally {
    await f.close();
  }
});

test('spin keeps the literal task and selected model in its owned daemon job when an Orca pane cannot bind the new worktree', async () => {
  const specs: import('../src/core/ports/runner.ts').RunSpec[] = [];
  const f = await watchedRuntime({
    runner: {
      id: 'codex',
      caps: watchCaps,
      detect: async () => ({ installed: true }),
      async *run(spec) {
        specs.push(spec);
        yield { t: 'done', code: 0, result: 'WORKTREE RESULT' };
      },
    },
  });
  try {
    await gitEnvelope(f.sb, async () => {
      const result = await f.cli([
        'spin',
        WATCH_TASK,
        '--name',
        'side_task',
        '--host',
        'codex',
        '--request-id',
        'spin_original',
        '--watch',
      ]);
      assert.equal(result.code, 0, result.err);
      const queued = JSON.parse(result.out);
      assert.equal(queued.record.state, 'ready');
      assert.equal(queued.watch.state, 'not_started');
      assert.equal((await f.cli(queued.watch.observation.wait.slice(1))).code, 0);
      const duplicate = JSON.parse(
        (
          await f.cli([
            'spin',
            WATCH_TASK,
            '--name',
            'side_task',
            '--host',
            'codex',
            '--request-id',
            'spin_original',
            '--no-watch',
          ])
        ).out,
      );
      assert.equal(duplicate.job.id, queued.job.id);
      assert.equal(specs.length, 1);
      assert.equal(specs[0].prompt, WATCH_TASK);
      assert.equal(specs[0].model, 'PINNED');
      assert.equal(specs[0].effort, 'high');
      assert.equal(specs[0].cwd, queued.record.path);
      assert.equal(specs[0].access, 'edit');
      assert.equal(
        f.native.calls().filter((row) => ['create', 'split'].includes(row.args[1])).length,
        0,
      );
    });
  } finally {
    await f.close();
  }
});

test('revision-bound review uses the same metadata observer and original read-only selected job', async () => {
  const specs: import('../src/core/ports/runner.ts').RunSpec[] = [];
  const f = await watchedRuntime({
    runner: {
      id: 'codex',
      caps: watchCaps,
      detect: async () => ({ installed: true }),
      async *run(spec) {
        specs.push(spec);
        yield { t: 'done', code: 0, result: 'REVIEW RESULT' };
      },
    },
  });
  try {
    await gitEnvelope(f.sb, async () => {
      fs.writeFileSync(path.join(f.workspace, 'public.ts'), 'export const publicSource = 1;\n');
      const args = [
        'review',
        '--public',
        '--host',
        'codex',
        '--model',
        'PINNED',
        '--effort',
        'high',
        '--request-id',
        'review_original',
        '--watch',
      ];
      const result = await f.cli(args);
      assert.equal(result.code, 0, result.err);
      const queued = JSON.parse(result.out);
      assert.equal(queued.watch.record.state, 'opened');
      const duplicate = JSON.parse((await f.cli(args)).out);
      assert.equal(duplicate.job.id, queued.job.id);
      assert.equal((await f.cli(['job', 'wait', queued.job.id])).code, 0);
      assert.equal(specs.length, 1);
      assert.equal(specs[0].access, 'read');
      assert.equal(specs[0].model, 'PINNED');
      assert.equal(specs[0].effort, 'high');
      assert.match(specs[0].prompt, /publicSource/);
      const split = f.native.calls().filter((row) => row.args[1] === 'split');
      assert.equal(split.length, 1);
      assert.doesNotMatch(split[0].args.join(' '), /publicSource|REVIEW RESULT|PINNED/);
    });
  } finally {
    await f.close();
  }
});

test('subdirectory callers retain each job exact execution cwd and canonical Orca pane binding', async () => {
  const specs: import('../src/core/ports/runner.ts').RunSpec[] = [];
  const f = await watchedRuntime({
    runner: {
      id: 'codex',
      caps: watchCaps,
      detect: async () => ({ installed: true }),
      async *run(spec) {
        specs.push(spec);
        yield { t: 'done', code: 0, result: 'SUBDIRECTORY RESULT' };
      },
    },
  });
  try {
    await gitEnvelope(f.sb, async () => {
      const cwd = path.join(f.workspace, 'pkg');
      fs.mkdirSync(cwd);
      fs.writeFileSync(path.join(f.workspace, 'public.ts'), 'export const publicSource = 1;\n');
      for (const args of [
        ['run', WATCH_TASK, '--host', 'codex', '--request-id', 'subdir_run', '--watch'],
        [
          'review',
          '--public',
          '--host',
          'codex',
          '--model',
          'PINNED',
          '--effort',
          'high',
          '--request-id',
          'subdir_review',
          '--watch',
        ],
      ]) {
        const result = await bosun(args, { env: f.env, cwd });
        assert.equal(result.code, 0, result.err);
        const queued = JSON.parse(result.out);
        assert.equal(queued.watch.record.state, 'opened');
        const jobCwd = args[0] === 'run' ? cwd : f.workspace; // Reviews already execute at their captured revision root.
        assert.equal(queued.watch.record.cwd, jobCwd);
        assert.equal(queued.watch.record.binding.root, f.workspace);
        assert.equal((await f.cli(['job', 'wait', queued.job.id])).code, 0);
        const observed = await f.rpc(
          'job.watchGet',
          { id: queued.job.id },
          { ...f.scope, workspace: cwd },
        );
        assert.equal(observed.record.cwd, jobCwd);
        assert.equal(observed.job.id, queued.job.id);
      }
      assert.equal(specs.length, 2);
      assert.ok(specs.every((spec) => spec.model === 'PINNED' && spec.effort === 'high'));
      assert.equal(specs[0].cwd, cwd);
      assert.equal(specs[1].cwd, f.workspace);
      assert.equal(specs[0].prompt, WATCH_TASK);
      assert.equal(specs[0].access, 'edit');
      assert.match(specs[1].prompt, /publicSource/);
      assert.equal(specs[1].access, 'read');
      assert.equal(f.native.calls().filter((row) => row.args[1] === 'split').length, 2);
      assert.ok(f.native.calls().every((row) => row.cwd === f.workspace));
    });
  } finally {
    await f.close();
  }
});
