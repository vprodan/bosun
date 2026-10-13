import './bootstrap.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { sandbox, type Sandbox } from './helpers.ts';
import { BosunError } from '../src/core/errors.ts';
import { createCodexRunner, CODEX_VERSION } from '../src/adapters/hosts/codex/runner.ts';
import { connectCodexAppServer } from '../src/adapters/hosts/codex/client.ts';
import { createCodexQuotaSource } from '../src/adapters/hosts/codex/quota-source.ts';
import { createClaudeRunner, CLAUDE_VERSION } from '../src/adapters/hosts/claude/runner.ts';
import { nativeRunners } from '../src/app/native-runners.ts';
import { openDaemonJobs } from '../src/app/jobs.ts';
import { defaultConfig } from '../src/core/domain/config.ts';
import type { RunEvent, RunSpec } from '../src/core/ports/runner.ts';

const rows = [
  { type: 'thread.started', thread_id: 'native-thread' },
  { type: 'turn.started' },
  {
    type: 'item.completed',
    item: {
      id: 'item_0',
      type: 'command_execution',
      command: 'COMMAND_CANARY',
      aggregated_output: 'OUTPUT_CANARY',
    },
  },
  {
    type: 'item.completed',
    item: {
      id: 'item_1',
      type: 'file_change',
      changes: [{ path: 'src/example.ts', kind: 'update' }],
    },
  },
  {
    type: 'item.completed',
    item: { id: 'item_2', type: 'agent_message', text: 'Verified native result — exact' },
  },
  {
    type: 'turn.completed',
    usage: { input_tokens: 50, cached_input_tokens: 30, output_tokens: 12 },
  },
];
const jsonl = (values: unknown[]) => values.map((value) => JSON.stringify(value)).join('\n') + '\n';
function env(sb: Sandbox, output = jsonl(rows), code = 0, version = CODEX_VERSION) {
  return sb.env({
    STUB_MAP: JSON.stringify({
      'codex --version': { out: `codex-cli ${version}\n` },
      'codex exec': { out: output, code },
    }),
    CODEX_HOME: path.join(sb.home, '.codex'),
    CODEX_OSS_BASE_URL: 'http://configured-native-provider.invalid/v1',
  });
}
function spec(sb: Sandbox, extra: Partial<RunSpec> = {}): RunSpec {
  return {
    prompt: 'literal $(never-execute) task — public',
    privacy: 'public',
    cwd: sb.home,
    access: 'edit',
    model: 'gpt-6.1-sol:exact:tag',
    effort: 'ultra',
    signal: new AbortController().signal,
    ...extra,
  };
}
async function collect(events: AsyncIterable<RunEvent>) {
  const out: RunEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}
const unknown = (error: unknown) =>
  error instanceof BosunError &&
  error.code === 'unavailable' &&
  error.details?.outcome === 'unknown';

test('Codex constructor is inert and privacy screening precedes content, options and executable discovery', async () => {
  let reads = 0;
  const runner = createCodexRunner({
    get env(): never {
      reads++;
      throw new Error('ENV_CANARY');
    },
  });
  const sb = sandbox();
  try {
    assert.equal(reads, 0);
    for (const privacy of ['private', 'unknown', undefined]) {
      const input = {
        ...spec(sb),
        privacy,
        get prompt(): never {
          reads++;
          throw new Error('PROMPT_CANARY');
        },
      } as RunSpec;
      await assert.rejects(
        collect(runner.run(input)),
        (error: unknown) => error instanceof BosunError && error.code === 'private_input',
      );
    }
    await assert.rejects(
      collect(runner.run(Object.create(spec(sb)))),
      (error: unknown) => error instanceof BosunError && error.code === 'private_input',
    );
    const getter = {
      ...spec(sb),
      get privacy() {
        reads++;
        return 'public' as const;
      },
    };
    await assert.rejects(
      collect(runner.run(getter)),
      (error: unknown) => error instanceof BosunError && error.code === 'private_input',
    );
    assert.equal(reads, 0);
    assert.deepEqual(sb.calls(), []);
  } finally {
    sb.cleanup();
  }
});

test('Codex exact model/effort/cwd/native environment and stdin survive actual guarded process execution', async () => {
  const sb = sandbox();
  try {
    const environment = env(sb);
    const input = spec(sb);
    const runner = createCodexRunner({ env: environment });
    const events = await collect(runner.run(input));
    assert.deepEqual(events, [
      { t: 'tool', name: 'command_execution' },
      { t: 'file', path: 'src/example.ts', op: 'edit' },
      { t: 'text', text: 'Verified native result — exact' },
      { t: 'usage', tokensIn: 50, tokensOut: 12 },
      { t: 'done', code: 0, result: 'Verified native result — exact' },
    ]);
    assert.equal(JSON.stringify(events).includes('CANARY'), false);
    const calls = sb.calls();
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0]!.argv, ['--version']);
    const call = calls[1]!;
    assert.equal(call.cwd, input.cwd);
    assert.equal(call.stdin, input.prompt);
    assert.equal(call.argv[call.argv.indexOf('-m') + 1], input.model);
    assert.equal(call.argv[call.argv.indexOf('-C') + 1], input.cwd);
    assert.ok(call.argv.includes('model_reasoning_effort="ultra"'));
    assert.ok(call.argv.includes('approval_policy="never"'));
    assert.ok(call.argv.includes('sandbox_workspace_write.network_access=false'));
    assert.equal(call.argv.includes('--ignore-user-config'), false);
    assert.equal(call.argv.at(-1), '-');
    assert.equal(call.env.CODEX_HOME, environment.CODEX_HOME);
    assert.equal(call.env.CODEX_OSS_BASE_URL, environment.CODEX_OSS_BASE_URL);
    assert.equal(call.env.BOSUN_DEPTH, '1');
    assert.equal(call.env.BOSUN_CALLER, 'model');
    assert.equal(call.argv.includes(input.prompt), false);
    assert.equal(runner.caps.readOnly, 'unverified');
  } finally {
    sb.cleanup();
  }
});

