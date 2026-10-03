// Host wiring: rendered role agents, linked skills, the policy block, the router hook, permissions, overlapping plugins.
import fs from 'node:fs';
import path from 'node:path';
import { P, saveState, type Cfg } from './config.ts';
import { has, readJson, writeJson, backup, say, ok, warn, die, sh } from './util.ts';
import * as roles from './roles.ts';

// Not `memory`: the CLI shows private bodies and can purge, so a host must ask before running it.
export const PERMS = ['run', 'review', 'spin', 'card', 'roles', 'route'].map((c) => `Bash(bosun ${c} *)`);
export const OVERLAP = ['superpowers@claude-plugins-official', 'mattpocock-skills@mattpocock', 'code-review@claude-plugins-official'];
const CS = () => path.join(P.CLAUDE, 'settings.json');
const CX_HOOKS = () => path.join(P.CODEX, 'hooks.json');
const hookCmd = (host: string) => `${path.join(P.BIN, 'bosun')} route --hook --host ${host}`;
const SKILLS_DIR = path.join(P.REPO, 'skills');
// Codex homes that get rules + agents: ~/.codex, plus Orca's runtime home when it exists (Codex inside Orca reads that one)
export const codexHomes = (): string[] => [P.CODEX, ...(P.ORCA_CODEX !== P.CODEX && fs.existsSync(P.ORCA_CODEX) ? [P.ORCA_CODEX] : [])];
const skillDirs = () => fs.readdirSync(SKILLS_DIR).filter((n) => n.startsWith('bosun-')).map((n) => path.join(SKILLS_DIR, n));

export const mcpCmd = (): string[] => [process.execPath, path.join(P.REPO, 'bin', 'bosun'), 'mcp'];
// (Un)register the bosun MCP server: Claude at user scope, Codex in every Codex home. Remove first, so re-installs stay idempotent.
function mcpClaude(op: 'add' | 'rm'): void {
  if (!has('claude')) return;
  sh('claude', ['mcp', 'remove', '--scope', 'user', 'bosun']);
  if (op !== 'add') return;
  const r = sh('claude', ['mcp', 'add', '--scope', 'user', 'bosun', '--', ...mcpCmd()]);
  if (r.code) warn(`claude mcp add failed: ${r.err}`);
}
function mcpCodex(op: 'add' | 'rm'): void {
  if (!has('codex')) return;
  for (const h of codexHomes()) {
    const env = { ...process.env, CODEX_HOME: h };
    sh('codex', ['mcp', 'remove', 'bosun'], { env });
    if (op !== 'add') continue;
    const r = sh('codex', ['mcp', 'add', 'bosun', '--', ...mcpCmd()], { env });
    if (r.code) warn(`codex mcp add (${h}) failed: ${r.err}`);
  }
}

function parseOrDie(file: string): any {
  try { return readJson(file); } catch { return die(`${file} is not valid JSON: fix it first (nothing was changed)`); }
}

function checkMarkers(file: string): void {
  if (!fs.existsSync(file)) return;
  const t = fs.readFileSync(file, 'utf8');
  if (t.split('<!-- bosun:begin -->').length !== t.split('<!-- bosun:end -->').length) die(`${file} has an unmatched bosun marker: fix it by hand (nothing was changed)`);
}
// Every file wiring or unwiring could touch must be readable before the first write.
export function preflight(): void {
  parseOrDie(CS());
  parseOrDie(CX_HOOKS());
  parseOrDie(P.STATE);
  checkMarkers(path.join(P.CLAUDE, 'CLAUDE.md'));
  for (const h of codexHomes()) checkMarkers(path.join(h, 'AGENTS.md'));
}

// Remember files bosun creates, so unwire can remove them instead of leaving empty husks behind.
function noteCreated(file: string): void {
  const st = parseOrDie(P.STATE) || {};
  st.created = [...new Set([...(st.created || []), file])];
  saveState(st);
}

export function policy(host: string): string {
  const claude = host === 'claude';
  const other = claude ? 'codex' : 'claude';
  const call = (r: string) => (claude ? `Agent tool → \`bosun-${r}\`` : `spawn agent \`bosun_${r}\``);
  const values: Record<string, string> = {
    HOST: claude ? 'Claude Code' : 'Codex',
    ARCHITECT: call('architect'), SCOUT: call('scout'), WORKER: call('worker'), TESTER: call('tester'), DEBUGGER: call('debugger'),
    REVIEWER: has(other) ? `the other vendor (${other}) reviews, read-only` : `same-vendor fallback (${call('reviewer')})`,
    RUN_HOW: claude ? 'Bash with `run_in_background: true`; it can take minutes' : 'give the command a timeout of at least 30 minutes',
    SANDBOX: claude ? '' : '\n- Codex: `bosun` commands reach Ollama and Kev on localhost and write ~/.bosun, so run them outside the sandbox (request escalated permissions; approve once).',
    CROSS: has(other) ? `| cross | a worker-lane task on your other plan (rate limits, second vendor) | \`bosun run -e ${other} -f -\` |\n` : '',
  };
  return fs.readFileSync(path.join(P.REPO, 'policy.md'), 'utf8').replace(/\{\{(\w+)\}\}/g, (_, k: string) => values[k]);
}

