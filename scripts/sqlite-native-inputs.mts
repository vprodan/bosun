// Reviewed native build inputs only; importing this module never accesses the network.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
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
export function verifyNativeBuild(repo: string): VerifiedNativeBuild {
  if (!QUALIFIED_NATIVE_BUILD || !/^[0-9a-f]{64}$/.test(QUALIFIED_NATIVE_BUILD.sha256) ||
      QUALIFIED_NATIVE_BUILD.patchSha256 !== PATCH_SHA256 || QUALIFIED_NATIVE_BUILD.runtime !== RUNTIME ||
      !Array.isArray(QUALIFIED_NATIVE_BUILD.toolchain) || QUALIFIED_NATIVE_BUILD.toolchain.length !== 3)
    throw new Error('Native SQLite fixed-output admission is pending; no distribution is admitted');
  const packageDir = path.join(repo, 'node_modules/better-sqlite3');
  const { selected } = loadInputs(repo);
  verifyPackage(packageDir, selected);
  const release = path.join(packageDir, 'build/Release');
  const bytes = regularBytes(path.join(release, 'bosun_sqlite.node'));
  const provenanceBytes = regularBytes(path.join(release, 'bosun_sqlite.provenance.json'), 4 * 1024 * 1024);
  const provenance: NativeBuildProvenance = JSON.parse(provenanceBytes.toString('utf8')) as NativeBuildProvenance;
  if (sha256(bytes) !== QUALIFIED_NATIVE_BUILD.sha256 ||
      JSON.stringify(provenance.toolchain) !== JSON.stringify(QUALIFIED_NATIVE_BUILD.toolchain))
    throw new Error('Native output/toolchain is outside fixed-output admission; explicit requalification is required');
  if (bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf ||
      bytes.readUInt32LE(4) !== 0x0100000c || bytes.readUInt32LE(12) !== 8)
    throw new Error('Native SQLite binding must be one macOS arm64 Mach-O bundle');
  if (provenance.schema !== 1 || provenance.package !== 'better-sqlite3@13.0.3' || provenance.runtime !== `Bun ${RUNTIME}` || provenance.platform !== 'darwin' || provenance.architecture !== 'arm64' || provenance.napi !== 10 || provenance.cxx !== 'c++20' || provenance.status !== 'built-not-qualified' || provenance.qualification !== 'not-run' || provenance.patch?.sha256 !== PATCH_SHA256 || provenance.patch?.path !== PATCH || provenance.output?.sha256 !== sha256(bytes) || provenance.output?.bytes !== bytes.length || JSON.stringify(provenance.archives) !== JSON.stringify(INPUTS.map(({ name, sha256: archiveSha256 }) => ({ name, archiveSha256 }))) || JSON.stringify(provenance.inputFiles) !== JSON.stringify(selected.map(([name, bytes]) => ({ name, sha256: sha256(bytes) }))))
    throw new Error('Native binary/provenance differs from pinned build inputs; explicitly rebuild (no stock prebuild fallback)');
  // Build provenance is an inventory/integrity binding, not a claim of runtime qualification.
  return { bytes, provenanceBytes, selected };
}
