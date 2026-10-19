import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, fresh } from './helpers.ts';
import { runtimePaths } from '../src/platform/paths.ts';
import { loadRuntimeConfig, parseRuntimeConfig, saveRuntimeConfig } from '../src/platform/config.ts';
import { readRuntimeManifest } from '../src/platform/manifest.ts';
import { DaemonOwner } from '../src/platform/daemon-owner.ts';
import { version } from '../src/platform/assets.ts';
import { setupRuntime } from '../src/app/setup.ts';
import { installationStatus } from '../src/app/installation.ts';
import { runInstallWizard } from '../src/app/install-wizard.ts';
import { planHostInstallation, applyHostInstallation, hostLaunchPlan } from '../src/app/host-install.ts';
import { runOnboardingWizard, type OnboardingPrompts } from '../src/app/onboarding-wizard.ts';
import type { HostId } from '../src/core/domain/config.ts';
import { startDaemon } from '../src/app/daemon.ts';
import { controlInstallationService } from '../src/app/installation-service.ts';
import type { LaunchdControl } from '../src/adapters/services/launchd.ts';

const versions = { omp: '18.10.3', opencode: '2.0.27', codex: '0.161.0', claude: '2.1.292' };
type Question = Parameters<OnboardingPrompts['confirm']>[0];
let serial = 0;
function fixture() {
  const sb = sandbox({ stubs: ['omp', 'opencode2', 'codex', 'claude'] });
  fresh(sb);
  const env = sb.env({ BOSUN_SOCKET: path.join(process.env.BOSUN_TEST_RUN_ROOT!, `ob${process.pid}_${++serial}`) });
  const paths = runtimePaths(env);
  const binary = path.join(sb.root, 'qualified-release');
  fs.writeFileSync(binary, `#!/usr/bin/env bun\nif(process.argv.slice(2).join(' ')!=='--version')process.exit(2);process.stdout.write(${JSON.stringify(version + '\n')});\n`, { mode: 0o755 });
  const questions: Question[] = [];
  const defaults: HostId[] = [];
  let output = '';
  const prompts: OnboardingPrompts = {
    async confirm(question) { questions.push(question); return !['start', 'models', 'launch'].includes(question.kind); },
    async selectHost(initialValue) { defaults.push(initialValue); return initialValue; },
    async text() { return null; },
  };
  const run = (selected?: HostId, selectedBinary: string | undefined = binary) => runOnboardingWizard({
    paths, env, cwd: sb.home, binary: selectedBinary, host: selected, prompts,
    write(text) { output += text; },
  });
  const native = (host: HostId, selectedVersion = versions[host]) => {
    const name = host === 'opencode' ? 'opencode2' : host;
    const reply = host === 'omp' ? `omp/${selectedVersion}` : host === 'codex' ? `codex-cli ${selectedVersion}` : host === 'claude' ? `${selectedVersion} (Claude Code)` : selectedVersion;
    env.STUB_MAP = JSON.stringify({ [`${name} --version`]: { out: reply + '\n' } });
  };
  async function install(toml = '') {
    await setupRuntime(paths, parseRuntimeConfig(toml));
    const installed = await runInstallWizard({ paths, env, binary, confirm: async q => q.kind !== 'start', write() {} });
    assert.equal(installed.state, 'ready');
    return installed.binary!;
  }
  async function profile(host: HostId) {
    const installedBinary = installationStatus({ paths, env }).record!.targetBinary;
    const options = { paths, config: loadRuntimeConfig(paths, env), binary: installedBinary, workspace: sb.home };
    const plan = await planHostInstallation(options, { hostId: host, nativeVersion: versions[host], requestId: `seed-${host}` });
    return applyHostInstallation(options, plan, plan.planHash);
  }
  return { sb, env, paths, binary, prompts, questions, defaults, run, native, install, profile, output: () => output };
}
function footprint(root: string): unknown {
  if (!fs.existsSync(root)) return null;
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink()) return { mode: stat.mode, ino: stat.ino, link: fs.readlinkSync(root) };
  if (stat.isDirectory()) return { mode: stat.mode, ino: stat.ino, entries: fs.readdirSync(root).sort().map(name => [name, footprint(path.join(root, name))]) };
  return { mode: stat.mode, ino: stat.ino, bytes: fs.readFileSync(root) };
}

