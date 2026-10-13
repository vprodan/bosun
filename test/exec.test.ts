import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SqliteDatabase } from '../src/platform/sqlite.ts';
import { bosun } from './helpers.ts';
import { runtimeFixture } from './runtime-fixture.ts';
import { createClaudeRunner, CLAUDE_VERSION } from '../src/adapters/hosts/claude/runner.ts';
import { createCodexRunner, CODEX_VERSION } from '../src/adapters/hosts/codex/runner.ts';
import type { AgentRunner, RunSpec } from '../src/core/ports/runner.ts';
import { watchedRuntime, WATCH_TASK, watchCaps } from './orca-fixture.ts';
import { gitEnvelope } from './git-fixture.ts';

const val = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
type Fixture = Awaited<ReturnType<typeof runtimeFixture>>;
async function terminal(f: Fixture, id: string) {
  let job = await f.rpc('job.get', { id });
  const deadline = performance.now() + 5000;
  while (['queued', 'running'].includes(job.state)) {
    assert.ok(performance.now() < deadline, 'original job must settle');
    await new Promise((resolve) => setTimeout(resolve, 10));
    job = await f.rpc('job.get', { id });
  }
  return job;
}
function nativeOutput(f: Fixture, model = 'claude-sonnet-5') {
  const session = '00000000-0000-4000-8000-000000000002';
  const rows = [
    {
      type: 'system',
      subtype: 'init',
      session_id: session,
      cwd: f.workspace,
      model,
      permissionMode: 'dontAsk',
      tools: ['Read', 'Glob', 'Grep', 'EndConversation'],
      mcp_servers: [],
    },
    {
      type: 'assistant',
      session_id: session,
      message: { model, content: [{ type: 'text', text: 'Owner verifies this result.' }] },
    },
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: session,
      result: 'Owner verifies this result.',
      usage: { input_tokens: 7, output_tokens: 3 },
      modelUsage: { [model]: { inputTokens: 7, outputTokens: 3 } },
    },
  ];
  f.env.STUB_MAP = JSON.stringify({
    'claude --version': { out: CLAUDE_VERSION + ' (Claude Code)\n' },
    'claude -p': { out: rows.map((row) => JSON.stringify(row)).join('\n') + '\n' },
    'codex --version': { out: 'codex-cli ' + CODEX_VERSION + '\n' },
  });
}
async function nativeFixture() {
  let f: Fixture;
  f = await runtimeFixture(
    '[hosts]\nprimary="claude"\n[roles.worker.claude]\nmodel="claude-sonnet-5"\neffort="high"\n[roles.cross-reviewer.claude]\nmodel="claude-opus-5"\neffort="high"\n[roles.cross-reviewer.codex]\nmodel="gpt-6.1-sol:owner"\neffort="ultra"\n',
    {
      env: {
        CLAUDECODE: '1',
        CLAUDE_EFFORT: 'xhigh',
        CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/parent.sock',
        CLAUDE_CODE_SUBAGENT_MODEL: 'owner-subagent',
        ANTHROPIC_AUTH_TOKEN: 'native-auth-fixture',
      },
      runners: {
        claude: () => createClaudeRunner({ env: f.env }),
        codex: () => createCodexRunner({ env: f.env }),
      },
    },
  );
  nativeOutput(f);
  return f;
}
const nativeExecutions = (f: Fixture) =>
  f.sb.calls().filter((call) => call.bin === 'claude' && call.argv[0] === '-p');
function storedInput(f: Fixture, id: string) {
  const db = new SqliteDatabase(f.paths.state, { readOnly: true });
  try {
    return JSON.parse(String(db.prepare('SELECT payload FROM jobs WHERE id=?').get(id)!.payload));
  } finally {
    db.close();
  }
}

