import fs from 'node:fs';
import { BosunError } from '../core/errors.ts';
import { HOSTS, type HostId } from '../core/domain/config.ts';
import { loadRuntimeConfig } from '../platform/config.ts';
import { readRuntimeManifest } from '../platform/manifest.ts';
import { installationStatus, type InstallationOptions } from './installation.ts';
import { hostInstallationStatus } from './host-install.ts';

type Action = { purpose: string; argv: string[] };
export function inspectOnboarding(options: InstallationOptions, host?: string) {
  const config = loadRuntimeConfig(options.paths, options.env),
    selected = host ?? config.hosts.primary;
  if (!HOSTS.includes(selected as HostId))
    throw new BosunError('invalid', 'Select OMP, OpenCode 2, Codex or Claude');
  const actions: Action[] = [];
  const result = (state: string, detail: string) => ({
    state,
    host: selected,
    detail,
    actions,
    nativeQualification: 'unverified' as const,
    observation: 'saved-configuration' as const,
  });
  let manifest: ReturnType<typeof readRuntimeManifest>;
  try {
    manifest = readRuntimeManifest(options.paths, { installationStatus: true });
  } catch {
    if (fs.existsSync(options.paths.manifest))
      return result('held', 'Inspect the existing runtime manifest before continuing.');
    if (fs.existsSync(options.paths.memory) || fs.existsSync(options.paths.legacyConfig)) {
      actions.push({
        purpose: 'Review the existing data upgrade.',
        argv: [
          'bosun',
          'upgrade',
          'plan',
          '--request-id',
          'onboard-upgrade',
          '--output',
          'upgrade-plan.json',
        ],
      });
      return result('upgrade', 'Review the supported upgrade before installing the final runtime.');
    }
    actions.push({
      purpose: 'Prepare private runtime storage and configuration.',
      argv: ['bosun', 'setup'],
    });
    return result('setup', 'Start by preparing the runtime.');
  }
  if (manifest.state !== 'ready')
    return result('held', 'Inspect the original incomplete setup or upgrade receipt.');
  const status = installationStatus(options),
    record = status.record;
  if (!record) {
    actions.push({
      purpose: 'Review the release executable and installation destinations.',
      argv: [
        'bosun',
        'install',
        'plan',
        '--binary',
        '<release-executable>',
        '--request-id',
        'onboard-install',
        '--output',
        'install-plan.json',
      ],
    });
    actions.push({
      purpose: 'Apply the reviewed plan after stopping native clients.',
      argv: [
        'bosun',
        'install',
        'apply',
        'install-plan.json',
        '--hash',
        '<planHash>',
        '--clients-stopped',
      ],
    });
    return result('install', 'Select your release executable and review its installation plan.');
  }
  if (record.state !== 'ready' || !status.matches) {
    actions.push({
      purpose: 'Inspect original ownership, drift or uncertain effects.',
      argv: ['bosun', 'install', 'status'],
    });
    return result('held', 'The saved installation requires review.');
  }
  const binary = record.targetBinary,
    service = record.service;
  if (['unknown', 'enabling', 'disabling'].includes(service.state)) {
    actions.push({
      purpose: 'Reconcile the original service operation without repeating it.',
      argv: [
        binary,
        'install',
        'reconcile',
        record.id,
        '--version',
        String(record.version),
        '--hash',
        record.planHash,
      ],
    });
    return result('held', 'Inspect the uncertain daemon operation before continuing.');
  }
  const profiles =
    manifest.hostProfiles?.filter(
      (profile) => profile.hostId === selected && profile.state !== 'undone',
    ) ?? [];
  if (profiles.some((profile) => profile.state !== 'ready'))
    return result(
      'held',
      'Inspect the original native profile receipt before applying another profile.',
    );
  if (!profiles.length) {
    if (service.state === 'enabled')
      actions.push({
        purpose: 'Stop the daemon before applying native profile files.',
        argv: [
          binary,
          'install',
          'disable',
          record.id,
          '--version',
          String(record.version),
          '--hash',
          record.planHash,
          '--request-id',
          `onboard-profile-stop-${record.id.slice(3)}-${service.operations.length}`,
          '--clients-stopped',
        ],
      });
    actions.push({
      purpose: 'Review the selected native host profile; use its supported installed version.',
      argv: [
        binary,
        'host',
        'plan',
        selected,
        '--native-version',
        '<supported-installed-version>',
        '--request-id',
        `onboard-${selected}`,
        '--binary',
        binary,
        '--output',
        'host-plan.json',
      ],
    });
    actions.push({
      purpose: 'Apply the reviewed native profile with the daemon stopped.',
      argv: [binary, 'host', 'apply', 'host-plan.json', '--hash', '<hostPlanHash>'],
    });
    actions.push({
      purpose: 'Inspect the next step after applying the profile.',
      argv: [binary, 'onboard', '--host', selected],
    });
    return result(
      'profile',
      'Use your existing native host installation and review its bosun profile.',
    );
  }
  if (profiles.length !== 1)
    return result('held', 'Select one owned native profile before launching.');
  if (service.state === 'prepared' || service.state === 'disabled') {
    actions.push({
      purpose: 'Start the owned daemon after native clients and effects are settled.',
      argv: [
        binary,
        'install',
        'enable',
        record.id,
        '--version',
        String(record.version),
        '--hash',
        record.planHash,
        '--request-id',
        `onboard-enable-${record.id.slice(3)}-${service.operations.length}`,
        '--clients-stopped',
      ],
    });
    return result('daemon', 'Start the reviewed daemon installation.');
  }
  const profile = profiles[0];
  const inspected = hostInstallationStatus(
    { paths: options.paths, config, binary },
    profile.id,
  ) as { tree?: { complete?: boolean; matches?: boolean }; configMatches?: boolean };
  if (
    inspected.tree?.complete !== true ||
    inspected.tree.matches !== true ||
    inspected.configMatches !== true
  )
    return result('held', 'The native profile or its configuration has changed.');
  actions.push({
    purpose: 'Preview native arguments, skills and model bindings.',
    argv: [
      binary,
      'host',
      'launch',
      profile.id,
      '--version',
      String(profile.version),
      '--hash',
      profile.planHash,
      '--preview',
    ],
  });
  actions.push({
    purpose: 'Launch the owned native profile after reviewing the preview.',
    argv: [
      binary,
      'host',
      'launch',
      profile.id,
      '--version',
      String(profile.version),
      '--hash',
      profile.planHash,
    ],
  });
  return result(
    'launch',
    'Review and launch the native profile; native trust and automatic handoff remain separately qualified.',
  );
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export function renderOnboarding(value: ReturnType<typeof inspectOnboarding>) {
  return `${value.host}: ${value.detail}\n\n${value.actions.map((action) => `${action.purpose}\n${action.argv.map(quote).join(' ')}`).join('\n\n')}\n`;
}
