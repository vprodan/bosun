import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { gitEnvelope } from './git-fixture.ts';
import { SqliteDatabase } from '../src/platform/sqlite.ts';
import { sandbox, fresh, gitRepo } from './helpers.ts';
import { runtimeFixture } from './runtime-fixture.ts';
import { openDaemonJobs } from '../src/app/jobs.ts';
import { createGitWorkspace } from '../src/adapters/workspaces/git.ts';
import { createWorkspaceService } from '../src/core/use-cases/workspaces.ts';
import { createDaemonWorkspaces } from '../src/app/workspaces.ts';
import { project } from '../src/platform/project.ts';
import { DaemonOwner } from '../src/platform/daemon-owner.ts';
import { methodParams, METHODS } from '../src/contracts/methods.ts';
import { BosunError } from '../src/core/errors.ts';
import type { WorkspaceRecord } from '../src/core/domain/workspace.ts';
import type { AgentRunner } from '../src/core/ports/runner.ts';

const code = (value: string) => (error: unknown) =>
  error instanceof BosunError && error.code === value;
const digest = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
const caps: AgentRunner['caps'] = {
  vendor: 'fixture',
  readOnly: 'verified',
  sandbox: 'tool-allowlist',
  mcpInject: 'unsupported',
  effort: 'verified',
  localBackend: 'unsupported',
  billing: 'unknown',
};
function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
function fixture(extra: Partial<Parameters<typeof openDaemonJobs>[0]> = {}) {
  const sb = sandbox();
  fresh(sb);
  const from = gitRepo(sb, 'source');
  const home = path.join(sb.home, 'authority');
  fs.mkdirSync(home, { mode: 0o700 });
  const root = path.join(home, 'worktrees');
  const settings = {
    stateFile: path.join(home, 'state.db'),
    ownerFile: path.join(home, 'owner.db'),
    runners: {
      selected: () => ({
        id: 'selected',
        caps,
        detect: async () => ({ installed: true }),
        async *run() {
          yield { t: 'done' as const, code: 0, result: 'Completed' };
        },
      }),
    },
    admit: async () => ({ allowed: true as const }),
    ...extra,
  };
  const jobs = openDaemonJobs(settings);
  jobs.recover();
  const driver = createGitWorkspace({ root, env: sb.env() });
  const scope = { projectId: project(from).id, audience: 'owner' as const };
  let sequence = 0;
  const service = createWorkspaceService({
    storage: jobs.workspaces,
    driver,
    path: (id) => path.join(root, id),
    id: () => `w_${(++sequence).toString(16).padStart(32, '0')}`,
    now: Date.now,
    hash: digest,
  });
  return {
    sb,
    from,
    home,
    root,
    settings,
    jobs,
    driver,
    scope,
    service,
    async close() {
      try {
        await jobs.close();
      } finally {
        sb.cleanup();
      }
    },
  };
}

test('native creation checks out only the pinned commit, keeps dirty source files, filters auth/env and disables hooks', async () => {
  const f = fixture();
  let authReads = 0;
  try {
    await gitEnvelope(f.sb, async (calls) => {
      fs.writeFileSync(path.join(f.from, 'tracked.txt'), 'committed');
      git(f.from, 'add', 'tracked.txt');
      git(f.from, 'commit', '-qm', 'file');
      const base = git(f.from, 'rev-parse', 'HEAD').trim();
      fs.writeFileSync(path.join(f.from, 'tracked.txt'), 'owner dirty');
      fs.writeFileSync(path.join(f.from, 'extra.txt'), 'owner untracked');
      const hook = path.join(f.from, '.git', 'hooks', 'post-checkout');
      const sentinel = path.join(f.sb.root, 'hook-ran');
      fs.writeFileSync(hook, `#!/bin/sh\nprintf ran > '${sentinel}'\n`, {
        mode: 0o700,
      });
      const env = f.sb.env({
        OPENAI_API_KEY: 'AUTH_VALUE_CANARY',
        GIT_TRACE: 'AUTH_VALUE_CANARY',
      });
      Object.defineProperty(env, 'ANTHROPIC_API_KEY', {
        get() {
          authReads++;
          throw Error('auth');
        },
      });
      const driver = createGitWorkspace({ root: f.root, env });
      const service = createWorkspaceService({
        storage: f.jobs.workspaces,
        driver,
        path: (id) => path.join(f.root, id),
        id: () => `w_${'1'.repeat(32)}`,
        now: Date.now,
        hash: digest,
      });
      const result = await service.create({ requestId: 'create', name: 'task' }, f.scope, f.from);
      assert.equal(result.record.state, 'ready');
      assert.equal(result.record.base, base);
      assert.equal(result.dirtyContentsCopied, false);
      assert.equal(
        fs.readFileSync(path.join(result.record.path, 'tracked.txt'), 'utf8'),
        'committed',
      );
      assert.equal(fs.existsSync(path.join(result.record.path, 'extra.txt')), false);
      assert.equal(fs.readFileSync(path.join(f.from, 'tracked.txt'), 'utf8'), 'owner dirty');
      assert.equal(fs.existsSync(sentinel), false);
      assert.equal(authReads, 0);
      assert.equal(
        calls.filter((call) => call.args[0] === 'worktree' && call.args[1] === 'add').length,
        1,
      );
      for (const call of calls) {
        assert.equal(call.env.OPENAI_API_KEY, undefined);
        assert.equal(call.env.GIT_TRACE, undefined);
        assert.equal(call.env.GIT_CONFIG_GLOBAL, '/dev/null');
        assert.equal(call.env.GIT_CONFIG_KEY_1, 'core.fsmonitor');
        assert.equal(call.env.GIT_CONFIG_VALUE_1, 'false');
      }
      const duplicate = await service.create(
        { requestId: 'create', name: 'other', base: 'missing' },
        f.scope,
        f.from,
      );
      assert.equal(duplicate.duplicate, true);
      assert.equal(duplicate.record.id, result.record.id);
      assert.equal(
        calls.filter((call) => call.args[0] === 'worktree' && call.args[1] === 'add').length,
        1,
      );
    });
  } finally {
    await f.close();
  }
});

