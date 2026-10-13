import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox } from './helpers.ts';
import { BosunError } from '../src/core/errors.ts';
import { runtimePaths } from '../src/platform/paths.ts';
import { loadRuntimeConfig } from '../src/platform/config.ts';
import { planUpgrade, applyUpgrade, upgradeStatus, upgradeHash } from '../src/app/upgrade.ts';
import type { LaunchdControl } from '../src/adapters/services/launchd.ts';
import { launchdList } from '../src/adapters/services/launchd.ts';
import { main } from '../src/app/cli.ts';
import { importLegacyConfig } from '../src/core/legacy-config.ts';

const selectedUrl = 'http://selected-ollama.invalid:11434';
const legacy =
  'LOCAL_MODEL=selected-local:tag\nROUTER_RUN=jaredpalmer/kev-0.8b\nROUTER_PORT=8009\nROUTER_URL=http://old-kev.invalid:8009\nROUTER_MIN_CONF=0.5\nMEMORY_TOKEN=PRIVATE_TOKEN_CANARY\n';
const xml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function fixture(present = true) {
  const sb = sandbox(),
    env = sb.env(),
    paths = runtimePaths(env);
  fs.mkdirSync(paths.home, { mode: 0o700 });
  fs.writeFileSync(paths.legacyConfig, legacy, { mode: 0o600 });
  const folder = path.join(sb.home, 'Library', 'LaunchAgents');
  fs.mkdirSync(folder, { recursive: true, mode: 0o755 });
  const file = path.join(folder, 'com.bosun.router.plist'),
    checkout = path.join(sb.home, 'legacy  shared', 'kev');
  fs.mkdirSync(checkout, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(checkout, 'keep.py'), 'original repository\n');
  const args = [
    path.join(sb.bin, 'uv'),
    'run',
    '--extra',
    'serve',
    'python',
    '-m',
    'kev.serve',
    '--run',
    'jaredpalmer/kev-0.8b',
    '--port',
    '8009',
  ];
  const log = path.join(paths.home, 'router.log');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.bosun.router</string>
  <key>ProgramArguments</key><array>${args.map((value) => `<string>${xml(value)}</string>`).join('')}</array>
  <key>WorkingDirectory</key><string>${xml(checkout)}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(sb.bin)}</string></dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>
