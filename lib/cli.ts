// Command dispatch. Later tasks add their commands to COMMANDS.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { P, VERSION, load, parse, setKey, hosts, harness, role, state, saveState, type Cfg, type Spec } from './config.ts';
import * as u from './util.ts';
import * as roles from './roles.ts';
import * as route from './route.ts';
import * as services from './services.ts';
import * as orca from './orca.ts';
import * as exec from './exec.ts';
import * as wire from './wire.ts';
import * as memoryCli from './memory/cli.ts';
import * as mcp from './mcp.ts';
import { inspectMemorySchema } from './memory/sqlite.ts';
import { RemoteStore } from './memory/remote.ts';
import * as serveLib from './serve.ts';
import { MemoryError } from './memory/types.ts';

type Command = (argv: string[], cfg: Cfg) => number | void | Promise<number | void>;
export const COMMANDS: Record<string, Command> = {
  install, doctor, uninstall,
  config: () => u.sh(process.env.EDITOR || 'nano', [P.CFG], { stdio: 'inherit' }).code,
  run: (argv, cfg) => exec.run(argv, cfg),
  review: (argv, cfg) => exec.review(argv, cfg),
  help: usage,
  roles: rolesCmd,
  start, stop, restart, status,
  model: modelCmd,
  card: (argv) => orca.card(argv),
  spin: (argv) => orca.spin(argv),
  _exec: (argv) => orca.execJob(argv[0]),
  route: (argv, cfg) => route.main(argv, cfg),
  label: (argv, cfg) => route.main(['--label'], cfg),
  eval: (argv, cfg) => route.main(['--eval'], cfg),
  stats: (argv, cfg) => route.main(['--stats'], cfg),
  memory: (argv, cfg) => memoryCli.main(argv, cfg),
  mcp: (argv, cfg) => mcp.main(cfg),
  serve: (argv, cfg) => serveLib.main(argv, cfg),
};

const fmt = (s: Spec) => (s.effort ? `${s.model} (${s.effort})` : s.model);
function rolesCmd(argv: string[], cfg: Cfg): number {
  const rows = roles.allRoles().map((r) => ({ role: r.name, access: r.access, claude: role(cfg, r.name, 'claude'), codex: role(cfg, r.name, 'codex') }));
  if (argv.includes('--json')) { console.log(JSON.stringify(rows, null, 2)); return 0; }
  for (const r of rows) console.log(`${r.role.padEnd(10)} ${r.access.padEnd(6)} claude: ${fmt(r.claude).padEnd(18)} codex: ${fmt(r.codex)}`);
  console.log(`\nreview: ${cfg.REVIEW_BY_CODEX} (from Claude), ${cfg.REVIEW_BY_CLAUDE} (from Codex)   -e codex: ${cfg.WORKER_BY_CODEX}   -e claude: ${cfg.WORKER_BY_CLAUDE}   local: ${cfg.LOCAL_MODEL}`);
  return 0;
}

