import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, fresh } from './helpers.ts';
import { runtimePaths } from '../src/platform/paths.ts';
import { loadRuntimeConfig, parseRuntimeConfig } from '../src/platform/config.ts';
import { version } from '../src/platform/assets.ts';
import { setupRuntime } from '../src/app/setup.ts';
import { installationStatus } from '../src/app/installation.ts';
import { runInstallWizard, type InstallWizardOptions } from '../src/app/install-wizard.ts';
import { startDaemon } from '../src/app/daemon.ts';
import { callLocalRpc } from '../src/adapters/transport/local-rpc.ts';
import type { RuntimePaths } from '../src/platform/paths.ts';
import type { Env } from '../src/core/domain/inference.ts';
import { retireInstallation } from '../src/app/installation-lifecycle.ts';

let serial = 0;
function fixture() {
  const sb = sandbox();
  fresh(sb);
  const env = sb.env({ BOSUN_SOCKET: path.join(process.env.BOSUN_TEST_RUN_ROOT!, `wiz${process.pid}_${++serial}`) });
  const paths = runtimePaths(env);
  const binary = path.join(sb.root, 'qualified-release');
  fs.writeFileSync(binary, `#!/usr/bin/env node\nif(process.argv.slice(2).join(' ')!=='--version')process.exit(2);process.stdout.write(${JSON.stringify(version + '\n')});\n`, { mode: 0o755 });
  const questions: Parameters<InstallWizardOptions['confirm']>[0][] = [];
  let output = '';
  const run = (accept: (kind: typeof questions[number]['kind']) => boolean, selectedBinary = binary) => runInstallWizard({
    paths, env, binary: selectedBinary,
    confirm: async (question) => { questions.push(question); return accept(question.kind); },
    write: (text) => { output += text; },
  });
  return { sb, env, paths, binary, questions, run, output: () => output };
}
function footprint(root: string): unknown {
  if (!fs.existsSync(root)) return null;
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink()) return { mode: stat.mode, ino: stat.ino, link: fs.readlinkSync(root) };
  if (stat.isDirectory()) return { mode: stat.mode, ino: stat.ino, entries: fs.readdirSync(root).sort().map(name => [name, footprint(path.join(root, name))]) };
  return { mode: stat.mode, ino: stat.ino, bytes: fs.readFileSync(root) };
}

async function seedPrivateNote(paths: RuntimePaths, env: Env, workspace: string): Promise<void> {
  const runtime = await startDaemon({ paths, environment: env, config: loadRuntimeConfig(paths, env), runners: {} });
  try {
    await callLocalRpc({ socket: paths.socket, request: {
      version: 1, id: 'seed-owner-note', method: 'memory.store',
      params: { category: 'personal', title: 'Retained owner note', body: 'Existing private content survives executable lifecycle changes.', private: true },
      scope: { workspace, sessionId: null, audience: 'owner' },
    } });
  } finally { await runtime.close(); }
}

test('declining preparation leaves the absent home and user installation untouched', async () => {
  const f = fixture();
  try {
    const before = footprint(f.sb.home);
    const result = await f.run(() => false);
    assert.equal(result.state, 'cancelled');
    assert.deepEqual(footprint(f.sb.home), before);
    assert.equal(fs.existsSync(f.paths.home), false);
    assert.deepEqual(f.sb.calls(), []);
  } finally { f.sb.cleanup(); }
});

test('new installation applies the qualified release and durable receipt only after explicit approvals', async () => {
  const f = fixture();
  try {
    const result = await f.run(kind => kind !== 'start');
    assert.equal(result.state, 'ready');
    assert.equal(result.service, 'prepared');
    assert.equal(f.questions.find(q => q.kind === 'start')!.initialValue, false);
    const status = installationStatus({ paths: f.paths, env: f.env });
    assert.equal(status.matches, true);
    assert.equal(status.record!.state, 'ready');
    assert.equal(status.record!.service.state, 'prepared');
    assert.deepEqual(fs.readFileSync(result.binary!), fs.readFileSync(f.binary));
    assert.equal(fs.existsSync(status.record!.service.target), false);
    assert.deepEqual(f.sb.calls(), []);
  } finally { f.sb.cleanup(); }
});

test('ready home retains exact configuration and matching installed files on repeated wizard use', async () => {
  const f = fixture();
  try {
    const config = parseRuntimeConfig('[roles.worker.codex]\nmodel="owner-selected-model"\neffort="high"\n', f.env);
    await setupRuntime(f.paths, config);
    const configBefore = footprint(f.paths.config);
    await f.run(kind => kind !== 'start');
    assert.deepEqual(footprint(f.paths.config), configBefore);
    const before = footprint(f.paths.home);
    const binaryBefore = footprint(path.join(f.sb.home, '.local', 'bin', 'bosun'));
    f.questions.length = 0;
    assert.equal((await f.run(() => false)).state, 'ready');
    assert.deepEqual(footprint(f.paths.home), before);
    assert.deepEqual(footprint(path.join(f.sb.home, '.local', 'bin', 'bosun')), binaryBefore);
    assert.deepEqual(f.sb.calls(), []);
  } finally { f.sb.cleanup(); }
});