test('native prune preview is read only and binds clean, unlocked, merged Git state and durable ownership', async () => {
  const f = fixture();
  try {
    await gitEnvelope(f.sb, async () => {
      const { record } = await f.service.create(
        { requestId: 'prune', name: 'task' },
        f.scope,
        f.from,
      );
      assert.equal(record.state, 'ready');
      const result = await f.service.reconcile(f.scope, f.from, record.id);
      assert.equal(result.prune.candidate, true);
      assert.equal(result.prune.applies, false);
      assert.match(result.prune.revision, /^[a-f0-9]{64}$/);
      assert.deepEqual(result.prune.reasons, []);
      assert.equal(fs.existsSync(record.path), true);
      assert.match(git(f.from, 'worktree', 'list', '--porcelain'), new RegExp(record.branch));
      await assert.rejects(f.driver.remove(record.id), code('unsupported'));
      fs.writeFileSync(path.join(record.path, 'DIRTY_NAME_CANARY'), 'body');
      const dirty = await f.service.reconcile(f.scope, f.from, record.id);
      assert.equal(dirty.prune.candidate, false);
      assert.ok(dirty.prune.reasons.includes('dirty'));
      assert.notEqual(dirty.prune.revision, result.prune.revision);
      assert.doesNotMatch(JSON.stringify(dirty), /DIRTY_NAME_CANARY/);
      fs.unlinkSync(path.join(record.path, 'DIRTY_NAME_CANARY'));
      git(f.from, 'worktree', 'lock', record.path);
      const locked = await f.service.reconcile(f.scope, f.from, record.id);
      assert.ok(locked.prune.reasons.includes('locked'));
      assert.equal(locked.prune.candidate, false);
      git(f.from, 'worktree', 'unlock', record.path);
      git(record.path, 'commit', '-q', '--allow-empty', '-m', 'unmerged');
      const unmerged = await f.service.reconcile(f.scope, f.from, record.id);
      assert.ok(unmerged.prune.reasons.includes('unmerged'));
      assert.equal(unmerged.prune.candidate, false);
    });
  } finally {
    await f.close();
  }
});

test('ignored worktree files also prevent prune, and no foreign or unowned worktree is adopted', async () => {
  const f = fixture();
  try {
    await gitEnvelope(f.sb, async () => {
      fs.writeFileSync(path.join(f.from, '.gitignore'), 'cache/\n');
      git(f.from, 'add', '.gitignore');
      git(f.from, 'commit', '-qm', 'ignore');
      const { record } = await f.service.create(
        { requestId: 'ignored', name: 'task' },
        f.scope,
        f.from,
      );
      fs.mkdirSync(path.join(record.path, 'cache'));
      fs.writeFileSync(path.join(record.path, 'cache', 'private'), 'cached');
      const result = await f.service.reconcile(f.scope, f.from, record.id);
      assert.ok(result.prune.reasons.includes('dirty'));
      assert.equal(result.prune.candidate, false);
      const other = path.join(f.sb.root, 'unowned');
      git(f.from, 'worktree', 'add', '-b', 'unowned', other);
      assert.equal((await f.service.list(f.scope, f.from)).length, 1);
      assert.equal(fs.existsSync(other), true);
    });
  } finally {
    await f.close();
  }
});

test('queued, held, running and unknown jobs in an owned path prevent prune while settled jobs do not', async () => {
  const f = fixture();
  try {
    await gitEnvelope(f.sb, async () => {
      const { record } = await f.service.create(
        { requestId: 'jobs', name: 'task' },
        f.scope,
        f.from,
      );
      const job = f.jobs.submit(
        {
          privacy: 'public',
          requestId: 'job',
          taskId: 'task',
          runnerId: 'selected',
          prompt: 'public',
          cwd: record.path,
          access: 'read',
          model: 'PINNED',
        },
        f.scope,
      ).job;
      const queued = await f.service.reconcile(f.scope, f.from, record.id);
      assert.equal(queued.jobs.active, 1);
      assert.ok(queued.prune.reasons.includes('active_jobs'));
      const states = new SqliteDatabase(f.settings.stateFile);
      try {
        for (const state of ['held', 'running']) {
          states.prepare('UPDATE jobs SET state=? WHERE id=?').run(state, job.id);
          assert.ok(
            (await f.service.reconcile(f.scope, f.from, record.id)).prune.reasons.includes(
              'active_jobs',
            ),
          );
        }
        states.prepare("UPDATE jobs SET state='queued' WHERE id=?").run(job.id);
      } finally {
        states.close();
      }
      await f.jobs.runQueued();
      // Generic jobs cannot bypass an owned worktree's admission by omitting its binding.
      assert.equal(f.jobs.get(f.scope, job.id).state, 'held');
      assert.equal(f.jobs.get(f.scope, job.id).reason, 'approval');
      f.jobs.cancel(f.scope, job.id);
      assert.equal((await f.service.reconcile(f.scope, f.from, record.id)).prune.candidate, true);
      const db = new SqliteDatabase(f.settings.stateFile);
      try {
        db.prepare("UPDATE jobs SET state='unknown',version=version+1 WHERE id=?").run(job.id);
      } finally {
        db.close();
      }
      const uncertain = await f.service.reconcile(f.scope, f.from, record.id);
      assert.equal(uncertain.jobs.uncertain, 1);
      assert.ok(uncertain.prune.reasons.includes('unknown_jobs'));
      assert.equal(uncertain.prune.candidate, false);
    });
  } finally {
    await f.close();
  }
});

