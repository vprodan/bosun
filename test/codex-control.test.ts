import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { sandbox, gitRepo, type Sandbox } from './helpers.ts';
import { BosunError } from '../src/core/errors.ts';
import { requireManagedControl } from '../src/core/managed-policy.ts';
import { createCodexControl } from '../src/adapters/hosts/codex/control.ts';
import { CODEX_VERSION } from '../src/adapters/hosts/codex/runner.ts';
import { bindRollout, readRolloutSeed } from '../src/adapters/hosts/codex/rollout.ts';
import type { ManagedSessionCreate } from '../src/core/ports/host.ts';
import { defaultConfig } from '../src/core/domain/config.ts';
import { runtimePaths } from '../src/platform/paths.ts';
import { setupRuntime } from '../src/app/setup.ts';
import { startDaemon } from '../src/app/daemon.ts';
import { callLocalRpc } from '../src/adapters/transport/local-rpc.ts';
import { nativeRunners } from '../src/app/native-runners.ts';

const hash = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
const signal = () => new AbortController().signal;
const seed = 'Public summary — literal $HOME, `backticks`, $(never-execute).';
const publicInput = (sb: Sandbox): ManagedSessionCreate => ({
  privacy: 'public',
  cwd: sb.home,
  model: 'gpt-6.1-sol',
  effort: 'high',
  access: 'edit',
  ownerId: 'owner_fixture',
  generation: 0,
  requestId: 'request_fixture',
});
const failure = (error: unknown) =>
  error instanceof BosunError &&
  error.details?.outcome === 'unknown' &&
  !/CANARY|secret|foreign/.test(JSON.stringify(error));
