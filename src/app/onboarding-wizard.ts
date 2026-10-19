import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { LaunchdControl } from '../adapters/services/launchd.ts';
import { HOSTS, type HostId } from '../core/domain/config.ts';
import type { Env } from '../core/domain/inference.ts';
import { sameNativeMajor } from '../core/domain/host-version.ts';
import { BosunError } from '../core/errors.ts';
import { roleDefinitions, version } from '../platform/assets.ts';
import { loadRuntimeConfig, parseRuntimeConfig, renderRuntimeConfig, saveRuntimeConfig } from '../platform/config.ts';
import { DaemonOwner } from '../platform/daemon-owner.ts';
import { installationDirectory } from '../platform/installation-files.ts';
import { readRuntimeManifest } from '../platform/manifest.ts';
import type { RuntimePaths } from '../platform/paths.ts';
import { privateDirectory, readPrivateFile } from '../platform/private-file.ts';
import { executable } from '../platform/process.ts';
import { publishHookConfig } from './config.ts';
import { applyHostInstallation, hostInstallationStatus, hostLaunchPlan, planHostInstallation, undoHostInstallation } from './host-install.ts';
import { inspectNativeHostVersion } from './host-launch.ts';
import { installationStatus, readInstallationPlan } from './installation.ts';
import type { LifecycleQuestion } from './installation-lifecycle.ts';
import { runInstallWizard } from './install-wizard.ts';
import { runServiceWizard } from './service-wizard.ts';

