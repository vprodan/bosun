import fs from 'node:fs';
import type { Env } from '../core/domain/inference.ts';
import type { RuntimePaths } from '../platform/paths.ts';
import { diagnoseFile, diagnoseSqlite } from '../platform/diagnostics.ts';
import { readRuntimeManifest } from '../platform/manifest.ts';
import { installationStatus } from './installation.ts';
import { loadRuntimeConfig, configRevision } from '../platform/config.ts';
import { loadHookConfig } from '../platform/hook-config.ts';
import { executable } from '../platform/process.ts';
import { hostInstallationStatus } from './host-install.ts';
import { HOSTS } from '../core/domain/config.ts';

export type DoctorCheck = {
  id: string;
  state: 'ready' | 'missing' | 'held' | 'unverified';
  detail: string;
  required: boolean;
};
export function diagnoseRuntime(options: { paths: RuntimePaths; env: Env }) {
  const { paths, env } = options;
  const checks: DoctorCheck[] = [];
  function check(id: string, state: DoctorCheck['state'], detail: string, required = true) {
    checks.push({ id, state, detail, required });
  }
  const home = diagnoseFile(paths.home, 'directory');
  check(
    'runtime.home',
    home.state === 'safe' ? 'ready' : home.state === 'missing' ? 'missing' : 'held',
    home.state === 'missing'
      ? 'Runtime is not prepared; use setup or the supported upgrade.'
      : home.state === 'safe'
        ? 'Private runtime directory is present.'
        : 'Runtime directory permissions or identity require review.',
  );
  if (home.state !== 'safe')
    return {
      prepared: false,
      coverage: 'filesystem-metadata' as const,
      checks,
      nativeCalls: false,
      databaseOpened: false,
      schemaQualification: 'unverified' as const,
    };
  let manifest: ReturnType<typeof readRuntimeManifest> | undefined;
  try {
    manifest = readRuntimeManifest(paths);
    check(
      'runtime.manifest',
      manifest.state === 'ready' ? 'ready' : 'held',
      manifest.state === 'ready'
        ? 'Prepared installation identity is valid.'
        : 'Installation is incomplete; inspect its saved receipt.',
    );
  } catch {
    check(
      'runtime.manifest',
      fs.existsSync(paths.manifest) ? 'held' : 'missing',
      'Installation manifest is unavailable; no repair was attempted.',
    );
  }
  if (manifest?.installation) {
    let matches = false;
    try {
      matches = installationStatus({ paths, env }).matches === true;
    } catch {}
    check(
      'installation.files',
      matches ? 'ready' : 'held',
      matches
        ? 'Owned binary and dormant daemon definition match their installation receipt.'
        : 'Installed files or root bindings changed; review the installation receipt.',
    );
    check(
      'installation.service',
      'unverified',
      'Native service activation is separately qualified.',
      false,
    );
  }
  let config: ReturnType<typeof loadRuntimeConfig> | undefined;
  try {
    config = loadRuntimeConfig(paths, env);
    const exists = diagnoseFile(paths.config, 'file').state === 'safe';
    check(
      'runtime.config',
      exists ? 'ready' : 'missing',
      exists
        ? 'TOML configuration is valid.'
        : 'Configuration is absent; only defaults were inspected.',
    );
  } catch {
    check('runtime.config', 'held', 'Configuration is unavailable or invalid.');
  }
  const memory = diagnoseSqlite(paths.memory);
  check(
    'memory.database',
    memory.state === 'missing'
      ? 'missing'
      : memory.state === 'unsafe' ||
          memory.state === 'header_invalid' ||
          memory.state === 'journal_present'
        ? 'held'
        : 'ready',
    memory.state === 'missing'
      ? 'memory database absent'
      : memory.state === 'wal_present'
        ? 'WAL held; schema not verified by read-only doctor'
        : memory.state === 'header_only'
          ? 'SQLite header inspected; schema and storage authority remain unverified.'
          : 'Memory file identity, permissions or header require review.',
  );
  const state = diagnoseFile(paths.state, 'file');
  check(
    'jobs.state',
    state.state === 'safe' ? 'ready' : state.state === 'missing' ? 'missing' : 'held',
    state.state === 'missing'
      ? 'Job state is absent until the daemon creates its owned store.'
      : state.state === 'safe'
        ? 'Private job state file is present.'
        : 'Job state file identity or permissions require review.',
    false,
  );
  const view = diagnoseSqlite(paths.view);
  check(
    'memory.view',
    view.state === 'header_only' ? 'ready' : view.state === 'missing' ? 'missing' : 'held',
    view.state === 'header_only'
      ? 'Read-view header is present; publication eligibility is checked at delivery.'
      : view.state === 'missing'
        ? 'Public read view is absent.'
        : 'Public read view identity, header or journal state requires review.',
  );
  const hook = loadHookConfig(paths);
  check(
    'hook.snapshot',
    hook &&
      config &&
      manifest &&
      hook.configRevision === configRevision(config) &&
      hook.memory.sourceId === manifest.sourceId
      ? 'ready'
      : 'held',
    hook &&
      config &&
      manifest &&
      hook.configRevision === configRevision(config) &&
      hook.memory.sourceId === manifest.sourceId
      ? 'Hook binding matches; native hook activation is separately qualified.'
      : 'Hook snapshot is absent, invalid or differs from the effective configuration.',
  );
  const socket = diagnoseFile(paths.socket, 'socket');
  check(
    'daemon.socket',
    socket.state === 'safe' ? 'unverified' : socket.state === 'missing' ? 'missing' : 'held',
    socket.state === 'safe'
      ? 'Socket metadata is present; no connection or liveness claim was made.'
      : socket.state === 'missing'
        ? 'Daemon socket is absent.'
        : 'Daemon socket ownership or permissions require review.',
    false,
  );
  if (config) {
    for (const host of HOSTS) {
      const enabled = config.hosts[host].enabled;
      const found = enabled && executable(config.hosts[host].command, env);
      check(
        `host.${host}`,
        !enabled ? 'unverified' : found ? 'unverified' : 'missing',
        !enabled
          ? 'Native host is disabled.'
          : found
            ? 'Executable is present; version, login, hooks and native controls remain unverified.'
            : 'Native executable is absent.',
        false,
      );
    }
    if (manifest) {
      try {
        const profiles = hostInstallationStatus({ paths, config, binary: '' });
        if ('profiles' in profiles)
          for (const item of profiles.profiles) {
            check(
              `profile.${item.record.id}`,
              item.record.state === 'ready' &&
                item.tree.matches &&
                item.tree.complete &&
                item.configMatches &&
                (!item.projectSkills || (item.projectSkills.complete && item.projectSkills.matches))
                ? 'ready'
                : item.record.state === 'undone'
                  ? 'unverified'
                  : 'held',
              item.record.state === 'ready'
                ? 'Owned profile is inspected; native activation remains unverified.'
                : item.record.state === 'undone'
                  ? 'Retired profile receipt is retained.'
                  : 'Profile or project skill receipt requires review.',
              item.record.state !== 'undone',
            );
          }
      } catch {
        check('profiles', 'held', 'Host profile diagnostics are unavailable.');
      }
    }
  }
  return {
    prepared: checks.every((item) => !item.required || item.state === 'ready'),
    coverage: 'filesystem-metadata' as const,
    checks,
    nativeCalls: false,
    databaseOpened: false,
    schemaQualification: 'unverified' as const,
  };
}
