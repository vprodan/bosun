import fs from 'node:fs';
import path from 'node:path';
import type { Env } from '../core/domain/inference.ts';
import type { BinaryIdentity } from '../core/domain/installation.ts';
import { BosunError } from '../core/errors.ts';
import { runtimePaths } from '../platform/paths.ts';
import { loadRuntimeConfig } from '../platform/config.ts';
import { readRuntimeManifest } from '../platform/manifest.ts';
import { protocolBase } from '../platform/http-json.ts';
import { inspectBinary, installationDirectory } from '../platform/installation-files.ts';
import { privateDirectory } from '../platform/private-file.ts';
import {
  checkedToolCommand, inspectOllamaApp, installOllamaDmg, ollamaDmgUrl, optionalToolsDependencies, toolExists,
  type OptionalToolsDependencies,
} from './install-tools-native.ts';
import { assertOptionalToolEffectsSettled, beginOptionalToolEffect, completeOptionalToolEffect, optionalToolHistory } from './install-tools-receipts.ts';

export type OptionalToolsQuestion = { kind: 'inspect' | 'install' | 'start' | 'pull'; message: string; initialValue: boolean };
export type OptionalToolsOptions = {
  env: Env;
  cwd: string;
  confirm: (question: OptionalToolsQuestion) => Promise<boolean>;
  write: (text: string) => void;
  signal?: AbortSignal;
};
type Selection = { command: BinaryIdentity | null; app: string | null; version: string | null };
type EndpointState = { ready: boolean; modelPresent: boolean | null; version: string | null };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

