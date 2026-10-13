import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'smol-toml';
import { sandbox, fresh, gitRepo } from './helpers.ts';
import { runtimePaths } from '../src/platform/paths.ts';
import { parseRuntimeConfig } from '../src/platform/config.ts';
import { readRuntimeManifest } from '../src/platform/manifest.ts';
import { setupRuntime } from '../src/app/setup.ts';
import {
  planHostInstallation,
  applyHostInstallation,
  hostInstallationStatus,
  undoHostInstallation,
  hostPlanHash,
} from '../src/app/host-install.ts';
import { DaemonOwner } from '../src/platform/daemon-owner.ts';
import { profileDoctor } from '../src/platform/host-files.ts';
import { main } from '../src/app/cli.ts';
import { BosunError } from '../src/core/errors.ts';
import { createCodexHost } from '../src/adapters/hosts/codex/host.ts';
import { createClaudeHost } from '../src/adapters/hosts/claude/host.ts';
import { createOpenCodeHost } from '../src/adapters/hosts/opencode/host.ts';
import { createOmpHost } from '../src/adapters/hosts/omp/host.ts';
import { hostPlan, hostPlanSchema } from '../src/contracts/host-install.ts';

const code = (name: string) => (error: unknown) =>
  error instanceof BosunError && error.code === name;
const versions = { omp: '18.11.0', opencode: '2.1.0', codex: '0.162.0', claude: '2.2.0' } as const;
async function fixture() {
  const sb = sandbox({ stubs: ['bosun'] });
  fresh(sb);
  const env = sb.env();
  const paths = runtimePaths(env);
  const config = parseRuntimeConfig(`
[roles.worker.omp]
model = "openai-codex/gpt-6.1-sol"
effort = "high"
[roles.worker.opencode]
model = "example/owner-model"
effort = "high"
[roles.worker.codex]
model = "gpt-6.1-sol"
effort = "xhigh"
[roles.worker.claude]
model = "sonnet"
effort = "medium"
`);
  const initial = await setupRuntime(paths, config);
  const workspace = gitRepo(sb, 'workspace');
  const personal = path.join(sb.home, 'personal');
  fs.mkdirSync(personal, { mode: 0o700 });
  for (const [name, text] of [
    ['opencode.jsonc', '{/*owner-comment*/"model":"existing","plugin":["existing"]}'],
    ['codex.toml', 'model = "existing"\n'],
    ['hooks.json', '{"hooks":{"SessionStart":["owner-managed"]}}'],
    ['claude.json', '{"owner":true}'],
  ])
    fs.writeFileSync(path.join(personal, name), text, { mode: 0o600 });
  const originals = () =>
    Object.fromEntries(
      fs
        .readdirSync(personal)
        .map((name) => [name, fs.readFileSync(path.join(personal, name), 'utf8')]),
    );
  const before = originals();
  const options = { paths, config, binary: path.join(sb.bin, 'bosun'), workspace };
  return {
    sb,
    env,
    paths,
    config,
    initial,
    workspace,
    options,
    originals,
    before,
    plan: (hostId: keyof typeof versions, requestId: string = hostId) =>
      planHostInstallation(options, { hostId, nativeVersion: versions[hostId], requestId }),
    close: () => sb.cleanup(),
  };
}

