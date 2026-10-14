import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, fresh, REPO } from './helpers.ts';
import { runtimePaths } from '../src/platform/paths.ts';
import { parseRuntimeConfig } from '../src/platform/config.ts';
import { version } from '../src/platform/assets.ts';
import { setupRuntime } from '../src/app/setup.ts';
import {
  planInstallation,
  applyInstallation,
  undoInstallation,
  installationStatus,
  installationProcessEnv,
} from '../src/app/installation.ts';
import {
  controlInstallationService,
  reconcileInstallationService,
} from '../src/app/installation-service.ts';
import { createLaunchdControl, launchdList } from '../src/adapters/services/launchd.ts';
import { callLocalRpc } from '../src/adapters/transport/local-rpc.ts';
import { readRuntimeManifest, writeRuntimeManifest } from '../src/platform/manifest.ts';
import { main } from '../src/app/cli.ts';
import { runInstallWizard } from '../src/app/install-wizard.ts';

test('start/restart/stop aliases compose the owned service, bind original operations and never replay a completed restart', async () => {
  const f = await fixture();
  try {
    const cli = async (command: string, requestId: string, version = f.record().version) => {
      let out = '',
        err = '';
      const code = await main(
        [
          command,
          f.plan.id,
          '--version',
          String(version),
          '--hash',
          f.plan.planHash,
          '--request-id',
          requestId,
          '--clients-stopped',
        ],
        {
          env: f.env,
          cwd: f.sb.root,
          stdout: (text) => (out += text),
          stderr: (text) => (err += text),
          serviceControl: f.control,
        },
      );
      return { code, out, err };
    };
    const started = await cli('start', 'alias-start');
    assert.equal(started.code, 0, started.err);
    assert.equal(f.record().service.state, 'enabled');
    const before = f.record().version;
    const restarted = await cli('restart', 'alias-restart', before);
    assert.equal(restarted.code, 0, restarted.err);
    const result = JSON.parse(restarted.out);
    assert.equal(result.record.service.state, 'enabled');
    assert.deepEqual(
      result.operations.map((op: { kind: string; state: string }) => [op.kind, op.state]),
      [
        ['disable', 'succeeded'],
        ['enable', 'succeeded'],
      ],
    );
    assert.equal(f.calls().filter((args) => args[0] === 'bootstrap').length, 2);
    assert.equal(f.calls().filter((args) => args[0] === 'bootout').length, 1);
    const calls = f.calls();
    const duplicate = await cli('restart', 'alias-restart', before);
    assert.equal(duplicate.code, 0, duplicate.err);
    assert.equal(JSON.parse(duplicate.out).duplicate, true);
    assert.deepEqual(
      f.calls(),
      calls,
      'the original restart does not stop or start the daemon again',
    );
    const stopped = await cli('stop', 'alias-stop');
    assert.equal(stopped.code, 0, stopped.err);
    assert.equal(f.record().service.state, 'disabled');
    assert.equal(fs.existsSync(f.plan.service.target), false);
  } finally {
    await f.close();
  }
});

test('restart with a lost actual stop acknowledgement holds its original operation without starting or replaying', async () => {
  const f = await fixture();
  try {
    await f.operate('enable', 'initial');
    const version = f.record().version;
    f.settings({ loseBootout: true });
    const cli = async () => {
      let err = '';
      const code = await main(
        [
          'restart',
          f.plan.id,
          '--version',
          String(version),
          '--hash',
          f.plan.planHash,
          '--request-id',
          'lost-restart',
          '--clients-stopped',
        ],
        {
          env: f.env,
          cwd: f.sb.root,
          stdout() {},
          stderr: (text) => (err += text),
          serviceControl: f.control,
        },
      );
      return { code, err };
    };
    const held = await cli();
    assert.equal(held.code, 1);
    assert.equal(JSON.parse(held.err).error.details.outcome, 'unknown');
    assert.equal(f.record().service.state, 'unknown');
    assert.equal(
      f.calls().filter((args) => args[0] === 'bootstrap').length,
      1,
      'enable never follows an uncertain stop',
    );
    assert.equal(f.calls().filter((args) => args[0] === 'bootout').length, 1);
    const calls = f.calls();
    assert.equal((await cli()).code, 1);
    assert.deepEqual(f.calls(), calls, 'original uncertain stop cannot replay');
  } finally {
    await f.close();
  }
});
import { BosunError } from '../src/core/errors.ts';
import { inspectOnboarding, renderOnboarding } from '../src/app/onboarding.ts';
import {
  planHostInstallation,
  applyHostInstallation,
  undoHostInstallation,
} from '../src/app/host-install.ts';

