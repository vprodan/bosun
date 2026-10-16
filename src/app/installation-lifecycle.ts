import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BosunError } from '../core/errors.ts';
import type { InstallationReceipt } from '../core/domain/installation.ts';
import type { InstallationOptions } from './installation.ts';
import { installationStatus, undoInstallation, installationProcessEnv } from './installation.ts';
import { controlInstallationService, reconcileInstallationService } from './installation-service.ts';
import type { LaunchdControl } from '../adapters/services/launchd.ts';
import { copyInstallationBinary, inspectBinary, installationDirectory } from '../platform/installation-files.ts';
import { readPrivateFile, writePrivateFile } from '../platform/private-file.ts';
import { readRuntimeManifest } from '../platform/manifest.ts';
import { version } from '../platform/assets.ts';
import { streamProcess } from '../platform/process.ts';

export type LifecycleQuestion = { kind: 'setup' | 'replace' | 'install' | 'start' | 'reinstall' | 'stop' | 'uninstall' | 'reconcile' | 'permissions' | 'tools'; message: string; initialValue: boolean };
export type LifecycleOptions = InstallationOptions & {
  confirm(question: LifecycleQuestion): Promise<boolean>;
  write(text: string): void;
  control?: LaunchdControl;
  prepareReplacement?: () => Promise<void>;
};
const uncertain = (value: InstallationReceipt) => value.service.operations.some(op => op.state === 'unknown' || op.state === 'pending') || ['unknown', 'enabling', 'disabling'].includes(value.service.state);
function current(options: InstallationOptions): InstallationReceipt {
  const value = readRuntimeManifest(options.paths, { installationStatus: true }).installation;
  if (!value || value.state !== 'ready') throw new BosunError('unverified', 'Installation is not ready; retain its receipts and inspect recovery.');
  return value;
}
function original(options: InstallationOptions, value: InstallationReceipt) {
  const home = options.env.HOME;
  if (!home || value.userHome !== home || value.runtimeHome !== options.paths.home || value.distribution !== 'managed' || value.targetBinary !== path.join(home, '.local', 'bin', 'bosun'))
    throw new BosunError('unverified', 'This installation requires its external package manager or original owner.');
  installationDirectory(home); installationDirectory(path.dirname(value.targetBinary));
  const binary = inspectBinary(value.targetBinary);
  if (!value.installed || binary.hash !== value.installed.hash || binary.dev !== value.installed.dev || binary.ino !== value.installed.ino)
    throw new BosunError('conflict', 'Installed executable changed; no recovery command was run.');
  const plan = JSON.parse(readPrivateFile(path.join(options.paths.home, 'installation', value.id, 'plan.json'), 262144)) as { version?: unknown };
  return { binary, sameVersion: plan.version === version };
}
async function originalCommand(options: LifecycleOptions, value: InstallationReceipt, operation: 'status' | 'reconcile' | 'disable' | 'undo'): Promise<void> {
  const selected = original(options, value);
  const args = operation === 'status' ? ['install', 'status'] : ['install', operation, value.id, '--version', String(value.version), '--hash', value.planHash,
    ...(operation === 'disable' ? ['--request-id', 'lifecycle_' + crypto.randomUUID(), '--clients-stopped'] : operation === 'undo' ? ['--clients-stopped'] : [])];
  let code: number | null = null, output = '';
  for await (const event of streamProcess({ command: selected.binary.path, args, cwd: options.paths.home, env: installationProcessEnv(options.env), signal: new AbortController().signal, timeoutMs: 60000, maxOutputBytes: 262144 })) {
    if (event.t === 'line') output += event.text + '\n';
    if (event.t === 'exit') code = event.code;
  }
  if (code !== 0) throw new BosunError('unverified', 'Original executable could not finish recovery. Retain receipts; do not replay an unknown operation.');
  if (operation === 'status') {
    const status = JSON.parse(output) as { matches?: unknown; record?: { id?: unknown; version?: unknown } };
    if (status.matches !== true || status.record?.id !== value.id || status.record.version !== value.version)
      throw new BosunError('conflict', 'Original receipt/files changed; no mutation was authorized.');
  }
}