const SPLIT = ['memory', 'kev-proxy'];   // launchd services of a split-setup server (bosun install --serve)
function chk(good: string, fix: string, pass: boolean): void { if (pass) u.ok(good); else u.bad(fix); }
function target(argv: string[]): string {
  const w = argv[0] || 'all';
  if (!['all', 'ollama', 'router'].includes(w)) u.die('target must be ollama, router or all', 2);
  return w;
}
function start(argv: string[], cfg: Cfg): number {
  const w = target(argv);
  if (w !== 'router') services.startOllama(cfg);
  if (w !== 'ollama') services.svcOn('router');
  if (w === 'all') for (const n of SPLIT) services.svcOn(n);   // no-ops without a plist
  u.ok(`started ${w}`);
  return 0;
}
function stop(argv: string[]): number {
  const w = target(argv);
  if (w !== 'router') services.stopOllama();
  if (w !== 'ollama') services.svcOff('router');
  if (w === 'all') for (const n of SPLIT) if (fs.existsSync(services.plistPath(n))) services.svcOff(n);
  u.ok(`stopped ${w} (frees RAM; hints and local runs pause, your host CLI keeps working)`);
  return 0;
}
function restart(argv: string[], cfg: Cfg): number { stop(argv); u.sleep(1); return start(argv, cfg); }
function status(argv: string[], cfg: Cfg): number | Promise<number> {
  u.say('Services');
  for (const n of ['ollama', 'router', ...SPLIT]) if (fs.existsSync(services.plistPath(n))) chk(`${n} running`, `${n} stopped`, services.svcRunning(n));
  if (services.app()) chk('Ollama.app running', 'Ollama.app not running', u.sh('pgrep', ['-xq', 'Ollama']).code === 0);
  u.say('Loaded models (ollama ps)');
  console.log(u.sh('ollama', ['ps']).out);
  u.say('Router decisions');
  return route.main(['--stats'], cfg);
}
function modelCmd(argv: string[], cfg: Cfg): number {
  if (!u.up(`${cfg.OLLAMA_URL}/api/tags`)) u.die('Ollama down: bosun start ollama');
  services.setModel(cfg, argv[0] || cfg.LOCAL_MODEL);
  return 0;
}

const REMOTE_KEYS: Record<string, string> = { kev: 'ROUTER_URL', llm: 'OLLAMA_URL', memory: 'MEMORY_URL' };
const INSTALL_USAGE = 'bosun install [--host claude|codex|both] [--replace-plugins] [--serve kev,llm,memory | --remote kev=URL,llm=URL,memory=URL]';

// Set a config.env key and remember its previous value once, so uninstall restores it.
function setRemembered(cfg: Cfg, key: string, value: string): void {
  const st = state();
  st.configPrev = st.configPrev || {};
  if (!(key in st.configPrev)) st.configPrev[key] = parse(P.CFG)[key] ?? '';
  saveState(st);
  setKey(key, value);
  cfg[key] = value;
}

async function install(argv: string[], cfg: Cfg): Promise<number> {
  let replace = false;
  let serve: string[] = [];
  const remote: Record<string, string> = {};
  const list = (s: string | undefined) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--host') {
      const h = String(argv[++i] || '').replace('both', 'claude,codex');
      if (!h) u.die('--host needs claude, codex or both', 2);
      cfg.HOSTS = h;
    } else if (argv[i] === '--replace-plugins') replace = true;
    else if (argv[i] === '--serve') {
      serve = list(argv[++i]);
      if (!serve.length || serve.some((w) => !(w in REMOTE_KEYS))) u.die('--serve takes kev, llm and/or memory, like --serve kev,llm,memory', 2);
    } else if (argv[i] === '--remote') {
      for (const kv of list(argv[++i])) {
        const [k, ...rest] = kv.split('=');
        const url = rest.join('=');
        if (!(k in REMOTE_KEYS) || !/^https?:\/\/\S+$/.test(url)) u.die('--remote takes kev=URL,llm=URL,memory=URL (http or https)', 2);
        remote[k] = url.replace(/\/$/, '');
      }
      if (!Object.keys(remote).length) u.die('--remote takes kev=URL,llm=URL,memory=URL', 2);
    } else u.die(`unknown option ${argv[i]} (${INSTALL_USAGE})`, 2);
  }
  if (serve.length && Object.keys(remote).length) u.die('--serve and --remote exclude each other: a server serves, a client points at it', 2);
  wire.preflight();   // a config file we can't read stops us before anything changes
  if (os.platform() !== 'darwin') u.die('macOS only');
  if (!u.has('brew')) u.die('Homebrew required: https://brew.sh');
  if (serve.length) return installServe(cfg, serve);
  const hs = hosts(cfg);
  if (!hs.length) u.die('install Claude Code (npm i -g @anthropic-ai/claude-code) or Codex (npm i -g @openai/codex) first');
  for (const h of hs) {
    if (!['claude', 'codex'].includes(h)) u.die(`unknown host ${h}`, 2);
    if (!u.has(h)) u.die(`host ${h} is not installed`);
  }
  setKey('HOSTS', cfg.HOSTS);
  for (const [k, url] of Object.entries(remote)) setRemembered(cfg, REMOTE_KEYS[k], url);
  // --remote now wins (a tunnel on 127.0.0.1 is still remote); a URL an earlier --remote set to another machine stays remote.
  const llmRemote = !!remote.llm || !thisMachine(cfg.OLLAMA_URL);
  const kevRemote = !!remote.kev || (!!cfg.ROUTER_URL && !thisMachine(cfg.ROUTER_URL));
  if (llmRemote) u.ok(`LLMs on ${cfg.OLLAMA_URL} (no local Ollama or model pull)`);
  else { services.setupOllama(cfg); services.setModel(cfg); }
  if (kevRemote) u.ok(`Kev on ${cfg.ROUTER_URL} (no local router)`);
  else services.setupRouter(cfg);
  if (remote.memory) u.ok(`memory on ${remote.memory}`);
  linkBin();
  const { off, back } = wire.rewire(cfg, hs, replace);
  if (off.length) u.ok(`overlapping plugins off: ${off.join(', ')} (bosun uninstall re-enables them)`);
  if (back.length) u.warn(`re-enabled ${back.join(', ')}`);
  await doctor([], cfg);
  smoke(cfg);
  console.log(`\n${u.C.b}Installed.${u.C.n} Restart ${hs.join(' and ')}, then work as usual. Cheatsheet: bosun help`);
  return 0;
}