test('fresh preparation requires approvals and probes only the selected host, without foreground launch', async () => {
  const f = fixture();
  try {
    f.native('omp');
    f.prompts.selectHost = async initial => {
      assert.equal(installationStatus({ paths: f.paths, env: f.env }).record?.state, 'ready');
      f.defaults.push(initial);
      return initial;
    };
    const result = await f.run();
    assert.equal(result.state, 'ready', result.message);
    assert.equal(result.host, 'omp');
    assert.equal(result.launch, undefined);
    assert.deepEqual(f.defaults, ['omp']);
    assert.deepEqual(f.questions.slice(0, 2).map(q => q.kind), ['setup', 'install']);
    assert.ok(f.questions.some(q => q.kind === 'native-version' && q.initialValue === false));
    assert.ok(f.questions.some(q => q.kind === 'profile' && q.initialValue === false));
    assert.deepEqual(f.sb.calls().map(c => [c.bin, c.argv]), [['omp', ['--version']]]);
    const receipt = readRuntimeManifest(f.paths).hostProfiles![0];
    assert.equal(receipt.state, 'ready');
    assert.ok(fs.existsSync(path.join(f.paths.artifacts, `host-${receipt.id}.json`)));
    assert.match(result.message, /prepared/i);
    assert.match(result.message, /not started/i);
    assert.match(f.output(), /unverified/i);
  } finally { f.sb.cleanup(); }
});

for (const host of ['omp', 'opencode', 'codex', 'claude'] as const)
  test(`${host} ready profile reuses exact files/config/receipts and returns only separately approved literal launch`, async () => {
    const f = fixture();
    try {
      await f.install('[hosts]\nprimary="opencode"\n[roles.worker.omp]\nmodel="owner/exact-model"\neffort="high"\n');
      const prepared = await f.profile(host);
      f.native(host);
      const before = footprint(f.paths.home);
      f.prompts.selectHost = async initial => { assert.equal(initial, 'opencode'); return host; };
      f.prompts.confirm = async q => {
        f.questions.push(q);
        if (q.kind === 'launch') {
          const preview = await hostLaunchPlan({ paths: f.paths, config: loadRuntimeConfig(f.paths, f.env), binary: prepared.record.binary, env: f.env, cwd: f.sb.home }, prepared.record.id, prepared.record.version, prepared.record.planHash);
          assert.ok(f.output().includes(`Executable: ${JSON.stringify(preview.command)}`));
          assert.ok(f.output().includes(`Literal argv (no shell): ${JSON.stringify(preview.args)}`));
          assert.ok(f.output().includes(`Workspace: ${JSON.stringify(preview.cwd)}`));
          for (const [key, value] of Object.entries(preview.env)) {
            if (key === 'OPENCODE_CONFIG_CONTENT') {
              assert.ok(f.output().includes(`${key}: exact reviewed bytes from ${JSON.stringify(preview.env.OPENCODE_CONFIG)}`));
              assert.equal(f.output().includes(value), false);
            } else assert.ok(f.output().includes(`${key}=${JSON.stringify(value)}`));
          }
          assert.deepEqual(f.sb.calls().map(c => c.argv), [['--version']]);
          return true;
        }
        return q.kind === 'native-version';
      };
      const result = await f.run();
      assert.equal(result.state, 'ready', result.message);
      assert.deepEqual(result.launch, { id: prepared.record.id, version: prepared.record.version, hash: prepared.record.planHash });
      assert.deepEqual(footprint(f.paths.home), before);
      assert.equal(loadRuntimeConfig(f.paths, {}).hosts.primary, 'opencode');
      assert.deepEqual(f.sb.calls().map(c => [c.bin, c.argv]), [[host === 'opencode' ? 'opencode2' : host, ['--version']]]);
      assert.equal(f.questions.some(q => ['install', 'reinstall', 'profile', 'models'].includes(q.kind)), false);
    } finally { f.sb.cleanup(); }
  });

test('declining initial setup or native inspection does not imply rollback of already approved installation', async () => {
  for (const decline of ['setup', 'native-version'] as const) {
    const f = fixture();
    try {
      f.prompts.confirm = async q => q.kind !== decline && q.kind !== 'start';
      const result = await f.run();
      assert.equal(result.state, 'cancelled');
      assert.equal(fs.existsSync(f.paths.home), decline !== 'setup');
      if (decline === 'native-version') assert.match(result.message, /install.*retain/i);
      assert.deepEqual(f.sb.calls(), []);
    } finally { f.sb.cleanup(); }
  }
});

test('source onboarding without an explicit release binary holds before preparation', async () => {
  const f = fixture();
  try {
    const result = await runOnboardingWizard({ paths: f.paths, env: f.env, cwd: f.sb.home, prompts: f.prompts, write() {} });
    assert.equal(result.state, 'held');
    assert.match(result.message, /--binary/);
    assert.deepEqual(f.questions, []);
    assert.equal(fs.existsSync(f.paths.home), false);
  } finally { f.sb.cleanup(); }
});

