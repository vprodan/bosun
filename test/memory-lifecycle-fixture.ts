import './bootstrap.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SqliteDatabase } from '../src/platform/sqlite.ts';
import { sandbox, fresh, gitRepo } from './helpers.ts';
import { runtimePaths } from '../src/platform/paths.ts';
import {
  parseRuntimeConfig,
  loadRuntimeConfig,
  renderRuntimeConfig,
  saveRuntimeConfig,
} from '../src/platform/config.ts';
import { setupRuntime } from '../src/app/setup.ts';
import { planUpgrade, applyUpgrade } from '../src/app/upgrade.ts';
import { startDaemon } from '../src/app/daemon.ts';
import { main } from '../src/app/cli.ts';
import { callLocalRpc } from '../src/adapters/transport/local-rpc.ts';
import { CutoverWriter } from '../src/adapters/memory/sqlite-cutover.ts';
import { MEMORY_MIGRATIONS } from '../src/adapters/memory/sqlite-schema.ts';
import { contentHash } from '../src/platform/content-hash.ts';
import { project } from '../src/platform/project.ts';
import type { RpcScope } from '../src/contracts/rpc.ts';

let serial = 0;
const DAY = 86400000;
export async function memoryLifecycleFixture(origin: 'fresh' | 'upgraded' = 'fresh') {
  const sb = sandbox();
  fresh(sb);
  const workspace = gitRepo(sb, 'memory-owner', 'git@example.com:team/memory-owner.git');
  const foreign = gitRepo(sb, 'memory-foreign', 'git@example.com:team/memory-foreign.git');
  const env = sb.env({
    BOSUN_HOME: path.join(sb.root, 'chosen-runtime'),
    BOSUN_SOCKET: path.join(process.env.BOSUN_TEST_RUN_ROOT!, 'ml' + process.pid + '_' + ++serial),
    BOSUN_SESSION_ID: 's_a',
  });
  const paths = runtimePaths(env),
    scope: RpcScope = { workspace, sessionId: 's_a', audience: 'owner' };
  const now = Date.now(),
    projectId = project(workspace).id;
  const records = [
    { id: 'public-note', category: 'project', private: 0, shared: 0, status: 'active', version: 1 },
    {
      id: 'private-note',
      category: 'personal',
      private: 1,
      shared: 0,
      status: 'active',
      version: 1,
    },
    {
      id: 'malformed-note',
      category: 'personal',
      private: 'false',
      shared: 1,
      status: 'active',
      version: 1,
    },
    {
      id: 'expired-note',
      category: 'session',
      private: 0,
      shared: 0,
      status: 'active',
      version: 1,
    },
    ...[0, 1, 'false'].map((flag, n) => ({
      id: 'restore-session-' + n,
      category: 'session',
      private: flag,
      shared: 1,
      status: 'archived',
      version: 2,
    })),
  ];
  function seed(db: SqliteDatabase) {
    const insert = db.prepare(
      'INSERT INTO memories(id,category,project_id,session_id,title,body,tags,shared,private,status,source,source_ref,hash,created_at,updated_at,expires_at,version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    );
    const event = db.prepare(
      'INSERT INTO memory_events(memory_id,op,at,source,hash_before,hash_after) VALUES(?,?,?,?,?,?)',
    );
    for (const value of records) {
      const title = value.id,
        body =
          value.private === 0
            ? value.id + ' zebra cart naming policy.'
            : 'PRIVATE-LIFECYCLE-CANARY ' + value.id;
      const hash = contentHash(title, body),
        createdAt = now - 2 * DAY;
      insert.run(
        value.id,
        value.category,
        value.category === 'personal' ? null : projectId,
        value.category === 'session' ? 's_a' : null,
        title,
        body,
        '["stable"]',
        value.shared,
        value.private,
        value.status,
        'cli',
        'original-reference',
        hash,
        createdAt,
        createdAt,
        value.category === 'session' ? now - 1000 : null,
        value.version,
      );
      event.run(value.id, 'store', createdAt, 'cli', null, hash);
      if (value.status === 'archived')
        event.run(value.id, 'archive', createdAt + 1, 'cli', hash, hash);
    }
  }
  let runtime: Awaited<ReturnType<typeof startDaemon>> | undefined;
  try {
    if (origin === 'fresh') {
      await setupRuntime(paths, parseRuntimeConfig('[memory]\nsessionTtlDays=1\n'));
      const writer = new CutoverWriter({
        primary: paths.memory,
        view: paths.view,
        backups: paths.backups,
      });
      try {
        writer.transaction(seed);
      } finally {
        writer.close();
      }
    } else {
      fs.mkdirSync(paths.home, { mode: 0o700 });
      fs.writeFileSync(
        paths.legacyConfig,
        'MEMORY_SESSION_TTL_DAYS=1\nCLAUDE_MEM=off\nROLE_WORKER_CODEX=gpt-6.1-sol:high\n',
        { mode: 0o600 },
      );
      fs.closeSync(fs.openSync(paths.memory, 'wx', 0o600));
      const db = new SqliteDatabase(paths.memory);
      try {
        db.exec(
          'PRAGMA journal_mode=WAL; CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);',
        );
        db.exec(MEMORY_MIGRATIONS[0]);
        db.prepare('INSERT INTO schema_migrations VALUES(1,?)').run(now);
        db.exec('BEGIN IMMEDIATE');
        try {
          seed(db);
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      } finally {
        db.close();
      }
      const planned = planUpgrade(paths, 'lifecycle_upgrade', { env });
      await applyUpgrade(paths, { plan: planned.plan, hash: planned.hash, clientsStopped: true, env });
    }
    const config = loadRuntimeConfig(paths, env),
      settings = { paths, config, environment: env, runners: {} };
    runtime = await startDaemon(settings);
    const rpc = (method: string, params: Record<string, unknown>, caller: RpcScope = scope) =>
      callLocalRpc<any>({
        socket: paths.socket,
        request: { version: 1, id: 'ml_' + ++serial, method, params, scope: caller },
      });
    const cli = async (args: string[], callerEnv = env, cwd = workspace) => {
      let out = '',
        err = '';
      const code = await main(args, {
        env: callerEnv,
        cwd,
        stdout: (text) => {
          out += text;
        },
        stderr: (text) => {
          err += text;
        },
      });
      return { code, out, err };
    };
    const row = (id: string) => {
      const db = new SqliteDatabase(paths.memory, { readOnly: true });
      try {
        const value = db.prepare('SELECT * FROM memories WHERE id=?').get(id);
        return value ? { ...value } : undefined;
      } finally {
        db.close();
      }
    };
    const events = (id: string) => {
      const db = new SqliteDatabase(paths.memory, { readOnly: true });
      try {
        return db
          .prepare('SELECT * FROM memory_events WHERE memory_id=? ORDER BY id')
          .all(id)
          .map((value) => ({ ...value }));
      } finally {
        db.close();
      }
    };
    return {
      sb,
      workspace,
      foreign,
      env,
      paths,
      scope,
      config,
      rpc,
      cli,
      row,
      events,
      get runtime() {
        return runtime!;
      },
      async restart(linkedProjects?: readonly string[]) {
        await runtime!.close();
        if (linkedProjects) {
          settings.config = parseRuntimeConfig(
            renderRuntimeConfig({
              ...settings.config,
              memory: { ...settings.config.memory, linkedProjects: [...linkedProjects] },
            }),
          );
          saveRuntimeConfig(paths, settings.config);
        }
        runtime = await startDaemon(settings);
      },
      async close() {
        try {
          await runtime?.close();
        } finally {
          sb.cleanup();
        }
      },
    };
  } catch (error) {
    try {
      await runtime?.close();
    } finally {
      sb.cleanup();
    }
    throw error;
  }
}
export async function completedMemoryJob(
  f: Awaited<ReturnType<typeof memoryLifecycleFixture>>,
  id: string,
) {
  const deadline = performance.now() + 5000;
  let job = await f.rpc('job.get', { id });
  while (['queued', 'running'].includes(job.state)) {
    assert.ok(performance.now() < deadline, 'original admin job must settle');
    await new Promise((resolve) => setTimeout(resolve, 10));
    job = await f.rpc('job.get', { id });
  }
  assert.equal(job.state, 'succeeded');
  return JSON.parse((await f.rpc('job.result', { id })).result);
}