test('final run preserves configured primary and explicit native host/model/effort and literal task', async () => {
  const calls: Array<{ host: string; spec: RunSpec }> = [];
  const runners: Record<string, () => AgentRunner> = {};
  for (const host of ['opencode', 'codex', 'claude'])
    runners[host] = () => ({
      id: host,
      caps: watchCaps,
      detect: async () => ({ installed: true }),
      async *run(spec) {
        calls.push({ host, spec });
        yield { t: 'done', code: 0, result: 'Selected ' + host };
      },
    });
  const f = await runtimeFixture(
    '[hosts]\nprimary="opencode"\n[roles.worker.opencode]\nmodel="owner/opencode:model"\neffort="high"\n[roles.worker.codex]\nmodel="gpt-6.1-sol:owner"\neffort="ultra"\n[roles.worker.claude]\nmodel="claude-sonnet-5"\neffort="high"\n',
    { runners },
  );
  try {
    const tick = String.fromCharCode(96),
      task = 'Keep "$HOME", ' + tick + 'literal' + tick + ' and $(text) unchanged — public.';
    const cases = [
      { args: [], host: 'opencode', model: 'owner/opencode:model', effort: 'high' },
      { args: ['--host', 'codex'], host: 'codex', model: 'gpt-6.1-sol:owner', effort: 'ultra' },
      { args: ['--host', 'claude'], host: 'claude', model: 'claude-sonnet-5', effort: 'high' },
      {
        args: ['--host', 'codex', '--model', 'owner:exact:tag', '--effort', 'max'],
        host: 'codex',
        model: 'owner:exact:tag',
        effort: 'max',
      },
    ];
    for (const [n, expected] of cases.entries()) {
      const response = await f.cli([
        'run',
        task,
        '--request-id',
        'selection_' + n,
        ...expected.args,
      ]);
      assert.equal(response.code, 0, response.err);
      const queued = JSON.parse(response.out);
      assert.equal((await terminal(f, queued.job.id)).state, 'succeeded');
      const call = calls[n];
      assert.equal(call.host, expected.host);
      assert.equal(call.spec.model, expected.model);
      assert.equal(call.spec.effort, expected.effort);
      assert.equal(call.spec.prompt, task);
      assert.equal(call.spec.cwd, f.workspace);
      assert.equal(call.spec.access, 'edit');
    }
    assert.equal(calls.length, 4);
    const invalid = await f.cli(['run', task, '--host', 'local']);
    assert.equal(invalid.code, 2);
    assert.equal(JSON.parse(invalid.err).error.code, 'invalid');
    assert.equal((await f.rpc('job.list', {})).jobs.length, 4);
  } finally {
    await f.close();
  }
});

test('final read-only run uses restricted native Claude tools and holds unqualified Codex without changing host or model', async () => {
  const f = await nativeFixture();
  try {
    const response = await f.cli([
      'run',
      'Read this public checkout.',
      '--read-only',
      '--request-id',
      'read_claude',
    ]);
    assert.equal(response.code, 0, response.err);
    const queued = JSON.parse(response.out);
    assert.equal((await terminal(f, queued.job.id)).state, 'succeeded');
    const [call] = nativeExecutions(f);
    assert.equal(val(call.argv, '--tools'), 'Read,Glob,Grep');
    assert.equal(val(call.argv, '--allowedTools'), 'Read,Glob,Grep');
    assert.equal(val(call.argv, '--disallowedTools'), 'mcp__*');
    assert.ok(call.argv.includes('--restricted') && call.argv.includes('--strict-mcp-config'));
    assert.ok(!call.argv.some((arg) => /^(Edit|Write|Bash)(,|$)/.test(arg)));
    const held = await f.cli([
      'run',
      'Read this public checkout.',
      '--host',
      'codex',
      '--read-only',
      '--model',
      'owner:exact:tag',
      '--effort',
      'ultra',
      '--request-id',
      'read_codex',
    ]);
    assert.equal(held.code, 0, held.err);
    const job = await terminal(f, JSON.parse(held.out).job.id);
    assert.equal(job.state, 'held');
    assert.equal(job.runnerId, 'codex');
    assert.equal(job.reason, 'unsupported');
    assert.equal(storedInput(f, job.id).model, 'owner:exact:tag');
    assert.equal(storedInput(f, job.id).effort, 'ultra');
    assert.equal(nativeExecutions(f).length, 1);
    assert.ok(!f.sb.calls().some((call) => call.bin === 'codex' && call.argv[0] === 'exec'));
  } finally {
    await f.close();
  }
});