test('reviewed missing-role writes preserve every explicit model/effort, other host and primary without persisting env overlays', async () => {
  const f = fixture();
  try {
    await f.install('[hosts]\nprimary="opencode"\n[roles.worker.omp]\nmodel="owner/exact"\neffort="high"\n[roles.scout.omp]\neffort="low"\n[roles.worker.opencode]\nmodel="other-host-exact"\neffort="max"\n');
    const saved = loadRuntimeConfig(f.paths, {});
    const savedBytes = fs.readFileSync(f.paths.config);
    f.env.BOSUN_ROLE_WORKER_OMP_MODEL = 'temporary/override';
    f.env.BOSUN_ROUTER_MODEL = 'temporary-router';
    f.env.BOSUN_PRIMARY_HOST = 'claude';
    f.native('omp');
    f.prompts.confirm = async q => { f.questions.push(q); return !['start', 'launch'].includes(q.kind); };
    f.prompts.selectHost = async initial => { assert.equal(initial, 'claude'); return 'omp'; };
    let inputs = 0;
    f.prompts.text = async message => {
      inputs++;
      assert.equal(message.includes('worker ('), false);
      return 'provider/exact-user-model';
    };
    const result = await f.run();
    assert.equal(result.state, 'ready', result.message);
    const actual = loadRuntimeConfig(f.paths, {});
    assert.equal(actual.hosts.primary, saved.hosts.primary);
    assert.equal(actual.router.model, saved.router.model);
    assert.deepEqual(actual.roles.worker.omp, saved.roles.worker.omp);
    assert.deepEqual(actual.roles.worker.opencode, saved.roles.worker.opencode);
    assert.deepEqual(actual.roles.scout.omp, { effort: 'low', model: 'provider/exact-user-model' });
    for (const [role, bindings] of Object.entries(saved.roles)) {
      assert.deepEqual(actual.roles[role].codex, bindings.codex);
      assert.deepEqual(actual.roles[role].claude, bindings.claude);
    }
    assert.equal(loadRuntimeConfig(f.paths, f.env).roles.worker.omp!.model, 'temporary/override');
    assert.equal(f.questions.filter(q => q.kind === 'models').length, 2);
    assert.ok(f.output().includes('"scout": "provider/exact-user-model"'));
    assert.equal(fs.readFileSync(f.paths.config, 'utf8').includes('temporary/override'), false);
    assert.equal(inputs, 1, 'one exact owner selector is explicitly reviewed for all missing roles');
    const backups = fs.readdirSync(f.paths.artifacts).filter(name => name.startsWith('onboard-config-'));
    assert.equal(backups.length, 1);
    assert.equal(fs.statSync(path.join(f.paths.artifacts, backups[0])).mode & 0o777, 0o600);
    assert.deepEqual(fs.readFileSync(path.join(f.paths.artifacts, backups[0])), savedBytes);
  } finally { f.sb.cleanup(); }
});

test('fresh runtime preparation also keeps temporary config overlays out of the saved file', async () => {
  const f = fixture();
  try {
    f.env.BOSUN_PRIMARY_HOST = 'opencode';
    f.env.BOSUN_ROLE_WORKER_OPENCODE_MODEL = 'provider/temporary-exact';
    f.native('opencode');
    const result = await f.run();
    assert.equal(result.state, 'ready', result.message);
    assert.equal(loadRuntimeConfig(f.paths, {}).hosts.primary, 'omp');
    assert.equal(loadRuntimeConfig(f.paths, {}).roles.worker.opencode?.model, undefined);
    assert.equal(loadRuntimeConfig(f.paths, f.env).roles.worker.opencode?.model, 'provider/temporary-exact');
    assert.deepEqual(f.sb.calls().map(c => c.bin), ['opencode2']);
  } finally { f.sb.cleanup(); }
});

test('preparing another host leaves existing ready profiles and whole-config bindings byte-identical after explicit missing-model consent', async () => {
  const f = fixture();
  try {
    await f.install();
    const old = await f.profile('codex');
    const oldTree = footprint(old.root), oldRecord = old.record;
    const config = footprint(f.paths.config);
    f.native('omp');
    f.prompts.confirm = async q => {
      if (q.kind === 'models') assert.match(q.message, /preserve all existing profile\/config hashes/);
      return !['start', 'launch'].includes(q.kind);
    };
    const result = await f.run('omp');
    assert.equal(result.state, 'ready', result.message);
    assert.deepEqual(footprint(f.paths.config), config);
    assert.deepEqual(footprint(old.root), oldTree);
    assert.deepEqual(readRuntimeManifest(f.paths).hostProfiles!.find(p => p.id === oldRecord.id), oldRecord);
    assert.equal(readRuntimeManifest(f.paths).hostProfiles!.filter(p => p.state === 'ready').length, 2);
  } finally { f.sb.cleanup(); }
});