test('Codex unsupported controls and unqualified read-only stay held before prompt getters or native probes', async () => {
  const sb = sandbox();
  let reads = 0;
  try {
    const runner = createCodexRunner({ env: env(sb) });
    for (const extra of [
      { access: 'read' as const },
      { maxTurns: 5 },
      { mcp: [{ name: 'new', command: 'something', args: [] }] },
      { env: { HOME: '/other' } },
    ]) {
      const input = {
        ...spec(sb, extra),
        get prompt(): never {
          reads++;
          throw new Error('PROMPT_CANARY');
        },
      };
      await assert.rejects(
        collect(runner.run(input)),
        (error: unknown) =>
          error instanceof BosunError && ['unsupported', 'unverified'].includes(error.code),
      );
    }
    assert.equal(reads, 0);
    assert.deepEqual(sb.calls(), []);
    for (const extra of [
      { model: '' },
      { model: 'bad\nmodel' },
      { effort: 'high"\nkey=true' },
      { cwd: 'relative' },
    ]) {
      await assert.rejects(
        collect(runner.run(spec(sb, extra))),
        (error: unknown) => error instanceof BosunError && error.code === 'invalid',
      );
    }
    assert.deepEqual(sb.calls(), []);
  } finally {
    sb.cleanup();
  }
});

test('Codex native version mismatch never starts an agent or substitutes an older protocol', async () => {
  const sb = sandbox();
  try {
    const runner = createCodexRunner({ env: env(sb, jsonl(rows), 0, '1.0.0') });
    assert.equal((await runner.detect(env(sb, jsonl(rows), 0, '1.0.0'))).version, '1.0.0');
    sb.reset();
    await assert.rejects(
      collect(runner.run(spec(sb))),
      (error: unknown) => error instanceof BosunError && error.code === 'unverified',
    );
    assert.deepEqual(
      sb.calls().map((call) => call.argv),
      [['--version']],
    );
  } finally {
    sb.cleanup();
  }
});

test('Codex partial, malformed, failed and duplicate native terminal records never invent completion or retry', async () => {
  const sb = sandbox();
  try {
    for (const output of [
      jsonl(rows.slice(0, -1)),
      '{"type":\n',
      jsonl([...rows.slice(0, 2), { type: 'turn.failed', error: { message: 'SECRET_CANARY' } }]),
      jsonl([...rows, rows.at(-1)]),
      jsonl([{ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 2 } }]),
      jsonl([
        ...rows.slice(0, -1),
        { type: 'turn.completed', usage: { input_tokens: -1, output_tokens: 12 } },
      ]),
    ]) {
      sb.reset();
      const observed: RunEvent[] = [];
      await assert.rejects(
        async () => {
          for await (const event of createCodexRunner({ env: env(sb, output) }).run(spec(sb)))
            observed.push(event);
        },
        (error: unknown) => unknown(error) && !(error as Error).message.includes('CANARY'),
      );
      assert.equal(
        observed.some((event) => event.t === 'done'),
        false,
      );
      assert.equal(sb.calls().length, 2);
    }
    await assert.rejects(
      collect(createCodexRunner({ env: env(sb, jsonl(rows), 7) }).run(spec(sb))),
      unknown,
    );
  } finally {
    sb.cleanup();
  }
});

test('Codex native completion followed by a stuck process times out and awaits actual termination', async () => {
  const sb = sandbox();
  const observed: RunEvent[] = [];
  try {
    const script = `#!/usr/bin/env node\nconst fs=require('node:fs');if(process.argv.includes('--version')){process.stdout.write('codex-cli ${CODEX_VERSION}\\n');}else{fs.writeFileSync(process.env.STUB_OUT,String(process.pid));process.on('SIGTERM',()=>{});process.stdout.write(${JSON.stringify(jsonl(rows))});setInterval(()=>{},1000);}\n`;
    fs.writeFileSync(path.join(sb.bin, 'codex'), script, { mode: 0o755 });
    const runner = createCodexRunner({ env: sb.env(), timeoutMs: 150, killGraceMs: 20 });
    await assert.rejects(
      async () => {
        for await (const event of runner.run(spec(sb))) observed.push(event);
      },
      (error: unknown) =>
        error instanceof BosunError &&
        error.code === 'timeout' &&
        error.details?.outcome === 'unknown',
    );
    const pid = Number(fs.readFileSync(sb.out, 'utf8'));
    assert.ok(pid > 0);
    assert.throws(
      () => process.kill(pid, 0),
      (error: NodeJS.ErrnoException) => error.code === 'ESRCH',
    );
    assert.equal(
      observed.some((event) => event.t === 'usage'),
      true,
    );
    assert.equal(
      observed.some((event) => event.t === 'done'),
      false,
    );
  } finally {
    sb.cleanup();
  }
});

test('Codex cancellation stops native work before the iterator and queued ownership can drain', async () => {
  const sb = sandbox();
  const controller = new AbortController();
  let pid = 0;
  try {
    const script = `#!/usr/bin/env node\nif(process.argv.includes('--version')){process.stdout.write('codex-cli ${CODEX_VERSION}\\n');}else{require('node:fs').writeFileSync(process.env.STUB_OUT,String(process.pid));process.on('SIGTERM',()=>{});process.stdout.write(${JSON.stringify(jsonl(rows.slice(0, 5)))});setInterval(()=>{},1000);}\n`;
    fs.writeFileSync(path.join(sb.bin, 'codex'), script, { mode: 0o755 });
    const runner = createCodexRunner({ env: sb.env(), killGraceMs: 20 });
    await assert.rejects(
      async () => {
        for await (const event of runner.run(spec(sb, { signal: controller.signal }))) {
          if (event.t === 'text') {
            pid = Number(fs.readFileSync(sb.out, 'utf8'));
            controller.abort();
          }
          assert.notEqual(event.t, 'done');
        }
      },
      (error: unknown) =>
        error instanceof BosunError &&
        error.code === 'cancelled' &&
        error.details?.outcome === 'unknown',
    );
    assert.ok(pid > 0);
    assert.throws(
      () => process.kill(pid, 0),
      (error: NodeJS.ErrnoException) => error.code === 'ESRCH',
    );
  } finally {
    sb.cleanup();
  }
});

