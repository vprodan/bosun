import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import childProcess, { type ChildProcess, type SpawnOptions } from 'node:child_process';
import { sandbox, fresh, BIN, bosun } from './helpers.ts';
import { runtimePaths } from '../src/platform/paths.ts';
import { parseRuntimeConfig } from '../src/platform/config.ts';
import { setupRuntime } from '../src/app/setup.ts';
import {
  planHostInstallation,
  applyHostInstallation,
  hostLaunchPlan,
} from '../src/app/host-install.ts';
import { launchHost } from '../src/app/host-launch.ts';
import { main } from '../src/app/cli.ts';
import type { HostId } from '../src/core/domain/config.ts';
import { BosunError } from '../src/core/errors.ts';

const versions = { omp: '18.10.3', opencode: '2.0.27', codex: '0.161.0', claude: '2.1.292' };
async function fixture(hostId: HostId = 'opencode') {
  const sb = sandbox({ stubs: ['bosun', 'omp', 'opencode2', 'codex', 'claude'] });
  fresh(sb);
  const env = sb.env({
    BOSUN_SESSION_ID: 'parent-session',
    CODEX_THREAD_ID: 'parent-thread',
    CLAUDECODE: '1',
  });
  const paths = runtimePaths(env),
    config = parseRuntimeConfig('', env),
    cwd = sb.home;
  await setupRuntime(paths, config);
  const options = { paths, config, binary: path.join(sb.bin, 'bosun'), env, cwd, workspace: cwd };
  const plan = await planHostInstallation(options, {
    hostId,
    nativeVersion: versions[hostId],
    requestId: `launch-${hostId}`,
  });
  const installed = await applyHostInstallation(options, plan, plan.planHash);
  const args = [
    'host',
    'launch',
    installed.record.id,
    '--version',
    String(installed.record.version),
    '--hash',
    installed.record.planHash,
  ];
  return { sb, env, paths, config, options, plan, installed, args, hostId };
}
function native(
  f: Awaited<ReturnType<typeof fixture>>,
  options: { version?: string; code?: number; probe?: string; body?: string } = {},
) {
  const version = options.version ?? versions[f.hostId];
  const reply =
    f.hostId === 'codex'
      ? `codex-cli ${version}`
      : f.hostId === 'claude'
        ? `${version} (Claude Code)`
        : f.hostId === 'omp' ? 'omp/' + version : version;
  const selectedKeys = [
    'BOSUN_HOME',
    'BOSUN_CALLER',
    'BOSUN_SESSION_ID',
    'CODEX_HOME',
    'CODEX_THREAD_ID',
    'CLAUDE_CONFIG_DIR',
    'CLAUDECODE',
    'OPENCODE_CONFIG',
    'OPENCODE_CONFIG_DIR',
    'OPENCODE_CONFIG_CONTENT',
  ];
  const script = `#!/usr/bin/env bun
const fs=require('node:fs'); const argv=process.argv.slice(2);
const event={argv,cwd:process.cwd(),stdin:fs.readFileSync(0,'utf8'),env:Object.fromEntries(${JSON.stringify(selectedKeys)}.map(key=>[key,process.env[key]??null]))};
fs.appendFileSync(process.env.STUB_OUT,JSON.stringify(event)+'\\n');
if(argv.includes('--version')) { ${options.probe ?? ''}; process.stdout.write(${JSON.stringify(reply + '\n')}); }
else { ${options.body ?? `process.stdout.write('native_ui\\n'); process.exit(${options.code ?? 0});`} }
`;
  fs.writeFileSync(path.join(f.sb.bin, f.hostId === 'opencode' ? 'opencode2' : f.hostId), script, { mode: 0o755 });
}
const conflict = (error: unknown) => error instanceof BosunError && error.code === 'conflict';