function fixture(sb: Sandbox, mode = 'normal', nativeVersion = CODEX_VERSION) {
  const home = path.join(sb.home, '.codex');
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true, mode: 0o700 });
  const source = `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
const record=row=>fs.appendFileSync(process.env.STUB_OUT,JSON.stringify(row)+'\\n');
record({argv:process.argv.slice(2),pid:process.pid});
const nativeVersion=process.env.STUB_VERSION;
if(process.argv.includes('--version')){process.stdout.write('codex-cli '+nativeVersion+'\\n');return;}
const mode=process.env.STUB_MODE,home=process.env.CODEX_HOME;
const id='019aa001-aaaa-7aaa-8aaa-'+process.pid.toString(16).padStart(12,'0');
const file=path.join(home,'sessions','rollout-2026-10-11T10-00-00-'+id+'.jsonl');
const send=row=>process.stdout.write(JSON.stringify(row)+'\\n');
const line=(type,payload)=>JSON.stringify({timestamp:'2026-10-11T10:00:00Z',type,payload})+'\\n';
let root,turns=[],current,turnCount=0;
const thread=()=>({...root,turns});
const rl=require('node:readline').createInterface({input:process.stdin});
rl.on('line',body=>{const row=JSON.parse(body);record({request:row});const p=row.params||{};
if(row.method==='initialize'){send({id:row.id,result:{codexHome:home,platformFamily:'unix',platformOs:'macos',userAgent:'codex/'+nativeVersion}});return;}
if(row.method==='initialized'||row.error)return;
if(row.method==='thread/start'){
 const meta={id,session_id:id,cwd:p.cwd,cli_version:mode==='wrong-rollout-version'?'0.163.0':nativeVersion,source:'mcp',history_mode:'legacy',base_instructions:{text:'Native policy'},creator_account_id:'ACCOUNT_CANARY'};
 fs.writeFileSync(file,line('session_meta',meta),{flag:'wx',mode:0o600});
 root={id,sessionId:id,forkedFromId:null,parentThreadId:null,ephemeral:false,historyMode:'legacy',cwd:p.cwd,cliVersion:nativeVersion,model:p.model,reasoningEffort:p.config.model_reasoning_effort||null,path:file,status:{type:'idle'},turns:[]};
 if(mode==='lost-create'){process.exit(0);return;}
 if(mode==='wrong-model')root.model='different-model';if(mode==='fork')root.forkedFromId='parent';if(mode==='active')root.status={type:'active',activeFlags:[]};if(mode==='wrong-effort')root.reasoningEffort='low';if(mode==='wrong-version')root.cliVersion='0.162.0';if(mode==='foreign-path')root.path=path.join(home,'auth.json');
 send({id:row.id,result:{thread:thread(),model:p.model,cwd:p.cwd,reasoningEffort:root.reasoningEffort,approvalPolicy:mode==='wrong-policy'?'on-request':'never',sandbox:{type:'workspaceWrite',networkAccess:mode==='network',writableRoots:[p.cwd],excludeTmpdirEnvVar:false,excludeSlashTmp:false}}});return;
}
if(row.method==='thread/read'){send({id:row.id,result:{thread:thread()}});return;}
if(row.method==='thread/backgroundTerminals/list'){send({id:row.id,result:{data:mode==='background'?[{processId:'pending'}]:[],nextCursor:mode==='background-page'?'more':null}});return;}
if(row.method==='thread/inject_items'){
 const item=JSON.parse(JSON.stringify(p.items[0]));if(mode==='wrong-seed')item.content[0].text='Different seed';
 if(mode!=='missing-seed')fs.appendFileSync(file,line('response_item',item));
 if(mode==='lost-inject'){process.exit(0);return;}
 send({id:row.id,result:{}});return;
}
if(row.method==='turn/start'){
 const turnId='019aa002-bbbb-7bbb-8bbb-'+String(++turnCount).padStart(12,'0');
 const user={type:'userMessage',id:'user_'+turnCount,clientId:p.clientUserMessageId,content:p.input};
 const answer={type:'agentMessage',id:'answer_'+turnCount,text:mode==='secret-answer'?'api_key='+('z'.repeat(40)):'Public native answer'};
 const tool={type:'commandExecution',id:'tool_'+turnCount,status:'completed',command:'COMMAND_CANARY',aggregatedOutput:'OUTPUT_CANARY'};
 current={id:turnId,status:'inProgress',itemsView:'full',items:[user,tool,answer],error:null};turns.push(current);
 send({id:row.id,result:{turn:{...current,items:[]}}});
 send({method:'turn/started',params:{threadId:id,turn:{...current,items:[]}}});
 send({method:'item/started',params:{threadId:id,turnId,item:{...tool,status:'inProgress'}}});
 if(mode!=='pending-tool')send({method:'item/completed',params:{threadId:id,turnId,item:tool}});
 send({method:'item/completed',params:{threadId:id,turnId,item:answer}});
 send({method:'thread/tokenUsage/updated',params:{threadId:id,turnId,tokenUsage:{last:{totalTokens:140,inputTokens:100,cachedInputTokens:80,outputTokens:40,reasoningOutputTokens:20},total:{totalTokens:999999},modelContextWindow:200000}}});
 if(mode==='reroute'){send({method:'model/rerouted',params:{threadId:id,turnId,fromModel:p.model,toModel:'different-model'}});return;}
 if(mode==='lost-turn'){process.exit(0);return;}
 if(mode==='no-terminal')return;
 current.status='completed';if(mode==='foreign-user')user.clientId='foreign';
 send({method:'turn/completed',params:{threadId:id,turn:{...current,id:mode==='foreign-turn'?'019aa099-cccc-7ccc-8ccc-000000000001':turnId}}});return;
}
if(row.method==='turn/interrupt'){send({id:row.id,result:{}});if(mode!=='no-terminal'){current.status='interrupted';send({method:'turn/completed',params:{threadId:id,turn:current}});}return;}
send({id:row.id,error:{code:-32601,message:'Unavailable'}});
});
rl.on('close',()=>process.exit(0));
`;
  fs.writeFileSync(path.join(sb.bin, 'codex'), source, { mode: 0o755 });
  const environment = sb.env({ CODEX_HOME: home, STUB_MODE: mode, STUB_VERSION: nativeVersion });
  let active = false,
    generation = 0,
    gateCount = 0;
  const gates = {
    hash,
    now: () => 1000,
    id: () => 'fence_fixture',
    assertOwner(expected: { ownerId: string; generation: number }) {
      gateCount++;
      assert.equal(expected.ownerId, 'owner_fixture');
      assert.ok(expected.generation === generation || expected.generation === generation + 1);
    },
    assertDispatchOwner(expected: { generation: number }) {
      gateCount++;
      assert.equal(active, true);
      assert.equal(expected.generation, generation);
    },
    freshClaim: () => ({ ownerId: 'owner_fixture', generation: generation + 1 }),
  };
  const driver = createCodexControl(
    { env: environment, requestTimeoutMs: 100, killGraceMs: 20 },
    gates,
  );
  return {
    driver,
    home,
    gates,
    environment,
    activate(value = 0) {
      active = true;
      generation = value;
    },
    gateCount: () => gateCount,
  };
}
const records = (
  sb: Sandbox,
): { argv?: string[]; pid?: number; request?: { method: string; params: Record<string, any> } }[] =>
  fs
    .readFileSync(sb.out, 'utf8')
    .trim()
    .split('\n')
    .map((row) => JSON.parse(row));
