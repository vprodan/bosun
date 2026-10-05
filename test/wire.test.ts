import "./bootstrap.ts";
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, fresh } from './helpers.ts';
import { load } from '../lib/config.ts';
import * as wire from '../lib/wire.ts';

const write = (home: string, rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true }); fs.writeFileSync(path.join(home, rel), text); };
const read = (home: string, rel: string) => fs.readFileSync(path.join(home, rel), 'utf8');
const ls = (home: string, rel: string) => (fs.existsSync(path.join(home, rel)) ? fs.readdirSync(path.join(home, rel)) : []);
const cmds = (j: any) => j.hooks.UserPromptSubmit.flatMap((e: any) => e.hooks.map((h: any) => h.command));
const FILES = ['.claude/settings.json', '.claude/CLAUDE.md', '.codex/hooks.json', '.codex/AGENTS.md'];

test('wire: claude + codex twice is idempotent, keeps user config, unwire restores it', () => {
  const sb = sandbox();
  try {
    const h = sb.home;
    write(h, '.claude/settings.json', JSON.stringify({
      model: 'opus', permissions: { allow: ['Bash(git *)'] },
      enabledPlugins: { 'superpowers@claude-plugins-official': true, 'ponytail@ponytail': true },
      hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'codegraph prompt-hook' }] }] },
    }, null, 2) + '\n');
    write(h, '.claude/CLAUDE.md', '# my rules\n\nbe nice\n');
    write(h, '.codex/hooks.json', JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } }));
    write(h, '.codex/AGENTS.md', '# codex rules\n');
    const before = Object.fromEntries(FILES.map((f) => [f, read(h, f)]));

    fresh(sb);
    const cfg = load();
    for (let i = 0; i < 2; i++) { wire.wireClaude(cfg); wire.wireCodex(cfg); }
    assert.deepEqual(wire.plugins('disable'), ['superpowers@claude-plugins-official']);

    const s = JSON.parse(read(h, '.claude/settings.json'));
    assert.deepEqual(cmds(s), ['codegraph prompt-hook', `${h}/.local/bin/bosun route --hook --host claude`]);
    assert.deepEqual(s.permissions.allow, ['Bash(git *)', ...wire.PERMS]);
    assert.equal(s.enabledPlugins['superpowers@claude-plugins-official'], false);
    assert.equal(s.enabledPlugins['ponytail@ponytail'], true);
    const cx = JSON.parse(read(h, '.codex/hooks.json'));
    assert.deepEqual(cmds(cx), [`${h}/.local/bin/bosun route --hook --host codex`]);
    assert.ok(cx.hooks.Stop, 'other Codex hooks kept');

    const md = read(h, '.claude/CLAUDE.md');
    assert.ok(md.startsWith('# my rules\n\nbe nice\n\n<!-- bosun:begin -->'));
    assert.equal(md.split('bosun:begin').length, 2, 'one block');
    assert.match(md, /`bosun-architect`/);
    assert.match(md, /bosun run -e codex/);
    assert.match(md, /run_in_background/);
    assert.doesNotMatch(md, /\{\{|undefined/);
    assert.match(md, /\|\n\n\*\*Skills/, 'table closed by a blank line');
    const ag = read(h, '.codex/AGENTS.md');
    assert.match(ag, /`bosun_architect`/);
    assert.match(ag, /bosun run -e claude/);
    assert.match(ag, /30 minutes/);

    for (const r of ['architect', 'debugger', 'reviewer', 'scout', 'tester', 'worker']) {
      assert.match(read(h, `.claude/agents/bosun-${r}.md`), /generated-by: bosun/);
      assert.match(read(h, `.codex/agents/bosun_${r}.toml`), new RegExp(`name = "bosun_${r}"`));
    }
    for (const d of ['.claude/skills', '.agents/skills']) assert.ok(fs.existsSync(path.join(h, d, 'bosun-review', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(h, '.claude/settings.json.bak-bosun')));

    assert.deepEqual(wire.unwire(), ['superpowers@claude-plugins-official']);
    for (const f of ['.claude/settings.json', '.codex/hooks.json']) assert.deepEqual(JSON.parse(read(h, f)), JSON.parse(before[f]), f);
    for (const f of ['.claude/CLAUDE.md', '.codex/AGENTS.md']) assert.equal(read(h, f), before[f], f);
    for (const d of ['.claude/agents', '.codex/agents', '.claude/skills', '.agents/skills']) assert.deepEqual(ls(h, d), [], d);
  } finally { sb.cleanup(); }
});

