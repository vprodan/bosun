import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BosunError } from '../core/errors.ts';
import { HOSTS, type HostId, type RuntimeConfig } from '../core/domain/config.ts';
import { data, jobId } from '../core/domain/job.ts';
import type { HostAdapter, HostBundle } from '../core/ports/host.ts';
import type { HostInstallReceipt } from '../core/domain/host-install.ts';
import { requirePublicInput } from '../core/policy.ts';
import { screenPublicText } from '../core/secret-screen.ts';
import { hostPlan, type HostInstallPlan } from '../contracts/host-install.ts';
import {
  readRuntimeManifest,
  writeRuntimeManifest,
  type RuntimeManifest,
} from '../platform/manifest.ts';
import { privateDirectory, readPrivateFile } from '../platform/private-file.ts';
import { configRevision } from '../platform/config.ts';
import { asset, roleDefinitions, skillAssets } from '../platform/assets.ts';
import { hostHash, HOST_FILES_LIMITS } from '../platform/host-files.ts';
import {
  hostFileReceipts,
  hostTree,
  makeHostDirectory,
  writeHostTree,
  syncHostDirectory,
} from '../platform/host-tree.ts';
import { DaemonOwner } from '../platform/daemon-owner.ts';
import {
  planWorkspaceSkills,
  installWorkspaceSkills,
  inspectWorkspaceSkills,
  undoWorkspaceSkills,
} from '../platform/host-skills.ts';
import type { RuntimePaths } from '../platform/paths.ts';
import { executable } from '../platform/process.ts';
import type { Env } from '../core/domain/inference.ts';

type Options = { paths: RuntimePaths; config: RuntimeConfig; binary: string; workspace?: string };
async function adapter(host: HostId, config: RuntimeConfig): Promise<HostAdapter> {
  if (!config.hosts[host].enabled) throw new BosunError('unsupported', 'Host disabled');
  // Selected-host registry: unselected native configuration/auth modules must stay unevaluated.
  if (host === 'omp')
    return (await import('../adapters/hosts/omp/host.ts')).createOmpHost(config.hosts.omp.command);
  if (host === 'opencode')
    return (await import('../adapters/hosts/opencode/host.ts')).createOpenCodeHost(
      config.hosts.opencode.command,
    );
  if (host === 'codex')
    return (await import('../adapters/hosts/codex/host.ts')).createCodexHost(
      config.hosts.codex.command,
    );
  return (await import('../adapters/hosts/claude/host.ts')).createClaudeHost(
    config.hosts.claude.command,
  );
}
function bundle(options: Options, host: HostId, native: HostAdapter): HostBundle {
  const substitutions: Record<string, string> = {
    HOST: host,
    RUN_HOW: 'explicit native host/model selection through the daemon',
    CROSS: 'Native harness identity does not establish a different effective model vendor.',
    SANDBOX:
      ' Native host policy is a tool boundary; managed read-only and automatic handoff require separate qualification.',
  };
  for (const role of roleDefinitions())
    substitutions[role.id.toUpperCase()] = native.roleRef(role.id);
  const policy = asset('policy.md').replace(/\{\{([A-Z_]+)\}\}/g, (_match, name) => {
    if (!Object.hasOwn(substitutions, name))
      throw new BosunError('invalid', 'Unknown policy binding');
    return substitutions[name];
  });
  return {
    roles: roleDefinitions().map((role) => ({ ...role, ...options.config.roles[role.id]?.[host] })),
    skills: Object.fromEntries(
      Object.entries(skillAssets()).map(([file, text]) => [file.split('/')[1], text]),
    ),
    policy,
    mcp: {
      command: options.binary,
      args: ['mcp'],
      env: { BOSUN_HOME: options.paths.home, BOSUN_CALLER: 'model' },
    },
    hook: {
      command: options.binary,
      args: ['hook'],
      env: { BOSUN_HOME: options.paths.home },
      timeoutS: 1,
    },
  };
}
const profileRoot = (options: Options, id: string) =>
  path.join(options.paths.home, 'host-profiles', id);
