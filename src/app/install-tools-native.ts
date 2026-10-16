import fs from 'node:fs';
import path from 'node:path';
import type { Env } from '../core/domain/inference.ts';
import { BosunError } from '../core/errors.ts';
import { executable, streamProcess } from '../platform/process.ts';
import { httpJson } from '../platform/http-json.ts';
import { inspectBinary, installationDirectory } from '../platform/installation-files.ts';
import { privateDirectory } from '../platform/private-file.ts';

export type OptionalToolCommand = {
  command: string; args: readonly string[]; cwd: string; env: Env; timeoutMs: number;
};
export type OptionalToolCommandResult = { code: number | null; output: string };
/** All subprocess/network/time effects are replaceable by contained synthetic fixtures. */
export type OptionalToolsDependencies = {
  platform: string;
  arch: string;
  executable: (command: string, env: Env) => string | null;
  run: (command: OptionalToolCommand) => Promise<OptionalToolCommandResult>;
  metadata: (url: string) => Promise<unknown>;
  download: (url: string, destination: string) => Promise<void>;
  sleep: (milliseconds: number) => Promise<void>;
};
export const ollamaDmgUrl = 'https://ollama.com/download/Ollama.dmg';
const downloadLimit = 2 * 1024 * 1024 * 1024;
const unavailable = (message: string) => new BosunError('unavailable', message);
export function toolExists(file: string): boolean {
  try { fs.lstatSync(file); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

async function downloadDmg(url: string, destination: string): Promise<void> {
  privateDirectory(path.dirname(destination));
  const allowed: Readonly<Record<string, true>> = { 'ollama.com': true, 'github.com': true, 'release-assets.githubusercontent.com': true, 'objects.githubusercontent.com': true };
  const signal = AbortSignal.timeout(15 * 60 * 1000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let fd: number | undefined;
  try {
    for (let redirects = 0; redirects <= 5; redirects++) {
      const selected = new URL(url);
      if (selected.protocol !== 'https:' || selected.username || selected.password || selected.port || allowed[selected.hostname] !== true)
        throw unavailable('Ollama download location is not approved');
      const response = await fetch(selected, { redirect: 'manual', signal });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location || redirects === 5) throw unavailable('Ollama download redirect limit reached');
        url = new URL(location, selected).href;
        continue;
      }
      const length = response.headers.get('content-length');
      if (!response.ok || length !== null && (!/^\d+$/.test(length) || Number(length) > downloadLimit)) {
        await response.body?.cancel();
        throw unavailable('Ollama download failed or exceeds the 2 GiB limit');
      }
      reader = response.body?.getReader();
      if (!reader) throw unavailable('Ollama download body unavailable');
      fd = fs.openSync(destination, 'wx', 0o600);
      let bytes = 0;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > downloadLimit) throw unavailable('Ollama download exceeds the 2 GiB limit');
        let offset = 0;
        while (offset < chunk.value.byteLength) {
          const written = fs.writeSync(fd, chunk.value, offset, chunk.value.byteLength - offset);
          if (written < 1) throw unavailable('Ollama download write unavailable');
          offset += written;
        }
      }
      if (bytes === 0 || length !== null && bytes !== Number(length)) throw unavailable('Ollama download is incomplete');
      fs.fsyncSync(fd);
      return;
    }
    throw unavailable('Ollama download unavailable');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { await reader?.cancel(); } catch { /* finite aborted download */ }
    reader?.releaseLock();
  }
}
export function optionalToolsDependencies(): OptionalToolsDependencies {
  return {
    platform: process.platform,
    arch: process.arch,
    executable,
    async run(spec) {
      let output = ''; let code: number | null = null;
      for await (const event of streamProcess({ ...spec, signal: new AbortController().signal, maxOutputBytes: 4194304, maxLineBytes: 262144 })) {
        if (event.t === 'line') output += event.text + '\n'; else code = event.code;
      }
      return { code, output };
    },
    metadata: (url) => httpJson(url, { method: 'GET', signal: new AbortController().signal }, 1500, 1048576),
    download: downloadDmg,
    sleep(milliseconds) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, milliseconds);
      return promise;
    },
  };
}
export async function checkedToolCommand(deps: OptionalToolsDependencies, spec: OptionalToolCommand): Promise<string> {
  const result = await deps.run(spec);
  if (result.code !== 0) throw unavailable('Optional tool command did not confirm completion');
  return result.output;
}
async function verifyOllamaSignature(deps: OptionalToolsDependencies, app: string, cwd: string, env: Env): Promise<void> {
  for (const [command, args] of [
    ['/usr/bin/codesign', ['--verify', '--deep', '--strict', app]],
    ['/usr/sbin/spctl', ['--assess', '--type', 'execute', app]],
  ] as const) await checkedToolCommand(deps, { command, args, cwd, env, timeoutMs: 60000 });
}
export async function inspectOllamaApp(deps: OptionalToolsDependencies, app: string, cwd: string, env: Env): Promise<string> {
  if (!path.isAbsolute(app) || path.resolve(app) !== app || /[\x00-\x1f\x7f]/.test(app))
    throw unavailable('Select a canonical absolute Ollama application path');
  const stat = fs.lstatSync(app);
  if (!stat.isDirectory() || fs.realpathSync(app) !== app || (stat.mode & 0o022) !== 0 ||
      process.getuid && stat.uid !== 0 && stat.uid !== process.getuid())
    throw unavailable('Ollama application ownership is unavailable');
  await verifyOllamaSignature(deps, app, cwd, env);
  return inspectBinary(path.join(app, 'Contents', 'Resources', 'ollama')).path;
}