async function prepared(sb: Sandbox, mode = 'normal', nativeVersion = CODEX_VERSION) {
  const f = fixture(sb, mode, nativeVersion),
    session = await f.driver.create(publicInput(sb), signal());
  await f.driver.seed(session, { privacy: 'public', text: seed, hash: hash(seed) }, signal());
  await f.driver.ready(
    session,
    { seedHash: hash(seed), model: session.model, access: session.access },
    signal(),
  );
  f.activate();
  return { ...f, session };
}

test('Codex managed constructor and rejected privacy/read/secret input never discover a host or read settings', async () => {
  const sb = sandbox();
  let reads = 0;
  const driver = createCodexControl(
    {
      get env(): never {
        reads++;
        throw Error('SETTINGS_CANARY');
      },
    },
    {} as never,
  );
  try {
    assert.equal(reads, 0);
    for (const privacy of ['private', 'unknown', undefined])
      await assert.rejects(
        driver.create(
          {
            ...publicInput(sb),
            privacy,
            get cwd(): never {
              throw Error('BODY_CANARY');
            },
          } as never,
          signal(),
        ),
        (error: unknown) => error instanceof BosunError && error.code === 'private_input',
      );
    await assert.rejects(
      driver.create({ ...publicInput(sb), access: 'read' }, signal()),
      (error: unknown) => error instanceof BosunError && error.code === 'unverified',
    );
    await assert.rejects(
      driver.create({ ...publicInput(sb), requestId: 'api_key=' + 'z'.repeat(40) }, signal()),
      (error: unknown) => error instanceof BosunError && error.code === 'private_input',
    );
    assert.equal(reads, 0);
    assert.deepEqual(sb.calls(), []);
  } finally {
    await driver.close?.();
    sb.cleanup();
  }
});

test('fresh Codex seed is persisted and independently read back with no turn/model request before readiness', async () => {
  const sb = sandbox();
  const f = await prepared(sb);
  try {
    const calls = records(sb),
      requests = calls.flatMap((row) => (row.request ? [row.request] : []));
    assert.equal(requests.filter((row) => row.method === 'thread/start').length, 1);
    assert.equal(requests.filter((row) => row.method === 'thread/inject_items').length, 1);
    assert.equal(requests.filter((row) => row.method === 'turn/start').length, 0);
    assert.equal(
      requests.some((row) => /resume|fork|account/.test(row.method)),
      false,
    );
    assert.equal(
      requests.find((row) => row.method === 'thread/start')!.params.config.model_reasoning_effort,
      'high',
    );
    assert.equal(
      requests.find((row) => row.method === 'thread/inject_items')!.params.items[0].content[0].text,
      seed,
    );
    const file = path.join(f.home, 'sessions', fs.readdirSync(path.join(f.home, 'sessions'))[0]);
    assert.ok(fs.readFileSync(file, 'utf8').includes(seed));
    assert.equal(f.gateCount() > 0, true);
    assert.ok(Object.values(f.driver.caps).every((value) => value === 'unverified'));
    assert.throws(
      () => requireManagedControl({ control: f.driver }),
      (error: unknown) => error instanceof BosunError && error.code === 'unverified',
    );
  } finally {
    const pids = records(sb)
      .filter((row) => row.argv?.[0] === 'app-server')
      .map((row) => row.pid!);
    await f.driver.close?.();
    for (const pid of pids)
      assert.throws(
        () => process.kill(pid, 0),
        (error: NodeJS.ErrnoException) => error.code === 'ESRCH',
      );
    sb.cleanup();
  }
});