for (const change of ['config', 'release-source', 'receipt', 'native-executable', 'native-path'] as const)
  test(`${change} changed while native consent is pending holds before the selected version probe`, async () => {
    const f = fixture();
    try {
      await f.install();
      f.native('omp');
      f.prompts.confirm = async q => {
        if (q.kind === 'native-version') {
          if (change === 'config') saveRuntimeConfig(f.paths, parseRuntimeConfig('[roles.worker.omp]\nmodel="new/review"\n'));
          if (change === 'release-source') fs.appendFileSync(f.binary, '# source changed\n');
          if (change === 'receipt') {
            const manifest = JSON.parse(fs.readFileSync(f.paths.manifest, 'utf8'));
            manifest.installation.version++;
            fs.writeFileSync(f.paths.manifest, JSON.stringify(manifest));
          }
          if (change === 'native-executable') fs.appendFileSync(path.join(f.sb.bin, 'omp'), '\n// owner change\n');
          if (change === 'native-path') f.env.PATH = '/no-selected-native';
        }
        return true;
      };
      const result = await f.run('omp');
      assert.equal(result.state, 'held');
      assert.equal(readRuntimeManifest(f.paths).hostProfiles, undefined);
      assert.deepEqual(f.sb.calls(), []);
    } finally { f.sb.cleanup(); }
  });

for (const change of ['config', 'receipt', 'live-owner'] as const)
  test(`${change} changed at model-save approval fences the file write and profile application`, async () => {
    const f = fixture();
    let owner: DaemonOwner | undefined;
    try {
      await f.install();
      f.native('omp');
      const original = fs.readFileSync(f.paths.config);
      f.prompts.text = async () => 'provider/exact-model';
      f.prompts.confirm = async q => {
        if (q.kind === 'models' && q.message.startsWith('Save')) {
          if (change === 'config') saveRuntimeConfig(f.paths, parseRuntimeConfig('[roles.worker.omp]\nmodel="concurrent/exact"\n'));
          if (change === 'receipt') {
            const manifest = JSON.parse(fs.readFileSync(f.paths.manifest, 'utf8'));
            manifest.installation.version++;
            fs.writeFileSync(f.paths.manifest, JSON.stringify(manifest));
          }
          if (change === 'live-owner') {
            assert.throws(() => { owner = new DaemonOwner(f.paths.owner); });
            return false;
          }
        }
        return !['start', 'launch'].includes(q.kind);
      };
      const result = await f.run('omp');
      assert.equal(result.state, change === 'live-owner' ? 'cancelled' : 'held');
      assert.equal(readRuntimeManifest(f.paths).hostProfiles, undefined);
      if (change !== 'config') assert.deepEqual(fs.readFileSync(f.paths.config), original);
      else assert.equal(loadRuntimeConfig(f.paths, {}).roles.worker.omp!.model, 'concurrent/exact');
      assert.deepEqual(f.sb.calls().map(c => c.argv), [['--version']]);
    } finally { owner?.close(); f.sb.cleanup(); }
  });

for (const defect of ['unknown-install', 'unknown-service', 'unknown-profile', 'profile-drift', 'config-drift', 'legacy', 'unsafe'] as const)
  test(`${defect} is held on original inspection without prompts, native calls or changes`, async () => {
    const f = fixture();
    try {
      if (defect === 'legacy') {
        fs.mkdirSync(f.paths.home, { mode: 0o700 });
        fs.writeFileSync(path.join(f.paths.home, 'legacy-data'), 'retained');
      } else {
        await f.install();
        if (['unknown-profile', 'profile-drift', 'config-drift'].includes(defect)) await f.profile('omp');
        const manifest = JSON.parse(fs.readFileSync(f.paths.manifest, 'utf8'));
        if (defect === 'unknown-install') manifest.installation.state = 'unknown';
        if (defect === 'unknown-service') manifest.installation.service.state = 'unknown';
        if (defect === 'unknown-profile') manifest.hostProfiles[0].state = 'unknown';
        if (defect.startsWith('unknown-')) fs.writeFileSync(f.paths.manifest, JSON.stringify(manifest));
        if (defect === 'profile-drift') fs.appendFileSync(path.join(f.paths.home, 'host-profiles', manifest.hostProfiles[0].id, 'shared', 'policy.md'), '\nchanged');
        if (defect === 'config-drift') saveRuntimeConfig(f.paths, parseRuntimeConfig('[roles.worker.omp]\nmodel="drifted/exact"\n'));
        if (defect === 'unsafe') fs.chmodSync(f.paths.home, 0o755);
      }
      const before = footprint(f.sb.home);
      for (let attempt = 0; attempt < 2; attempt++) assert.equal((await f.run('omp')).state, 'held');
      assert.deepEqual(f.questions, []);
      assert.deepEqual(footprint(f.sb.home), before);
      assert.deepEqual(f.sb.calls(), []);
    } finally { f.sb.cleanup(); }
  });