for (const kind of ['nonempty', 'symlink'] as const)
  test(`unprepared ${kind} home is held without mutation`, async () => {
    const f = fixture();
    try {
      if (kind === 'symlink') fs.symlinkSync(f.sb.root, f.paths.home);
      else {
        fs.mkdirSync(f.paths.home, { mode: 0o700 });
        if (kind === 'nonempty') fs.writeFileSync(path.join(f.paths.home, 'owner-data'), 'retain me', { mode: 0o600 });
      }
      const before = footprint(f.sb.home);
      assert.equal((await f.run(() => true)).state, 'held');
      assert.deepEqual(f.questions, []);
      assert.deepEqual(footprint(f.sb.home), before);
      assert.deepEqual(f.sb.calls(), []);
    } finally { f.sb.cleanup(); }
  });

test('declining separate replacement approval retains unmanaged executable and ready data', async () => {
  const f = fixture();
  try {
    await setupRuntime(f.paths, parseRuntimeConfig('', f.env));
    const target = path.join(f.sb.home, '.local', 'bin', 'bosun');
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
    fs.writeFileSync(target, 'owner unmanaged executable\n', { mode: 0o755 });
    const before = footprint(f.sb.home);
    assert.equal((await f.run(kind => kind !== 'replace')).state, 'cancelled');
    assert.deepEqual(footprint(f.sb.home), before);
    assert.deepEqual(f.sb.calls(), []);
  } finally { f.sb.cleanup(); }
});

test('declining install on a ready home writes no plan or installation receipt', async () => {
  const f = fixture();
  try {
    await setupRuntime(f.paths, parseRuntimeConfig('', f.env));
    const before = footprint(f.sb.home);
    assert.equal((await f.run(() => false)).state, 'cancelled');
    assert.deepEqual(footprint(f.sb.home), before);
    assert.equal(installationStatus({ paths: f.paths, env: f.env }).record, null);
  } finally { f.sb.cleanup(); }
});

for (const state of ['unknown', 'drifted'] as const)
  test(`wizard holds ${state} installed state without reinstalling or altering retained data`, async () => {
    const f = fixture();
    try {
      await f.run(kind => kind !== 'start');
      const status = installationStatus({ paths: f.paths, env: f.env });
      if (state === 'unknown') {
        const manifest = JSON.parse(fs.readFileSync(f.paths.manifest, 'utf8'));
        manifest.installation.state = 'unknown';
        manifest.installation.version++;
        fs.writeFileSync(f.paths.manifest, JSON.stringify(manifest), { mode: 0o600 });
      } else fs.appendFileSync(status.record!.targetBinary, '// owner edit\n');
      const before = footprint(f.sb.home);
      f.questions.length = 0;
      for (let n = 0; n < 2; n++) assert.equal((await f.run(() => true)).state, 'held');
      assert.deepEqual(f.questions, []);
      assert.deepEqual(footprint(f.sb.home), before);
      assert.deepEqual(f.sb.calls(), []);
    } finally { f.sb.cleanup(); }
  });

test('approved unmanaged replacement keeps original bytes in the receipt-bound backup', async () => {
  const f = fixture();
  try {
    await setupRuntime(f.paths, parseRuntimeConfig('', f.env));
    const target = path.join(f.sb.home, '.local', 'bin', 'bosun');
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
    fs.writeFileSync(target, 'owner executable before replacement\n', { mode: 0o755 });
    const before = footprint(target);
    const result = await f.run(kind => kind !== 'start');
    assert.equal(result.state, 'ready');
    const receipt = installationStatus({ paths: f.paths, env: f.env }).record!;
    assert.equal(receipt.state, 'ready');
    assert.deepEqual(footprint(path.join(f.paths.home, 'installation', receipt.id, 'previous-binary')), before);
    assert.deepEqual(fs.readFileSync(target), fs.readFileSync(f.binary));
  } finally { f.sb.cleanup(); }
});