test('owned Codex turn and capture retain literal admitted text, exact native receipts, bounded references and unknown occupancy semantics', async () => {
  const sb = sandbox();
  const f = await prepared(sb);
  try {
    const events = await f.driver.run(
      f.session,
      { privacy: 'public', text: 'Literal $(never-execute) public task', turnId: 'job_fixture' },
      signal(),
    );
    assert.deepEqual(events, [
      { t: 'tool', name: 'commandExecution' },
      { t: 'text', text: 'Public native answer' },
      { t: 'done', code: 0, result: 'Public native answer' },
    ]);
    const usage = await f.driver.observeContext(f.session, signal());
    assert.equal(usage.usedTokens, 140);
    assert.equal(usage.windowTokens, 200000);
    assert.equal(usage.scope, 'unknown');
    assert.equal(usage.quality, 'unknown');
    const window = await f.driver.capture!(
      f.session,
      { privacy: 'public', afterCursor: null },
      signal(),
    );
    assert.equal(window.complete, true);
    assert.equal(window.totalEvents, 3);
    assert.equal(window.evidence.length, 3);
    assert.deepEqual(
      window.references.map((row) => row.kind),
      ['user', 'tool-reference', 'assistant'],
    );
    assert.doesNotMatch(
      JSON.stringify(window),
      /COMMAND_CANARY|OUTPUT_CANARY|ACCOUNT_CANARY|999999/,
    );
    const next = await f.driver.capture!(
      f.session,
      { privacy: 'public', afterCursor: window.completedEventCursor },
      signal(),
    );
    assert.equal(next.evidence.length, 0);
    assert.equal(next.snapshotHash, window.snapshotHash);
    const fence = await f.driver.fenceAdmission(f.session, signal());
    assert.equal((await f.driver.quiesce(f.session, fence, signal())).pendingTools, 0);
    await assert.rejects(
      f.driver.run(
        f.session,
        { privacy: 'public', text: 'Next task', turnId: 'job_next' },
        signal(),
      ),
    );
    assert.equal(records(sb).filter((row) => row.request?.method === 'turn/start').length, 1);
  } finally {
    await f.driver.close?.();
    sb.cleanup();
  }
});

test('Codex supported native major retains the actual version through owned creation, seed, turn and capture', async () => {
  for (const nativeVersion of ['0.159.0', '0.162.0']) {
    const sb = sandbox();
    const f = await prepared(sb, 'normal', nativeVersion);
    try {
      await f.driver.run(f.session, { privacy: 'public', text: 'Public native task', turnId: 'job_fixture' }, signal());
      const window = await f.driver.capture!(f.session, { privacy: 'public', afterCursor: null }, signal());
      assert.equal(window.complete, true);
      assert.equal(window.evidence.length, 3);
      const next = await f.driver.capture!(f.session, { privacy: 'public', afterCursor: window.completedEventCursor }, signal());
      assert.equal(next.snapshotHash, window.snapshotHash);
      const directory = path.join(f.home, 'sessions');
      const file = path.join(directory, fs.readdirSync(directory)[0]);
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8').split('\n')[0]).payload.cli_version, nativeVersion);
    } finally {
      await f.driver.close?.();
      sb.cleanup();
    }
  }
});