function commandEnvironment(env: Env, endpoint: string): Env {
  const selected: Record<string, string> = { OLLAMA_HOST: endpoint, HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_INSTALL_CLEANUP: '1', HOMEBREW_NO_ANALYTICS: '1', NONINTERACTIVE: '1' };
  // Do not forward unrelated credentials/provider variables to native installers.
  for (const key of ['HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'BOSUN_TEST_RUN_ROOT', 'BOSUN_TEST_NET', 'STUB_OUT']) {
    const value = Object.getOwnPropertyDescriptor(env, key)?.value;
    if (typeof value === 'string') selected[key] = value;
  }
  return selected;
}
async function inspectSelection(deps: OptionalToolsDependencies, options: OptionalToolsOptions, env: Env): Promise<Selection> {
  const explicitApp = options.env.BOSUN_OLLAMA_APP;
  const apps = explicitApp ? [explicitApp] : [path.join(options.env.HOME!, 'Applications', 'Ollama.app'), '/Applications/Ollama.app'];
  const app = apps.find(candidate => toolExists(candidate)) ?? null;
  const commandName = options.env.BOSUN_OLLAMA_COMMAND || 'ollama';
  let command = deps.executable(commandName, env);
  if (!command && !options.env.BOSUN_OLLAMA_COMMAND && app) command = await inspectOllamaApp(deps, app, options.cwd, env);
  if (!command) return { command: null, app, version: null };
  const identity = inspectBinary(command);
  const output = await checkedToolCommand(deps, { command: identity.path, args: ['--version'], cwd: options.cwd, env, timeoutMs: 10000 });
  // Ollama reports the server first and a client warning when they differ.
  // Prefer the executable's explicit client identity, never label it as server.
  const match = output.match(/\bclient version is\s+(\d{1,3}\.\d{1,3}\.\d{1,3}(?:[-+][a-zA-Z0-9.-]{1,32})?)\b/i)
    ?? output.match(/\b(?:ollama version is\s+)?(\d{1,3}\.\d{1,3}\.\d{1,3}(?:[-+][a-zA-Z0-9.-]{1,32})?)\b/i);
  if (!match) throw new BosunError('unavailable', 'The selected Ollama executable did not return an inspectable version');
  return { command: identity, app, version: match[1]! };
}
async function inspectEndpoint(deps: OptionalToolsDependencies, endpoint: string, model: string): Promise<EndpointState> {
  let version: unknown;
  try { version = await deps.metadata(`${endpoint}/api/version`); }
  catch { return { ready: false, modelPresent: null, version: null }; }
  if (!object(version) || typeof version.version !== 'string' || !/^\d{1,3}\.\d{1,3}\.\d{1,3}(?:[-+][a-zA-Z0-9.-]{1,32})?$/.test(version.version))
    throw new BosunError('unavailable', 'The selected endpoint did not return valid Ollama version metadata');
  let tags: unknown;
  try { tags = await deps.metadata(`${endpoint}/api/tags`); }
  catch { return { ready: true, modelPresent: null, version: version.version }; }
  if (!object(tags) || !Array.isArray(tags.models) || tags.models.length > 4096 ||
      tags.models.some(value => !object(value) || typeof value.name !== 'string' && typeof value.model !== 'string'))
    throw new BosunError('unavailable', 'The selected endpoint did not return valid model-list metadata');
  return { ready: true, modelPresent: tags.models.some(value => object(value) && (value.name === model || value.model === model)), version: version.version };
}
function commandUnchanged(identity: BinaryIdentity): void {
  const observed = inspectBinary(identity.path);
  if (observed.dev !== identity.dev || observed.ino !== identity.ino || observed.hash !== identity.hash ||
      observed.mtimeMs !== identity.mtimeMs || observed.ctimeMs !== identity.ctimeMs)
    throw new BosunError('conflict', 'The reviewed optional tool executable changed');
}

/** Owner-approved optional steps; neither inspection nor readiness submits inference. */
export async function runOptionalTools(options: OptionalToolsOptions): Promise<void> {
  await createOptionalTools(optionalToolsDependencies(options.signal))(options);
}
/** Synthetic fixtures inject all process/network effects; production uses the same flow. */
export function createOptionalTools(deps: OptionalToolsDependencies): (options: OptionalToolsOptions) => Promise<void> {
  return async (options) => {
    let active = 'inspection';
    try {
      if (options.env.BOSUN_CALLER === 'model') throw new BosunError('invalid', 'Optional tools require an owner terminal');
      if (!await options.confirm({ kind: 'inspect', message: 'Set up optional Ollama/router tools? Approving permits inspecting the selected Ollama executable/version and endpoint metadata, never inference. Download/install, app launch and model pull each require separate approval.', initialValue: false })) {
        options.write('Declined: optional Ollama/router tools were not inspected or changed. Completed Bosun installation is unaffected.\n');
        return;
      }
      const paths = runtimePaths(options.env);
      const config = loadRuntimeConfig(paths, options.env);
      const endpoint = protocolBase(config.router.url);
      const model = config.router.model;
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,255}$/.test(model))
        throw new BosunError('invalid', 'The exact configured router model cannot be safely passed to the Ollama CLI');
      options.write(`Optional router tools\nEndpoint: ${endpoint}\nExact configured model: ${model}\nConfiguration and explicit BOSUN_ROUTER_URL/model selections will not be changed. Metadata inspection never runs a model.\n`);
      const url = new URL(endpoint);
      if (!['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) {
        options.write('Remote Ollama endpoint selected. No local Ollama installation, startup or model pull will be performed. Install/start Ollama and pull the exact configured model on that remote machine with its owner’s approval.\n');
        return;
      }
      const home = options.env.HOME;
      if (!home || !path.isAbsolute(home) || path.resolve(home) !== home || /[\x00-\x1f\x7f]/.test(home))
        throw new BosunError('invalid', 'A canonical absolute owner HOME is required');
      installationDirectory(home);
      privateDirectory(paths.home);
      privateDirectory(paths.artifacts);
      if (readRuntimeManifest(paths).state !== 'ready') throw new BosunError('unavailable', 'Prepare a ready private Bosun runtime before optional tools');
      assertOptionalToolEffectsSettled(paths.artifacts);
      const env = commandEnvironment(options.env, endpoint);
      let selection = await inspectSelection(deps, options, env);
      let state = await inspectEndpoint(deps, endpoint, model);
      options.write(selection.command ? `Inspected Ollama CLI: ${selection.command.path} (version ${selection.version})\n` : 'Ollama CLI is missing from the selected command/application.\n');
      options.write(state.ready ? `Ollama metadata is reachable (version ${state.version}); model ${state.modelPresent === true ? 'already present' : state.modelPresent === false ? 'not present' : 'presence unconfirmed'}.\n` : 'Selected local Ollama endpoint is not ready.\n');

      // Install identity is local, not endpoint-specific: changing ports must not
      // bypass a lost return from an earlier installation on this same machine.
      const installTarget = path.join(home, 'Applications', 'Ollama.app');
      let installHistory = optionalToolHistory(paths.artifacts, 'install', installTarget);
      if (installHistory.pending)
        throw new BosunError('unavailable', 'An unresolved Ollama install intent prevents further optional tool mutations; observed installation is not original native completion evidence');
      if (!selection.command) {
        if (deps.platform !== 'darwin' || deps.arch !== 'arm64') {
          options.write('Held: automated optional Ollama installation is supported on macOS arm64 only; no installation was attempted.\n');
          return;
        }
        if (options.env.BOSUN_OLLAMA_COMMAND || options.env.BOSUN_OLLAMA_APP && options.env.BOSUN_OLLAMA_APP !== installTarget) {
          options.write('Held: the explicitly selected Ollama command/application is unavailable. It was retained; installation will not substitute a different selection.\n');
          return;
        }
        // Never overwrite an existing app, even when its bundled CLI is absent.
        if (toolExists(installTarget) || !options.env.BOSUN_OLLAMA_APP && toolExists('/Applications/Ollama.app'))
          throw new BosunError('unavailable', 'An existing Ollama app could not be inspected; it was retained without replacement');
        const brewPath = deps.executable('brew', env);
        const brew = brewPath ? inspectBinary(brewPath) : null;
        const applications = path.dirname(installTarget);
        const method = brew ? `existing Homebrew (${brew.path}) using brew install --cask ollama-app with --no-binaries and --appdir=${applications} (no privileged CLI link)` : `the official HTTPS DMG (${ollamaDmgUrl}), verified by codesign and Gatekeeper, into ${installTarget}`;
        if (!await options.confirm({ kind: 'install', message: `Download and install Ollama using ${method}? Download size is unknown and may be large (DMG capped at 2 GiB). Homebrew will not be installed; no sudo or trust bypass is used. This does not approve app launch or model pull.`, initialValue: false })) {
          options.write('Declined: Ollama download/installation was not performed; startup and model pull remain held.\n');
          return;
        }
        active = 'Ollama install';
        installHistory = beginOptionalToolEffect(paths.artifacts, 'install', installTarget);
        if (brew) {
          if (!toolExists(applications)) fs.mkdirSync(applications, { mode: 0o700 });
          installationDirectory(applications);
          commandUnchanged(brew);
          await checkedToolCommand(deps, { command: brew.path, args: ['install', '--cask', 'ollama-app', '--no-binaries', `--appdir=${applications}`], cwd: options.cwd, env, timeoutMs: 1800000 });
          await inspectOllamaApp(deps, installTarget, options.cwd, env);
        } else {
          await installOllamaDmg(deps, { home, artifacts: paths.artifacts, cwd: options.cwd, env });
          options.write('Ollama app installed in your Applications folder. If Ollama asks to move it or create a privileged CLI link, decline; Bosun uses its inspected bundled CLI directly.\n');
        }
        selection = await inspectSelection(deps, options, env);
        if (!selection.command) throw new BosunError('unavailable', 'Ollama installation returned without an inspectable CLI');
        completeOptionalToolEffect(installHistory, `Observed installed CLI ${selection.command.hash} version ${selection.version}`);
        options.write(`Ollama installation observed: ${selection.command.path} (version ${selection.version}). No model was pulled.\n`);
        state = await inspectEndpoint(deps, endpoint, model);
      }

      const startTarget = `${endpoint}\n${selection.app ?? 'no-selected-app'}`;
      const startHistory = optionalToolHistory(paths.artifacts, 'start', startTarget);
      if (startHistory.pending)
        throw new BosunError('unavailable', 'An unresolved Ollama start intent prevents further optional tool mutations; endpoint readiness is not original native completion evidence');
      if (!state.ready) {
        if (deps.platform !== 'darwin' || !selection.app) {
          options.write('Held: no inspected macOS Ollama application is available for launch. Start the selected Ollama service yourself, then rerun this guided step. Bosun does not claim launchd ownership of Ollama.\n');
          return;
        }
        if (url.protocol !== 'http:' || url.port !== '11434') {
          options.write('Held: the selected endpoint uses a custom port/protocol. Starting the default Ollama app would not establish that binding. Start Ollama with your existing endpoint configuration; Bosun will not overwrite it.\n');
          return;
        }
        await inspectOllamaApp(deps, selection.app, options.cwd, env);
        if (!await options.confirm({ kind: 'start', message: `Launch the inspected Ollama app at ${selection.app} using /usr/bin/open -a? Ollama manages its own app/server and may show first-run prompts; Bosun creates no Ollama launchd job. This does not approve a model pull.`, initialValue: false })) {
          options.write('Declined: Ollama app was not launched; model pull remains held because the endpoint is not ready.\n');
          return;
        }
        active = 'Ollama start';
        const intent = beginOptionalToolEffect(paths.artifacts, 'start', startTarget);
        await inspectOllamaApp(deps, selection.app, options.cwd, env);
        await checkedToolCommand(deps, { command: '/usr/bin/open', args: ['-a', selection.app], cwd: options.cwd, env, timeoutMs: 15000 });
        completeOptionalToolEffect(intent, 'Original open command acknowledged and process/group joined; endpoint readiness is inspected separately');
        for (let attempt = 0; attempt < 15; attempt++) {
          state = await inspectEndpoint(deps, endpoint, model);
          if (state.ready) break;
          if (attempt < 14) await deps.sleep(1000);
        }
        if (!state.ready) throw new BosunError('unavailable', 'App launch was acknowledged, but the endpoint is not ready. Finish Ollama first-run setup, then rerun guided tools; no automatic relaunch occurred');
        options.write('Ollama endpoint metadata is ready. No inference was submitted.\n');
      }

      const pullTarget = `${endpoint}\n${model}`;
      const pullHistory = optionalToolHistory(paths.artifacts, 'pull', pullTarget);
      if (pullHistory.pending)
        throw new BosunError('unavailable', 'An unresolved model-pull intent prevents further optional tool mutations; model presence is not original native completion evidence');
      if (state.modelPresent === true) {
        options.write(`Exact configured router model ${model} is already present. No pull or inference was performed. This is metadata availability, not router quality/compatibility qualification.\n`);
        return;
      }
      if (state.modelPresent === null) throw new BosunError('unavailable', 'Model-list metadata is unavailable; model presence is unknown and no pull is authorized');
      if (!await options.confirm({ kind: 'pull', message: `Pull exactly ${model} into the selected local Ollama endpoint ${endpoint}? Download size is unknown and may be many gigabytes; allow adequate disk space and network bandwidth. This downloads model files only, never submits inference, and does not change configuration.`, initialValue: false })) {
        options.write(`Declined: ${model} was not pulled. Ollama remains installed/available as observed; router model setup is incomplete.\n`);
        return;
      }
      active = 'router model pull';
      const intent = beginOptionalToolEffect(paths.artifacts, 'pull', pullTarget);
      if (!selection.command) throw new BosunError('unavailable', 'The selected Ollama command is unavailable');
      commandUnchanged(selection.command);
      await checkedToolCommand(deps, { command: selection.command.path, args: ['pull', model], cwd: options.cwd, env, timeoutMs: 7200000 });
      completeOptionalToolEffect(intent, 'Original pull command acknowledged and process/group joined; model-list metadata is inspected separately');
      state = await inspectEndpoint(deps, endpoint, model);
      if (state.modelPresent !== true) throw new BosunError('unavailable', 'Pull returned but exact configured model presence is unconfirmed');
      options.write(`Exact configured router model ${model} is present after the approved pull. No inference was submitted; model/router quality and compatibility remain independently checked by bosun doctor/router status.\n`);
    } catch (error) {
      const message = error instanceof BosunError ? error.message : 'Ownership, native completion, or durable receipt could not be verified';
      options.write(`Optional tool setup is incomplete; completed Bosun installation is not rolled back. Held during ${active}: ${message}. Existing configuration, apps, model data and intent/receipt artifacts were retained. Any unresolved native intent remains unknown permanently and must not be replayed or automatically settled from observed presence.\n`);
    }
  };
}