// A split-setup server: only the listed services, on the bind address. No host wiring.
function installServe(cfg: Cfg, what: string[]): number {
  const bind = serveLib.bindAddress(cfg);
  setRemembered(cfg, 'SERVE_BIND', bind);
  if (what.includes('llm')) { setRemembered(cfg, 'OLLAMA_URL', `http://${bind}:11434`); services.setupOllama(cfg); services.setModel(cfg); }
  const self = [process.execPath, path.join(P.REPO, 'bin', 'bosun')];
  if (what.includes('kev')) {
    services.setupRouter(cfg);
    services.svcWrite('kev-proxy', P.REPO, { PATH: process.env.PATH || '' }, [...self, 'serve', 'kev']);
    services.svcOn('kev-proxy');
  }
  if (what.includes('memory')) {
    services.svcWrite('memory', P.REPO, { PATH: process.env.PATH || '' }, [...self, 'serve', 'memory']);
    services.svcOn('memory');
  }
  saveState({ ...state(), serve: what });
  u.ok(`serving ${what.join(', ')} on ${bind} (allow ${serveLib.allowList(cfg, bind).join(', ')})`);
  const url: Record<string, string> = { kev: `kev=http://${bind}:${cfg.ROUTER_PORT}`, llm: `llm=http://${bind}:11434`, memory: `memory=http://${bind}:${cfg.MEMORY_PORT}` };
  console.log(`\nOn each client: bosun install --remote ${what.map((w) => url[w]).join(',')}`);
  if (!/^100\./.test(bind)) u.warn('not a Tailscale address: this traffic is plain HTTP on your network');
  return 0;
}

// Does this URL point at this machine (loopback or one of its own addresses)?
function thisMachine(url: string): boolean {
  let host = '';
  try { host = new URL(url).hostname.replace(/^\[|\]$/g, ''); } catch { return false; }
  const mine = Object.values(os.networkInterfaces()).flat().map((a) => a?.address);
  return ['localhost', '127.0.0.1', '::1'].includes(host) || mine.includes(host);
}