test('Codex incompatible majors and malformed releases are held before app-server startup', async () => {
  for (const nativeVersion of ['1.0.0', '00.161.0', '0.0161.0', '0.161', '0.161.0-preview', '0.161.0\nextra']) {
    const sb = sandbox(), f = fixture(sb, 'normal', nativeVersion);
    try {
      await assert.rejects(f.driver.create(publicInput(sb), signal()), failure);
      assert.deepEqual(records(sb).map(row => row.argv), [['--version']]);
    } finally {
      await f.driver.close?.();
      sb.cleanup();
    }
  }
});

test('wrong Codex creation identity/model/effort/policy/active/background/path is held before injection or inference', async () => {
  for (const mode of [
    'wrong-model',
    'wrong-effort',
    'wrong-policy',
    'network',
    'fork',
    'active',
    'wrong-version',
    'wrong-rollout-version',
    'foreign-path',
    'background',
    'background-page',
  ]) {
    const sb = sandbox();
    const f = fixture(sb, mode);
    try {
      await assert.rejects(f.driver.create(publicInput(sb), signal()), failure);
      assert.equal(
        records(sb).some((row) =>
          ['thread/inject_items', 'turn/start'].includes(row.request?.method ?? ''),
        ),
        false,
      );
    } finally {
      await f.driver.close?.();
      sb.cleanup();
    }
  }
});

test('empty injection receipt cannot mask wrong/missing seed or lost native return; original mutation is never repeated', async () => {
  for (const mode of ['wrong-seed', 'missing-seed', 'lost-inject']) {
    const sb = sandbox();
    const f = fixture(sb, mode);
    try {
      const session = await f.driver.create(publicInput(sb), signal());
      await assert.rejects(
        f.driver.seed(session, { privacy: 'public', text: seed, hash: hash(seed) }, signal()),
        failure,
      );
      await assert.rejects(
        f.driver.seed(session, { privacy: 'public', text: seed, hash: hash(seed) }, signal()),
      );
      assert.equal(
        records(sb).filter((row) => row.request?.method === 'thread/inject_items').length,
        1,
      );
      assert.equal(
        records(sb).some((row) => row.request?.method === 'turn/start'),
        false,
      );
    } finally {
      await f.driver.close?.();
      sb.cleanup();
    }
  }
});

test('lost creation receipt retains original native history and prevents repeating the same source request', async () => {
  const sb = sandbox();
  const f = fixture(sb, 'lost-create');
  try {
    await assert.rejects(f.driver.create(publicInput(sb), signal()), failure);
    await assert.rejects(f.driver.create(publicInput(sb), signal()));
    assert.equal(records(sb).filter((row) => row.request?.method === 'thread/start').length, 1);
    assert.equal(fs.readdirSync(path.join(f.home, 'sessions')).length, 1);
  } finally {
    await f.driver.close?.();
    sb.cleanup();
  }
});

test('pending tools, foreign original turn/user, model reroute, secret answer and lost terminal prevent completion or replay', async () => {
  for (const mode of [
    'pending-tool',
    'foreign-turn',
    'foreign-user',
    'reroute',
    'secret-answer',
    'lost-turn',
  ]) {
    const sb = sandbox();
    const f = await prepared(sb, mode);
    try {
      await assert.rejects(
        f.driver.run(
          f.session,
          { privacy: 'public', text: 'One public task', turnId: 'job_fixture' },
          signal(),
        ),
        failure,
      );
      await assert.rejects(
        f.driver.run(
          f.session,
          { privacy: 'public', text: 'One public task', turnId: 'job_fixture' },
          signal(),
        ),
      );
      assert.equal(records(sb).filter((row) => row.request?.method === 'turn/start').length, 1);
    } finally {
      await f.driver.close?.();
      sb.cleanup();
    }
  }
});

test('cancellation request without original terminal receipt joins the process and leaves unknown effects', async () => {
  const sb = sandbox();
  const f = await prepared(sb, 'no-terminal');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60);
  try {
    await assert.rejects(
      f.driver.run(
        f.session,
        { privacy: 'public', text: 'Public cancellable task', turnId: 'job_fixture' },
        controller.signal,
      ),
      failure,
    );
    const rows = records(sb),
      pid = rows.find((row) => row.argv?.[0] === 'app-server')!.pid!;
    assert.throws(
      () => process.kill(pid, 0),
      (error: NodeJS.ErrnoException) => error.code === 'ESRCH',
    );
    assert.equal(rows.filter((row) => row.request?.method === 'turn/start').length, 1);
    assert.equal(rows.filter((row) => row.request?.method === 'turn/interrupt').length, 1);
  } finally {
    clearTimeout(timer);
    await f.driver.close?.();
    sb.cleanup();
  }
});

