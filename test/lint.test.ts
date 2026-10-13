import "./bootstrap.ts";
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './helpers.ts';
import { roleDefinitions } from '../src/platform/assets.ts';
import { main } from '../src/app/cli.ts';

const ROLES = roleDefinitions().map((r) => r.id);
const SKILLS_DIR = path.join(REPO, 'skills');
const SKILLS = fs.readdirSync(SKILLS_DIR).filter((n) => n.startsWith('bosun-')).sort();
const read = (p: string) => fs.readFileSync(p, 'utf8');

test('lint: thirteen skills, frontmatter name matches the folder, descriptions long enough to trigger', () => {
  assert.deepEqual(SKILLS, ['bosun-build', 'bosun-chatgpt', 'bosun-codex', 'bosun-debug', 'bosun-design', 'bosun-handoff',
    'bosun-openai-models', 'bosun-parallel', 'bosun-plan', 'bosun-review', 'bosun-ship', 'bosun-spin', 'bosun-tdd']);
  for (const s of SKILLS) {
    const m = read(path.join(SKILLS_DIR, s, 'SKILL.md')).match(/^---\nname: (.+)\ndescription: (.+)\n---\n/);
    assert.ok(m, `${s}: frontmatter`);
    assert.equal(m[1], s);
    assert.ok(m[2].length > 80, `${s}: description too short to trigger reliably`);
  }
});

test('lint: skills, policy and roles only reference final roles, skills and commands that exist', async () => {
  let help = '';
  assert.equal(await main(['--help'], { stdout: value => help += value, stderr() {} }), 0);
  const commands = new Set([...help.slice(help.indexOf('Commands:')).matchAll(/^  ([a-z][a-z-]*)\b/gm)].map(match => match[1]));
  assert.ok(commands.has('handoff') && commands.has('consolidation') && commands.has('profile'), 'inspect the real final Commander root');
  const files = [...SKILLS.map((s) => path.join(SKILLS_DIR, s, 'SKILL.md')), path.join(REPO, 'policy.md'),
    ...fs.readdirSync(path.join(REPO, 'roles')).map((f) => path.join(REPO, 'roles', f))];
  const skillNames = SKILLS.map((s) => s.slice('bosun-'.length));
  const missing: string[] = [];
  for (const f of files) {
    const t = read(f);
    const where = path.relative(REPO, f);
    // Preserve checks of plain prose references, excluding the one ordinary adjective in research skills.
    for (const [, n] of t.matchAll(/\bbosun-([a-z]+(?:-[a-z]+)*)\b/g)) {
      if (n === 'specific') continue;
      assert.ok(ROLES.includes(n) || skillNames.includes(n), `${where}: bosun-${n}`);
    }
    for (const [, n] of t.matchAll(/\bbosun_([a-z]+)\b/g)) assert.ok(ROLES.includes(n), `${where}: bosun_${n}`);
    for (const [, n] of t.matchAll(/`bosun ([a-z_]+)/g)) if (!commands.has(n)) missing.push(`${where}: bosun ${n}`);
    for (const [, n] of t.matchAll(/\*\*([a-z]+)\*\* role/g)) assert.ok(ROLES.includes(n), `${where}: ${n} role`);
  }
  assert.deepEqual([...new Set(missing)].sort(), [], 'unfinished command references must be updated after their final workflows exist');
});

test('lint: no skill passes spec text to a shell inside double quotes (backticks and $ would run)', () => {
  for (const s of SKILLS) {
    const t = read(path.join(SKILLS_DIR, s, 'SKILL.md'));
    assert.doesNotMatch(t, /--spec "(?!\$\(cat )/, `${s}: use --spec "$(cat <file>)"`);
  }
});

test('lint: the verify rule covers new files too (git status --short, not only git diff)', () => {
  for (const f of [path.join(REPO, 'policy.md'), path.join(SKILLS_DIR, 'bosun-build', 'SKILL.md')]) assert.match(read(f), /git status --short/, f);
});