test('lost final COMMIT preserves one positively created worktree and its ready record without replay after reopen', async () => {
  const f = fixture();
  const original = SqliteDatabase.prototype.exec;
  let commits = 0;
  let reopened: ReturnType<typeof openDaemonJobs> | undefined;
  try {
    await gitEnvelope(f.sb, async (calls) => {
      SqliteDatabase.prototype.exec = function (sql) {
        const result = original.call(this, sql);
        if (sql === 'COMMIT' && ++commits === 2) throw Error('lost finish');
        return result;
      };
      await assert.rejects(
        f.service.create({ requestId: 'lost-final', name: 'task' }, f.scope, f.from),
        (error: any) => error.details?.outcome === 'unknown',
      );
      SqliteDatabase.prototype.exec = original;
      assert.equal(
        calls.filter((call) => call.args[0] === 'worktree' && call.args[1] === 'add').length,
        1,
      );
      assert.throws(() => f.jobs.list(f.scope), code('unavailable'));
      await f.jobs.close();
      reopened = openDaemonJobs(f.settings);
      reopened.recover();
      const resumed = createWorkspaceService({
        storage: reopened.workspaces,
        driver: f.driver,
        path: (id) => path.join(f.root, id),
        id: () => `w_${'5'.repeat(32)}`,
        now: Date.now,
        hash: digest,
      });
      const result = await resumed.create(
        { requestId: 'lost-final', name: 'task' },
        f.scope,
        f.from,
      );
      assert.equal(result.duplicate, true);
      assert.equal(result.record.state, 'ready');
      assert.equal(fs.existsSync(result.record.path), true);
      assert.equal(
        calls.filter((call) => call.args[0] === 'worktree' && call.args[1] === 'add').length,
        1,
      );
    });
  } finally {
    SqliteDatabase.prototype.exec = original;
    await reopened?.close();
    await f.close();
  }
});

test('bounded permanent workspace capacity preserves unknown intents and owner isolation rather than evicting receipts', async () => {
  const f = fixture();
  try {
    const common = path.join(f.from, '.git');
    const base = git(f.from, 'rev-parse', 'HEAD').trim();
    for (let i = 0; i < 64; i++) {
      const id = `w_${i.toString(16).padStart(32, '0')}`;
      f.jobs.workspaces.reserve(f.scope, {
        id,
        requestId: `r_${i}`,
        name: 'task',
        projectId: f.scope.projectId,
        repository: common,
        from: f.from,
        path: path.join(f.root, id),
        branch: `bosun/${id}`,
        base,
        state: 'creating',
        version: 1,
        createdAt: 1,
        updatedAt: 1,
      });
    }
    const id = `w_${'f'.repeat(32)}`;
    assert.throws(
      () =>
        f.jobs.workspaces.reserve(f.scope, {
          id,
          requestId: 'overflow',
          name: 'task',
          projectId: f.scope.projectId,
          repository: common,
          from: f.from,
          path: path.join(f.root, id),
          branch: `bosun/${id}`,
          base,
          state: 'creating',
          version: 1,
          createdAt: 1,
          updatedAt: 1,
        }),
      code('unavailable'),
    );
    assert.equal(f.jobs.workspaces.list(f.scope).length, 64);
    assert.equal(
      f.jobs.workspaces.list(f.scope).every((record) => record.state === 'creating'),
      true,
    );
    assert.equal(fs.existsSync(f.root), false);
    assert.throws(
      () => f.jobs.workspaces.list({ ...f.scope, audience: 'model' }),
      code('unsupported'),
    );
  } finally {
    await f.close();
  }
});

test('lost positive Git receipt remains unknown across duplicate requests and daemon reopen without another creation', async () => {
  const f = fixture();
  let reopened: ReturnType<typeof openDaemonJobs> | undefined;
  try {
    await gitEnvelope(f.sb, async (calls) => {
      const driver = {
        ...f.driver,
        async create(input: Parameters<typeof f.driver.create>[0]) {
          await f.driver.create(input);
          throw Error('lost receipt');
        },
      };
      const service = createWorkspaceService({
        storage: f.jobs.workspaces,
        driver,
        path: (id) => path.join(f.root, id),
        id: () => `w_${'2'.repeat(32)}`,
        now: Date.now,
        hash: digest,
      });
      const { record } = await service.create({ requestId: 'lost', name: 'task' }, f.scope, f.from);
      assert.equal(record.state, 'unknown');
      assert.equal(fs.existsSync(record.path), true);
      const result = await service.reconcile(f.scope, f.from, record.id);
      assert.ok(result.prune.reasons.includes('creation_receipt_unknown'));
      assert.equal(result.observed.state, 'present');
      assert.equal(result.prune.candidate, false);
      await f.jobs.close();
      reopened = openDaemonJobs(f.settings);
      reopened.recover();
      const resumed = createWorkspaceService({
        storage: reopened.workspaces,
        driver: f.driver,
        path: (id) => path.join(f.root, id),
        id: () => `w_${'3'.repeat(32)}`,
        now: Date.now,
        hash: digest,
      });
      const duplicate = await resumed.create({ requestId: 'lost', name: 'task' }, f.scope, f.from);
      assert.equal(duplicate.duplicate, true);
      assert.equal(duplicate.record.state, 'unknown');
      assert.equal(duplicate.record.id, record.id);
      assert.equal(
        calls.filter((call) => call.args[0] === 'worktree' && call.args[1] === 'add').length,
        1,
      );
    });
  } finally {
    await reopened?.close();
    await f.close();
  }
});