function claudeRows(sb: Sandbox, model = 'claude-sonnet-5', access: 'read' | 'edit' = 'read') {
  const session = '00000000-0000-4000-8000-000000000001';
  return [
    {
      type: 'system',
      subtype: 'init',
      session_id: session,
      cwd: sb.home,
      model,
      permissionMode: 'dontAsk',
      tools:
        access === 'read'
          ? ['Read', 'Glob', 'Grep', 'EndConversation']
          : ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'EndConversation'],
      mcp_servers: [],
    },
    {
      type: 'assistant',
      session_id: session,
      parent_tool_use_id: null,
      message: {
        model,
        content: [
          { type: 'tool_use', id: 'tool_1', name: 'Read', input: { file_path: 'INPUT_CANARY' } },
          { type: 'thinking', thinking: 'THINKING_CANARY', signature: 'SIGNATURE_CANARY' },
          { type: 'text', text: 'Native Claude answer' },
        ],
      },
    },
    {
      type: 'user',
      session_id: session,
      message: { content: [{ type: 'tool_result', content: 'TOOL_OUTPUT_CANARY' }] },
    },
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: session,
      result: 'Native Claude answer',
      usage: { input_tokens: 8, output_tokens: 17, cache_read_input_tokens: 20 },
      modelUsage: { [model]: { inputTokens: 8, outputTokens: 17 } },
    },
  ];
}
function claudeEnv(
  sb: Sandbox,
  output = jsonl(claudeRows(sb)),
  code = 0,
  version = CLAUDE_VERSION,
) {
  return sb.env({
    STUB_MAP: JSON.stringify({
      'claude --version': { out: `${version} (Claude Code)\n` },
      'claude -p': { out: output, code },
    }),
    CLAUDE_CONFIG_DIR: path.join(sb.home, '.claude'),
    CLAUDECODE: '1',
    ANTHROPIC_BASE_URL: 'http://explicit-native-provider.invalid',
  });
}

