import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, fresh } from './helpers.ts';
import { runtimePaths } from '../src/platform/paths.ts';
import { parseRuntimeConfig } from '../src/platform/config.ts';
import { setupRuntime } from '../src/app/setup.ts';
import { startDaemon } from '../src/app/daemon.ts';
import { main } from '../src/app/cli.ts';
import { DaemonOwner } from '../src/platform/daemon-owner.ts';
import { readRuntimeManifest } from '../src/platform/manifest.ts';
import {
  planInstallation,
  installationPlanHash,
  applyInstallation,
  undoInstallation,
  installationStatus,
  saveInstallationPlan,
  readInstallationPlan,
} from '../src/app/installation.ts';
import { BosunError } from '../src/core/errors.ts';
import { version } from '../src/platform/assets.ts';
import { callLocalRpc } from '../src/adapters/transport/local-rpc.ts';
import { diagnoseRuntime } from '../src/app/doctor.ts';

let serial = 0;
async function fixture() {
  const sb = sandbox();
  fresh(sb);
  const env = sb.env({
      BOSUN_SOCKET: path.join(process.env.BOSUN_TEST_RUN_ROOT!, `ins${process.pid}_${++serial}`),
    }),
    paths = runtimePaths(env),
    config = parseRuntimeConfig('[roles.worker.codex]\nmodel="gpt-6.1-sol"\neffort="high"\n');
  await setupRuntime(paths, config);
  const runtime = await startDaemon({ paths, config, runners: {}, environment: env });
  try {
    for (const privateNote of [false, true])
      await callLocalRpc({
        socket: paths.socket,
        request: {
          version: 1,
          id: privateNote ? 'private-install-note' : 'public-install-note',
          method: 'memory.store',
          params: {
            category: 'personal',
            title: privateNote ? 'Private original note' : 'Original package choice',
            body: privateNote ? 'Private retained original.' : 'Use pnpm original package choice.',
            private: privateNote,
          },
          scope: { workspace: sb.root, sessionId: null, audience: 'owner' },
        },
      });
  } finally {
    await runtime.close();
  }
  const source = path.join(sb.root, 'bosun-release');
  fs.writeFileSync(
    source,
    `#!/usr/bin/env node\nif(process.argv.slice(2).join(' ')!=='--version')process.exit(2);process.stdout.write(${JSON.stringify(version + '\n')});\n`,
    { mode: 0o755 },
  );
  const personal = path.join(sb.home, '.zshrc');
  fs.writeFileSync(personal, 'owner shell configuration\n');
  const options = { paths, env };
  return {
    sb,
    env,
    paths,
    config,
    source,
    options,
    personal,
    plan: (requestId = 'install', replaceExisting = false) =>
      planInstallation(options, { binary: source, requestId, replaceExisting }),
    close: () => sb.cleanup(),
  };
}
const code = (expected: string) => (error: unknown) =>
  error instanceof BosunError && error.code === expected;
