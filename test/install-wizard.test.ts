import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, fresh } from './helpers.ts';
import { runtimePaths } from '../src/platform/paths.ts';
import { parseRuntimeConfig } from '../src/platform/config.ts';
import { version } from '../src/platform/assets.ts';
import { setupRuntime } from '../src/app/setup.ts';
import { installationStatus } from '../src/app/installation.ts';
import { runInstallWizard, type InstallWizardOptions } from '../src/app/install-wizard.ts';

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
  const run = (accept: (kind: typeof questions[number]['kind']) => boolean) => runInstallWizard({
    paths, env, binary,
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

test('declining preparation leaves the absent home and user installation untouched', async () => {
  const f = fixture();
  try {
    const before = footprint(f.sb.home);
    const result = await f.run(() => false);
    assert.equal(result.state, 'cancelled');
    assert.deepEqual(f.questions.map(q => q.kind), ['setup']);
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
    assert.deepEqual(f.questions.map(q => q.kind), ['setup', 'install', 'start']);
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
    assert.deepEqual(f.questions.map(q => q.kind), ['start']);
    assert.deepEqual(footprint(f.paths.home), before);
    assert.deepEqual(footprint(path.join(f.sb.home, '.local', 'bin', 'bosun')), binaryBefore);
    assert.deepEqual(f.sb.calls(), []);
  } finally { f.sb.cleanup(); }
});

for (const kind of ['nonempty', 'public', 'symlink'] as const)
  test(`unprepared ${kind} home is held without prompts or mutation`, async () => {
    const f = fixture();
    try {
      if (kind === 'symlink') fs.symlinkSync(f.sb.root, f.paths.home);
      else {
        fs.mkdirSync(f.paths.home, { mode: kind === 'public' ? 0o755 : 0o700 });
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
    assert.deepEqual(f.questions.map(q => q.kind), ['replace']);
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
    assert.deepEqual(f.questions.map(q => q.kind), ['install']);
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
    assert.deepEqual(f.questions.map(q => q.kind), ['replace', 'install', 'start']);
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