let serial = 0;
async function fixture() {
  const sb = sandbox();
  fresh(sb);
  const env = sb.env({
      BOSUN_SOCKET: path.join(process.env.BOSUN_TEST_RUN_ROOT!, `svc${process.pid}_${++serial}`),
    }),
    paths = runtimePaths(env),
    config = parseRuntimeConfig('', env);
  await setupRuntime(paths, config);
  const source = path.join(sb.root, 'service-bosun'),
    settingsFile = path.join(sb.root, 'service-settings.json'),
    stateFile = path.join(sb.root, 'service-state.json'),
    callsFile = path.join(sb.root, 'service-calls.jsonl');
  fs.writeFileSync(settingsFile, '{}');
  fs.writeFileSync(
    source,
    `#!/usr/bin/env node
if(process.argv[2]==='--version'){process.stdout.write(${JSON.stringify(version + '\n')});process.exit(0);}
import(${JSON.stringify(path.join(REPO, 'src/app/cli.ts'))}).then(async({main})=>{
 const code=await main(process.argv.slice(2),{stdout(text){process.stdout.write(text);if(text.includes('bosun daemon ready'))process.send?.({ready:true});},stderr(text){process.stderr.write(text);}});
 process.exit(code);
}).catch(error=>{process.stderr.write(String(error));process.exitCode=1;});
`,
    { mode: 0o755 },
  );
  const options = { paths, env };
  const plan = planInstallation(options, { binary: source, requestId: 'service' });
  await applyInstallation(options, plan, plan.planHash, true);
  const command = path.join(sb.root, 'launchctl-fixture');
  fs.writeFileSync(
    command,
    `#!/usr/bin/env node
const fs=require('node:fs'),cp=require('node:child_process');const args=process.argv.slice(2),settings=JSON.parse(fs.readFileSync(${JSON.stringify(settingsFile)},'utf8'));
const stateFile=${JSON.stringify(stateFile)},callsFile=${JSON.stringify(callsFile)};const get=()=>fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile,'utf8')):null;
fs.appendFileSync(callsFile,JSON.stringify(args)+'\\n');
if(args[0]==='manageruid'){process.stdout.write(String(${process.getuid?.() ?? 501})+'\\n');process.exit(0);}
if(args[0]==='managername'){process.stdout.write((settings.context||'Aqua')+'\\n');process.exit(0);}
if(args[0]==='list'){if(settings.badList){process.stdout.write('unsupported format\\n');process.exit(0);}const value=get();process.stdout.write('PID\\tStatus\\tLabel\\n');if(value)process.stdout.write((value.pid===null?'-':String(value.pid))+'\\t0\\t'+value.label+'\\n');process.exit(0);}
if(args[0]==='bootstrap'){
const text=fs.readFileSync(args[2],'utf8');const decode=s=>s.replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&quot;','"').replaceAll('&apos;',"'").replaceAll('&amp;','&');
const field=name=>decode(new RegExp('<key>'+name+'</key><string>([^<]*)</string>').exec(text)[1]);const argumentsXml=/<key>ProgramArguments<\\/key><array>(.*?)<\\/array>/s.exec(text)[1];const programArgs=[...argumentsXml.matchAll(/<string>([^<]*)<\\/string>/g)].map(match=>decode(match[1]));const label=field('Label');
if(settings.noReady){fs.writeFileSync(stateFile,JSON.stringify({label,pid:null}));process.exit(0);}
const child=cp.spawn(process.execPath,programArgs,{env:{...process.env,HOME:field('HOME'),BOSUN_HOME:field('BOSUN_HOME'),BOSUN_SOCKET:field('BOSUN_SOCKET'),BOSUN_INSTALLATION_ID:field('BOSUN_INSTALLATION_ID')},cwd:field('WorkingDirectory'),detached:true,stdio:['ignore','ignore','pipe','ipc']});let stderr='';child.stderr.on('data',bytes=>stderr+=bytes);child.once('exit',()=>{if(stderr)process.stderr.write(stderr);process.exit(1);});child.once('message',()=>{fs.writeFileSync(stateFile,JSON.stringify({label,pid:child.pid}));fs.appendFileSync(callsFile,JSON.stringify(['daemon-pid',String(child.pid)])+'\\n');child.disconnect();child.unref();if(settings.loseBootstrap)process.exit(9);process.exit(0);});
}else if(args[0]==='bootout'){
const value=get();if(!value||!args[1].endsWith('/'+value.label))process.exit(9);if(value.pid!==null)try{process.kill(value.pid,'SIGTERM');}catch{}
const until=Date.now()+4000;const poll=()=>{let alive=false;if(value.pid!==null)try{process.kill(value.pid,0);alive=true;}catch{}if(!alive){fs.unlinkSync(stateFile);process.exit(settings.loseBootout?9:0);}if(Date.now()>until)process.exit(9);setTimeout(poll,10);};poll();
}else process.exit(2);
`,
    { mode: 0o755 },
  );
  const control = createLaunchdControl({
    env: installationProcessEnv(env),
    cwd: paths.home,
    command,
    platform: 'darwin',
    uid: process.getuid?.() ?? 501,
  });
  const serviceOptions = { ...options, control, timeoutMs: 500 };
  const record = () => installationStatus(options).record!;
  const operate = (operation: 'enable' | 'disable', requestId: string) => {
    const value = record();
    return controlInstallationService(serviceOptions, {
      id: plan.id,
      expectedVersion: value.version,
      hash: plan.planHash,
      requestId,
      operation,
      clientsStopped: true,
    });
  };
  const settings = (value: Record<string, unknown>) =>
    fs.writeFileSync(settingsFile, JSON.stringify(value));
  const calls = () =>
    fs.existsSync(callsFile)
      ? fs
          .readFileSync(callsFile, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as string[])
      : [];
  return {
    sb,
    env,
    paths,
    config,
    plan,
    options,
    serviceOptions,
    control,
    record,
    operate,
    settings,
    calls,
    stateFile,
    async close() {
      const pids = calls()
        .filter((args) => args[0] === 'daemon-pid')
        .map((args) => Number(args[1]))
        .filter((pid) => Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid);
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {}
        for (let n = 0; n < 100; n++) {
          try {
            process.kill(pid, 0);
          } catch {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      sb.cleanup();
    },
  };
}

test('wizard optional start uses the owned service transaction and preserves local memory privacy', async () => {
  const f = await fixture();
  try {
    const questions: string[] = [];
    const result = await runInstallWizard({
      ...f.options,
      binary: f.plan.binary.path,
      control: f.control,
      confirm: async question => { questions.push(question.kind); return question.kind === 'start'; },
      write() {},
    });
    assert.equal(result.state, 'ready');
    assert.equal(result.service, 'enabled');
    assert.deepEqual(questions, ['start']);
    assert.equal(f.record().service.state, 'enabled');
    assert.equal(f.calls().filter(args => args[0] === 'bootstrap').length, 1);
    const stored = await callLocalRpc<{ memory: { id: string; private: boolean } }>({
      socket: f.paths.socket,
      request: {
        version: 1, id: 'wizard-private-note', method: 'memory.store',
        params: { category: 'personal', title: 'Private wizard note', body: 'Owner-only retained data.', private: true },
        scope: { workspace: f.sb.root, sessionId: null, audience: 'owner' },
      },
    });
    assert.equal(stored.memory.private, true);
    const publicSearch = await callLocalRpc<{ hits: { id: string }[] }>({
      socket: f.paths.socket,
      request: {
        version: 1, id: 'wizard-public-search', method: 'memory.search',
        params: { text: 'Owner-only retained', includePrivate: false },
        scope: { workspace: f.sb.root, sessionId: null, audience: 'owner' },
      },
    });
    assert.equal(publicSearch.hits.some(note => note.id === stored.memory.id), false);
    await f.operate('disable', 'wizard-close');
  } finally { await f.close(); }
});

test('wizard holds a genuinely unknown service acknowledgement without replaying or rewriting receipts', async () => {
  const f = await fixture();
  try {
    f.settings({ loseBootstrap: true });
    await assert.rejects(() => f.operate('enable', 'wizard-lost-enable'));
    assert.equal(f.record().service.state, 'unknown');
    const calls = f.calls();
    const manifest = fs.readFileSync(f.paths.manifest);
    const binary = fs.readFileSync(f.plan.targetBinary);
    let prompts = 0;
    for (let n = 0; n < 2; n++) {
      const result = await runInstallWizard({
        ...f.options, binary: f.plan.binary.path, control: f.control,
        confirm: async () => { prompts++; return true; }, write() {},
      });
      assert.equal(result.state, 'held');
    }
    assert.equal(prompts, 0);
    assert.deepEqual(f.calls(), calls);
    assert.deepEqual(fs.readFileSync(f.paths.manifest), manifest);
    assert.deepEqual(fs.readFileSync(f.plan.targetBinary), binary);
  } finally { await f.close(); }
});
const code = (expected: string) => (error: unknown) =>
  error instanceof BosunError && error.code === expected;
test('legacy launchd list accepts only bounded declared columns and unique labels, withholding unknown observations', () => {
  const selected = 'com.bosun.daemon.' + 'a'.repeat(32);
  assert.deepEqual(launchdList('PID\tStatus\tLabel\n12\t0\t' + selected + '\n', selected), {
    present: true,
    pid: 12,
    exitStatus: 0,
  });
  assert.deepEqual(launchdList('PID Status Label\n- -15 other.label\n', selected), {
    present: false,
    pid: null,
    exitStatus: null,
  });
  for (const text of [
    '',
    'diagnostic text',
    'PID Status Label\n0 0 ' + selected,
    'PID Status Label\n12 0 ' + selected + '\n13 0 ' + selected,
    'PID Status Label\n999999999999 0 ' + selected,
  ])
    assert.throws(() => launchdList(text, selected));
});
test('actual guarded daemon start/readiness/stop and exact undo use original owned namespace without service replay', async () => {
  const f = await fixture();
  try {
    const originalConfig = fs.readFileSync(f.paths.config);
    const started = await f.operate('enable', 'enable-1');
    assert.equal(started.record.service.state, 'enabled');
    assert.equal(started.operation.observedState, 'enabled');
    assert.ok(started.operation.pid);
    assert.equal(fs.existsSync(f.plan.service.target), true);
    const status = await callLocalRpc<any>({
      socket: f.paths.socket,
      request: { version: 1, id: 'status', method: 'daemon.status', params: {} },
    });
    assert.equal(status.deploymentId, f.plan.id);
    assert.equal(status.installationId, f.plan.installationId);
    assert.equal(status.pid, started.operation.pid);
    const duplicate = await f.operate('enable', 'enable-1');
    assert.equal(duplicate.duplicate, true);
    assert.equal(f.calls().filter((args) => args[0] === 'bootstrap').length, 1);
    assert.throws(() =>
      undoInstallation(f.options, f.plan.id, f.record().version, f.plan.planHash, true),
    );
    const stopped = await f.operate('disable', 'disable-1');
    assert.equal(stopped.record.service.state, 'disabled');
    assert.equal(fs.existsSync(f.plan.service.target), false);
    assert.equal(f.calls().filter((args) => args[0] === 'bootout').length, 1);
    assert.equal((await f.operate('disable', 'disable-1')).duplicate, true);
    const second = await f.operate('enable', 'enable-2');
    assert.equal(second.record.service.state, 'enabled');
    await f.operate('disable', 'disable-2');
    const undone = undoInstallation(
      f.options,
      f.plan.id,
      f.record().version,
      f.plan.planHash,
      true,
    );
    assert.equal(undone.record.state, 'undone');
    assert.deepEqual(fs.readFileSync(f.paths.config), originalConfig);
    assert.equal(fs.existsSync(f.plan.targetBinary), false);
    assert.equal(fs.existsSync(path.join(f.env.HOME, 'Library')), false);
  } finally {
    await f.close();
  }
});
test('lost actual bootstrap return remains unknown; own daemon observation reconciles without a second bootstrap', async () => {
  const f = await fixture();
  try {
    f.settings({ loseBootstrap: true });
    await assert.rejects(
      f.operate('enable', 'uncertain-enable'),
      (error) => error instanceof BosunError && error.details?.outcome === 'unknown',
    );
    assert.equal(f.record().service.state, 'unknown');
    assert.equal(f.calls().filter((args) => args[0] === 'bootstrap').length, 1);
    await assert.rejects(f.operate('enable', 'uncertain-enable'), code('unverified'));
    const current = f.record(),
      reconciled = await reconcileInstallationService(
        f.serviceOptions,
        f.plan.id,
        current.version,
        f.plan.planHash,
      );
    assert.equal(reconciled.record.service.state, 'enabled');
    assert.equal(reconciled.record.service.operations.at(-1)!.state, 'reconciled');
    assert.equal(reconciled.replayed, false);
    assert.equal(f.calls().filter((args) => args[0] === 'bootstrap').length, 1);
    f.settings({});
    await f.operate('disable', 'stop-after-reconcile');
  } finally {
    await f.close();
  }
});
test('lost actual bootout return reconciles absence plus native closure and removes only the original plist without repeating bootout', async () => {
  const f = await fixture();
  try {
    await f.operate('enable', 'enable');
    f.settings({ loseBootout: true });
    await assert.rejects(f.operate('disable', 'uncertain-disable'));
    assert.equal(f.record().service.state, 'unknown');
    assert.equal(fs.existsSync(f.plan.service.target), true);
    const value = f.record(),
      reconciled = await reconcileInstallationService(
        f.serviceOptions,
        f.plan.id,
        value.version,
        f.plan.planHash,
      );
    assert.equal(reconciled.record.service.state, 'disabled');
    assert.equal(reconciled.record.service.operations.at(-1)!.observedState, 'disabled');
    assert.equal(fs.existsSync(f.plan.service.target), false);
    assert.equal(f.calls().filter((args) => args[0] === 'bootout').length, 1);
  } finally {
    await f.close();
  }
});
test('unknown list/context and a foreign namespace or definition refuse before service intent or mutations', async () => {
  for (const condition of ['format', 'context', 'namespace', 'leaf']) {
    const f = await fixture();
    try {
      if (condition === 'format') f.settings({ badList: true });
      if (condition === 'context') f.settings({ context: 'Background' });
      if (condition === 'namespace')
        fs.writeFileSync(f.stateFile, JSON.stringify({ label: f.plan.service.label, pid: null }));
      if (condition === 'leaf') {
        fs.mkdirSync(path.dirname(f.plan.service.target), { recursive: true });
        fs.writeFileSync(f.plan.service.target, 'owner foreign plist');
      }
      const before = fs.readFileSync(f.paths.manifest);
      await assert.rejects(f.operate('enable', 'refuse'));
      assert.deepEqual(fs.readFileSync(f.paths.manifest), before);
      assert.equal(
        f.calls().filter((args) => ['bootstrap', 'bootout'].includes(args[0])).length,
        0,
      );
    } finally {
      await f.close();
    }
  }
});
test('loaded but not ready service retains original owned intent and can be explicitly disabled without pretending readiness', async () => {
  const f = await fixture();
  try {
    f.settings({ noReady: true });
    await assert.rejects(f.operate('enable', 'no-ready'));
    assert.equal(f.record().service.state, 'unknown');
    assert.equal(f.record().service.owned, true);
    // No active daemon can establish readiness; explicit reconciliation remains held.
    const value = f.record();
    await assert.rejects(
      reconcileInstallationService(f.serviceOptions, f.plan.id, value.version, f.plan.planHash),
    );
    f.settings({});
    const stopped = await f.operate('disable', 'stop-unready');
    assert.equal(stopped.record.service.state, 'disabled');
    assert.equal(f.calls().filter((args) => args[0] === 'bootstrap').length, 1);
    assert.equal(f.calls().filter((args) => args[0] === 'bootout').length, 1);
  } finally {
    await f.close();
  }
});
test('actual owner CLI service commands use shared receipts and model callers cannot reach service observations', async () => {
  const f = await fixture();
  try {
    const output: string[] = [];
    const invoke = (argv: string[], env = f.env) =>
        main(argv, {
          env,
          cwd: f.sb.root,
          serviceControl: f.control,
          stdout: (line) => output.push(line),
          stderr() {},
        }),
      value = f.record();
    const args = [
      'install',
      'enable',
      f.plan.id,
      '--version',
      String(value.version),
      '--hash',
      f.plan.planHash,
      '--request-id',
      'cli-enable',
      '--clients-stopped',
    ];
    assert.notEqual(await invoke(args, { ...f.env, BOSUN_CALLER: 'model' }), 0);
    assert.deepEqual(f.calls(), []);
    assert.equal(await invoke(args), 0);
    assert.equal(JSON.parse(output.pop()!).record.service.state, 'enabled');
    const active = f.record();
    assert.equal(
      await invoke([
        'install',
        'disable',
        f.plan.id,
        '--version',
        String(active.version),
        '--hash',
        f.plan.planHash,
        '--request-id',
        'cli-disable',
        '--clients-stopped',
      ]),
      0,
    );
    assert.equal(JSON.parse(output.pop()!).record.service.state, 'disabled');
  } finally {
    await f.close();
  }
});
test('manifest monotonic CAS rejects a stale installation snapshot without overwriting newer service receipts', async () => {
  const f = await fixture();
  try {
    const stale = readRuntimeManifest(f.paths);
    await f.operate('enable', 'fresh');
    assert.throws(() => writeRuntimeManifest(f.paths, stale), code('conflict'));
    assert.equal(f.record().service.state, 'enabled');
    await f.operate('disable', 'close');
  } finally {
    await f.close();
  }
});
test('changed published definition and mismatched native PID cannot stop an unqualified service', async () => {
  for (const condition of ['definition', 'pid']) {
    const f = await fixture();
    try {
      await f.operate('enable', 'start');
      const original = fs.readFileSync(f.plan.service.target),
        state = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
      if (condition === 'definition')
        fs.appendFileSync(f.plan.service.target, '<!-- owner edit -->');
      else fs.writeFileSync(f.stateFile, JSON.stringify({ ...state, pid: process.pid }));
      const before = fs.readFileSync(f.paths.manifest);
      await assert.rejects(f.operate('disable', 'refuse-stop'));
      assert.deepEqual(fs.readFileSync(f.paths.manifest), before);
      assert.equal(f.calls().filter((args) => args[0] === 'bootout').length, 0);
      fs.writeFileSync(f.plan.service.target, original);
      fs.writeFileSync(f.stateFile, JSON.stringify(state));
      await f.operate('disable', 'qualified-stop');
    } finally {
      await f.close();
    }
  }
});
test('service publication into an unsafe parent is held before intent and preserves owner paths', async () => {
  const f = await fixture();
  try {
    fs.symlinkSync(f.sb.root, path.join(f.env.HOME, 'Library'));
    const before = fs.readFileSync(f.paths.manifest);
    await assert.rejects(f.operate('enable', 'unsafe-parent'));
    assert.deepEqual(fs.readFileSync(f.paths.manifest), before);
    assert.equal(f.calls().filter((args) => args[0] === 'bootstrap').length, 0);
  } finally {
    await f.close();
  }
});
test('actual plist removal followed by a lost rename return stays uncertain and reconciles without repeating shutdown', async () => {
  const f = await fixture(),
    rename = fs.renameSync;
  try {
    await f.operate('enable', 'start');
    let lost = false;
    fs.renameSync = function (from, to) {
      const result = rename(from, to);
      if (String(from) === f.plan.service.target && !lost) {
        lost = true;
        throw Error('lost removal return');
      }
      return result;
    };
    await assert.rejects(f.operate('disable', 'stop'));
    fs.renameSync = rename;
    assert.equal(f.record().service.state, 'unknown');
    assert.equal(fs.existsSync(f.plan.service.target), false);
    const value = f.record();
    const reconciled = await reconcileInstallationService(
      f.serviceOptions,
      f.plan.id,
      value.version,
      f.plan.planHash,
    );
    assert.equal(reconciled.record.service.state, 'disabled');
    assert.equal(f.calls().filter((args) => args[0] === 'bootout').length, 1);
  } finally {
    fs.renameSync = rename;
    await f.close();
  }
});
test('foreign archive bytes survive shutdown and reconciliation never repeats native control', async () => {
  const f = await fixture();
  try {
    await f.operate('enable', 'start');
    const archive = path.join(path.dirname(f.plan.service.file), 'daemon-removed-2.plist');
    fs.writeFileSync(archive, 'owner archive bytes', { mode: 0o600 });
    await assert.rejects(f.operate('disable', 'stop'));
    assert.equal(fs.readFileSync(archive, 'utf8'), 'owner archive bytes');
    assert.equal(f.record().service.state, 'unknown');
    const before = f.calls().filter((args) => args[0] === 'bootout').length;
    const current = f.record();
    await assert.rejects(
      reconcileInstallationService(f.serviceOptions, f.plan.id, current.version, f.plan.planHash),
    );
    assert.equal(fs.readFileSync(archive, 'utf8'), 'owner archive bytes');
    assert.equal(f.calls().filter((args) => args[0] === 'bootout').length, before);
  } finally {
    await f.close();
  }
});
test('onboarding guides the existing OpenCode profile and daemon flow without process calls, automatic effects or extra start cycles', async () => {
  const f = await fixture();
  try {
    const manifest = fs.readFileSync(f.paths.manifest),
      initial = inspectOnboarding(f.options, 'opencode');
    assert.equal(initial.state, 'profile');
    assert.ok(!initial.actions.some((action) => action.argv.includes('enable')));
    assert.deepEqual(fs.readFileSync(f.paths.manifest), manifest);
    assert.deepEqual(f.calls(), []);
    const hostPlan = await planHostInstallation(
      { ...f.options, config: f.config, binary: f.plan.targetBinary },
      { hostId: 'opencode', nativeVersion: '2.0.27', requestId: 'onboard-profile' },
    );
    const profile = await applyHostInstallation(
      { ...f.options, config: f.config, binary: f.plan.targetBinary },
      hostPlan,
      hostPlan.planHash,
    );
    const daemon = inspectOnboarding(f.options, 'opencode');
    assert.equal(daemon.state, 'daemon');
    assert.equal(daemon.actions[0].argv[2], 'enable');
    await f.operate('enable', 'onboard-start');
    const ready = inspectOnboarding(f.options, 'opencode');
    assert.equal(ready.state, 'launch');
    assert.equal(ready.nativeQualification, 'unverified');
    assert.ok(ready.actions[0].argv.includes('--preview'));
    assert.match(renderOnboarding(ready), /opencode/);
    assert.equal(f.calls().filter((args) => args[0] === 'bootstrap').length, 1);
    const output: string[] = [];
    assert.equal(
      await main(['onboard', '--host', 'opencode', '--json'], {
        env: f.env,
        cwd: f.sb.root,
        stdout: (value) => output.push(value),
        stderr() {},
      }),
      0,
    );
    assert.equal(JSON.parse(output[0]).state, 'launch');
    await f.operate('disable', 'onboard-stop');
    await undoHostInstallation(
      { ...f.options, config: f.config, binary: f.plan.targetBinary },
      profile.record.id,
      profile.record.version,
    );
  } finally {
    await f.close();
  }
});
test('fresh onboarding reports setup, selects each first-class host and refuses invalid host or uncertain installation without mutation', async () => {
  const sb = sandbox();
  fresh(sb);
  try {
    const options = { env: sb.env(), paths: runtimePaths(sb.env()) };
    for (const host of ['opencode', 'codex', 'claude']) {
      const report = inspectOnboarding(options, host);
      assert.equal(report.state, 'setup');
      assert.equal(report.host, host);
      assert.equal(report.actions[0].argv[1], 'setup');
    }
    assert.throws(() => inspectOnboarding(options, 'unknown'));
    assert.equal(fs.existsSync(options.paths.home), false);
    assert.deepEqual(sb.calls(), []);
    const quoted = renderOnboarding({
      state: 'setup',
      host: 'opencode',
      detail: 'Owner path',
      actions: [{ purpose: 'Literal path', argv: ['bosun', "/owner/a'$(echo unsafe)"] }],
      nativeQualification: 'unverified',
      observation: 'saved-configuration',
    });
    assert.ok(quoted.includes("'\\''"));
  } finally {
    sb.cleanup();
  }
});