const stageRoot = (options: Options, id: string) => profileRoot(options, id) + '.stage';
const archiveRoot = (options: Options, id: string) => profileRoot(options, id) + '.retired';
function manifest(options: Options) {
  privateDirectory(options.paths.home);
  const value = readRuntimeManifest(options.paths);
  if (value.state !== 'ready') throw new BosunError('unavailable', 'Prepared runtime required');
  return value;
}
export function hostPlanHash(input: Omit<HostInstallPlan, 'planHash'> | HostInstallPlan) {
  const { planHash: _hash, ...value } = input as HostInstallPlan;
  return hostHash(JSON.stringify(value));
}
function original(value: RuntimeManifest, requestId: string) {
  return value.hostProfiles?.find((item) => item.requestId === requestId);
}
function assertBinary(binary: string) {
  if (!path.isAbsolute(binary) || path.resolve(binary) !== binary || /[\x00-\x1f\x7f]/.test(binary))
    throw new BosunError('invalid', 'Select the bosun executable');
  screenPublicText(binary);
  fs.accessSync(binary, fs.constants.X_OK);
}
export async function planHostInstallation(
  options: Options,
  input: { hostId: HostId; nativeVersion: string; requestId: string },
): Promise<HostInstallPlan> {
  const value = manifest(options);
  jobId(input.requestId);
  screenPublicText(input.requestId);
  assertBinary(options.binary);
  if (!HOSTS.includes(input.hostId)) throw new BosunError('invalid', 'Invalid host');
  const prior = original(value, input.requestId);
  if (prior)
    throw new BosunError(
      'conflict',
      'Host request already has an installation receipt; inspect host status',
    );
  const native = await adapter(input.hostId, options.config);
  const id = `hp_${crypto.randomUUID().replaceAll('-', '')}`;
  const settings = { root: profileRoot(options, id), nativeVersion: input.nativeVersion };
  const inputBundle = bundle(options, input.hostId, native);
  const changes = await native.plan(inputBundle, settings);
  const launch = native.launch(inputBundle, settings);
  if (input.hostId === 'codex' && !options.workspace)
    throw new BosunError('invalid', 'Select the Codex skill workspace');
  const skillWorkspace =
    input.hostId === 'codex'
      ? planWorkspaceSkills(options.workspace!, settings.root, inputBundle.skills)
      : undefined;
  hostFileReceipts(changes);
  const fields = {
    schemaVersion: 1 as const,
    privacy: 'public' as const,
    id,
    requestId: input.requestId,
    hostId: input.hostId,
    nativeVersion: input.nativeVersion,
    runtimeHome: options.paths.home,
    installationId: value.installationId,
    manifestHash: hostHash(
      readPrivateFile(options.paths.manifest, HOST_FILES_LIMITS.manifestBytes),
    ),
    configHash: configRevision(options.config),
    binary: options.binary,
    ...(skillWorkspace ? { skillWorkspace } : {}),
    changes: changes as HostInstallPlan['changes'],
    launch: {
      args: [...launch.args],
      env: { ...launch.env },
    },
  };
  return hostPlan({ ...fields, planHash: hostPlanHash(fields) });
}
function receiptPlan(plan: HostInstallPlan, at: number): HostInstallReceipt {
  return {
    id: plan.id,
    requestId: plan.requestId,
    hostId: plan.hostId,
    nativeVersion: plan.nativeVersion,
    planHash: plan.planHash,
    configHash: plan.configHash,
    binary: plan.binary,
    ...(plan.skillWorkspace ? { skillWorkspace: plan.skillWorkspace } : {}),
    state: 'applying',
    version: 1,
    createdAt: at,
    updatedAt: at,
    files: hostFileReceipts(plan.changes),
    launch: plan.launch,
  };
}
function save(
  options: Options,
  value: RuntimeManifest,
  record: HostInstallReceipt,
  assertOwner: () => void,
) {
  const profiles = (value.hostProfiles ?? []).filter((item) => item.id !== record.id);
  if (profiles.length >= HOST_FILES_LIMITS.profiles)
    throw new BosunError('unavailable', 'Host profile capacity reached');
  const next = { ...value, hostProfiles: [...profiles, record] };
  if (Buffer.byteLength(JSON.stringify(next)) > HOST_FILES_LIMITS.manifestBytes)
    throw new BosunError('unavailable', 'Installation manifest capacity reached');
  assertOwner();
  writeRuntimeManifest(options.paths, next);
  assertOwner();
  return next;
}
function report(options: Options, record: HostInstallReceipt) {
  const root = profileRoot(options, record.id);
  const state = hostTree(
    record.state === 'undone' ? archiveRoot(options, record.id) : root,
    record.files,
  );
  const stage = hostTree(stageRoot(options, record.id), record.files);
  return {
    record,
    root,
    tree: state,
    stage,
    ...(record.skillWorkspace
      ? { projectSkills: inspectWorkspaceSkills(record.skillWorkspace, root) }
      : {}),
    configMatches: record.configHash === configRevision(options.config),
    activation: 'manual_review_required' as const,
    nativeQualification: 'unverified' as const,
    outcome:
      record.state === 'applying' || record.state === 'undoing' || record.state === 'unknown'
        ? ('unknown' as const)
        : record.state,
  };
}
export async function applyHostInstallation(
  options: Options,
  input: unknown,
  expectedHash: string,
) {
  requirePublicInput(input as { privacy?: unknown });
  const requestId = jobId(data(input, 'requestId'));
  screenPublicText(requestId);
  const before = manifest(options);
  const duplicate = original(before, requestId);
  if (duplicate) return { ...report(options, duplicate), duplicate: true };
  const plan = hostPlan(input);
  if (hostPlanHash(plan) !== plan.planHash || expectedHash !== plan.planHash)
    throw new BosunError('conflict', 'Reviewed host plan hash changed');
  if (
    plan.runtimeHome !== options.paths.home ||
    plan.installationId !== before.installationId ||
    plan.binary !== options.binary ||
    plan.configHash !== configRevision(options.config) ||
    plan.manifestHash !==
      hostHash(readPrivateFile(options.paths.manifest, HOST_FILES_LIMITS.manifestBytes))
  )
    throw new BosunError('conflict', 'Host installation source changed');
  assertBinary(plan.binary);
  const native = await adapter(plan.hostId, options.config);
  const settings = { root: profileRoot(options, plan.id), nativeVersion: plan.nativeVersion };
  const inputBundle = bundle(options, plan.hostId, native);
  if (
    (plan.hostId === 'codex' && !plan.skillWorkspace) ||
    (plan.hostId !== 'codex' && plan.skillWorkspace)
  )
    throw new BosunError('invalid', 'Invalid host skill workspace');
  if (
    plan.skillWorkspace &&
    JSON.stringify(
      planWorkspaceSkills(plan.skillWorkspace.root, settings.root, inputBundle.skills),
    ) !== JSON.stringify(plan.skillWorkspace)
  )
    throw new BosunError('conflict', 'Skill workspace changed');
  if (
    JSON.stringify(await native.plan(inputBundle, settings)) !== JSON.stringify(plan.changes) ||
    JSON.stringify(native.launch(inputBundle, settings)) !== JSON.stringify(plan.launch)
  )
    throw new BosunError('conflict', 'Host plan differs from shipped assets');
  const owner = new DaemonOwner(options.paths.owner);
  let current = before;
  let record = receiptPlan(plan, Date.now());
  let intent = false;
  try {
    const latest = manifest(options);
    if (
      hostHash(readPrivateFile(options.paths.manifest, HOST_FILES_LIMITS.manifestBytes)) !==
      plan.manifestHash
    )
      throw new BosunError('conflict', 'Installation manifest changed');
    current = latest;
    for (const root of [
      profileRoot(options, plan.id),
      stageRoot(options, plan.id),
      archiveRoot(options, plan.id),
    ]) {
      try {
        fs.lstatSync(root);
        throw new BosunError('conflict', 'Host destination already exists');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    current = save(options, current, record, () => owner.assert());
    intent = true;
    makeHostDirectory(path.join(options.paths.home, 'host-profiles'));
    writeHostTree(stageRoot(options, plan.id), plan.changes, () => owner.assert());
    const stage = hostTree(stageRoot(options, plan.id), record.files);
    if (!stage.exists || !stage.complete || !stage.matches)
      throw new BosunError('conflict', 'Staged host profile changed');
    owner.assert();
    fs.renameSync(stageRoot(options, plan.id), profileRoot(options, plan.id));
    syncHostDirectory(path.join(options.paths.home, 'host-profiles'));
    owner.assert();
    if (record.skillWorkspace) {
      const workspace = installWorkspaceSkills(
        record.skillWorkspace,
        profileRoot(options, record.id),
        () => owner.assert(),
        (binding) => {
          record = {
            ...record,
            skillWorkspace: binding,
            version: record.version + 1,
            updatedAt: Date.now(),
          };
          current = save(options, current, record, () => owner.assert());
        },
      );
      record = { ...record, skillWorkspace: workspace };
    }
    record = { ...record, state: 'ready', version: record.version + 1, updatedAt: Date.now() };
    current = save(options, current, record, () => owner.assert());
    return { ...report(options, record), duplicate: false };
  } catch (error) {
    if (intent) {
      try {
        const saved = readRuntimeManifest(options.paths);
        const previous = original(saved, requestId);
        if (previous && previous.state !== 'ready')
          save(
            options,
            saved,
            { ...previous, state: 'unknown', version: previous.version + 1, updatedAt: Date.now() },
            () => owner.assert(),
          );
      } catch {}
      throw new BosunError('unavailable', 'Host installation receipt unavailable', {
        details: { outcome: 'unknown' },
      });
    }
    throw error;
  } finally {
    owner.close();
  }
}
export function hostInstallationStatus(options: Options, id?: string) {
  const value = manifest(options);
  if (id !== undefined) {
    const record = value.hostProfiles?.find((item) => item.id === id);
    if (!record) throw new BosunError('not_found', 'Host profile not found');
    return report(options, record);
  }
  return { profiles: (value.hostProfiles ?? []).map((record) => report(options, record)) };
}
// This is a manual native UI launch, not a managed-session capability claim.
// Re-render the saved recipe so a changed receipt cannot introduce native flags.
export async function hostLaunchPlan(
  options: Options & { env: Env; cwd: string },
  id: string,
  expectedVersion: number,
  expectedHash: string,
) {
  const value = manifest(options);
  const record = value.hostProfiles?.find((item) => item.id === id);
  if (!record) throw new BosunError('not_found', 'Host profile not found');
  if (record.version !== expectedVersion || record.planHash !== expectedHash)
    throw new BosunError('conflict', 'Reviewed host installation changed');
  const status = report(options, record);
  if (
    record.state !== 'ready' ||
    !status.configMatches ||
    !status.tree.matches ||
    !status.tree.complete ||
    status.stage.exists ||
    (status.projectSkills && (!status.projectSkills.complete || !status.projectSkills.matches))
  )
    throw new BosunError('conflict', 'Host profile requires review');
  assertBinary(record.binary);
  const native = await adapter(record.hostId, options.config);
  const settings = { root: status.root, nativeVersion: record.nativeVersion };
  const inputBundle = bundle({ ...options, binary: record.binary }, record.hostId, native);
  if (
    JSON.stringify(hostFileReceipts(await native.plan(inputBundle, settings))) !==
      JSON.stringify(record.files) ||
    JSON.stringify(native.launch(inputBundle, settings)) !== JSON.stringify(record.launch)
  )
    throw new BosunError('conflict', 'Host receipt differs from shipped assets');
  const cwd = options.cwd;
  if (
    !path.isAbsolute(cwd) ||
    path.resolve(cwd) !== cwd ||
    fs.realpathSync(cwd) !== cwd ||
    !fs.statSync(cwd).isDirectory() ||
    /[\x00-\x1f\x7f]/.test(cwd)
  )
    throw new BosunError('invalid', 'Select a canonical native workspace');
  if (
    record.skillWorkspace &&
    cwd !== record.skillWorkspace.root &&
    !cwd.startsWith(record.skillWorkspace.root + path.sep)
  )
    throw new BosunError('conflict', 'Codex profile belongs to another skill workspace');
  const selected = executable(options.config.hosts[record.hostId].command, options.env);
  if (!selected) throw new BosunError('unavailable', 'Native executable unavailable');
  const command = fs.realpathSync(selected);
  const env: Record<string, string> = { ...record.launch.env, BOSUN_HOME: options.paths.home };
  if (record.hostId === 'omp' && options.config.hosts.omp.home)
    Object.assign(env, { PI_CODING_AGENT_DIR: options.config.hosts.omp.home });
  if (record.hostId === 'codex' && options.config.hosts.codex.home)
    Object.assign(env, { CODEX_HOME: options.config.hosts.codex.home });
  if (record.hostId === 'claude' && options.config.hosts.claude.home)
    Object.assign(env, { CLAUDE_CONFIG_DIR: options.config.hosts.claude.home });
  return {
    id: record.id,
    version: record.version,
    planHash: record.planHash,
    hostId: record.hostId,
    nativeVersion: record.nativeVersion,
    command,
    cwd,
    args: [...record.launch.args],
    env,
    managedControl: 'unverified' as const,
  };
}
export function undoHostInstallation(options: Options, id: string, expectedVersion: number) {
  const owner = new DaemonOwner(options.paths.owner);
  let intent = false;
  try {
    let value = manifest(options);
    let record = value.hostProfiles?.find((item) => item.id === id);
    if (!record) throw new BosunError('not_found', 'Host profile not found');
    if (record.state === 'undone') return { ...report(options, record), duplicate: true };
    if (record.version !== expectedVersion)
      throw new BosunError('conflict', 'Host installation version changed');
    const root = profileRoot(options, id),
      stage = stageRoot(options, id),
      archive = archiveRoot(options, id);
    const main = hostTree(root, record.files),
      pending = hostTree(stage, record.files),
      retired = hostTree(archive, record.files);
    if (
      !main.matches ||
      !pending.matches ||
      !retired.matches ||
      (main.exists && pending.exists) ||
      (retired.exists && (main.exists || pending.exists)) ||
      (record.state === 'ready' && !main.complete)
    )
      throw new BosunError('conflict', 'Host profile changed; undo requires review');
    if (record.skillWorkspace && !inspectWorkspaceSkills(record.skillWorkspace, root).matches)
      throw new BosunError('conflict', 'Project skills changed; undo requires review');
    record = { ...record, state: 'undoing', version: record.version + 1, updatedAt: Date.now() };
    value = save(options, value, record, () => owner.assert());
    intent = true;
    const source = main.exists ? root : pending.exists ? stage : null;
    if (record.skillWorkspace)
      undoWorkspaceSkills(record.skillWorkspace, root, () => owner.assert());
    if (source) {
      owner.assert();
      fs.renameSync(source, archive);
      syncHostDirectory(path.dirname(archive));
      owner.assert();
    }
    record = { ...record, state: 'undone', version: record.version + 1, updatedAt: Date.now() };
    save(options, value, record, () => owner.assert());
    return { ...report(options, record), duplicate: false };
  } catch (error) {
    if (intent)
      throw new BosunError('unavailable', 'Host undo receipt unavailable', {
        details: { outcome: 'unknown' },
      });
    throw error;
  } finally {
    owner.close();
  }
}