for (const host of Object.keys(versions) as (keyof typeof versions)[])
  test(`${host} plan/apply/undo owns a private profile, native role/MCP configuration and canonical skill links without changing personal files`, async () => {
    const f = await fixture();
    try {
      const manifest = fs.readFileSync(f.paths.manifest, 'utf8');
      const plan = await f.plan(host);
      assert.equal(fs.existsSync(path.join(f.paths.home, 'host-profiles')), false);
      assert.equal(fs.readFileSync(f.paths.manifest, 'utf8'), manifest);
      assert.equal(plan.planHash, hostPlanHash(plan));
      assert.ok(plan.changes.every((change) => ['write', 'link'].includes(change.op)));
      assert.equal(hostPlanSchema.safeParse(plan).success, true);
      const result = await applyHostInstallation(f.options, plan, plan.planHash);
      assert.equal(result.record.state, 'ready');
      assert.equal(result.tree.complete, true);
      assert.equal(result.tree.matches, true);
      assert.equal(result.nativeQualification, 'unverified');
      const shared = path.join(result.root, 'shared', 'skills', 'bosun-codex', 'SKILL.md');
      assert.equal(
        fs.realpathSync(path.join(result.root, 'skills', 'bosun-codex', 'SKILL.md')),
        shared,
      );
      assert.equal(fs.statSync(shared).mode & 0o777, 0o600);
      assert.equal(fs.statSync(result.root).mode & 0o777, 0o700);
      if (host === 'opencode') {
        const native = JSON.parse(fs.readFileSync(path.join(result.root, 'opencode.json'), 'utf8'));
        assert.deepEqual(native.agents.bosun_worker.model,
          { providerID: 'example', model: 'owner-model', variant: 'high' });
        assert.ok(native.agents.bosun_reviewer.permissions.some((rule: { action: string; effect: string }) =>
          rule.action === '*' && rule.effect === 'deny'));
        assert.equal(native.model, undefined);
        assert.equal(native.providers, undefined);
        assert.deepEqual(native.plugins, [path.join(result.root, 'plugin')]);
        assert.deepEqual(native.mcp.servers.bosun.command, [f.options.binary, 'mcp']);
        assert.equal(native.mcp.servers.bosun.environment.BOSUN_HOME, f.paths.home);
        assert.deepEqual(native.skills, [path.join(result.root, 'shared', 'skills')]);
        assert.deepEqual(plan.launch.args, ['--standalone']);
        assert.deepEqual(plan.launch.env, {
          OPENCODE_CONFIG: path.join(result.root, 'opencode.json'),
          OPENCODE_CONFIG_CONTENT: fs.readFileSync(path.join(result.root, 'opencode.json'), 'utf8'),
          BOSUN_CALLER: 'model',
        });
        assert.ok(plan.launch.env.OPENCODE_CONFIG_CONTENT.length > 4096);
        assert.equal(Object.hasOwn(plan.launch.env, 'OPENCODE_CONFIG_DIR'), false);
      } else if (host === 'codex') {
        const native = parse(
          fs.readFileSync(path.join(result.root, 'agents', 'bosun_worker.toml'), 'utf8'),
        );
        assert.equal(native.model, 'gpt-6.1-sol');
        assert.equal(native.model_reasoning_effort, 'xhigh');
        assert.equal(
          parse(fs.readFileSync(path.join(result.root, 'agents', 'bosun_reviewer.toml'), 'utf8'))
            .sandbox_mode,
          'read-only',
        );
        assert.ok(plan.launch.args.includes(`mcp_servers.bosun.command=${JSON.stringify(f.options.binary)}`));
        assert.ok(plan.launch.args.includes('mcp_servers.bosun.args=["mcp"]'));
        assert.ok(
          !plan.launch.args.some((arg) =>
            /^(?:hooks(?:\.|=)|features\.hooks=|auth(?:\.|=)|model=)/.test(arg),
          ),
        );
        assert.deepEqual(plan.launch.env, { BOSUN_CALLER: 'model' });
        assert.ok(!plan.launch.args.some((arg) => arg.startsWith('skills.config=')));
        assert.equal(
          fs.realpathSync(path.join(f.workspace, '.agents', 'skills', 'bosun-codex', 'SKILL.md')),
          shared,
        );
        assert.equal(result.projectSkills?.complete, true);
      } else if (host === 'claude') {
        const native = JSON.parse(fs.readFileSync(path.join(result.root, '.mcp.json'), 'utf8'));
        assert.equal(native.mcpServers.bosun.command, f.options.binary);
        assert.deepEqual(native.mcpServers.bosun.args, ['mcp']);
        const worker = fs.readFileSync(path.join(result.root, 'agents', 'bosun_worker.md'), 'utf8');
        assert.match(worker, /model: "sonnet"/);
        assert.match(worker, /effort: "medium"/);
        const reviewer = fs.readFileSync(
          path.join(result.root, 'agents', 'bosun_reviewer.md'),
          'utf8',
        );
        assert.match(reviewer, /tools: Read, Grep, Glob/);
        assert.doesNotMatch(reviewer, /permissionMode:|^hooks:|^mcpServers:/m);
        assert.deepEqual(plan.launch.args, [
          '--plugin-dir',
          result.root,
          '--append-system-prompt-file',
          path.join(result.root, 'shared', 'policy.md'),
        ]);
      } else {
        const worker = fs.readFileSync(path.join(result.root, 'agents', 'bosun_worker.md'), 'utf8');
        assert.match(worker, /model: \["openai-codex\/gpt-6\.1-sol"\]/);
        assert.match(worker, /thinkingLevel: "high"/);
        const reviewer = fs.readFileSync(path.join(result.root, 'agents', 'bosun_reviewer.md'), 'utf8');
        assert.match(reviewer, /tools: \["read","glob","grep"\]/);
        assert.deepEqual(plan.launch.args, ['--no-extensions', '--extension', result.root,
          '--append-system-prompt', path.join(result.root, 'shared', 'policy.md')]);
      }
      const after = readRuntimeManifest(f.paths);
      assert.equal(after.sourceId, f.initial.sourceId);
      assert.equal(after.installationId, f.initial.installationId);
      assert.equal(after.memorySchema, f.initial.memorySchema);
      assert.equal(after.hostProfiles?.length, 1);
      assert.deepEqual(f.originals(), f.before);
      assert.equal(f.sb.calls().length, 0);
      const duplicate = await applyHostInstallation(
        f.options,
        {
          privacy: 'public',
          requestId: plan.requestId,
          get changes() {
            throw Error('duplicate getter');
          },
        },
        'not-the-original-hash',
      );
      assert.equal(duplicate.duplicate, true);
      assert.equal(duplicate.record.id, result.record.id);
      const undone = undoHostInstallation(f.options, result.record.id, result.record.version);
      assert.equal(undone.record.state, 'undone');
      assert.equal(fs.existsSync(result.root), false);
      assert.equal(undone.tree.complete, true);
      if (host === 'codex') assert.equal(fs.existsSync(path.join(f.workspace, '.agents')), false);
      assert.deepEqual(f.originals(), f.before);
      assert.equal(f.sb.calls().length, 0);
      assert.equal(undoHostInstallation(f.options, result.record.id, 0).duplicate, true);
    } finally {
      f.close();
    }
  });