for (const hostId of ['omp', 'opencode', 'codex', 'claude'] as const) {
  test(`${hostId} preview performs no native call and explicit launch preserves selected native homes/model precedence, terminal input and exit`, async () => {
    const f = await fixture(hostId);
    try {
      native(f, { code: 7 });
      const before = fs.readFileSync(f.paths.manifest);
      const preview = await bosun([...f.args, '--preview'], { env: f.env, cwd: f.sb.home });
      assert.equal(preview.code, 0, preview.err);
      const recipe = JSON.parse(preview.out);
      assert.equal(recipe.managedControl, 'unverified');
      assert.equal(recipe.env.BOSUN_CALLER, 'model');
      assert.equal(recipe.env.BOSUN_HOME, f.paths.home);
      assert.equal(recipe.args.includes('--model') || recipe.args.includes('-m'), false);
      assert.equal(f.sb.calls().length, 0);
      const result = await bosun(f.args, {
        env: f.env,
        cwd: f.sb.home,
        input: 'literal $(no-shell) input\n',
      });
      assert.equal(result.code, 7, result.err);
      assert.equal(result.out, 'native_ui\n');
      const calls = f.sb.calls();
      assert.deepEqual(
        calls.map((call) => call.argv),
        [['--version'], recipe.args],
      );
      assert.equal(calls[1].stdin, 'literal $(no-shell) input\n');
      assert.equal(calls[1].cwd, f.sb.home);
      assert.equal(calls[1].env.BOSUN_HOME, f.paths.home);
      assert.equal(calls[1].env.BOSUN_CALLER, 'model');
      assert.equal(calls[1].env.BOSUN_SESSION_ID, null);
      if (hostId === 'codex') {
        assert.equal(calls[1].env.CODEX_HOME, f.env.BOSUN_CODEX_HOME);
        assert.equal(calls[1].env.CODEX_THREAD_ID, null);
      } else if (hostId === 'claude') {
        assert.equal(calls[1].env.CLAUDE_CONFIG_DIR, f.env.CLAUDE_CONFIG_DIR);
        assert.equal(calls[1].env.CLAUDECODE, null);
      } else if (hostId === 'opencode') {
        assert.equal(calls[1].env.OPENCODE_CONFIG, path.join(f.installed.root, 'opencode.json'));
        assert.equal(calls[1].env.OPENCODE_CONFIG_DIR, f.env.OPENCODE_CONFIG_DIR);
        assert.equal(calls[1].env.OPENCODE_CONFIG_CONTENT, fs.readFileSync(path.join(f.installed.root, 'opencode.json'), 'utf8'));
      } else {
        assert.ok(calls[1].argv.includes('--extension'));
        assert.ok(calls[1].argv.includes(f.installed.root));
      }
      assert.deepEqual(fs.readFileSync(f.paths.manifest), before);
    } finally {
      f.sb.cleanup();
    }
  });
}

test('guided launch selects only the reviewed host profile, previews without native probes and decline preserves original receipts', async () => {
  const f = await fixture('omp');
  try {
    native(f); const before = fs.readFileSync(f.paths.manifest);
    const preview = await bosun(['host', 'launch', '--preview'], { env: f.env, cwd: f.sb.home });
    assert.equal(preview.code, 0, preview.err);
    assert.equal(JSON.parse(preview.out).id, f.installed.record.id);
    assert.deepEqual(f.sb.calls(), []);
    let questions = 0;
    const declined = await main(['host', 'launch'], { env: f.env, cwd: f.sb.home, terminal: true,
      installConfirm: async () => { questions++; return false; }, stdout() {}, stderr() {},
    });
    assert.equal(declined, 0); assert.equal(questions, 1);
    assert.deepEqual(fs.readFileSync(f.paths.manifest), before); assert.deepEqual(f.sb.calls(), []);
    const piped = await bosun(['host', 'launch'], { env: f.env, cwd: f.sb.home });
    assert.equal(piped.code, 1); assert.equal(JSON.parse(piped.err).error.code, 'unsupported');
    assert.deepEqual(f.sb.calls(), []);
  } finally { f.sb.cleanup(); }
});

test('native version mismatch, ambiguous version output and nonzero probe cannot launch a UI or substitute a host', async () => {
  const f = await fixture('codex');
  try {
    for (const version of ['0.162.0', '0.160.0', '0.161.0\nextra']) {
      f.sb.reset();
      native(f, { version });
      const result = await bosun(f.args, { env: f.env, cwd: f.sb.home });
      assert.equal(result.code, 1);
      assert.equal(JSON.parse(result.err).error.code, 'unverified');
      assert.deepEqual(
        f.sb.calls().map((call) => call.argv),
        [['--version']],
      );
    }
    f.sb.reset();
    native(f, { probe: 'process.exitCode=2' });
    const result = await bosun(f.args, { env: f.env, cwd: f.sb.home });
    assert.equal(result.code, 1);
    assert.equal(f.sb.calls().length, 1);
  } finally {
    f.sb.cleanup();
  }
});

test('profile, configuration, receipt, workspace and review drift hold before native probes', async () => {
  const f = await fixture('codex');
  try {
    native(f);
    const p = f.installed.record;
    for (const [version, hash] of [
      [p.version + 1, p.planHash],
      [p.version, '0'.repeat(64)],
    ] as const)
      await assert.rejects(hostLaunchPlan(f.options, p.id, version, hash), conflict);
    const other = path.join(f.sb.root, 'other');
    fs.mkdirSync(other);
    await assert.rejects(
      hostLaunchPlan({ ...f.options, cwd: other }, p.id, p.version, p.planHash),
      conflict,
    );
    const changed = parseRuntimeConfig('', {
      ...f.env,
      BOSUN_ROLE_WORKER_CODEX_MODEL: 'exact-new-model',
    });
    await assert.rejects(
      hostLaunchPlan({ ...f.options, config: changed }, p.id, p.version, p.planHash),
      conflict,
    );
    const saved = fs.readFileSync(f.paths.manifest, 'utf8');
    const changedReceipt = JSON.parse(saved);
    changedReceipt.hostProfiles[0].launch.args.push('--unsafe');
    fs.writeFileSync(f.paths.manifest, JSON.stringify(changedReceipt));
    await assert.rejects(hostLaunchPlan(f.options, p.id, p.version, p.planHash), conflict);
    fs.writeFileSync(f.paths.manifest, saved);
    fs.appendFileSync(path.join(f.installed.root, 'shared', 'policy.md'), 'changed');
    await assert.rejects(
      launchHost(f.options, p.id, p.version, p.planHash, new AbortController().signal),
      conflict,
    );
    assert.equal(f.sb.calls().length, 0);
  } finally {
    f.sb.cleanup();
  }
});

