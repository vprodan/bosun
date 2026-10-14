// Reviewed native build inputs only; importing this module never accesses the network.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { gunzipSync } from 'node:zlib';
export interface NativeArchiveInput {
  readonly name: string;
  readonly filename: string;
  readonly url: string;
  readonly sha256: string;
  readonly integrity?: string;
  readonly prefix: string;
}
export interface NativeToolchainInput {
  readonly path: string;
  readonly realpath: string;
  readonly sha256: string;
}
export interface QualifiedNativeBuild {
  readonly sha256: string;
  readonly patchSha256: string;
  readonly runtime: string;
  readonly toolchain: readonly NativeToolchainInput[];
}
export interface NativeArchiveFiles {
  name: string;
  archiveSha256: string;
  files: Map<string, Buffer>;
}
export type NativeSelectedFiles = [name: string, bytes: Buffer][];
export interface NativeSourceInputs {
  archives: NativeArchiveFiles[];
  patch: string;
  packageFiles: Map<string, Buffer>;
  selected: NativeSelectedFiles;
}
export interface VerifiedNativeBuild {
  bytes: Buffer;
  provenanceBytes: Buffer;
  selected: NativeSelectedFiles;
  licenseBytes: Buffer;
  qualificationBytes?: Buffer;
}
export interface NativeBuildCommand {
  binary: string;
  arguments: string[];
}
export interface NativeBuildProvenance {
  schema: 1;
  package: 'better-sqlite3@13.0.3';
  runtime: string;
  platform: 'darwin';
  architecture: 'arm64';
  napi: 10;
  cxx: 'c++20';
  packageDir: string;
  archives: { name: string; archiveSha256: string }[];
  patch: { path: string; sha256: string };
  inputFiles: { name: string; sha256: string }[];
  toolchain: NativeToolchainInput[];
  sdk: string;
  buildMode?: 'hosted';
  hostedToolchain?: { developerDir: string; toolchainRoot: string; xcrun: NativeToolchainInput; sdkSettings: NativeToolchainInput };
  sandboxProfileSha256: string;
  environment: Record<string, string>;
  commands: NativeBuildCommand[];
  qualification: 'not-run';
  output?: { path: string; sha256: string; bytes: number };
  status?: 'built-not-qualified' | 'failed';
  error?: string;
}
export const RUNTIME = '1.4.3';
export const PATCH = 'patches/better-sqlite3@13.0.3.patch';
export const PATCH_SHA256 = 'e1020d35775b701e8c186e0b5073a74b06232ec05f2f90fc99e2d79752007fbf';
// A different output or toolchain requires explicit requalification, never automatic acceptance.
export const QUALIFIED_NATIVE_BUILD: QualifiedNativeBuild = Object.freeze({
  sha256: '554a3ad6a9b55b8c91af529d7832c7c52605511c32a2833f352166a136046c1d',
  patchSha256: 'e1020d35775b701e8c186e0b5073a74b06232ec05f2f90fc99e2d79752007fbf',
  runtime: '1.4.3',
  toolchain: Object.freeze([
    { path: '/Library/Developer/CommandLineTools/usr/bin/clang', realpath: '/Library/Developer/CommandLineTools/usr/bin/clang', sha256: '1590ac950a3d627817d09ade5cb60b2115f17a72182a3141e010b4bcc482a0c9' },
    { path: '/Library/Developer/CommandLineTools/usr/bin/clang++', realpath: '/Library/Developer/CommandLineTools/usr/bin/clang', sha256: '1590ac950a3d627817d09ade5cb60b2115f17a72182a3141e010b4bcc482a0c9' },
    { path: '/Library/Developer/CommandLineTools/usr/bin/ld', realpath: '/Library/Developer/CommandLineTools/usr/bin/ld', sha256: '374d9f0713bce2c8a9e1e82bde51615d5433516a10d99b63107eb6ee70542e4c' },
  ].map((input: NativeToolchainInput) => Object.freeze(input))),
});
export const INPUTS: readonly NativeArchiveInput[] = Object.freeze([
  { name: 'better-sqlite3', filename: 'better-sqlite3.tgz', url: 'https://registry.npmjs.org/better-sqlite3/-/better-sqlite3-13.0.3.tgz', sha256: '77e0513dc1a469fb3bceec4c7fb5ad3f403109787eda05be047ec17fd56868cb', integrity: 'sha512-RbOBxmLBG8uvFUc15X9+9SFemKcQ0WBuISBVkpuiaUB2qblC8UWlHEjdWVoZ8AdhSwmoEgsiXKfopX0CQxaACQ==', prefix: 'package/' },
  { name: 'node-addon-api', filename: 'node-addon-api.tgz', url: 'https://registry.npmjs.org/node-addon-api/-/node-addon-api-8.0.0.tgz', sha256: '49487860e4672b30f2bb5bfd5149ab51b5b98b44e321b2be9d4b77c2e7321b15', integrity: 'sha512-ipO7rsHEBqa9STO5C5T10fj732ml+5kLN1cAG8/jdHd56ldQeGj3Q7+scUS+VHK/qy1zLEwC4wMK5+yM0btPvw==', prefix: 'package/' },
  { name: 'node-api-headers', filename: 'node-api-headers.tgz', url: 'https://nodejs.org/dist/v22.16.0/node-v22.16.0-headers.tar.gz', sha256: 'a60e5a543fab5e5105525948c596d4974c617f39606cef76eb94c3bf1df9a06c', prefix: 'node-v22.16.0/' },
].map((input: NativeArchiveInput) => Object.freeze(input)));
export const NATIVE_QUALIFICATION_PATH = '.omp/tooling/sqlite-native-13.0.3/qualification.json';
export const NATIVE_OUTPUT_PATH = 'node_modules/better-sqlite3/build/Release/bosun_sqlite.node';
export const NATIVE_PROVENANCE_PATH = 'node_modules/better-sqlite3/build/Release/bosun_sqlite.provenance.json';
export const NATIVE_QUALIFICATION_INPUTS = Object.freeze([
  'scripts/qualify-sqlite-native.mts', 'scripts/sqlite-native-inputs.mts',
  'scripts/build-sqlite-native.mts', 'scripts/check-sqlite-library.mts',
  'scripts/test-runtime.cjs', 'scripts/test-env.cjs',
]);
export const NATIVE_LIBRARY_CHECKS = Object.freeze([
  'retainedStatementClose', 'nativeWriterReacquired', 'unfinishedFtsRollback',
  'authorizerDdlDenied', 'callbackErrorIdentity', 'asyncAuthorizerDenied',
  'authorizerReentryDenied', 'authorizerIgnore', 'invalidAuthorizerRecovery',
  'primitiveAuthorizerIdentity', 'authorizerReplacementReprepare', 'udf',
  'exactIntegers', 'allIterateExactIntegers', 'unsafeUdfArgumentDenied',
  'typedArrayBlobParity', 'literalFilename', 'literalBackupFilename',
  'backupNulDenied', 'extensionDenied', 'doubleQuotedStringsDenied',
  'onlineBackup', 'backupTransferCleanupErrorIdentity', 'partiallyRunningBackupClose',
  'noDelayedBackupWrites', 'readonlyBackup', 'immutableUri',
]);
export interface NativeQualificationReceipt {
  schema: 1;
  coverage: 'native-library-smoke';
  trust: 'trusted-workspace-not-hostile-same-user';
  applicationAdmissionLifted: false;
  root: string;
  host: { platform: 'darwin'; architecture: 'arm64'; release: string; hostname: string };
  runtime: { version: string; executable: NativeToolchainInput };
  verifierInputs: { path: string; sha256: string }[];
  output: { path: string; sha256: string; bytes: number };
  provenance: { sha256: string; json: string };
  probe: {
    exitCode: 0; signal: null;
    stdout: string; stdoutSha256: string;
    stderr: string; stderrSha256: string;
    sandboxProfile: string; sandboxProfileSha256: string;
  };
}
export const sha256 = (data: Buffer | string): string => crypto.createHash('sha256').update(data).digest('hex');
export function assertRuntime(): void {
  if (process.versions.bun !== RUNTIME || process.platform !== 'darwin' || process.arch !== 'arm64')
    throw new Error(`Native SQLite requires already installed Bun ${RUNTIME} on macOS arm64; no runtime download or fallback`);
}
export function inputsRoot(repo: string): string { return path.join(repo, '.omp/tooling/sqlite-native-13.0.3'); }
export function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
export function regularBytes(file: string, maximum = 32 * 1024 * 1024): Buffer {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum || fs.realpathSync(file) !== path.resolve(file))
    throw new Error(`Noncanonical or oversized native input: ${file}`);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (stat.dev !== opened.dev || stat.ino !== opened.ino || stat.size !== opened.size) throw new Error('Native input changed');
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (bytes.length !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error('Native input changed');
    return bytes;
  } finally { fs.closeSync(fd); }
}
export function verifyArchive(input: NativeArchiveInput, archive: Buffer): Map<string, Buffer> {
  if (sha256(archive) !== input.sha256 || (input.integrity && `sha512-${crypto.createHash('sha512').update(archive).digest('base64')}` !== input.integrity))
    throw new Error(`Native archive integrity mismatch: ${input.name}`);
  return tarFiles(archive, input.prefix);
}
function tarFiles(archive: Buffer, prefix: string): Map<string, Buffer> {
  const data = gunzipSync(archive);
  const files = new Map<string, Buffer>();
  const text = (buffer: Buffer): string => buffer.toString('utf8').replace(/\0.*$/s, '');
  let longName: string | undefined;
  let paxPath: string | undefined;
  for (let offset = 0; offset + 512 <= data.length;) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = Number.parseInt(text(header.subarray(124, 136)).trim() || '0', 8);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > data.length) throw new Error('Invalid acquired tar size');
    const body = data.subarray(offset + 512, offset + 512 + size);
    const type = String.fromCharCode(header[156]);
    const namePrefix = text(header.subarray(345, 500));
    const name = paxPath ?? longName ?? `${namePrefix ? `${namePrefix}/` : ''}${text(header.subarray(0, 100))}`;
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = text(body).replace(/\n$/, ''); continue; }
    if (type === 'x') {
      let cursor = 0;
      while (cursor < body.length) {
        const space = body.indexOf(32, cursor);
        const length = Number(body.subarray(cursor, space).toString());
        if (space < cursor || !Number.isSafeInteger(length) || length <= 0 || cursor + length > body.length) throw new Error('Invalid tar PAX record');
        const record = body.subarray(space + 1, cursor + length - 1).toString();
        if (record.startsWith('path=')) paxPath = record.slice(5);
        cursor += length;
      }
      continue;
    }
    paxPath = undefined;
    longName = undefined;
    if (type === '5') continue;
    if (type !== '0' && type !== '\0') throw new Error(`Unsupported acquired tar member type ${type}`);
    if (!name.startsWith(prefix)) throw new Error(`Unexpected archive root: ${name}`);
    const relative = name.slice(prefix.length);
    if (!relative || relative.split('/').some((part) => part === '..' || part === '') || path.isAbsolute(relative)) throw new Error(`Unsafe archive member: ${name}`);
    if (files.has(relative)) throw new Error(`Duplicate archive member: ${name}`);
    files.set(relative, Buffer.from(body));
  }
  return files;
}
// Apply ordinary exact-context unified hunks in memory; no patch executable or fuzz.
function patchedFiles(pristine: Map<string, Buffer>, diff: string): Map<string, Buffer> {
  const files = new Map(pristine);
  const lines = diff.split('\n');
  for (let i = 0; i < lines.length;) {
    if (!lines[i].startsWith('--- a/')) { i++; continue; }
    const filename = lines[i++].slice(6);
    if (lines[i++] !== `+++ b/${filename}` || !files.has(filename)) throw new Error('Patch does not target a pristine package file');
    const source = files.get(filename)!.toString('utf8').split('\n');
    const output: string[] = [];
    let cursor = 0;
    while (i < lines.length && lines[i].startsWith('@@ ')) {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i++]);
      if (!match) throw new Error('Invalid patch hunk');
      const start = Number(match[1]) - 1;
      if (start < cursor) throw new Error('Overlapping patch hunks');
      output.push(...source.slice(cursor, start));
      cursor = start;
      let removed = 0;
      let added = 0;
      while (i < lines.length && /^[ +\-]/.test(lines[i]) && !lines[i].startsWith('--- a/')) {
        const line = lines[i++];
        if (line[0] !== '+') {
          if (source[cursor++] !== line.slice(1)) throw new Error(`Patch context mismatch: ${filename}`);
          removed++;
        }
        if (line[0] !== '-') { output.push(line.slice(1)); added++; }
      }
      if (removed !== Number(match[2] ?? 1) || added !== Number(match[4] ?? 1)) throw new Error('Patch hunk counts mismatch');
    }
    output.push(...source.slice(cursor));
    files.set(filename, Buffer.from(output.join('\n')));
  }
  return files;
}
export function loadInputs(repo: string): NativeSourceInputs {
  const root = inputsRoot(repo);
  const archives = INPUTS.map((input) => {
    let bytes: Buffer;
    try { bytes = regularBytes(path.join(root, input.filename)); }
    catch (error) { throw new Error(`Native inputs missing/invalid; explicitly run sh scripts/bun-check.sh sqlite-native-acquire first (${input.name})`, { cause: error }); }
    return { name: input.name, archiveSha256: input.sha256, files: verifyArchive(input, bytes) };
  });
  const patch = regularBytes(path.join(repo, PATCH)).toString('utf8');
  if (sha256(patch) !== PATCH_SHA256) throw new Error('Native SQLite patch differs from the qualified exact patch');
  const packageFiles = patchedFiles(archives[0].files, patch);
  const metadata: { name: string; version: string } = JSON.parse(packageFiles.get('package.json')!.toString()) as { name: string; version: string };
  if (metadata.name !== 'better-sqlite3' || metadata.version !== '13.0.3') throw new Error('Pinned native package identity mismatch');
  const selected = [...packageFiles].filter(([name]) => name.startsWith('src/') || name.startsWith('lib/') || name.startsWith('deps/sqlite3/') || ['package.json', 'binding.gyp', 'deps/defines.gypi', 'deps/common.gypi', 'deps/sqlite3.gyp'].includes(name));
  return { archives, patch, packageFiles, selected };
}
export function verifyPackage(packageDir: string, selected: NativeSelectedFiles): void {
  for (const [name, bytes] of selected) {
    if (!regularBytes(path.join(packageDir, name)).equals(bytes)) throw new Error(`Native package is not the exact patched source: ${name}; run explicit sqlite-native-prepare on a fresh target`);
  }
}
const HASH = /^[0-9a-f]{64}$/;
function exactObject(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0'))
    throw new Error('Malformed native qualification evidence');
}
function canonicalAbsolute(value: unknown): value is string {
  return typeof value === 'string' && value.length < 1024 && path.isAbsolute(value) &&
    path.normalize(value) === value && !/[\x00-\x1f\x7f]/.test(value);
}
function toolInput(value: unknown): asserts value is NativeToolchainInput {
  exactObject(value, ['path', 'realpath', 'sha256']);
  if (!canonicalAbsolute(value.path) || !canonicalAbsolute(value.realpath) ||
      typeof value.sha256 !== 'string' || !HASH.test(value.sha256))
    throw new Error('Malformed native toolchain evidence');
}
export function qualificationVerifierInputs(repo: string): { path: string; sha256: string }[] {
  return NATIVE_QUALIFICATION_INPUTS.map(name => ({ path: name, sha256: sha256(regularBytes(path.join(repo, name), 256 * 1024)) }));
}
export function nativeQualificationHost(): NativeQualificationReceipt['host'] {
  return { platform: 'darwin', architecture: 'arm64', release: os.release(), hostname: os.hostname() };
}
export function nativeQualificationRuntime(): NativeQualificationReceipt['runtime'] {
  const executable = fs.realpathSync(process.execPath);
  return { version: RUNTIME, executable: { path: executable, realpath: executable, sha256: sha256(regularBytes(executable, 256 * 1024 * 1024)) } };
}
export function validateNativeLibraryReport(stdout: string): void {
  if (Buffer.byteLength(stdout) > 32 * 1024) throw new Error('Oversized native library report');
  const report: unknown = JSON.parse(stdout);
  exactObject(report, ['runtime', 'package', 'sqlite', 'selected', ...NATIVE_LIBRARY_CHECKS, 'applicationAdmissionLifted']);
  if (report.runtime !== RUNTIME || report.package !== 'better-sqlite3@13.0.3' ||
      report.selected !== 'node_modules/better-sqlite3' || report.applicationAdmissionLifted !== false ||
      typeof report.sqlite !== 'string' || !/^\d+\.\d+\.\d+$/.test(report.sqlite) ||
      !NATIVE_LIBRARY_CHECKS.every(check => report[check] === true))
    throw new Error('Native library qualification did not pass every required check');
  const [major, minor, patch] = report.sqlite.split('.').map(Number);
  if (major !== 3 || !(minor > 51 || minor === 51 && patch >= 3 || minor === 50 && patch >= 7 || minor === 44 && patch >= 6))
    throw new Error('Native library report lacks the patched WAL engine');
}
export function parseNativeProvenance(json: string): NativeBuildProvenance {
  if (Buffer.byteLength(json) > 512 * 1024) throw new Error('Oversized native provenance');
  const value: unknown = JSON.parse(json);
  const hosted = !!value && typeof value === 'object' && 'buildMode' in value;
  exactObject(value, ['schema', 'package', 'runtime', 'platform', 'architecture', 'napi', 'cxx',
    'packageDir', 'archives', 'patch', 'inputFiles', 'toolchain', 'sdk', 'sandboxProfileSha256',
    'environment', 'commands', 'qualification', 'output', 'status',
    ...(hosted ? ['buildMode', 'hostedToolchain'] : [])]);
  const provenance = value as unknown as NativeBuildProvenance;
  if (provenance.schema !== 1 || provenance.package !== 'better-sqlite3@13.0.3' ||
      provenance.runtime !== `Bun ${RUNTIME}` || provenance.platform !== 'darwin' ||
      provenance.architecture !== 'arm64' || provenance.napi !== 10 || provenance.cxx !== 'c++20' ||
      provenance.status !== 'built-not-qualified' || provenance.qualification !== 'not-run' ||
      !canonicalAbsolute(provenance.packageDir) || !canonicalAbsolute(provenance.sdk) ||
      !HASH.test(provenance.sandboxProfileSha256) || !Array.isArray(provenance.toolchain) ||
      provenance.toolchain.length !== 3 || !Array.isArray(provenance.inputFiles) ||
      !provenance.inputFiles.length || provenance.inputFiles.length > 1024 ||
      JSON.stringify(provenance.archives) !== JSON.stringify(INPUTS.map(({ name, sha256: archiveSha256 }) => ({ name, archiveSha256 }))))
    throw new Error('Native binary/provenance differs from pinned build inputs; explicitly rebuild (no stock prebuild fallback)');
  exactObject(provenance.patch, ['path', 'sha256']);
  exactObject(provenance.output, ['path', 'sha256', 'bytes']);
  if (provenance.patch.path !== PATCH || provenance.patch.sha256 !== PATCH_SHA256 ||
      !(hosted ? [NATIVE_OUTPUT_PATH] : [NATIVE_OUTPUT_PATH, '.omp/tooling/sqlite-native-13.0.3/candidate/better-sqlite3/build/Release/bosun_sqlite.node']).includes(provenance.output.path) ||
      !HASH.test(provenance.output.sha256) ||
      !Number.isSafeInteger(provenance.output.bytes) || provenance.output.bytes < 32 || provenance.output.bytes > 32 * 1024 * 1024)
    throw new Error('Native binary/provenance differs from pinned build inputs; explicitly rebuild (no stock prebuild fallback)');
  const seen = new Set<string>();
  for (const input of provenance.inputFiles) {
    exactObject(input, ['name', 'sha256']);
    if (typeof input.name !== 'string' || input.name.length >= 512 ||
        input.name.split('/').some(part => !part || part === '.' || part === '..') ||
        /[\\\x00-\x1f\x7f]/.test(input.name) || !HASH.test(input.sha256) || seen.has(input.name))
      throw new Error('Malformed native source evidence');
    seen.add(input.name);
  }
  provenance.toolchain.forEach(toolInput);
  exactObject(provenance.environment, ['HOME', 'TMPDIR', 'XDG_CACHE_HOME', 'CLANG_MODULE_CACHE_PATH',
    'PATH', 'LANG', 'LC_ALL', 'SDKROOT', 'MACOSX_DEPLOYMENT_TARGET', 'ZERO_AR_DATE']);
  if (Object.values(provenance.environment).some(value => typeof value !== 'string' || value.length > 2048) ||
      provenance.environment.SDKROOT !== provenance.sdk || provenance.environment.MACOSX_DEPLOYMENT_TARGET !== '11.0' ||
      provenance.environment.ZERO_AR_DATE !== '1' || provenance.environment.LANG !== 'C' || provenance.environment.LC_ALL !== 'C' ||
      !Array.isArray(provenance.commands) || provenance.commands.length !== 5)
    throw new Error('Malformed native build command evidence');
  for (const command of provenance.commands) {
    exactObject(command, ['binary', 'arguments']);
    if (!provenance.toolchain.slice(0, 2).some(tool => tool.path === command.binary) ||
        !Array.isArray(command.arguments) || command.arguments.length > 512 ||
        command.arguments.some(argument => typeof argument !== 'string' || argument.length > 2048))
      throw new Error('Malformed native build command evidence');
  }
  if (hosted) {
    if (provenance.buildMode !== 'hosted') throw new Error('Malformed hosted native provenance');
    exactObject(provenance.hostedToolchain, ['developerDir', 'toolchainRoot', 'xcrun', 'sdkSettings']);
    const { developerDir, toolchainRoot, xcrun, sdkSettings } = provenance.hostedToolchain;
    toolInput(xcrun);
    toolInput(sdkSettings);
    if (!canonicalAbsolute(developerDir) || !/^\/Applications\/Xcode[^/]*\.app\/Contents\/Developer$/.test(developerDir) ||
        toolchainRoot !== path.join(developerDir, 'Toolchains/XcodeDefault.xctoolchain') ||
        xcrun.path !== '/usr/bin/xcrun' || xcrun.realpath !== '/usr/bin/xcrun' ||
        sdkSettings.path !== path.join(provenance.sdk, 'SDKSettings.json') || sdkSettings.realpath !== sdkSettings.path ||
        !inside(path.join(developerDir, 'Platforms/MacOSX.platform/Developer/SDKs'), provenance.sdk) ||
        !provenance.toolchain.every((tool, index) => tool.path === path.join(toolchainRoot, 'usr/bin', ['clang', 'clang++', 'ld'][index]) && inside(toolchainRoot, tool.realpath)))
      throw new Error('Hosted native evidence is outside canonical Xcode paths');
  }
  return provenance;
}
// Inspect exact sources and actual output without granting either admission path.
// Only the explicit qualification command may turn an unqualified build into a receipt.
export function inspectNativeBuild(repo: string): VerifiedNativeBuild {
  const packageDir = path.join(repo, 'node_modules/better-sqlite3');
  const { selected, packageFiles } = loadInputs(repo);
  verifyPackage(packageDir, selected);
  const licenseBytes = regularBytes(path.join(packageDir, 'LICENSE'), 1024 * 1024);
  const pinnedLicense = packageFiles.get('LICENSE');
  if (!pinnedLicense || !licenseBytes.equals(pinnedLicense))
    throw new Error('Native license differs from the pinned archive');
  const bytes = regularBytes(path.join(repo, NATIVE_OUTPUT_PATH));
  const provenanceBytes = regularBytes(path.join(repo, NATIVE_PROVENANCE_PATH), 512 * 1024);
  const provenance = parseNativeProvenance(provenanceBytes.toString('utf8'));
  if (bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf ||
      bytes.readUInt32LE(4) !== 0x0100000c || bytes.readUInt32LE(12) !== 8)
    throw new Error('Native SQLite binding must be one macOS arm64 Mach-O bundle');
  if (provenance.output?.sha256 !== sha256(bytes) || provenance.output.bytes !== bytes.length ||
      JSON.stringify(provenance.inputFiles) !== JSON.stringify(selected.map(([name, bytes]) => ({ name, sha256: sha256(bytes) }))))
    throw new Error('Native binary/provenance differs from pinned build inputs; explicitly rebuild (no stock prebuild fallback)');
  return { bytes, provenanceBytes, selected, licenseBytes };
}
export function validateNativeQualification(bytes: Buffer, workspace?: string): NativeQualificationReceipt {
  if (bytes.length > 1024 * 1024) throw new Error('Oversized native qualification receipt');
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  exactObject(value, ['schema', 'coverage', 'trust', 'applicationAdmissionLifted', 'root', 'host',
    'runtime', 'verifierInputs', 'output', 'provenance', 'probe']);
  const receipt = value as unknown as NativeQualificationReceipt;
  exactObject(receipt.host, ['platform', 'architecture', 'release', 'hostname']);
  exactObject(receipt.runtime, ['version', 'executable']);
  exactObject(receipt.provenance, ['sha256', 'json']);
  exactObject(receipt.output, ['path', 'sha256', 'bytes']);
  exactObject(receipt.probe, ['exitCode', 'signal', 'stdout', 'stdoutSha256', 'stderr', 'stderrSha256', 'sandboxProfile', 'sandboxProfileSha256']);
  toolInput(receipt.runtime.executable);
  if (receipt.schema !== 1 || receipt.coverage !== 'native-library-smoke' ||
      receipt.trust !== 'trusted-workspace-not-hostile-same-user' || receipt.applicationAdmissionLifted !== false ||
      !canonicalAbsolute(receipt.root) || receipt.host.platform !== 'darwin' || receipt.host.architecture !== 'arm64' ||
      typeof receipt.host.release !== 'string' || !receipt.host.release || receipt.host.release.length > 256 ||
      typeof receipt.host.hostname !== 'string' || !receipt.host.hostname || receipt.host.hostname.length > 256 ||
      receipt.runtime.version !== RUNTIME || receipt.runtime.executable.path !== receipt.runtime.executable.realpath ||
      receipt.probe.exitCode !== 0 || receipt.probe.signal !== null ||
      typeof receipt.probe.stdout !== 'string' || typeof receipt.probe.stderr !== 'string' ||
      Buffer.byteLength(receipt.probe.stderr) > 32 * 1024 ||
      typeof receipt.probe.sandboxProfile !== 'string' || Buffer.byteLength(receipt.probe.sandboxProfile) > 32 * 1024 ||
      !receipt.probe.sandboxProfile.startsWith('(version 1)\n') ||
      receipt.probe.stdoutSha256 !== sha256(receipt.probe.stdout) ||
      receipt.probe.stderrSha256 !== sha256(receipt.probe.stderr) ||
      receipt.probe.sandboxProfileSha256 !== sha256(receipt.probe.sandboxProfile) ||
      typeof receipt.provenance.json !== 'string' || receipt.provenance.sha256 !== sha256(receipt.provenance.json))
    throw new Error('Malformed or tampered native qualification receipt');
  validateNativeLibraryReport(receipt.probe.stdout);
  const provenance = parseNativeProvenance(receipt.provenance.json);
  if (provenance.buildMode !== 'hosted' || provenance.packageDir !== path.join(receipt.root, 'node_modules/better-sqlite3') ||
      JSON.stringify(receipt.output) !== JSON.stringify(provenance.output))
    throw new Error('Native qualification receipt differs from hosted build provenance');
  if (!Array.isArray(receipt.verifierInputs) || receipt.verifierInputs.length !== NATIVE_QUALIFICATION_INPUTS.length)
    throw new Error('Stale native qualification verifier');
  for (const input of receipt.verifierInputs) exactObject(input, ['path', 'sha256']);
  const currentVerifierInputs = qualificationVerifierInputs(path.resolve(import.meta.dirname, '..'));
  if (JSON.stringify(receipt.verifierInputs) !== JSON.stringify(currentVerifierInputs))
    throw new Error('Stale native qualification verifier');
  if (workspace) {
    assertRuntime();
    if (receipt.root !== fs.realpathSync(receipt.root) ||
        JSON.stringify(receipt.host) !== JSON.stringify(nativeQualificationHost()) ||
        JSON.stringify(receipt.runtime) !== JSON.stringify(nativeQualificationRuntime()) ||
        JSON.stringify(receipt.verifierInputs) !== JSON.stringify(qualificationVerifierInputs(workspace)) ||
        sha256(regularBytes(path.join(workspace, NATIVE_OUTPUT_PATH))) !== receipt.output.sha256 ||
        sha256(regularBytes(path.join(workspace, NATIVE_PROVENANCE_PATH), 512 * 1024)) !== receipt.provenance.sha256)
      throw new Error('Stale native qualification workspace/runtime/output');
    // Exact-content build snapshots may reuse same-host evidence, but cannot
    // rewrite its issuer root or outlive the issuer's actual source/output.
    if (fs.realpathSync(workspace) !== receipt.root) {
      const issuer = inspectNativeBuild(receipt.root);
      verifyPackage(path.join(workspace, 'node_modules/better-sqlite3'), issuer.selected);
      if (sha256(issuer.bytes) !== receipt.output.sha256 ||
          sha256(issuer.provenanceBytes) !== receipt.provenance.sha256 ||
          !regularBytes(path.join(receipt.root, NATIVE_QUALIFICATION_PATH), 1024 * 1024).equals(bytes) ||
          sha256(regularBytes(path.join(workspace, PATCH))) !== PATCH_SHA256 ||
          !INPUTS.every(input => sha256(regularBytes(path.join(inputsRoot(workspace), input.filename))) === input.sha256) ||
          JSON.stringify(receipt.verifierInputs) !== JSON.stringify(qualificationVerifierInputs(receipt.root)))
        throw new Error('Stale native qualification issuer workspace');
    }
    for (const tool of [...provenance.toolchain, provenance.hostedToolchain!.xcrun, provenance.hostedToolchain!.sdkSettings]) {
      if (fs.realpathSync(tool.path) !== tool.realpath || sha256(regularBytes(tool.realpath, 512 * 1024 * 1024)) !== tool.sha256)
        throw new Error('Native qualification toolchain changed');
    }
    for (const directory of [provenance.sdk, provenance.hostedToolchain!.toolchainRoot])
      if (!fs.lstatSync(directory).isDirectory() || fs.realpathSync(directory) !== directory)
        throw new Error('Native qualification SDK/toolchain changed');
  }
  return receipt;
}
export function verifyNativeBuild(repo: string): VerifiedNativeBuild {
  const native = inspectNativeBuild(repo);
  const provenance = parseNativeProvenance(native.provenanceBytes.toString('utf8'));
  const qualificationFile = path.join(repo, NATIVE_QUALIFICATION_PATH);
  // An explicit receipt must be valid; malformed/stale evidence cannot fall back to local pins.
  if (fs.lstatSync(qualificationFile, { throwIfNoEntry: false })) {
    const qualificationBytes = regularBytes(qualificationFile, 1024 * 1024);
    validateNativeQualification(qualificationBytes, repo);
    return { ...native, qualificationBytes };
  }
  if (!QUALIFIED_NATIVE_BUILD || QUALIFIED_NATIVE_BUILD.patchSha256 !== PATCH_SHA256 ||
      QUALIFIED_NATIVE_BUILD.runtime !== RUNTIME || provenance.buildMode ||
      sha256(native.bytes) !== QUALIFIED_NATIVE_BUILD.sha256 ||
      JSON.stringify(provenance.toolchain) !== JSON.stringify(QUALIFIED_NATIVE_BUILD.toolchain))
    throw new Error('Native output/toolchain is outside fixed-output admission; explicit hosted requalification is required');
  // Local fixed-output pins remain admission evidence, not full runtime qualification.
  return native;
}
