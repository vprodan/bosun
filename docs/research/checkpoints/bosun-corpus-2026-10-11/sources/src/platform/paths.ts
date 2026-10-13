import path from 'node:path';
import os from 'node:os';
import { BosunError } from '../core/errors.ts';
import type { Env } from '../core/domain/inference.ts';

export type RuntimePaths = Readonly<{
  home: string; config: string; legacyConfig: string; run: string; socket: string; owner: string;
  hookConfig: string; state: string; memory: string; view: string; backups: string;
  artifacts: string; manifest: string;
}>;

function absolute(value: string): string {
  if (!value || !path.isAbsolute(value) || path.resolve(value) !== value || value.includes('\0')) {
    throw new BosunError('invalid', 'Runtime path must be an absolute normalized path');
  }
  return value;
}

// Path calculation has no filesystem effects. Roots receive an explicit environment;
// only CLI/daemon composition normally passes process.env.
export function runtimePaths(env: Env, fallbackHome: () => string = os.homedir): RuntimePaths {
  const home = absolute(env.BOSUN_HOME || path.join(absolute(env.HOME || fallbackHome()), '.bosun'));
  const run = path.join(home, 'run');
  return Object.freeze({
    home, config: path.join(home, 'config.toml'), legacyConfig: path.join(home, 'config.env'), run,
    socket: absolute(env.BOSUN_SOCKET || path.join(run, 'bosun.sock')), owner: path.join(run, 'owner.db'),
    hookConfig: path.join(run, 'hook-config.json'), state: path.join(home, 'state.db'),
    memory: path.join(home, 'memory.db'), view: path.join(home, 'memory-view', 'public.db'),
    backups: path.join(home, 'memory-backups'), artifacts: path.join(home, 'artifacts'),
    manifest: path.join(home, 'manifest.json'),
  });
}