/** Uses the executable which owns the receipt, including across release changes. */
export async function retireInstallation(options: LifecycleOptions, purpose: 'reinstall' | 'uninstall'): Promise<boolean> {
  if (options.env.BOSUN_CALLER === 'model') throw new BosunError('private_input', 'Owner terminal required');
  let value = current(options);
  let selected = original(options, value);
  options.write(`Current installation: ${value.targetBinary}\nData/configuration retained: ${options.paths.home}\nPrevious executable backup: ${value.previous ? 'will be restored; it is not deleted' : 'none'}\n`);
  if (purpose === 'reinstall') options.write('Reinstall first retires the old owned installation, then asks to install the selected replacement. Cancelling after retirement leaves the old executable removed (or its reviewed previous executable restored); data and recovery evidence remain.\n');
  if (!await options.confirm({ kind: purpose, message: `${purpose === 'uninstall' ? 'Remove' : 'Reinstall'} the owned Bosun executable/service, retaining all memory, configuration, models and receipts? Close native/Bosun clients before continuing.`, initialValue: false })) return false;
  if (selected.sameVersion) {
    if (installationStatus(options).matches !== true) throw new BosunError('conflict', 'Owned installation files or receipt changed');
  } else await originalCommand(options, value, 'status');
  if (uncertain(value)) {
    if (!await options.confirm({ kind: 'reconcile', message: 'Inspect and reconcile the ORIGINAL uncertain service outcome without replaying start/stop?', initialValue: false })) return false;
    if (selected.sameVersion) await reconcileInstallationService(options, value.id, value.version, value.planHash);
    else await originalCommand(options, value, 'reconcile');
    value = current(options); selected = original(options, value);
    if (uncertain(value)) throw new BosunError('unverified', 'Original service remains uncertain; no reinstall or uninstall was performed.');
  }
  await options.prepareReplacement?.();
  if (value.service.state === 'enabled') {
    if (!await options.confirm({ kind: 'stop', message: 'Stop the receipt-owned background service before replacing/removing Bosun?', initialValue: false })) return false;
    if (selected.sameVersion) await controlInstallationService(options, { id: value.id, expectedVersion: value.version, hash: value.planHash, operation: 'disable', requestId: 'lifecycle_' + crypto.randomUUID(), clientsStopped: true });
    else await originalCommand(options, value, 'disable');
    value = current(options);
  }
  options.write('Any separately started foreground/nohup daemon must be stopped by its owner. Active native ownership will hold this operation; it is never killed by a guessed PID.\n');
  if (selected.sameVersion) undoInstallation(options, value.id, value.version, value.planHash, true);
  else await originalCommand(options, value, 'undo');
  const result = readRuntimeManifest(options.paths, { installationStatus: true }).installation;
  if (result?.id !== value.id || result.state !== 'undone') throw new BosunError('unverified', 'Removal outcome is unconfirmed; retain the original receipt.');
  options.write(`Owned installation removed. Data/configuration retained at ${options.paths.home}.${value.previous ? ' The reviewed previous executable was restored.' : ''}\n`);
  return true;
}

/** Cache the selected bytes before undo can archive a currently executing binary. */
export function stageInstallerBinary(options: InstallationOptions, binary: string): string {
  const identity = inspectBinary(binary);
  const root = path.join(options.paths.artifacts, 'installer-' + crypto.randomUUID());
  fs.mkdirSync(root, { mode: 0o700 });
  const target = path.join(root, 'bosun');
  copyInstallationBinary(identity, target);
  if (inspectBinary(target).hash !== identity.hash || inspectBinary(binary).hash !== identity.hash) throw new BosunError('conflict', 'Selected installer changed while staging');
  writePrivateFile(path.join(root, 'selection.json'), JSON.stringify({ source: identity, staged: target }));
  return target;
}
