import { BosunError } from '../../core/errors.ts';
import type { Env } from '../../core/domain/inference.ts';
import { inspectBinary } from '../../platform/installation-files.ts';
import { streamProcess } from '../../platform/process.ts';

export type ServiceObservation = {
  present: boolean;
  pid: number | null;
  exitStatus: number | null;
};
export type LaunchdControl = {
  domain: string;
  observe(label: string, signal: AbortSignal): Promise<ServiceObservation>;
  bootstrap(file: string, signal: AbortSignal): Promise<void>;
  bootout(label: string, signal: AbortSignal): Promise<void>;
};
const unavailable = () => new BosunError('unverified', 'Native service observation unavailable');
const label = (value: string) => {
  if (value !== 'com.bosun.router' && !/^com\.bosun\.daemon\.[a-f0-9]{32}$/.test(value))
    throw new BosunError('invalid', 'Invalid daemon service label');
};
// The documented legacy three-column list is bounded and treated as unverified on any format drift.
export function launchdList(text: string, selected: string): ServiceObservation {
  label(selected);
  const lines = text.trimEnd().split('\n');
  if (lines.length > 4097 || !/^PID\s+Status\s+Label$/.test(lines.shift() ?? ''))
    throw unavailable();
  const seen = new Set<string>();
  let result: ServiceObservation = { present: false, pid: null, exitStatus: null };
  for (const line of lines) {
    const row = /^(-|[1-9][0-9]*)\s+(-?[0-9]+)\s+([^\s\x00-\x1f\x7f]{1,512})$/u.exec(line);
    if (!row || seen.has(row[3])) throw unavailable();
    seen.add(row[3]);
    const pid = row[1] === '-' ? null : Number(row[1]),
      status = Number(row[2]);
    if (
      (pid !== null && (!Number.isSafeInteger(pid) || pid > 2147483647)) ||
      !Number.isSafeInteger(status) ||
      Math.abs(status) > 2147483647
    )
      throw unavailable();
    if (row[3] === selected) result = { present: true, pid, exitStatus: status };
  }
  return result;
}
// Command/platform/uid are trusted composition inputs for fixtures, never configuration or RPC capabilities.
export function createLaunchdControl(options: {
  env: Env;
  cwd: string;
  command?: string;
  platform?: NodeJS.Platform;
  uid?: number;
}): LaunchdControl {
  const uid = options.uid ?? process.getuid?.();
  if (
    (options.platform ?? process.platform) !== 'darwin' ||
    !Number.isSafeInteger(uid) ||
    !uid ||
    uid < 1
  )
    throw new BosunError('unsupported', 'A macOS GUI user service is required');
  const command = options.command ?? '/bin/launchctl',
    binary = inspectBinary(command),
    domain = `gui/${uid}`;
  const current = () => {
    if (JSON.stringify(inspectBinary(command)) !== JSON.stringify(binary))
      throw new BosunError('conflict', 'Service executable changed');
  };
  async function run(args: string[], signal: AbortSignal, mutation = false) {
    current();
    let text = '',
      code: number | null = null;
    try {
      for await (const event of streamProcess({
        command: binary.path,
        args,
        cwd: options.cwd,
        env: options.env,
        signal,
        timeoutMs: 5000,
        maxOutputBytes: 262144,
        maxLineBytes: 2048,
      })) {
        if (event.t === 'line') text += event.text + '\n';
        else code = event.code;
      }
      current();
      if (code !== 0) throw unavailable();
      return text;
    } catch (error) {
      if (mutation)
        throw new BosunError('unavailable', 'Native service effect requires reconciliation', {
          details: { outcome: 'unknown' },
        });
      throw error;
    }
  }
  async function context(signal: AbortSignal) {
    const actual = (await run(['manageruid'], signal)).trim(),
      name = (await run(['managername'], signal)).trim();
    if (actual !== String(uid) || name !== 'Aqua')
      throw new BosunError('unverified', 'Use this user’s GUI launchd context');
  }
  return {
    domain,
    async observe(selected, signal) {
      label(selected);
      await context(signal);
      return launchdList(await run(['list'], signal), selected);
    },
    async bootstrap(file, signal) {
      if (!file.startsWith('/') || /[\x00-\x1f\x7f]/.test(file))
        throw new BosunError('invalid', 'Invalid daemon definition path');
      await context(signal);
      await run(['bootstrap', domain, file], signal, true);
    },
    async bootout(selected, signal) {
      label(selected);
      await context(signal);
      await run(['bootout', `${domain}/${selected}`], signal, true);
    },
  };
}