test('Claude explicit native read tools/model/effort/MCP deny rules preserve auth selection and protocol stdout', async () => {
  const sb = sandbox();
  try {
    const environment: Record<string, string> = {
      ...claudeEnv(sb),
      CLAUDE_EFFORT: 'xhigh',
      CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/parent.sock',
      CLAUDE_CODE_SUBAGENT_MODEL: 'selected-native-subagent',
    };
    const input = spec(sb, {
      access: 'read',
      model: 'claude-sonnet-5',
      effort: 'max',
      maxTurns: 4,
    });
    const runner = createClaudeRunner({ env: environment });
    assert.equal(runner.caps.sandbox, 'tool-allowlist');
    assert.deepEqual(await collect(runner.run(input)), [
      { t: 'tool', name: 'Read' },
      { t: 'text', text: 'Native Claude answer' },
      { t: 'usage', tokensIn: 8, tokensOut: 17 },
      { t: 'done', code: 0, result: 'Native Claude answer' },
    ]);
    const calls = sb.calls();
    assert.equal(calls.length, 2);
    const call = calls[1]!;
    assert.equal(call.stdin, input.prompt);
    assert.equal(call.cwd, input.cwd);
    assert.equal(call.argv[call.argv.indexOf('--model') + 1], input.model);
    assert.equal(call.argv[call.argv.indexOf('--effort') + 1], 'max');
    assert.equal(call.argv[call.argv.indexOf('--max-turns') + 1], '4');
    assert.equal(call.argv[call.argv.indexOf('--tools') + 1], 'Read,Glob,Grep');
    assert.equal(call.argv[call.argv.indexOf('--disallowedTools') + 1], 'mcp__*');
    assert.equal(call.argv[call.argv.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
    assert.equal(call.argv[call.argv.indexOf('--permission-mode') + 1], 'dontAsk');
    for (const field of ['CLAUDECODE', 'CLAUDE_EFFORT', 'CLAUDE_CODE_MESSAGING_SOCKET'])
      assert.equal(
        call.env[field],
        undefined,
        'delegated runs cannot inherit parent session controls',
      );
    assert.equal(call.env.CLAUDE_CODE_SUBAGENT_MODEL, 'selected-native-subagent');
    assert.ok(call.argv.includes('--restricted'));
    assert.ok(call.argv.includes('--safe-mode'));
    assert.ok(call.argv.includes('--strict-mcp-config'));
    assert.deepEqual(JSON.parse(call.argv[call.argv.indexOf('--settings') + 1]!), {
      disableAllHooks: true,
      fallbackModel: [],
      switchModelsOnFlag: false,
    });
    assert.equal(call.env.CLAUDE_CONFIG_DIR, environment.CLAUDE_CONFIG_DIR);
    assert.equal(call.env.CLAUDECODE, undefined);
    assert.equal(call.env.ANTHROPIC_BASE_URL, environment.ANTHROPIC_BASE_URL);
    assert.equal(call.env.BOSUN_CALLER, 'model');
    assert.equal(call.argv.includes(input.prompt), false);
  } finally {
    sb.cleanup();
  }
});

test('Claude edit jobs expose file editing only; native aliases resolve without changing model families', async () => {
  const sb = sandbox();
  try {
    const runner = createClaudeRunner({
      env: claudeEnv(sb, jsonl(claudeRows(sb, 'claude-sonnet-5', 'edit'))),
    });
    assert.equal(
      (await collect(runner.run(spec(sb, { model: 'sonnet', access: 'edit', effort: 'high' })))).at(
        -1,
      )!.t,
      'done',
    );
    const call = sb.calls()[1]!;
    assert.equal(call.argv[call.argv.indexOf('--tools') + 1], 'Read,Glob,Grep,Edit,Write');
    assert.equal(
      call.argv.some((value) => value.includes('Bash') || value.includes('bypassPermissions')),
      false,
    );
  } finally {
    sb.cleanup();
  }
});

test('Claude preserves native overflow protection and explicit native context/compaction choices', async () => {
  const sb = sandbox();
  try {
    const keys = [
      'DISABLE_AUTO_COMPACT',
      'DISABLE_COMPACT',
      'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
      'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE',
    ];
    const source = `#!/usr/bin/env node\nconst fs=require('node:fs');if(process.argv.includes('--version')){process.stdout.write('${CLAUDE_VERSION} (Claude Code)\\n');}else{fs.readFileSync(0,'utf8');fs.writeFileSync(process.env.STUB_OUT,JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map(key=>[key,process.env[key]??null]))));process.stdout.write(${JSON.stringify(jsonl(claudeRows(sb)))});}\n`;
    fs.writeFileSync(path.join(sb.bin, 'claude'), source, { mode: 0o755 });
    for (const native of [
      {},
      {
        DISABLE_AUTO_COMPACT: '0',
        DISABLE_COMPACT: '0',
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000',
        CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '50',
      },
    ]) {
      await collect(
        createClaudeRunner({ env: { ...sb.env(), ...native } }).run(
          spec(sb, { access: 'read', model: 'claude-sonnet-5', effort: 'high' }),
        ),
      );
      assert.deepEqual(
        JSON.parse(fs.readFileSync(sb.out, 'utf8')),
        Object.fromEntries(keys.map((key) => [key, native[key as keyof typeof native] ?? null])),
      );
    }
  } finally {
    sb.cleanup();
  }
});

test('Claude public classification and unsupported controls are checked before content, env and native probes', async () => {
  const sb = sandbox();
  let reads = 0;
  try {
    const runner = createClaudeRunner({
      get env(): never {
        reads++;
        throw new Error('ENV_CANARY');
      },
    });
    for (const privacy of ['private', 'unknown', undefined]) {
      const input = {
        ...spec(sb),
        privacy,
        get prompt(): never {
          reads++;
          throw new Error('PROMPT_CANARY');
        },
      } as RunSpec;
      await assert.rejects(
        collect(runner.run(input)),
        (error: unknown) => error instanceof BosunError && error.code === 'private_input',
      );
    }
    for (const extra of [
      { mcp: [{ name: 'unknown', command: 'external', args: [] }] },
      { env: { CLAUDE_CODE_SAFE_MODE: '0' } },
    ]) {
      await assert.rejects(
        collect(
          runner.run({
            ...spec(sb, extra),
            get prompt(): never {
              reads++;
              throw new Error('PROMPT_CANARY');
            },
          }),
        ),
        (error: unknown) => error instanceof BosunError && error.code === 'unsupported',
      );
    }
    assert.equal(reads, 0);
    assert.deepEqual(sb.calls(), []);
    const valid = createClaudeRunner({ env: claudeEnv(sb) });
    for (const extra of [
      { maxTurns: 0 },
      { maxTurns: 257 },
      { effort: 'unsupported' },
      { model: 'bad\nmodel' },
    ]) {
      await assert.rejects(
        collect(valid.run(spec(sb, extra))),
        (error: unknown) => error instanceof BosunError && error.code === 'invalid',
      );
    }
    assert.deepEqual(sb.calls(), []);
  } finally {
    sb.cleanup();
  }
});

test('Claude native version mismatch holds the requested host without fallback or execution', async () => {
  const sb = sandbox();
  try {
    const runner = createClaudeRunner({ env: claudeEnv(sb, '', 0, '3.0.0') });
    await assert.rejects(
      collect(runner.run(spec(sb, { access: 'read', model: 'sonnet', effort: 'high' }))),
      (error: unknown) => error instanceof BosunError && error.code === 'unverified',
    );
    assert.deepEqual(
      sb.calls().map((call) => call.argv),
      [['--version']],
    );
  } finally {
    sb.cleanup();
  }
});

test('Claude mismatched native access/model/cwd/session and widened tools never produce a successful receipt', async () => {
  const sb = sandbox();
  try {
    const base = claudeRows(sb);
    const variants: unknown[][] = [
      [{ ...base[0], cwd: path.join(sb.home, 'other') }, ...base.slice(1)],
      [{ ...base[0], model: 'claude-opus-5' }, ...base.slice(1)],
      [{ ...base[0], permissionMode: 'bypassPermissions' }, ...base.slice(1)],
      [{ ...base[0], tools: ['Read', 'Write'] }, ...base.slice(1)],
      [{ ...base[0], mcp_servers: [{ name: 'external', status: 'connected' }] }, ...base.slice(1)],
      [base[0], { ...base[1], session_id: 'other' }, ...base.slice(2)],
      [base[0], { ...base[1], message: { model: 'claude-opus-5', content: [] } }, ...base.slice(2)],
      [
        ...base.slice(0, 3),
        { ...base[3], modelUsage: { 'claude-sonnet-5': {}, 'claude-opus-5': {} } },
      ],
    ];
    for (const values of variants) {
      sb.reset();
      const observed: RunEvent[] = [];
      await assert.rejects(async () => {
        for await (const event of createClaudeRunner({ env: claudeEnv(sb, jsonl(values)) }).run(
          spec(sb, { access: 'read', model: 'claude-sonnet-5', effort: 'high' }),
        ))
          observed.push(event);
      }, unknown);
      assert.equal(
        observed.some((event) => event.t === 'done'),
        false,
      );
      assert.equal(sb.calls().length, 2);
      assert.equal(JSON.stringify(observed).includes('CANARY'), false);
    }
  } finally {
    sb.cleanup();
  }
});

test('Claude native error/partial/malformed/duplicate result and nonzero process close are unknown without retry', async () => {
  const sb = sandbox();
  try {
    const base = claudeRows(sb);
    for (const output of [
      jsonl(base.slice(0, -1)),
      'BROKEN_CANARY\n',
      jsonl([...base, base.at(-1)]),
      jsonl([
        ...base.slice(0, -1),
        { ...base[3], subtype: 'error_max_turns', is_error: true, result: 'ERROR_CANARY' },
      ]),
    ]) {
      sb.reset();
      const observed: RunEvent[] = [];
      await assert.rejects(
        async () => {
          for await (const event of createClaudeRunner({ env: claudeEnv(sb, output) }).run(
            spec(sb, { access: 'read', model: 'claude-sonnet-5', effort: 'high' }),
          ))
            observed.push(event);
        },
        (error: unknown) => unknown(error) && !(error as Error).message.includes('CANARY'),
      );
      assert.equal(
        observed.some((event) => event.t === 'done'),
        false,
      );
      assert.equal(sb.calls().length, 2);
    }
    await assert.rejects(
      collect(
        createClaudeRunner({ env: claudeEnv(sb, jsonl(base), 7) }).run(
          spec(sb, { access: 'read', model: 'claude-sonnet-5', effort: 'high' }),
        ),
      ),
      unknown,
    );
  } finally {
    sb.cleanup();
  }
});

test('Claude cancellation after native text awaits process termination and never claims a successful result', async () => {
  const sb = sandbox();
  const controller = new AbortController();
  let pid = 0;
  try {
    const script = `#!/usr/bin/env node\nif(process.argv.includes('--version')){process.stdout.write('${CLAUDE_VERSION} (Claude Code)\\n');}else{require('node:fs').writeFileSync(process.env.STUB_OUT,String(process.pid));process.on('SIGTERM',()=>{});process.stdout.write(${JSON.stringify(jsonl(claudeRows(sb).slice(0, 2)))});setInterval(()=>{},1000);}\n`;
    fs.writeFileSync(path.join(sb.bin, 'claude'), script, { mode: 0o755 });
    await assert.rejects(
      async () => {
        for await (const event of createClaudeRunner({ env: sb.env(), killGraceMs: 20 }).run(
          spec(sb, {
            access: 'read',
            model: 'claude-sonnet-5',
            effort: 'high',
            signal: controller.signal,
          }),
        )) {
          if (event.t === 'text') {
            pid = Number(fs.readFileSync(sb.out, 'utf8'));
            controller.abort();
          }
          assert.notEqual(event.t, 'done');
        }
      },
      (error: unknown) =>
        error instanceof BosunError &&
        error.code === 'cancelled' &&
        error.details?.outcome === 'unknown',
    );
    assert.ok(pid > 0);
    assert.throws(
      () => process.kill(pid, 0),
      (error: NodeJS.ErrnoException) => error.code === 'ESRCH',
    );
  } finally {
    sb.cleanup();
  }
});

test('final native registry loads only the selected host, preserves explicit native home and performs no probes', async () => {
  const sb = sandbox();
  try {
    const config = defaultConfig();
    config.hosts.claude.enabled = false;
    config.hosts.codex.home = path.join(sb.home, 'selected-codex-home');
    const factories = nativeRunners(config, env(sb));
    assert.ok(Object.isFrozen(factories));
    assert.deepEqual(sb.calls(), []);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      factories.opencode!(controller.signal),
      (error: unknown) => error instanceof BosunError && error.code === 'cancelled',
    );
    const runner = await factories.codex!(new AbortController().signal);
    assert.deepEqual(sb.calls(), []);
    await collect(runner.run(spec(sb)));
    assert.ok(sb.calls().every((call) => call.bin === 'codex'));
    assert.equal(sb.calls().at(-1)!.env.CODEX_HOME, config.hosts.codex.home);
    assert.equal(fs.existsSync(config.hosts.codex.home), false);
  } finally {
    sb.cleanup();
  }
});

test('actual durable job dispatcher executes the selected native Codex once and persists the positive result', async () => {
  const sb = sandbox();
  const scope = { projectId: 'p_native' };
  let jobs: ReturnType<typeof openDaemonJobs> | undefined;
  try {
    const root = path.join(sb.home, 'runtime');
    fs.mkdirSync(root, { mode: 0o700 });
    jobs = openDaemonJobs({
      stateFile: path.join(root, 'state.db'),
      ownerFile: path.join(root, 'owner.db'),
      runners: nativeRunners(defaultConfig(), env(sb)),
      admit: async () => ({ allowed: true }),
    });
    jobs.recover();
    const input = spec(sb);
    const submitted = jobs.submit(
      {
        privacy: 'public',
        requestId: 'native-request',
        taskId: 'native-task',
        runnerId: 'codex',
        prompt: input.prompt,
        cwd: input.cwd,
        access: 'edit',
        model: input.model!,
        effort: input.effort,
      },
      scope,
    );
    await jobs.runQueued();
    assert.equal(jobs.get(scope, submitted.job.id).state, 'succeeded');
    assert.equal(jobs.result(scope, submitted.job.id), 'Verified native result — exact');
    await jobs.runQueued();
    assert.equal(sb.calls().length, 2);
    assert.ok(sb.calls().every((call) => call.bin === 'codex'));
    assert.equal(
      jobs.submit(
        {
          privacy: 'public',
          requestId: 'native-request',
          taskId: 'ignored-duplicate',
          runnerId: 'claude',
          prompt: 'Never run again',
          cwd: input.cwd,
          access: 'edit',
          model: 'different',
        },
        scope,
      ).duplicate,
      true,
    );
    assert.equal(sb.calls().length, 2);
  } finally {
    await jobs?.close();
    sb.cleanup();
  }
});

function appServerStub(sb: Sandbox, mode = 'normal') {
  const source = `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
const record=(row)=>fs.appendFileSync(process.env.STUB_OUT,JSON.stringify(row)+'\\n');
record({argv:process.argv.slice(2),pid:process.pid});
if(process.argv.includes('--version')){process.stdout.write('codex-cli '+(process.env.STUB_VERSION||'${CODEX_VERSION}')+'\\n');return;}
if(process.argv[2]==='exec'){fs.readFileSync(0,'utf8');process.stdout.write(${JSON.stringify(jsonl(rows))});return;}
process.on('SIGTERM',()=>{if(process.env.STUB_MODE!=='timeout')process.exit(0)});
const send=(row)=>process.stdout.write(JSON.stringify(row)+'\\n');
const rl=require('node:readline').createInterface({input:process.stdin});
rl.on('line',line=>{const row=JSON.parse(line);record({request:row});
 if(row.method==='initialize'){send({id:row.id,result:{codexHome:process.env.STUB_MODE==='wrong-home'?'/foreign':path.join(process.env.HOME,'.codex'),platformFamily:'unix',platformOs:'macos',userAgent:'native/${CODEX_VERSION}'}});return;}
 if(row.method==='initialized'){if(process.env.STUB_MODE==='approval'){send({method:'account/rateLimits/updated',params:{limitId:'public'}});send({id:'server-1',method:'item/commandExecution/requestApproval',params:{command:'COMMAND_CANARY'}});}return;}
 if(row.error){record({denied:row.error.code});return;}
 if(process.env.STUB_MODE.startsWith('quota')&&row.method==='account/read'){send({id:row.id,result:{account:{type:process.env.STUB_MODE==='quota-api'?'apiKey':'chatgpt',email:'EMAIL_CANARY',planType:'pro'},requiresOpenaiAuth:true}});return;}
 if(process.env.STUB_MODE.startsWith('quota')&&row.method==='account/rateLimits/read'){send({id:row.id,result:JSON.parse(process.env.STUB_QUOTA)});return;}
 if(process.env.STUB_MODE==='timeout')return;
 if(process.env.STUB_MODE==='malformed'){process.stdout.write('PROVIDER_CANARY\\n');return;}
 if(process.env.STUB_MODE==='foreign'){send({id:99999,result:'FOREIGN_CANARY'});return;}
 if(process.env.STUB_MODE==='error'){send({id:row.id,error:{code:-1,message:'SECRET_CANARY',data:{secret:'DATA_CANARY'}}});return;}
 setTimeout(()=>send({id:row.id,result:{method:row.method,refreshToken:row.params.refreshToken??null}}),row.method==='account/read'?20:5);
});
`;
  fs.writeFileSync(path.join(sb.bin, 'codex'), source, { mode: 0o755 });
  return sb.env({ STUB_MODE: mode });
}
function serverRecords(
  sb: Sandbox,
): { argv?: string[]; pid?: number; request?: Record<string, unknown>; denied?: number }[] {
  return fs
    .readFileSync(sb.out, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

test('native Codex app-server performs correlated initialization and concurrent metadata reads over bounded interactive stdio', async () => {
  const sb = sandbox();
  let client: Awaited<ReturnType<typeof connectCodexAppServer>> | undefined;
  try {
    const environment = appServerStub(sb);
    client = await connectCodexAppServer(
      { env: environment, cwd: sb.home },
      new AbortController().signal,
    );
    const values = await Promise.all([
      client.request('account/read', { refreshToken: false }),
      client.request('account/rateLimits/read', {}),
    ]);
    assert.deepEqual(values, [
      { method: 'account/read', refreshToken: false },
      { method: 'account/rateLimits/read', refreshToken: null },
    ]);
    const records = serverRecords(sb);
    const requests = records.filter((row) => row.request).map((row) => row.request!);
    assert.deepEqual(
      requests.map((row) => row.method),
      ['initialize', 'initialized', 'account/read', 'account/rateLimits/read'],
    );
    const initialization = requests[0]!.params;
    assert.ok(initialization !== null && typeof initialization === 'object' && 'capabilities' in initialization);
    assert.deepEqual(initialization.capabilities, { experimentalApi: true, explicitGatewayOauth: true });
    const startup = records.filter((row) => row.argv);
    assert.equal(startup.length, 2);
    assert.deepEqual(startup[0]!.argv, ['--version']);
    assert.ok(startup[1]!.argv!.includes('stdio://'));
    assert.equal(
      startup[1]!.argv!.some((arg) => /login|token|resume|proxy/.test(arg)),
      false,
    );
    await client.close();
    assert.throws(
      () => process.kill(startup[1]!.pid!, 0),
      (error: NodeJS.ErrnoException) => error.code === 'ESRCH',
    );
    assert.equal(fs.existsSync(path.join(sb.home, '.codex')), false);
  } finally {
    await client?.close();
    sb.cleanup();
  }
});

test('Codex transport rejects native server approvals and auth mutation methods instead of granting or forwarding credentials', async () => {
  const sb = sandbox();
  const notifications: string[] = [];
  let client: Awaited<ReturnType<typeof connectCodexAppServer>> | undefined;
  try {
    client = await connectCodexAppServer(
      {
        env: appServerStub(sb, 'approval'),
        cwd: sb.home,
        notification(method) {
          notifications.push(method);
        },
      },
      new AbortController().signal,
    );
    await client.request('account/read', { refreshToken: false });
    await assert.rejects(
      client.request('account/login/start' as any, { token: 'SECRET_CANARY' }),
      (error: unknown) => error instanceof BosunError && error.code === 'unsupported',
    );
    const records = serverRecords(sb);
    assert.deepEqual(notifications, ['account/rateLimits/updated']);
    assert.ok(records.some((row) => row.denied === -32601));
    assert.equal(JSON.stringify(records).includes('SECRET_CANARY'), false);
    assert.equal(
      records.some(
        (row) => row.request?.method === 'turn/start' || row.request?.method === 'thread/start',
      ),
      false,
    );
  } finally {
    await client?.close();
    sb.cleanup();
  }
});

test('Codex native app-server malformed/foreign response loss closes the process and never retries', async () => {
  const sb = sandbox();
  try {
    for (const mode of ['malformed', 'foreign']) {
      sb.reset();
      const client = await connectCodexAppServer(
        { env: appServerStub(sb, mode), cwd: sb.home, killGraceMs: 20 },
        new AbortController().signal,
      );
      try {
        await assert.rejects(
          client.request('account/rateLimits/read', {}),
          (error: unknown) => unknown(error) && !(error as Error).message.includes('CANARY'),
        );
      } finally {
        await client.close();
      }
      const records = serverRecords(sb);
      assert.equal(
        records.filter((row) => row.request?.method === 'account/rateLimits/read').length,
        1,
      );
      assert.throws(
        () => process.kill(records.find((row) => row.argv?.[0] === 'app-server')!.pid!, 0),
        (error: NodeJS.ErrnoException) => error.code === 'ESRCH',
      );
    }
  } finally {
    sb.cleanup();
  }
});

test('Codex native metadata errors are finite and discarded without token or provider message exposure', async () => {
  const sb = sandbox();
  let client: Awaited<ReturnType<typeof connectCodexAppServer>> | undefined;
  try {
    client = await connectCodexAppServer(
      { env: appServerStub(sb, 'error'), cwd: sb.home },
      new AbortController().signal,
    );
    await assert.rejects(
      client.request('account/read', { refreshToken: false }),
      (error: unknown) =>
        unknown(error) &&
        !JSON.stringify(error).includes('CANARY') &&
        !(error as Error).message.includes('CANARY'),
    );
    assert.equal(
      serverRecords(sb).filter((row) => row.request?.method === 'account/read').length,
      1,
    );
  } finally {
    await client?.close();
    sb.cleanup();
  }
});

test('Codex metadata request deadline and caller cancellation wait for native close even when TERM is ignored', async () => {
  const sb = sandbox();
  try {
    for (const reason of ['timeout', 'cancelled']) {
      sb.reset();
      const client = await connectCodexAppServer(
        { env: appServerStub(sb, 'timeout'), cwd: sb.home, requestTimeoutMs: 100, killGraceMs: 20 },
        new AbortController().signal,
      );
      const controller = new AbortController();
      const pending = client.request('account/rateLimits/read', {}, controller.signal);
      if (reason === 'cancelled') controller.abort();
      await assert.rejects(
        pending,
        (error: unknown) =>
          error instanceof BosunError &&
          error.code === reason &&
          error.details?.outcome === 'unknown',
      );
      await client.close();
      const records = serverRecords(sb);
      assert.equal(
        records.filter((row) => row.request?.method === 'account/rateLimits/read').length,
        1,
      );
      assert.throws(
        () => process.kill(records.find((row) => row.argv?.[0] === 'app-server')!.pid!, 0),
        (error: NodeJS.ErrnoException) => error.code === 'ESRCH',
      );
    }
  } finally {
    sb.cleanup();
  }
});

test('Codex startup is held on wrong native home/version and pre-aborted connection without adopting foreign state', async () => {
  const sb = sandbox();
  try {
    await assert.rejects(
      connectCodexAppServer(
        { env: appServerStub(sb, 'wrong-home'), cwd: sb.home },
        new AbortController().signal,
      ),
      unknown,
    );
    const records = serverRecords(sb);
    assert.throws(
      () => process.kill(records.find((row) => row.argv?.[0] === 'app-server')!.pid!, 0),
      (error: NodeJS.ErrnoException) => error.code === 'ESRCH',
    );
    sb.reset();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      connectCodexAppServer({ env: appServerStub(sb), cwd: sb.home }, controller.signal),
      (error: unknown) => error instanceof BosunError && error.code === 'cancelled',
    );
    assert.equal(fs.existsSync(sb.out), false);
    await assert.rejects(
      connectCodexAppServer(
        { env: { ...appServerStub(sb), STUB_VERSION: '1.0.0' }, cwd: sb.home },
        new AbortController().signal,
      ),
      (error: unknown) => error instanceof BosunError && error.code === 'unverified',
    );
    assert.deepEqual(
      serverRecords(sb).map((row) => row.argv),
      [['--version']],
    );
  } finally {
    sb.cleanup();
  }
});

const QUOTA_NOW = 1800000000000;
function quotaPayload() {
  const windows = {
    primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: (QUOTA_NOW + 3600000) / 1000 },
    secondary: {
      usedPercent: 60,
      windowDurationMins: 10080,
      resetsAt: (QUOTA_NOW + 604800000) / 1000,
    },
  };
  return {
    accountId: 'native-account-public',
    ordinaryUsageAllowed: true,
    rateLimits: { limitId: 'codex', ...windows },
    rateLimitsByLimitId: {
      codex: { limitId: 'codex', ...windows },
      model_sol: {
        limitId: 'model_sol',
        normalModelSlug: 'gpt-6.1-sol',
        ...windows,
        primary: { ...windows.primary, usedPercent: 95 },
      },
      unrelated: { limitId: 'unrelated', normalModelSlug: 'different-model', ...windows },
    },
    rateLimitResetCredits: { availableCount: 12 },
    providerSecret: 'TOKEN_CANARY',
  };
}

test('native Codex quota source reads only native ChatGPT account/limits and returns scrubbed generic plus selected-model batches', async () => {
  const sb = sandbox();
  try {
    const source = createCodexQuotaSource({
      env: { ...appServerStub(sb, 'quota'), STUB_QUOTA: JSON.stringify(quotaPayload()) },
      cwd: sb.home,
      now: () => QUOTA_NOW,
    });
    assert.equal(fs.existsSync(sb.out), false);
    const result = await source.read(
      { runnerId: 'codex', model: 'gpt-6.1-sol' },
      new AbortController().signal,
    );
    assert.equal(result!.length, 2);
    assert.deepEqual(
      result!.map((entry) => entry.binding.scope),
      ['pool', 'model'],
    );
    assert.deepEqual(
      result!.map((entry) => entry.binding.bucketId),
      ['codex', 'model_sol'],
    );
    assert.ok(
      result!.every(
        (entry) =>
          entry.binding.accountId === 'native-account-public' &&
          entry.binding.unit === 'work-codex',
      ),
    );
    assert.equal(result![0]!.observation!.windows[1]!.durationMinutes, 10080);
    assert.equal(result![1]!.observation!.windows[0]!.remainingPercent, 5);
    assert.equal(JSON.stringify(result).includes('CANARY'), false);
    assert.equal(JSON.stringify(result).includes('availableCount'), false);
    const records = serverRecords(sb);
    assert.deepEqual(
      records.filter((row) => row.request).map((row) => row.request!.method),
      ['initialize', 'initialized', 'account/read', 'account/rateLimits/read'],
    );
    assert.deepEqual(
      records.find((row) => row.request?.method === 'account/read')!.request!.params,
      { refreshToken: false },
    );
    assert.throws(
      () => process.kill(records.find((row) => row.argv?.[0] === 'app-server')!.pid!, 0),
      (error: NodeJS.ErrnoException) => error.code === 'ESRCH',
    );
  } finally {
    sb.cleanup();
  }
});

test('native Codex quota source never treats API auth, absent account binding or absent included-access permission as a renewed subscription balance', async () => {
  const sb = sandbox();
  try {
    const api = createCodexQuotaSource({
      env: { ...appServerStub(sb, 'quota-api'), STUB_QUOTA: JSON.stringify(quotaPayload()) },
      cwd: sb.home,
      now: () => QUOTA_NOW,
    });
    assert.equal(
      await api.read({ runnerId: 'codex', model: 'gpt-6.1-sol' }, new AbortController().signal),
      null,
    );
    assert.equal(
      serverRecords(sb).some((row) => row.request?.method === 'account/rateLimits/read'),
      false,
    );
    sb.reset();
    const payload = quotaPayload() as Record<string, unknown>;
    delete payload.accountId;
    const unbound = createCodexQuotaSource({
      env: { ...appServerStub(sb, 'quota'), STUB_QUOTA: JSON.stringify(payload) },
      cwd: sb.home,
      now: () => QUOTA_NOW,
    });
    assert.equal(
      await unbound.read({ runnerId: 'codex', model: 'gpt-6.1-sol' }, new AbortController().signal),
      null,
    );
    sb.reset();
    const missing = quotaPayload() as Record<string, unknown>;
    delete missing.ordinaryUsageAllowed;
    const unavailable = createCodexQuotaSource({
      env: { ...appServerStub(sb, 'quota'), STUB_QUOTA: JSON.stringify(missing) },
      cwd: sb.home,
      now: () => QUOTA_NOW,
    });
    const result = await unavailable.read(
      { runnerId: 'codex', model: 'gpt-6.1-sol' },
      new AbortController().signal,
    );
    assert.ok(result!.every((entry) => entry.observation!.ordinaryUsageAllowed === null));
    sb.reset();
    let envReads = 0;
    const inert = createCodexQuotaSource({
      get env(): never {
        envReads++;
        throw new Error('ENV_CANARY');
      },
      cwd: sb.home,
      now: () => QUOTA_NOW,
    });
    await assert.rejects(
      inert.read({ runnerId: 'claude', model: 'sonnet' }, new AbortController().signal),
      (error: unknown) => error instanceof BosunError && error.code === 'invalid',
    );
    assert.equal(envReads, 0);
    assert.equal(fs.existsSync(sb.out), false);
  } finally {
    sb.cleanup();
  }
});

test('actual queued native Codex remains held through a short reset and owner unknown opt-in, then runs once after fresh weekly/model recovery', async () => {
  const sb = sandbox();
  let jobs: ReturnType<typeof openDaemonJobs> | undefined;
  let at = QUOTA_NOW;
  const payload = quotaPayload();
  payload.rateLimits.secondary.usedPercent = 100;
  payload.rateLimitsByLimitId.codex.secondary.usedPercent = 100;
  const scope = { projectId: 'p_native_quota' };
  const choice = { runnerId: 'codex', model: 'gpt-6.1-sol' };
  try {
    const environment = appServerStub(sb, 'quota');
    const config = defaultConfig();
    const dir = path.join(sb.home, 'native-quota-state');
    fs.mkdirSync(dir, { mode: 0o700 });
    jobs = openDaemonJobs({
      stateFile: path.join(dir, 'state.db'),
      ownerFile: path.join(dir, 'owner.db'),
      now: () => at,
      runners: nativeRunners(config, environment),
      quotaSources: {
        codex: {
          read(selection, signal) {
            return createCodexQuotaSource({
              env: { ...environment, STUB_QUOTA: JSON.stringify(payload) },
              cwd: sb.home,
              now: () => at,
            }).read(selection, signal);
          },
        },
      },
    });
    jobs.recover();
    const submitted = jobs.submit(
      {
        privacy: 'public',
        requestId: 'native-quota-request',
        taskId: 'native-quota-task',
        runnerId: 'codex',
        prompt: 'Public native task',
        cwd: sb.home,
        access: 'edit',
        model: choice.model,
        effort: 'high',
        allowUnknownQuota: true,
      },
      scope,
    ).job;
    await jobs.runQueued();
    assert.equal(jobs.get(scope, submitted.id).state, 'held');
    assert.equal(jobs.get(scope, submitted.id).reason, 'quota');
    assert.equal(
      serverRecords(sb).some((row) => row.argv?.[0] === 'exec'),
      false,
    );
    at++;
    payload.rateLimits.primary.usedPercent = 0;
    payload.rateLimitsByLimitId.codex.primary.usedPercent = 0;
    assert.equal((await jobs.quota.refresh(choice, new AbortController().signal)).state, 'blocked');
    assert.equal((await jobs.release(scope, submitted.id)).state, 'held');
    assert.equal(
      serverRecords(sb).some((row) => row.argv?.[0] === 'exec'),
      false,
    );
    at++;
    payload.rateLimits.secondary.usedPercent = 0;
    payload.rateLimitsByLimitId.codex.secondary.usedPercent = 0;
    payload.rateLimitsByLimitId.model_sol.primary.usedPercent = 5;
    assert.equal(
      (await jobs.quota.refresh(choice, new AbortController().signal)).state,
      'available',
    );
    assert.equal((await jobs.release(scope, submitted.id)).state, 'queued');
    await jobs.runQueued();
    assert.equal(jobs.get(scope, submitted.id).state, 'succeeded');
    assert.equal(jobs.result(scope, submitted.id), 'Verified native result — exact');
    await jobs.runQueued();
    assert.equal(serverRecords(sb).filter((row) => row.argv?.[0] === 'exec').length, 1);
    assert.equal(JSON.stringify(jobs.quota.status()).includes('native-account-public'), false);
    assert.equal(JSON.stringify(jobs.quota.status()).includes('CANARY'), false);
  } finally {
    await jobs?.close();
    sb.cleanup();
  }
});