test('foreground/nohup daemon ownership prevents model/profile mutation and gives concrete stop guidance', async () => {
  const f = fixture();
  let owner: DaemonOwner | undefined;
  try {
    await f.install();
    f.native('omp');
    owner = new DaemonOwner(f.paths.owner);
    const before = footprint(f.paths.home);
    const result = await f.run('omp');
    assert.equal(result.state, 'held');
    assert.match(result.message, /foreground\/nohup/);
    assert.match(result.message, /Ctrl-C/);
    assert.equal(f.questions.some(q => q.kind === 'profile' || q.kind === 'models'), false);
    assert.deepEqual(footprint(f.paths.home), before);
  } finally { owner?.close(); f.sb.cleanup(); }
});

for (const defect of ['missing', 'unsupported-major', 'ambiguous', 'nonzero'] as const)
  test(`selected ${defect} native version holds without profile/config writes or fallback host`, async () => {
    const f = fixture();
    try {
      await f.install();
      f.native('omp', defect === 'unsupported-major' ? '19.0.0' : defect === 'ambiguous' ? '18.10.3\nextra' : versions.omp);
      if (defect === 'missing') fs.unlinkSync(path.join(f.sb.bin, 'omp'));
      if (defect === 'nonzero') f.env.STUB_MAP = JSON.stringify({ 'omp --version': { out: 'omp/18.10.3\n', code: 2 } });
      const before = footprint(f.paths.home);
      const result = await f.run('omp');
      assert.equal(result.state, 'held');
      assert.deepEqual(footprint(f.paths.home), before);
      assert.deepEqual(f.sb.calls().map(c => [c.bin, c.argv]), defect === 'missing' ? [] : [['omp', ['--version']]]);
      assert.equal(f.questions.some(q => q.kind === 'profile'), false);
    } finally { f.sb.cleanup(); }
  });

for (const decision of ['decline-retire', 'decline-apply', 'replace'] as const)
  test(`supported native version change ${decision} preserves config and truthfully retains old undo/archive`, async () => {
    const f = fixture();
    try {
      await f.install('[roles.worker.omp]\nmodel="owner/exact"\neffort="high"\n');
      const old = await f.profile('omp');
      const config = footprint(f.paths.config), oldTree = footprint(old.root);
      f.native('omp', '18.11.0');
      let profiles = 0;
      f.prompts.confirm = async q => {
        if (q.kind === 'profile') {
          profiles++;
          if (decision === 'decline-retire' || decision === 'decline-apply' && profiles === 2) return false;
        }
        return !['start', 'launch'].includes(q.kind);
      };
      const result = await f.run('omp');
      assert.equal(result.state, decision === 'replace' ? 'ready' : 'cancelled', result.message);
      assert.deepEqual(footprint(f.paths.config), config);
      const records = readRuntimeManifest(f.paths).hostProfiles!;
      assert.equal(records.find(p => p.id === old.record.id)!.state, decision === 'decline-retire' ? 'ready' : 'undone');
      if (decision === 'decline-retire') assert.deepEqual(footprint(old.root), oldTree);
      else {
        assert.deepEqual(footprint(old.root + '.retired'), oldTree);
        assert.match(result.message, /archived/);
      }
      assert.equal(records.filter(p => p.state === 'ready').length, decision === 'decline-apply' ? 0 : 1);
      if (decision === 'replace') assert.equal(records.find(p => p.state === 'ready')!.nativeVersion, '18.11.0');
      assert.deepEqual(f.sb.calls().map(c => c.argv), [['--version']]);
    } finally { f.sb.cleanup(); }
  });