test('only supported OpenCode 2 standalone overlays exceed ordinary launch environment bounds in plans and receipts', async () => {
  const f = await fixture();
  try {
    const plan = await f.plan('opencode');
    const invalid = [
      { ...plan, hostId: 'claude' },
      { ...plan, nativeVersion: '1.18.34' },
      { ...plan, launch: { ...plan.launch, args: [] } },
      { ...plan, launch: { ...plan.launch, env: { ...plan.launch.env, EXTRA: 'owner' } } },
      { ...plan, launch: { ...plan.launch, env: {
        ...plan.launch.env, OPENCODE_CONFIG_CONTENT: ' '.repeat(131073),
      } } },
      { ...plan, launch: { ...plan.launch, env: {
        ...plan.launch.env, OPENCODE_CONFIG_CONTENT: '[]',
      } } },
      { ...plan, launch: { ...plan.launch, env: {
        ...plan.launch.env, OPENCODE_CONFIG_CONTENT: plan.launch.env.OPENCODE_CONFIG_CONTENT + '\0',
      } } },
      { ...plan, launch: { ...plan.launch, env: {
        ...plan.launch.env, OPENCODE_CONFIG: '/owned/\nprofile',
      } } },
    ];
    for (const input of invalid) {
      assert.equal(hostPlanSchema.safeParse(input).success, false);
      assert.throws(() => hostPlan(input), code('invalid'));
    }
    const ordinary = await f.plan('claude');
    assert.equal(hostPlanSchema.safeParse({
      ...ordinary, launch: { ...ordinary.launch, env: { EXTRA: 'x'.repeat(4097) } },
    }).success, false);
    const privateOverlay = {
      ...plan, launch: { ...plan.launch, env: {
        ...plan.launch.env,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ credential: 'sk-proj-' + 'x'.repeat(64) }),
      } },
    };
    assert.throws(() => hostPlan(privateOverlay), code('private_input'));
    const installed = await applyHostInstallation(f.options, plan, plan.planHash);
    assert.deepEqual(readRuntimeManifest(f.paths).hostProfiles?.[0].launch, plan.launch);
    const validManifest = fs.readFileSync(f.paths.manifest, 'utf8');
    for (const input of invalid) {
      const changed = JSON.parse(validManifest);
      Object.assign(changed.hostProfiles[0], {
        hostId: input.hostId, nativeVersion: input.nativeVersion, launch: input.launch,
      });
      fs.writeFileSync(f.paths.manifest, JSON.stringify(changed), { mode: 0o600 });
      assert.throws(() => readRuntimeManifest(f.paths), code('unavailable'));
    }
    fs.writeFileSync(f.paths.manifest, validManifest, { mode: 0o600 });
    const status = hostInstallationStatus(f.options, installed.record.id);
    assert.ok('record' in status);
    assert.equal(status.outcome, 'ready');
  } finally {
    f.close();
  }
});

