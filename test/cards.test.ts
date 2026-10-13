import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SqliteDatabase } from '../src/platform/sqlite.ts';
import { sandbox, fresh, gitRepo } from './helpers.ts';
import { gitEnvelope } from './git-fixture.ts';
import { runtimeFixture } from './runtime-fixture.ts';
import { openDaemonJobs } from '../src/app/jobs.ts';
import { createCardService } from '../src/app/cards.ts';
import { createOrcaCard, selectedOrcaCommand } from '../src/adapters/workspaces/orca-card.ts';
import { project } from '../src/platform/project.ts';
import { BosunError } from '../src/core/errors.ts';
import { main } from '../src/app/cli.ts';
import { METHODS } from '../src/contracts/methods.ts';

const code = (name: string) => (error: unknown) =>
  error instanceof BosunError && error.code === name;
function stub(sb: Pick<ReturnType<typeof sandbox>, 'home' | 'bin'>, root: string) {
  const control = path.join(sb.home, 'orca-fixture.json');
  const log = path.join(sb.home, 'orca-calls.jsonl');
  const command = path.join(sb.bin, 'orca');
  fs.writeFileSync(
    control,
    JSON.stringify({
      version: '1.4.222',
      row: {
        id: `repo-test::${root}`,
        repoId: 'repo-test',
        path: root,
        hostId: 'local',
        workspaceStatus: 'todo',
        comment: '',
      },
      mode: 'ok',
    }),
  );
  fs.writeFileSync(
    command,
    `#!${process.execPath}\nconst fs=require('node:fs');const control=${JSON.stringify(control)},log=${JSON.stringify(log)};
const args=process.argv.slice(2), state=JSON.parse(fs.readFileSync(control,'utf8'));
fs.appendFileSync(log,JSON.stringify({args,cwd:process.cwd(),pid:process.pid})+'\\n');
if(args[0]==='--version'){process.stdout.write(state.version+'\\n');process.exit(0);}
if(args[0]!=='worktree')process.exit(2);
if(args[1]==='set'){
  state.row.workspaceStatus=args[args.indexOf('--workspace-status')+1];
  if(args.includes('--comment'))state.row.comment=args[args.indexOf('--comment')+1];
  fs.writeFileSync(control,JSON.stringify(state));
  if(state.mode==='wait'){setTimeout(()=>process.exit(1),30000);return;}
  if(state.mode==='lost')process.exit(1);
  if(state.mode==='malformed'){process.stdout.write('{}');process.exit(0);}
  if(state.mode==='wrong-status')state.row.workspaceStatus='todo';
}
process.stdout.write(JSON.stringify({id:'fixture',ok:true,result:{worktree:state.row}}));\n`,
    { mode: 0o700 },
  );
  return {
    control,
    command,
    calls: () =>
      fs.existsSync(log)
        ? fs
            .readFileSync(log, 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [],
    change(patch: Record<string, unknown>) {
      const state = JSON.parse(fs.readFileSync(control, 'utf8'));
      fs.writeFileSync(control, JSON.stringify({ ...state, ...patch }));
    },
  };
}
function fixture() {
  const sb = sandbox();
  fresh(sb);
  const root = gitRepo(sb, 'project', 'https://example.invalid/fixture-cards.git');
  const home = path.join(sb.home, 'authority');
  fs.mkdirSync(home, { mode: 0o700 });
  const settings = {
    stateFile: path.join(home, 'state.db'),
    ownerFile: path.join(home, 'owner.db'),
    runners: {},
  };
  const jobs = openDaemonJobs(settings);
  jobs.recover();
  const native = stub(sb, root);
  const env = sb.env();
  const driver = createOrcaCard({ env, command: native.command });
  const cards = createCardService({ jobs, env, driver });
  const scope = { projectId: project(root).id, audience: 'owner' as const };
  return {
    sb,
    root,
    home,
    settings,
    jobs,
    driver,
    cards,
    scope,
    native,
    input: (requestId = 'one', comment?: string) => ({
      privacy: 'public' as const,
      requestId,
      status: 'in-review',
      ...(comment === undefined ? {} : { comment }),
    }),
    async close() {
      try {
        await cards.close();
        await jobs.close();
      } finally {
        sb.cleanup();
      }
    },
  };
}

test('Orca selection respects the session executable and avoids the Linux screen reader', () => {
  assert.equal(
    selectedOrcaCommand({ ORCA_CLI_COMMAND: '/fixture/orca-next' }, 'darwin'),
    '/fixture/orca-next',
  );
  assert.equal(selectedOrcaCommand({ ORCA_DEV_REPO_ROOT: '/fixture/dev' }, 'darwin'), 'orca-dev');
  assert.equal(selectedOrcaCommand({}, 'linux'), 'orca-ide');
  assert.equal(selectedOrcaCommand({ ORCA_TERMINAL_HANDLE: 'fixture' }, 'linux'), 'orca');
  assert.throws(
    () => selectedOrcaCommand({ ORCA_CLI_COMMAND: 'orca --environment other' }, 'darwin'),
    code('unavailable'),
  );
});

test('native card update pins local host and checkout, sends literal argv and stores hashes rather than comment content', async () => {
  const f = fixture();
  try {
    await gitEnvelope(f.sb, async (calls) => {
      const comment = 'reviewed $(touch /not-an-action) `literal`';
      const result = await f.cards.submit(f.input('one', comment), f.scope, f.root);
      assert.equal(result.record.state, 'applied');
      assert.equal(result.duplicate, false);
      const set = f.native.calls().filter((row: any) => row.args[1] === 'set');
      assert.equal(set.length, 1);
      assert.deepEqual(set[0].args, [
        'worktree',
        'set',
        '--worktree',
        `identity:local|repo-test::${f.root}`,
        '--workspace-status',
        'in-review',
        '--comment',
        comment,
        '--json',
      ]);
      assert.equal(set[0].cwd, f.root);
      assert.ok(
        calls.every(
          (call) =>
            !call.env.ANTHROPIC_API_KEY && !call.env.CODEX_HOME && !call.env.ORCA_RUNTIME_URL,
        ),
      );
      const db = new SqliteDatabase(f.settings.stateFile, { readOnly: true });
      try {
        assert.doesNotMatch(
          String(db.prepare('SELECT payload FROM card_receipts').get()!.payload),
          /touch|literal|not-an-action/,
        );
      } finally {
        db.close();
      }
      const inspection = await f.cards.reconcile(f.scope, f.root, result.record.id);
      assert.equal(inspection.matches, true);
      assert.equal(inspection.record.state, 'applied');
      assert.equal(f.native.calls().filter((r: any) => r.args[1] === 'set').length, 1);
      const duplicate = await f.cards.submit(
        {
          privacy: 'public',
          requestId: 'one',
          get status(): string {
            throw Error('must not read');
          },
          get comment(): string {
            throw Error('must not read');
          },
        },
        f.scope,
        f.root,
      );
      assert.equal(duplicate.duplicate, true);
      assert.equal(duplicate.record.id, result.record.id);
      assert.equal(f.native.calls().filter((r: any) => r.args[1] === 'set').length, 1);
    });
  } finally {
    await f.close();
  }
});

test('private, credential, accessor, model and invalid status inputs have no Git or Orca effect', async () => {
  const f = fixture();
  try {
    await gitEnvelope(f.sb, async (calls) => {
      assert.throws(
        () => f.cards.submit({ ...f.input(), privacy: 'private' } as any, f.scope, f.root),
        code('private_input'),
      );
      assert.throws(
        () =>
          f.cards.submit(
            {
              get privacy() {
                throw Error('getter');
              },
            } as any,
            f.scope,
            f.root,
          ),
        code('private_input'),
      );
      assert.throws(
        () => f.cards.submit(f.input(), { ...f.scope, audience: 'model' }, f.root),
        code('unsupported'),
      );
      await assert.rejects(
        () => f.cards.submit({ ...f.input(), status: 'not-a-status' }, f.scope, f.root),
        code('invalid'),
      );
      await assert.rejects(
        () => f.cards.submit(f.input('secret', 'sk-proj-' + 'a'.repeat(60)), f.scope, f.root),
        code('private_input'),
      );
      await assert.rejects(
        () =>
          f.cards.submit(
            {
              ...f.input(),
              get comment(): string {
                throw Error('getter');
              },
            },
            f.scope,
            f.root,
          ),
        code('invalid'),
      );
      const mutable: any = f.input('changed-classification');
      const changed = f.cards.submit(mutable, f.scope, f.root);
      mutable.privacy = 'private';
      await assert.rejects(() => changed, code('private_input'));
      assert.equal(calls.length, 0);
      assert.equal(f.native.calls().length, 0);
      for (const name of ['card.submit', 'card.get', 'card.reconcile', 'card.acknowledge'] as const)
        assert.equal(METHODS[name].ownerOnly, true);
    });
  } finally {
    await f.close();
  }
});

test('unsupported versions, missing or remote host identities, and foreign worktree paths never update a card', async () => {
  const f = fixture();
  try {
    await gitEnvelope(f.sb, async () => {
      f.native.change({ version: '1.4.223' });
      await assert.rejects(() => f.cards.submit(f.input(), f.scope, f.root), code('unsupported'));
      f.native.change({ version: '1.4.222' });
      for (const hostId of [undefined, 'ssh:fixture']) {
        const row = JSON.parse(fs.readFileSync(f.native.control, 'utf8')).row;
        f.native.change({ row: { ...row, hostId } });
        await assert.rejects(() => f.cards.submit(f.input(), f.scope, f.root), code('unavailable'));
      }
      const row = JSON.parse(fs.readFileSync(f.native.control, 'utf8')).row;
      f.native.change({
        row: { ...row, hostId: 'local', path: f.sb.home, id: `repo-test::${f.sb.home}` },
      });
      await assert.rejects(() => f.cards.submit(f.input(), f.scope, f.root), code('unavailable'));
      assert.equal(f.native.calls().filter((r: any) => r.args[1] === 'set').length, 0);
    });
  } finally {
    await f.close();
  }
});

test('same-origin foreign checkout cannot read or retry the original card receipt', async () => {
  const f = fixture();
  try {
    await gitEnvelope(f.sb, async () => {
      const result = await f.cards.submit(f.input(), f.scope, f.root);
      const other = gitRepo(f.sb, 'other', 'https://example.invalid/fixture-cards.git');
      assert.equal(project(other).id, f.scope.projectId);
      const before = f.native.calls().length;
      await assert.rejects(() => f.cards.get(f.scope, other, result.record.id), code('conflict'));
      await assert.rejects(
        () =>
          f.cards.submit(
            {
              privacy: 'public',
              requestId: 'one',
              get status(): string {
                throw Error('foreign getter');
              },
            },
            f.scope,
            other,
          ),
        code('conflict'),
      );
      assert.equal(f.native.calls().length, before);
    });
  } finally {
    await f.close();
  }
});

test('lost native response stays unknown, blocks another update and supports explicit reviewed acknowledgement without replay', async () => {
  const f = fixture();
  try {
    await gitEnvelope(f.sb, async () => {
      f.native.change({ mode: 'lost' });
      const result = await f.cards.submit(f.input('one', 'finished fixture task'), f.scope, f.root);
      assert.equal(result.record.state, 'unknown');
      const duplicate = await f.cards.submit(f.input('one'), f.scope, f.root);
      assert.equal(duplicate.record.state, 'unknown');
      await assert.rejects(() => f.cards.submit(f.input('new'), f.scope, f.root), code('conflict'));
      const inspection = await f.cards.reconcile(f.scope, f.root, result.record.id);
      assert.equal(inspection.matches, true);
      assert.equal(inspection.record.state, 'unknown');
      await assert.rejects(
        () =>
          f.cards.acknowledge(
            {
              id: result.record.id,
              expectedVersion: result.record.version,
              observationHash: '0'.repeat(64),
            },
            f.scope,
            f.root,
          ),
        code('conflict'),
      );
      const acknowledgement = await f.cards.acknowledge(
        {
          id: result.record.id,
          expectedVersion: result.record.version,
          observationHash: inspection.observationHash!,
        },
        f.scope,
        f.root,
      );
      assert.equal(acknowledgement.record.state, 'unknown');
      assert.equal(acknowledgement.record.acknowledged, true);
      assert.equal(f.native.calls().filter((r: any) => r.args[1] === 'set').length, 1);
      f.native.change({ mode: 'ok' });
      const next = await f.cards.submit(
        f.input('new', 'owner chooses a later update'),
        f.scope,
        f.root,
      );
      assert.equal(next.record.state, 'applied');
      assert.equal(f.native.calls().filter((r: any) => r.args[1] === 'set').length, 2);
    });
  } finally {
    await f.close();
  }
});

test('card shutdown aborts and waits for native update closure before releasing the shared authority', async () => {
  const f = fixture();
  try {
    await gitEnvelope(f.sb, async () => {
      f.native.change({ mode: 'wait' });
      const pending = f.cards.submit(f.input('shutdown'), f.scope, f.root);
      const deadline = performance.now() + 3000;
      while (!f.native.calls().some((row: any) => row.args[1] === 'set')) {
        if (performance.now() >= deadline) assert.fail('native update did not start');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const pid = f.native.calls().find((row: any) => row.args[1] === 'set').pid;
      await f.cards.close();
      const result = await pending;
      assert.equal(result.record.state, 'unknown');
      assert.throws(
        () => process.kill(pid, 0),
        (error) => (error as NodeJS.ErrnoException).code === 'ESRCH',
      );
      await assert.rejects(
        () => f.cards.get(f.scope, f.root, result.record.id),
        code('unavailable'),
      );
      f.jobs.assertOwner();
    });
  } finally {
    await f.close();
  }
});

for (const commit of [1, 2])
  test(`lost ${commit === 1 ? 'intent' : 'terminal'} COMMIT preserves one original card and does not replay after reopen`, async () => {
    const f = fixture();
    const original = SqliteDatabase.prototype.exec;
    let resumed: ReturnType<typeof openDaemonJobs> | undefined;
    try {
      await gitEnvelope(f.sb, async () => {
        let count = 0;
        SqliteDatabase.prototype.exec = function (sql) {
          const result = original.call(this, sql);
          if (sql === 'COMMIT' && ++count === commit) throw Error('lost receipt');
          return result;
        };
        await assert.rejects(
          () => f.cards.submit(f.input('durable', 'checkpoint'), f.scope, f.root),
          (error) => error instanceof BosunError && error.details?.outcome === 'unknown',
        );
        SqliteDatabase.prototype.exec = original;
        await f.cards.close();
        await f.jobs.close();
        resumed = openDaemonJobs(f.settings);
        resumed.recover();
        const service = createCardService({ jobs: resumed, env: f.sb.env(), driver: f.driver });
        try {
          const before = f.native.calls().filter((r: any) => r.args[1] === 'set').length;
          const duplicate = await service.submit(f.input('durable'), f.scope, f.root);
          assert.equal(duplicate.duplicate, true);
          assert.equal(duplicate.record.state, commit === 1 ? 'unknown' : 'applied');
          assert.equal(before, commit === 1 ? 0 : 1);
          assert.equal(f.native.calls().filter((r: any) => r.args[1] === 'set').length, before);
        } finally {
          await service.close();
        }
      });
    } finally {
      SqliteDatabase.prototype.exec = original;
      await resumed?.close();
      await f.close();
    }
  });

test('malformed or mismatched positive response remains unknown and receipt tampering is withheld', async () => {
  const f = fixture();
  try {
    await gitEnvelope(f.sb, async () => {
      f.native.change({ mode: 'wrong-status' });
      const result = await f.cards.submit(f.input(), f.scope, f.root);
      assert.equal(result.record.state, 'unknown');
      const db = new SqliteDatabase(f.settings.stateFile);
      try {
        const payload = JSON.parse(
          String(db.prepare('SELECT payload FROM card_receipts').get()!.payload),
        );
        payload.status = 'completed';
        db.prepare('UPDATE card_receipts SET payload=?').run(JSON.stringify(payload));
      } finally {
        db.close();
      }
      await assert.rejects(() => f.cards.get(f.scope, f.root, result.record.id), code('conflict'));
    });
  } finally {
    await f.close();
  }
});

test('actual CLI skips outside Orca, requires public comments, and uses owner RPC with exact receipts', async () => {
  let native: ReturnType<typeof stub>;
  let env: Readonly<Record<string, string | undefined>>;
  const f = await runtimeFixture('', {
    cardDriver: (workspace, input) => {
      const sb = {
        home: input.HOME!,
        bin: input.PATH!.split(path.delimiter)[0],
      };
      native = stub(sb, workspace);
      env = input;
      return createOrcaCard({ env: input, command: native.command });
    },
  });
  try {
    await gitEnvelope(f.sb, async () => {
      const skipped = await f.cli(['card', 'completed']);
      assert.equal(skipped.code, 0);
      assert.equal(JSON.parse(skipped.out).state, 'skipped');
      assert.equal(native!.calls().length, 0);
      const run = async (args: string[], extra: Record<string, string> = {}) => {
        let out = '';
        let err = '';
        const status = await main(args, {
          env: { ...env!, ORCA_WORKTREE_ID: `repo-test::${f.workspace}`, ...extra },
          cwd: f.workspace,
          stdout: (text) => (out += text),
          stderr: (text) => (err += text),
        });
        return { status, out, err };
      };
      assert.equal((await run(['card', 'completed', 'private comment'])).status, 1);
      const invalid = await run(['card', 'invalid']);
      assert.equal(invalid.status, 2);
      assert.equal(JSON.parse(invalid.err).error.code, 'invalid');
      const model = await run(['card', 'completed'], { BOSUN_CALLER: 'model' });
      assert.equal(model.status, 1);
      assert.equal(JSON.parse(model.err).error.code, 'unsupported');
      const update = await run([
        'card',
        'completed',
        'public checkpoint',
        '--public',
        '--request-id',
        'cli',
      ]);
      assert.equal(update.status, 0, update.err);
      const record = JSON.parse(update.out).record;
      assert.equal(record.state, 'applied');
      const get = await f.cli(['card', 'get', record.id]);
      assert.equal(get.code, 0, get.err);
      assert.equal(JSON.parse(get.out).record.id, record.id);
      const reconcile = await f.cli(['card', 'reconcile', record.id]);
      assert.equal(reconcile.code, 0, reconcile.err);
      assert.equal(JSON.parse(reconcile.out).matches, true);
      await assert.rejects(
        () => f.rpc('card.get', { id: record.id }, { ...f.scope, audience: 'model' }),
        code('unsupported'),
      );
    });
  } finally {
    await f.close();
  }
});
