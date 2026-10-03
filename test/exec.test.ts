import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sandbox, fresh, bosun, mock } from './helpers.ts';
import { load } from '../lib/config.ts';
import * as exec from '../lib/exec.ts';

const val = (args: string[], flag: string) => args[args.indexOf(flag) + 1];
const git = (cwd: string, ...a: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' });

test('buildRun: the four executor paths', () => {
  const sb = sandbox();
  try {
    fresh(sb);
    const cfg = load();

    const lc = exec.buildRun('local', 'rename a to b', cfg);
    assert.equal(lc.cmd, 'claude');
    assert.ok(lc.args.includes('--bare'));
    assert.equal(val(lc.args, '--model'), cfg.LOCAL_MODEL);
    assert.equal(val(lc.args, '--permission-mode'), 'dontAsk');
    assert.ok(lc.args.includes('Bash(git commit*)') && lc.args.includes('Bash(grep *)'));
    assert.ok(lc.args.includes('Bash(git mv *)') && lc.args.includes('Bash(mkdir -p *)'), 'the local lane can move files');
    assert.ok(val(lc.args, '-p').includes('TASK:\nrename a to b'));
    assert.deepEqual([lc.set.ANTHROPIC_BASE_URL, lc.set.ANTHROPIC_API_KEY, lc.set.BOSUN_DEPTH], [cfg.OLLAMA_URL, 'ollama', '1']);
    assert.ok(lc.unset.includes('ANTHROPIC_AUTH_TOKEN'));

    const lx = exec.buildRun('local', 't', { ...cfg, LOCAL_HARNESS: 'codex' });
    assert.equal(lx.cmd, 'codex');
    assert.deepEqual(lx.args.slice(0, 4), ['exec', '--oss', '--local-provider', 'ollama']);
    assert.equal(val(lx.args, '-s'), 'workspace-write');
    assert.ok(lx.args.includes('sandbox_workspace_write.network_access=false') && lx.args.includes('--ignore-user-config'));
    assert.equal(lx.set.CODEX_OSS_BASE_URL, `${cfg.OLLAMA_URL}/v1`);

    const xc = exec.buildRun('codex', 't', cfg);
    assert.equal(val(xc.args, '-m'), 'gpt-6-luna');
    assert.ok(xc.args.includes('model_reasoning_effort="high"') && !xc.args.includes('--oss'));

    const xa = exec.buildRun('claude', 't', cfg);
    assert.equal(val(xa.args, '--model'), 'sonnet');
    assert.ok(xa.args.includes('--restricted') && xa.args.includes('--strict-mcp-config'), 'no user/project settings, plugins or MCP');
    assert.ok(!xa.args.includes('--setting-sources'));
    assert.ok(!xa.args.includes('--bare') && xa.unset.includes('ANTHROPIC_API_KEY'));
    assert.throws(() => exec.buildRun('gpt', 't', cfg), /-e must be/);
  } finally { sb.cleanup(); }
});

test('buildReview + hostNow: other vendor, read-only', () => {
  const sb = sandbox();
  try {
    fresh(sb);
    const cfg = load();
    assert.equal(exec.hostNow({ CLAUDECODE: '1' }), 'claude');
    assert.equal(exec.hostNow({ CODEX_THREAD_ID: 't1' }), 'codex');
    assert.equal(exec.hostNow({}), null);
    const c = exec.buildReview('codex', cfg);
    assert.deepEqual([c.cmd, val(c.args, '-m'), val(c.args, '-s'), c.args.at(-1)], ['codex', 'gpt-6-sol', 'read-only', '-']);
    const a = exec.buildReview('claude', cfg);
    assert.deepEqual([a.cmd, val(a.args, '--model'), val(a.args, '--effort'), val(a.args, '--tools')], ['claude', 'opus', 'high', 'Read,Glob,Grep']);
    assert.ok(a.args.includes('--restricted') && !a.args.includes('--setting-sources'), 'project settings cannot widen the reviewer');
    assert.ok(!a.args.some((x) => /Edit|Write|Bash/.test(x)), 'no write or shell tools');
    assert.equal(val(exec.buildReview('claude', cfg, 'sonnet').args, '--model'), 'sonnet');
  } finally { sb.cleanup(); }
});

test('run (inline): exact call, token stripped, stdin spec, guards', async () => {
  const sb = sandbox();
  const m = await mock();
  try {
    const repo = path.join(sb.root, 'repo');
    fs.mkdirSync(repo);
    git(repo, 'init', '-q');
    const env = sb.env({ OLLAMA_URL: m.url, ANTHROPIC_AUTH_TOKEN: 'secret' });
    let r = await bosun(['run', 'rename a to b'], { env: { ...env, CLAUDECODE: '1', CLAUDE_EFFORT: 'xhigh', CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/parent.sock' }, cwd: repo });
    assert.equal(r.code, 0, r.err);
    const [c] = sb.calls();
    for (const k of ['CLAUDECODE', 'CLAUDE_EFFORT', 'CLAUDE_CODE_MESSAGING_SOCKET']) assert.equal(c.env[k], undefined, `parent session var ${k} is not inherited`);
    assert.equal(c.env.CLAUDE_CODE_SUBAGENT_MODEL, 'qwen3.6:35b-a3b-coding-nvfp4', 'our own CLAUDE_CODE_* vars survive');
    assert.equal(val(c.argv, '--output-format'), 'text', 'inline runs print the final text');
    assert.equal(c.bin, 'claude');
    assert.equal(c.env.ANTHROPIC_API_KEY, 'ollama');
    assert.equal(c.env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(c.env.BOSUN_DEPTH, '1');
    assert.equal(c.stdin, '', 'stdin closed');
    assert.equal(fs.realpathSync(c.cwd), fs.realpathSync(repo));
    sb.reset();
    r = await bosun(['run', '-f', '-'], { env, cwd: repo, input: 'rename x\nverify: yarn tsc --noEmit\n' });
    assert.ok(sb.calls()[0].argv.some((a) => a.includes('verify: yarn tsc --noEmit')));
    assert.match((await bosun(['run', 'x'], { env: { ...env, BOSUN_DEPTH: '1' }, cwd: repo })).err, /nested/);
    const down = (await bosun(['run', 'x'], { env: { ...env, OLLAMA_URL: 'http://127.0.0.1:1' }, cwd: repo })).err;
    assert.match(down, /Ollama down/);
    assert.match(down, /unreachable at http:\/\/127\.0\.0\.1:1/, 'says where it looked (a remote OLLAMA_URL too)');
    assert.equal((await bosun(['run'], { env, cwd: repo })).code, 2);
    assert.equal((await bosun(['run', '-e', 'claude', 'x'], { env: { ...env, STUB_EXIT_CLAUDE: '3' }, cwd: repo })).code, 3, 'exit code passes through');
  } finally { await m.close(); sb.cleanup(); }
});

test('run (watch): runs in the Orca split, falls back inline, detects a closed or dead split', async () => {
  const sb = sandbox();
  const m = await mock();
  try {
    const repo = path.join(sb.root, 'repo');
    fs.mkdirSync(repo);
    git(repo, 'init', '-q');
    const base = sb.env({ OLLAMA_URL: m.url, ORCA_PANE_KEY: 'p1', STUB_MAP: JSON.stringify({ 'orca status': { out: { ok: true } } }) });

    let r = await bosun(['run', 'rename a to b'], { env: { ...base, STUB_EXIT_CLAUDE: '4' }, cwd: repo });
    assert.equal(r.code, 4, r.err);
    const split = sb.calls().find((c) => c.bin === 'orca' && c.argv[1] === 'split')!;
    assert.match(val(split.argv, '--command'), /bin\/bosun' _exec \d+-[0-9a-f]{6}$/);
    const watched = sb.calls().find((c) => c.bin === 'claude')!;
    assert.equal(watched.env.BOSUN_DEPTH, '1');
    assert.equal(val(watched.argv, '--output-format'), 'stream-json', 'the split shows progress');
    assert.ok(watched.argv.includes('--verbose'));

    sb.reset();
    const noSplit = { ...base, STUB_MAP: JSON.stringify({ 'orca status': { out: { ok: true } }, 'orca terminal': { code: 1 } }) };
    r = await bosun(['run', 'rename a to b'], { env: noSplit, cwd: repo });
    assert.equal(r.code, 0);
    assert.ok(sb.calls().some((c) => c.bin === 'claude'), 'split failed: ran inline');

    sb.reset();
    r = await bosun(['run', 'rename a to b'], { env: { ...base, STUB_SPLIT: 'noop', BOSUN_SPLIT_START_S: '1' }, cwd: repo });
    assert.equal(r.code, 0);
    assert.match(r.err, /did not start the run/);
    assert.equal(sb.calls().filter((c) => c.bin === 'claude').length, 1, 'exactly one run');

    sb.reset();
    const t0 = Date.now();
    r = await bosun(['run', 'rename a to b'], { env: { ...base, STUB_SPLIT: 'dead' }, cwd: repo });
    assert.equal(r.code, 130);
    assert.match(r.err, /split closed/);
    assert.ok(Date.now() - t0 < 10000, 'returns promptly');

    sb.reset();
    r = await bosun(['run', '--no-watch', 'rename a to b'], { env: base, cwd: repo });
    assert.ok(!sb.calls().some((c) => c.bin === 'orca' && c.argv[1] === 'split'), '--no-watch skips the split');
  } finally { await m.close(); sb.cleanup(); }
});

test('review: other vendor from env, diff + untracked files on stdin, fallback, nothing to review', async () => {
  const sb = sandbox();
  try {
    const repo = path.join(sb.root, 'repo');
    fs.mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.ts'), 'export const x = 1;\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
    assert.match((await bosun(['review'], { env: sb.env({ CLAUDECODE: '1' }), cwd: repo })).out, /nothing to review/);

    fs.writeFileSync(path.join(repo, 'a.ts'), 'export const x = 2;\n');
    fs.writeFileSync(path.join(repo, 'new-file.ts'), 'export const y = 3;\n');
    let r = await bosun(['review'], { env: sb.env({ CLAUDECODE: '1' }), cwd: repo });
    assert.equal(r.code, 0, r.err);
    let c = sb.calls().find((x) => x.bin === 'codex')!;
    assert.ok(c, 'from Claude, codex reviews');
    assert.equal(val(c.argv, '-s'), 'read-only');
    assert.match(c.stdin, /P0 \(must fix\)/);
    assert.match(c.stdin, /\+export const x = 2;/);
    assert.match(c.stdin, /New untracked files \(read them too\): new-file\.ts/);
    sb.reset();
    fs.mkdirSync(path.join(repo, 'pkg'));
    await bosun(['review'], { env: sb.env({ CLAUDECODE: '1' }), cwd: path.join(repo, 'pkg') });
    assert.match(sb.calls().find((x) => x.bin === 'codex')!.stdin, /new-file\.ts/, 'untracked files outside the current directory are included');

    sb.reset();
    await bosun(['review'], { env: sb.env({ CODEX_THREAD_ID: 't1' }), cwd: repo });
    c = sb.calls().find((x) => x.bin === 'claude')!;
    assert.equal(val(c.argv, '--model'), 'opus');
    assert.equal(c.env.BOSUN_DEPTH, '1');

    const only = sandbox({ stubs: ['claude'] });
    try {
      r = await bosun(['review'], { env: only.env({ CLAUDECODE: '1' }), cwd: repo });
      assert.match(r.err, /same-vendor review/);
      assert.equal(val(only.calls()[0].argv, '--model'), 'sonnet');
    } finally { only.cleanup(); }
    assert.equal((await bosun(['review', '--bogus'], { env: sb.env(), cwd: repo })).code, 2);
  } finally { sb.cleanup(); }
});

test('run (watch, hardening): split target, no double run, atomic exit code, timeout stops the executor, tricky text, pruning', async () => {
  const sb = sandbox();
  const m = await mock();
  try {
    const repo = path.join(sb.root, 'repo');
    fs.mkdirSync(repo);
    git(repo, 'init', '-q');
    const base = sb.env({ OLLAMA_URL: m.url, ORCA_PANE_KEY: 'p1', ORCA_TERMINAL_HANDLE: 'term_me', STUB_MAP: JSON.stringify({ 'orca status': { out: { ok: true } } }) });
    const runs = path.join(sb.home, '.bosun', 'runs');
    fs.mkdirSync(runs, { recursive: true });
    const old = path.join(runs, 'old-run.log');
    fs.writeFileSync(old, 'x');
    const eightDays = Date.now() / 1000 - 8 * 86400;
    fs.utimesSync(old, eightDays, eightDays);

    const tricky = 'rename a to b; keep "$HOME" and `backticks` literal';
    let r = await bosun(['run', tricky], { env: base, cwd: repo });
    assert.equal(r.code, 0, r.err);
    const split = sb.calls().find((c) => c.bin === 'orca' && c.argv[1] === 'split')!;
    assert.equal(val(split.argv, '--terminal'), 'term_me', 'split next to the calling terminal');
    assert.ok(sb.calls().find((c) => c.bin === 'claude')!.argv.some((a) => a.includes(tricky)), 'task text reaches the executor literally');
    assert.ok(!fs.existsSync(old), 'runs older than 7 days are pruned');

    sb.reset();
    const failed = { ...base, STUB_SPLIT: 'force', STUB_MAP: JSON.stringify({ 'orca status': { out: { ok: true } }, 'orca terminal': { code: 1 } }) };
    r = await bosun(['run', 'rename a to b'], { env: failed, cwd: repo });
    await new Promise((res) => setTimeout(res, 1500));   // give a late pane time to (not) run it
    assert.equal(sb.calls().filter((c) => c.bin === 'claude').length, 1, 'a pane that opened despite a failure report does not run it again');

    sb.reset();
    r = await bosun(['run', 'rename a to b'], { env: { ...base, STUB_SPLIT: 'emptyrc' }, cwd: repo });
    assert.equal(r.code, 7, 'an empty exit-code file means "not written yet", never success');

    sb.reset();
    const t0 = Date.now();
    r = await bosun(['run', 'rename a to b'], { env: { ...base, RUN_TIMEOUT_MIN: '0.05', STUB_SLEEP_CLAUDE: '30' }, cwd: repo });
    assert.equal(r.code, 124);
    assert.match(r.err, /stopped it/);
    assert.ok(Date.now() - t0 < 15000);
    const pid = sb.calls().find((c) => c.bin === 'claude')!.pid;
    let alive = true;
    for (let i = 0; i < 30 && alive; i++) { try { process.kill(pid, 0); await new Promise((res) => setTimeout(res, 100)); } catch { alive = false; } }
    assert.ok(!alive, 'the timed-out executor was stopped');

    sb.reset();
    r = await bosun(['run', 'rename a to b'], { env: { ...base, STUB_SPLIT: 'dead' }, cwd: repo });
    assert.equal(r.code, 130);
    assert.match(r.err, /partial log: .+\.log/);
  } finally { await m.close(); sb.cleanup(); }
});