test('final queued native run retains auth and cwd, clears parent controls and preserves unknown native exits without replay', async () => {
  const f = await nativeFixture();
  try {
    const file = path.join(f.workspace, 'public-task.txt'),
      task = 'rename x\nverify: yarn tsc --noEmit\n';
    fs.writeFileSync(file, task);
    const response = await bosun(['run', '-f', '-', '--request-id', 'native_original'], {
      env: f.env,
      cwd: f.workspace,
      input: task,
    });
    assert.equal(response.code, 0, response.err);
    const queued = JSON.parse(response.out);
    assert.equal((await terminal(f, queued.job.id)).state, 'succeeded');
    const [call] = nativeExecutions(f);
    assert.equal(call.stdin, task);
    assert.equal(call.cwd, f.workspace);
    assert.equal(val(call.argv, '--model'), 'claude-sonnet-5');
    assert.equal(val(call.argv, '--effort'), 'high');
    assert.equal(val(call.argv, '--output-format'), 'stream-json');
    assert.equal(call.env.ANTHROPIC_AUTH_TOKEN, 'native-auth-fixture');
    assert.equal(call.env.ANTHROPIC_API_KEY, undefined);
    for (const key of ['CLAUDECODE', 'CLAUDE_EFFORT', 'CLAUDE_CODE_MESSAGING_SOCKET'])
      assert.equal(call.env[key], undefined);
    assert.equal(call.env.CLAUDE_CODE_SUBAGENT_MODEL, 'owner-subagent');
    assert.equal(call.env.BOSUN_DEPTH, '1');
    assert.equal(call.env.BOSUN_CALLER, 'model');
    const repeat = await f.cli(['run', '-f', file, '--request-id', 'native_original']);
    assert.equal(repeat.code, 0, repeat.err);
    assert.equal(JSON.parse(repeat.out).job.id, queued.job.id);
    const nested = await bosun(['run', '-f', 'missing-task'], {
      env: { ...f.env, BOSUN_DEPTH: '1' },
      cwd: f.workspace,
    });
    assert.equal(JSON.parse(nested.err).error.code, 'unsupported');
    const before = (await f.rpc('job.list', {})).jobs.length;
    assert.equal((await f.cli(['run'])).code, 2);
    assert.equal((await f.rpc('job.list', {})).jobs.length, before);
    const replies = JSON.parse(f.env.STUB_MAP);
    replies['claude -p'].code = 3;
    f.env.STUB_MAP = JSON.stringify(replies);
    const failed = await f.cli([
      'run',
      'Public bounded failure.',
      '--request-id',
      'native_unknown',
    ]);
    assert.equal(failed.code, 0, failed.err);
    const unknown = await terminal(f, JSON.parse(failed.out).job.id);
    assert.equal(unknown.state, 'unknown');
    const duplicate = JSON.parse(
      (await f.cli(['run', 'Public bounded failure.', '--request-id', 'native_unknown'])).out,
    );
    assert.equal(duplicate.job.id, unknown.id);
    assert.equal(duplicate.job.state, 'unknown');
    await assert.rejects(() => f.rpc('job.release', { id: unknown.id }));
    assert.equal(nativeExecutions(f).length, 2);
  } finally {
    await f.close();
  }
});

