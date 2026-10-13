import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SqliteDatabase } from '../src/platform/sqlite.ts';
import { sandbox, fresh } from './helpers.ts';
import { runtimePaths } from '../src/platform/paths.ts';
import { parseRuntimeConfig } from '../src/platform/config.ts';
import { setupRuntime } from '../src/app/setup.ts';
import { diagnoseRuntime } from '../src/app/doctor.ts';
import { diagnoseSqlite, diagnoseFile } from '../src/platform/diagnostics.ts';
import { main } from '../src/app/cli.ts';
import { planHostInstallation, applyHostInstallation } from '../src/app/host-install.ts';

function tree(root: string) {
  const files: Record<string, unknown> = {};
  if (!fs.existsSync(root)) return files;
  function walk(dir: string) {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      const stat = fs.lstatSync(file, { bigint: true });
      files[path.relative(root, file)] = {
        mode: stat.mode,
        ino: stat.ino,
        mtime: stat.mtimeNs,
        ctime: stat.ctimeNs,
        bytes: stat.isFile() ? fs.readFileSync(file) : null,
        link: stat.isSymbolicLink() ? fs.readlinkSync(file) : null,
      };
      if (stat.isDirectory()) walk(file);
    }
  }
  walk(root);
  return files;
}
function fixture() {
  const sb = sandbox({ stubs: ['bosun'] });
  fresh(sb);
  const env = sb.env();
  return { sb, env, paths: runtimePaths(env), config: parseRuntimeConfig('', env) };
}
async function cli(env: Record<string, string>, args = ['doctor']) {
  let out = '',
    err = '';
  const code = await main(args, {
    env,
    cwd: env.HOME,
    stdout: (text) => (out += text),
    stderr: (text) => (err += text),
  });
  return { code, out, err };
}

test('empty doctor reports missing preparation without creating a home, database, config or native process', async () => {
  const f = fixture();
  try {
    const before = tree(f.sb.root);
    const result = await cli(f.env);
    assert.equal(result.code, 1);
    const report = JSON.parse(result.out);
    assert.equal(report.prepared, false);
    assert.equal(report.coverage, 'filesystem-metadata');
    assert.equal(report.databaseOpened, false);
    assert.equal(report.nativeCalls, false);
    assert.deepEqual(tree(f.sb.root), before);
    assert.equal(fs.existsSync(f.paths.home), false);
    assert.equal(f.sb.calls().length, 0);
  } finally {
    f.sb.cleanup();
  }
});

test('prepared runtime diagnostics preserve IDs, modes, bytes and WAL sidecars while reporting native/schema qualification honestly', async () => {
  const f = fixture();
  try {
    const manifest = await setupRuntime(f.paths, f.config);
    const before = tree(f.paths.home);
    const report = diagnoseRuntime(f);
    assert.equal(report.prepared, true, JSON.stringify(report));
    assert.equal(report.schemaQualification, 'unverified');
    assert.ok(
      report.checks
        .find((check) => check.id === 'memory.database')
        ?.detail.includes('schema not verified'),
    );
    assert.ok(
      report.checks
        .filter((check) => check.id.startsWith('host.'))
        .every((check) => check.state === 'unverified' || check.state === 'missing'),
    );
    assert.deepEqual(tree(f.paths.home), before);
    assert.equal(JSON.parse(fs.readFileSync(f.paths.manifest, 'utf8')).sourceId, manifest.sourceId);
    assert.equal(f.sb.calls().length, 0);
    const changed = diagnoseRuntime({
      paths: f.paths,
      env: { ...f.env, BOSUN_HANDOFF_THRESHOLD: '0.6' },
    });
    assert.equal(changed.prepared, false);
    assert.equal(changed.checks.find((check) => check.id === 'hook.snapshot')?.state, 'held');
    assert.deepEqual(tree(f.paths.home), before);
    const result = await cli(f.env);
    assert.equal(result.code, 0, result.err);
    assert.deepEqual(tree(f.paths.home), before);
  } finally {
    f.sb.cleanup();
  }
});

