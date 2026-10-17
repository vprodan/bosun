import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, bosun } from './helpers.ts';
import { setupRuntime } from '../src/app/setup.ts';
import { defaultConfig } from '../src/core/domain/config.ts';
import { runtimePaths } from '../src/platform/paths.ts';
import { planInstallation, applyInstallation } from '../src/app/installation.ts';
import { version } from '../src/platform/assets.ts';

test('cli: help exits 0, unknown command exits 2', async () => {
  const sb = sandbox();
  try {
    const h = await bosun(['help'], { env: sb.env() });
    assert.equal(h.code, 0);
    assert.equal((await bosun(['nope'], { env: sb.env() })).code, 2);
  } finally {
    sb.cleanup();
  }
});

test('cli: doctor reports problems in an empty sandbox without crashing', async () => {
  const sb = sandbox();
  try {
    const r = await bosun(['doctor'], {
      env: sb.env({ OLLAMA_URL: 'http://127.0.0.1:1', ROUTER_PORT: '1' }),
    });
    assert.equal(r.code, 1);
    const report = JSON.parse(r.out);
    assert.equal(report.prepared, false);
    assert.equal(report.coverage, 'filesystem-metadata');
    assert.equal(report.checks[0].id, 'runtime.home');
    assert.equal(report.checks[0].state, 'missing');
    assert.equal(report.nativeCalls, false);
    assert.equal(report.databaseOpened, false);
    assert.deepEqual(sb.calls(), []);
    assert.equal(fs.existsSync(path.join(sb.home, '.bosun')), false);
  } finally {
    sb.cleanup();
  }
});