test('private, credential, stale, unsupported or modified plans have no profile/configuration effect', async () => {
  const f = await fixture();
  try {
    const plan = await f.plan('opencode');
    const before = fs.readFileSync(f.paths.manifest, 'utf8');
    await assert.rejects(
      () =>
        applyHostInstallation(
          f.options,
          {
            privacy: 'private',
            get requestId() {
              throw Error('private getter');
            },
          },
          plan.planHash,
        ),
      code('private_input'),
    );
    await assert.rejects(
      () => applyHostInstallation(f.options, plan, '0'.repeat(64)),
      code('conflict'),
    );
    const modified = {
      ...plan,
      changes: [
        ...plan.changes,
        { op: 'write' as const, path: 'unexpected.js', text: 'unreviewed' },
      ],
    };
    modified.planHash = hostPlanHash(modified);
    await assert.rejects(
      () => applyHostInstallation(f.options, modified, modified.planHash),
      code('conflict'),
    );
    const secret = { ...plan, requestId: 'sk-proj-' + 'x'.repeat(64) };
    await assert.rejects(
      () => applyHostInstallation(f.options, secret, secret.planHash),
      code('private_input'),
    );
    await assert.rejects(
      () =>
        planHostInstallation(f.options, {
          hostId: 'codex',
          nativeVersion: '1.0.0',
          requestId: 'unsupported',
        }),
      code('unsupported'),
    );
    const changed = {
      ...f.options,
      config: parseRuntimeConfig('[roles.worker.opencode]\nmodel="changed/model"'),
    };
    await assert.rejects(
      () => applyHostInstallation(changed, plan, plan.planHash),
      code('conflict'),
    );
    assert.equal(fs.readFileSync(f.paths.manifest, 'utf8'), before);
    assert.equal(fs.existsSync(path.join(f.paths.home, 'host-profiles')), false);
    assert.deepEqual(f.originals(), f.before);
  } finally {
    f.close();
  }
});

test('running daemon authority prevents installation and stale plan/undo versions preserve original profiles', async () => {
  const f = await fixture();
  try {
    const first = await f.plan('opencode');
    const stale = await f.plan('claude');
    const owner = new DaemonOwner(f.paths.owner);
    try {
      await assert.rejects(
        () => applyHostInstallation(f.options, first, first.planHash),
        code('unavailable'),
      );
      assert.equal(fs.existsSync(path.join(f.paths.home, 'host-profiles')), false);
    } finally {
      owner.close();
    }
    const installed = await applyHostInstallation(f.options, first, first.planHash);
    await assert.rejects(
      () => applyHostInstallation(f.options, stale, stale.planHash),
      code('conflict'),
    );
    assert.throws(
      () => undoHostInstallation(f.options, installed.record.id, installed.record.version - 1),
      code('conflict'),
    );
    assert.equal(fs.existsSync(installed.root), true);
  } finally {
    f.close();
  }
});

for (const kind of ['content', 'extra-file', 'symlink', 'hardlink', 'mode'] as const)
  test(`undo refuses ${kind} drift and preserves the profile and unrelated data`, async () => {
    const f = await fixture();
    try {
      const plan = await f.plan('claude');
      const result = await applyHostInstallation(f.options, plan, plan.planHash);
      const target = path.join(result.root, 'shared', 'policy.md');
      if (kind === 'content') fs.appendFileSync(target, 'owner changed this');
      else if (kind === 'extra-file')
        fs.writeFileSync(path.join(result.root, 'owner.txt'), 'owner data', { mode: 0o600 });
      else if (kind === 'symlink') {
        fs.unlinkSync(target);
        fs.symlinkSync(path.join(f.sb.home, 'personal', 'hooks.json'), target);
      } else if (kind === 'hardlink') fs.linkSync(target, path.join(f.sb.home, 'other-link'));
      else fs.chmodSync(target, 0o644);
      const before = fs.readFileSync(f.paths.manifest, 'utf8');
      assert.throws(
        () => undoHostInstallation(f.options, result.record.id, result.record.version),
        code('conflict'),
      );
      assert.equal(fs.readFileSync(f.paths.manifest, 'utf8'), before);
      assert.equal(fs.existsSync(result.root), true);
      assert.deepEqual(f.originals(), f.before);
    } finally {
      f.close();
    }
  });