test('model requests are denied before params, Git or registry access and known credentials are refused before a new intent', async () => {
  const f = fixture();
  try {
    await gitEnvelope(f.sb, async (calls) => {
      const params = {
        get requestId() {
          throw Error('do not read');
        },
      };
      assert.throws(
        () =>
          methodParams({
            version: 1,
            id: 'x',
            method: 'workspace.create',
            params,
            scope: { workspace: f.from, sessionId: null, audience: 'model' },
          }),
        code('unsupported'),
      );
      await assert.rejects(
        f.service.create(params as any, { ...f.scope, audience: 'model' }, f.from),
        code('unsupported'),
      );
      const secret = 'sk-proj-' + 'x'.repeat(32);
      await assert.rejects(
        f.service.create({ requestId: secret, name: 'task' }, f.scope, f.from),
        code('private_input'),
      );
      await assert.rejects(
        f.service.create({ requestId: 'credential', name: secret }, f.scope, f.from),
        code('private_input'),
      );
      assert.equal(calls.length, 0);
      assert.deepEqual(f.jobs.workspaces.list(f.scope), []);
      for (const [name, definition] of Object.entries(METHODS).filter(([name]) =>
        name.startsWith('workspace.'),
      )) {
        assert.equal((definition as any).ownerOnly, true, name);
        assert.equal((definition as any).tool, undefined, name);
      }
    });
  } finally {
    await f.close();
  }
});

test('same-origin clones remain separate workspace authorities and a removed/rebound path cannot qualify pruning', async () => {
  const f = fixture();
  try {
    await gitEnvelope(f.sb, async () => {
      git(f.from, 'remote', 'add', 'origin', 'https://example.invalid/project.git');
      const scope = { ...f.scope, projectId: project(f.from).id };
      const clone = gitRepo(f.sb, 'clone', 'https://example.invalid/project.git');
      const { record } = await f.service.create(
        { requestId: 'scope', name: 'task' },
        scope,
        f.from,
      );
      assert.equal(project(clone).id, scope.projectId);
      assert.deepEqual(await f.service.list(scope, clone), []);
      await assert.rejects(f.service.get(scope, clone, record.id), code('not_found'));
      await assert.rejects(
        f.service.get(
          { ...scope, projectId: project(gitRepo(f.sb, 'foreign')).id },
          f.from,
          record.id,
        ),
        code('not_found'),
      );
      fs.renameSync(record.path, record.path + '.retained');
      fs.mkdirSync(record.path);
      const changed = await f.service.reconcile(scope, f.from, record.id);
      assert.equal(changed.observed.state, 'changed');
      assert.equal(changed.prune.candidate, false);
    });
  } finally {
    await f.close();
  }
});

test('external checkout filters and existing destinations are held without running hooks, overwrite or automatic cleanup', async () => {
  const f = fixture();
  try {
    await gitEnvelope(f.sb, async (calls) => {
      fs.appendFileSync(
        path.join(f.from, '.git', 'config'),
        '\n[filter "unsafe"]\n\tprocess = execute-owner-command\n',
      );
      const result = await f.service.create({ requestId: 'filter', name: 'task' }, f.scope, f.from);
      assert.equal(result.record.state, 'unknown');
      assert.equal(fs.existsSync(result.record.path), false);
      assert.equal(
        calls.some((call) => call.args[0] === 'worktree' && call.args[1] === 'add'),
        false,
      );
      fs.writeFileSync(
        path.join(f.from, '.git', 'config'),
        '[core]\n\trepositoryformatversion = 0\n\tbare = false\n',
      );
      fs.mkdirSync(f.root, { mode: 0o700 });
      const target = path.join(f.root, `w_${'2'.padStart(32, '0')}`);
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, 'sentinel'), 'owner');
      const occupied = await f.service.create(
        { requestId: 'occupied', name: 'task' },
        f.scope,
        f.from,
      );
      assert.equal(occupied.record.state, 'unknown');
      assert.equal(occupied.record.path, target);
      assert.equal(fs.readFileSync(path.join(target, 'sentinel'), 'utf8'), 'owner');
      assert.equal(
        calls.some((call) => call.args[0] === 'worktree' && call.args[1] === 'add'),
        false,
      );
    });
  } finally {
    await f.close();
  }
});

test('lost reservation COMMIT fences the shared authority before Git, preserves original intent and never replays on reopen', async () => {
  const f = fixture();
  const original = SqliteDatabase.prototype.exec;
  let armed = true;
  let reopened: ReturnType<typeof openDaemonJobs> | undefined;
  try {
    await gitEnvelope(f.sb, async (calls) => {
      SqliteDatabase.prototype.exec = function (sql) {
        const result = original.call(this, sql);
        if (armed && sql === 'COMMIT') {
          armed = false;
          throw Error('lost committed receipt');
        }
        return result;
      };
      await assert.rejects(
        f.service.create({ requestId: 'lost-commit', name: 'task' }, f.scope, f.from),
        (error: any) => error.details?.outcome === 'unknown',
      );
      assert.equal(
        calls.some((call) => call.args[0] === 'worktree' && call.args[1] === 'add'),
        false,
      );
      assert.throws(() => f.jobs.list(f.scope), code('unavailable'));
      SqliteDatabase.prototype.exec = original;
      await f.jobs.close();
      reopened = openDaemonJobs(f.settings);
      reopened.recover();
      const resumed = createWorkspaceService({
        storage: reopened.workspaces,
        driver: f.driver,
        path: (id) => path.join(f.root, id),
        id: () => `w_${'4'.repeat(32)}`,
        now: Date.now,
        hash: digest,
      });
      const duplicate = await resumed.create(
        { requestId: 'lost-commit', name: 'task' },
        f.scope,
        f.from,
      );
      assert.equal(duplicate.duplicate, true);
      assert.equal(duplicate.record.state, 'creating');
      assert.equal(fs.existsSync(duplicate.record.path), false);
      assert.equal(
        calls.some((call) => call.args[0] === 'worktree' && call.args[1] === 'add'),
        false,
      );
    });
  } finally {
    SqliteDatabase.prototype.exec = original;
    await reopened?.close();
    await f.close();
  }
});

