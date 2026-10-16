import fs from 'node:fs';
import path from 'node:path';
import { BosunError } from '../core/errors.ts';
import {
  installationPlan,
  installationReceipt,
  installationSelection,
  type InstallationPlan,
  type InstallationReceipt,
} from '../core/domain/installation.ts';
import type { Env } from '../core/domain/inference.ts';
import type { RuntimePaths } from '../platform/paths.ts';
import { privateDirectory, readPrivateFile, writePrivateFile } from '../platform/private-file.ts';
import {
  readRuntimeManifest,
  writeRuntimeManifest,
  type RuntimeManifest,
} from '../platform/manifest.ts';
import { DaemonOwner } from '../platform/daemon-owner.ts';
import { version } from '../platform/assets.ts';
import { streamProcess } from '../platform/process.ts';
import {
  inspectBinary,
  previousBinary,
  installationHash,
  installationDirectory,
  planInstallationDirectories,
  copyInstallationBinary,
  syncInstallationDirectory,
  installationPlist,
  readInstallationFile,
} from '../platform/installation-files.ts';

export type InstallationOptions = {
  paths: RuntimePaths;
  env: Env;
  homebrewRoots?: readonly string[];
};
type Options = InstallationOptions;
const conflict = (message: string) => new BosunError('conflict', message);
const bundle = (paths: RuntimePaths, id: string) => path.join(paths.home, 'installation', id);
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
function retainedCapacity(paths: RuntimePaths) {
  const container = path.join(paths.home, 'installation');
  if (fs.existsSync(container)) {
    privateDirectory(container);
    if (fs.readdirSync(container).length >= 64)
      throw new BosunError('unavailable', 'Retained installation capacity held');
  }
}
export function installationPlanHash(value: Omit<InstallationPlan, 'planHash'> | InstallationPlan) {
  const { planHash: _hash, ...fields } = value as InstallationPlan;
  return installationHash(JSON.stringify(fields));
}
function userHome(env: Env) {
  const value = Object.getOwnPropertyDescriptor(env, 'HOME')?.value;
  if (typeof value !== 'string') throw new BosunError('invalid', 'User HOME required');
  installationDirectory(value);
  return value;
}
function pathsFor(options: Options, plan: InstallationPlan, verifySource = true) {
  if (
    plan.runtimeHome !== options.paths.home ||
    plan.userHome !== userHome(options.env) ||
    plan.version !== version ||
    plan.planHash !== installationPlanHash(plan) ||
    plan.id !==
      'in_' + installationHash(JSON.stringify([plan.installationId, plan.requestId])).slice(0, 32)
  )
    throw conflict('Installation plan scope changed');
  if (
    !same(installationDirectory(plan.userHome), plan.roots.user) ||
    !same(installationDirectory(plan.runtimeHome), plan.roots.runtime)
  )
    throw conflict('Installation root identity changed');
  const target =
    plan.distribution === 'managed'
      ? path.join(plan.userHome, '.local', 'bin', 'bosun')
      : plan.targetBinary;
  if (
    target !== plan.targetBinary ||
    plan.service.file !== path.join(bundle(options.paths, plan.id), 'daemon.plist') ||
    plan.service.target !==
      path.join(plan.userHome, 'Library', 'LaunchAgents', plan.service.label + '.plist') ||
    plan.service.label !== 'com.bosun.daemon.' + plan.id.slice(3) ||
    installationHash(plan.service.text) !== plan.service.hash
  )
    throw conflict('Installation paths changed');
  if (
    plan.distribution === 'homebrew' &&
    !(options.homebrewRoots ?? ['/opt/homebrew', '/usr/local']).some(
      (root) => plan.targetBinary === path.join(root, 'opt', 'bosun', 'bin', 'bosun'),
    )
  )
    throw new BosunError('unsupported', 'Select the Homebrew stable opt binary');
  if (
    verifySource &&
    plan.distribution === 'homebrew' &&
    !same(inspectBinary(plan.targetBinary), plan.binary)
  )
    throw conflict('Homebrew binary selection changed');
  const text = installationPlist({
    label: plan.service.label,
    binary: plan.targetBinary,
    runtimeHome: plan.runtimeHome,
    userHome: plan.userHome,
    id: plan.id,
    path: installationPath(plan.userHome),
    socket: options.paths.socket,
  });
  if (text !== plan.service.text)
    throw conflict('Daemon definition differs from the generated plan');
  if (
    !same(
      plan.directories.map((dir) => dir.path),
      planInstallationDirectories(plan.userHome, plan.distribution === 'managed').map(
        (dir) => dir.path,
      ),
    )
  )
    throw conflict('Installation directory scope changed');
}
const installationPath = (home: string) =>
  [
    path.join(home, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ].join(':');
export function planInstallation(
  options: Options,
  input: {
    requestId: string;
    binary: string;
    distribution?: 'managed' | 'homebrew';
    replaceExisting?: boolean;
  },
): InstallationPlan {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(input.requestId))
    throw new BosunError('invalid', 'Stable installation request required');
  privateDirectory(options.paths.home);
  const manifest = readRuntimeManifest(options.paths, { installationStatus: true });
  if (
    manifest.state !== 'ready' ||
    (manifest.installation && manifest.installation.state !== 'undone')
  )
    throw conflict('Inspect the existing installation before planning');
  const home = userHome(options.env),
    binary = inspectBinary(input.binary),
    distribution = input.distribution ?? 'managed';
  const id =
      'in_' +
      installationHash(JSON.stringify([manifest.installationId, input.requestId])).slice(0, 32),
    root = bundle(options.paths, id);
  if (fs.existsSync(root)) throw conflict('Installation request already has retained artifacts');
  retainedCapacity(options.paths);
  const targetBinary =
    distribution === 'managed' ? path.join(home, '.local', 'bin', 'bosun') : input.binary;
  const previous = distribution === 'managed' ? previousBinary(targetBinary) : null;
  if (previous && !input.replaceExisting)
    throw conflict('Existing binary requires an explicit reviewed replacement');
  if (previous && fs.lstatSync(options.paths.home).dev !== fs.lstatSync(targetBinary).dev)
    throw new BosunError('unsupported', 'Existing binary backup requires the same filesystem');
  const label = 'com.bosun.daemon.' + id.slice(3),
    serviceFile = path.join(root, 'daemon.plist'),
    serviceTarget = path.join(home, 'Library', 'LaunchAgents', label + '.plist');
  if (fs.existsSync(serviceTarget)) throw conflict('Service target already exists');
  const searchPath = installationPath(home);
  const text = installationPlist({
    label,
    binary: targetBinary,
    runtimeHome: options.paths.home,
    userHome: home,
    id,
    path: searchPath,
    socket: options.paths.socket,
  });
  const plan: InstallationPlan = {
    schemaVersion: 1,
    privacy: 'public',
    id,
    requestId: input.requestId,
    installationId: manifest.installationId,
    runtimeHome: options.paths.home,
    userHome: home,
    roots: {
      user: installationDirectory(home),
      runtime: installationDirectory(options.paths.home),
    },
    distribution,
    binary,
    targetBinary,
    previous,
    directories: planInstallationDirectories(home, distribution === 'managed'),
    manifestHash: installationHash(readPrivateFile(options.paths.manifest, 131072)),
    configHash: installationHash(readPrivateFile(options.paths.config, 131072)),
    version,
    createdAt: Date.now(),
    planHash: '0'.repeat(64),
    service: {
      label,
      file: serviceFile,
      target: serviceTarget,
      text,
      hash: installationHash(text),
    },
  };
  plan.planHash = installationPlanHash(plan);
  pathsFor(options, plan);
  return installationPlan(plan);
}
export function saveInstallationPlan(file: string, plan: InstallationPlan) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(installationPlan(plan), null, 2) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
export function readInstallationPlan(file: string) {
  const text = readInstallationFile(file, 262144);
  try {
    return installationPlan(JSON.parse(text));
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new BosunError('invalid', 'Invalid installation plan JSON');
    throw error;
  }
}
function sourceCurrent(plan: Pick<InstallationPlan, 'binary'>) {
  if (!same(inspectBinary(plan.binary.path), plan.binary))
    throw conflict('Installation executable changed');
}
export function installationProcessEnv(env: Env) {
  const selected: Record<string, string> = {};
  for (const key of [
    'HOME',
    'BOSUN_HOME',
    'BOSUN_SOCKET',
    'BOSUN_OLLAMA_APP',
    'BOSUN_TAILSCALE_APP',
    'STUB_OUT',
    'BOSUN_TEST_NET',
    'BOSUN_TEST_RUN_ROOT',
    'BOSUN_TEST_PRELOAD',
    'GIT_CONFIG_GLOBAL',
    'GIT_CONFIG_NOSYSTEM',
    'GIT_ALLOW_PROTOCOL',
    'CODEX_HOME',
    'BOSUN_CODEX_HOME',
    'ORCA_CODEX_HOME',
    'CLAUDE_CONFIG_DIR',
    'OPENCODE_CONFIG_DIR',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_STATE_HOME',
    'XDG_CACHE_HOME',
    'PATH',
    'LANG',
    'LC_ALL',
    'TMPDIR',
    'TMP',
    'TEMP',
  ]) {
    const value = Object.getOwnPropertyDescriptor(env, key)?.value;
    if (typeof value === 'string') selected[key] = value;
  }
  return selected;
}
export async function probeInstallationBinary(plan: Pick<InstallationPlan, 'binary' | 'runtimeHome' | 'version'>, env: Env, signal: AbortSignal) {
  sourceCurrent(plan);
  let output = '',
    code: number | null = null;
  const selected = installationProcessEnv(env);
  for await (const event of streamProcess({
    command: plan.binary.path,
    args: ['--version'],
    cwd: plan.runtimeHome,
    env: selected,
    signal,
    timeoutMs: 3000,
    maxOutputBytes: 4096,
    maxLineBytes: 1024,
  })) {
    if (event.t === 'line') output += event.text + '\n';
    else code = event.code;
  }
  if (code !== 0 || output.trim() !== plan.version)
    throw new BosunError('unverified', 'Reviewed bosun binary version differs');
  sourceCurrent(plan);
}
function record(options: Options, value: InstallationReceipt, manifest: RuntimeManifest) {
  installationReceipt(value);
  writeRuntimeManifest(options.paths, { ...manifest, installation: value });
}
function installedMatches(receipt: InstallationReceipt, ignoreExternalBinary = false) {
  if (
    !receipt.installed ||
    (!ignoreExternalBinary && !same(inspectBinary(receipt.targetBinary), receipt.installed))
  )
    throw conflict('Installed executable changed');
  if (installationHash(readPrivateFile(receipt.service.file, 16384)) !== receipt.service.hash)
    throw conflict('Installed daemon definition changed');
  for (const directory of receipt.directories) {
    const current = installationDirectory(directory.path);
    if (
      current.dev !== directory.dev ||
      current.ino !== directory.ino ||
      current.mode !== directory.mode
    )
      throw conflict('Installed directory changed');
  }
}
function receiptScope(options: Options, receipt: InstallationReceipt) {
  const plan = installationPlan(
    JSON.parse(readPrivateFile(path.join(bundle(options.paths, receipt.id), 'plan.json'), 262144)),
  );
  pathsFor(options, plan, false);
  for (const key of [
    'id',
    'requestId',
    'planHash',
    'installationId',
    'runtimeHome',
    'userHome',
    'roots',
    'distribution',
    'binary',
    'targetBinary',
    'previous',
  ] as const)
    if (!same(receipt[key], plan[key])) throw conflict('Installation receipt binding differs');
  if (
    !same(
      receipt.directories.map((dir) => dir.path),
      plan.directories.map((dir) => dir.path),
    ) ||
    !same(
      {
        label: receipt.service.label,
        file: receipt.service.file,
        target: receipt.service.target,
        hash: receipt.service.hash,
      },
      {
        label: plan.service.label,
        file: plan.service.file,
        target: plan.service.target,
        hash: plan.service.hash,
      },
    )
  )
    throw conflict('Owned installation paths differ');
  const allowed = [
    path.join(receipt.userHome, 'Library'),
    path.join(receipt.userHome, 'Library', 'LaunchAgents'),
  ];
  if (receipt.service.directories.some((dir) => !allowed.includes(dir.path)))
    throw conflict('Owned service directory differs');
}
export function validateInstallation(
  options: InstallationOptions,
  receipt: InstallationReceipt,
  ignoreExternalBinary = false,
) {
  receiptScope(options, receipt);
  installedMatches(receipt, ignoreExternalBinary);
}
export function installationStatus(options: Options) {
  const manifest = readRuntimeManifest(options.paths, { installationStatus: true }),
    receipt = manifest.installation;
  if (!receipt) return { state: 'absent', record: null };
  let matches = false;
  if (receipt.state === 'ready')
    try {
      receiptScope(options, receipt);
      installedMatches(receipt);
      matches = true;
    } catch {}
  return {
    state: receipt.state,
    record: receipt,
    matches,
    serviceQualification: 'unverified' as const,
  };
}
export async function applyInstallation(
  options: Options,
  input: unknown,
  hash: string,
  clientsStopped: boolean,
  signal: AbortSignal = new AbortController().signal,
) {
  const plan = installationPlan(input);
  pathsFor(options, plan);
  if (hash !== plan.planHash) throw conflict('Review the exact installation plan hash');
  if (!clientsStopped) throw conflict('Stop clients before applying installation');
  let manifest = readRuntimeManifest(options.paths, { installationStatus: true });
  if (manifest.installation) {
    const original = manifest.installation;
    if (original.id === plan.id && original.planHash === hash && original.state === 'ready') {
      receiptScope(options, original);
      installedMatches(original);
      return { record: original, duplicate: true };
    }
    if (original.state !== 'undone') throw conflict('Original installation requires inspection');
  }
  const owner = new DaemonOwner(options.paths.owner);
  let receipt: InstallationReceipt | undefined;
  let effect = false;
  try {
    owner.assert();
    retainedCapacity(options.paths);
    if (
      manifest.installationId !== plan.installationId ||
      installationHash(readPrivateFile(options.paths.manifest, 131072)) !== plan.manifestHash ||
      installationHash(readPrivateFile(options.paths.config, 131072)) !== plan.configHash ||
      !same(
        planInstallationDirectories(plan.userHome, plan.distribution === 'managed'),
        plan.directories,
      ) ||
      !same(
        plan.distribution === 'managed' ? previousBinary(plan.targetBinary) : null,
        plan.previous,
      ) ||
      Date.now() < plan.createdAt ||
      Date.now() - plan.createdAt > 300000
    )
      throw conflict('Installation plan is stale');
    await probeInstallationBinary(plan, options.env, signal);
    owner.assert();
    retainedCapacity(options.paths);
    if (
      installationHash(readPrivateFile(options.paths.manifest, 131072)) !== plan.manifestHash ||
      installationHash(readPrivateFile(options.paths.config, 131072)) !== plan.configHash ||
      !same(
        planInstallationDirectories(plan.userHome, plan.distribution === 'managed'),
        plan.directories,
      ) ||
      !same(
        plan.distribution === 'managed' ? previousBinary(plan.targetBinary) : null,
        plan.previous,
      )
    )
      throw conflict('Installation source changed during probe');
    receipt = {
      id: plan.id,
      requestId: plan.requestId,
      planHash: hash,
      installationId: plan.installationId,
      runtimeHome: plan.runtimeHome,
      userHome: plan.userHome,
      roots: plan.roots,
      distribution: plan.distribution,
      binary: plan.binary,
      installed: null,
      targetBinary: plan.targetBinary,
      previous: plan.previous,
      directories: [],
      state: 'applying',
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      service: {
        label: plan.service.label,
        file: plan.service.file,
        target: plan.service.target,
        hash: plan.service.hash,
        state: 'prepared',
        owned: false,
        published: null,
        directories: [],
        operations: [],
      },
    };
    effect = true;
    record(options, receipt, manifest);
    const container = path.dirname(bundle(options.paths, plan.id));
    if (!fs.existsSync(container)) fs.mkdirSync(container, { mode: 0o700 });
    privateDirectory(container);
    fs.mkdirSync(bundle(options.paths, plan.id), { mode: 0o700 });
    saveInstallationPlan(path.join(bundle(options.paths, plan.id), 'plan.json'), plan);
    writePrivateFile(plan.service.file, plan.service.text);
    for (const directory of plan.directories) {
      if (directory.before === null) fs.mkdirSync(directory.path, { mode: 0o755 });
      const current = installationDirectory(directory.path);
      receipt.directories.push({
        path: directory.path,
        dev: current.dev,
        ino: current.ino,
        mode: current.mode,
        created: directory.before === null,
      });
    }
    if (plan.distribution === 'managed') {
      const stage = path.join(path.dirname(plan.targetBinary), '.bosun-' + plan.id + '.stage');
      copyInstallationBinary(plan.binary, stage);
      sourceCurrent(plan);
      owner.assert();
      if (!same(previousBinary(plan.targetBinary), plan.previous))
        throw conflict('Binary destination changed');
      if (plan.previous) {
        fs.renameSync(
          plan.targetBinary,
          path.join(bundle(options.paths, plan.id), 'previous-binary'),
        );
        syncInstallationDirectory(bundle(options.paths, plan.id));
      }
      // Hard-link publication is atomic and refuses an unexpected existing leaf.
      fs.linkSync(stage, plan.targetBinary);
      fs.unlinkSync(stage);
      syncInstallationDirectory(path.dirname(plan.targetBinary));
    }
    receipt.installed = inspectBinary(plan.targetBinary);
    if (receipt.installed.hash !== plan.binary.hash) throw conflict('Installed binary differs');
    receipt.state = 'ready';
    receipt.version++;
    receipt.updatedAt = Date.now();
    owner.assert();
    record(options, receipt, manifest);
    return { record: receipt, duplicate: false };
  } catch (error) {
    if (effect && receipt) {
      receipt = {
        ...receipt,
        state: 'unknown',
        version: receipt.version + 1,
        updatedAt: Date.now(),
      };
      try {
        record(options, receipt, manifest);
      } catch {}
      throw new BosunError('unavailable', 'Installation outcome requires inspection', {
        details: { outcome: 'unknown' },
      });
    }
    throw error;
  } finally {
    owner.close();
  }
}
export function undoInstallation(
  options: Options,
  id: string,
  expectedVersion: number,
  hash: string,
  clientsStopped: boolean,
) {
  installationSelection(id, expectedVersion, hash);
  let manifest = readRuntimeManifest(options.paths, { installationStatus: true });
  const original = manifest.installation;
  if (
    !original ||
    original.id !== id ||
    original.version !== expectedVersion ||
    original.planHash !== hash ||
    original.state !== 'ready'
  )
    throw conflict('Review the current installation receipt');
  if (!clientsStopped || !['prepared', 'disabled'].includes(original.service.state))
    throw conflict('Stop clients and disable the owned daemon before undo');
  if (
    manifest.hostProfiles?.some(
      (profile) => profile.state !== 'undone' && profile.binary === original.targetBinary,
    )
  )
    throw conflict('Undo profiles using this executable first');
  const owner = new DaemonOwner(options.paths.owner);
  let receipt: InstallationReceipt = {
    ...original,
    directories: original.directories.map((dir) => ({ ...dir })),
    service: { ...original.service },
  };
  let effect = false;
  try {
    receiptScope(options, original);
    installedMatches(original, original.distribution === 'homebrew');
    if (original.service.published || fs.existsSync(original.service.target))
      throw conflict('Published service definition requires explicit disable');
    owner.assert();
    const root = bundle(options.paths, id),
      backup = path.join(root, 'previous-binary');
    if (original.distribution === 'managed' && fs.existsSync(path.join(root, 'removed-binary')))
      throw conflict('Retained binary archive already exists');
    if (original.previous) {
      const actual = previousBinary(backup);
      if (original.previous.kind === 'link') {
        if (
          actual?.kind !== 'link' ||
          actual.target !== original.previous.target ||
          actual.dev !== original.previous.dev ||
          actual.ino !== original.previous.ino
        )
          throw conflict('Original binary backup changed');
      } else if (
        actual?.kind !== 'file' ||
        actual.identity.hash !== original.previous.identity.hash ||
        actual.identity.dev !== original.previous.identity.dev ||
        actual.identity.ino !== original.previous.identity.ino ||
        actual.identity.mode !== original.previous.identity.mode
      )
        throw conflict('Original binary backup changed');
    }
    receipt.state = 'undoing';
    receipt.version++;
    receipt.updatedAt = Date.now();
    effect = true;
    record(options, receipt, manifest);
    if (original.distribution === 'managed') {
      fs.renameSync(original.targetBinary, path.join(root, 'removed-binary'));
      if (original.previous) {
        if (fs.existsSync(original.targetBinary)) throw conflict('Binary destination rebound');
        fs.renameSync(backup, original.targetBinary);
      }
      syncInstallationDirectory(path.dirname(original.targetBinary));
    }
    for (const directory of [...original.directories].reverse()) {
      if (!directory.created) continue;
      const current = installationDirectory(directory.path);
      if (
        current.dev !== directory.dev ||
        current.ino !== directory.ino ||
        current.mode !== directory.mode
      )
        throw conflict('Created directory rebound');
      if (!fs.readdirSync(directory.path).length) fs.rmdirSync(directory.path);
    }
    for (const directory of [...original.service.directories].reverse()) {
      if (!directory.created) continue;
      const current = installationDirectory(directory.path);
      if (
        current.dev !== directory.dev ||
        current.ino !== directory.ino ||
        current.mode !== directory.mode
      )
        throw conflict('Service directory changed');
      if (!fs.readdirSync(directory.path).length) fs.rmdirSync(directory.path);
    }
    receipt.state = 'undone';
    receipt.version++;
    receipt.updatedAt = Date.now();
    owner.assert();
    record(options, receipt, manifest);
    return { record: receipt, retainedData: true };
  } catch (error) {
    if (effect) {
      receipt = {
        ...receipt,
        state: 'unknown',
        version: receipt.version + 1,
        updatedAt: Date.now(),
      };
      try {
        record(options, receipt, manifest);
      } catch {}
      throw new BosunError('unavailable', 'Installation undo requires inspection', {
        details: { outcome: 'unknown' },
      });
    }
    throw error;
  } finally {
    owner.close();
  }
}