/** Mount read-only, verify Apple's trust assessment before copying, publish without replacement. */
export async function installOllamaDmg(
  deps: OptionalToolsDependencies, options: { home: string; artifacts: string; cwd: string; env: Env },
): Promise<string> {
  installationDirectory(options.home);
  privateDirectory(options.artifacts);
  const applications = path.join(options.home, 'Applications');
  if (!toolExists(applications)) fs.mkdirSync(applications, { mode: 0o700 });
  installationDirectory(applications);
  const target = path.join(applications, 'Ollama.app');
  if (toolExists(target)) throw unavailable('Existing Ollama application was retained; it will not be overwritten');
  // Retained stages live in runtime artifacts for recovery. The app directory is
  // reserved exclusively only after signature/trust verification of the mount.
  const stage = fs.mkdtempSync(path.join(options.artifacts, '.ollama-stage-'));
  fs.chmodSync(stage, 0o700);
  const dmg = path.join(stage, 'Ollama.dmg');
  const mount = path.join(stage, 'mount');
  fs.mkdirSync(mount, { mode: 0o700 });
  let completed = false;
  try {
    await deps.download(ollamaDmgUrl, dmg);
    await checkedToolCommand(deps, { command: '/usr/bin/hdiutil', args: ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, dmg], cwd: options.cwd, env: options.env, timeoutMs: 120000 });
    const source = path.join(mount, 'Ollama.app');
    // Image filesystem UIDs belong to its publisher, not necessarily this user.
    // Read-only mount + canonical source + native signature/trust are admission;
    // the copied app and executable must separately pass local ownership checks.
    if (!fs.lstatSync(source).isDirectory() || fs.realpathSync(source) !== source)
      throw unavailable('Mounted Ollama application is not a canonical directory');
    await verifyOllamaSignature(deps, source, options.cwd, options.env);
    installationDirectory(applications);
    // Exclusive mkdir, rather than mv/copy-to-directory semantics, cannot merge
    // into or replace a foreign app that appears after the initial inspection.
    fs.mkdirSync(target, { mode: 0o700 });
    const before = fs.lstatSync(target);
    const fd = fs.openSync(applications, fs.constants.O_RDONLY);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    await checkedToolCommand(deps, { command: '/usr/bin/ditto', args: ['--rsrc', '--extattr', source, target], cwd: options.cwd, env: options.env, timeoutMs: 180000 });
    const after = fs.lstatSync(target);
    if (after.dev !== before.dev || after.ino !== before.ino) throw unavailable('Ollama destination identity changed');
    await inspectOllamaApp(deps, target, options.cwd, options.env);
    await checkedToolCommand(deps, { command: '/usr/bin/hdiutil', args: ['detach', mount], cwd: options.cwd, env: options.env, timeoutMs: 60000 });
    completed = true;
    return target;
  } finally {
    // An error can leave an original native producer unconfirmed. Never detach
    // its image or recurse through that mount; retain the private stage for review.
    if (completed) fs.rmSync(stage, { recursive: true, force: false });
  }
}