test('actual daemon/Commander workspace create/list/reconcile/prune-preview share native state, deny models and preserve the worktree', async () => {
  const f = await runtimeFixture();
  try {
    await gitEnvelope(f.sb, async () => {
      const created = await f.cli(['workspace', 'create', 'task', '--request-id', 'actual']);
      assert.equal(created.code, 0, created.err);
      const record = JSON.parse(created.out).record as WorkspaceRecord;
      assert.equal(record.state, 'ready');
      const listed = await f.cli(['workspace', 'list']);
      assert.equal(listed.code, 0, listed.err);
      assert.equal(JSON.parse(listed.out).workspaces[0].id, record.id);
      const preview = await f.cli(['workspace', 'prune-preview', record.id]);
      assert.equal(preview.code, 0, preview.err);
      assert.equal(JSON.parse(preview.out).prune.candidate, true);
      assert.equal(JSON.parse(preview.out).prune.applies, false);
      assert.equal(fs.existsSync(record.path), true);
      await assert.rejects(
        f.rpc('workspace.get', { id: record.id }, { ...f.scope, audience: 'model' }),
        code('unsupported'),
      );
      const db = new SqliteDatabase(f.paths.state, { readOnly: true });
      try {
        assert.equal(db.prepare('SELECT count(*) AS n FROM workspaces').get()!.n, 1);
      } finally {
        db.close();
      }
      const again = await f.cli([
        'workspace',
        'create',
        'task',
        '--request-id',
        'actual',
        '--base',
        'missing',
      ]);
      assert.equal(again.code, 0, again.err);
      assert.equal(JSON.parse(again.out).duplicate, true);
    });
  } finally {
    await f.close();
  }
});

test('workspace shutdown aborts and waits native creation settlement while the existing daemon owner remains held', async () => {
  const f = fixture();
  let started!: () => void;
  let finish!: () => void;
  const began = new Promise<void>((resolve) => (started = resolve));
  const settled = new Promise<void>((resolve) => (finish = resolve));
  let aborted = false;
  let closed = false;
  const driver = {
    ...f.driver,
    async repository() {
      return {
        root: f.from,
        common: path.join(f.from, '.git'),
        head: 'a'.repeat(40),
        projectId: f.scope.projectId,
      };
    },
    async create(input: Parameters<typeof f.driver.create>[0]) {
      input.signal!.addEventListener(
        'abort',
        () => {
          aborted = true;
        },
        { once: true },
      );
      started();
      await settled;
      throw Error('unknown native settlement');
    },
  };
  const workspaces = createDaemonWorkspaces({
    home: f.home,
    jobs: f.jobs,
    env: f.sb.env(),
    driver,
  });
  try {
    const task = workspaces.create({ requestId: 'shutdown', name: 'task' }, f.scope, f.from);
    await began;
    const close = workspaces.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(aborted, true);
    assert.equal(closed, false);
    assert.throws(() => new DaemonOwner(f.settings.ownerFile), code('unavailable'));
    finish();
    const result = await task;
    await close;
    assert.equal(result.record.state, 'unknown');
    assert.equal(closed, true);
    f.jobs.assertOwner();
  } finally {
    finish();
    await workspaces.close();
    await f.close();
  }
});

function launchInput(requestId = 'launch') {
  return {
    privacy: 'public' as const,
    requestId,
    taskId: 'task',
    runnerId: 'selected',
    prompt: 'Public worktree task',
    access: 'read' as const,
    model: 'PINNED',
    effort: 'high',
    name: 'task',
  };
}

test('filters added after creation cannot execute during reconciliation or dispatch, even with a quota opt-in', async () => {
  let workspaces: ReturnType<typeof createDaemonWorkspaces> | undefined;
  let ran = 0;
  const f = fixture({
    workspaceAdmit: (job, signal, metadata) => workspaces!.admit(job, signal, metadata),
    runners: {
      selected: () => ({
        id: 'selected',
        caps,
        detect: async () => ({ installed: true }),
        async *run() {
          ran++;
          yield { t: 'done', code: 0, result: 'Completed' };
        },
      }),
    },
  });
  workspaces = createDaemonWorkspaces({ home: f.home, jobs: f.jobs, env: f.sb.env() });
  try {
    await gitEnvelope(f.sb, async (calls) => {
      fs.writeFileSync(path.join(f.from, '.gitattributes'), '*.txt filter=unsafe\n');
      fs.writeFileSync(path.join(f.from, 'file.txt'), 'public');
      git(f.from, 'add', '.gitattributes', 'file.txt');
      git(f.from, 'commit', '-qm', 'files');
      const queued = await workspaces!.spin(
        { ...launchInput('late-filter'), allowUnknownQuota: true },
        f.scope,
        f.from,
      );
      assert.ok(queued.job);
      calls.length = 0;
      const sentinel = path.join(f.sb.root, 'filter-ran');
      fs.appendFileSync(
        path.join(f.from, '.git', 'config'),
        `\n[filter "unsafe"]\n\tclean = touch '${sentinel}'\n`,
      );
      await assert.rejects(
        workspaces!.reconcile(f.scope, f.from, queued.record.id),
        code('unsupported'),
      );
      assert.equal(
        calls.some((call) => call.args[0] === 'status'),
        false,
      );
      assert.equal(fs.existsSync(sentinel), false);
      await f.jobs.runQueued();
      assert.equal(f.jobs.get(f.scope, queued.job.id).state, 'held');
      assert.equal(f.jobs.get(f.scope, queued.job.id).reason, 'admission_unavailable');
      assert.equal(ran, 0);
      assert.equal(
        calls.some((call) => call.args[0] === 'status'),
        false,
      );
      assert.equal(fs.existsSync(sentinel), false);
    });
  } finally {
    await workspaces.close();
    await f.close();
  }
});