function dataFootprint(paths: ReturnType<typeof runtimePaths>) {
  const files = [
    paths.memory,
    paths.view,
    paths.config,
    paths.hookConfig,
    paths.state,
    ...fs.readdirSync(paths.backups).map((name) => path.join(paths.backups, name)),
  ];
  return files.map((file) => ({
    file,
    ino: fs.statSync(file).ino,
    mode: fs.statSync(file).mode,
    bytes: fs.readFileSync(file),
  }));
}
test('reviewed installer copies the exact binary to a stable owner path, retains data/models, prepares a dormant plist and undoes only owned files', async () => {
  const f = await fixture();
  try {
    const before = dataFootprint(f.paths),
      manifest = fs.readFileSync(f.paths.manifest),
      plan = f.plan();
    assert.equal(plan.planHash, installationPlanHash(plan));
    assert.deepEqual(fs.readFileSync(f.paths.manifest), manifest);
    assert.deepEqual(f.sb.calls(), []);
    assert.equal(fs.existsSync(path.dirname(plan.targetBinary)), false);
    const file = path.join(f.sb.root, 'plan.json');
    saveInstallationPlan(file, plan);
    assert.deepEqual(readInstallationPlan(file), plan);
    assert.throws(() => saveInstallationPlan(file, plan));
    const applied = await applyInstallation(f.options, plan, plan.planHash, true);
    assert.equal(applied.record.state, 'ready');
    assert.equal(applied.record.service.state, 'prepared');
    assert.equal(fs.existsSync(plan.service.target), false);
    assert.deepEqual(fs.readFileSync(plan.targetBinary), fs.readFileSync(f.source));
    assert.equal(fs.statSync(plan.targetBinary).mode & 0o777, 0o755);
    assert.equal(fs.statSync(plan.service.file).mode & 0o777, 0o600);
    assert.ok(installationStatus(f.options).matches);
    const xml = fs.readFileSync(plan.service.file, 'utf8');
    assert.match(xml, /<integer>63<\/integer>/);
    assert.match(xml, /<key>KeepAlive<\/key><true\/>/);
    assert.match(xml, /<key>ExitTimeOut<\/key><integer>30/);
    assert.ok(!xml.includes('ANTHROPIC'));
    assert.ok(!xml.includes('CODEX_HOME'));
    assert.ok(xml.includes(f.paths.socket));
    assert.equal((await applyInstallation(f.options, plan, plan.planHash, true)).duplicate, true);
    const undone = undoInstallation(
      f.options,
      plan.id,
      applied.record.version,
      plan.planHash,
      true,
    );
    assert.equal(undone.record.state, 'undone');
    assert.equal(fs.existsSync(plan.targetBinary), false);
    assert.equal(fs.existsSync(path.join(f.env.HOME, '.local')), false);
    assert.deepEqual(dataFootprint(f.paths), before);
    assert.equal(fs.readFileSync(f.personal, 'utf8'), 'owner shell configuration\n');
    assert.equal(readRuntimeManifest(f.paths).installation!.state, 'undone');
  } finally {
    f.close();
  }
});
for (const kind of ['link', 'file'] as const)
  test(`explicit existing ${kind} replacement retains the original inode and restores it on exact undo`, async () => {
    const f = await fixture();
    try {
      const directory = path.join(f.sb.home, '.local', 'bin');
      fs.mkdirSync(directory, { recursive: true, mode: 0o755 });
      const target = path.join(directory, 'bosun');
      if (kind === 'link') fs.symlinkSync('/old/owner/bosun', target);
      else
        fs.writeFileSync(target, '#!/usr/bin/env node\n// original owner binary\n', {
          mode: 0o755,
        });
      const before = fs.lstatSync(target);
      const bytes = kind === 'file' ? fs.readFileSync(target) : null;
      assert.throws(() => f.plan(), code('conflict'));
      const plan = f.plan('replace', true);
      const applied = await applyInstallation(f.options, plan, plan.planHash, true);
      const backup = path.join(f.paths.home, 'installation', plan.id, 'previous-binary');
      assert.equal(fs.lstatSync(backup).ino, before.ino);
      undoInstallation(f.options, plan.id, applied.record.version, plan.planHash, true);
      assert.equal(fs.lstatSync(target).ino, before.ino);
      if (kind === 'link') assert.equal(fs.readlinkSync(target), '/old/owner/bosun');
      else assert.deepEqual(fs.readFileSync(target), bytes);
      assert.equal(fs.existsSync(directory), true);
    } finally {
      f.close();
    }
  });
