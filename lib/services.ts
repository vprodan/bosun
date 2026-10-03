// Ollama, Kev and their launchd agents (macOS). Only `bosun install` / `start` / `stop` call the side-effecting parts.
import fs from 'node:fs';
import path from 'node:path';
import { P, setKey, state, saveState, type Cfg } from './config.ts';
import { say, ok, warn, die, sh, step, has, which, up, sleep } from './util.ts';

const LABEL = (name: string) => `com.bosun.${name}`;
const uid = () => sh('id', ['-u']).out;
export const xml = (s: unknown): string => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const plistPath = (name: string): string => path.join(P.LA, `${LABEL(name)}.plist`);

export function plist(name: string, dir: string, env: Record<string, string>, argv: string[]): string {
  const envXml = Object.entries(env).map(([k, v]) => `<key>${xml(k)}</key><string>${xml(v)}</string>`).join('');
  const log = xml(path.join(P.BOSUN, `${name}.log`));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL(name)}</string>
  <key>ProgramArguments</key><array>${argv.map((a) => `<string>${xml(a)}</string>`).join('')}</array>
  <key>WorkingDirectory</key><string>${xml(dir)}</string>
  <key>EnvironmentVariables</key><dict>${envXml}</dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict></plist>
`;
}
export function svcWrite(name: string, dir: string, env: Record<string, string>, argv: string[]): void { fs.mkdirSync(P.LA, { recursive: true }); fs.writeFileSync(plistPath(name), plist(name, dir, env, argv)); }
export function svcOn(name: string): void {
  if (!fs.existsSync(plistPath(name))) return;
  sh('launchctl', ['bootout', `gui/${uid()}/${LABEL(name)}`]);
  // right after a bootout launchd often answers "5: Input/output error" while the old job tears down: retry briefly
  for (let i = 1; ; i++) {
    const r = sh('launchctl', ['bootstrap', `gui/${uid()}`, plistPath(name)]);
    if (!r.code) return;
    if (i === 4) die(`launchctl bootstrap ${name}: ${r.err}`);
    sleep(0.5);
  }
}
export const svcOff = (name: string): void => { sh('launchctl', ['bootout', `gui/${uid()}/${LABEL(name)}`]); };
export function svcRm(name: string): void { svcOff(name); fs.rmSync(plistPath(name), { force: true }); }
export const svcRunning = (name: string): boolean => sh('launchctl', ['print', `gui/${uid()}/${LABEL(name)}`]).code === 0;
function waitUp(url: string, tries: number): boolean { for (let i = 0; i < tries; i++) { if (up(url)) return true; sleep(2); } return false; }

// vge('0.34.4', '0.34.0') -> true
export function vge(have: string, need: string): boolean {
  const a = String(have).split('.').map(Number);
  const b = String(need).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return true;
}

export const app = (): boolean => fs.existsSync(P.OLLAMA_APP);
const ollamaEnv = (cfg: Cfg): Record<string, string> => ({
  OLLAMA_HOST: cfg.OLLAMA_URL.replace(/^https?:\/\//, ''), OLLAMA_CONTEXT_LENGTH: cfg.CTX, OLLAMA_KV_CACHE_TYPE: 'q8_0',
  OLLAMA_NUM_PARALLEL: '1', OLLAMA_MAX_LOADED_MODELS: '1', OLLAMA_KEEP_ALIVE: '30m',
});
// Ollama.app reads launchctl env. setenv is lost on reboot; `bosun start` re-applies it.
export function appEnv(cfg: Cfg, on: boolean): void { for (const [k, v] of Object.entries(ollamaEnv(cfg))) sh('launchctl', on ? ['setenv', k, v] : ['unsetenv', k]); }
export const appEnvOk = (cfg: Cfg): boolean => sh('launchctl', ['getenv', 'OLLAMA_CONTEXT_LENGTH']).out === String(cfg.CTX);
export function startOllama(cfg: Cfg): void { if (app()) { appEnv(cfg, true); sh('open', ['-a', 'Ollama']); } else svcOn('ollama'); }
export function stopOllama(): void { if (app()) sh('osascript', ['-e', 'quit app "Ollama"']); else svcOff('ollama'); }

export function setupOllama(cfg: Cfg): void {
  say('Ollama');
  if (app()) {
    ok('Ollama.app found: configuring it instead of running a second server');
    const st = state();
    if (!st.appEnvPrev) {   // remember your own values once, so uninstall can put them back
      st.appEnvPrev = Object.fromEntries(Object.keys(ollamaEnv(cfg)).map((k) => [k, sh('launchctl', ['getenv', k]).out || null]));
      saveState(st);
    }
    appEnv(cfg, true);
    if (sh('pgrep', ['-xq', 'Ollama']).code === 0) { sh('osascript', ['-e', 'quit app "Ollama"']); sleep(2); }
    sh('open', ['-a', 'Ollama']);
  } else {
    if (!has('ollama')) step('brew', ['install', 'ollama']);
    sh('brew', ['services', 'stop', 'ollama']);
    svcWrite('ollama', P.HOME, ollamaEnv(cfg), [which('ollama'), 'serve']);
    svcOn('ollama');
  }
  if (!waitUp(`${cfg.OLLAMA_URL}/api/tags`, 30)) die(`Ollama not responding at ${cfg.OLLAMA_URL}`);
  const v = (sh('ollama', ['--version']).out.match(/\d+\.\d+\.\d+/) || ['0'])[0];
  if (!vge(v, '0.34.0')) die(`ollama ${v} < 0.34.0 (needed for MLX models + Anthropic/Responses APIs): brew upgrade ollama, or update the app`);
  ok(`ollama ${v}`);
}

export function setModel(cfg: Cfg, tag = cfg.LOCAL_MODEL): void {
  say(`Local model: ${tag}`);
  step('ollama', ['pull', tag]);
  setKey('LOCAL_MODEL', tag);
  ok(`LOCAL_MODEL=${tag}`);
}

export function setupRouter(cfg: Cfg): void {
  say(`Router: Kev (${cfg.ROUTER_RUN}) on 127.0.0.1:${cfg.ROUTER_PORT}`);
  if (!has('uv')) step('brew', ['install', 'uv']);
  const kev = path.join(P.SHARE, 'kev');
  fs.mkdirSync(P.SHARE, { recursive: true });
  if (fs.existsSync(path.join(kev, '.git'))) {
    if (sh('git', ['-C', kev, 'pull', '-q', '--ff-only']).code) warn('kev: git pull failed, using the existing checkout');
  } else step('git', ['clone', '-q', 'https://github.com/jaredpalmer/kev.git', kev]);
  step('uv', ['sync', '-q', '--extra', 'serve'], { cwd: kev });
  svcWrite('router', kev, { PATH: process.env.PATH || '' }, [which('uv'), 'run', '--extra', 'serve', 'python', '-m', 'kev.serve', '--run', cfg.ROUTER_RUN, '--port', String(cfg.ROUTER_PORT)]);
  svcOn('router');
  const log = path.join(P.BOSUN, 'router.log');
  console.log(`  (first start downloads the weights: tail -f ${log})`);
  if (waitUp(`http://127.0.0.1:${cfg.ROUTER_PORT}/v1/models`, 150)) ok('Kev up');
  else warn(`Kev not up yet (see ${log}). Hosts still work; hints stay off until it is.`);
}