`;
  if (present) fs.writeFileSync(file, plist, { mode: 0o644 });
  let running = true,
    lose = false;
  const calls: string[] = [];
  const control: LaunchdControl = {
    domain: 'gui/501',
    async observe(label) {
      assert.equal(label, 'com.bosun.router');
      calls.push('observe');
      return { present: running, pid: running ? 123 : null, exitStatus: null };
    },
    async bootstrap() {
      calls.push('bootstrap');
      throw Error('Never bootstrap a retired service');
    },
    async bootout(label) {
      assert.equal(label, 'com.bosun.router');
      calls.push('bootout');
      running = false;
      if (lose)
        throw new BosunError('unavailable', 'Lost native return', {
          details: { outcome: 'unknown' },
        });
    },
  };
  const plan = (adopt = true, url: string | undefined = selectedUrl) =>
    planUpgrade(paths, 'upgrade_clef', {
      env,
      routerUrl: url,
      ...(adopt && present
        ? { reviewedAdoptionHash: upgradeHash(fs.readFileSync(file, 'utf8')) }
        : {}),
    });
  const apply = (value = plan()) =>
    applyUpgrade(paths, { plan: value.plan, hash: value.hash, clientsStopped: true, env, control });
  return {
    sb,
    env,
    paths,
    file,
    checkout,
    plist,
    control,
    calls,
    plan,
    apply,
    setLose() {
      lose = true;
    },
    setStopped() {
      running = false;
    },
  };
}

test('upgrade reviews exact supported Kev plist and explicit new endpoint without probing, installing or retaining its confidence', async () => {
  const f = fixture();
  try {
    assert.throws(
      () => planUpgrade(f.paths, 'missing_selection', { env: f.env }),
      (error: unknown) => error instanceof BosunError && error.code === 'unverified',
    );
    const value = f.plan();
    assert.equal(value.plan.legacyRouter!.state, 'present');
    if (value.plan.legacyRouter!.state === 'present') {
      assert.equal(value.plan.legacyRouter!.reason, 'ready');
      assert.equal(value.plan.legacyRouter!.hash, upgradeHash(f.plist));
      assert.equal(value.plan.legacyRouter!.reviewedAdoptionHash, upgradeHash(f.plist));
      assert.ok(value.plan.legacyRouter!.argv.includes('kev.serve'));
    }
    assert.match(value.plan.config, /clef-flash:9b/);
    assert.match(value.plan.config, /minConfidence = 0.7/);
    assert.ok(value.plan.config.includes(selectedUrl));
    assert.ok(!value.plan.config.includes('old-kev.invalid'));
    assert.doesNotMatch(JSON.stringify(value.plan), /PRIVATE_TOKEN_CANARY/);
    assert.doesNotMatch(
      JSON.stringify(
        importLegacyConfig(
          legacy.replace(
            'http://old-kev.invalid:8009',
            'http://user:PRIVATE_PASSWORD_CANARY@old-kev.invalid:8009?token=PRIVATE_QUERY_CANARY',
          ),
        ),
      ),
      /PRIVATE_PASSWORD_CANARY|PRIVATE_QUERY_CANARY/,
    );
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.sb.calls(), []);
  } finally {
    f.sb.cleanup();
  }
});

test('unowned, malformed, changed, linked and foreign-user legacy definitions hold before upgrade effects or service discovery', async () => {
  for (const arm of [
    'unowned',
    'template',
    'forged-review',
    'changed',
    'inode',
    'symlink',
    'wrong-home',
  ]) {
    const f = fixture();
    try {
      if (arm === 'template' || arm === 'forged-review')
        fs.writeFileSync(f.file, f.plist.replace('kev.serve', 'other.serve'));
      const value = f.plan(arm !== 'unowned');
      if (arm === 'forged-review') {
        assert.equal(value.plan.legacyRouter.state, 'present');
        if (value.plan.legacyRouter.state === 'present') value.plan.legacyRouter.reason = 'ready';
        value.hash = upgradeHash(JSON.stringify(value.plan));
      }
      if (arm === 'changed') fs.appendFileSync(f.file, '\n');
      if (arm === 'inode') {
        const next = f.file + '.next';
        fs.writeFileSync(next, f.plist, { mode: 0o644 });
        fs.renameSync(next, f.file);
      }
      if (arm === 'symlink') {
        const next = f.file + '.next';
        fs.writeFileSync(next, f.plist, { mode: 0o644 });
        fs.unlinkSync(f.file);
        fs.symlinkSync(next, f.file);
      }
      await assert.rejects(
        applyUpgrade(f.paths, {
          plan: value.plan,
          hash: value.hash,
          clientsStopped: true,
          env: arm === 'wrong-home' ? { ...f.env, HOME: f.paths.home } : f.env,
          get control(): never {
            throw Error('SERVICE_DISCOVERY_CANARY');
          },
        }),
      );
      assert.equal(fs.existsSync(path.join(f.paths.home, 'upgrade.json')), false);
      assert.equal(fs.existsSync(f.paths.memory), false);
      assert.deepEqual(f.calls, []);
    } finally {
      f.sb.cleanup();
    }
  }
});

test('one reviewed upgrade backs up, stops and archives Kev, retains config/repository, and selects Clef without replay', async () => {
  const f = fixture();
  try {
    const value = f.plan(),
      result = await f.apply(value);
    assert.equal(result.receipt.state, 'ready');
    assert.equal(result.receipt.legacyRouter!.state, 'retired');
    assert.equal(result.receipt.legacyRouter!.adopted, true);
    assert.equal(fs.existsSync(f.file), false);
    assert.equal(fs.readFileSync(result.receipt.legacyRouter!.backup, 'utf8'), f.plist);
    assert.equal(fs.statSync(result.receipt.legacyRouter!.backup).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(f.paths.legacyConfig, 'utf8'), legacy);
    assert.equal(
      fs.readFileSync(path.join(f.checkout, 'keep.py'), 'utf8'),
      'original repository\n',
    );
    assert.equal(loadRuntimeConfig(f.paths, f.env).router.url, selectedUrl);
    assert.equal(loadRuntimeConfig(f.paths, f.env).router.model, 'clef-flash:9b');
    assert.deepEqual(f.calls, ['observe', 'bootout', 'observe']);
    assert.deepEqual(f.sb.calls(), []);
    const calls = [...f.calls];
    const duplicate = await f.apply(value);
    assert.equal(duplicate.duplicate, true);
    assert.deepEqual(f.calls, calls);
    assert.equal(upgradeStatus(f.paths).legacyRouter!.hash, upgradeHash(f.plist));
  } finally {
    f.sb.cleanup();
  }
});

test('already stopped Kev definition archives without repeating bootout, while absent service makes no native call', async () => {
  for (const absent of [true, false]) {
    const f = fixture(!absent);
    f.setStopped();
    try {
      const value = f.plan();
      const result = await f.apply(value);
      assert.equal(result.receipt.state, 'ready');
      assert.equal(f.calls.includes('bootout'), false);
      assert.deepEqual(f.calls, absent ? [] : ['observe', 'observe']);
    } finally {
      f.sb.cleanup();
    }
  }
});

test('actual stop followed by lost native return retains original plist/backup and a held attempt without another stop', async () => {
  const f = fixture();
  f.setLose();
  try {
    const value = f.plan();
    await assert.rejects(
      f.apply(value),
      (error: unknown) => error instanceof BosunError && error.details?.outcome === 'unknown',
    );
    const receipt = upgradeStatus(f.paths);
    assert.equal(receipt.state, 'unknown');
    assert.equal(receipt.legacyRouter!.state, 'stopping');
    assert.equal(fs.readFileSync(receipt.legacyRouter!.backup, 'utf8'), f.plist);
    assert.equal(fs.existsSync(f.file), true);
    assert.equal(fs.existsSync(f.paths.memory), false);
    assert.equal(fs.existsSync(f.paths.config), false);
    const calls = [...f.calls];
    await assert.rejects(f.apply(value));
    assert.deepEqual(f.calls, calls);
    assert.equal(f.calls.filter((call) => call === 'bootout').length, 1);
  } finally {
    f.sb.cleanup();
  }
});

test('archive unlink followed by lost return preserves retained native backup and never repeats any upgrade effects', async () => {
  const f = fixture(),
    unlink = fs.unlinkSync;
  const value = f.plan();
  try {
    fs.unlinkSync = ((file: fs.PathLike) => {
      unlink(file);
      if (String(file) === f.file) throw Error('Lost archive return');
    }) as typeof fs.unlinkSync;
    await assert.rejects(f.apply(value));
    fs.unlinkSync = unlink;
    const receipt = upgradeStatus(f.paths);
    assert.equal(receipt.state, 'unknown');
    assert.equal(fs.existsSync(f.file), false);
    assert.equal(fs.readFileSync(receipt.legacyRouter!.backup, 'utf8'), f.plist);
    const calls = [...f.calls];
    await assert.rejects(f.apply(value));
    assert.deepEqual(f.calls, calls);
  } finally {
    fs.unlinkSync = unlink;
    f.sb.cleanup();
  }
});

test('retired backup corruption or an unowned replacement definition makes status/duplicate apply held without mutation', async () => {
  for (const arm of ['backup', 'replacement']) {
    const f = fixture();
    try {
      const value = f.plan();
      const result = await f.apply(value);
      if (arm === 'backup') fs.appendFileSync(result.receipt.legacyRouter!.backup, 'changed');
      else fs.writeFileSync(f.file, f.plist, { mode: 0o644 });
      assert.throws(() => upgradeStatus(f.paths));
      const calls = [...f.calls];
      await assert.rejects(f.apply(value));
      assert.deepEqual(f.calls, calls);
    } finally {
      f.sb.cleanup();
    }
  }
});

test('legacy launchd list selection is restricted to the exact router label and current CLI exposes its review options', async () => {
  assert.equal(
    launchdList('PID Status Label\n123 0 com.bosun.router\n', 'com.bosun.router').present,
    true,
  );
  assert.throws(() => launchdList('PID Status Label\n', 'com.bosun.other'));
  let output = '';
  assert.equal(
    await main(['upgrade', 'plan', '--help'], { stdout: (text) => (output += text), stderr() {} }),
    0,
  );
  assert.match(output, /--router-url/);
  assert.match(output, /--adopt-router-hash/);
});

test('actual owner CLI plans hash-based Kev adoption and applies the single supported upgrade through scoped service control', async () => {
  const f = fixture();
  const cli = async (args: string[]) => {
    let out = '',
      err = '';
    const code = await main(args, {
      env: f.env,
      cwd: f.sb.home,
      serviceControl: f.control,
      stdout: (value) => (out += value),
      stderr: (value) => (err += value),
    });
    assert.equal(code, 0, err);
    assert.doesNotMatch(out, /PRIVATE_TOKEN_CANARY/);
    return JSON.parse(out);
  };
  try {
    const firstFile = path.join(f.sb.home, 'first-upgrade.json'),
      adoptedFile = path.join(f.sb.home, 'adopted-upgrade.json');
    const first = await cli([
      'upgrade',
      'plan',
      '--request-id',
      'cli_retirement',
      '--router-url',
      selectedUrl,
      '--output',
      firstFile,
    ]);
    assert.equal(first.plan.legacyRouter.reason, 'service_unowned');
    assert.deepEqual(f.calls, []);
    const adopted = await cli([
      'upgrade',
      'plan',
      '--request-id',
      'cli_retirement',
      '--router-url',
      selectedUrl,
      '--adopt-router-hash',
      first.plan.legacyRouter.hash,
      '--output',
      adoptedFile,
    ]);
    assert.equal(adopted.plan.legacyRouter.reason, 'ready');
    assert.deepEqual(f.calls, []);
    const args = ['upgrade', 'apply', adoptedFile, '--hash', adopted.hash, '--clients-stopped'];
    const result = await cli(args);
    assert.equal(result.receipt.legacyRouter.state, 'retired');
    const calls = [...f.calls];
    assert.equal((await cli(args)).duplicate, true);
    assert.deepEqual(f.calls, calls);
    assert.deepEqual(f.sb.calls(), []);
  } finally {
    f.sb.cleanup();
  }
});