function linkBin(): void {
  fs.mkdirSync(P.BIN, { recursive: true });
  const dest = path.join(P.BIN, 'bosun');
  fs.rmSync(dest, { force: true });
  fs.symlinkSync(path.join(P.REPO, 'bin', 'bosun'), dest);
  if (!(process.env.PATH || '').split(':').includes(P.BIN)) {
    const line = 'export PATH="$HOME/.local/bin:$PATH"';
    fs.appendFileSync(path.join(P.HOME, '.zshrc'), `\n${line}\n`);
    saveState({ ...state(), zshrcLine: line });
    u.warn('added ~/.local/bin to PATH in ~/.zshrc: open a new terminal');
  }
}

function smoke(cfg: Cfg): void {
  u.say(`Smoke test: local executor (${harness(cfg)} harness, ${cfg.LOCAL_MODEL})`);
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'bosun-smoke-'));
  u.sh('git', ['init', '-q'], { cwd: t });
  fs.writeFileSync(path.join(t, 'math.ts'), 'export const add = (a: number, b: number) => a - b;\n');
  const t0 = Date.now();
  u.sh(process.execPath, [path.join(P.REPO, 'bin', 'bosun'), 'run', '--no-watch', 'math.ts: add() subtracts. Make it add. Touch nothing else.'], { cwd: t, timeout: 10 * 60 * 1000 });
  if (fs.readFileSync(path.join(t, 'math.ts'), 'utf8').includes('a + b')) u.ok(`local model fixed math.ts in ${Math.round((Date.now() - t0) / 1000)} s`);
  else u.warn(`local model didn't fix math.ts: try LOCAL_HARNESS=codex, or bosun model ${cfg.LOCAL_FALLBACK}`);
}