test('Homebrew deployment references its stable opt path and never copies/removes the externally owned binary', async () => {
  const f = await fixture();
  try {
    const brew = path.join(f.sb.root, 'homebrew'),
      stable = path.join(brew, 'opt', 'bosun', 'bin', 'bosun');
    fs.mkdirSync(path.dirname(stable), { recursive: true, mode: 0o755 });
    fs.copyFileSync(f.source, stable);
    fs.chmodSync(stable, 0o755);
    const stat = fs.statSync(stable),
      before = fs.readFileSync(stable),
      options = { ...f.options, homebrewRoots: [brew] };
    const plan = planInstallation(options, {
      requestId: 'brew',
      binary: stable,
      distribution: 'homebrew',
    });
    assert.equal(plan.targetBinary, stable);
    assert.deepEqual(plan.directories, []);
    const applied = await applyInstallation(options, plan, plan.planHash, true);
    undoInstallation(options, plan.id, applied.record.version, plan.planHash, true);
    assert.equal(fs.statSync(stable).ino, stat.ino);
    assert.deepEqual(fs.readFileSync(stable), before);
    assert.deepEqual(f.sb.calls(), []);
  } finally {
    f.close();
  }
});
test('stale source/config/manifest, unsafe directories, edited daemon text and active authority refuse before installation intent', async () => {
  for (const change of [
    'source',
    'config',
    'manifest',
    'directory',
    'text',
    'owner',
    'stopped',
    'hash',
  ]) {
    const f = await fixture();
    let owner: DaemonOwner | undefined;
    try {
      const plan = f.plan(),
        before = fs.readFileSync(f.paths.manifest);
      if (change === 'source') fs.appendFileSync(f.source, '// drift\n');
      if (change === 'config') fs.appendFileSync(f.paths.config, '\n# drift\n');
      if (change === 'manifest') fs.appendFileSync(f.paths.manifest, '\n');
      if (change === 'directory') {
        fs.mkdirSync(path.join(f.sb.home, '.local'));
        fs.symlinkSync(f.sb.root, path.join(f.sb.home, '.local', 'bin'));
      }
      if (change === 'text') {
        plan.service.text = plan.service.text.replace(
          '<string>daemon</string>',
          '<string>unsafe</string>',
        );
        plan.service.hash = '0'.repeat(64);
        plan.planHash = installationPlanHash(plan);
      }
      if (change === 'owner') owner = new DaemonOwner(f.paths.owner);
      await assert.rejects(
        applyInstallation(
          f.options,
          plan,
          change === 'hash' ? '0'.repeat(64) : plan.planHash,
          change !== 'stopped',
        ),
      );
      assert.equal(fs.existsSync(path.join(f.paths.home, 'installation')), false);
      if (change !== 'manifest') assert.deepEqual(fs.readFileSync(f.paths.manifest), before);
    } finally {
      owner?.close();
      f.close();
    }
  }
});
test('edited installed bytes, original backup and unrelated files are preserved; unknown receipts cannot replay apply or undo', async () => {
  const f = await fixture();
  try {
    const plan = f.plan();
    const applied = await applyInstallation(f.options, plan, plan.planHash, true);
    fs.appendFileSync(plan.targetBinary, '// owner edit\n');
    const before = fs.readFileSync(plan.targetBinary),
      manifest = fs.readFileSync(f.paths.manifest);
    assert.throws(() =>
      undoInstallation(f.options, plan.id, applied.record.version, plan.planHash, true),
    );
    assert.deepEqual(fs.readFileSync(plan.targetBinary), before);
    assert.deepEqual(fs.readFileSync(f.paths.manifest), manifest);
    assert.equal(installationStatus(f.options).matches, false);
  } finally {
    f.close();
  }
});
test('actual ready manifest rename with a lost return fences activation and does not repeat the binary copy', async () => {
  const f = await fixture();
  const original = fs.renameSync;
  let copiedInode: number | undefined;
  try {
    const plan = f.plan();
    let lost = false;
    fs.renameSync = function (from, to) {
      const result = original(from, to);
      if (String(to) === f.paths.manifest && !lost) {
        const metadata = JSON.parse(fs.readFileSync(f.paths.manifest, 'utf8'));
        if (metadata.installation?.state === 'ready') {
          lost = true;
          copiedInode = fs.statSync(plan.targetBinary).ino;
          throw Error('lost ready rename return');
        }
      }
      return result;
    };
    await assert.rejects(
      applyInstallation(f.options, plan, plan.planHash, true),
      (error) => error instanceof BosunError && error.details?.outcome === 'unknown',
    );
    fs.renameSync = original;
    assert.equal(installationStatus(f.options).state, 'unknown');
    assert.throws(() => readRuntimeManifest(f.paths));
    await assert.rejects(applyInstallation(f.options, plan, plan.planHash, true));
    assert.equal(fs.statSync(plan.targetBinary).ino, copiedInode);
  } finally {
    fs.renameSync = original;
    f.close();
  }
});
test('actual CLI plan/apply/status/undo uses the same reviewed contract and denies model callers before changes', async () => {
  const f = await fixture();
  try {
    const file = path.join(f.sb.root, 'cli-plan.json'),
      out: string[] = [];
    const invoke = (argv: string[], env = f.env) =>
      main(argv, { env, cwd: f.sb.root, stdout: (text) => out.push(text), stderr() {} });
    assert.equal(
      await invoke([
        'install',
        'plan',
        '--binary',
        f.source,
        '--request-id',
        'cli',
        '--output',
        file,
      ]),
      0,
    );
    const plan = JSON.parse(out.pop()!);
    assert.equal(
      await invoke(['install', 'apply', file, '--hash', plan.planHash, '--clients-stopped']),
      0,
    );
    const applied = JSON.parse(out.pop()!);
    assert.equal(await invoke(['install', 'status']), 0);
    assert.equal(JSON.parse(out.pop()!).matches, true);
    assert.notEqual(
      await invoke(
        [
          'install',
          'undo',
          plan.id,
          '--version',
          String(applied.record.version),
          '--hash',
          plan.planHash,
          '--clients-stopped',
        ],
        { ...f.env, BOSUN_CALLER: 'model' },
      ),
      0,
    );
    assert.equal(
      await invoke([
        'install',
        'undo',
        plan.id,
        '--version',
        String(applied.record.version),
        '--hash',
        plan.planHash,
        '--clients-stopped',
      ]),
      0,
    );
    assert.equal(JSON.parse(out.pop()!).retainedData, true);
  } finally {
    f.close();
  }
});
test('edited original backups and directory permissions refuse undo; unrelated new files survive removal of the owned executable', async () => {
  for (const change of ['backup', 'directory', 'unrelated']) {
    const f = await fixture();
    try {
      const target = path.join(f.sb.home, '.local', 'bin', 'bosun');
      if (change === 'backup') {
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
        fs.writeFileSync(target, '#!/usr/bin/env node\n// retain old\n', { mode: 0o755 });
      }
      const plan = f.plan(change, change === 'backup'),
        applied = await applyInstallation(f.options, plan, plan.planHash, true);
      if (change === 'backup')
        fs.appendFileSync(
          path.join(f.paths.home, 'installation', plan.id, 'previous-binary'),
          '// owner changed backup\n',
        );
      if (change === 'directory') fs.chmodSync(path.dirname(target), 0o700);
      const unrelated = path.join(path.dirname(target), 'owner-tool');
      if (change === 'unrelated') fs.writeFileSync(unrelated, 'owner tool\n');
      const manifest = fs.readFileSync(f.paths.manifest);
      if (change === 'unrelated') {
        undoInstallation(f.options, plan.id, applied.record.version, plan.planHash, true);
        assert.equal(fs.existsSync(target), false);
        assert.equal(fs.readFileSync(unrelated, 'utf8'), 'owner tool\n');
      } else {
        assert.throws(() =>
          undoInstallation(f.options, plan.id, applied.record.version, plan.planHash, true),
        );
        assert.deepEqual(fs.readFileSync(f.paths.manifest), manifest);
        assert.equal(fs.existsSync(target), true);
      }
    } finally {
      f.close();
    }
  }
});
test('rebound user home and a forged receipt cannot redirect installer writes or undo an unowned executable', async () => {
  const f = await fixture();
  try {
    const plan = f.plan(),
      oldHome = f.sb.home + '.old';
    fs.renameSync(f.sb.home, oldHome);
    fs.mkdirSync(f.sb.home, { mode: 0o700 });
    // Keep the prepared runtime independently available; only the enclosing user home changes identity.
    fs.renameSync(path.join(oldHome, '.bosun'), f.paths.home);
    await assert.rejects(applyInstallation(f.options, plan, plan.planHash, true), code('conflict'));
    assert.equal(fs.existsSync(path.join(f.sb.home, '.local')), false);
  } finally {
    f.close();
  }
  const g = await fixture();
  try {
    const plan = g.plan(),
      applied = await applyInstallation(g.options, plan, plan.planHash, true),
      foreign = path.join(g.sb.root, 'foreign-binary');
    fs.copyFileSync(g.source, foreign);
    fs.chmodSync(foreign, 0o755);
    const before = fs.readFileSync(foreign);
    const manifest = JSON.parse(fs.readFileSync(g.paths.manifest, 'utf8'));
    manifest.installation.targetBinary = foreign;
    manifest.installation.installed = { ...manifest.installation.installed, path: foreign };
    fs.writeFileSync(g.paths.manifest, JSON.stringify(manifest));
    assert.throws(
      () => undoInstallation(g.options, plan.id, applied.record.version, plan.planHash, true),
      code('conflict'),
    );
    assert.deepEqual(fs.readFileSync(foreign), before);
    assert.equal(fs.existsSync(plan.targetBinary), true);
  } finally {
    g.close();
  }
});
test('wrong executable version and source mutation during the version probe preserve manifest and install destinations', async () => {
  for (const change of ['version', 'during-probe']) {
    const f = await fixture();
    try {
      const script =
        change === 'version'
          ? `process.stdout.write('99.0.0\\n');`
          : `require('node:fs').appendFileSync(__filename,'// drift\\n');process.stdout.write(${JSON.stringify(version + '\n')});`;
      fs.writeFileSync(f.source, '#!/usr/bin/env node\n' + script + '\n');
      const plan = f.plan(change),
        before = fs.readFileSync(f.paths.manifest);
      await assert.rejects(applyInstallation(f.options, plan, plan.planHash, true));
      assert.deepEqual(fs.readFileSync(f.paths.manifest), before);
      assert.equal(fs.existsSync(plan.targetBinary), false);
      assert.equal(fs.existsSync(path.join(f.paths.home, 'installation')), false);
    } finally {
      f.close();
    }
  }
});
test('lost actual undo rename retains original receipts and data; a second undo cannot replay restoration', async () => {
  const f = await fixture(),
    original = fs.renameSync;
  try {
    const plan = f.plan(),
      applied = await applyInstallation(f.options, plan, plan.planHash, true),
      before = dataFootprint(f.paths);
    let lost = false;
    fs.renameSync = function (from, to) {
      const result = original(from, to);
      if (String(from) === plan.targetBinary && !lost) {
        lost = true;
        throw Error('lost native undo rename return');
      }
      return result;
    };
    assert.throws(
      () => undoInstallation(f.options, plan.id, applied.record.version, plan.planHash, true),
      (error) => error instanceof BosunError && error.details?.outcome === 'unknown',
    );
    fs.renameSync = original;
    const status = installationStatus(f.options);
    assert.equal(status.state, 'unknown');
    assert.equal(fs.existsSync(plan.targetBinary), false);
    assert.throws(() =>
      undoInstallation(f.options, plan.id, status.record!.version, plan.planHash, true),
    );
    assert.deepEqual(dataFootprint(f.paths), before);
  } finally {
    fs.renameSync = original;
    f.close();
  }
});
test('doctor detects installed file drift through filesystem checks without opening memory or executing services', async () => {
  const f = await fixture();
  try {
    const plan = f.plan();
    await applyInstallation(f.options, plan, plan.planHash, true);
    const before = dataFootprint(f.paths);
    const ready = diagnoseRuntime(f.options);
    assert.equal(ready.checks.find((check) => check.id === 'installation.files')!.state, 'ready');
    assert.equal(ready.nativeCalls, false);
    assert.equal(ready.databaseOpened, false);
    fs.appendFileSync(plan.targetBinary, '// owner edit\n');
    const held = diagnoseRuntime(f.options);
    assert.equal(held.checks.find((check) => check.id === 'installation.files')!.state, 'held');
    assert.equal(held.prepared, false);
    assert.deepEqual(dataFootprint(f.paths), before);
    assert.deepEqual(f.sb.calls(), []);
  } finally {
    f.close();
  }
});
test('retained installation capacity repeats under native admission before any new intent or external effect', async () => {
  const f = await fixture();
  try {
    const plan = f.plan(),
      before = fs.readFileSync(f.paths.manifest),
      container = path.join(f.paths.home, 'installation');
    fs.mkdirSync(container, { mode: 0o700 });
    for (let n = 0; n < 64; n++)
      fs.mkdirSync(path.join(container, 'retained-' + n), { mode: 0o700 });
    await assert.rejects(
      applyInstallation(f.options, plan, plan.planHash, true),
      code('unavailable'),
    );
    assert.deepEqual(fs.readFileSync(f.paths.manifest), before);
    assert.equal(fs.existsSync(plan.targetBinary), false);
    assert.equal(fs.readdirSync(container).length, 64);
    assert.throws(() => f.plan('fresh'), code('unavailable'));
  } finally {
    f.close();
  }
});