test('spin atomically maps a pinned job to one owned worktree and dedupes before prompt getters or another launch', async () => {
  let workspaces: ReturnType<typeof createDaemonWorkspaces> | undefined;
  let calls = 0;
  let selected: any;
  const f = fixture({
    workspaceAdmit: (job, signal, metadata) => workspaces!.admit(job, signal, metadata),
    runners: {
      selected: () => ({
        id: 'selected',
        caps,
        detect: async () => ({ installed: true }),
        async *run(spec) {
          calls++;
          selected = spec;
          yield { t: 'done', code: 0, result: 'Completed in owned worktree' };
        },
      }),
    },
  });
  workspaces = createDaemonWorkspaces({ home: f.home, jobs: f.jobs, env: f.sb.env() });
  try {
    await gitEnvelope(f.sb, async (native) => {
      const result = await workspaces!.spin(launchInput(), f.scope, f.from);
      assert.ok(result.job);
      assert.equal(result.job.state, 'queued');
      assert.equal(result.record.state, 'ready');
      const inspect = new SqliteDatabase(f.settings.stateFile, { readOnly: true });
      let saved: any;
      try {
        saved = JSON.parse(
          String(
            inspect.prepare('SELECT payload FROM jobs WHERE id=?').get(result.job.id)!.payload,
          ),
        );
      } finally {
        inspect.close();
      }
      assert.equal(saved.workspaceId, result.record.id);
      assert.equal(saved.workspaceVersion, result.record.version);
      assert.equal(saved.cwd, result.record.path);
      assert.equal(f.jobs.workspaces.jobWorkspace(f.scope, result.job.id), result.record.id);
      await f.jobs.runQueued();
      assert.equal(calls, 1);
      assert.equal(selected.model, 'PINNED');
      assert.equal(selected.effort, 'high');
      assert.equal(selected.access, 'read');
      assert.equal(selected.cwd, result.record.path);
      assert.equal(f.jobs.get(f.scope, result.job.id).state, 'succeeded');
      const repeated = {
        ...launchInput(),
        get prompt(): never {
          throw Error('DUPLICATE_PROMPT_MUST_NOT_READ');
        },
      };
      const duplicate = await workspaces!.spin(repeated, f.scope, f.from);
      assert.equal(duplicate.duplicate, true);
      assert.equal(duplicate.job!.id, result.job.id);
      assert.equal(calls, 1);
      assert.equal(
        native.filter((call) => call.args[0] === 'worktree' && call.args[1] === 'add').length,
        1,
      );
      const db = new SqliteDatabase(f.settings.stateFile, { readOnly: true });
      try {
        const row = db.prepare('SELECT * FROM workspace_jobs').get()!;
        assert.equal(row.workspace_id, result.record.id);
        assert.equal(row.job_id, result.job.id);
        assert.doesNotMatch(JSON.stringify(row), /Public worktree task|PINNED|high/);
      } finally {
        db.close();
      }
    });
  } finally {
    await workspaces.close();
    await f.close();
  }
});

test('worktree job enqueue refuses stale versions and collisions with ordinary jobs or another workspace without changing selected work', async () => {
  const f = fixture();
  const workspaces = createDaemonWorkspaces({ home: f.home, jobs: f.jobs, env: f.sb.env() });
  try {
    await gitEnvelope(f.sb, async () => {
      const first = await workspaces.create({ requestId: 'first', name: 'first' }, f.scope, f.from);
      const second = await workspaces.create(
        { requestId: 'second', name: 'second' },
        f.scope,
        f.from,
      );
      await assert.rejects(
        workspaces.submit(
          { ...launchInput(), id: first.record.id, expectedVersion: 1 },
          f.scope,
          f.from,
        ),
        code('conflict'),
      );
      assert.equal(f.jobs.list(f.scope).length, 0);
      const original = f.jobs.submit({ ...launchInput('ordinary'), cwd: f.from }, f.scope).job;
      await assert.rejects(
        workspaces.spin(launchInput('ordinary'), f.scope, f.from),
        code('conflict'),
      );
      assert.equal(f.jobs.list(f.scope).length, 1);
      assert.equal(f.jobs.get(f.scope, original.id).state, 'queued');
      const mapped = await workspaces.submit(
        { ...launchInput('mapped'), id: first.record.id, expectedVersion: first.record.version },
        f.scope,
        f.from,
      );
      await assert.rejects(
        workspaces.submit(
          {
            ...launchInput('mapped'),
            id: second.record.id,
            expectedVersion: second.record.version,
          },
          f.scope,
          f.from,
        ),
        code('conflict'),
      );
      assert.equal(f.jobs.workspaces.jobWorkspace(f.scope, mapped.job.id), first.record.id);
      assert.equal(f.jobs.list(f.scope).length, 2);
      // Missing positive workspace admission is held even with general quota permission.
      await f.jobs.runQueued();
      assert.equal(f.jobs.get(f.scope, mapped.job.id).state, 'held');
      assert.equal(f.jobs.get(f.scope, mapped.job.id).reason, 'approval');
    });
  } finally {
    await workspaces.close();
    await f.close();
  }
});