test('final revision-bound review captures the whole checkout from a subdirectory, selects the read-only vendor and holds unsafe selections', async () => {
  const f = await nativeFixture();
  try {
    await gitEnvelope(f.sb, async () => {
      nativeOutput(f, 'claude-opus-5');
      const unchanged = await f.cli([
        'review',
        '--public',
        '--source-host',
        'codex',
        '--request-id',
        'unchanged',
      ]);
      assert.equal(unchanged.code, 0, unchanged.err);
      assert.equal(JSON.parse(unchanged.out).state, 'unchanged');
      assert.equal(nativeExecutions(f).length, 0);
      fs.writeFileSync(path.join(f.workspace, 'a.ts'), 'export const x = 1;\n');
      git(f.workspace, 'add', 'a.ts');
      git(f.workspace, 'commit', '-qm', 'public base');
      fs.writeFileSync(path.join(f.workspace, 'a.ts'), 'export const x = 2;\n');
      fs.writeFileSync(path.join(f.workspace, 'new-file.ts'), 'export const y = 3;\n');
      const cwd = path.join(f.workspace, 'pkg');
      fs.mkdirSync(cwd);
      const before = git(f.workspace, 'status', '--porcelain=v1', '-z');
      const args = [
        'review',
        '--public',
        '--source-host',
        'codex',
        '--request-id',
        'review_original',
      ];
      const response = await bosun(args, { env: f.env, cwd });
      assert.equal(response.code, 0, response.err);
      const queued = JSON.parse(response.out),
        job = await terminal(f, queued.job.id);
      assert.equal(job.state, 'succeeded');
      assert.equal(job.runnerId, 'claude');
      assert.equal(queued.record.model, 'claude-opus-5');
      assert.equal(queued.record.sourceHost, 'codex');
      const [call] = nativeExecutions(f);
      assert.equal(call.cwd, f.workspace);
      assert.equal(val(call.argv, '--tools'), 'Read,Glob,Grep');
      assert.equal(val(call.argv, '--model'), 'claude-opus-5');
      assert.equal(val(call.argv, '--effort'), 'high');
      assert.match(call.stdin, /Revision: [a-f0-9]{64}/);
      assert.match(call.stdin, /export const x = 2/);
      assert.match(call.stdin, /new-file\.ts/);
      assert.match(call.stdin, /export const y = 3/);
      assert.equal(git(f.workspace, 'status', '--porcelain=v1', '-z'), before);
      const repeated = await bosun(args, { env: f.env, cwd });
      assert.equal(repeated.code, 0, repeated.err);
      assert.equal(JSON.parse(repeated.out).job.id, job.id);
      const inspected = await f.rpc('review.get', { id: queued.record.id });
      assert.equal(inspected.freshness, 'matches');
      assert.equal(inspected.decision, 'owner-review-required');
      assert.equal(inspected.checks, 'unverified');
      const held = await f.cli([
        'review',
        '--public',
        '--source-host',
        'claude',
        '--request-id',
        'unsafe_review',
      ]);
      assert.equal(held.code, 0, held.err);
      const heldJob = await terminal(f, JSON.parse(held.out).job.id);
      assert.equal(heldJob.state, 'held');
      assert.equal(heldJob.runnerId, 'codex');
      assert.equal(nativeExecutions(f).length, 1);
      assert.ok(!f.sb.calls().some((call) => call.bin === 'codex' && call.argv[0] === 'exec'));
      const count = (await f.rpc('job.list', {})).jobs.length;
      const denied = await f.cli(['review', '--source-host', 'codex']);
      assert.equal(JSON.parse(denied.err).error.code, 'private_input');
      assert.equal((await f.rpc('job.list', {})).jobs.length, count);
      assert.equal((await f.cli(['review', '--bogus'])).code, 2);
    });
  } finally {
    await f.close();
  }
});

