import './bootstrap.ts';
import childProcess, { type SpawnOptions } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import type { Sandbox } from './helpers.ts';

export async function gitEnvelope<T>(
  sb: Sandbox,
  run: (calls: { args: readonly string[]; env: NodeJS.ProcessEnv }[]) => Promise<T>,
): Promise<T> {
  const original = childProcess.spawn;
  const calls: { args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
  // Inspect production selection, then restore mandatory fixture-only roots.
  // Every spawn still passes through the original containment guard.
  const spawn = (command: string, args: readonly string[] = [], options: SpawnOptions = {}) => {
    calls.push({ args, env: { ...options.env } });
    return original(command, args, { ...options, env: { ...sb.env(), ...options.env, GIT_CONFIG_GLOBAL:sb.env().GIT_CONFIG_GLOBAL } });
  };
  childProcess.spawn = spawn as unknown as typeof childProcess.spawn;
  syncBuiltinESMExports();
  try {
    return await run(calls);
  } finally {
    childProcess.spawn = original;
    syncBuiltinESMExports();
  }
}
