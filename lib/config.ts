// Settings: environment > ~/.bosun/config.env > config.default.env. Paths are getters over $HOME, so tests can sandbox them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { has, readJson, writeJson } from './util.ts';

export type Cfg = Record<string, string>;
const REPO = path.resolve(import.meta.dirname, '..');
export const VERSION: string = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
export const P = {
  REPO,
  DEFAULTS: path.join(REPO, 'config.default.env'),
  get HOME(): string { return process.env.HOME || os.homedir(); },
  get BOSUN(): string { return process.env.BOSUN_HOME || path.join(this.HOME, '.bosun'); },
  get SHARE(): string { return path.join(this.HOME, '.local', 'share', 'bosun'); },
  get LA(): string { return path.join(this.HOME, 'Library', 'LaunchAgents'); },
  get BIN(): string { return path.join(this.HOME, '.local', 'bin'); },
  get CLAUDE(): string { return path.join(this.HOME, '.claude'); },
  // ~/.codex, not an inherited CODEX_HOME: inside Orca that points at Orca's own managed runtime home
  get CODEX(): string { return process.env.BOSUN_CODEX_HOME || path.join(this.HOME, '.codex'); },
  get ORCA_CODEX(): string { return process.env.ORCA_CODEX_HOME || path.join(this.HOME, 'Library', 'Application Support', 'orca', 'codex-runtime-home', 'home'); },
  get OLLAMA_APP(): string { return process.env.BOSUN_OLLAMA_APP || '/Applications/Ollama.app'; },
  get TAILSCALE_APP(): string { return process.env.BOSUN_TAILSCALE_APP || '/Applications/Tailscale.app/Contents/MacOS/Tailscale'; },
  get AGENTS_SKILLS(): string { return path.join(this.HOME, '.agents', 'skills'); },
  get CFG(): string { return path.join(this.BOSUN, 'config.env'); },
  get STATE(): string { return path.join(this.BOSUN, 'state.json'); },
  get DB(): string { return path.join(this.BOSUN, 'memory.db'); },
};

export function parse(file: string): Cfg {
  const out: Cfg = {};
  if (!fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = raw.split('#')[0].trim().match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

export function load(): Cfg {
  fs.mkdirSync(P.BOSUN, { recursive: true });
  if (!fs.existsSync(P.CFG)) fs.copyFileSync(P.DEFAULTS, P.CFG);
  const defaults = parse(P.DEFAULTS);
  const env: Cfg = {};
  for (const k of Object.keys(defaults)) if (process.env[k] !== undefined) env[k] = process.env[k] as string;
  return { ...defaults, ...parse(P.CFG), ...env };
}

export function setKey(key: string, value: string): void {
  const text = fs.existsSync(P.CFG) ? fs.readFileSync(P.CFG, 'utf8') : '';
  const re = new RegExp(`^${key}=[^ #\\n]*`, 'm');
  const sep = text && !text.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(P.CFG, re.test(text) ? text.replace(re, `${key}=${value}`) : `${text}${sep}${key}=${value}\n`);
}

// "opus:high" -> { model: 'opus', effort: 'high' }
export type Spec = { model: string; effort: string };
export function spec(value?: string): Spec { const [model = '', effort = ''] = String(value || '').split(':'); return { model, effort }; }
export const role = (cfg: Cfg, name: string, host: string): Spec => spec(cfg[`ROLE_${name.toUpperCase()}_${host.toUpperCase()}`]);
export const hosts = (cfg: Cfg): string[] => (cfg.HOSTS === 'auto'
  ? ['claude', 'codex'].filter(has)
  : cfg.HOSTS.replace('both', 'claude,codex').split(',').map((h) => h.trim()).filter(Boolean));
export const harness = (cfg: Cfg): string => (cfg.LOCAL_HARNESS !== 'auto' ? cfg.LOCAL_HARNESS : has('claude') ? 'claude' : 'codex');

// ~/.bosun/state.json: what bosun changed, so uninstall can undo exactly that
export const state = (): any => readJson(P.STATE) || {};
export const saveState = (st: object): void => writeJson(P.STATE, st);