test('privacy and credential screening precede spin worktree effects, and model requests cannot create or queue owned work', async () => {
  const f = fixture();
  const workspaces = createDaemonWorkspaces({ home: f.home, jobs: f.jobs, env: f.sb.env() });
  try {
    await gitEnvelope(f.sb, async (calls) => {
      const hidden = {
        ...launchInput(),
        privacy: 'private',
        get prompt(): never {
          throw Error('PRIVATE_MUST_NOT_READ');
        },
      };
      await assert.rejects(workspaces.spin(hidden as any, f.scope, f.from), code('private_input'));
      for (const field of ['prompt', 'model', 'effort'])
        await assert.rejects(
          workspaces.spin(
            { ...launchInput(), [field]: 'sk-proj-' + 'x'.repeat(40) },
            f.scope,
            f.from,
          ),
          code('private_input'),
        );
      assert.throws(
        () => workspaces.spin(hidden as any, { ...f.scope, audience: 'model' }, f.from),
        code('unsupported'),
      );
      assert.throws(
        () =>
          f.jobs.submit(
            {
              ...launchInput(),
              cwd: f.from,
              workspaceId: `w_${'a'.repeat(32)}`,
              workspaceVersion: 2,
              get prompt(): never {
                throw Error('MODEL_BINDING_MUST_NOT_READ_PROMPT');
              },
            },
            { ...f.scope, audience: 'model' },
          ),
        code('unsupported'),
      );
      assert.equal(calls.length, 0);
      assert.equal(fs.existsSync(f.root), false);
      assert.deepEqual(f.jobs.list(f.scope), []);
      assert.deepEqual(f.jobs.workspaces.list(f.scope), []);
    });
  } finally {
    await workspaces.close();
    await f.close();
  }
});

test('dispatch revalidates the exact worktree after enqueue and cannot bypass changed identity with allow-unknown-quota', async () => {
  let workspaces: ReturnType<typeof createDaemonWorkspaces> | undefined;
  let ran = 0;
  const f = fixture({
    workspaceAdmit: (job, signal, metadata) => workspaces!.admit(job, signal, metadata),
    runners: {
      selected: () => ({
        id: 'selected',
        caps,
        detect: async () => ({ installed: true }),
        async *run() {
          ran++;
          yield { t: 'done', code: 0, result: 'Completed' };
        },
      }),
    },
  });
  workspaces = createDaemonWorkspaces({ home: f.home, jobs: f.jobs, env: f.sb.env() });
  try {
    await gitEnvelope(f.sb, async () => {
      const queued = await workspaces!.spin(
        { ...launchInput(), allowUnknownQuota: true },
        f.scope,
        f.from,
      );
      assert.ok(queued.job);
      fs.renameSync(queued.record.path, queued.record.path + '.retained');
      fs.mkdirSync(queued.record.path);
      await f.jobs.runQueued();
      assert.equal(ran, 0);
      assert.equal(f.jobs.get(f.scope, queued.job.id).state, 'held');
      assert.equal(f.jobs.get(f.scope, queued.job.id).reason, 'admission_unavailable');
      const release = await f.jobs.release(f.scope, queued.job.id);
      assert.equal(release.state, 'held');
      assert.equal(ran, 0);
      assert.equal(f.jobs.workspaces.jobWorkspace(f.scope, queued.job.id), queued.record.id);
    });
  } finally {
    await workspaces.close();
    await f.close();
  }
});

test('unknown creation prevents spin enqueue or replay, while positive workspace intent is retained for owner inspection', async () => {
  const f = fixture();
  const driver = {
    ...f.driver,
    async create(input: Parameters<typeof f.driver.create>[0]) {
      await f.driver.create(input);
      throw Error('lost Git receipt');
    },
  };
  const workspaces = createDaemonWorkspaces({
    home: f.home,
    jobs: f.jobs,
    env: f.sb.env(),
    driver,
  });
  try {
    await gitEnvelope(f.sb, async (native) => {
      const first = await workspaces.spin(launchInput(), f.scope, f.from);
      assert.equal(first.job, null);
      assert.equal(first.record.state, 'unknown');
      assert.equal(fs.existsSync(first.record.path), true);
      assert.deepEqual(f.jobs.list(f.scope), []);
      const repeated = await workspaces.spin(launchInput(), f.scope, f.from);
      assert.equal(repeated.job, null);
      assert.equal(repeated.record.id, first.record.id);
      assert.equal(
        native.filter((call) => call.args[0] === 'worktree' && call.args[1] === 'add').length,
        1,
      );
    });
  } finally {
    await workspaces.close();
    await f.close();
  }
});

