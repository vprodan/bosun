import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runtimeFixture } from './runtime-fixture.ts';
import { bosun } from './helpers.ts';
import { createClaudeRunner, CLAUDE_VERSION } from '../src/adapters/hosts/claude/runner.ts';
import { main } from '../src/app/cli.ts';

const MODEL = 'claude-sonnet-5',
  TASK = 'Public task: keep "$HOME", `backticks` and $(literal) intact.\nVerify Unicode — exact.\n';
type Fixture = Awaited<ReturnType<typeof runtimeFixture>>;
async function fixture() {
  let f: Fixture;
  f = await runtimeFixture(`[roles.worker.claude]\nmodel="${MODEL}"\neffort="high"\n`, {
    runners: {
      claude: () =>
        createClaudeRunner({
          env: {
            ...f.env,
            CLAUDECODE: '1',
            CLAUDE_EFFORT: 'xhigh',
            CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/parent.sock',
            CLAUDE_CODE_SUBAGENT_MODEL: 'owner-native-subagent',
            ANTHROPIC_AUTH_TOKEN: 'native-auth-fixture',
          },
        }),
    },
  });
  const trace = path.join(f.sb.root, 'native-execution.jsonl');
  fs.writeFileSync(
    path.join(f.sb.bin, 'claude'),
    `#!/usr/bin/env node
const fs=require('node:fs'),args=process.argv.slice(2);
if(args.includes('--version')){process.stdout.write('${CLAUDE_VERSION} (Claude Code)\\n');process.exit(0);}
const prompt=fs.readFileSync(0,'utf8'),model=args[args.indexOf('--model')+1],session='00000000-0000-4000-8000-000000000001';
fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({args,prompt,cwd:process.cwd(),env:Object.fromEntries(['CLAUDECODE','CLAUDE_EFFORT','CLAUDE_CODE_MESSAGING_SOCKET','CLAUDE_CODE_SUBAGENT_MODEL','ANTHROPIC_AUTH_TOKEN','BOSUN_DEPTH','BOSUN_CALLER'].map(k=>[k,process.env[k]??null]))})+'\\n');
const rows=[{type:'system',subtype:'init',session_id:session,cwd:process.cwd(),model,permissionMode:'dontAsk',tools:['Read','Glob','Grep','Edit','Write','EndConversation'],mcp_servers:[]},
{type:'assistant',session_id:session,message:{model,content:[{type:'text',text:'Completed bounded public task.'}]}},
{type:'result',subtype:'success',is_error:false,session_id:session,result:'Completed bounded public task.',usage:{input_tokens:7,output_tokens:3},modelUsage:{[model]:{inputTokens:7,outputTokens:3}}}];
for(const row of rows)process.stdout.write(JSON.stringify(row)+'\\n');
`,
    { mode: 0o755 },
  );
  return {
    ...f,
    trace,
    nativeCalls: () =>
      fs.existsSync(trace)
        ? fs
            .readFileSync(trace, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
        : [],
  };
}
async function terminal(f: Fixture, id: string) {
  let job = await f.rpc('job.get', { id });
  for (let n = 0; n < 200 && ['queued', 'running'].includes(job.state); n++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    job = await f.rpc('job.get', { id });
  }
  assert.ok(!['queued', 'running'].includes(job.state));
  return job;
}

test('final run literal, public file and real stdin all reach one pinned native executor with isolated parent controls and original dedupe', async () => {
  const f = await fixture();
  try {
    const file = path.join(f.workspace, 'public-task.txt');
    fs.writeFileSync(file, TASK);
    for (const [name, args, stdin] of [
      ['literal', [TASK], undefined],
      ['file', ['-f', file], undefined],
      ['stdin', ['-f', '-'], TASK],
    ] as const) {
      const result = await bosun(['run', ...args, '--host', 'claude', '--request-id', name], {
        env: f.env,
        cwd: f.workspace,
        ...(stdin ? { input: stdin } : {}),
      });
      assert.equal(result.code, 0, result.err);
      const queued = JSON.parse(result.out);
      assert.equal((await terminal(f, queued.job.id)).state, 'succeeded');
      const repeated = await bosun(['run', ...args, '--host', 'claude', '--request-id', name], {
        env: f.env,
        cwd: f.workspace,
        ...(stdin ? { input: stdin } : {}),
      });
      assert.equal(repeated.code, 0, repeated.err);
      assert.equal(JSON.parse(repeated.out).job.id, queued.job.id);
    }
    assert.equal(f.nativeCalls().length, 3);
    for (const call of f.nativeCalls()) {
      assert.equal(call.prompt, TASK);
      assert.equal(call.cwd, f.workspace);
      assert.equal(call.args[call.args.indexOf('--model') + 1], MODEL);
      assert.equal(call.args[call.args.indexOf('--effort') + 1], 'high');
      assert.equal(call.args[call.args.indexOf('--output-format') + 1], 'stream-json');
      for (const name of ['CLAUDECODE', 'CLAUDE_EFFORT', 'CLAUDE_CODE_MESSAGING_SOCKET'])
        assert.equal(call.env[name], null);
      assert.equal(
        call.env.ANTHROPIC_AUTH_TOKEN,
        'native-auth-fixture',
        'selected native authentication is retained with its own host',
      );
      assert.equal(call.env.CLAUDE_CODE_SUBAGENT_MODEL, 'owner-native-subagent');
      assert.equal(call.env.BOSUN_DEPTH, '1');
      assert.equal(call.env.BOSUN_CALLER, 'model');
    }
  } finally {
    await f.close();
  }
});

test('nested run rejects before task file, configuration getters, queue writes or native discovery', async () => {
  const f = await fixture();
  try {
    let touched = 0,
      error = '';
    const env = {
      ...f.env,
      BOSUN_DEPTH: '1',
      get BOSUN_ROLE_WORKER_CLAUDE_MODEL(): string {
        touched++;
        throw Error('CONFIG CANARY');
      },
    };
    const result = await main(['run', '-f', path.join(f.workspace, 'missing-file')], {
      env,
      cwd: f.workspace,
      stdout() {},
      stderr: (text) => (error += text),
    });
    assert.equal(result, 1);
    assert.equal(JSON.parse(error).error.code, 'unsupported');
    assert.equal(touched, 0);
    assert.deepEqual((await f.rpc('job.list', {})).jobs, []);
    assert.deepEqual(f.nativeCalls(), []);
  } finally {
    await f.close();
  }
});

test('run rejects missing/ambiguous/oversized and credential-bearing task input before owner jobs or native effects', async () => {
  const f = await fixture();
  try {
    const file = path.join(f.workspace, 'too-big.txt');
    fs.writeFileSync(file, 'x'.repeat(32769));
    const malformed = path.join(f.workspace, 'invalid-utf8.txt');
    fs.writeFileSync(malformed, new Uint8Array([0xc3, 0x28]));
    for (const args of [[], [TASK, '-f', file], ['-f', file], ['-f', malformed], ['   ']]) {
      const result = await f.cli(['run', ...args, '--host', 'claude']);
      assert.equal(result.code, 2);
    }
    const invalidStdin = await bosun(['run', '-f', '-', '--host', 'claude'], {
      env: f.env,
      cwd: f.workspace,
      input: new Uint8Array([0xc3, 0x28]),
    });
    assert.equal(invalidStdin.code, 2);
    assert.equal(JSON.parse(invalidStdin.err).error.code, 'invalid');
    const secret = await f.cli(['run', 'api_key=' + 'x'.repeat(40), '--host', 'claude']);
    assert.equal(secret.code, 1);
    assert.equal(JSON.parse(secret.err).error.code, 'private_input');
    assert.deepEqual((await f.rpc('job.list', {})).jobs, []);
    assert.deepEqual(f.nativeCalls(), []);
  } finally {
    await f.close();
  }
});