test('lost positive profile rename receipt stays unknown, duplicate apply does not recreate, and explicit verified undo retires it', async () => {
  const f = await fixture();
  const original = fs.renameSync;
  try {
    const plan = await f.plan('codex');
    let effects = 0;
    fs.renameSync = function (from, to) {
      const result = original(from, to);
      if (String(from).endsWith('.stage')) {
        effects++;
        throw Error('lost native rename receipt');
      }
      return result;
    };
    await assert.rejects(
      () => applyHostInstallation(f.options, plan, plan.planHash),
      (error) => error instanceof BosunError && error.details?.outcome === 'unknown',
    );
    fs.renameSync = original;
    const result = hostInstallationStatus(f.options, plan.id);
    assert.ok('record' in result);
    assert.equal(result.record.state, 'unknown');
    assert.equal(result.tree.complete, true);
    const duplicate = await applyHostInstallation(f.options, plan, plan.planHash);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.record.state, 'unknown');
    assert.equal(effects, 1);
    const undone = undoHostInstallation(f.options, plan.id, result.record.version);
    assert.equal(undone.record.state, 'undone');
    assert.equal(undone.tree.complete, true);
    assert.deepEqual(f.originals(), f.before);
  } finally {
    fs.renameSync = original;
    f.close();
  }
});

test('partial install receipt loss retains mismatched staged files for review without changing outside data', async () => {
  const f = await fixture();
  const original = fs.writeFileSync;
  try {
    const plan = await f.plan('opencode');
    let writes = 0;
    fs.writeFileSync = function (file, data, ...args: any[]) {
      if (typeof file === 'number' && ++writes === 4) throw Error('interrupted profile write');
      return (original as any)(file, data, ...args);
    } as typeof fs.writeFileSync;
    await assert.rejects(
      () => applyHostInstallation(f.options, plan, plan.planHash),
      (error) => error instanceof BosunError && error.details?.outcome === 'unknown',
    );
    fs.writeFileSync = original;
    const result = hostInstallationStatus(f.options, plan.id);
    assert.ok('record' in result);
    assert.equal(result.outcome, 'unknown');
    assert.equal(result.stage.matches, false);
    assert.throws(
      () => undoHostInstallation(f.options, plan.id, result.record.version),
      code('conflict'),
    );
    assert.deepEqual(f.originals(), f.before);
  } finally {
    fs.writeFileSync = original;
    f.close();
  }
});

for (const commit of [1, 2])
  test(`lost ${commit === 1 ? 'intent' : 'terminal'} manifest receipt returns the saved original and never recreates a host profile`, async () => {
    const f = await fixture();
    const original = fs.renameSync;
    try {
      const plan = await f.plan('opencode');
      let receipts = 0;
      let creations = 0;
      fs.renameSync = function (from, to) {
        const result = original(from, to);
        if (String(from).endsWith('.stage')) creations++;
        if (String(to) === f.paths.manifest && ++receipts === commit)
          throw Error('lost manifest receipt');
        return result;
      };
      await assert.rejects(
        () => applyHostInstallation(f.options, plan, plan.planHash),
        (error) => error instanceof BosunError && error.details?.outcome === 'unknown',
      );
      fs.renameSync = original;
      const status = hostInstallationStatus(f.options, plan.id);
      assert.ok('record' in status);
      assert.equal(status.record.state, commit === 1 ? 'applying' : 'ready');
      assert.equal(status.tree.exists, commit === 2);
      assert.equal(creations, commit === 1 ? 0 : 1);
      const duplicate = await applyHostInstallation(f.options, plan, plan.planHash);
      assert.equal(duplicate.duplicate, true);
      assert.equal(duplicate.record.state, status.record.state);
      const undone = undoHostInstallation(f.options, plan.id, status.record.version);
      assert.equal(undone.record.state, 'undone');
      assert.deepEqual(f.originals(), f.before);
    } finally {
      fs.renameSync = original;
      f.close();
    }
  });