export type OnboardingPrompts = {
  confirm(question: { kind: LifecycleQuestion['kind'] | 'native-version' | 'models' | 'profile' | 'launch'; message: string; initialValue: boolean }): Promise<boolean>;
  selectHost(initialValue: HostId): Promise<HostId | null>;
  text(message: string, initialValue?: string): Promise<string | null>;
};
export type OnboardingResult = {
  state: 'ready' | 'cancelled' | 'held';
  message: string;
  host?: HostId;
  binary?: string;
  launch?: { id: string; version: number; hash: string };
};
export type OnboardingOptions = {
  paths: RuntimePaths;
  env: Env;
  cwd: string;
  binary?: string;
  host?: HostId;
  prompts: OnboardingPrompts;
  write(text: string): void;
  control?: LaunchdControl;
  optionalTools?: () => Promise<void>;
  signal?: AbortSignal;
};
function identity(file: string) {
  try {
    const stat = fs.lstatSync(file);
    return [fs.realpathSync(file), stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Owner-approved preparation only; the caller owns actual foreground launch and signals. */
export async function runOnboardingWizard(options: OnboardingOptions): Promise<OnboardingResult> {
  if (options.env.BOSUN_CALLER === 'model')
    return { state: 'held', message: 'Guided onboarding requires an owner terminal; no changes were made.' };
  const effects: string[] = [];
  const signal = options.signal ?? new AbortController().signal;
  let host: HostId | undefined, binary: string | undefined;
  let nativeSource: { command: string; lookup: string; identity: string } | undefined;
  let failure = 'Inspect bosun doctor, bosun install status and bosun host status. Existing unsafe, legacy, incomplete, drifted or unknown state must be recovered through its original receipt; do not reinstall or replay it.';
  function result(state: OnboardingResult['state'], message: string): OnboardingResult {
    return { state, message: message + (effects.length ? `\nPrior approved changes are retained: ${effects.join('; ')}. No automatic rollback or restart was requested.` : ''), ...(host ? { host } : {}), ...(binary ? { binary } : {}) };
  }
  function active() {
    if (signal.aborted) throw new BosunError('cancelled', 'Onboarding cancelled; the next operation was not requested');
  }
  function inspect() {
    if (!identity(options.paths.home)) return null;
    installationDirectory(options.paths.home);
    if (!fs.readdirSync(options.paths.home).length) return null;
    privateDirectory(options.paths.home);
    const manifest = readRuntimeManifest(options.paths, { installationStatus: true });
    if (manifest.state !== 'ready') throw new BosunError('unverified', 'Runtime preparation is incomplete');
    readPrivateFile(options.paths.config, 262144);
    const config = loadRuntimeConfig(options.paths, options.env);
    const status = installationStatus(options), installed = status.record;
    if (installed?.state === 'ready' && status.matches !== true) {
      const original = readInstallationPlan(path.join(options.paths.home, 'installation', installed.id, 'plan.json'));
      if (original.planHash === installed.planHash && original.version !== version)
        throw new BosunError('unverified', 'This owned installation belongs to another release. First run bosun install from the selected downloaded release; that reviewed flow invokes the original executable for cross-version retirement. Onboarding will not bypass its version-bound receipt.');
    }
    if (installed && installed.state !== 'undone' && (installed.state !== 'ready' || status.matches !== true ||
        !['prepared', 'enabled', 'disabled'].includes(installed.service.state) ||
        installed.service.operations.some(operation => operation.state === 'pending' || operation.state === 'unknown')))
      throw new BosunError('unverified', 'Installation or original service outcome requires review');
    const active = (manifest.hostProfiles ?? []).filter(profile => profile.state !== 'undone');
    if (new Set(active.map(profile => profile.hostId)).size !== active.length)
      throw new BosunError('conflict', 'Multiple active profiles require explicit owner review');
    const profiles = active.map(profile => {
      if (profile.state !== 'ready') throw new BosunError('unverified', 'Original native profile outcome is unconfirmed; do not replay apply or undo');
      const report = hostInstallationStatus({ paths: options.paths, config, binary: profile.binary }, profile.id);
      if (!('tree' in report) || !report.tree.complete || !report.tree.matches || report.stage.exists || !report.configMatches ||
          (report.projectSkills && (!report.projectSkills.complete || !report.projectSkills.matches)))
        throw new BosunError('conflict', 'Existing native profile or configuration drift requires review');
      return report;
    });
    return { manifest, config, installed: installed?.state === 'ready' ? installed : undefined, profiles };
  }
  function snapshot() {
    const state = inspect();
    if (nativeSource && (JSON.stringify(identity(nativeSource.lookup)) !== nativeSource.identity ||
        !host || executable(state!.config.hosts[host].command, options.env) !== nativeSource.lookup))
      throw new BosunError('conflict', 'Selected native executable changed; inspect it before a new review');
    return JSON.stringify({
      home: identity(options.paths.home),
      manifest: state ? [identity(options.paths.manifest), readPrivateFile(options.paths.manifest, 131072)] : null,
      config: state ? [identity(options.paths.config), readPrivateFile(options.paths.config, 262144), state.config] : null,
      installation: state?.installed,
      profiles: state?.profiles,
      source: options.binary ? identity(options.binary) : null,
      binary: binary ? identity(binary) : null,
      native: nativeSource,
    });
  }
  async function reviewed<T>(action: () => Promise<T>): Promise<T> {
    active();
    const before = snapshot();
    const value = await action();
    active();
    if (snapshot() !== before) throw new BosunError('conflict', 'Configuration, executable, profile or receipt changed during review; inspect fresh state before continuing');
    return value;
  }
  const confirm: OnboardingPrompts['confirm'] = question => reviewed(() => options.prompts.confirm(question));
  async function stopped() {
    active();
    let state = inspect();
    if (!state?.installed) throw new BosunError('unverified', 'A matching owned installation is required');
    if (state.installed.service.state === 'enabled') {
      const stop = await runServiceWizard({ ...options, confirm }, 'disable');
      if (stop.state !== 'ready') return result(stop.state, stop.message);
      effects.push('owned background service stopped');
      state = inspect();
      if (state?.installed?.service.state !== 'disabled') throw new BosunError('unverified', 'Original service stop is unconfirmed; do not start or replay it');
    }
    active();
    failure = 'Profile/configuration changes require released daemon ownership. Stop any separately launched foreground/nohup daemon in its original terminal (Ctrl-C), close native clients and settle their effects, then inspect bosun doctor and the original receipts. No guessed PID is killed.';
    const owner = new DaemonOwner(options.paths.owner);
    try { owner.assert(); } finally { owner.close(); }
    return null;
  }
  try {
    active();
    let state = inspect();
    const defaultHost = options.host ?? (state?.config ?? loadRuntimeConfig(options.paths, options.env)).hosts.primary;
    if (!HOSTS.includes(defaultHost)) throw new BosunError('invalid', 'Select omp, opencode, codex or claude');
    if (!state?.installed) {
      if (!options.binary) return result('held', 'Source onboarding requires --binary /absolute/path/to/the/downloaded/bosun release executable. No runtime was prepared.');
      // Installation must not serialize temporary configuration environment overlays.
      const installation = await runInstallWizard({ ...options, showCompletion: false, setupConfig: loadRuntimeConfig(options.paths, {}), binary: options.binary,
        confirm: async question => {
          if (question.kind === 'start') return false;
          const approved = await confirm(question);
          if (approved && question.kind === 'setup') effects.push('runtime preparation approved; inspect bosun doctor for its outcome');
          if (approved && question.kind === 'install') effects.push('installation approved; original plan and receipt retained');
          return approved;
        },
      });
      binary = installation.binary;
      if (installation.state !== 'ready') return result(installation.state, installation.message);
      state = inspect();
    }
    if (!state?.installed) return result('held', 'A matching owned installation is required. Inspect bosun install status; existing data was retained.');
    binary = state.installed.targetBinary;
    const selected = await reviewed(() => options.prompts.selectHost(defaultHost));
    if (selected === null) return result('cancelled', 'Host selection cancelled; no native profile was changed.');
    if (!HOSTS.includes(selected)) throw new BosunError('invalid', 'Select omp, opencode, codex or claude');
    host = selected;
    state = inspect()!;
    const firstProfile = state.profiles.length === 0;
    let profile = state.profiles.find(report => report.record.hostId === host)?.record;
    if (profile) await reviewed(() => hostLaunchPlan({ ...options, config: state!.config, binary: binary! }, profile!.id, profile!.version, profile!.planHash));
    if (!state.config.hosts[host].enabled) return result('held', `The selected ${host} host is disabled. Review its configuration explicitly; no host was substituted.`);
    const command = executable(state.config.hosts[host].command, options.env);
    if (!command) return result('held', `The selected ${host} executable is missing. Install that native host yourself and rerun bosun onboard; no other host was probed.`);
    const canonical = fs.realpathSync(command);
    nativeSource = { command: canonical, lookup: command, identity: JSON.stringify(identity(command)) };
    failure = `The selected ${host} --version inspection was unavailable or unsupported. Inspect that executable and bosun host status; no native login, model or foreground session was requested.`;
    if (!await confirm({ kind: 'native-version', message: `Run only ${JSON.stringify(canonical)} --version (3-second bounded inspection)? This does not log in, run a model or qualify native controls.`, initialValue: false }))
      return result('cancelled', 'Native version inspection declined; no native call was made.');
    const nativeVersion = await reviewed(() => inspectNativeHostVersion({ hostId: host!, command: canonical, cwd: options.cwd, env: options.env }, signal));
    const hostOptions = () => ({ ...options, config: loadRuntimeConfig(options.paths, options.env), binary: binary!, workspace: options.cwd });
    // Existing Codex skill links cannot be replanned until their approved undo.
    if (profile) {
      if (!sameNativeMajor(nativeVersion, profile.nativeVersion))
        throw new BosunError('unsupported', 'Detected native major is unsupported by the prepared profile; no profile was retired');
    } else await reviewed(() => planHostInstallation(hostOptions(), { hostId: host!, nativeVersion, requestId: 'onboard_check_' + crypto.randomUUID() }));
    if (profile && profile.nativeVersion !== nativeVersion) {
      options.write(`Prepared native version: ${profile.nativeVersion}\nDetected native version: ${nativeVersion}\nReplacement archives only the owned old profile and retains its original receipt. Current config/model/effort/primary selections are preserved. A separate new-profile approval follows; declining later leaves the old profile retired.\n`);
      if (!await confirm({ kind: 'profile', message: 'Retire/archive this old native profile and review a replacement for the detected version? Confirm native clients are stopped and effects settled.', initialValue: false }))
        return result('cancelled', 'Native version replacement declined; the original profile remains unchanged.');
      const stop = await stopped();
      if (stop) return stop;
      failure = 'Old-profile retirement did not finish or is unconfirmed. Retain the original host receipt and archive, inspect bosun host status, and do not replay undo or apply.';
      active();
      const retired = undoHostInstallation(hostOptions(), profile.id, profile.version);
      if (retired.record.state !== 'undone') throw new BosunError('unverified', 'Original profile retirement is unconfirmed');
      effects.push(`old ${host} profile ${profile.id} archived`);
      profile = undefined;
    }
    if (!profile) {
      const stop = await stopped();
      if (stop) return stop;
      state = inspect()!;
      const missing = roleDefinitions().map(role => role.id).filter(role => !state!.config.roles[role]?.[host!]?.model);
      options.write(`Selected host: ${host}; configured primary remains ${state.config.hosts.primary}.\nExact effective role bindings (environment overrides remain temporary):\n${JSON.stringify(Object.fromEntries(Object.entries(state.config.roles).map(([role, bindings]) => [role, bindings[host!] ?? {}])), null, 2)}\n`);
      if (missing.length && !firstProfile) {
        if (!await confirm({ kind: 'models', message: 'Leave missing model bindings unchanged to preserve all existing profile/config hashes? The native UI uses its existing host settings; Bosun jobs with no configured binding require --model. No models will be guessed or copied.', initialValue: false }))
          return result('cancelled', 'Missing model bindings were not changed; profile preparation declined.');
      } else if (missing.length && await confirm({ kind: 'models', message: `Optionally fill missing ${host} role bindings with one exact model selector you choose, after reviewing the affected roles? No keeps them unchanged: the native UI uses existing host settings and jobs need --model. Existing model/effort and all other hosts remain unchanged.`, initialValue: false })) {
        const candidate = structuredClone(loadRuntimeConfig(options.paths, {}));
        const changes: Record<string, string> = {};
        const model = await reviewed(() => options.prompts.text(`Exact ${host} model selector to share across these missing roles: ${missing.join(', ')} (empty keeps all unconfigured; no model call):`));
        if (model === null) return result('cancelled', 'Model entry cancelled; no model configuration was saved.');
        if (model && (model.trim() !== model || model.length > 200 || /[\x00-\x1f\x7f]/.test(model)))
          return result('held', 'Model selectors must be exact, nonempty text without surrounding whitespace or controls; no configuration was saved.');
        if (model) for (const role of missing) {
          candidate.roles[role] ??= {};
          candidate.roles[role][host] = { ...candidate.roles[role][host], model };
          changes[role] = model;
        }
        if (Object.keys(changes).length) {
          const checked = parseRuntimeConfig(renderRuntimeConfig(candidate));
          const effective = parseRuntimeConfig(renderRuntimeConfig(checked), options.env);
          await reviewed(() => planHostInstallation({ ...hostOptions(), config: effective }, { hostId: host!, nativeVersion, requestId: 'onboard_models_' + crypto.randomUUID() }));
          options.write(`Save only these missing selected-host model bindings; no effort, primary, existing model or other-host binding changes:\n${JSON.stringify(changes, null, 2)}\n`);
          const originalConfig = readPrivateFile(options.paths.config, 262144);
          const originalManifest = readPrivateFile(options.paths.manifest, 131072);
          const backup = path.join(options.paths.artifacts, `onboard-config-${crypto.randomUUID()}.toml`);
          options.write(`Original private configuration backup (created only after approval): ${JSON.stringify(backup)}\n`);
          const owner = new DaemonOwner(options.paths.owner);
          try {
            owner.assert();
            if (!await confirm({ kind: 'models', message: 'Save these exact reviewed bindings, retain a private original-config backup and publish the hook snapshot?', initialValue: false }))
              return result('cancelled', 'Model configuration save declined; no bindings were saved.');
            owner.assert();
            const current = inspect()!;
            if (current.profiles.length || current.installed?.service.state === 'enabled') throw new BosunError('conflict', 'Profile or service state changed before configuration save');
            active();
            if (readPrivateFile(options.paths.config, 262144) !== originalConfig || readPrivateFile(options.paths.manifest, 131072) !== originalManifest)
              throw new BosunError('conflict', 'Configuration or manifest changed before the reviewed save');
            privateDirectory(options.paths.artifacts);
            failure = 'Original configuration backup did not finish. No configuration write was requested; inspect the private artifacts directory before proceeding.';
            const fd = fs.openSync(backup, 'wx', 0o600);
            try { fs.writeFileSync(fd, originalConfig); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
            effects.push(`original private configuration backup retained at ${JSON.stringify(backup)}`);
            failure = `The reviewed configuration/hook-snapshot write did not finish or is unconfirmed. Original private configuration backup: ${JSON.stringify(backup)}. Inspect the saved file, bosun config show and bosun doctor before proceeding; no profile was applied and no rollback or repeat write was requested.`;
            effects.push('reviewed model configuration write approved; inspect saved config if interrupted');
            active();
            saveRuntimeConfig(options.paths, checked);
            owner.assert();
            active();
            publishHookConfig(loadRuntimeConfig(options.paths, options.env), options.paths, { sourceId: current.manifest.sourceId, installationId: current.manifest.installationId, now: Date.now() });
          } finally { owner.close(); }
        }
      }
      const plan = await reviewed(() => planHostInstallation(hostOptions(), { hostId: host!, nativeVersion, requestId: 'onboard_' + crypto.randomUUID() }));
      options.write(`Native profile review:\nHost/version: ${host} ${nativeVersion}\nSelected executable: ${JSON.stringify(canonical)}\nWorkspace: ${JSON.stringify(options.cwd)}\nOwned profile directory: ${JSON.stringify(path.join(options.paths.home, 'host-profiles', plan.id))}\n${plan.changes.length} owned files/links:\n${plan.changes.map(change => `  ${change.op} ${JSON.stringify(change.path)}${change.op === 'link' ? ` -> ${JSON.stringify(change.target)}` : ''}`).join('\n')}\n${plan.skillWorkspace ? `Codex workspace skills: ${JSON.stringify(plan.skillWorkspace.root)}; create ${plan.skillWorkspace.links.filter(link => link.create).length} owned links, preserve ${plan.skillWorkspace.links.filter(link => !link.create).length} existing matching skills. Owned link/directory provenance is retained for undo.` : 'No workspace skill links outside the owned profile.'}\nThe full reviewed plan and receipt are retained; no ID/hash copying is needed. Native account/trust and existing host settings stay with ${host}.\n`);
      if (!await confirm({ kind: 'profile', message: 'Apply this reviewed native profile? Confirm Bosun/native clients are stopped and their effects settled. No model, login or native foreground launch is included.', initialValue: false }))
        return result('cancelled', 'Native profile application declined.');
      active();
      const stoppedOwner = new DaemonOwner(options.paths.owner);
      try { stoppedOwner.assert(); } finally { stoppedOwner.close(); }
      privateDirectory(options.paths.artifacts);
      fs.writeFileSync(path.join(options.paths.artifacts, `host-${plan.id}.json`), JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      failure = 'Native profile application did not finish or its outcome is unconfirmed. Retain the saved plan and original receipt; run bosun host status and do not replay apply or undo.';
      active();
      const applied = await applyHostInstallation(hostOptions(), plan, plan.planHash);
      profile = applied.record;
      if (profile.state !== 'ready') throw new BosunError('unverified', 'Original native profile outcome is unconfirmed');
      effects.push(`${host} native profile prepared`);
    } else options.write(`Reusing matching ready native profile ${profile.id}; no config, profile file or receipt was rewritten.\n`);
    active();
    const prepared = inspect()!;
    failure = 'Native profile preparation completed, but optional service/tools or launch review did not finish. Inspect bosun install status, bosun host status and original tool receipts; do not replay an uncertain effect.';
    const wasEnabled = prepared.installed?.service.state === 'enabled';
    const service = await runServiceWizard({ ...options, confirm }, 'enable');
    if (service.state === 'held') return result('held', service.message);
    if (service.state === 'ready' && installationStatus(options).record?.service.state === 'enabled')
      options.write('The owned background service is enabled; daemon availability still requires bosun status.\n');
    if (!wasEnabled && service.state === 'ready' && installationStatus(options).record?.service.state === 'enabled')
      effects.push('owned background service enabled');
    active();
    await options.optionalTools?.();
    state = inspect()!;
    const preview = await reviewed(() => hostLaunchPlan({ ...options, config: state!.config, binary: binary! }, profile!.id, profile!.version, profile!.planHash));
    const environment = Object.entries(preview.env).map(([key, value]) => key === 'OPENCODE_CONFIG_CONTENT'
      ? `  ${key}: exact reviewed bytes from ${JSON.stringify(preview.env.OPENCODE_CONFIG)} (${Buffer.byteLength(value)} bytes; SHA256 ${crypto.createHash('sha256').update(value).digest('hex')})`
      : `  ${key}=${JSON.stringify(value)}`).join('\n');
    options.write(`Literal native foreground launch preview (no foreground process has been started):\nNative version: ${preview.nativeVersion}\nExecutable: ${JSON.stringify(preview.command)}\nLiteral argv (no shell): ${JSON.stringify(preview.args)}\nWorkspace: ${JSON.stringify(preview.cwd)}\nProfile environment overrides:\n${environment}\nOther native environment/auth remains inherited; session/thread nesting markers are removed at launch. No credentials are printed or copied.\nNative authentication, live/model quality, optional tools and automatic dispatch qualification remain unverified.\n`);
    const launch = await confirm({ kind: 'launch', message: 'Launch exactly this reviewed native foreground session now? The actual launch rechecks native version, executable identity and profile state.', initialValue: false });
    if (launch) {
      const fresh = await reviewed(() => hostLaunchPlan({ ...options, config: loadRuntimeConfig(options.paths, options.env), binary: binary! }, profile!.id, profile!.version, profile!.planHash));
      if (JSON.stringify(fresh) !== JSON.stringify(preview)) throw new BosunError('conflict', 'Literal native launch preview changed');
    }
    active();
    const enabled = state.installed?.service.state === 'enabled';
    return { ...result('ready', `The ${host} native profile is prepared. ${enabled ? 'Owned background service enabled; inspect bosun status for daemon availability.' : 'Background service not started; use bosun start or run the foreground daemon in another terminal before memory/job commands.'} ${launch ? 'Native launch approved for the caller; not started by onboarding.' : 'Native launch not requested.'} Live/model quality and automatic dispatch remain unverified.`), ...(launch ? { launch: { id: profile.id, version: profile.version, hash: profile.planHash } } : {}) };
  } catch (error) {
    if (error instanceof BosunError && error.code === 'cancelled' && error.details?.outcome !== 'unknown')
      return result('cancelled', 'Onboarding cancelled; no further operation or native foreground launch was requested.');
    return result('held', failure + (error instanceof BosunError ? `\n${error.message}` : ''));
  }
}