test('literal launch approval changed during the prompt cannot return a launch receipt or start foreground', async () => {
  const f = fixture();
  try {
    await f.install();
    await f.profile('omp');
    f.native('omp');
    f.prompts.confirm = async q => {
      if (q.kind === 'launch') {
        assert.match(f.output(), /Literal native foreground launch preview/);
        const manifest = JSON.parse(fs.readFileSync(f.paths.manifest, 'utf8'));
        manifest.hostProfiles[0].version++;
        fs.writeFileSync(f.paths.manifest, JSON.stringify(manifest));
      }
      return q.kind !== 'start';
    };
    const result = await f.run('omp');
    assert.equal(result.state, 'held');
    assert.equal(result.launch, undefined);
    assert.deepEqual(f.sb.calls().map(c => c.argv), [['--version']]);
  } finally { f.sb.cleanup(); }
});

test('host-selection and model-entry cancellation preserve already approved changes without rollback or foreground launch', async () => {
  for (const cancel of ['host', 'model'] as const) {
    const f = fixture();
    try {
      f.native('omp');
      if (cancel === 'host') f.prompts.selectHost = async () => null;
      else f.prompts.confirm = async q => !['start', 'launch'].includes(q.kind);
      const result = await f.run();
      assert.equal(result.state, 'cancelled');
      assert.match(result.message, /approved changes are retained/);
      assert.match(result.message, /No automatic rollback/);
      assert.equal(readRuntimeManifest(f.paths).hostProfiles, undefined);
      assert.deepEqual(f.sb.calls().map(c => c.argv), cancel === 'host' ? [] : [['--version']]);
    } finally { f.sb.cleanup(); }
  }
});

for (const change of ['config', 'receipt', 'live-owner'] as const)
  test(`${change} changed at native profile approval holds before saving/applying its plan`, async () => {
    const f = fixture();
    let owner: DaemonOwner | undefined;
    try {
      await f.install();
      f.native('omp');
      const config = fs.readFileSync(f.paths.config);
      f.prompts.confirm = async q => {
        if (q.kind === 'profile') {
          if (change === 'config') saveRuntimeConfig(f.paths, parseRuntimeConfig('[roles.worker.omp]\nmodel="concurrent/exact"\n'));
          if (change === 'receipt') {
            const manifest = JSON.parse(fs.readFileSync(f.paths.manifest, 'utf8'));
            manifest.installation.version++;
            fs.writeFileSync(f.paths.manifest, JSON.stringify(manifest));
          }
          if (change === 'live-owner') owner = new DaemonOwner(f.paths.owner);
        }
        return !['models', 'start', 'launch'].includes(q.kind);
      };
      const result = await f.run('omp');
      assert.equal(result.state, 'held');
      assert.equal(readRuntimeManifest(f.paths).hostProfiles, undefined);
      assert.equal(fs.readdirSync(f.paths.artifacts).some(name => name.startsWith('host-')), false);
      if (change !== 'config') assert.deepEqual(fs.readFileSync(f.paths.config), config);
      assert.deepEqual(f.sb.calls().map(c => c.argv), [['--version']]);
    } finally { owner?.close(); f.sb.cleanup(); }
  });

for (const selector of [' provider/exact ', 'provider/fuzzy*', 'not-a-native-selector'] as const)
  test(`unreviewable exact model input ${JSON.stringify(selector)} cannot persist config or apply a profile`, async () => {
    const f = fixture();
    try {
      await f.install();
      f.native('omp');
      const before = footprint(f.paths.home);
      f.prompts.text = async () => selector;
      f.prompts.confirm = async q => !['start', 'launch'].includes(q.kind);
      const result = await f.run('omp');
      assert.equal(result.state, 'held');
      assert.deepEqual(footprint(f.paths.home), before);
      assert.deepEqual(f.sb.calls().map(c => c.argv), [['--version']]);
    } finally { f.sb.cleanup(); }
  });

test('optional tools reuse the supplied real flow only after profile preparation and before launch review', async () => {
  const f = fixture();
  try {
    await f.install();
    f.native('omp');
    let called = false;
    const result = await runOnboardingWizard({
      paths: f.paths, env: f.env, cwd: f.sb.home, binary: f.binary, prompts: f.prompts,
      write: text => { if (text.includes('Literal native foreground launch preview')) assert.equal(called, true); },
      async optionalTools() {
        assert.equal(readRuntimeManifest(f.paths).hostProfiles![0].state, 'ready');
        assert.equal(installationStatus({ paths: f.paths, env: f.env }).record!.service.state, 'prepared');
        assert.deepEqual(f.sb.calls().map(c => c.argv), [['--version']]);
        called = true;
      },
    });
    assert.equal(result.state, 'ready', result.message);
    assert.equal(called, true);
    assert.equal(result.launch, undefined);
  } finally { f.sb.cleanup(); }
});