test('SQLite diagnostics never recover a journal or create shared memory, including live WAL and corrupt files', () => {
  const f = fixture();
  try {
    fs.mkdirSync(f.paths.home, { mode: 0o700 });
    const file = path.join(f.paths.home, 'sample.db');
    const db = new SqliteDatabase(file);
    fs.chmodSync(file, 0o600);
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE x(id); INSERT INTO x VALUES(1)');
    try {
      const before = tree(f.paths.home);
      const report = diagnoseSqlite(file);
      assert.equal(report.state, 'wal_present');
      assert.equal(report.schema, null);
      assert.deepEqual(tree(f.paths.home), before);
      fs.chmodSync(file + '-wal', 0o644);
      const exposed = tree(f.paths.home);
      assert.equal(diagnoseSqlite(file).state, 'unsafe');
      assert.deepEqual(tree(f.paths.home), exposed);
      fs.chmodSync(file + '-wal', 0o600);
    } finally {
      db.close();
    }
    const reader = new SqliteDatabase(file);
    reader.exec('PRAGMA journal_mode=DELETE; PRAGMA user_version=7');
    reader.close();
    const before = tree(f.paths.home);
    assert.deepEqual(diagnoseSqlite(file), {
      state: 'header_only',
      schema: 7,
      schemaQualification: 'unverified',
    });
    assert.deepEqual(tree(f.paths.home), before);
    const foreign = path.join(f.sb.home, 'foreign-wal');
    fs.writeFileSync(foreign, 'journal canary', { mode: 0o600 });
    fs.symlinkSync(foreign, file + '-wal');
    const rebound = tree(f.paths.home);
    assert.equal(diagnoseSqlite(file).state, 'unsafe');
    assert.deepEqual(tree(f.paths.home), rebound);
    fs.unlinkSync(file + '-wal');
    fs.writeFileSync(file + '-journal', 'journal canary', { mode: 0o600 });
    const journal = tree(f.paths.home);
    assert.equal(diagnoseSqlite(file).state, 'journal_present');
    assert.equal(diagnoseSqlite(file).schema, null);
    assert.deepEqual(tree(f.paths.home), journal);
    fs.unlinkSync(file + '-journal');
    fs.writeFileSync(file, 'corrupt', { mode: 0o600 });
    const corrupt = tree(f.paths.home);
    assert.equal(diagnoseSqlite(file).state, 'header_invalid');
    assert.deepEqual(tree(f.paths.home), corrupt);
  } finally {
    f.sb.cleanup();
  }
});

test('unsafe runtime parents and rebounded files are held before foreign payload reads', async () => {
  const f = fixture();
  const original = fs.readFileSync;
  try {
    const foreign = path.join(f.sb.home, 'foreign');
    fs.mkdirSync(foreign, { mode: 0o700 });
    fs.writeFileSync(path.join(foreign, 'config.toml'), 'private foreign payload', { mode: 0o600 });
    fs.symlinkSync(foreign, f.paths.home);
    let reads = 0;
    fs.readFileSync = function (file: fs.PathOrFileDescriptor, ...args: any[]) {
      if (String(file).startsWith(foreign + path.sep)) {
        reads++;
        throw Error('foreign read');
      }
      return (original as any)(file, ...args);
    } as typeof fs.readFileSync;
    const report = diagnoseRuntime(f);
    assert.equal(report.prepared, false);
    assert.equal(report.checks[0].state, 'held');
    assert.equal(reads, 0);
    assert.equal(diagnoseFile(path.join(foreign, 'config.toml'), 'file').state, 'safe');
    fs.chmodSync(path.join(foreign, 'config.toml'), 0o644);
    assert.equal(diagnoseFile(path.join(foreign, 'config.toml'), 'file').state, 'unsafe');
  } finally {
    fs.readFileSync = original;
    f.sb.cleanup();
  }
});

test('model and malformed doctor commands refuse before path/config getters or storage effects', async () => {
  const f = fixture();
  try {
    const env = {
      ...f.env,
      BOSUN_CALLER: 'model',
      get BOSUN_HOME(): string {
        throw Error('must not read');
      },
    };
    const denied = await cli(env);
    assert.equal(denied.code, 1);
    assert.equal(JSON.parse(denied.err).error.code, 'unsupported');
    assert.equal(denied.out, '');
    const before = tree(f.sb.root);
    const bad = await cli(f.env, ['doctor', '--repair']);
    assert.equal(bad.code, 2);
    assert.deepEqual(tree(f.sb.root), before);
  } finally {
    f.sb.cleanup();
  }
});

test('changed profiles, invalid manifests and stale hook bindings are held with finite metadata and no repair', async () => {
  const f = fixture();
  try {
    await setupRuntime(f.paths, f.config);
    const plan = await planHostInstallation(
      { ...f, binary: path.join(f.sb.bin, 'bosun') },
      { hostId: 'opencode', nativeVersion: '2.0.27', requestId: 'doctor-profile' },
    );
    const installed = await applyHostInstallation(
      { ...f, binary: path.join(f.sb.bin, 'bosun') }, plan, plan.planHash,
    );
    const target = path.join(installed.root, 'shared', 'policy.md');
    fs.appendFileSync(target, 'private changed canary');
    const before = tree(f.paths.home);
    const report = diagnoseRuntime(f);
    assert.equal(report.prepared, false);
    assert.equal(
      report.checks.find((check) => check.id === `profile.${installed.record.id}`)?.state,
      'held',
    );
    assert.doesNotMatch(JSON.stringify(report), /private changed canary/);
    assert.deepEqual(tree(f.paths.home), before);
    const hook = JSON.parse(fs.readFileSync(f.paths.hookConfig, 'utf8'));
    hook.configRevision = '0'.repeat(64);
    fs.writeFileSync(f.paths.hookConfig, JSON.stringify(hook), { mode: 0o600 });
    assert.equal(
      diagnoseRuntime(f).checks.find((check) => check.id === 'hook.snapshot')?.state,
      'held',
    );
    fs.writeFileSync(f.paths.manifest, '{"invalid":true}', { mode: 0o600 });
    const invalid = tree(f.paths.home);
    assert.equal(
      diagnoseRuntime(f).checks.find((check) => check.id === 'runtime.manifest')?.state,
      'held',
    );
    assert.deepEqual(tree(f.paths.home), invalid);
  } finally {
    f.sb.cleanup();
  }
});