// Put the bosun block (text) into a Markdown file, or strip it when text is empty. Idempotent.
export function block(file: string, text = ''): void {
  if (!text && !fs.existsSync(file)) return;
  if (text && !fs.existsSync(file)) noteCreated(file);
  else if (text) backup(file);
  const cur = (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '').replace(/<!-- bosun:begin -->[\s\S]*?<!-- bosun:end -->\n?/g, '').trimEnd();
  const out = [cur, text.trim()].filter(Boolean).join('\n\n');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, out ? `${out}\n` : '');
}

// (Un)register the router hook, and permission rules, in a Claude settings.json or Codex hooks.json. Writes only on change.
export function hookJson(file: string, op: 'add' | 'rm', cmd: string, rules: string[] = []): void {
  const orig = parseOrDie(file);
  if (!orig && op === 'rm') return;
  if (!orig) noteCreated(file);
  const j = orig ? JSON.parse(JSON.stringify(orig)) : {};
  if (op === 'add' || (j.hooks && j.hooks.UserPromptSubmit)) {
    j.hooks = j.hooks || {};
    const ups = (j.hooks.UserPromptSubmit || []).filter((e: any) => !(e.hooks || []).some((x: any) => String(x.command || '').includes('bosun route --hook')));
    if (op === 'add') ups.push({ hooks: [{ type: 'command', command: cmd, timeout: 5 }] });
    j.hooks.UserPromptSubmit = ups;
  }
  if (rules.length && (op === 'add' || (j.permissions && j.permissions.allow))) {
    j.permissions = j.permissions || {};
    j.permissions.allow = (j.permissions.allow || []).filter((r: string) => !rules.includes(r)).concat(op === 'add' ? rules : []);
  }
  for (const [outer, inner] of [['hooks', 'UserPromptSubmit'], ['permissions', 'allow']]) {   // leave no empty husks
    if (j[outer] && Array.isArray(j[outer][inner]) && !j[outer][inner].length) delete j[outer][inner];
    if (j[outer] && !Object.keys(j[outer]).length) delete j[outer];
  }
  if (!orig || JSON.stringify(j) !== JSON.stringify(orig)) writeJson(file, j);
}

export const enabledOverlap = (): string[] => {
  try { const s = readJson(CS()); return OVERLAP.filter((id) => s && s.enabledPlugins && s.enabledPlugins[id]); } catch { return []; }
};
// disable: turn off overlapping plugins that are on now, remember them. restore: turn back on only those.
export function plugins(op: 'disable' | 'restore'): string[] {
  const s = parseOrDie(CS());
  const st = parseOrDie(P.STATE) || {};
  if (op === 'disable') {
    const now = s && s.enabledPlugins ? OVERLAP.filter((id) => s.enabledPlugins[id]) : [];
    if (!now.length) return [];
    for (const id of now) s.enabledPlugins[id] = false;
    st.disabledPlugins = [...new Set([...(st.disabledPlugins || []), ...now])];
    writeJson(CS(), s);
    writeJson(P.STATE, st);
    return now;
  }
  const back: string[] = (st.disabledPlugins || []).filter((id: string) => s && s.enabledPlugins && id in s.enabledPlugins);
  for (const id of back) s.enabledPlugins[id] = true;
  if (back.length) writeJson(CS(), s);
  if (st.disabledPlugins) { delete st.disabledPlugins; writeJson(P.STATE, st); }
  return back;
}