test('metadata detection/session parsing never executes native hosts or classifies unknown prompts as public', async () => {
  const f = await fixture();
  try {
    for (const host of [createOmpHost(), createOpenCodeHost(), createCodexHost(), createClaudeHost()]) {
      await host.detect(f.env);
      assert.equal(host.caps.promptHook, 'unverified');
      assert.equal(host.control, undefined);
      assert.equal(
        host.hook.parse(JSON.stringify({ prompt: 'unclassified', cwd: f.workspace }), f.env),
        null,
      );
      assert.equal(
        host.hook.parse(
          JSON.stringify({
            host: host.id,
            privacy: 'public',
            prompt: 'sk-proj-' + 's'.repeat(64),
            cwd: f.workspace,
          }),
          f.env,
        ),
        null,
      );
      assert.equal(
        host.hook.parse(
          JSON.stringify({
            host: host.id,
            privacy: 'public',
            prompt: 'public test',
            cwd: f.workspace,
            session_id: 'fixture',
          }),
          f.env,
        )?.privacy,
        'public',
      );
    }
    assert.equal(f.sb.calls().length, 0);
  } finally {
    f.close();
  }
});

test('profile doctor refuses rebound parent directories before reading foreign payloads', async () => {
  const f = await fixture();
  const original = fs.readFileSync;
  try {
    const plan = await f.plan('opencode');
    const installed = await applyHostInstallation(f.options, plan, plan.planHash);
    assert.ok((await profileDoctor(installed.root, plan.changes)).every((check) => check.ok));
    const foreign = path.join(f.sb.home, 'personal');
    fs.writeFileSync(path.join(foreign, 'policy.md'), 'private foreign canary', { mode: 0o600 });
    fs.renameSync(
      path.join(installed.root, 'shared'),
      path.join(installed.root, 'shared-original'),
    );
    fs.symlinkSync(foreign, path.join(installed.root, 'shared'));
    let reads = 0;
    fs.readFileSync = function (file: fs.PathOrFileDescriptor, ...args: any[]) {
      if (String(file).startsWith(foreign + path.sep)) {
        reads++;
        throw Error('foreign payload read');
      }
      return (original as any)(file, ...args);
    } as typeof fs.readFileSync;
    const checks = await profileDoctor(installed.root, plan.changes);
    assert.equal(checks.find((check) => check.label === 'shared/policy.md')?.ok, false);
    assert.equal(reads, 0);
  } finally {
    fs.readFileSync = original;
    f.close();
  }
});

test('actual Commander plan export refuses overwrite, requires reviewed apply and denies model mutation before file reads', async () => {
  const f = await fixture();
  try {
    async function cli(args: string[], extra: Record<string, string> = {}) {
      let out = '',
        err = '';
      const code = await main(args, {
        env: { ...f.env, ...extra },
        cwd: f.workspace,
        stdout: (text) => (out += text),
        stderr: (text) => (err += text),
      });
      return { code, out, err };
    }
    const file = path.join(f.sb.home, 'host-plan.json');
    const planned = await cli([
      'host',
      'plan',
      'opencode',
      '--native-version',
      versions.opencode,
      '--request-id',
      'cli',
      '--binary',
      f.options.binary,
      '--output',
      file,
    ]);
    assert.equal(planned.code, 0, planned.err);
    const plan = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(
      (
        await cli([
          'host',
          'plan',
          'opencode',
          '--native-version',
          versions.opencode,
          '--request-id',
          'other',
          '--binary',
          f.options.binary,
          '--output',
          file,
        ])
      ).code,
      1,
    );
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).planHash, plan.planHash);
    assert.equal(
      (
        await cli(['host', 'apply', '/not-a-readable-plan', '--hash', plan.planHash], {
          BOSUN_CALLER: 'model',
        })
      ).code,
      1,
    );
    const applied = await cli(['host', 'apply', file, '--hash', plan.planHash]);
    assert.equal(applied.code, 0, applied.err);
    const record = JSON.parse(applied.out).record;
    const status = await cli(['host', 'status', record.id]);
    assert.equal(status.code, 0, status.err);
    assert.equal(JSON.parse(status.out).record.state, 'ready');
    const undone = await cli(['host', 'undo', record.id, '--version', String(record.version)]);
    assert.equal(undone.code, 0, undone.err);
    assert.equal(JSON.parse(undone.out).record.state, 'undone');
    assert.deepEqual(f.originals(), f.before);
    assert.equal(f.sb.calls().length, 0);
  } finally {
    f.close();
  }
});