test('wire: invalid settings.json stops before any write', () => {
  const sb = sandbox();
  try {
    write(sb.home, '.claude/settings.json', '{ not json');
    fresh(sb);
    assert.throws(() => wire.wireClaude(load()), /not valid JSON/);
    assert.equal(read(sb.home, '.claude/settings.json'), '{ not json');
    assert.deepEqual(ls(sb.home, '.claude/agents'), []);
    assert.ok(!fs.existsSync(path.join(sb.home, '.claude/CLAUDE.md')));
  } finally { sb.cleanup(); }
});

test('wire: without the other CLI there is no cross row and review falls back to same-vendor', () => {
  const sb = sandbox({ stubs: ['claude'] });
  try {
    fresh(sb);
    const p = wire.policy('claude');
    assert.doesNotMatch(p, /-e codex/);
    assert.match(p, /same-vendor fallback/);
    assert.match(p, /\|\n\n\*\*Skills/);
  } finally { sb.cleanup(); }
});

const snap = (dir: string) => {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    if (!fs.existsSync(d)) return;
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) out[p] = `-> ${fs.readlinkSync(p)}`;
      else if (st.isDirectory()) walk(p);
      else out[p] = fs.readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
};
const ORCA_HOME = 'Library/Application Support/orca/codex-runtime-home/home';

test('wire: inside Orca, Codex rules + agents also go to Orca\'s codex home; the hook only to ~/.codex; unwire cleans both', () => {
  const sb = sandbox();
  try {
    const orcaHome = path.join(sb.home, ORCA_HOME);
    fs.mkdirSync(orcaHome, { recursive: true });
    const orcaHooks = '{"hooks":{"Stop":[]}}\n';
    fs.writeFileSync(path.join(orcaHome, 'hooks.json'), orcaHooks);
    fresh(sb, { CODEX_HOME: orcaHome, ORCA_CODEX_HOME: orcaHome });
    wire.wireCodex(load());
    assert.match(read(sb.home, '.codex/hooks.json'), /bosun route --hook --host codex/);
    assert.match(read(sb.home, '.codex/AGENTS.md'), /bosun:begin/);
    assert.equal(fs.readFileSync(path.join(orcaHome, 'hooks.json'), 'utf8'), orcaHooks, "Orca's managed hooks.json untouched");
    assert.match(fs.readFileSync(path.join(orcaHome, 'AGENTS.md'), 'utf8'), /bosun:begin/);
    assert.ok(fs.existsSync(path.join(orcaHome, 'agents', 'bosun_worker.toml')));
    fresh(sb);   // later, from a plain terminal: no Orca env
    wire.unwire();
    assert.ok(!fs.existsSync(path.join(orcaHome, 'agents', 'bosun_worker.toml')));
    assert.ok(!fs.existsSync(path.join(orcaHome, 'AGENTS.md')), 'bosun created it, so unwire removes it');
    assert.ok(!fs.existsSync(path.join(sb.home, '.codex/AGENTS.md')));
    assert.equal(fs.readFileSync(path.join(orcaHome, 'hooks.json'), 'utf8'), orcaHooks);
  } finally { sb.cleanup(); }
});

test('wire: a broken hooks.json stops unwire before it changes anything', () => {
  const sb = sandbox();
  try {
    write(sb.home, '.claude/settings.json', JSON.stringify({ enabledPlugins: { 'superpowers@claude-plugins-official': true } }));
    fresh(sb);
    const cfg = load();
    wire.wireClaude(cfg);
    wire.wireCodex(cfg);
    wire.plugins('disable');
    write(sb.home, '.codex/hooks.json', '{ broken');
    const before = snap(sb.home);
    assert.throws(() => wire.unwire(), /hooks\.json is not valid JSON/);
    assert.deepEqual(snap(sb.home), before, 'nothing changed');
  } finally { sb.cleanup(); }
});

