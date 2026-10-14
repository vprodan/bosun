// Build only the pinned, locally patched native SQLite binding. No package scripts run.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertRuntime, inputsRoot as nativeInputsRoot, inside, PATCH, NATIVE_QUALIFICATION_PATH, regularBytes, sha256, loadInputs, verifyPackage } from './sqlite-native-inputs.mts';
import type { NativeBuildCommand, NativeBuildProvenance } from './sqlite-native-inputs.mts';

interface NativeBuildProcess {
  readonly exited: Promise<number>;
  kill(signal: NodeJS.Signals): void;
}
interface NativeBuildRuntime {
  file(filename: string): Blob;
  spawn(arguments_: string[], options: {
    cwd: string;
    env: Record<string, string>;
    stdin: 'ignore';
    stdout: Blob;
    stderr: Blob;
  }): NativeBuildProcess;
}
declare const Bun: NativeBuildRuntime;

assertRuntime();

const repo = path.resolve(import.meta.dirname, '..');
const inputsRoot = nativeInputsRoot(repo);
const candidate = path.join(inputsRoot, 'candidate/better-sqlite3');
const installed = path.join(repo, 'node_modules/better-sqlite3');
let packageDir = installed;
let hosted = false;
let packageArgument = false;
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--hosted' && !hosted) hosted = true;
  else if (args[index] === '--package-dir' && args[index + 1] && !packageArgument) {
    packageArgument = true;
    packageDir = path.resolve(repo, args[++index]);
  }
  else throw new Error('Usage: bun scripts/build-sqlite-native.mts [--hosted] [--package-dir <candidate or node_modules/better-sqlite3>]');
}
if (![candidate, installed].includes(packageDir)) throw new Error('Package directory is outside the two admitted build targets');
const realRepo = fs.realpathSync(repo);
if (!fs.existsSync(packageDir)) throw new Error('Native package missing; explicitly run sqlite-native-acquire then sqlite-native-prepare before this offline build');
const realPackage = fs.realpathSync(packageDir);
if (!inside(realRepo, realPackage)) throw new Error('Package symlink escapes the checkout');
const patchPath = path.join(repo, PATCH);
let clang = '/Library/Developer/CommandLineTools/usr/bin/clang';
let clangxx = '/Library/Developer/CommandLineTools/usr/bin/clang++';
let linker = '/Library/Developer/CommandLineTools/usr/bin/ld';
let sdk = hosted ? '' : fs.realpathSync('/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk');
let hostedToolchain: NativeBuildProvenance['hostedToolchain'];
if (hosted) {
  const xcrun = '/usr/bin/xcrun';
  const resolve = (arguments_: string[]): string => {
    const result = spawnSync(xcrun, ['--sdk', 'macosx', ...arguments_], {
      cwd: realRepo, env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      encoding: 'utf8', timeout: 30_000, maxBuffer: 4096, shell: false,
    });
    const value = result.stdout?.trim();
    if (result.error || result.status !== 0 || !value || !path.isAbsolute(value) || path.normalize(value) !== value || /[\x00-\x1f\x7f]/.test(value))
      throw new Error(`Installed Xcode resolution failed: ${arguments_.join(' ')}`);
    return value;
  };
  clang = resolve(['--find', 'clang']);
  clangxx = resolve(['--find', 'clang++']);
  linker = resolve(['--find', 'ld']);
  sdk = fs.realpathSync(resolve(['--show-sdk-path']));
  const toolchainRoot = path.dirname(path.dirname(path.dirname(clang)));
  const developerDir = path.dirname(path.dirname(toolchainRoot));
  if (!/^\/Applications\/Xcode[^/]*\.app\/Contents\/Developer$/.test(developerDir) ||
      toolchainRoot !== path.join(developerDir, 'Toolchains/XcodeDefault.xctoolchain') ||
      fs.realpathSync(toolchainRoot) !== toolchainRoot ||
      ![clang, clangxx, linker].every(binary => path.dirname(binary) === path.join(toolchainRoot, 'usr/bin') && inside(toolchainRoot, fs.realpathSync(binary))) ||
      !inside(path.join(developerDir, 'Platforms/MacOSX.platform/Developer/SDKs'), sdk))
    throw new Error('Hosted native build requires one canonical installed Xcode toolchain and macOS SDK');
  const sdkSettings = path.join(sdk, 'SDKSettings.json');
  hostedToolchain = {
    developerDir, toolchainRoot,
    xcrun: { path: xcrun, realpath: fs.realpathSync(xcrun), sha256: sha256(regularBytes(fs.realpathSync(xcrun))) },
    sdkSettings: { path: sdkSettings, realpath: sdkSettings, sha256: sha256(regularBytes(sdkSettings, 64 * 1024)) },
  };
}
const sandbox = '/usr/bin/sandbox-exec';
for (const binary of [clang, clangxx, linker, sandbox]) fs.accessSync(binary, fs.constants.X_OK);
const { archives, patch, packageFiles, selected } = loadInputs(repo);
verifyPackage(realPackage, selected);
// A rebuild cannot inherit a receipt from any earlier output, even if it fails.
if (packageDir === installed && fs.existsSync(path.join(repo, NATIVE_QUALIFICATION_PATH)))
  fs.unlinkSync(path.join(repo, NATIVE_QUALIFICATION_PATH));
