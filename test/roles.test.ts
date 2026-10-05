import "./bootstrap.ts";
import test from 'node:test';
import assert from 'node:assert/strict';
import { sandbox, fresh, bosun } from './helpers.ts';
import { load, role } from '../lib/config.ts';
import * as roles from '../lib/roles.ts';

const NAMES = ['architect', 'debugger', 'reviewer', 'scout', 'tester', 'worker'];

test('roles: every role parses and renders for Claude and Codex with its configured model', () => {
  const sb = sandbox();
  try {
    fresh(sb);
    const cfg = load();
    const all = roles.allRoles();
    assert.deepEqual(all.map((r) => r.name), NAMES);
    for (const r of all) {
      const c = roles.renderClaude(r, cfg);
      const cm = role(cfg, r.name, 'claude');
      assert.ok(c.startsWith(`---\n# ${roles.MARK}`), `${r.name}: marker first`);
      assert.match(c, new RegExp(`^name: bosun-${r.name}$`, 'm'));
      assert.match(c, new RegExp(`^model: ${cm.model}$`, 'm'));
      assert.equal(/^effort: /m.test(c), !!cm.effort, `${r.name}: effort only when configured`);
      assert.match(c, /^description: ".+"$/m);
      assert.ok(c.includes(`\n---\n${r.body}\n`), `${r.name}: body after frontmatter`);

      const x = roles.renderCodex(r, cfg);
      const xm = role(cfg, r.name, 'codex');
      assert.match(x, new RegExp(`^name = "bosun_${r.name}"$`, 'm'));
      assert.match(x, new RegExp(`^model = "${xm.model}"$`, 'm'));
      assert.match(x, new RegExp(`^model_reasoning_effort = "${xm.effort}"$`, 'm'));
      assert.match(x, /^developer_instructions = '''\n[\s\S]+\n'''\n$/m);
    }
    const by = Object.fromEntries(all.map((r) => [r.name, r]));
    for (const n of ['architect', 'scout', 'reviewer']) assert.match(roles.renderCodex(by[n], cfg), /sandbox_mode = "read-only"/);
    for (const n of ['worker', 'tester', 'debugger']) assert.match(roles.renderCodex(by[n], cfg), /sandbox_mode = "workspace-write"/);
    assert.match(roles.renderClaude(by.debugger, cfg), /^tools: Read, Glob, Grep, Bash$/m, 'debugger cannot Edit');
    assert.match(roles.renderClaude(by.worker, cfg), /^tools: Read, Edit, Write, Glob, Grep, Bash$/m);
    assert.throws(() => roles.renderCodex({ ...by.scout, body: "has ''' inside" }, cfg), /must not contain/);
    assert.match(roles.reviewerBody(), /P0 \(must fix\)/);
  } finally { sb.cleanup(); }
});

test('roles: bosun roles --json prints the resolved table', async () => {
  const sb = sandbox();
  try {
    const r = await bosun(['roles', '--json'], { env: sb.env({ ROLE_SCOUT_CLAUDE: 'sonnet:low' }) });
    assert.equal(r.code, 0, r.err);
    const rows = JSON.parse(r.out);
    assert.deepEqual(rows.map((x: any) => x.role), NAMES);
    assert.deepEqual(rows.find((x: any) => x.role === 'architect').codex, { model: 'gpt-6-astra', effort: 'high' });
    assert.deepEqual(rows.find((x: any) => x.role === 'scout').claude, { model: 'sonnet', effort: 'low' }, 'env overrides config');
  } finally { sb.cleanup(); }
});
