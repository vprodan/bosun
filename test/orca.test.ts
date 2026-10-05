import "./bootstrap.ts";
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sandbox, bosun } from './helpers.ts';

const ORCA_OK = { 'orca status': { out: { ok: true, result: {} } } };
const WT = { ok: true, result: { worktree: { id: 'repo1::/wt/spin-x' }, startupTerminal: { handle: 'term_1' } } };

test('card: no-op outside Orca, sets status + comment inside, usage without args', async () => {
  const sb = sandbox();
  try {
    assert.equal((await bosun(['card', 'in-review', 'done'], { env: sb.env() })).code, 0);
    assert.equal(sb.calls().filter((c) => c.bin === 'orca').length, 0, 'outside Orca: no orca calls');
    const env = sb.env({ ORCA_PANE_KEY: 'p1', STUB_MAP: JSON.stringify(ORCA_OK) });
    assert.equal((await bosun(['card', 'in-review', 'done', 'here'], { env })).code, 0);
    const set = sb.calls().find((c) => c.argv[0] === 'worktree')!;
    assert.deepEqual(set.argv, ['worktree', 'set', '--worktree', 'active', '--workspace-status', 'in-review', '--comment', 'done here', '--json']);
    assert.equal((await bosun(['card'], { env })).code, 2);
    const failing = sb.env({ ORCA_PANE_KEY: 'p1', STUB_MAP: JSON.stringify({ ...ORCA_OK, 'orca worktree set': { code: 1 } }) });
    assert.equal((await bosun(['card', 'completed'], { env: failing })).code, 0, 'a failed card update never fails the caller');
  } finally { sb.cleanup(); }
});

test('spin: claude agent gets the spec literally plus the footer; outside Orca or nested is refused', async () => {
  const sb = sandbox();
  try {
    assert.match((await bosun(['spin', 'fix it'], { env: sb.env() })).err, /needs Orca/);
    const env = sb.env({ ORCA_PANE_KEY: 'p1', STUB_MAP: JSON.stringify({ ...ORCA_OK, 'orca worktree create': { out: WT } }) });
    assert.equal((await bosun(['spin', 'x'], { env: { ...env, BOSUN_DEPTH: '1' } })).code, 1);
    const tricky = 'Fix the flaky cart test\nuse "$HOME" and `backticks` and it\'s fine';
    const r = await bosun(['spin', '-f', '-'], { env, input: tricky });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /worktree: repo1::\/wt\/spin-x/);
    assert.match(r.out, /terminal: term_1/);
    const create = sb.calls().find((c) => c.argv[1] === 'create')!;
    const a = create.argv;
    assert.equal(a[a.indexOf('--name') + 1], 'spin-fix-the-flaky-cart-test');
    assert.equal(a[a.indexOf('--parent-worktree') + 1], 'active');
    assert.equal(a[a.indexOf('--agent') + 1], 'claude');
    const prompt = a[a.indexOf('--prompt') + 1];
    assert.ok(prompt.startsWith(tricky), 'spec reaches the agent literally');
    assert.match(prompt, /Do not commit or push/);
    assert.ok(!a.includes('--base-branch'), 'default base unless --stacked');
    const plans = fs.readdirSync(path.join(sb.home, '.bosun', 'plans'));
    assert.equal(plans.length, 1);
  } finally { sb.cleanup(); }
});

test('spin: local agent opens a terminal running bosun run; --stacked bases on the current branch', async () => {
  const sb = sandbox();
  try {
    const repo = path.join(sb.root, 'repo');
    fs.mkdirSync(repo);
    spawnSync('git', ['init', '-q', '-b', 'feat/x'], { cwd: repo });
    spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo });
    const map = { ...ORCA_OK, 'orca worktree create': { out: { ok: true, result: { worktree: { id: 'repo1::/wt/spin-y' } } } }, 'orca terminal create': { out: { ok: true, result: { terminal: { handle: 'term_9' } } } } };
    const env = sb.env({ ORCA_PANE_KEY: 'p1', STUB_MAP: JSON.stringify(map) });
    const r = await bosun(['spin', '--agent', 'local', '--stacked', 'rename getCart to fetchCart'], { env, cwd: repo });
    assert.equal(r.code, 0, r.err);
    const [create, term] = sb.calls().filter((c) => c.argv[1] === 'create');
    assert.ok(!create.argv.includes('--agent'), 'local: no agent in the worktree');
    assert.equal(create.argv[create.argv.indexOf('--base-branch') + 1], 'feat/x');
    assert.equal(term.argv[term.argv.indexOf('--worktree') + 1], 'id:repo1::/wt/spin-y');
    assert.match(term.argv[term.argv.indexOf('--command') + 1], /bin\/bosun' run --no-watch -f '.+\.md'$/);
    assert.match(r.out, /terminal: term_9/);
  } finally { sb.cleanup(); }
});