const builds = path.join(inputsRoot, 'builds');
fs.mkdirSync(builds, { recursive: true, mode: 0o700 });
if (!inside(realRepo, fs.realpathSync(builds))) throw new Error('Build workspace escapes the checkout');
const work = fs.mkdtempSync(path.join(builds, 'build-'));
fs.chmodSync(work, 0o700);
for (const directory of ['home', 'cache', 'tmp', 'package', 'addon-api', 'headers']) fs.mkdirSync(path.join(work, directory), { mode: 0o700 });
function materialize(root: string, entries: Iterable<readonly [string, Buffer]>): void {
  for (const [name, bytes] of entries) {
    const target = path.join(root, name);
    if (!inside(root, target)) throw new Error('Input path escapes workspace');
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, bytes, { mode: 0o600 });
  }
}
materialize(path.join(work, 'package'), selected);
materialize(path.join(work, 'addon-api'), archives[1].files);
materialize(path.join(work, 'headers'), [...archives[2].files].filter(([name]) => name.startsWith('include/node/')));
const environment = {
  HOME: path.join(work, 'home'), TMPDIR: `${path.join(work, 'tmp')}/`,
  XDG_CACHE_HOME: path.join(work, 'cache'), CLANG_MODULE_CACHE_PATH: path.join(work, 'cache/modules'),
  PATH: `${path.dirname(clang)}:/usr/bin:/bin`, LANG: 'C', LC_ALL: 'C',
  SDKROOT: sdk, MACOSX_DEPLOYMENT_TARGET: '11.0', ZERO_AR_DATE: '1',
};
const literal = (value: string): string => JSON.stringify(value);
const toolchainReads = hostedToolchain
  ? `(subpath ${literal(hostedToolchain.toolchainRoot)}) (subpath ${literal(sdk)})`
  : '(subpath "/Library/Developer/CommandLineTools")';