test('wire: an unmatched bosun marker stops wiring and unwiring instead of eating user text', () => {
  const sb = sandbox();
  try {
    const mine = '# mine\n<!-- bosun:begin -->\nold\n\nmy own notes\n';
    write(sb.home, '.claude/CLAUDE.md', mine);
    fresh(sb);
    assert.throws(() => wire.wireClaude(load()), /unmatched bosun marker/);
    assert.throws(() => wire.unwire(), /unmatched bosun marker/);
    assert.equal(read(sb.home, '.claude/CLAUDE.md'), mine);
    assert.deepEqual(ls(sb.home, '.claude/agents'), []);
  } finally { sb.cleanup(); }
});

test('wire: the Codex block says bosun commands run outside the sandbox; the Claude block does not; rule lists stay unbroken', () => {
  const sb = sandbox();
  try {
    fresh(sb);
    const codex = wire.policy('codex');
    const claude = wire.policy('claude');
    assert.match(codex, /outside the sandbox/);
    assert.doesNotMatch(claude, /outside the sandbox/);
    for (const p of [codex, claude]) assert.doesNotMatch(p, /\n- [^\n]*\n\n- /, 'no blank line inside the rules list');
  } finally { sb.cleanup(); }
});

test('wire: --replace-plugins is sticky across re-installs until uninstall', () => {
  const sb = sandbox();
  try {
    write(sb.home, '.claude/settings.json', JSON.stringify({ enabledPlugins: { 'superpowers@claude-plugins-official': true } }));
    fresh(sb);
    const cfg = load();
    const on = () => JSON.parse(read(sb.home, '.claude/settings.json')).enabledPlugins['superpowers@claude-plugins-official'];
    wire.rewire(cfg, ['claude'], true);
    assert.equal(on(), false);
    wire.rewire(cfg, ['claude'], false);
    assert.equal(on(), false, 'a plain re-install keeps them off');
    wire.unwire({ forget: true });
    assert.equal(on(), true);
    assert.equal(JSON.parse(read(sb.home, '.bosun/state.json')).replacePlugins, undefined);
  } finally { sb.cleanup(); }
});

test('wire: files bosun created are removed on unwire; files it changed are backed up; a user file it moved aside comes back', () => {
  const sb = sandbox();
  try {
    write(sb.home, '.claude/agents/bosun-scout.md', 'my own scout\n');
    fresh(sb);
    const cfg = load();
    wire.wireClaude(cfg);
    wire.wireCodex(cfg);
    assert.equal(read(sb.home, '.claude/agents/bosun-scout.md.bak-bosun'), 'my own scout\n');
    wire.unwire();
    for (const f of ['.claude/CLAUDE.md', '.claude/settings.json', '.codex/AGENTS.md', '.codex/hooks.json']) assert.ok(!fs.existsSync(path.join(sb.home, f)), `${f} was created by bosun and is removed`);
    assert.equal(read(sb.home, '.claude/agents/bosun-scout.md'), 'my own scout\n', 'user file restored');
    assert.ok(!fs.existsSync(path.join(sb.home, '.claude/agents/bosun-scout.md.bak-bosun')));

    write(sb.home, '.claude/CLAUDE.md', '# mine\n');
    wire.wireClaude(cfg);
    assert.equal(read(sb.home, '.claude/CLAUDE.md.bak-bosun'), '# mine\n', 'CLAUDE.md backed up before the first change');
  } finally { sb.cleanup(); }
});

test('wire: bosun memory is never auto-allowed — the CLI shows private bodies and can purge, so the host must ask first', () => {
  assert.ok(!wire.PERMS.some((p) => p.startsWith('Bash(bosun memory')), wire.PERMS.join(', '));
});