test('drift during version inspection is rechecked before foreground effects, including executable replacement', async () => {
  for (const mutateBinary of [false, true]) {
    const f = await fixture();
    try {
      const target = mutateBinary
        ? path.join(f.sb.bin, f.hostId === 'opencode' ? 'opencode2' : f.hostId)
        : path.join(f.installed.root, 'shared', 'policy.md');
      native(f, { probe: `fs.appendFileSync(${JSON.stringify(target)},'\\n// changed source')` });
      const result = await bosun(f.args, { env: f.env, cwd: f.sb.home });
      assert.equal(result.code, 3);
      assert.equal(JSON.parse(result.err).error.code, 'conflict');
      assert.equal(f.sb.calls().length, 1);
    } finally {
      f.sb.cleanup();
    }
  }
});

test('model and malformed launch requests reject before home/config/secret getters; preview never reads auth', async () => {
  const f = await fixture('claude');
  try {
    native(f);
    let reads = 0;
    const environment = {
      ...f.env,
      BOSUN_CALLER: 'model',
      get BOSUN_HOME(): never {
        reads++;
        throw Error('home read');
      },
    };
    let err = '';
    const code = await main(f.args, {
      env: environment,
      cwd: f.sb.home,
      stdout: () => assert.fail('output'),
      stderr: (text) => {
        err += text;
      },
    });
    assert.equal(code, 1);
    assert.equal(JSON.parse(err).error.code, 'unsupported');
    assert.equal(reads, 0);
    const secrets = {
      ...f.env,
      get ANTHROPIC_API_KEY(): never {
        reads++;
        throw Error('secret read');
      },
    };
    const record = f.installed.record;
    const preview = await hostLaunchPlan(
      { ...f.options, env: secrets },
      record.id,
      record.version,
      record.planHash,
    );
    assert.equal(reads, 0);
    assert.doesNotMatch(JSON.stringify(preview), /API_KEY/);
    let output = '';
    assert.equal(
      await main([...f.args, '--preview'], {
        env: secrets,
        cwd: f.sb.home,
        stdout: (text) => {
          output += text;
        },
        stderr: () => assert.fail('preview error'),
      }),
      0,
    );
    assert.equal(JSON.parse(output).managedControl, 'unverified');
    assert.equal(reads, 0);
    assert.equal(
      await main(['host', 'launch', record.id], { env: environment, stderr: () => {} }),
      2,
    );
    assert.equal(f.sb.calls().length, 0);
  } finally {
    f.sb.cleanup();
  }
});

test('explicit terminal shutdown waits for positive native parent close without claiming managed tool quiescence', async () => {
  const f = await fixture();
  let child: ChildProcess | undefined;
  try {
    const pidFile = path.join(f.sb.root, 'ui.pid');
    native(f, {
      body: `fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid)); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);`,
    });
    child = childProcess.spawn(process.execPath, [BIN, ...f.args], {
      env: f.env,
      cwd: f.sb.home,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let err = '';
    child.stderr!.on('data', (chunk) => {
      err += chunk;
    });
    child.stdout!.resume();
    child.stdin!.end();
    const completion = new Promise<number | null>((resolve) =>
      child!.once('close', (code) => resolve(code)),
    );
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(pidFile)) {
      if (Date.now() >= deadline) assert.fail('UI did not start: ' + err);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    child.kill('SIGTERM');
    assert.equal(await completion, 143, err);
    assert.throws(
      () => process.kill(pid, 0),
      (error: NodeJS.ErrnoException) => error.code === 'ESRCH',
    );
    assert.equal(f.sb.calls().length, 2);
  } finally {
    if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    f.sb.cleanup();
  }
});

test('foreground launch dispatches through the current child-process boundary and retains native close and exit receipts', async () => {
  const f = await fixture('codex');
  const original = childProcess.spawn;
  let foregroundDispatches = 0;
  const spawn = (command: string, args: readonly string[] = [], options: SpawnOptions = {}) => {
    if (options.stdio === 'inherit') {
      foregroundDispatches++;
      assert.equal(command, path.join(f.sb.bin, 'codex'));
      assert.deepEqual(args, f.plan.launch.args);
      assert.equal(options.shell, false);
      assert.equal(options.detached, false);
    }
    return original(command, args, options);
  };
  childProcess.spawn = spawn as unknown as typeof childProcess.spawn;
  try {
    native(f, { code: 7 });
    const record = f.installed.record;
    const result = await launchHost(
      f.options, record.id, record.version, record.planHash, new AbortController().signal,
    );
    assert.deepEqual(result, { code: 7, signal: null });
    assert.equal(foregroundDispatches, 1);
    assert.equal(f.sb.calls().length, 2);
  } finally {
    childProcess.spawn = original;
    f.sb.cleanup();
  }
});