test('model callers cannot enter wizard effects or even read runtime/configuration getters', async () => {
  let reads = 0;
  const result = await runOnboardingWizard({
    get paths(): never { reads++; throw Error('paths read'); },
    env: { BOSUN_CALLER: 'model', get HOME(): never { reads++; throw Error('home read'); } },
    cwd: '/not-used',
    prompts: {
      async confirm() { assert.fail('model confirmation'); },
      async selectHost() { assert.fail('model host selection'); },
      async text() { assert.fail('model input'); },
    },
    write() { assert.fail('model output'); },
  });
  assert.equal(result.state, 'held');
  assert.equal(reads, 0);
});

for (const host of ['opencode', 'codex', 'claude'] as const)
  test(`${host} detected supported version replacement uses original undo before real-workspace replan`, async () => {
    const f = fixture();
    try {
      await f.install();
      const old = await f.profile(host);
      const config = footprint(f.paths.config);
      const next = { opencode: '2.1.0', codex: '0.162.0', claude: '2.2.0' }[host];
      f.native(host, next);
      f.prompts.confirm = async q => !['start', 'launch'].includes(q.kind);
      const result = await f.run(host);
      assert.equal(result.state, 'ready', result.message);
      assert.deepEqual(footprint(f.paths.config), config);
      const records = readRuntimeManifest(f.paths).hostProfiles!;
      assert.equal(records.find(p => p.id === old.record.id)!.state, 'undone');
      const current = records.find(p => p.state === 'ready')!;
      assert.equal(current.nativeVersion, next);
      assert.notEqual(current.id, old.record.id);
      assert.ok(fs.existsSync(old.root + '.retired'));
      if (host === 'codex') {
        assert.equal(current.skillWorkspace!.root, f.sb.home);
        for (const link of current.skillWorkspace!.links)
          assert.equal(fs.realpathSync(path.join(f.sb.home, '.agents', 'skills', link.name)), fs.realpathSync(path.resolve(f.sb.home, '.agents', 'skills', link.target)));
      }
      assert.deepEqual(f.sb.calls().map(c => c.argv), [['--version']]);
    } finally { f.sb.cleanup(); }
  });

test('unsupported detected major never retires or rewrites an existing prepared profile', async () => {
  const f = fixture();
  try {
    await f.install();
    await f.profile('omp');
    f.native('omp', '19.0.0');
    const before = footprint(f.paths.home);
    const result = await f.run('omp');
    assert.equal(result.state, 'held');
    assert.deepEqual(footprint(f.paths.home), before);
    assert.equal(f.questions.some(q => q.kind === 'profile'), false);
    assert.deepEqual(f.sb.calls().map(c => c.argv), [['--version']]);
  } finally { f.sb.cleanup(); }
});