test('job-map COMMIT loss keeps exactly one queued job/link and dedupes after reopen without another worktree or submission', async () => {
  const f = fixture();
  let workspaces = createDaemonWorkspaces({ home: f.home, jobs: f.jobs, env: f.sb.env() });
  let reopened: ReturnType<typeof openDaemonJobs> | undefined;
  const original = SqliteDatabase.prototype.exec;
  let armed = false;
  try {
    await gitEnvelope(f.sb, async (native) => {
      const created = await workspaces.create(
        { requestId: 'mapped', name: 'task' },
        f.scope,
        f.from,
      );
      armed = true;
      SqliteDatabase.prototype.exec = function (sql) {
        const result = original.call(this, sql);
        if (armed && sql === 'COMMIT') {
          armed = false;
          throw Error('lost mapping commit');
        }
        return result;
      };
      await assert.rejects(
        workspaces.submit(
          {
            ...launchInput('mapped'),
            id: created.record.id,
            expectedVersion: created.record.version,
          },
          f.scope,
          f.from,
        ),
        (error: any) => error.details?.outcome === 'unknown',
      );
      SqliteDatabase.prototype.exec = original;
      assert.throws(() => f.jobs.list(f.scope), code('unavailable'));
      await workspaces.close();
      await f.jobs.close();
      reopened = openDaemonJobs(f.settings);
      reopened.recover();
      workspaces = createDaemonWorkspaces({ home: f.home, jobs: reopened, env: f.sb.env() });
      const duplicate = await workspaces.spin(
        {
          ...launchInput('mapped'),
          get prompt(): never {
            throw Error('no retry payload');
          },
        },
        f.scope,
        f.from,
      );
      assert.equal(duplicate.duplicate, true);
      assert.equal(duplicate.job!.state, 'queued');
      assert.equal(duplicate.record.id, created.record.id);
      assert.equal(reopened.list(f.scope).length, 1);
      assert.equal(reopened.workspaces.jobWorkspace(f.scope, duplicate.job!.id), created.record.id);
      assert.equal(
        native.filter((call) => call.args[0] === 'worktree' && call.args[1] === 'add').length,
        1,
      );
    });
  } finally {
    SqliteDatabase.prototype.exec = original;
    await workspaces.close();
    await reopened?.close();
    await f.close();
  }
});

test('retention preserves the workspace-to-original-job mapping and original no-replay receipt without archived task content', async () => {
  let now = 1000;
  let workspaces: ReturnType<typeof createDaemonWorkspaces> | undefined;
  const f = fixture({
    now: () => now,
    retentionDays: 1,
    workspaceAdmit: (job, signal, metadata) => workspaces!.admit(job, signal, metadata),
  });
  workspaces = createDaemonWorkspaces({ home: f.home, jobs: f.jobs, env: f.sb.env() });
  try {
    await gitEnvelope(f.sb, async (native) => {
      const first = await workspaces!.spin(launchInput('retained'), f.scope, f.from);
      await f.jobs.runQueued();
      assert.equal(f.jobs.get(f.scope, first.job!.id).state, 'succeeded');
      now += 86400001;
      assert.equal(f.jobs.prune(f.scope).jobs, 1);
      const duplicate = await workspaces!.spin(
        {
          ...launchInput('retained'),
          get prompt(): never {
            throw Error('archived payload');
          },
        },
        f.scope,
        f.from,
      );
      assert.equal(duplicate.job!.id, first.job!.id);
      assert.equal(duplicate.job!.retained, 'receipt');
      assert.equal(f.jobs.result(f.scope, first.job!.id), null);
      assert.equal(f.jobs.workspaces.jobWorkspace(f.scope, first.job!.id), first.record.id);
      assert.equal(
        native.filter((call) => call.args[0] === 'worktree' && call.args[1] === 'add').length,
        1,
      );
    });
  } finally {
    await workspaces.close();
    await f.close();
  }
});

test('actual spin/workspace-run CLI dispatches through the same native job authority with exact model and scoped branch', async () => {
  let calls = 0;
  const paths: string[] = [];
  const f = await runtimeFixture('', {
    runner: {
      id: 'codex',
      caps,
      detect: async () => ({ installed: true }),
      async *run(spec) {
        calls++;
        paths.push(spec.cwd);
        assert.equal(spec.model, 'PINNED');
        assert.equal(spec.effort, 'high');
        yield { t: 'done', code: 0, result: 'Completed worktree task' };
      },
    },
  });
  try {
    await gitEnvelope(f.sb, async () => {
      const taskFile = path.join(f.sb.root, 'public-task.txt');
      fs.writeFileSync(taskFile, 'public task');
      const result = await f.cli([
        'spin',
        '-f',
        taskFile,
        '--host',
        'codex',
        '--model',
        'PINNED',
        '--effort',
        'high',
        '--read-only',
        '--request-id',
        'cli-spin',
      ]);
      assert.equal(result.code, 0, result.err);
      const created = JSON.parse(result.out);
      assert.equal(created.record.state, 'ready');
      assert.ok(created.job);
      assert.equal((await f.cli(['job', 'wait', created.job.id])).code, 0);
      assert.equal(calls, 1);
      assert.equal(paths[0], created.record.path);
      const duplicate = await f.cli([
        'spin',
        'changed task',
        '--host',
        'codex',
        '--model',
        'PINNED',
        '--request-id',
        'cli-spin',
      ]);
      assert.equal(duplicate.code, 0, duplicate.err);
      assert.equal(JSON.parse(duplicate.out).job.id, created.job.id);
      assert.equal(calls, 1);
      const next = await f.cli([
        'workspace',
        'run',
        created.record.id,
        'next task',
        '--version',
        String(created.record.version),
        '--host',
        'codex',
        '--model',
        'PINNED',
        '--effort',
        'high',
        '--read-only',
        '--request-id',
        'cli-next',
      ]);
      assert.equal(next.code, 0, next.err);
      const nextJob = JSON.parse(next.out).job;
      assert.equal((await f.cli(['job', 'wait', nextJob.id])).code, 0);
      assert.equal(calls, 2);
      assert.equal(paths[1], created.record.path);
      await assert.rejects(
        f.rpc('spin.submit', launchInput(), { ...f.scope, audience: 'model' }),
        code('unsupported'),
      );
      const { name, ...publicJob } = launchInput();
      await assert.rejects(
        f.rpc('workspace.submit', {
          ...publicJob,
          id: created.record.id,
          expectedVersion: created.record.version,
          runnerId: 'bosun-summary',
        }),
        code('unsupported'),
      );
    });
  } finally {
    await f.close();
  }
});