test('fresh rollout reader rejects native links, inode replacement, foreign roots, malformed UTF8 and added history', async () => {
  const sb = sandbox();
  const f = await prepared(sb);
  try {
    const directory = path.join(f.home, 'sessions'),
      file = path.join(directory, fs.readdirSync(directory)[0]);
    const binding = bindRollout({ file, home: f.home, cwd: sb.home, id: f.session.sessionId, version: CODEX_VERSION }),
      original = fs.readFileSync(file);
    readRolloutSeed(binding, seed);
    for (const arm of [
      'wrong-seed',
      'foreign-id',
      'wrong-version',
      'history',
      'utf8',
      'oversize',
      'inode',
      'symlink',
    ]) {
      fs.writeFileSync(file, original, { mode: 0o600 });
      if (arm === 'wrong-seed')
        fs.writeFileSync(file, original.toString().replace(seed, 'Different seed'));
      else if (arm === 'foreign-id')
        fs.writeFileSync(
          file,
          original
            .toString()
            .replaceAll(f.session.sessionId, '019aa099-cccc-7ccc-8ccc-000000000001'),
        );
      else if (arm === 'wrong-version')
        fs.writeFileSync(file, original.toString().replace(CODEX_VERSION, '0.162.0'));
      else if (arm === 'history')
        fs.appendFileSync(
          file,
          JSON.stringify({
            timestamp: '2026-10-11T10:00:00Z',
            type: 'event_msg',
            payload: { type: 'task_started' },
          }) + '\n',
        );
      else if (arm === 'utf8') fs.writeFileSync(file, Buffer.from([0xff, 0x0a]));
      else if (arm === 'oversize') fs.writeFileSync(file, ' '.repeat(1024 * 1024 + 1));
      else if (arm === 'inode') {
        const replacement = file + '.replacement';
        fs.writeFileSync(replacement, original, { mode: 0o600 });
        fs.renameSync(replacement, file);
      } else {
        const target = file + '.target';
        fs.writeFileSync(target, original, { mode: 0o600 });
        fs.unlinkSync(file);
        fs.symlinkSync(target, file);
      }
      assert.throws(
        () => readRolloutSeed(binding, seed),
        (error: unknown) => error instanceof BosunError && error.code === 'unverified',
      );
      if (arm === 'symlink') fs.unlinkSync(file);
    }
  } finally {
    await f.driver.close?.();
    sb.cleanup();
  }
});

test('Codex fresh generation creates an independent root and joins the retired process before destination dispatch', async () => {
  const sb = sandbox();
  const f = await prepared(sb);
  try {
    const fence = await f.driver.fenceAdmission(f.session, signal());
    await f.driver.quiesce(f.session, fence, signal());
    const destination = await f.driver.startFresh(f.session, signal());
    assert.notEqual(destination.sessionId, f.session.sessionId);
    assert.equal(destination.generation, 1);
    await assert.rejects(f.driver.startFresh(f.session, signal()));
    await f.driver.seed(destination, { privacy: 'public', text: seed, hash: hash(seed) }, signal());
    await f.driver.ready(
      destination,
      { seedHash: hash(seed), model: destination.model, access: destination.access },
      signal(),
    );
    const oldPid = records(sb).find((row) => row.argv?.[0] === 'app-server')!.pid!;
    f.activate(1);
    await f.driver.run(
      destination,
      { privacy: 'public', text: 'Public destination task', turnId: 'job_destination' },
      signal(),
    );
    assert.throws(
      () => process.kill(oldPid, 0),
      (error: NodeJS.ErrnoException) => error.code === 'ESRCH',
    );
    assert.equal(records(sb).filter((row) => row.request?.method === 'thread/start').length, 2);
    assert.equal(records(sb).filter((row) => row.request?.method === 'turn/start').length, 1);
    assert.equal(
      records(sb).some((row) => /resume|fork/.test(row.request?.method ?? '')),
      false,
    );
  } finally {
    await f.driver.close?.();
    sb.cleanup();
  }
});