async function doctor(argv: string[], cfg: Cfg): Promise<number> {
  u.state.failed = false;
  u.say('Doctor');
  const mem = Math.round(os.totalmem() / 2 ** 30);
  console.log(`  mac: ${u.sh('sysctl', ['-n', 'machdep.cpu.brand_string']).out}, ${mem} GB RAM, macOS ${u.sh('sw_vers', ['-productVersion']).out}`);
  if (mem < 48) u.warn(`under 48 GB: bosun model ${cfg.LOCAL_FALLBACK}, and CTX=32768`);
  else if (mem < 64) console.log(`  - 48 GB is tight: ${cfg.LOCAL_MODEL} peaks ~32 GB at ${cfg.CTX} ctx. If runs crawl, quit Docker or set CTX=32768`);
  const hs = hosts(cfg);
  console.log(`  hosts: ${hs.join(',') || 'none'}   local harness: ${harness(cfg)}   model: ${cfg.LOCAL_MODEL}   orca: ${orca.inOrca() ? 'yes' : 'no'}`);
  const read = (p: string) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');
  const names = roles.allRoles().map((r) => r.name);
  const skills = fs.readdirSync(path.join(P.REPO, 'skills')).filter((n) => n.startsWith('bosun-'));
  const version = (bin: string) => u.sh(bin, ['--version']).out.split('\n')[0];
  if (hs.includes('claude')) {
    chk(`claude ${version('claude')}`, 'claude CLI missing', u.has('claude'));
    chk('router hook in ~/.claude/settings.json', 'router hook missing: bosun install', read(path.join(P.CLAUDE, 'settings.json')).includes('bosun route --hook'));
    chk('rules in ~/.claude/CLAUDE.md', 'rules missing: bosun install', read(path.join(P.CLAUDE, 'CLAUDE.md')).includes('bosun:begin'));
    chk(`agents bosun-{${names.join(',')}}`, 'agents missing: bosun install', names.every((n) => fs.existsSync(path.join(P.CLAUDE, 'agents', `bosun-${n}.md`))));
    chk(`${skills.length} skills in ~/.claude/skills`, 'skills missing: bosun install', skills.every((s) => fs.existsSync(path.join(P.CLAUDE, 'skills', s, 'SKILL.md'))));
    const over = wire.enabledOverlap();
    if (over.length) u.warn(`overlapping plugins enabled: ${over.join(', ')}. Fix: bosun install --replace-plugins (or /plugin disable <name>)`);
  }
  if (hs.includes('codex')) {
    chk(`codex ${version('codex')}`, 'codex CLI missing', u.has('codex'));
    chk('router hook in ~/.codex/hooks.json (trust it once via /hooks)', 'router hook missing: bosun install', read(path.join(P.CODEX, 'hooks.json')).includes('bosun route --hook'));
    for (const h of wire.codexHomes()) chk(`rules in ${h === P.CODEX ? '~/.codex' : 'Orca\'s Codex home'}/AGENTS.md`, `rules missing in ${h}: bosun install`, read(path.join(h, 'AGENTS.md')).includes('bosun:begin'));
    chk(`agents bosun_{${names.join(',')}}`, 'agents missing: bosun install', names.every((n) => fs.existsSync(path.join(P.CODEX, 'agents', `bosun_${n}.toml`))));
    chk(`${skills.length} skills in ~/.agents/skills`, 'skills missing: bosun install', skills.every((s) => fs.existsSync(path.join(P.AGENTS_SKILLS, s, 'SKILL.md'))));
  }
  if (hs.includes('claude')) chk('bosun MCP server in Claude Code', 'MCP server missing in Claude Code: bosun install', u.sh('claude', ['mcp', 'get', 'bosun']).code === 0);
  if (hs.includes('codex')) for (const h of wire.codexHomes()) chk(`bosun MCP server in ${h === P.CODEX ? '~/.codex' : 'Orca\'s Codex home'}`, `MCP server missing in ${h}: bosun install`, u.sh('codex', ['mcp', 'get', 'bosun'], { env: { ...process.env, CODEX_HOME: h } }).code === 0);
  if (cfg.MEMORY_URL) {
    const h = await new RemoteStore(cfg).health().catch(() => null);
    chk(`memory server ${cfg.MEMORY_URL} (bosun ${h?.version}, schema v${h?.schema})`, `memory server unreachable at ${cfg.MEMORY_URL}`, !!h);
    if (h && h.version !== VERSION) u.warn(`memory server runs bosun ${h.version}, this is ${VERSION}: update both`);
  } else {
    const inspection = inspectMemorySchema(P.DB);
    if (inspection.state === 'wal-held') u.warn(`memory ${P.DB}: WAL held; schema not verified by read-only doctor`);
    else chk(`memory ${P.DB} (schema v${inspection.version ?? 0})`,
      inspection.state === 'missing' ? `memory database absent: ${P.DB} (created on first use)` : `memory database unreadable: ${P.DB}`,
      inspection.state === 'verified');
  }
  chk(`local harness: ${harness(cfg)}`, `local harness ${harness(cfg)} not installed`, u.has(harness(cfg)));
  if (services.app() && thisMachine(cfg.OLLAMA_URL)) chk(`Ollama.app env (context ${cfg.CTX})`, 'Ollama.app lost bosun env (reboot?): bosun start ollama', services.appEnvOk(cfg));
  chk(`ollama up (${cfg.OLLAMA_URL})`, 'ollama down: bosun start ollama', u.up(`${cfg.OLLAMA_URL}/api/tags`));
  let models: string[] = [];
  try { models = JSON.parse(u.sh('curl', ['-sf', '-m', '2', `${cfg.OLLAMA_URL}/api/tags`]).out).models.map((m: { name: string }) => m.name); } catch { /* reported below */ }
  const M = cfg.LOCAL_MODEL;
  chk(`model ${M} on ${cfg.OLLAMA_URL}`, `model ${M} missing on ${cfg.OLLAMA_URL}: bosun model ${M}`, models.includes(M) || models.includes(`${M}:latest`));
  const kev = route.routerUrl(cfg);
  chk(`kev up (${kev}, ${cfg.ROUTER_RUN})`, `kev down at ${kev}: bosun start router (log: ${path.join(P.BOSUN, 'router.log')})`, u.up(`${kev}/v1/models`));
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) u.warn('ANTHROPIC_API_KEY/AUTH_TOKEN set in your shell: this overrides your Claude subscription login');
  return u.state.failed ? 1 : 0;
}

