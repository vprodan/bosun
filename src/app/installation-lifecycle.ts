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
import { loadRuntimeConfig } from '../platform/config.ts';
import { hostInstallationStatus, undoHostInstallation } from './host-install.ts';
import { DaemonOwner } from '../platform/daemon-owner.ts';
import type { HostInstallReceipt } from '../core/domain/host-install.ts';

export type LifecycleQuestion = { kind: 'setup' | 'replace' | 'install' | 'start' | 'reinstall' | 'stop' | 'uninstall' | 'reconcile' | 'permissions' | 'tools' | 'profiles'; message: string; initialValue: boolean };
export type LifecycleOptions = InstallationOptions & {
  confirm(question: LifecycleQuestion): Promise<boolean>;
  write(text: string): void;
  control?: LaunchdControl;
  prepareReplacement?: () => Promise<void>;
  signal?: AbortSignal;
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
function unchanged(options: LifecycleOptions, value: InstallationReceipt) {
  if (options.signal?.aborted) throw new BosunError('cancelled', 'Lifecycle review cancelled; retain existing data and receipts.');
  if (JSON.stringify(current(options)) !== JSON.stringify(value))
    throw new BosunError('conflict', 'Reviewed installation receipt changed; no further retirement was authorized.');
  return original(options, value);
}
async function originalOutput(options: LifecycleOptions, value: InstallationReceipt, args: string[]): Promise<string> {
  const selected = unchanged(options, value);
  let code: number | null = null, output = '';
  for await (const event of streamProcess({ command: selected.binary.path, args, cwd: options.paths.home, env: installationProcessEnv(options.env), signal: options.signal ?? new AbortController().signal, timeoutMs: 60000, maxOutputBytes: 262144 })) {
    if (event.t === 'line') output += event.text + '\n';
    if (event.t === 'exit') code = event.code;
  }
  if (options.signal?.aborted) throw new BosunError('unverified', 'Original command interrupted; retain receipts and inspect its outcome before any further operation.');
  if (code !== 0) throw new BosunError('unverified', 'Original executable could not finish recovery. Retain receipts; do not replay an unknown operation.');
  return output;
}
async function originalCommand(options: LifecycleOptions, value: InstallationReceipt, operation: 'status' | 'reconcile' | 'disable' | 'undo'): Promise<void> {
  const args = operation === 'status' ? ['install', 'status'] : ['install', operation, value.id, '--version', String(value.version), '--hash', value.planHash,
    ...(operation === 'disable' ? ['--request-id', 'lifecycle_' + crypto.randomUUID(), '--clients-stopped'] : operation === 'undo' ? ['--clients-stopped'] : [])];
  const output = await originalOutput(options, value, args);
  if (operation === 'status') {
    const status = JSON.parse(output) as { matches?: unknown; record?: { id?: unknown; version?: unknown } };
    if (status.matches !== true || status.record?.id !== value.id || status.record.version !== value.version)
      throw new BosunError('conflict', 'Original receipt/files changed; no mutation was authorized.');
  }
}

async function inspectProfile(options: LifecycleOptions, value: InstallationReceipt, profile: HostInstallReceipt, sameVersion: boolean): Promise<void> {
  if (profile.state !== 'ready' || profile.binary !== value.targetBinary)
    throw new BosunError('unverified', 'A native profile is uncertain or externally owned; retain its original receipt.');
  const status = sameVersion
    ? hostInstallationStatus({ paths: options.paths, config: loadRuntimeConfig(options.paths, options.env), binary: value.targetBinary }, profile.id)
    : JSON.parse(await originalOutput(options, value, ['host', 'status', profile.id])) as {
      record?: HostInstallReceipt; configMatches?: boolean; tree?: { matches?: boolean; complete?: boolean }; stage?: { exists?: boolean };
      projectSkills?: { matches?: boolean };
    };
  if (!('record' in status) || JSON.stringify(status.record) !== JSON.stringify(profile) || status.configMatches !== true
    || status.tree?.matches !== true || status.tree.complete !== true || status.stage?.exists !== false
    || status.projectSkills && status.projectSkills.matches !== true
    || fs.existsSync(path.join(options.paths.home, 'host-profiles', profile.id + '.retired')))
    throw new BosunError('conflict', 'Native profile files, configuration or receipt changed; no retirement was authorized.');
}

async function retireProfiles(options: LifecycleOptions, value: InstallationReceipt, sameVersion: boolean, confirm: LifecycleOptions['confirm']): Promise<boolean> {
  // Release the owner probe before prompts or delegated transactions; each mutator reacquires it.
  const owner = new DaemonOwner(options.paths.owner);
  owner.close();
  let snapshot = readRuntimeManifest(options.paths, { installationStatus: true });
  const profiles = (snapshot.hostProfiles ?? []).filter(profile => profile.state !== 'undone');
  if (!profiles.length) return true;
  const recheck = () => {
    unchanged(options, value);
    if (sameVersion && installationStatus(options).matches !== true)
      throw new BosunError('conflict', 'Owned installation files changed during profile review.');
    if (JSON.stringify(readRuntimeManifest(options.paths, { installationStatus: true })) !== JSON.stringify(snapshot))
      throw new BosunError('conflict', 'Reviewed native profile set changed; no further retirement was authorized.');
  };
  for (const profile of profiles) {
    await inspectProfile(options, value, profile, sameVersion);
    recheck();
    options.write(`Owned native profile: ${profile.hostId}, ${profile.id}, receipt version ${profile.version}, native version ${profile.nativeVersion}\nRetained archive: ${path.join(options.paths.home, 'host-profiles', profile.id + '.retired')}\n`);
  }
  if (!await confirm({ kind: 'profiles', message: 'Retire these owned native profiles before removing/replacing their executable? Profile archives, historical receipts, memory and configuration are retained. Any already approved service stop remains in effect if you decline.', initialValue: false })) {
    options.write('Profile retirement declined. Installation and profiles retained; any already approved service stop remains in effect.\n');
    return false;
  }
  recheck();
  if (!sameVersion) {
    await originalCommand(options, value, 'status');
    recheck();
  }
  for (const profile of profiles) {
    await inspectProfile(options, value, profile, sameVersion);
    recheck();
  }
  for (const profile of profiles) {
    recheck();
    if (sameVersion) undoHostInstallation({ paths: options.paths, config: loadRuntimeConfig(options.paths, options.env), binary: value.targetBinary }, profile.id, profile.version);
    else await originalOutput(options, value, ['host', 'undo', profile.id, '--version', String(profile.version)]);
    unchanged(options, value);
    const next = readRuntimeManifest(options.paths, { installationStatus: true });
    const retired = next.hostProfiles?.find(item => item.id === profile.id);
    if (!retired || retired.state !== 'undone' || retired.version <= profile.version
      || JSON.stringify({ ...next, hostProfiles: (next.hostProfiles ?? []).filter(item => item.id !== profile.id) })
        !== JSON.stringify({ ...snapshot, hostProfiles: (snapshot.hostProfiles ?? []).filter(item => item.id !== profile.id) }))
      throw new BosunError('unverified', 'Profile retirement outcome changed; retain original receipts and do not replay.');
    snapshot = next;
  }
  return true;
}

/** Uses the executable which owns the receipt, including across release changes. */
export async function retireInstallation(options: LifecycleOptions, purpose: 'reinstall' | 'uninstall'): Promise<boolean> {
  if (options.env.BOSUN_CALLER === 'model') throw new BosunError('private_input', 'Owner terminal required');
  if (options.signal?.aborted) throw new BosunError('cancelled', 'Lifecycle review cancelled; retain existing data and receipts.');
  const confirm: LifecycleOptions['confirm'] = async question => {
    const accepted = await options.confirm(question);
    if (options.signal?.aborted) throw new BosunError('cancelled', 'Lifecycle review cancelled; any already approved service stop or profile retirement remains in effect.');
    return accepted;
  };
  let value = current(options);
  let selected = original(options, value);
  options.write(`Current installation: ${value.targetBinary}\nData/configuration retained: ${options.paths.home}\nPrevious executable backup: ${value.previous ? 'will be restored; it is not deleted' : 'none'}\n`);
  if (purpose === 'reinstall') options.write('Reinstall first retires the old owned installation, then asks to install the selected replacement. Cancelling after retirement leaves the old executable removed (or its reviewed previous executable restored); data and recovery evidence remain.\n');
  if (!await confirm({ kind: purpose, message: `${purpose === 'uninstall' ? 'Remove' : 'Reinstall'} the owned Bosun executable/service, retaining all memory, configuration, models and receipts? Close native/Bosun clients before continuing.`, initialValue: false })) return false;
  unchanged(options, value);
  if (selected.sameVersion) {
    if (installationStatus(options).matches !== true) throw new BosunError('conflict', 'Owned installation files or receipt changed');
  } else await originalCommand(options, value, 'status');
  if (uncertain(value)) {
    if (!await confirm({ kind: 'reconcile', message: 'Inspect and reconcile the ORIGINAL uncertain service outcome without replaying start/stop?', initialValue: false })) return false;
    unchanged(options, value);
    if (selected.sameVersion) await reconcileInstallationService(options, value.id, value.version, value.planHash, options.signal);
    else await originalCommand(options, value, 'reconcile');
    const reconciled = current(options);
    if (reconciled.id !== value.id || reconciled.planHash !== value.planHash || reconciled.targetBinary !== value.targetBinary
      || JSON.stringify(reconciled.installed) !== JSON.stringify(value.installed))
      throw new BosunError('conflict', 'Original installation binding changed during reconciliation.');
    value = reconciled; selected = original(options, value);
    if (uncertain(value)) throw new BosunError('unverified', 'Original service remains uncertain; no reinstall or uninstall was performed.');
  }
  await options.prepareReplacement?.();
  unchanged(options, value);
  if (value.service.state === 'enabled') {
    if (!await confirm({ kind: 'stop', message: 'Stop the receipt-owned background service before replacing/removing Bosun?', initialValue: false })) return false;
    unchanged(options, value);
    if (selected.sameVersion) await controlInstallationService(options, { id: value.id, expectedVersion: value.version, hash: value.planHash, operation: 'disable', requestId: 'lifecycle_' + crypto.randomUUID(), clientsStopped: true }, options.signal);
    else await originalCommand(options, value, 'disable');
    const stopped = current(options);
    if (stopped.id !== value.id || stopped.planHash !== value.planHash || stopped.targetBinary !== value.targetBinary
      || JSON.stringify(stopped.installed) !== JSON.stringify(value.installed))
      throw new BosunError('conflict', 'Original installation binding changed during service shutdown.');
    value = stopped;
  }
  options.write('Any separately started foreground/nohup daemon must be stopped by its owner. Active native ownership will hold this operation; it is never killed by a guessed PID.\n');
  unchanged(options, value);
  if (!await retireProfiles(options, value, selected.sameVersion, confirm)) return false;
  // Profile retirement changes the manifest, never the installation receipt binding.
  unchanged(options, value);
  value = current(options);
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