for (const mode of ['normal', 'lost-turn'])
  test(`production Codex managed daemon startup/turn/capture/restart binds original jobs (${mode})`, async () => {
    const sb = sandbox();
    const f = fixture(sb, mode);
    const workspace = gitRepo(sb, 'codex-managed-repo', 'git@example.com:team/codex-managed.git');
    const env = {
      ...f.environment,
      BOSUN_SOCKET: path.join(
        process.env.BOSUN_TEST_RUN_ROOT!,
        'cx_' + crypto.randomUUID().slice(0, 8),
      ),
    };
    const paths = runtimePaths(env),
      config = defaultConfig();
    let runtime: Awaited<ReturnType<typeof startDaemon>> | undefined;
    let id = 0;
    const scope = { workspace, audience: 'owner' as const, sessionId: null };
    const rpc = (method: string, params: Record<string, unknown>) =>
      callLocalRpc<any>({
        socket: paths.socket,
        request: { version: 1, id: 'cx_' + ++id, method, params, scope },
        mutation: ['managed.start', 'managed.turn', 'managed.retire'].includes(method),
      });
    async function wait(jobId: string, state: string) {
      const deadline = Date.now() + 5000;
      for (;;) {
        const job = await rpc('job.get', { id: jobId });
        if (job.state === state) return job;
        if (Date.now() > deadline) assert.fail(JSON.stringify(job));
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    const options = {
      paths,
      config,
      environment: env,
      runners: nativeRunners(config, env),
      admit: async () => ({ allowed: true as const }),
    };
    try {
      await setupRuntime(paths, config);
      runtime = await startDaemon(options);
      const start = {
        privacy: 'public',
        hostId: 'codex',
        requestId: 'start_fixture',
        model: 'gpt-6.1-sol',
        effort: 'high',
        access: 'edit',
        seed,
      };
      const started = await rpc('managed.start', start);
      await wait(started.job.id, 'succeeded');
      const before = await rpc('managed.get', { id: started.id });
      assert.equal(before.ownership.phase, 'active');
      const request = {
        privacy: 'public',
        id: started.id,
        requestId: 'turn_fixture',
        expectedVersion: before.ownership.version,
        text: 'One original public task',
        allowUnknownQuota: true,
      };
      const turn = await rpc('managed.turn', request);
      await wait(turn.job.id, mode === 'normal' ? 'succeeded' : 'unknown');
      if (mode === 'normal') {
        const window = await rpc('managed.capture', {
          privacy: 'public',
          id: started.id,
          afterCursor: null,
        });
        assert.equal(window.complete, true);
        assert.equal(window.evidence.length, 3);
      }
      const count = records(sb).filter((row) => row.request?.method === 'turn/start').length;
      const pids = records(sb)
        .filter((row) => row.argv?.[0] === 'app-server')
        .map((row) => row.pid!);
      await runtime.close();
      runtime = await startDaemon(options);
      for (const pid of pids)
        assert.throws(
          () => process.kill(pid, 0),
          (error: NodeJS.ErrnoException) => error.code === 'ESRCH',
        );
      const duplicate = await rpc('managed.turn', request);
      assert.equal(duplicate.duplicate, true);
      assert.equal(duplicate.job.id, turn.job.id);
      assert.equal((await rpc('managed.get', { id: started.id })).ownership.phase, 'held');
      await assert.rejects(rpc('managed.turn', { ...request, requestId: 'new_after_restart' }));
      assert.equal(records(sb).filter((row) => row.request?.method === 'turn/start').length, count);
      assert.equal(
        records(sb).some((row) => row.argv?.[0] === 'exec'),
        false,
      );
    } finally {
      await runtime?.close();
      await f.driver.close?.();
      sb.cleanup();
    }
  });