function uninstall(argv: string[], cfg: Cfg): number {
  wire.preflight();
  u.say('Uninstall');
  services.svcRm('ollama');
  services.svcRm('router');
  for (const n of SPLIT) services.svcRm(n);
  const st = state();
  for (const [k, v] of Object.entries(st.configPrev || {})) setKey(k, String(v));   // URLs and bind address install changed
  if (services.app()) {   // put your own launchctl values back; unset only what bosun set
    if (st.appEnvPrev) for (const [k, v] of Object.entries(st.appEnvPrev)) u.sh('launchctl', v === null ? ['unsetenv', k] : ['setenv', k, String(v)]);
    else services.appEnv(cfg, false);
  }
  const link = path.join(P.BIN, 'bosun');
  let lst: fs.Stats | null = null;
  try { lst = fs.lstatSync(link); } catch { /* absent */ }
  if (lst && lst.isSymbolicLink() && fs.readlinkSync(link).endsWith(path.join('bin', 'bosun'))) fs.rmSync(link);   // only our own link
  const rc = path.join(P.HOME, '.zshrc');
  if (st.zshrcLine && fs.existsSync(rc)) fs.writeFileSync(rc, fs.readFileSync(rc, 'utf8').replace(`${st.zshrcLine}\n`, ''));
  const back = wire.unwire({ forget: true });
  const after = state();
  delete after.zshrcLine;
  delete after.appEnvPrev;
  delete after.configPrev;
  delete after.serve;
  if (fs.existsSync(P.STATE)) saveState(after);
  u.ok(`removed services, link, hooks, rules, agents, skills${back.length ? `; re-enabled ${back.join(', ')}` : ''}. Kept: models (ollama rm ${cfg.LOCAL_MODEL}), ${P.SHARE}, ${P.BOSUN} (config, logs, labels, plans)`);
  return 0;
}

function usage(argv: string[] = [], cfg: Cfg = load()): number {
  console.log(`${u.C.b}bosun${u.C.n}: pair with one agent; bosun routes the rest.   hosts: ${hosts(cfg).join(',') || 'none'}   local: ${cfg.LOCAL_MODEL}

  bosun install [--host claude|codex|both] [--replace-plugins]   one-shot setup, safe to re-run
  bosun install --serve kev,llm,memory | --remote kev=URL,llm=URL,memory=URL   split setup (server | client)
  bosun doctor | status | start|stop|restart [ollama|router|all] | uninstall | config

  bosun run [-e local|codex|claude] "task" | -f spec | -f - [--no-watch]   an executor makes the edit here
  bosun review [--pr N] [--base ref] [--vendor claude|codex]   the other vendor reviews the diff, read-only
  bosun spin [--agent claude|codex|local] [--name slug] [--stacked] "spec" | -f spec   side quest in a new Orca worktree
  bosun card <todo|in-progress|in-review|completed> ["comment"]   Orca worktree card
  bosun roles [--json]                 role -> model table for both hosts
  bosun model [tag]                    switch the local model (e.g. ${cfg.LOCAL_FALLBACK})
  bosun route "prompt" | label | eval | stats   the Kev router
  bosun mcp                            MCP server for Claude Code and Codex (memory + context tools)
  bosun serve memory|kev               serve memory or Kev to your other machines (split setup)
  bosun memory add|search|get|update|delete|review|consolidate|stats …   curated memory (bosun memory help)

In any prompt: add #noroute to skip the router hint.`);
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const [name = 'help', ...rest] = argv;
  const fn = COMMANDS[name === '-h' || name === '--help' ? 'help' : name];
  if (!fn) { usage(); return 2; }
  try {
    return (await fn(rest, load())) || 0;
  } catch (e) {
    if (e instanceof u.BosunError) { console.error(`bosun: ${e.message}`); return e.exitCode; }
    if (e instanceof MemoryError) { console.error(`bosun: ${e.message}`); return 1; }
    throw e;
  }
}
