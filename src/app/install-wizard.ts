import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { LaunchdControl } from '../adapters/services/launchd.ts';
import type { InstallationReceipt } from '../core/domain/installation.ts';
import type { RuntimeConfig } from '../core/domain/config.ts';
import { BosunError } from '../core/errors.ts';
import { loadRuntimeConfig } from '../platform/config.ts';
import { readRuntimeManifest } from '../platform/manifest.ts';
import { privateDirectory } from '../platform/private-file.ts';
import { inspectBinary, installationDirectory, planInstallationDirectories, previousBinary } from '../platform/installation-files.ts';
import { setupRuntime } from './setup.ts';
import { applyInstallation, installationStatus, planInstallation, probeInstallationBinary, saveInstallationPlan, type InstallationOptions } from './installation.ts';
import { controlInstallationService } from './installation-service.ts';
import { retireInstallation, stageInstallerBinary, type LifecycleQuestion } from './installation-lifecycle.ts';
import { version } from '../platform/assets.ts';

export type InstallWizardOptions = InstallationOptions & {
  binary: string;
  confirm: (question: LifecycleQuestion) => Promise<boolean>;
  write: (text: string) => void;
  control?: LaunchdControl;
  afterInstall?: () => Promise<void>;
  signal?: AbortSignal;
  setupConfig?: RuntimeConfig;
  showCompletion?: boolean;
};
export type InstallWizardResult = {
  state: 'ready' | 'cancelled' | 'held';
  message: string;
  binary?: string;
  service?: 'enabled' | 'prepared' | 'disabled';
};
const cancelled = (): InstallWizardResult => ({ state: 'cancelled', message: 'Installation cancelled; the declined operation was not performed.' });
const held = (message: string): InstallWizardResult => ({ state: 'held', message });
const exists = (file: string) => {
  try { fs.lstatSync(file); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
};
const uncertain = (value: InstallationReceipt) =>
  !['prepared', 'enabled', 'disabled'].includes(value.service.state) ||
  value.service.operations.some((operation) => operation.state === 'pending' || operation.state === 'unknown');
const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";

/** Explicit owner flow; inspection never creates or repairs runtime state. */
export async function runInstallWizard(options: InstallWizardOptions): Promise<InstallWizardResult> {
  let failure = 'Installation preflight could not verify owned paths and private runtime state. Run bosun doctor and bosun install status; inspect permissions and symlinks without changing existing data.';
  const confirm: InstallWizardOptions['confirm'] = async question => {
    if (options.signal?.aborted) throw new BosunError('cancelled', 'Installation review cancelled');
    const approved = await options.confirm(question);
    if (options.signal?.aborted) throw new BosunError('cancelled', 'Installation review cancelled');
    return approved;
  };
  try {
    if (options.signal?.aborted) throw new BosunError('cancelled', 'Installation review cancelled');
    if (options.env.BOSUN_CALLER === 'model') return held('Installation requires an owner terminal; no changes were made.');
    const home = options.env.HOME;
    if (!home || /[\x00-\x1f\x7f]/.test(home)) return held('A safe absolute HOME is required. Run installation from your owner terminal.');
    installationDirectory(home);
    const runtime = options.paths.home;
    if (!path.isAbsolute(runtime) || path.resolve(runtime) !== runtime || /[\x00-\x1f\x7f]/.test(runtime))
      return held('The runtime home must be an absolute canonical owned path. Run bosun doctor; no changes were made.');
    installationDirectory(path.dirname(runtime));
    const present = exists(runtime);
    let fresh = !present;
    if (present) {
      installationDirectory(runtime);
      fresh = fs.readdirSync(runtime).length === 0;
      const mode = fs.lstatSync(runtime).mode & 0o7777;
      if (fresh && mode !== 0o700) {
        if (!await confirm({ kind: 'permissions', message: `Restrict your EMPTY data directory ${runtime} to owner-only permissions (0700)? No existing data will be changed.`, initialValue: false })) return cancelled();
        const fd = fs.openSync(runtime, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
          const before = fs.fstatSync(fd), current = fs.lstatSync(runtime);
          if (!before.isDirectory() || before.dev !== current.dev || before.ino !== current.ino ||
              fs.readdirSync(runtime).length || before.uid !== process.getuid?.())
            return held('Empty directory changed; no permission repair was performed.');
          fs.fchmodSync(fd, 0o700);
        } finally { fs.closeSync(fd); }
      }
      privateDirectory(runtime);
    }
    let receipt: InstallationReceipt | undefined;
    let selectedBinary = options.binary;
    if (!fresh) {
      failure = 'Existing runtime setup is incomplete, legacy, or unavailable. Run bosun doctor and inspect the supported bosun upgrade flow; existing data was retained.';
      const manifest = readRuntimeManifest(options.paths, { installationStatus: true });
      if (manifest.state !== 'ready') return held('Runtime preparation is incomplete. Run bosun doctor and inspect setup or upgrade recovery; existing data was retained.');
      loadRuntimeConfig(options.paths, options.env);
      const existing = manifest.installation;
      if (existing && existing.state !== 'undone') {
        if (existing.state !== 'ready' || uncertain(existing)) return held('The owned installation/service is uncertain. Existing receipts are retained; inspect and explicitly reconcile the original outcome before replacing files.');
        failure = 'Reinstall did not finish. Data and original receipts were retained. Inspect bosun install status and stop any separately launched foreground/nohup daemon; never replay an unknown service operation.';
        options.write(`Selected replacement release: ${version}\nSource executable: ${options.binary}\n`);
        if (!await retireInstallation({ ...options, confirm, async prepareReplacement() {
          selectedBinary = stageInstallerBinary(options, options.binary);
          await probeInstallationBinary({ binary: inspectBinary(selectedBinary), runtimeHome: options.paths.home, version }, options.env, options.signal ?? new AbortController().signal);
        } }, 'reinstall')) {
          const retained = installationStatus(options);
          if (!retained.record || retained.matches !== true || uncertain(retained.record)) return cancelled();
          receipt = retained.record;
        }
      }
    }
    if (!receipt) {
      failure = 'The release executable or destination could not be safely inspected. Use install --binary with an absolute downloaded release path; inspect bosun doctor and bosun install status before retrying.';
      inspectBinary(selectedBinary);
      planInstallationDirectories(home, true);
      const target = path.join(home, '.local', 'bin', 'bosun');
      const previous = previousBinary(target);
      // Inspect service parent paths before even preparing a new runtime.
      for (const directory of [path.join(home, 'Library'), path.join(home, 'Library', 'LaunchAgents')])
        if (exists(directory)) installationDirectory(directory);
      if (fresh) {
        const config = options.setupConfig ?? loadRuntimeConfig(options.paths, options.env);
        if (!await confirm({ kind: 'setup', message: `Prepare a new private runtime at ${runtime}? No hosts or models will be installed.`, initialValue: true })) return cancelled();
        failure = 'Setup did not finish; existing data was retained. Run bosun doctor and inspect setup or upgrade recovery before retrying. Private runtime directories must already have safe ownership and permissions; the installer does not repair them.';
        await setupRuntime(options.paths, config);
      }
      if (previous && !await confirm({ kind: 'replace', message: `Replace the existing unmanaged executable at ${target}, retaining its backup?`, initialValue: false })) return cancelled();
      failure = 'Installation planning could not verify current state. Run bosun doctor and bosun install status; no installation was applied.';
      const plan = planInstallation(options, { requestId: 'wizard_' + crypto.randomUUID(), binary: selectedBinary, replaceExisting: !!previous });
      options.write(`Source: ${plan.binary.path}\nDestination: ${plan.targetBinary}\nBackup: ${plan.previous ? path.join(runtime, 'installation', plan.id, 'previous-binary') : 'not needed (no existing executable)'}\nData home: ${runtime}\nService: prepared only; starting requires separate approval.\n`);
      if (!await confirm({ kind: 'install', message: 'Install this reviewed executable and dormant service definition? Confirm that all Bosun/native clients are stopped and their effects settled.', initialValue: false })) return cancelled();
      failure = 'Installation did not finish or its outcome is unconfirmed. Existing data and receipts were retained. Run bosun doctor and bosun install status; do not replay an uncertain operation.';
      privateDirectory(options.paths.artifacts);
      saveInstallationPlan(path.join(options.paths.artifacts, `install-${plan.id}.json`), plan);
      receipt = (await applyInstallation(options, plan, plan.planHash, true, options.signal)).record;
    }
    if (receipt.state !== 'ready' || uncertain(receipt)) return held('Installation or service outcome is unconfirmed. Run bosun install status and inspect recovery; do not replay the operation.');
    if (receipt.service.state !== 'enabled' && await confirm({ kind: 'start', message: 'Start the owned background service now? Confirm all Bosun/native clients remain stopped and their effects settled.', initialValue: false })) {
      failure = 'Service start did not finish or its outcome is unconfirmed. The executable remains installed. Run bosun install status and review bosun install reconcile; do not retry an unknown service operation.';
      receipt = (await controlInstallationService(options, { id: receipt.id, expectedVersion: receipt.version, hash: receipt.planHash, requestId: 'wizard_' + crypto.randomUUID(), operation: 'enable', clientsStopped: true }, options.signal)).record;
    }
    if (uncertain(receipt)) return held('The service outcome is unconfirmed. Run bosun install status and review bosun install reconcile; do not replay the operation.');
    const service = receipt.service.state;
    if (service !== 'enabled' && service !== 'prepared' && service !== 'disabled')
      return held('The service outcome is unconfirmed. Run bosun install status and review recovery before any service operation.');
    const binary = receipt.targetBinary;
    failure = 'Bosun is installed, but optional tool setup did not finish. Retain tool receipts and inspect the reported tool step; do not repeat an uncertain tool installation or model pull.';
    await options.afterInstall?.();
    if (options.showCompletion !== false) options.write(`Installed executable: ${binary}\nForeground alternative: ${quote(binary)} daemon run\n${service === 'enabled' ? 'The background service is enabled.' : 'Start the foreground daemon in another terminal before using memory commands.'}\nFor this shell session: export PATH=${quote(path.dirname(binary))}:"$PATH"\nFrom the same workspace/directory, try:\n  ${quote(binary)} memory add --category project --title 'First note' --body 'Bosun is running.'\n  ${quote(binary)} memory search Bosun\nOptional host follow-up: ${quote(binary)} onboard\nNo shell configuration, authentication, host selection, or model selection was changed.\n`);
    return { state: 'ready', message: service === 'enabled' ? 'Bosun is installed and the background service is enabled.' : 'Bosun is installed; the background service was not started.', binary, service };
  } catch (error) {
    if (error instanceof BosunError && error.code === 'cancelled' && error.details?.outcome !== 'unknown')
      return { state: 'cancelled', message: 'Installation review cancelled. Retain existing data and receipts; inspect bosun install status before further changes.' };
    return held(failure + (error instanceof BosunError ? `\n${error.message}` : ''));
  }
}
