import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox } from './helpers.ts';
import { BosunError } from '../src/core/errors.ts';
import { connectClaudeStream, type ClaudeStreamOptions, type ClaudeReadMethod, type ClaudeConnectionDiagnostic } from '../src/adapters/hosts/claude/client.ts';
import { CLAUDE_VERSION } from '../src/adapters/hosts/claude/runner.ts';

const SESSION = '019aa001-aaaa-7aaa-8aaa-000000000001';
const USER = '019aa002-bbbb-7bbb-8bbb-000000000002';
const MODEL = 'claude-sonnet-4-7';
const signal = () => new AbortController().signal;
const unknown = (error: unknown) => error instanceof BosunError && error.details?.outcome === 'unknown'
  && !/CANARY|password|account/.test(JSON.stringify(error));
function fixture(mode = 'normal', nativeVersion = CLAUDE_VERSION) {
  const sb = sandbox();
  const command = path.join(sb.root, 'stubs', 'claude');
  fs.writeFileSync(command, `#!/usr/bin/env node
const fs=require('node:fs'),rl=require('node:readline').createInterface({input:process.stdin});
const record=row=>fs.appendFileSync(process.env.STUB_OUT,JSON.stringify(row)+'\\n');
const send=row=>process.stdout.write(JSON.stringify(row)+'\\n');
record({argv:process.argv.slice(2),pid:process.pid,suppressed:Object.hasOwn(process.env,'CLAUDE_CODE_SKIP_PROMPT_HISTORY')});
if(process.argv.includes('--version')){process.stdout.write(process.env.STUB_VERSION+' (Claude Code)\\n');process.exit(0);}
const mode=process.env.STUB_MODE;
process.on('SIGTERM',()=>{setTimeout(()=>process.exit(0),60)});
rl.on('line',line=>{
 const row=JSON.parse(line);record({row});
 if(row.type==='control_response')return;
 if(row.type==='user'){
  if(!process.argv.includes('--replay-user-messages'))return;
  if(mode==='lost-append'){process.exit(0);return;}
  const replay={...row,isReplay:true};
  if(mode==='wrong-seed')replay.message={role:'user',content:'OTHER'};
  if(mode==='array-seed')replay.message={role:'user',content:[{type:'text',text:row.message.content}]};
  if(mode==='extra-content')replay.message={role:'user',content:[{type:'text',text:row.message.content},{type:'text',text:'OTHER'}]};
  if(mode==='wrong-user')replay.uuid='019aa002-bbbb-7bbb-8bbb-000000000099';
  if(mode==='wrong-session')replay.session_id='019aa001-aaaa-7aaa-8aaa-000000000099';
  if(mode==='model-turn'){send({type:'assistant',session_id:row.session_id,message:{content:[{type:'text',text:'MODEL_CANARY'}]}});return;}
  send(replay);return;
 }
 const subtype=row.request.subtype;
 if(subtype==='initialize'&&mode==='init-timeout')return;
 if(subtype==='initialize'&&mode==='init-exit'){process.stderr.write('PRIVATE_ACCOUNT_CANARY');process.exit(23);return;}
 if(subtype==='initialize'&&mode==='init-signal'){process.removeAllListeners('SIGTERM');process.kill(process.pid,'SIGTERM');return;}
 if(subtype==='initialize'&&mode==='init-error'){send({type:'control_response',response:{subtype:'error',request_id:row.request_id,error:'PRIVATE_ACCOUNT_CANARY'}});return;}
 if(mode==='session-state'&&subtype!=='initialize')send({type:'system',subtype:'session_state_changed',state:'idle',uuid:'${USER}',session_id:'${SESSION}'});
 if(mode==='timeout'&&subtype!=='initialize')return;
 if(mode==='error'&&subtype!=='initialize'){send({type:'control_response',response:{subtype:'error',request_id:row.request_id,error:'PRIVATE_ACCOUNT_CANARY'}});return;}
 if(mode==='foreign-id'&&subtype!=='initialize'){send({type:'control_response',response:{subtype:'success',request_id:'foreign',response:{}}});return;}
 if(mode==='tools'&&subtype!=='initialize'){
  send({type:'control_request',request_id:'permission_a',request:{subtype:'can_use_tool',tool_name:'Bash',input:{command:'PRIVATE_TOOL_CANARY'}}});
  send({type:'control_request',request_id:'permission_b',request:{subtype:'hook_callback',callback_id:'PRIVATE_HOOK_CANARY'}});
 }
 send({type:'control_response',response:{subtype:'success',request_id:row.request_id,response:subtype==='initialize'?{commands:[],agents:[],models:[],account:{}}:{ok:true}}});
});
`, { mode: 0o700 });
  let closed = false;
  const options: ClaudeStreamOptions = { command, env: sb.env({ STUB_MODE: mode, STUB_VERSION: nativeVersion }), cwd: sb.home,
    sessionId: SESSION, model: MODEL, effort: 'high', requestTimeoutMs: 500, killGraceMs: 150,
    closed() { closed = true; } };
  return { sb, options, get closed() { return closed; },
    calls() { return fs.existsSync(sb.out) ? fs.readFileSync(sb.out, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []; } };
}

test('native bootstrap transport pins selection, disables tools and acknowledges an inference-free user append without claiming retained readiness', async () => {
  const f = fixture(); const client = await connectClaudeStream(f.options, signal());
  try {
    await client.append({ privacy: 'public', text: 'Literal $HOME and @file, /command stay public text.', uuid: USER });
    const stream = f.calls().find(call => call.argv?.includes('-p')).argv;
    for (const [flag, value] of [['--model', MODEL], ['--effort', 'high'], ['--session-id', SESSION],
      ['--tools', ''], ['--setting-sources', ''], ['--permission-mode', 'dontAsk']]) assert.equal(stream[stream.indexOf(flag) + 1], value);
    assert.ok(stream.includes('--await-initialize'));
    assert.ok(stream.includes('--replay-user-messages'));
    assert.ok(!stream.includes('--resume') && !stream.includes('--fork-session'));
    const rows = f.calls().filter(call => call.row).map(call => call.row);
    assert.equal(rows[0].request.subtype, 'initialize');
    assert.deepEqual(rows[0].request.sdkMcpServers, []);
    assert.equal(rows[1].shouldQuery, false);
    assert.equal(rows[1].client_composed, true);
    assert.equal(rows[1].uuid, USER);
    await assert.rejects(client.append({ privacy: 'public', text: 'Duplicate', uuid: USER }));
    await client.read('get_context_usage');
    assert.equal(f.calls().at(-1).row.request.detail, 'summary');
    for (const forbidden of ['background_tasks', 'interrupt', 'get_usage', 'set_model'])
      await assert.rejects(client.read(forbidden as ClaudeReadMethod), error => error instanceof BosunError && error.code === 'unsupported');
    assert.equal(f.calls().filter(call => call.row?.request?.subtype === 'background_tasks').length, 0);
  } finally { await client.close(); assert.equal(f.closed, true); f.sb.cleanup(); }
});

test('private/malformed/secret bootstrap input refuses before content access or native delivery', async () => {
  const f = fixture(); const client = await connectClaudeStream(f.options, signal());
  try {
    const count = f.calls().length;
    let read = 0;
    await assert.rejects(client.append({ privacy: 'private', uuid: USER, get text() { read++; throw Error('PRIVATE_CANARY'); } } as never));
    assert.equal(read, 0);
    for (const text of ['', 'x'.repeat(16385), 'a\0b', 'api_key=sk-proj-' + 'z'.repeat(40)])
      await assert.rejects(client.append({ privacy: 'public', text, uuid: USER }));
    assert.equal(f.calls().length, count);
  } finally { await client.close(); f.sb.cleanup(); }
});

for (const mode of ['lost-append', 'wrong-seed', 'wrong-user', 'wrong-session', 'model-turn', 'extra-content'])
  test(`native bootstrap ${mode} joins the original process and never retries or reports readiness`, async () => {
    const f = fixture(mode); const client = await connectClaudeStream(f.options, signal());
    try {
      await assert.rejects(client.append({ privacy: 'public', text: 'Public original instructions', uuid: USER }), unknown);
      assert.equal(f.closed, true);
      await assert.rejects(client.append({ privacy: 'public', text: 'Retry refused', uuid: USER }));
      assert.equal(f.calls().filter(call => call.row?.type === 'user').length, 1);
    } finally { await client.close(); f.sb.cleanup(); }
  });

for (const mode of ['timeout', 'error', 'foreign-id'])
  test(`native control ${mode} holds until original producer termination and hides raw errors`, async () => {
    const f = fixture(mode); const client = await connectClaudeStream({ ...f.options, requestTimeoutMs: 40 }, signal());
    try {
      await assert.rejects(client.read('get_settings'), unknown);
      assert.equal(f.closed, true);
      await assert.rejects(client.read('get_settings'), unknown);
      assert.equal(f.calls().filter(call => call.row?.request?.subtype === 'get_settings').length, 1);
    } finally { await client.close(); f.sb.cleanup(); }
  });

test('native permission and hook requests are explicitly denied without reading or exposing their payloads', async () => {
  const f = fixture('tools'); const client = await connectClaudeStream(f.options, signal());
  try {
    await client.read('get_settings');
    const until = Date.now() + 1000;
    while (f.calls().filter(call => call.row?.type === 'control_response').length < 2 && Date.now() < until)
      await new Promise(resolve => setTimeout(resolve, 5));
    const replies = f.calls().filter(call => call.row?.type === 'control_response').map(call => call.row.response);
    assert.equal(replies.length, 2);
    assert.deepEqual(replies[0].response, { behavior: 'deny', message: 'Bootstrap tools unavailable' });
    assert.equal(replies[1].subtype, 'error');
    assert.doesNotMatch(JSON.stringify(replies), /CANARY/);
  } finally { await client.close(); f.sb.cleanup(); }
});

test('selection validation and unsupported native version precede stream startup', async () => {
  const f = fixture();
  try {
    for (const selection of [{ sessionId: 'foreign' }, { model: '--help' }, { effort: 'unsupported' }])
      await assert.rejects(connectClaudeStream({ ...f.options, ...selection }, signal()));
    assert.deepEqual(f.calls(), []);
    fs.writeFileSync(f.options.command!, '#!/usr/bin/env node\nprocess.stdout.write("0.0.0 (Claude Code)\\n")', { mode: 0o700 });
    await assert.rejects(connectClaudeStream(f.options, signal()), error => error instanceof BosunError && error.code === 'unverified');
    assert.equal(f.closed, false);
  } finally { f.sb.cleanup(); }
});

test('Claude stream accepts supported-major releases without widening replay or read capabilities', async () => {
  for (const nativeVersion of ['2.1.247', '2.2.0']) {
    const f = fixture('normal', nativeVersion);
    const client = await connectClaudeStream(f.options, signal());
    try {
      await client.append({ privacy: 'public', text: 'Exact public native input', uuid: USER });
      assert.deepEqual(await client.read('get_settings'), { ok: true });
      await assert.rejects(client.read('set_model' as ClaudeReadMethod), error => error instanceof BosunError && error.code === 'unsupported');
      assert.equal(f.calls().filter(call => call.row?.type === 'user').length, 1);
      assert.equal(f.calls().filter(call => call.row?.request?.subtype === 'set_model').length, 0);
    } finally { await client.close(); f.sb.cleanup(); }
  }
});

test('Claude incompatible majors and malformed releases cannot start the stream', async () => {
  for (const nativeVersion of ['1.9.0', '3.0.0', '02.1.292', '2.01.292', '2.1', '2.1.292-preview', '2.1.292\nextra']) {
    const f = fixture('normal', nativeVersion);
    try {
      await assert.rejects(connectClaudeStream(f.options, signal()), error => error instanceof BosunError && error.code === 'unverified');
      assert.deepEqual(f.calls().map(call => call.argv), [['--version']]);
      assert.equal(f.closed, false);
    } finally { f.sb.cleanup(); }
  }
});

test('native text-block replay and versioned session-state notifications stay exact without becoming readiness claims', async () => {
  for (const mode of ['array-seed', 'session-state']) {
    const f = fixture(mode); const messages: Readonly<Record<string, unknown>>[] = [];
    const client = await connectClaudeStream({ ...f.options, notification: message => messages.push(message) }, signal());
    try {
      await client.append({ privacy: 'public', text: 'Exact public native input', uuid: USER });
      await client.read('get_status');
      if (mode === 'session-state') assert.equal(messages[0].state, 'idle');
      assert.equal(f.calls().filter(call => call.row?.type === 'user').length, 1);
    } finally { await client.close(); f.sb.cleanup(); }
  }
});

test('managed Claude removes inherited transcript suppression rather than setting a false-looking string', async () => {
  for (const inherited of ['1', '0', 'true', '']) {
    const f = fixture();
    f.options.env = { ...f.options.env, CLAUDE_CODE_SKIP_PROMPT_HISTORY: inherited };
    const client = await connectClaudeStream(f.options, signal());
    try {
      await client.append({ privacy: 'public', text: 'Public retained-bootstrap candidate', uuid: USER });
      const calls = f.calls().filter(call => call.argv);
      assert.equal(calls.length, 2); assert.ok(calls.every(call => call.suppressed === false));
      assert.equal(f.options.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY, inherited);
      assert.equal(calls.some(call => call.argv.includes('--no-session-persistence')), false);
      assert.equal(f.calls().find(call => call.row?.type === 'user').row.shouldQuery, false);
    } finally { await client.close(); f.sb.cleanup(); }
  }
});

test('Claude diagnostics distinguish accepted initialization from a later read failure without native payloads', async () => {
  const f = fixture('error'), diagnostics: ClaudeConnectionDiagnostic[] = [];
  const client = await connectClaudeStream({ ...f.options, diagnostic(row) {
    assert.equal(Object.isFrozen(row), true); diagnostics.push(row);
  } }, signal());
  try {
    assert.deepEqual(diagnostics.map(row => row.phase), ['version-detection', 'version-verified',
      'stream-attached', 'initialize-request', 'initialize-accepted']);
    await assert.rejects(client.read('get_settings'), unknown);
    assert.equal(f.closed, true); assert.equal(diagnostics.at(-1)!.phase, 'original-joined');
    assert.ok(diagnostics.every(row => Object.keys(row).join() === 'phase'));
    assert.doesNotMatch(JSON.stringify(diagnostics), /CANARY|account|settings|password|session|model/);
    assert.equal(f.calls().filter(call => call.row?.request?.subtype === 'initialize').length, 1);
    assert.equal(f.calls().filter(call => call.row?.request?.subtype === 'get_settings').length, 1);
  } finally { await client.close(); f.sb.cleanup(); }
});

test('Claude failed initialization diagnostics retain only fixed phases and finite native exits', async () => {
  for (const mode of ['init-error', 'init-timeout', 'init-exit', 'init-signal']) {
    const f = fixture(mode), diagnostics: ClaudeConnectionDiagnostic[] = [];
    try {
      await assert.rejects(connectClaudeStream({ ...f.options, requestTimeoutMs: 100,
        diagnostic: row => { diagnostics.push(row); } }, signal()), unknown);
      assert.equal(f.closed, true);
      assert.deepEqual(diagnostics.slice(0, 4).map(row => row.phase),
        ['version-detection', 'version-verified', 'stream-attached', 'initialize-request']);
      assert.equal(diagnostics.some(row => row.phase === 'initialize-accepted'), false);
      assert.equal(diagnostics.at(-1)!.phase, 'original-joined');
      const exits = diagnostics.filter(row => row.phase === 'native-exit');
      if (mode === 'init-exit') assert.deepEqual(exits, [{ phase: 'native-exit', code: 23, signal: null }]);
      else if (mode === 'init-signal') assert.deepEqual(exits, [{ phase: 'native-exit', code: null, signal: 'SIGTERM' }]);
      else assert.deepEqual(exits, []);
      assert.doesNotMatch(JSON.stringify(diagnostics), /CANARY|account|password|session|model/);
      assert.equal(f.calls().filter(call => call.row?.request?.subtype === 'initialize').length, 1);
      assert.equal(f.calls().some(call => call.row?.request?.subtype === 'get_settings'), false);
      for (const call of f.calls().filter(call => call.argv))
        assert.throws(() => process.kill(call.pid, 0), (error: NodeJS.ErrnoException) => error.code === 'ESRCH');
    } finally { f.sb.cleanup(); }
  }
});

test('throwing or rejecting Claude diagnostic observers do not change append, read, denial or positive join', async () => {
  for (const asynchronous of [false, true]) {
    const f = fixture('tools'); let observed = 0;
    const observer = (row: ClaudeConnectionDiagnostic) => {
      observed++; assert.equal(Object.isFrozen(row), true);
      if (asynchronous) return Promise.reject(Error('DIAGNOSTIC_CANARY'));
      throw Error('DIAGNOSTIC_CANARY');
    };
    const client = await connectClaudeStream({ ...f.options, diagnostic: observer }, signal());
    try {
      await client.append({ privacy: 'public', text: 'Public original append', uuid: USER });
      assert.deepEqual(await client.read('get_status'), { ok: true });
      await client.close();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(f.closed, true); assert.equal(observed, 6);
      const replies = f.calls().filter(call => call.row?.type === 'control_response').map(call => call.row.response);
      assert.equal(replies.length, 2);
      assert.deepEqual(replies[0].response, { behavior: 'deny', message: 'Bootstrap tools unavailable' });
      assert.equal(replies[1].subtype, 'error');
      assert.equal(f.calls().filter(call => call.row?.type === 'user').length, 1);
      assert.equal(f.calls().filter(call => call.row?.request?.subtype === 'get_status').length, 1);
    } finally { await client.close(); f.sb.cleanup(); }
  }
});

test('Claude closed callback never claims join when synthetic group termination remains uncertain after the real parent exited', async t => {
  const f = fixture(), diagnostics: ClaudeConnectionDiagnostic[] = [];
  const client = await connectClaudeStream({ ...f.options, diagnostic: row => { diagnostics.push(row); } }, signal());
  const pid = f.calls().find(call => call.argv?.includes('-p')).pid;
  const actualKill = process.kill;
  // There is no child left behind. Only the group existence/denial observations
  // are synthetic; TERM and the original stub process's close stay real.
  const mock = t.mock.method(process, 'kill', (target: number, name?: string | number) => {
    if (target === -pid && name === 0) return true;
    if (target === -pid && name === 'SIGKILL')
      throw Object.assign(Error('GROUP_DIAGNOSTIC_CANARY'), { code: 'EPERM' });
    return Reflect.apply(actualKill, process, [target, name]);
  });
  try {
    await assert.rejects(client.close(), unknown);
    assert.equal(f.closed, false);
    assert.equal(diagnostics.at(-1)!.phase, 'original-join-unknown');
    assert.equal(diagnostics.some(row => row.phase === 'original-joined'), false);
    assert.doesNotMatch(JSON.stringify(diagnostics), /CANARY|EPERM|pid|group|account/);
    assert.throws(() => Reflect.apply(actualKill, process, [pid, 0]),
      (error: NodeJS.ErrnoException) => error.code === 'ESRCH');
    assert.throws(() => Reflect.apply(actualKill, process, [-pid, 0]),
      (error: NodeJS.ErrnoException) => error.code === 'ESRCH');
    const originalCount = f.calls().length;
    await assert.rejects(client.read('get_settings'), unknown);
    await assert.rejects(client.close(), unknown);
    assert.equal(f.calls().length, originalCount);
  } finally { mock.mock.restore(); await client.close().catch(() => {}); f.sb.cleanup(); }
});