test('preparing manifest remains held rather than initializing existing data again', async () => {
  const f = fixture();
  try {
    await setupRuntime(f.paths, parseRuntimeConfig('', f.env));
    const manifest = JSON.parse(fs.readFileSync(f.paths.manifest, 'utf8'));
    manifest.state = 'preparing';
    fs.writeFileSync(f.paths.manifest, JSON.stringify(manifest), { mode: 0o600 });
    const before = footprint(f.sb.home);
    assert.equal((await f.run(() => true)).state, 'held');
    assert.deepEqual(f.questions, []);
    assert.deepEqual(footprint(f.sb.home), before);
    assert.deepEqual(f.sb.calls(), []);
  } finally { f.sb.cleanup(); }
});

test('reinstall from the running installed path preserves configuration/database bytes and original recovery evidence', async () => {
  const f = fixture();
  try {
    await setupRuntime(f.paths, parseRuntimeConfig('[roles.worker.codex]\nmodel="owner-selected-model"\neffort="high"\n', f.env));
    assert.equal((await f.run(kind => kind !== 'start')).state, 'ready');
    const old = installationStatus({ paths: f.paths, env: f.env }).record!;
    await seedPrivateNote(f.paths, f.env, f.sb.root);
    const retained = [f.paths.config, f.paths.memory, f.paths.state].map(file => [file, fs.readFileSync(file)] as const);
    const oldPlan = fs.readFileSync(path.join(f.paths.home, 'installation', old.id, 'plan.json'));
    const result = await f.run(kind => kind !== 'start', old.targetBinary);
    assert.equal(result.state, 'ready');
    const next = installationStatus({ paths: f.paths, env: f.env });
    assert.equal(next.matches, true);
    assert.notEqual(next.record!.id, old.id);
    for (const [file, bytes] of retained) assert.deepEqual(fs.readFileSync(file), bytes);
    assert.deepEqual(fs.readFileSync(path.join(f.paths.home, 'installation', old.id, 'plan.json')), oldPlan);
    assert.deepEqual(fs.readFileSync(path.join(f.paths.home, 'installation', old.id, 'removed-binary')), fs.readFileSync(f.binary));
  } finally { f.sb.cleanup(); }
});

test('guided uninstall restores reviewed previous bytes but retains memory/configuration and refuses a second removal', async () => {
  const f = fixture();
  try {
    await setupRuntime(f.paths, parseRuntimeConfig('', f.env));
    const target = path.join(f.sb.home, '.local', 'bin', 'bosun');
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
    fs.writeFileSync(target, 'owner previous executable\n', { mode: 0o755 });
    const previous = footprint(target);
    assert.equal((await f.run(kind => kind !== 'start')).state, 'ready');
    await seedPrivateNote(f.paths, f.env, f.sb.root);
    const retained = [f.paths.config, f.paths.memory, f.paths.state].map(file => [file, fs.readFileSync(file)] as const);
    const options = { paths: f.paths, env: f.env, confirm: async () => true, write() {} };
    assert.equal(await retireInstallation(options, 'uninstall'), true);
    assert.deepEqual(footprint(target), previous);
    for (const [file, bytes] of retained) assert.deepEqual(fs.readFileSync(file), bytes);
    const before = footprint(f.paths.home);
    await assert.rejects(() => retireInstallation(options, 'uninstall'));
    assert.deepEqual(footprint(f.paths.home), before);
  } finally { f.sb.cleanup(); }
});

test('empty owned public runtime directory is restricted only after separate permission approval', async () => {
  const f = fixture();
  try {
    fs.mkdirSync(f.paths.home, { mode: 0o755 });
    const before = footprint(f.sb.home);
    assert.equal((await f.run(() => false)).state, 'cancelled');
    assert.deepEqual(footprint(f.sb.home), before);
    assert.equal((await f.run(kind => kind !== 'start')).state, 'ready');
    assert.equal(fs.lstatSync(f.paths.home).mode & 0o777, 0o700);
    assert.equal(installationStatus({ paths: f.paths, env: f.env }).matches, true);
  } finally { f.sb.cleanup(); }
});

test('an incompatible replacement executable is rejected before the owned installation is retired', async () => {
  const f = fixture();
  try {
    assert.equal((await f.run(kind => kind !== 'start')).state, 'ready');
    const original = installationStatus({ paths: f.paths, env: f.env }).record!;
    const targetBefore = footprint(original.targetBinary);
    fs.writeFileSync(f.binary, '#!/usr/bin/env node\nprocess.stdout.write("99.0.0\\n");\n', { mode: 0o755 });
    assert.equal((await f.run(kind => kind !== 'start')).state, 'held');
    const after = installationStatus({ paths: f.paths, env: f.env });
    assert.equal(after.matches, true);
    assert.deepEqual(after.record, original);
    assert.deepEqual(footprint(original.targetBinary), targetBefore);
    assert.equal(fs.existsSync(path.join(f.paths.home, 'installation', original.id, 'removed-binary')), false);
  } finally { f.sb.cleanup(); }
});