function link(src: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let st: fs.Stats | null = null;
  try { st = fs.lstatSync(dest); } catch { /* absent */ }
  if (st && st.isSymbolicLink()) fs.unlinkSync(dest);
  else if (st) fs.renameSync(dest, `${dest}.bak-bosun`);
  fs.symlinkSync(src, dest);
}
// Write a generated file; a user's own file with the same name is kept as .bak-bosun.
function writeOwned(file: string, text: string): void {
  if (fs.existsSync(file) && !fs.readFileSync(file, 'utf8').includes(roles.MARK)) fs.renameSync(file, `${file}.bak-bosun`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

export function wireClaude(cfg: Cfg): void {
  preflight();   // before any write
  say('Claude Code');
  for (const r of roles.allRoles()) writeOwned(path.join(P.CLAUDE, 'agents', `bosun-${r.name}.md`), roles.renderClaude(r, cfg));
  for (const s of skillDirs()) link(s, path.join(P.CLAUDE, 'skills', path.basename(s)));
  block(path.join(P.CLAUDE, 'CLAUDE.md'), policy('claude'));
  backup(CS());
  hookJson(CS(), 'add', hookCmd('claude'), PERMS);
  mcpClaude('add');
  ok(`agents bosun-*, ${skillDirs().length} skills, rules in ~/.claude/CLAUDE.md, hook + permissions in settings.json (backup: .bak-bosun), MCP server bosun`);
}

export function wireCodex(cfg: Cfg): void {
  preflight();
  say('Codex');
  for (const h of codexHomes()) {
    for (const r of roles.allRoles()) writeOwned(path.join(h, 'agents', `bosun_${r.name}.toml`), roles.renderCodex(r, cfg));
    block(path.join(h, 'AGENTS.md'), policy('codex'));
    if (fs.existsSync(path.join(h, 'AGENTS.override.md'))) warn(`${h}/AGENTS.override.md wins over AGENTS.md: copy the bosun block into it`);
  }
  for (const s of skillDirs()) link(s, path.join(P.AGENTS_SKILLS, path.basename(s)));
  backup(CX_HOOKS());
  hookJson(CX_HOOKS(), 'add', hookCmd('codex'));   // not into Orca's home: Orca manages and rewrites its hooks.json
  mcpCodex('add');
  ok(`agents bosun_*, rules in AGENTS.md (${codexHomes().length > 1 ? '~/.codex + Orca' : '~/.codex'}), skills in ~/.agents/skills, hook in ~/.codex/hooks.json, MCP server bosun`);
  warn('one-time: start codex, run /hooks and trust the bosun route hook (Codex skips untrusted hooks)');
}

// A user's own file that writeOwned/link moved aside to .bak-bosun goes back in place.
function restoreAside(p: string): void { if (fs.existsSync(`${p}.bak-bosun`)) fs.renameSync(`${p}.bak-bosun`, p); }

export function unwire({ forget = false } = {}): string[] {
  preflight();
  const rmOwned = (dir: string, re: RegExp) => {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (re.test(f) && fs.lstatSync(p).isFile() && fs.readFileSync(p, 'utf8').includes(roles.MARK)) { fs.rmSync(p); restoreAside(p); }
    }
  };
  rmOwned(path.join(P.CLAUDE, 'agents'), /^bosun-.+\.md$/);
  for (const h of codexHomes()) rmOwned(path.join(h, 'agents'), /^bosun_.+\.toml$/);
  for (const dir of [path.join(P.CLAUDE, 'skills'), P.AGENTS_SKILLS]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (f.startsWith('bosun-') && fs.lstatSync(p).isSymbolicLink() && fs.readlinkSync(p).endsWith(`${path.sep}skills${path.sep}${f}`)) { fs.unlinkSync(p); restoreAside(p); }
    }
  }
  block(path.join(P.CLAUDE, 'CLAUDE.md'));
  for (const h of codexHomes()) block(path.join(h, 'AGENTS.md'));
  hookJson(CS(), 'rm', '', PERMS);
  hookJson(CX_HOOKS(), 'rm', '');
  mcpClaude('rm');
  mcpCodex('rm');
  const back = plugins('restore');
  const st = parseOrDie(P.STATE) || {};
  for (const f of st.created || []) {   // created by bosun and now empty again: remove
    if (!fs.existsSync(f)) continue;
    const t = fs.readFileSync(f, 'utf8');
    if (f.endsWith('.json') ? t.trim() === '{}' : t.trim() === '') fs.rmSync(f);
  }
  delete st.created;
  if (forget) delete st.replacePlugins;
  if (fs.existsSync(P.STATE)) saveState(st);
  return back;
}

// Install's wiring step: unwire, wire each host, then --replace-plugins (sticky until uninstall).
export function rewire(cfg: Cfg, hs: string[], replace: boolean): { back: string[]; off: string[] } {
  const back = unwire();
  for (const h of hs) (h === 'claude' ? wireClaude : wireCodex)(cfg);
  const st = parseOrDie(P.STATE) || {};
  const sticky = replace || !!st.replacePlugins;
  if (sticky && !st.replacePlugins) { st.replacePlugins = true; saveState(st); }
  const off = sticky ? plugins('disable') : [];
  return { back: back.filter((id) => !off.includes(id)), off };
}
