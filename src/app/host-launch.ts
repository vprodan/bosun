import fs from 'node:fs';
import type { Env } from '../core/domain/inference.ts';
import type { HostId, RuntimeConfig } from '../core/domain/config.ts';
import { BosunError } from '../core/errors.ts';
import type { RuntimePaths } from '../platform/paths.ts';
import { streamProcess } from '../platform/process.ts';
import { foregroundProcess } from '../platform/foreground-process.ts';
import { hostLaunchPlan } from './host-install.ts';

type Options = {
  paths: RuntimePaths;
  config: RuntimeConfig;
  binary: string;
  env: Env;
  cwd: string;
};
function identity(file: string) {
  const stat = fs.statSync(file);
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.mode];
}
/** Bounded, inference-free inspection of only the explicitly selected native host. */
export async function inspectNativeHostVersion(
  options: { hostId: HostId; command: string; cwd: string; env: Env },
  signal: AbortSignal,
): Promise<string> {
  let output = '',
    code: number | null = null;
  for await (const event of streamProcess({
    command: options.command,
    args: ['--version'],
    cwd: options.cwd,
    env: options.env,
    signal,
    timeoutMs: 3000,
    maxOutputBytes: 4096,
    maxLineBytes: 1024,
  })) {
    if (event.t === 'line') output += event.text + '\n';
    else code = event.code;
  }
  const format =
    options.hostId === 'codex'
      ? /^codex-cli ([0-9]+\.[0-9]+\.[0-9]+)\s*$/
      : options.hostId === 'claude'
        ? /^([0-9]+\.[0-9]+\.[0-9]+) \(Claude Code\)\s*$/
        : options.hostId === 'omp'
          ? /^omp\/([0-9]+\.[0-9]+\.[0-9]+)\s*$/
          : /^([0-9]+\.[0-9]+\.[0-9]+)\s*$/;
  const version = format.exec(output)?.[1];
  if (code !== 0 || !version)
    throw new BosunError('unverified', 'Native version output is unavailable or unsupported');
  return version;
}
export async function launchHost(
  options: Options,
  id: string,
  version: number,
  hash: string,
  signal: AbortSignal,
) {
  if (signal.aborted) throw new BosunError('cancelled', 'Native launch cancelled');
  const plan = await hostLaunchPlan(options, id, version, hash);
  const before = identity(plan.command);
  // Native credentials/configuration remain with this same selected host. Do
  // not persist or print the inherited environment, or copy any auth file.
  const env: Record<string, string | undefined> = { ...options.env, ...plan.env };
  delete env.BOSUN_SESSION_ID;
  if (plan.hostId === 'claude') delete env.CLAUDECODE;
  if (plan.hostId === 'codex') delete env.CODEX_THREAD_ID;
  if (await inspectNativeHostVersion({ ...plan, env }, signal) !== plan.nativeVersion)
    throw new BosunError('unverified', 'Native version differs from the prepared profile');
  const fresh = await hostLaunchPlan(options, id, version, hash);
  if (
    JSON.stringify(fresh) !== JSON.stringify(plan) ||
    JSON.stringify(identity(plan.command)) !== JSON.stringify(before)
  )
    throw new BosunError('conflict', 'Native launch source changed');
  if (signal.aborted) throw new BosunError('cancelled', 'Native launch cancelled');
  return foregroundProcess({ command: plan.command, args: plan.args, cwd: plan.cwd, env, signal });
}