test('run (watch): the pane observes the existing durable job, optional failure uses job wait, and closing never reruns', async () => {
  const f = await watchedRuntime();
  try {
    await gitEnvelope(f.sb, async () => {
      let result = await f.cli([
        'run',
        WATCH_TASK,
        '--host',
        'codex',
        '--request-id',
        'watched',
        '--watch',
      ]);
      assert.equal(result.code, 0, result.err);
      const queued = JSON.parse(result.out);
      assert.equal(queued.watch.record.state, 'opened');
      const split = f.native.calls().find((c) => c.args[1] === 'split')!;
      assert.match(val(split.args, '--command'), /job wait '.*' --timeout 300000 --progress$/);
      assert.doesNotMatch(val(split.args, '--command'), /_exec|rename|backticks|job submit/);
      assert.equal((await f.cli(['job', 'wait', queued.job.id, '--result'])).code, 0);
      assert.equal(f.calls(), 1);
      f.native.change({ connected: false });
      const reconciled = JSON.parse((await f.cli(['job', 'watch-reconcile', queued.job.id])).out);
      assert.equal(reconciled.pane, 'closed');
      assert.equal(reconciled.job.state, 'succeeded');
      const repeated = JSON.parse(
        (await f.cli(['run', WATCH_TASK, '--host', 'codex', '--request-id', 'watched', '--watch']))
          .out,
      );
      assert.equal(repeated.job.id, queued.job.id);
      assert.equal(repeated.watch.duplicate, true);
      assert.equal(f.calls(), 1);
      f.native.change({ version: 'unsupported' });
      result = await f.cli([
        'run',
        WATCH_TASK,
        '--host',
        'codex',
        '--request-id',
        'fallback',
        '--watch',
      ]);
      assert.equal(result.code, 0, result.err);
      const fallback = JSON.parse(result.out);
      assert.equal(fallback.watch.state, 'not_started');
      assert.deepEqual(fallback.watch.observation.wait, ['bosun', 'job', 'wait', fallback.job.id]);
      assert.equal((await f.cli(fallback.watch.observation.wait.slice(1))).code, 0);
      assert.equal(f.calls(), 2);
      const before = f.native.calls().length;
      result = await f.cli([
        'run',
        WATCH_TASK,
        '--host',
        'codex',
        '--request-id',
        'no-watch',
        '--no-watch',
      ]);
      assert.equal(result.code, 0, result.err);
      assert.equal(f.native.calls().length, before);
    });
  } finally {
    await f.close();
  }
});

test('run (watch, hardening): selected terminal, literal task, lost split, duplicate late observers and timeout preserve one executor', async () => {
  let complete!: () => void,
    calls = 0;
  const finish = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const f = await watchedRuntime({
    runner: {
      id: 'codex',
      caps: watchCaps,
      detect: async () => ({ installed: true }),
      async *run(spec) {
        calls++;
        assert.equal(spec.prompt, WATCH_TASK);
        assert.equal(spec.model, 'PINNED');
        assert.equal(spec.effort, 'high');
        yield { t: 'tool', name: 'Edit', target: 'tool-output-canary' };
        await finish;
        yield { t: 'done', code: 0, result: 'FINAL RESULT ONLY' };
      },
    },
  });
  try {
    await gitEnvelope(f.sb, async () => {
      f.native.change({ mode: 'lost' });
      const result = await f.cli([
        'run',
        WATCH_TASK,
        '--host',
        'codex',
        '--request-id',
        'original',
        '--watch',
      ]);
      assert.equal(result.code, 0, result.err);
      const queued = JSON.parse(result.out);
      assert.equal(queued.watch.record.state, 'unknown');
      const split = f.native.calls().find((c) => c.args[1] === 'split')!;
      assert.equal(val(split.args, '--terminal'), 'term_source');
      const timeout = await f.cli(['job', 'wait', queued.job.id, '--timeout', '10', '--progress']);
      assert.equal(timeout.code, 124);
      assert.equal(JSON.parse(timeout.err).error.code, 'timeout');
      assert.doesNotMatch(timeout.out, /FINAL RESULT|tool-output-canary|rename/);
      assert.equal((await f.rpc('job.get', { id: queued.job.id })).cancelRequested, false);
      complete();
      const observers = await Promise.all([
        f.cli(['job', 'wait', queued.job.id, '--progress', '--result']),
        f.cli(['job', 'wait', queued.job.id, '--progress']),
      ]);
      assert.ok(observers.every((o) => o.code === 0));
      assert.match(observers[0].out, /FINAL RESULT ONLY/);
      assert.doesNotMatch(observers[1].out, /FINAL RESULT|tool-output-canary|rename/);
      const repeated = JSON.parse(
        (await f.cli(['run', WATCH_TASK, '--host', 'codex', '--request-id', 'original', '--watch']))
          .out,
      );
      assert.equal(repeated.watch.record.state, 'unknown');
      assert.equal(calls, 1);
      assert.equal(f.native.calls().filter((c) => c.args[1] === 'split').length, 1);
      assert.ok(
        !fs.existsSync(path.join(f.paths.home, 'runs')),
        'final observer creates no legacy executable spec/log/exit files',
      );
    });
  } finally {
    complete();
    await f.close();
  }
});