test('cli: install rejects a bad option before touching anything', async () => {
  const sb = sandbox();
  try {
    const r = await bosun(['install', '--bogus'], { env: sb.env() });
    assert.equal(r.code, 2);
    assert.match(r.err, /unknown option ['"]?--bogus/);
    assert.ok(!fs.existsSync(path.join(sb.home, '.claude')));
  } finally {
    sb.cleanup();
  }
});

test('cli: reviewed install/uninstall reject invalid owned plans and missing receipts before touching user configs or services', async () => {
  const sb = sandbox({ stubs: ['claude', 'codex', 'orca', 'launchctl'] });
  try {
    fs.mkdirSync(path.join(sb.home, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(sb.home, '.codex', 'hooks.json'), '{ broken');
    const plan = path.join(sb.root, 'invalid-plan.json'),
      hash = 'a'.repeat(64);
    fs.writeFileSync(plan, '{ broken', { mode: 0o600 });
    const invalid = await bosun(['install', 'apply', plan, '--hash', hash, '--clients-stopped'], {
      env: sb.env(),
    });
    assert.equal(invalid.code, 2);
    assert.equal(JSON.parse(invalid.err).error.code, 'invalid');
    const missing = await bosun(
      ['uninstall', 'in_' + 'a'.repeat(32), '--version', '1', '--hash', hash, '--clients-stopped'],
      { env: sb.env() },
    );
    assert.equal(missing.code, 1);
    assert.equal(JSON.parse(missing.err).error.code, 'unavailable');
    assert.equal(fs.readFileSync(path.join(sb.home, '.codex', 'hooks.json'), 'utf8'), '{ broken');
    assert.equal(fs.existsSync(path.join(sb.home, '.local', 'bin', 'bosun')), false);
    assert.equal(
      sb.calls().filter((x) => x.bin === 'launchctl').length,
      0,
      'no service was touched',
    );
  } finally {
    sb.cleanup();
  }
});

test('cli: metadata doctor leaves an existing Ollama app and launchctl environment unprobed and unchanged', async () => {
  const sb = sandbox({ stubs: ['claude', 'codex', 'orca', 'launchctl'] });
  try {
    const app = path.join(sb.root, 'Ollama.app');
    fs.mkdirSync(app);
    const before = fs.statSync(app, { bigint: true });
    const r = await bosun(['doctor'], {
      env: sb.env({
        BOSUN_OLLAMA_APP: app,
        STUB_MAP: JSON.stringify({ 'launchctl getenv': { out: '4096' } }),
      }),
    });
    assert.equal(r.code, 1);
    const report = JSON.parse(r.out);
    assert.equal(report.nativeCalls, false);
    assert.equal(report.databaseOpened, false);
    assert.equal(report.schemaQualification, 'unverified');
    const after = fs.statSync(app, { bigint: true });
    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeNs, before.mtimeNs);
    assert.equal(after.ctimeNs, before.ctimeNs);
    assert.deepEqual(sb.calls(), [], 'doctor does not invoke launchctl/open/host/model processes');
  } finally {
    sb.cleanup();
  }
});

test('cli: uninstall restores the reviewed previous binary and leaves unowned shell/env metadata and user files intact', async () => {
  const sb = sandbox({ stubs: ['claude', 'codex', 'orca', 'launchctl'] });
  try {
    const h = sb.home;
    const app = path.join(sb.root, 'Ollama.app');
    fs.mkdirSync(app);
    fs.mkdirSync(path.join(h, '.local', 'bin'), { recursive: true });
    const ownerBinary = '#!/usr/bin/env node\n// owner binary\n';
    fs.writeFileSync(path.join(h, '.local', 'bin', 'bosun'), ownerBinary, { mode: 0o755 });
    const line = 'export PATH="$HOME/.local/bin:$PATH"';
    fs.writeFileSync(path.join(h, '.zshrc'), `alias ll="ls -la"\n\n${line}\nexport EDITOR=vim\n`);
    const env = sb.env({ BOSUN_OLLAMA_APP: app }),
      paths = runtimePaths(env);
    await setupRuntime(paths, defaultConfig());
    const legacy = JSON.stringify({
      zshrcLine: line,
      appEnvPrev: { OLLAMA_KEEP_ALIVE: '5m', OLLAMA_CONTEXT_LENGTH: null },
    });
    fs.writeFileSync(path.join(h, '.bosun', 'state.json'), legacy);
    const source = path.join(sb.root, 'reviewed-binary');
    fs.writeFileSync(
      source,
      `#!/usr/bin/env node\nif(process.argv[2]!=='--version')process.exit(2);process.stdout.write(${JSON.stringify(version + '\n')});\n`,
      { mode: 0o755 },
    );
    const options = { paths, env },
      plan = planInstallation(options, {
        binary: source,
        requestId: 'owned-install',
        replaceExisting: true,
      });
    const before = fs.statSync(path.join(h, '.local', 'bin', 'bosun'));
    const applied = await applyInstallation(options, plan, plan.planHash, true);
    assert.notEqual(fs.readFileSync(plan.targetBinary, 'utf8'), ownerBinary);
    const r = await bosun(
      [
        'uninstall',
        plan.id,
        '--version',
        String(applied.record.version),
        '--hash',
        plan.planHash,
        '--clients-stopped',
      ],
      { env },
    );
    assert.equal(r.code, 0, r.err);
    assert.equal(
      fs.readFileSync(path.join(h, '.local', 'bin', 'bosun'), 'utf8'),
      ownerBinary,
      'the reviewed previous owner binary is restored',
    );
    assert.equal(
      fs.readFileSync(path.join(h, '.zshrc'), 'utf8'),
      `alias ll="ls -la"\n\n${line}\nexport EDITOR=vim\n`,
    );
    const lc = sb
      .calls()
      .filter((c) => c.bin === 'launchctl')
      .map((c) => c.argv.join(' '));
    assert.deepEqual(
      lc,
      [],
      'the owned installer never changed these global values and cannot claim ownership',
    );
    assert.equal(fs.statSync(path.join(h, '.local', 'bin', 'bosun')).ino, before.ino);
    assert.equal(
      fs.readFileSync(path.join(paths.home, 'state.json'), 'utf8'),
      legacy,
      'legacy retirement remains a separately reviewed ownership flow',
    );
  } finally {
    sb.cleanup();
  }
});