test('Codex reuses matching user project skills, preserves unrelated files and never owns their removal', async () => {
  const f = await fixture();
  try {
    const probe = await f.plan('codex', 'probe');
    const source = probe.changes.find(
      (change) => change.path === 'shared/skills/bosun-codex/SKILL.md',
    );
    assert.ok(source && source.op === 'write');
    const folder = path.join(f.workspace, '.agents', 'skills', 'bosun-codex');
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(folder, 'SKILL.md'), source.text, { mode: 0o600 });
    const ownerFile = path.join(f.workspace, '.agents', 'owner.txt');
    fs.writeFileSync(ownerFile, 'owner data', { mode: 0o600 });
    const plan = await f.plan('codex');
    assert.equal(
      plan.skillWorkspace?.links.find((link) => link.name === 'bosun-codex')?.create,
      false,
    );
    const installed = await applyHostInstallation(f.options, plan, plan.planHash);
    assert.equal(installed.projectSkills?.complete, true);
    const undone = undoHostInstallation(f.options, installed.record.id, installed.record.version);
    assert.equal(undone.record.state, 'undone');
    assert.equal(fs.readFileSync(path.join(folder, 'SKILL.md'), 'utf8'), source.text);
    assert.equal(fs.readFileSync(ownerFile, 'utf8'), 'owner data');
    assert.equal(fs.existsSync(path.join(f.workspace, '.agents', 'skills', 'bosun-build')), false);
  } finally {
    f.close();
  }
});

test('changed project skill links hold undo and a new request cannot adopt links owned by another profile', async () => {
  const f = await fixture();
  try {
    const plan = await f.plan('codex');
    const installed = await applyHostInstallation(f.options, plan, plan.planHash);
    await assert.rejects(() => f.plan('codex', 'another-profile'), code('conflict'));
    const link = path.join(f.workspace, '.agents', 'skills', 'bosun-codex');
    fs.unlinkSync(link);
    fs.symlinkSync(path.join(f.sb.home, 'personal'), link);
    const before = fs.readFileSync(f.paths.manifest, 'utf8');
    assert.throws(
      () => undoHostInstallation(f.options, installed.record.id, installed.record.version),
      code('conflict'),
    );
    assert.equal(fs.readFileSync(f.paths.manifest, 'utf8'), before);
    assert.equal(fs.existsSync(installed.root), true);
    assert.deepEqual(f.originals(), f.before);
  } finally {
    f.close();
  }
});

test('lost project skill link receipt remains unknown without recreation and explicit undo removes only matching new links', async () => {
  const f = await fixture();
  const original = fs.symlinkSync;
  try {
    const plan = await f.plan('codex');
    let links = 0;
    fs.symlinkSync = function (target, file, ...args: any[]) {
      const result = (original as any)(target, file, ...args);
      if (String(file).startsWith(f.workspace + path.sep)) {
        links++;
        throw Error('lost project link receipt');
      }
      return result;
    } as typeof fs.symlinkSync;
    await assert.rejects(
      () => applyHostInstallation(f.options, plan, plan.planHash),
      (error) => error instanceof BosunError && error.details?.outcome === 'unknown',
    );
    fs.symlinkSync = original;
    const status = hostInstallationStatus(f.options, plan.id);
    assert.ok('record' in status);
    assert.equal(status.record.state, 'unknown');
    assert.equal(status.projectSkills?.matches, true);
    assert.equal(status.projectSkills?.complete, false);
    const duplicate = await applyHostInstallation(f.options, plan, plan.planHash);
    assert.equal(duplicate.duplicate, true);
    assert.equal(links, 1);
    const undone = undoHostInstallation(f.options, plan.id, status.record.version);
    assert.equal(undone.record.state, 'undone');
    assert.equal(fs.existsSync(path.join(f.workspace, '.agents')), false);
    assert.deepEqual(f.originals(), f.before);
  } finally {
    fs.symlinkSync = original;
    f.close();
  }
});