for (const decision of ['decline-stop', 'decline-profile', 'unknown-stop', 'prepare'] as const)
  test(`owned service ${decision} uses approved nonreplay stop before profile changes and never silently restarts`, async () => {
    const f = fixture();
    let daemon: { close(): Promise<void> } | undefined;
    let running = false, starts = 0, stops = 0;
    const control: LaunchdControl = {
      domain: `gui/${process.getuid?.() ?? 501}`,
      async observe() { return { present: running, pid: running ? process.pid : null, exitStatus: null }; },
      async bootstrap() {
        starts++;
        daemon = await startDaemon({
          paths: f.paths, config: loadRuntimeConfig(f.paths, f.env), runners: {},
          environment: { ...f.env, BOSUN_INSTALLATION_ID: readRuntimeManifest(f.paths, { installationStatus: true }).installation!.id },
        });
        running = true;
      },
      async bootout() {
        stops++;
        await daemon!.close();
        daemon = undefined;
        running = false;
        if (decision === 'unknown-stop') throw Error('lost original stop acknowledgement');
      },
    };
    try {
      await f.install();
      const installed = installationStatus({ paths: f.paths, env: f.env }).record!;
      await controlInstallationService({ paths: f.paths, env: f.env, control }, {
        id: installed.id, expectedVersion: installed.version, hash: installed.planHash,
        requestId: 'seed-owned-service', operation: 'enable', clientsStopped: true,
      });
      assert.equal(installationStatus({ paths: f.paths, env: f.env }).record!.service.state, 'enabled');
      f.native('omp');
      const config = fs.readFileSync(f.paths.config);
      f.prompts.confirm = async q => {
        f.questions.push(q);
        if (q.kind === 'stop') return decision !== 'decline-stop';
        if (q.kind === 'profile') return decision !== 'decline-profile';
        return !['start', 'models', 'launch'].includes(q.kind);
      };
      const result = await runOnboardingWizard({ paths: f.paths, env: f.env, cwd: f.sb.home, binary: f.binary, prompts: f.prompts, write() {}, control });
      assert.equal(result.state, decision === 'prepare' ? 'ready' : decision === 'unknown-stop' ? 'held' : 'cancelled', result.message);
      assert.deepEqual(fs.readFileSync(f.paths.config), config);
      const manifest = readRuntimeManifest(f.paths, { installationStatus: true });
      assert.equal(manifest.installation!.service.state, decision === 'decline-stop' ? 'enabled' : decision === 'unknown-stop' ? 'unknown' : 'disabled');
      assert.equal(starts, 1, 'no automatic restart follows preparation, cancellation or an unknown stop');
      assert.equal(stops, decision === 'decline-stop' ? 0 : 1);
      assert.equal(manifest.hostProfiles?.length ?? 0, decision === 'prepare' ? 1 : 0);
      if (decision === 'decline-profile' || decision === 'prepare') assert.match(result.message, /owned background service stopped/);
      if (decision === 'unknown-stop') {
        const before = fs.readFileSync(f.paths.manifest);
        assert.equal((await f.run('omp')).state, 'held');
        assert.deepEqual(fs.readFileSync(f.paths.manifest), before);
        assert.equal(stops, 1);
      }
      assert.deepEqual(f.sb.calls().map(c => c.argv), [['--version']]);
    } finally { await daemon?.close(); f.sb.cleanup(); }
  });

for (const target of ['config', 'hookConfig'] as const)
  test(`lost ${target} publication acknowledgement holds with exact private original-config backup and no rollback`, async () => {
    const f = fixture();
    const rename = fs.renameSync;
    try {
      await f.install();
      f.native('omp');
      const original = fs.readFileSync(f.paths.config);
      f.prompts.text = async () => 'provider/reviewed-model';
      f.prompts.confirm = async q => !['start', 'launch'].includes(q.kind);
      let writes = 0;
      fs.renameSync = function(from, to) {
        const value = rename(from, to);
        if (String(to) === f.paths[target]) {
          writes++;
          throw Error('lost original publication acknowledgement');
        }
        return value;
      };
      const result = await f.run('omp');
      fs.renameSync = rename;
      assert.equal(result.state, 'held');
      assert.equal(writes, 1, 'the uncertain write is never retried');
      assert.match(result.message, /Original private configuration backup/);
      assert.match(result.message, /no rollback or repeat write/);
      const backups = fs.readdirSync(f.paths.artifacts).filter(name => name.startsWith('onboard-config-'));
      assert.equal(backups.length, 1);
      assert.deepEqual(fs.readFileSync(path.join(f.paths.artifacts, backups[0])), original);
      assert.equal(loadRuntimeConfig(f.paths, {}).roles.worker.omp!.model, 'provider/reviewed-model');
      assert.equal(readRuntimeManifest(f.paths).hostProfiles, undefined);
      assert.deepEqual(f.sb.calls().map(c => c.argv), [['--version']]);
    } finally { fs.renameSync = rename; f.sb.cleanup(); }
  });

for (const cancel of ['native-version', 'model-save'] as const)
  test(`caller cancellation at ${cancel} reports retained approvals and prevents the next mutation/native launch`, async () => {
    const f = fixture();
    const controller = new AbortController();
    try {
      await f.install();
      f.native('omp');
      const before = footprint(f.paths.home);
      f.prompts.text = async () => 'provider/exact-model';
      f.prompts.confirm = async q => {
        if (q.kind === cancel || cancel === 'model-save' && q.kind === 'models' && q.message.startsWith('Save'))
          controller.abort();
        return !['start', 'launch'].includes(q.kind);
      };
      const result = await runOnboardingWizard({ paths: f.paths, env: f.env, cwd: f.sb.home, binary: f.binary, prompts: f.prompts, signal: controller.signal, write() {} });
      assert.equal(result.state, 'cancelled');
      assert.equal(result.launch, undefined);
      assert.deepEqual(footprint(f.paths.home), before);
      assert.deepEqual(f.sb.calls().map(c => c.argv), cancel === 'native-version' ? [] : [['--version']]);
      const owner = new DaemonOwner(f.paths.owner);
      owner.close();
    } finally { f.sb.cleanup(); }
  });
