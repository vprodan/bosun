import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SqliteDatabase, type SqliteStatement } from '../src/platform/sqlite.ts';
import { sandbox, fresh, gitRepo } from './helpers.ts';
import { MEMORY_MIGRATIONS } from '../src/adapters/memory/sqlite-schema.ts';
import { contentHash } from '../src/platform/content-hash.ts';
import { runtimePaths } from '../src/platform/paths.ts';
import { importLegacyConfig } from '../src/core/legacy-config.ts';
import { loadRuntimeConfig } from '../src/platform/config.ts';
import {
  planUpgrade,
  applyUpgrade,
  saveUpgradePlan,
  upgradeStatus,
  upgradeHash,
} from '../src/app/upgrade.ts';
import { readRuntimeManifest } from '../src/platform/manifest.ts';
import { startDaemon } from '../src/app/daemon.ts';
import { main } from '../src/app/cli.ts';
import { callLocalRpc } from '../src/adapters/transport/local-rpc.ts';
import { project } from '../src/platform/project.ts';
import { BosunError } from '../src/core/errors.ts';
import type { AgentRunner } from '../src/core/ports/runner.ts';

const LEGACY = `LOCAL_MODEL=local-exact:tag
LOCAL_FALLBACK=fallback-exact:tag
OLLAMA_URL=http://127.0.0.1:11434
ROLE_WORKER_CODEX=role-exact:high
WORKER_BY_CODEX=direct-exact:low
REVIEW_BY_CODEX=review-exact:medium
ROLE_REVIEWER_CODEX=review-role-exact:high
LLM_MODEL=summary-exact:tag
CLAUDE_MEM=off
MEMORY_TOKEN=legacy-secret-not-imported
ROUTER_RUN=jaredpalmer/kev-0.8b
`;
let serial = 0;
function fixture(memory = true) {
  const sb = sandbox();
  fresh(sb);
  const workspace = gitRepo(sb, 'upgrade-repo');
  const env = sb.env({
    BOSUN_SOCKET: path.join(process.env.BOSUN_TEST_RUN_ROOT!, `up${process.pid}_${++serial}`),
  });
  const paths = runtimePaths(env);
  fs.mkdirSync(paths.home, { mode: 0o700 });
  fs.writeFileSync(paths.legacyConfig, LEGACY, { mode: 0o600 });
  const scope = { workspace, sessionId: null, audience: 'owner' as const };
  if (memory) {
    fs.closeSync(fs.openSync(paths.memory, 'wx', 0o600));
    const db = new SqliteDatabase(paths.memory);
    try {
      db.exec(
        'PRAGMA journal_mode=WAL; CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);',
      );
      db.exec(MEMORY_MIGRATIONS[0]);
      db.prepare('INSERT INTO schema_migrations VALUES(1,?)').run(123);
      const insert = db.prepare(
        `INSERT INTO memories(id,category,project_id,title,body,tags,shared,private,source,source_ref,hash,created_at,updated_at,version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      for (const [id, priv, shared] of [
        ['public-note', 0, 0],
        ['private-note', 1, 0],
        ['malformed-note', 'unknown', 2],
      ] as const)
        insert.run(
          id,
          'project',
          project(workspace).id,
          id,
          `${id} preserved original body`,
          '["stable"]',
          shared,
          priv,
          'cli',
          'original-reference',
          contentHash(id, `${id} preserved original body`),
          1,
          2,
          7,
        );
      db.prepare(
        "INSERT INTO memory_events(id,memory_id,op,at,source,hash_before,hash_after) VALUES(99,?,'store',2,'cli',NULL,?)",
      ).run('public-note', 'original-audit-hash');
      db.prepare('INSERT INTO docs(seq,path,project_id,mtime,title,body) VALUES(31,?,?,?,?,?)').run(
        'README.md',
        project(workspace).id,
        123,
        'Original documentation',
        'Original public indexed content',
      );
    } finally {
      db.close();
    }
  }
  const planned = () => planUpgrade(paths, 'upgrade_once', { env });
  const apply = (p = planned()) =>
    applyUpgrade(paths, { plan: p.plan, hash: p.hash, clientsStopped: true, env });
  const snapshot = (file = paths.memory) => {
    const db = new SqliteDatabase(file);
    try {
      return Object.fromEntries(
        ['memories', 'memory_events', 'docs'].map((table) => [
          table,
          db
            .prepare(`SELECT * FROM ${table} ORDER BY 1`)
            .all()
            .map((row) => ({ ...row })),
        ]),
      );
    } finally {
      db.close();
    }
  };
  const cli = async (args: string[], environment = env) => {
    let out = '',
      err = '';
    const code = await main(args, {
      env: environment,
      cwd: workspace,
      stdout: (s) => {
        out += s;
      },
      stderr: (s) => {
        err += s;
      },
    });
    return { code, out, err };
  };
  return { sb, env, paths, workspace, scope, planned, apply, snapshot, cli };
}
const unknown = (e: unknown) => e instanceof BosunError && e.details?.outcome === 'unknown';

test('legacy import preserves local, native role, direct worker/reviewer and provider selections without importing credentials', () => {
  const migrated = importLegacyConfig(LEGACY);
  assert.deepEqual(migrated.config.roles.worker.codex, { model: 'role-exact', effort: 'high' });
  assert.deepEqual(migrated.config.roles.executor.codex, { model: 'direct-exact', effort: 'low' });
  assert.deepEqual(migrated.config.roles['cross-reviewer'].codex, {
    model: 'review-exact',
    effort: 'medium',
  });
  assert.equal(migrated.config.roles.reviewer.codex!.model, 'review-role-exact');
  assert.equal(migrated.config.local.model, 'local-exact:tag');
  assert.equal(migrated.config.local.fallback, 'fallback-exact:tag');
  assert.equal(migrated.config.providers.default.model, 'summary-exact:tag');
  assert.equal(migrated.config.router.model, 'clef-flash:9b');
  assert.doesNotMatch(JSON.stringify(migrated), /legacy-secret-not-imported/);
  for (const text of [
    'FOO=unknown',
    'LLM_PROVIDERS=ollama,openai',
    'MEMORY_URL=http://127.0.0.1:8788',
    'ROLE_WORKER_CODEX=a:b:c',
    'LOCAL_MODEL=x\nLOCAL_MODEL=y',
  ])
    assert.throws(() => importLegacyConfig(text));
});

test('read-only upgrade plan performs no SQLite evaluation, creates no files and reports schema unverified', () => {
  const f = fixture();
  const prepare = SqliteDatabase.prototype.prepare;
  try {
    const before = fs.readdirSync(f.paths.home),
      bytes = fs.readFileSync(f.paths.memory);
    SqliteDatabase.prototype.prepare = () => {
      throw Error('Planning must not evaluate SQLite');
    };
    const p = f.planned();
    assert.equal(p.plan.memory, 'schema-unverified');
    assert.equal(p.hash, upgradeHash(JSON.stringify(p.plan)));
    assert.deepEqual(fs.readdirSync(f.paths.home), before);
    assert.deepEqual(fs.readFileSync(f.paths.memory), bytes);
    assert.doesNotMatch(JSON.stringify(p), /preserved original body|legacy-secret-not-imported/);
    const file = path.join(f.sb.root, 'reviewed-upgrade.json');
    saveUpgradePlan(file, p);
    assert.throws(() => saveUpgradePlan(file, p));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    SqliteDatabase.prototype.prepare = prepare;
    f.sb.cleanup();
  }
});

test('actual upgrade backs up original SQLite state before graph/floor commit and preserves raw rows, IDs, scope, audit and config', async () => {
  const f = fixture();
  try {
    const before = f.snapshot(),
      inode = fs.statSync(f.paths.memory).ino;
    const p = f.planned(),
      result = await f.apply(p);
    assert.equal(result.receipt.state, 'ready');
    assert.equal(result.manifest.memorySchema, 2);
    assert.deepEqual(f.snapshot(), before);
    assert.equal(fs.statSync(f.paths.memory).ino, inode);
    assert.equal(fs.readFileSync(f.paths.legacyConfig, 'utf8'), LEGACY);
    assert.deepEqual(f.snapshot(result.receipt.backup!), before);
    const backup = new SqliteDatabase(result.receipt.backup!, { readOnly: true });
    try {
      assert.deepEqual(
        backup
          .prepare('SELECT version FROM schema_migrations ORDER BY version')
          .all()
          .map((r) => r.version),
        [1],
      );
      assert.equal(
        backup
          .prepare(
            "SELECT count(*) n FROM sqlite_master WHERE name LIKE 'graph_%' OR name LIKE 'bosun_%'",
          )
          .get()!.n,
        0,
      );
    } finally {
      backup.close();
    }
    const loaded = loadRuntimeConfig(f.paths, {});
    assert.equal(loaded.roles.executor.codex!.model, 'direct-exact');
    assert.equal(readRuntimeManifest(f.paths).sourceId, p.plan.sourceId);
    const duplicate = await f.apply(p);
    assert.equal(duplicate.duplicate, true);
    assert.deepEqual(duplicate.receipt, result.receipt);
    assert.equal(fs.readdirSync(f.paths.backups).length, 1);
  } finally {
    f.sb.cleanup();
  }
});

test('upgrade inventories and preserves historical metrics, runtime log, and LLM usage files byte-for-byte', async () => {
  const f = fixture(false);
  const historical = new Map([
    ['metrics.jsonl', Buffer.from('{"op":"legacy-private-metric"}\nnot-json\n')],
    ['bosun.log', Buffer.from('{"event":"legacy-private-log"}\n')],
    ['llm-usage.jsonl', Buffer.from('{"task":"legacy-private-usage"}\nnot-json\n')],
  ]);
  try {
    for (const [name, bytes] of historical)
      fs.writeFileSync(path.join(f.paths.home, name), bytes, { mode: 0o600 });
    const planned = f.planned();
    assert.deepEqual(
      planned.plan.source.filter((row) => historical.has(row.name)).map((row) => row.name).sort(),
      [...historical.keys()].sort(),
      'historical telemetry remains in the reviewed source inventory',
    );
    const result = await f.apply(planned);
    assert.equal(result.receipt.state, 'ready');
    for (const [name, bytes] of historical)
      assert.deepEqual(fs.readFileSync(path.join(f.paths.home, name)), bytes, `${name} remains untouched`);
  } finally {
    f.sb.cleanup();
  }
});

test('upgraded data is usable through actual daemon owner/model methods and CLI run retains the separate direct model', async () => {
  const f = fixture();
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  const selections: { model?: string; effort?: string }[] = [];
  try {
    await f.apply();
    const runner: AgentRunner = {
      id: 'codex',
      caps: {
        vendor: 'fixture',
        readOnly: 'verified',
        sandbox: 'tool-allowlist',
        mcpInject: 'unsupported',
        effort: 'verified',
        localBackend: 'unverified',
        billing: 'unknown',
      },
      detect: async () => ({ installed: true }),
      async *run(spec) {
        selections.push({ model: spec.model, effort: spec.effort });
        yield { t: 'done', code: 0, result: 'Fixture completed' };
      },
    };
    daemon = await startDaemon({
      paths: f.paths,
      config: loadRuntimeConfig(f.paths, {}),
      environment: f.env,
      runners: { codex: () => runner },
      admit: async () => ({ allowed: true }),
    });
    const rpc = (
      method: string,
      params: Record<string, unknown>,
      audience: 'owner' | 'model' = 'owner',
    ) =>
      callLocalRpc<any>({
        socket: f.paths.socket,
        request: {
          version: 1,
          id: `up_${++serial}`,
          method,
          params,
          scope: { ...f.scope, audience },
        },
      });
    assert.equal(
      (await rpc('memory.get', { id: 'private-note' })).memory.body,
      'private-note preserved original body',
    );
    for (const id of ['private-note', 'malformed-note'])
      assert.doesNotMatch(
        JSON.stringify(await rpc('memory.get', { id }, 'model')),
        /preserved original body/,
      );
    const run = await f.cli(['run', 'Inspect the public task', '--host', 'codex', '--read-only']);
    assert.equal(run.code, 0, run.err);
    const id = JSON.parse(run.out).job.id;
    const deadline = Date.now() + 5000;
    while ((await rpc('job.get', { id })).state !== 'succeeded') {
      if (Date.now() > deadline) assert.fail('Pinned job did not finish');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(selections, [{ model: 'direct-exact', effort: 'low' }]);
  } finally {
    await daemon?.close();
    f.sb.cleanup();
  }
});

test('config-only legacy installation upgrades without inventing old rows and explicit CLI guards precede file access', async () => {
  const f = fixture(false);
  try {
    const file = path.join(f.sb.root, 'upgrade-plan.json');
    const denied = await f.cli(['upgrade', 'apply', file, '--hash', 'a'.repeat(64)], {
      ...f.env,
      BOSUN_CALLER: 'model',
    });
    assert.equal(denied.code, 1);
    assert.equal(fs.existsSync(f.paths.run), false);
    const plan = await f.cli(['upgrade', 'plan', '--request-id', 'cli_upgrade', '--output', file]);
    assert.equal(plan.code, 0, plan.err);
    const p = JSON.parse(plan.out);
    assert.equal(p.plan.memory, 'absent');
    assert.equal((await f.cli(['upgrade', 'apply', file, '--hash', p.hash])).code, 3);
    assert.equal(fs.existsSync(f.paths.run), false);
    const applied = await f.cli(['upgrade', 'apply', file, '--hash', p.hash, '--clients-stopped']);
    assert.equal(applied.code, 0, applied.err);
    assert.equal((f.snapshot().memories as unknown[]).length, 0);
    assert.equal(JSON.parse((await f.cli(['upgrade', 'status'])).out).state, 'ready');
  } finally {
    f.sb.cleanup();
  }
});

test('reviewed legacy modes are narrowed while original content and completed run receipts remain untouched', async () => {
  const f = fixture();
  try {
    fs.chmodSync(f.paths.home, 0o755);
    fs.chmodSync(f.paths.legacyConfig, 0o644);
    fs.chmodSync(f.paths.memory, 0o644);
    const runs = path.join(f.paths.home, 'runs');
    fs.mkdirSync(runs, { mode: 0o755 });
    fs.writeFileSync(path.join(runs, '123456-abcdef.rc'), '7', { mode: 0o644 });
    fs.writeFileSync(path.join(runs, '123456-abcdef.json'), 'PRIVATE-OLD-JOB-CONTENT', {
      mode: 0o644,
    });
    const p = f.planned();
    assert.equal(p.plan.homeMode, 0o755);
    assert.doesNotMatch(JSON.stringify(p), /PRIVATE-OLD-JOB-CONTENT/);
    await f.apply(p);
    assert.equal(fs.statSync(f.paths.home).mode & 0o777, 0o700);
    assert.equal(fs.statSync(f.paths.memory).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(path.join(runs, '123456-abcdef.rc'), 'utf8'), '7');
    assert.equal(
      fs.readFileSync(path.join(runs, '123456-abcdef.json'), 'utf8'),
      'PRIVATE-OLD-JOB-CONTENT',
    );
  } finally {
    f.sb.cleanup();
  }
});

for (const change of [
  'new-file',
  'source-bytes',
  'unsettled-run',
  'symlink',
  'hardlink',
] as const) {
  test(`upgrade ${change} refuses before any runtime intent or original-file mutation`, async () => {
    const f = fixture();
    try {
      const p = f.planned();
      if (change === 'new-file')
        fs.writeFileSync(path.join(f.paths.home, 'unowned.bin'), 'Preserve this unknown file');
      if (change === 'source-bytes') fs.appendFileSync(f.paths.legacyConfig, '\n# Owner edit\n');
      if (change === 'unsettled-run') {
        const dir = path.join(f.paths.home, 'runs');
        fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, '123-abcdef.pid'), '999999');
      }
      if (change === 'symlink') {
        fs.renameSync(f.paths.memory, path.join(f.sb.root, 'old-memory'));
        fs.symlinkSync(path.join(f.sb.root, 'old-memory'), f.paths.memory);
      }
      if (change === 'hardlink') fs.linkSync(f.paths.memory, path.join(f.sb.root, 'another-link'));
      const files = fs.readdirSync(f.paths.home);
      await assert.rejects(f.apply(p));
      assert.deepEqual(fs.readdirSync(f.paths.home), files);
      assert.equal(fs.existsSync(path.join(f.paths.home, 'upgrade.json')), false);
    } finally {
      f.sb.cleanup();
    }
  });
}

test('idle cached old writer cannot bypass the newly installed native SQL floor', async () => {
  const f = fixture();
  const mkdir = fs.mkdirSync;
  let old: SqliteDatabase | undefined, update: SqliteStatement | undefined;
  try {
    const p = f.planned();
    // Simulate a stale idle client arriving after preflight. Native admission
    // and SQL floor still have to prevent its already prepared old write.
    fs.mkdirSync = ((file: fs.PathLike, options: any) => {
      const result = mkdir(file, options);
      if (String(file) === f.paths.run && !old) {
        old = new SqliteDatabase(f.paths.memory);
        update = old.prepare("UPDATE memories SET title='Wrong old writer' WHERE id='public-note'");
      }
      return result;
    }) as typeof fs.mkdirSync;
    await f.apply(p);
    assert.ok(update);
    assert.throws(() => update!.run(), /bosun_writer_floor/);
    assert.equal((f.snapshot().memories as any[])[0].title, 'public-note');
  } finally {
    fs.mkdirSync = mkdir;
    old?.close();
    f.sb.cleanup();
  }
});

test('unknown legacy SQLite schema is held without changing original database or config bytes', async () => {
  const f = fixture();
  try {
    const db = new SqliteDatabase(f.paths.memory);
    try {
      db.exec('CREATE TABLE unknown_owner_table(value TEXT)');
    } finally {
      db.close();
    }
    fs.chmodSync(f.paths.home, 0o755);
    fs.chmodSync(f.paths.memory, 0o644);
    fs.chmodSync(f.paths.legacyConfig, 0o644);
    const before = fs.readFileSync(f.paths.memory),
      p = f.planned();
    const files = fs.readdirSync(f.paths.home);
    await assert.rejects(f.apply(p));
    assert.deepEqual(fs.readFileSync(f.paths.memory), before);
    assert.equal(fs.readFileSync(f.paths.legacyConfig, 'utf8'), LEGACY);
    assert.equal(fs.statSync(f.paths.home).mode & 0o777, 0o755);
    assert.equal(fs.statSync(f.paths.memory).mode & 0o777, 0o644);
    assert.deepEqual(fs.readdirSync(f.paths.home), files);
    assert.equal(fs.existsSync(f.paths.backups), false);
  } finally {
    f.sb.cleanup();
  }
});

test('actual live legacy writer admission prevents migration and no busy failure is retried', async () => {
  const f = fixture(),
    old = new SqliteDatabase(f.paths.memory);
  try {
    old.exec('BEGIN IMMEDIATE');
    const before = f.snapshot(),
      p = f.planned();
    await assert.rejects(f.apply(p));
    assert.deepEqual(f.snapshot(), before);
    assert.equal(fs.existsSync(f.paths.backups), false);
    old.exec('ROLLBACK');
    await assert.rejects(f.apply(p));
    assert.equal(fs.existsSync(f.paths.backups), false);
  } finally {
    if (old.isTransaction) old.exec('ROLLBACK');
    old.close();
    f.sb.cleanup();
  }
});

test('config edited after native migration stays intact and cannot activate a stale imported model selection', async () => {
  const f = fixture(),
    rename = fs.renameSync;
  try {
    const p = f.planned();
    let changed = false;
    fs.renameSync = (from, to) => {
      const phase =
        String(to) === path.join(f.paths.home, 'upgrade.json')
          ? JSON.parse(fs.readFileSync(from, 'utf8'))
          : null;
      rename(from, to);
      if (!changed && phase?.backup && phase.state === 'applying') {
        changed = true;
        fs.appendFileSync(
          f.paths.legacyConfig,
          '\n# Owner changed configuration during migration\n',
        );
      }
    };
    await assert.rejects(f.apply(p), unknown);
    fs.renameSync = rename;
    assert.equal(changed, true);
    assert.match(fs.readFileSync(f.paths.legacyConfig, 'utf8'), /Owner changed configuration/);
    assert.equal(fs.existsSync(f.paths.config), false);
    assert.equal(upgradeStatus(f.paths).state, 'unknown');
    assert.equal(readRuntimeManifest(f.paths).state, 'preparing');
  } finally {
    fs.renameSync = rename;
    f.sb.cleanup();
  }
});

for (const fault of ['schema-commit', 'ready-rename'] as const) {
  test(`actual upgrade ${fault} succeeds natively then loses return; durable intent fences activation and duplicate replay`, async () => {
    const f = fixture(),
      exec = SqliteDatabase.prototype.exec,
      prepare = SqliteDatabase.prototype.prepare,
      rename = fs.renameSync;
    let armed = false,
      fired = false;
    try {
      const before = f.snapshot(),
        p = f.planned();
      if (fault === 'schema-commit') {
        SqliteDatabase.prototype.prepare = function (this: SqliteDatabase, sql: string) {
          const statement = prepare.call(this, sql);
          if (sql.includes('INSERT INTO schema_migrations(version,applied_at) VALUES(2,')) {
            const run = statement.run;
            statement.run = function (this: SqliteStatement, ...args: any[]) {
              armed = true;
              return run.apply(this, args as any);
            };
          }
          return statement;
        } as typeof SqliteDatabase.prototype.prepare;
        SqliteDatabase.prototype.exec = function (this: SqliteDatabase, sql: string) {
          const result = exec.call(this, sql);
          if (sql === 'COMMIT' && armed && !fired) {
            fired = true;
            throw Error('Lost schema/floor commit return');
          }
          return result;
        };
      } else
        fs.renameSync = (from, to) => {
          const isReady =
            String(to) === f.paths.manifest &&
            JSON.parse(fs.readFileSync(from, 'utf8')).state === 'ready';
          rename(from, to);
          if (isReady && !fired) {
            fired = true;
            throw Error('Lost actual manifest rename return');
          }
        };
      await assert.rejects(f.apply(p), unknown);
      SqliteDatabase.prototype.prepare = prepare;
      SqliteDatabase.prototype.exec = exec;
      fs.renameSync = rename;
      assert.equal(fired, true);
      assert.equal(upgradeStatus(f.paths).state, 'unknown');
      if (fault === 'ready-rename') assert.throws(() => readRuntimeManifest(f.paths));
      else assert.equal(readRuntimeManifest(f.paths).state, 'preparing');
      await assert.rejects(
        startDaemon({
          paths: f.paths,
          config: loadRuntimeConfig(f.paths, {}),
          runners: {},
          environment: f.env,
        }),
      );
      assert.deepEqual(f.snapshot(), before);
      const files = fs.readdirSync(f.paths.backups);
      await assert.rejects(f.apply(p), unknown);
      assert.deepEqual(fs.readdirSync(f.paths.backups), files);
      assert.equal(files.length, 1);
    } finally {
      SqliteDatabase.prototype.prepare = prepare;
      SqliteDatabase.prototype.exec = exec;
      fs.renameSync = rename;
      f.sb.cleanup();
    }
  });
}