const profile = `(version 1)
(deny default)
(allow process-fork)
(allow process-exec ${[clang, clangxx, linker, fs.realpathSync(clang), fs.realpathSync(clangxx), fs.realpathSync(linker)].map((binary) => `(literal ${literal(binary)})`).join(' ')})
(allow sysctl-read)
(allow mach-lookup (global-name "com.apple.system.logger"))
; dyld needs the literal root inode, not access to its descendant bytes.
(allow file-read* (literal "/"))
(allow file-read-metadata)
(allow file-map-executable ${toolchainReads} (subpath "/usr/lib") (subpath "/System"))
(allow file-read* (subpath ${literal(work)}) ${toolchainReads} (subpath "/usr/lib") (subpath "/System") (subpath "/dev") (literal "/usr") (literal "/Library") (literal "/Library/Developer") (literal "/etc/localtime") (literal "/private/etc/localtime"))
(allow file-write* (subpath ${literal(work)}) (literal "/dev/null"))
(deny network*)
`;
const profilePath = path.join(work, 'build.sb');
fs.writeFileSync(profilePath, profile, { mode: 0o600 });
const commands: NativeBuildCommand[] = [];
async function run(binary: string, flags: string[], name: string): Promise<void> {
  commands.push({ binary, arguments: flags });
  const child = Bun.spawn([sandbox, '-f', profilePath, binary, ...flags], {
    cwd: work, env: environment, stdin: 'ignore', stdout: Bun.file(path.join(work, `${name}.stdout.log`)), stderr: Bun.file(path.join(work, `${name}.stderr.log`)),
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 300_000);
  const status = await child.exited;
  clearTimeout(timer);
  if (status !== 0) throw new Error(`Native build command ${name} failed (${status}); logs retained in ${work}`);
}
const provenance: NativeBuildProvenance = {
  schema: 1, package: 'better-sqlite3@13.0.3', runtime: `Bun ${process.versions.bun}`,
  platform: 'darwin', architecture: 'arm64', napi: 10, cxx: 'c++20', packageDir: realPackage,
  archives: archives.map(({ name, archiveSha256 }) => ({ name, archiveSha256 })),
  patch: { path: path.relative(repo, patchPath), sha256: sha256(patch) },
  inputFiles: selected.map(([name, bytes]) => ({ name, sha256: sha256(bytes) })),
  toolchain: [clang, clangxx, linker].map((binary) => ({ path: binary, realpath: fs.realpathSync(binary), sha256: sha256(fs.readFileSync(binary)) })),
  sdk, sandboxProfileSha256: sha256(profile), environment, commands, qualification: 'not-run',
  ...(hostedToolchain ? { buildMode: 'hosted' as const, hostedToolchain } : {}),
};
try {
  await run(clang, ['--version'], 'clang-version');
  await run(clangxx, ['--version'], 'clangxx-version');
  const definesFile = packageFiles.get('deps/defines.gypi')!.toString();
  const defines = [...definesFile.matchAll(/^\s*'([A-Z][A-Z0-9_]*(?:=[^']+)?)',?\s*$/gm)].map((match) => `-D${match[1]}`);
  if (!defines.length) throw new Error('No upstream SQLite compile flags found');
  const sqliteDir = 'package/deps/sqlite3';
  const common = ['-arch', 'arm64', '-isysroot', sdk, '-mmacosx-version-min=11.0', '-O3', '-DNDEBUG', '-fPIC', '-fvisibility=hidden', '-flto',
    `-ffile-prefix-map=${work}=/bosun-sqlite-native`, `-fdebug-prefix-map=${work}=/bosun-sqlite-native`];
  await run(clang, [...common, '-std=c99', '-w', ...defines, '-I', sqliteDir, '-c', `${sqliteDir}/sqlite3.c`, '-o', 'sqlite3.o'], 'sqlite');
  await run(clangxx, [...common, '-std=c++20', '-stdlib=libc++', '-fvisibility-inlines-hidden', '-DNAPI_VERSION=10', '-DNAPI_DISABLE_CPP_EXCEPTIONS', '-DNODE_API_SWALLOW_UNTHROWABLE_EXCEPTIONS', '-I', sqliteDir, '-I', 'addon-api', '-I', 'headers/include/node', '-c', 'package/src/better_sqlite3.cpp', '-o', 'better_sqlite3.o'], 'addon');
  const nativeOutput = path.join(work, 'bosun_sqlite.node');
  await run(clangxx, [...common, '-stdlib=libc++', '-bundle', '-undefined', 'dynamic_lookup', '-Wl,-dead_strip', 'better_sqlite3.o', 'sqlite3.o', '-o', 'bosun_sqlite.node'], 'link');
  const output = fs.readFileSync(nativeOutput);
  const release = path.join(realPackage, 'build/Release');
  // Reject existing escaping symlink ancestors before creating output directories.
  for (const directory of [path.join(realPackage, 'build'), release]) {
    if (fs.existsSync(directory) && !inside(realPackage, fs.realpathSync(directory))) throw new Error('Native output directory escapes the package');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const target = path.join(release, 'bosun_sqlite.node');
  const temporary = path.join(release, `.better_sqlite3-${path.basename(work)}.node`);
  fs.writeFileSync(temporary, output, { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, target);
  provenance.output = { path: path.relative(repo, target), sha256: sha256(output), bytes: output.length };
  provenance.status = 'built-not-qualified';
  const provenanceTarget = path.join(release, 'bosun_sqlite.provenance.json');
  const provenanceTemporary = path.join(release, `.bosun_sqlite-${path.basename(work)}.provenance.json`);
  fs.writeFileSync(provenanceTemporary, `${JSON.stringify(provenance, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  fs.renameSync(provenanceTemporary, provenanceTarget);
  console.log(JSON.stringify({ ...provenance.output, provenance: path.relative(repo, path.join(work, 'provenance.json')), qualification: 'not-run' }, null, 2));
} catch (error) {
  provenance.status = 'failed';
  provenance.error = String(error);
  throw error;
} finally {
  fs.writeFileSync(path.join(work, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`, { mode: 0o600 });
  // Fresh HOME/cache/temp never become ambient state for a subsequent build.
  for (const directory of ['home', 'cache', 'tmp']) fs.rmSync(path.join(work, directory), { recursive: true, force: true });
}