test('execJob: a streamed Claude run shows progress in the pane and hands main only the final result', async () => {
  const sb = sandbox();
  try {
    const runs = path.join(sb.home, '.bosun', 'runs');
    fs.mkdirSync(runs, { recursive: true });
    const events = [
      { type: 'system', subtype: 'init' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Renaming now.' }, { type: 'tool_use', name: 'Edit', input: { file_path: 'src/a.ts' } }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'yarn tsc --noEmit' } }] } },
      { type: 'result', subtype: 'success', result: 'FILES CHANGED: src/a.ts' },
    ].map((e) => JSON.stringify(e)).join('\n') + '\nnot json\n';
    fs.writeFileSync(path.join(runs, 'r1.json'), JSON.stringify({ cmd: 'claude', args: ['-p', 'x'], set: {}, unset: [], cwd: sb.root, stream: 'claude-json' }));
    const r = await bosun(['_exec', 'r1'], { env: sb.env({ STUB_MAP: JSON.stringify({ claude: { out: events } }) }) });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Renaming now\./);
    assert.match(r.out, /→ Edit src\/a\.ts/);
    assert.match(r.out, /→ Bash yarn tsc --noEmit/);
    assert.equal(fs.readFileSync(path.join(runs, 'r1.log'), 'utf8'), 'FILES CHANGED: src/a.ts\n', 'main gets the result, not the event stream');
    assert.equal(fs.readFileSync(path.join(runs, 'r1.rc'), 'utf8'), '0');
  } finally { sb.cleanup(); }
});

test('spin: defaults to the host agent, sanitizes --name, and refuses a result without a worktree id', async () => {
  const sb = sandbox();
  try {
    const env = sb.env({ ORCA_PANE_KEY: 'p1', CODEX_THREAD_ID: 't1', STUB_MAP: JSON.stringify({ ...ORCA_OK, 'orca worktree create': { out: WT } }) });
    const r = await bosun(['spin', '--name', '../Evil name!', 'fix the thing'], { env });
    assert.equal(r.code, 0, r.err);
    const a = sb.calls().find((c) => c.argv[1] === 'create')!.argv;
    assert.equal(a[a.indexOf('--agent') + 1], 'codex', 'inside Codex the default agent is codex');
    assert.equal(a[a.indexOf('--name') + 1], 'evil-name');
    for (const f of fs.readdirSync(path.join(sb.home, '.bosun', 'plans'))) assert.match(f, /^evil-name-\d+\.md$/);
    const noId = sb.env({ ORCA_PANE_KEY: 'p1', STUB_MAP: JSON.stringify({ ...ORCA_OK, 'orca worktree create': { out: { ok: true, result: {} } } }) });
    const bad = await bosun(['spin', 'x y'], { env: noId });
    assert.equal(bad.code, 1);
    assert.match(bad.err, /no worktree id/);
  } finally { sb.cleanup(); }
});

test('card: rejects a malformed status', async () => {
  const sb = sandbox();
  try {
    const r = await bosun(['card', 'BAD STATUS!'], { env: sb.env({ ORCA_PANE_KEY: 'p1', STUB_MAP: JSON.stringify(ORCA_OK) }) });
    assert.equal(r.code, 2);
    assert.equal(sb.calls().filter((c) => c.argv[0] === 'worktree').length, 0);
  } finally { sb.cleanup(); }
});
