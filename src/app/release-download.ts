import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createInflateRaw, createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { BosunError } from '../core/errors.ts';
import type { Env } from '../core/domain/inference.ts';
import { privateDirectory } from '../platform/private-file.ts';
import { executable, streamProcess } from '../platform/process.ts';
import type { ProcessEvent, ProcessSpec } from '../platform/process.ts';

export interface ReleaseDownloadQuestion { message: string; initialValue: boolean }
export interface ReleaseDownloadOptions {
  env: Env;
  /** Existing canonical owner-only parent; each approved download gets a new private child. */
  directory: string;
  currentVersion?: string;
  confirm(question: ReleaseDownloadQuestion): Promise<boolean>;
  write(text: string): void;
}
export type ReleaseDownloadResult =
  | { state: 'downloaded'; binary: string; version: string; releaseUrl: string }
  | { state: 'current' | 'newer-installed'; binary: null; version: string; releaseUrl: string };
export interface ReleaseDownloadDependencies {
  fetch(url: string, options: RequestInit): Promise<Response>;
  executable(command: string, env: Env): string | null;
  process(spec: ProcessSpec): AsyncIterable<ProcessEvent>;
  platform: string;
  architecture: string;
}
interface GithubAsset { id: number; name: string; size: number; digest: string }
interface GithubRelease { id: number; tag: string; version: string; url: string; assets: GithubAsset[] }
interface Member { path: string; bytes: number; sha256: string }
interface ZipMember extends Member { offset: number; compressed: number; method: number }

const MIB = 1024 * 1024;
const MAX = 300 * MIB;
const METADATA = 4 * MIB;
const API = 'https://api.github.com';
const REPOSITORY = 'repos/vprodan/bosun';
const VERSION = /^(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})$/;
const HASH = /^[0-9a-f]{64}$/;
const hash = (bytes: Uint8Array | string): string => crypto.createHash('sha256').update(bytes).digest('hex');
function integrity(condition: unknown, message: string): asserts condition {
  if (!condition) throw new BosunError('unverified', `Release integrity check failed: ${message}. No binary was installed or started.`);
}
function object(value: unknown): Record<string, unknown> {
  integrity(value !== null && typeof value === 'object' && !Array.isArray(value), 'expected an object');
  return value as Record<string, unknown>;
}
function safeName(name: string): boolean {
  return name.length > 0 && name.length < 512 && !/[\\:\x00-\x1f\x7f]/.test(name)
    && name.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}
function text(bytes: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new BosunError('unverified', 'Release metadata is not valid UTF-8. No binary was installed or started.'); }
}
// JSON.parse alone silently accepts duplicate keys. Scan the bounded document first,
// keeping decoded keys per object (including escaped equivalents) and bounding nesting.
function json(bytes: Uint8Array): unknown {
  integrity(bytes.byteLength <= METADATA, 'oversized JSON');
  const source = text(bytes); let cursor = 0;
  const literal = /(?:null|true|false|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/y;
  function whitespace(): void { while (/[\t\n\r ]/.test(source[cursor] ?? '\0')) cursor++; }
  function string(): string {
    const start = cursor++;
    while (cursor < source.length) {
      const char = source[cursor++];
      if (char === '\\') { cursor++; continue; }
      if (char === '"') return JSON.parse(source.slice(start, cursor)) as string;
    }
    throw new Error('unterminated JSON string');
  }
  function value(depth: number): void {
    integrity(depth <= 64, 'JSON nesting limit'); whitespace();
    const char = source[cursor];
    if (char === '"') { string(); return; }
    if (char === '{' || char === '[') {
      cursor++; whitespace(); const end = char === '{' ? '}' : ']'; const keys = new Set<string>();
      if (source[cursor] === end) { cursor++; return; }
      for (;;) {
        if (char === '{') {
          whitespace(); integrity(source[cursor] === '"', 'invalid JSON key');
          const key = string(); integrity(!keys.has(key), 'duplicate JSON key'); keys.add(key);
          whitespace(); integrity(source[cursor++] === ':', 'invalid JSON object');
        }
        value(depth + 1); whitespace();
        if (source[cursor] === end) { cursor++; return; }
        integrity(source[cursor++] === ',', 'invalid JSON separator');
      }
    }
    literal.lastIndex = cursor; const match = literal.exec(source);
    integrity(match, 'invalid JSON value'); cursor = literal.lastIndex;
  }
  try { value(0); whitespace(); integrity(cursor === source.length, 'trailing JSON data'); return JSON.parse(source) as unknown; }
  catch (error) { if (error instanceof BosunError) throw error; throw new BosunError('unverified', 'Release metadata is invalid JSON. No binary was installed or started.'); }
}
const digestSchema = z.string().regex(HASH);
const relativeSchema = z.string().refine(safeName);
const memberSchema = z.object({ path: relativeSchema, bytes: z.number().int().positive().max(MAX), sha256: digestSchema }).strict();
const assetSchema = z.object({ name: relativeSchema, bytes: z.number().int().positive().max(MAX), sha256: digestSchema }).strict();
const sourceSchema = z.object({
  project: z.string().max(256), commit: z.string().regex(/^[0-9a-f]{40}$/),
  bun: z.object({ version: z.string().max(64), commit: z.string().regex(/^[0-9a-f]{7,40}$/), url: z.string().max(256) }).strict(),
  sqlite: z.object({
    archives: z.array(z.object({ name: z.string().max(64), url: z.string().url().max(256), sha256: digestSchema }).strict()).length(3),
    patch: z.object({ path: relativeSchema, sha256: digestSchema }).strict(), publicDomain: z.literal('https://www.sqlite.org/copyright.html'),
  }).strict(),
}).strict();
const packageSchema = z.object({
  name: z.string().regex(/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/).max(256),
  version: z.string().regex(/^[0-9A-Za-z.+-]+$/).max(64), source: z.string().url().max(1024),
  files: z.array(relativeSchema).min(1).max(32),
}).strict();
const releaseSchema = z.object({
  schema: z.literal(1), product: z.literal('bosun'), tag: z.string().max(32), version: z.string().regex(VERSION),
  commit: z.string().regex(/^[0-9a-f]{40}$/), target: z.literal('bun-darwin-arm64'),
  runtimeQualification: z.literal('unverified'), compiledSafety: z.literal('passed'),
  binarySha256: digestSchema, buildSha256: digestSchema, qualificationSha256: digestSchema,
  originalArchive: z.object({ name: relativeSchema, sha256: digestSchema }).strict(),
  source: sourceSchema, packages: z.array(packageSchema).min(1).max(1000),
  members: z.array(memberSchema).min(7).max(1000), assets: z.array(assetSchema).length(2),
}).strict();
const inputSchema = z.object({ path: relativeSchema, bytes: z.number().int().min(0).max(32 * MIB), sha256: digestSchema }).strict();
const buildSchema = z.object({
  schema: z.literal(1), product: z.literal('bosun'), version: z.string().regex(VERSION), target: z.literal('bun-darwin-arm64'),
  compiler: z.object({ version: z.string().max(64), sha256: digestSchema }).strict(),
  flags: z.array(z.string().max(128)).max(32), inputs: z.array(inputSchema).min(1).max(20000),
  sourceDigest: digestSchema, dependenciesDigest: digestSchema, assetsDigest: digestSchema,
  binary: z.object({ bytes: z.number().int().positive().max(MAX), sha256: digestSchema }).strict(),
  developmentDebugger: z.literal('disabled-before-imports'), runtimeQualification: z.literal('unverified'),
  nativeQualification: z.object({ sha256: digestSchema, receiptJson: z.string().max(METADATA) }).strict().optional(),
}).strict();
const qualificationSchema = z.object({
  version: z.string().regex(VERSION), binarySha256: digestSchema, scope: z.literal('compiled-local-release-safety'),
  checks: z.array(z.union([
    z.object({ name: z.enum(['version', 'help', 'private-hook', 'private-route', 'mcp', 'shutdown-and-reacquire']), passed: z.literal(true) }).strict(),
    z.object({ name: z.literal('storage-privacy'), passed: z.literal(true), requests: z.literal(7), originalMutations: z.literal(2),
      privateOwnerReadable: z.literal(true), modelPrivateOverrideRejected: z.literal(true), modelPrivateSearchExcluded: z.literal(true),
      modelPrivateContextExcluded: z.literal(true), ownerStatusReceived: z.literal(true) }).strict(),
    z.object({ name: z.literal('public-hook'), passed: z.literal(true), notes: z.literal(10000), injections: z.literal(21) }).strict(),
  ])).length(8),
  allJoined: z.literal(true), liveHosts: z.literal(false), liveModels: z.literal(false), personalActivation: z.literal(false),
}).strict();
function decode<T>(schema: z.ZodType<T>, bytes: Uint8Array): T {
  const result = schema.safeParse(json(bytes)); integrity(result.success, 'unsupported or malformed closed manifest'); return result.data;
}
function githubRelease(bytes: Uint8Array): GithubRelease {
  const release = object(json(bytes));
  integrity(Number.isSafeInteger(release.id) && Number(release.id) > 0 && release.draft === false && release.prerelease === false,
    'latest release is not a published stable release');
  integrity(typeof release.tag_name === 'string' && release.tag_name.startsWith('v') && VERSION.test(release.tag_name.slice(1)), 'invalid stable version tag');
  const tag = release.tag_name; const version = tag.slice(1); const url = `https://github.com/vprodan/bosun/releases/tag/${tag}`;
  integrity(release.html_url === url && release.url === `${API}/${REPOSITORY}/releases/${release.id}`, 'unexpected repository/release URL');
  const names = [`bosun-${version}-darwin-arm64.zip`, 'release.json', 'SHA256SUMS', 'RELEASE_NOTES.md'];
  integrity(Array.isArray(release.assets) && release.assets.length === names.length, 'unexpected or missing release assets');
  const assets: GithubAsset[] = []; const ids = new Set<number>();
  for (const value of release.assets) {
    const asset = object(value);
    integrity(typeof asset.name === 'string' && names.includes(asset.name) && !assets.some(previous => previous.name === asset.name), 'unexpected or duplicate release asset');
    integrity(Number.isSafeInteger(asset.id) && Number(asset.id) > 0 && !ids.has(Number(asset.id)) && asset.state === 'uploaded', 'invalid asset identity/state');
    integrity(Number.isSafeInteger(asset.size) && Number(asset.size) > 0 && Number(asset.size) <= (asset.name.endsWith('.zip') ? MAX : asset.name === 'SHA256SUMS' ? 1024 : METADATA), 'oversized release asset');
    integrity(typeof asset.digest === 'string' && /^sha256:[0-9a-f]{64}$/.test(asset.digest), 'GitHub asset SHA256 digest is missing; ask the publisher to publish verified digest-bearing assets');
    integrity(asset.url === `${API}/${REPOSITORY}/releases/assets/${asset.id}`
      && asset.browser_download_url === `https://github.com/vprodan/bosun/releases/download/${tag}/${asset.name}`, 'unexpected asset URL');
    ids.add(Number(asset.id)); assets.push({ id: Number(asset.id), name: asset.name, size: Number(asset.size), digest: asset.digest.slice(7) });
  }
  assets.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return { id: Number(release.id), tag, version, url, assets };
}
function absent(file: string): void {
  try { fs.lstatSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  throw new BosunError('conflict', 'Release download destination already contains an artifact. Choose a new empty private download directory; nothing was overwritten.');
}
function readAt(fd: number, offset: number, size: number): Buffer {
  const buffer = Buffer.alloc(size); let count = 0;
  while (count < size) { const n = fs.readSync(fd, buffer, count, size - count, offset + count); integrity(n > 0, 'truncated ZIP'); count += n; }
  return buffer;
}
function regular(file: string, maximum: number): fs.Stats {
  const stat = fs.lstatSync(file);
  integrity(stat.isFile() && stat.nlink === 1 && stat.size > 0 && stat.size <= maximum
    && (!process.getuid || stat.uid === process.getuid()) && fs.realpathSync(file) === file, 'unsafe extracted file');
  return stat;
}
function regularBytes(file: string, maximum = METADATA): Buffer {
  const stat = regular(file, maximum); const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { const opened = fs.fstatSync(fd); integrity(opened.ino === stat.ino && opened.dev === stat.dev, 'file changed'); return readAt(fd, 0, stat.size); }
  finally { fs.closeSync(fd); }
}
function fileHash(file: string, expected: Member): void {
  const stat = regular(file, expected.bytes); integrity(stat.size === expected.bytes, 'extracted size mismatch');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); const digest = crypto.createHash('sha256');
  try {
    const opened = fs.fstatSync(fd); integrity(opened.ino === stat.ino && opened.dev === stat.dev, 'extracted file changed');
    const buffer = Buffer.alloc(Math.min(65536, stat.size)); let count = 0;
    while (count < stat.size) { const n = fs.readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - count), null); integrity(n > 0, 'truncated extracted file'); digest.update(buffer.subarray(0, n)); count += n; }
    const after = fs.fstatSync(fd); integrity(after.size === stat.size && after.mtimeMs === stat.mtimeMs && after.ctimeMs === stat.ctimeMs, 'extracted file changed');
    integrity(digest.digest('hex') === expected.sha256, 'extracted checksum mismatch');
  } finally { fs.closeSync(fd); }
}
// Validate both central and local framing before any native extraction. No ZIP64,
// links, directories, extra fields, encryption, ambiguous names, overlaps or trailing data.
function zipInventory(file: string, members: Member[]): ZipMember[] {
  const stat = regular(file, MAX); integrity(stat.size >= 22, 'truncated ZIP');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const end = readAt(fd, stat.size - 22, 22);
    integrity(end.readUInt32LE(0) === 0x06054b50 && end.readUInt16LE(4) === 0 && end.readUInt16LE(6) === 0
      && end.readUInt16LE(8) === members.length && end.readUInt16LE(10) === members.length && end.readUInt16LE(20) === 0, 'unsupported ZIP end record');
    const size = end.readUInt32LE(12); const offset = end.readUInt32LE(16);
    integrity(size <= MIB && offset + size === stat.size - 22, 'invalid ZIP central directory bounds');
    const central = readAt(fd, offset, size); let cursor = 0; let localEnd = 0; const result: ZipMember[] = [];
    for (const member of members) {
      integrity(cursor + 46 <= central.length && central.readUInt32LE(cursor) === 0x02014b50, 'invalid ZIP member header');
      const nameLength = central.readUInt16LE(cursor + 28); const extra = central.readUInt16LE(cursor + 30); const comment = central.readUInt16LE(cursor + 32);
      integrity(nameLength > 0 && nameLength < 512 && extra === 0 && comment === 0 && cursor + 46 + nameLength <= central.length, 'unsupported ZIP member metadata');
      const rawName = central.subarray(cursor + 46, cursor + 46 + nameLength); const name = text(rawName);
      const flags = central.readUInt16LE(cursor + 8); const method = central.readUInt16LE(cursor + 10);
      const compressed = central.readUInt32LE(cursor + 20); const bytes = central.readUInt32LE(cursor + 24); const localOffset = central.readUInt32LE(cursor + 42);
      const mode = central.readUInt32LE(cursor + 38) >>> 16;
      integrity(name === member.path && Buffer.from(name).equals(rawName) && safeName(name)
        && central[cursor + 5] === 3 && (mode & 0o170000) === 0o100000 && (mode & 0o7000) === 0
        && central.readUInt16LE(cursor + 34) === 0 && (central.readUInt32LE(cursor + 38) & 0x10) === 0
        && (flags & ~0x080e) === 0 && (method === 0 || method === 8) && bytes === member.bytes
        && compressed > 0 && compressed <= MAX && localOffset === localEnd, 'unsafe or inconsistent ZIP member');
      integrity(localOffset + 30 <= offset, 'invalid ZIP local offset');
      const local = readAt(fd, localOffset, 30);
      integrity(local.readUInt32LE(0) === 0x04034b50 && local.readUInt16LE(6) === flags && local.readUInt16LE(8) === method
        && local.readUInt16LE(26) === nameLength && local.readUInt16LE(28) === 0, 'ZIP local/central mismatch');
      integrity(readAt(fd, localOffset + 30, nameLength).equals(rawName), 'ZIP local filename mismatch');
      const dataOffset = localOffset + 30 + nameLength; localEnd = dataOffset + compressed;
      integrity(localEnd <= offset, 'ZIP data exceeds archive');
      const crc = central.readUInt32LE(cursor + 16);
      if (flags & 8) {
        integrity(local.readUInt32LE(14) === 0 && local.readUInt32LE(18) === 0 && local.readUInt32LE(22) === 0 && localEnd + 12 <= offset, 'invalid ZIP data descriptor');
        const signed = readAt(fd, localEnd, 4).readUInt32LE(0) === 0x08074b50;
        const descriptor = readAt(fd, localEnd + (signed ? 4 : 0), 12);
        integrity(descriptor.readUInt32LE(0) === crc && descriptor.readUInt32LE(4) === compressed && descriptor.readUInt32LE(8) === bytes, 'ZIP descriptor mismatch');
        localEnd += signed ? 16 : 12;
      } else integrity(local.readUInt32LE(14) === crc && local.readUInt32LE(18) === compressed && local.readUInt32LE(22) === bytes, 'ZIP local size/CRC mismatch');
      if (method === 0) integrity(compressed === bytes, 'invalid stored ZIP size');
      result.push({ ...member, offset: dataOffset, compressed, method }); cursor += 46 + nameLength;
    }
    integrity(cursor === central.length && localEnd === offset, 'extra or overlapping ZIP content'); return result;
  } finally { fs.closeSync(fd); }
}
async function verifyCompressedMembers(file: string, members: ZipMember[]): Promise<void> {
  // Streaming preflight proves actual expanded bounds/hash before ditto can write.
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 180000);
  try {
    for (const member of members) {
      const input = fs.createReadStream(file, { start: member.offset, end: member.offset + member.compressed - 1, highWaterMark: 65536 });
      const digest = crypto.createHash('sha256'); let bytes = 0;
      const consume = async (source: AsyncIterable<Buffer>): Promise<void> => {
        for await (const chunk of source) { bytes += chunk.length; integrity(bytes <= member.bytes, 'ZIP expanded size exceeds manifest'); digest.update(chunk); }
      };
      if (member.method === 8) {
        const inflater = createInflateRaw(); await pipeline(input, inflater, consume, { signal: controller.signal });
        integrity(inflater.bytesWritten === member.compressed, 'trailing compressed ZIP data');
      } else await pipeline(input, consume, { signal: controller.signal });
      integrity(bytes === member.bytes && digest.digest('hex') === member.sha256, 'ZIP member checksum/size mismatch');
    }
  } finally { clearTimeout(timer); }
}
async function verifyOriginalArchive(directory: string, original: string): Promise<void> {
  const binary = path.join(directory, 'bosun'); const binarySize = regular(binary, MAX).size;
  const archive = path.join(directory, original); const archiveSize = regular(archive, MAX).size;
  const header = Buffer.alloc(512); header.write('bosun', 0);
  for (const [value, offset, length] of [[0o755, 100, 8], [0, 108, 8], [0, 116, 8], [binarySize, 124, 12], [0, 136, 12]]) {
    header.write(value.toString(8).padStart(length - 1, '0') + '\0', offset, length);
  }
  header.fill(0x20, 148, 156); header[156] = 0x30; header.write('ustar\0', 257); header.write('00', 263);
  let checksum = 0; for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  const expectedSize = 512 + binarySize + (512 - binarySize % 512) % 512 + 1024;
  const fd = fs.openSync(binary, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 180000);
  const comparison = Buffer.alloc(65536); const inflater = createGunzip(); let position = 0;
  try {
    await pipeline(fs.createReadStream(archive, { highWaterMark: 65536 }), inflater, async (source: AsyncIterable<Buffer>): Promise<void> => {
      for await (const chunk of source) {
        integrity(position + chunk.length <= expectedSize, 'original archive exceeds binary framing');
        let cursor = 0;
        while (cursor < chunk.length) {
          if (position < 512) {
            const count = Math.min(chunk.length - cursor, 512 - position);
            integrity(chunk.subarray(cursor, cursor + count).equals(header.subarray(position, position + count)), 'original archive header mismatch');
            cursor += count; position += count;
          } else if (position < 512 + binarySize) {
            const count = Math.min(chunk.length - cursor, 512 + binarySize - position, comparison.length); let read = 0;
            while (read < count) { const n = fs.readSync(fd, comparison, read, count - read, position - 512 + read); integrity(n > 0, 'original binary truncated'); read += n; }
            integrity(chunk.subarray(cursor, cursor + count).equals(comparison.subarray(0, count)), 'original archive binary mismatch');
            cursor += count; position += count;
          } else {
            integrity(!chunk.subarray(cursor).some(byte => byte !== 0), 'original archive padding mismatch');
            position += chunk.length - cursor; cursor = chunk.length;
          }
        }
      }
    }, { signal: controller.signal });
    integrity(position === expectedSize && inflater.bytesWritten === archiveSize, 'original archive framing mismatch');
  } catch (error) {
    if (error instanceof BosunError) throw error;
    throw new BosunError('unverified', 'Original release archive failed bounded decompression verification. Nothing was installed or started.');
  } finally { clearTimeout(timer); fs.closeSync(fd); }
}
function manifestInventory(members: Member[], original: string): void {
  const required = ['bosun', 'build.json', original, 'SHA256SUMS', 'qualification.json', 'LICENSE', 'THIRD_PARTY.json'];
  const paths = new Set<string>(); const folded = new Set<string>(); let prior = ''; let total = 0;
  for (const member of members) {
    const fold = member.path.normalize('NFD').toLowerCase();
    integrity(member.path > prior && !folded.has(fold) && (required.includes(member.path) || member.path === 'INSTALL.md' || member.path.startsWith('licenses/')),
      'unexpected, duplicate or unordered ZIP inventory');
    prior = member.path; paths.add(member.path); folded.add(fold); total += member.bytes;
    integrity(total <= 600 * MIB, 'ZIP expansion exceeds bound');
    if (!['bosun', original].includes(member.path)) integrity(member.bytes <= METADATA, 'oversized ZIP metadata');
  }
  for (const name of paths) {
    const parts = name.split('/'); parts.pop(); let prefix = '';
    for (const part of parts) { prefix = prefix ? `${prefix}/${part}` : part; integrity(!folded.has(prefix.normalize('NFD').toLowerCase()), 'ZIP file/directory collision'); }
  }
  integrity(required.every(name => paths.has(name)), 'required ZIP member missing');
}
function verifyExtractedTree(directory: string, members: Member[]): void {
  const expected = new Map(members.map(member => [member.path, member])); let files = 0;
  const directories = new Set<string>();
  for (const member of members) {
    let parent = path.posix.dirname(member.path);
    while (parent !== '.' && !directories.has(parent)) { directories.add(parent); parent = path.posix.dirname(parent); }
  }
  function walk(current: string, prefix: string): void {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name; const target = path.join(current, entry.name); const stat = fs.lstatSync(target);
      if (stat.isDirectory()) {
        integrity(!stat.isSymbolicLink() && fs.realpathSync(target) === target && (!process.getuid || stat.uid === process.getuid())
          && directories.has(name), 'unexpected extracted directory'); walk(target, name);
      } else { const member = expected.get(name); integrity(member, 'unexpected extracted file'); fileHash(target, member); files++; }
    }
  }
  privateDirectory(directory); walk(directory, ''); integrity(files === members.length, 'missing extracted files');
}
function verifyBonds(directory: string, release: z.infer<typeof releaseSchema>, version: string, original: string): void {
  const inventory = new Map(release.members.map(item => [item.path, item]));
  const member = (name: string): Member => { const found = inventory.get(name); integrity(found, 'missing bound member'); return found; };
  integrity(release.binarySha256 === member('bosun').sha256 && release.buildSha256 === member('build.json').sha256
    && release.qualificationSha256 === member('qualification.json').sha256 && release.originalArchive.name === original
    && release.originalArchive.sha256 === member(original).sha256, 'release hash bonds mismatch');
  const sums = ['bosun', 'build.json', original].sort().map(name => `${member(name).sha256}  ${name}\n`).join('');
  integrity(text(regularBytes(path.join(directory, 'SHA256SUMS'), 1024)) === sums, 'inner distribution checksums mismatch');
  const build = decode(buildSchema, regularBytes(path.join(directory, 'build.json')));
  const inputs = new Map(build.inputs.map(input => [input.path, input]));
  integrity(build.version === version && build.compiler.version === release.source.bun.version && build.binary.bytes === member('bosun').bytes
    && build.binary.sha256 === release.binarySha256, 'build/version/binary identity mismatch');
  const flags = ['--compile', '--target=bun-darwin-arm64', '--format=esm', '--splitting', '--bytecode', '--minify', '--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig', '--no-compile-autoload-tsconfig', '--no-compile-autoload-package-json', '--define', 'process.env.DEV="false"', '--external', 'react-devtools-core'];
  integrity(JSON.stringify(build.flags) === JSON.stringify(flags), 'unexpected compiler flags');
  let prior = ''; let total = 0;
  for (const input of build.inputs) { integrity(input.path > prior && (total += input.bytes) <= 256 * MIB, 'invalid build input inventory'); prior = input.path; }
  integrity(build.sourceDigest === hash(JSON.stringify(build.inputs))
    && build.dependenciesDigest === hash(JSON.stringify(build.inputs.filter(input => input.path.startsWith('node_modules/'))))
    && build.assetsDigest === hash(JSON.stringify(build.inputs.filter(input => /^(roles\/|skills\/|policy\.md$)/.test(input.path)))), 'build inventory digest mismatch');
  if (build.nativeQualification) integrity(hash(build.nativeQualification.receiptJson) === build.nativeQualification.sha256, 'native qualification hash mismatch');
  const qualification = decode(qualificationSchema, regularBytes(path.join(directory, 'qualification.json'), MIB));
  integrity(qualification.version === version && qualification.binarySha256 === release.binarySha256
    && qualification.checks.map(check => check.name).join(',') === 'version,help,private-hook,private-route,mcp,storage-privacy,shutdown-and-reacquire,public-hook', 'compiled safety identity mismatch');
  const thirdSchema = z.object({ schema: z.literal(1), source: sourceSchema, packages: z.array(packageSchema).min(1).max(1000), disclaimer: z.string().max(4096) }).strict();
  const third = decode(thirdSchema, regularBytes(path.join(directory, 'THIRD_PARTY.json')));
  integrity(JSON.stringify(third.source) === JSON.stringify(release.source) && JSON.stringify(third.packages) === JSON.stringify(release.packages)
    && third.disclaimer.includes('Not a legal-clearance opinion'), 'third-party manifest mismatch');
  const licensed = new Set<string>(); prior = '';
  for (const pkg of release.packages) {
    integrity(pkg.name > prior && pkg.source === `https://registry.npmjs.org/${pkg.name}/-/${pkg.name.split('/').at(-1)}-${pkg.version}.tgz`
      && inputs.has(`node_modules/${pkg.name}/package.json`), 'invalid dependency notice identity'); prior = pkg.name;
    for (const file of pkg.files) {
      integrity(file.startsWith(`licenses/packages/${pkg.name}/`) && !licensed.has(file), 'duplicate or misplaced dependency notice'); licensed.add(file); member(file);
      const source = inputs.get(`node_modules/${file.slice('licenses/packages/'.length)}`);
      integrity(source?.sha256 === member(file).sha256 || (pkg.name === 'yoga-layout' && pkg.version === '3.2.1' && file === 'licenses/packages/yoga-layout/LICENSE'), 'notice differs from build input');
    }
  }
  for (const item of release.members) {
    if (item.path.startsWith('licenses/packages/')) integrity(licensed.has(item.path), 'unmapped dependency notice');
    if (item.path === 'LICENSE' || item.path.startsWith('licenses/') || item.path === 'INSTALL.md') {
      const content = text(regularBytes(path.join(directory, item.path))); integrity(content.trim() && !content.includes('\0'), 'invalid license/guide text');
    }
  }
  for (const name of ['bun-LICENSE.md', 'yoga-LICENSE', 'RELINKING.md', 'LGPL-2.0.txt', 'LGPL-2.1.txt']) member(`licenses/runtime/${name}`);
  integrity(text(regularBytes(path.join(directory, 'licenses/runtime/bun-LICENSE.md'))).includes('LGPL'), 'missing Bun license obligations');
  const binaryFile = path.join(directory, 'bosun'); const binaryFd = fs.openSync(binaryFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const header = readAt(binaryFd, 0, 32);
    integrity(header.readUInt32LE(0) === 0xfeedfacf && header.readUInt32LE(4) === 0x0100000c && header.readUInt32LE(12) === 2, 'binary is not macOS arm64 Mach-O');
    const count = header.readUInt32LE(16); const size = header.readUInt32LE(20);
    integrity(count > 0 && count <= 4096 && size <= 16 * MIB && 32 + size <= member('bosun').bytes, 'invalid Mach-O load commands');
    const commands = readAt(binaryFd, 32, size); let cursor = 0;
    for (let index = 0; index < count; index++) { integrity(cursor + 8 <= size, 'truncated Mach-O load command'); const length = commands.readUInt32LE(cursor + 4); integrity(length >= 8 && length % 8 === 0 && cursor + length <= size, 'invalid Mach-O load command'); cursor += length; }
    integrity(cursor === size, 'invalid Mach-O command inventory');
  } finally { fs.closeSync(binaryFd); }
}

export async function downloadLatestRelease(options: ReleaseDownloadOptions, injected: Partial<ReleaseDownloadDependencies> = {}): Promise<ReleaseDownloadResult> {
  const deps: ReleaseDownloadDependencies = {
    fetch: (url, init) => fetch(url, init), executable, process: streamProcess,
    platform: process.platform, architecture: process.arch, ...injected,
  };
  if (deps.platform !== 'darwin' || deps.architecture !== 'arm64') throw new BosunError('unsupported', 'GitHub releases support only macOS arm64. No download or installation was attempted.');
  if (options.currentVersion !== undefined && !VERSION.test(options.currentVersion)) throw new BosunError('invalid', 'A canonical installed version is required');
  privateDirectory(options.directory);
  const gh = deps.executable('gh', options.env);
  const ghEnv: Record<string, string | undefined> = { ...options.env, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_NO_EXTENSION_UPDATE_NOTIFIER: '1', GH_PAGER: 'cat', PAGER: 'cat', GH_DEBUG: undefined, GH_HTTP_UNIX_SOCKET: undefined };
  async function command(binary: string, args: string[], maximum: number, consume: (chunk: Uint8Array) => void, timeoutMs: number): Promise<void> {
    let code: number | null = null;
    for await (const event of deps.process({ command: binary, args, cwd: options.directory, env: ghEnv, signal: new AbortController().signal,
      stdout: consume, maxOutputBytes: Math.min(MAX, maximum + 32768), timeoutMs, killGraceMs: 2000 })) {
      if (event.t === 'exit') code = event.code;
    }
    if (code !== 0) throw new BosunError('unavailable', binary === gh
      ? 'GitHub CLI could not read the release. Check network access and existing authorization with `gh auth status --hostname github.com`; this private repository requires access. No anonymous fallback or authentication change was attempted.'
      : 'macOS ditto could not extract the verified release. Check available disk space and the retained download directory; nothing was installed or started.');
  }
  async function receive(endpoint: string, maximum: number, consume: (chunk: Uint8Array) => void, binary = false): Promise<void> {
    let received = 0;
    const bounded = (chunk: Uint8Array): void => { received += chunk.byteLength; integrity(received <= maximum, 'download exceeded its byte limit'); consume(chunk); };
    if (gh) {
      try { await command(gh, ['api', '--hostname', 'github.com', '--method', 'GET', '-H', `Accept: ${binary ? 'application/octet-stream' : 'application/vnd.github+json'}`, '-H', 'X-GitHub-Api-Version: 2022-11-28', endpoint], maximum, bounded, binary ? 180000 : 30000); }
      catch (error) {
        if (error instanceof BosunError && error.code === 'unverified') throw error;
        throw new BosunError('unavailable', 'GitHub release access failed or timed out. Check network access and existing credentials with `gh auth status --hostname github.com` and repository access. No anonymous fallback or authentication change was attempted.');
      }
      return;
    }
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), binary ? 180000 : 30000);
    try {
      let url = `${API}/${endpoint}`;
      for (let redirects = 0; ; redirects++) {
        const response = await deps.fetch(url, { headers: { Accept: binary ? 'application/octet-stream' : 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, redirect: 'manual', signal: controller.signal });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location'); await response.body?.cancel(); integrity(binary && redirects < 4 && location, 'unexpected GitHub redirect');
          const target = new URL(location, url);
          integrity(target.protocol === 'https:' && !target.username && !target.password && !target.port && !target.hash
            && ['api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(target.hostname), 'unsafe GitHub asset redirect'); url = target.href; continue;
        }
        if (!response.ok) {
          await response.body?.cancel();
          if ([401, 403, 404].includes(response.status)) throw new BosunError('unavailable', `GitHub release access returned HTTP ${response.status}. For private-repository access, install GitHub CLI separately and authorize access to vprodan/bosun with \`gh auth login --hostname github.com\`, then retry. This command did not read tokens or change authentication.`);
          throw new BosunError('unavailable', `GitHub returned HTTP ${response.status}. Check network access and GitHub status, then retry in a new private download directory.`);
        }
        const length = response.headers.get('content-length');
        integrity(length === null || (/^[0-9]+$/.test(length) && Number(length) <= maximum), 'HTTP response exceeds byte limit');
        integrity(response.body, 'empty HTTP response'); const reader = response.body.getReader();
        try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; bounded(chunk.value); } }
        finally { await reader.cancel(); reader.releaseLock(); }
        break;
      }
    } catch (error) {
      if (error instanceof BosunError) throw error;
      throw new BosunError('unavailable', 'GitHub release download failed or timed out. Check HTTPS/network access, available disk space and GitHub status; retry in a new private download directory. Nothing was installed or started.');
    } finally { clearTimeout(timer); }
  }
  async function metadata(endpoint: string): Promise<Buffer> {
    const chunks: Buffer[] = []; let bytes = 0;
    await receive(endpoint, METADATA, chunk => { chunks.push(Buffer.from(chunk)); bytes += chunk.byteLength; }); return Buffer.concat(chunks, bytes);
  }
  async function tagCommit(tag: string): Promise<string> {
    const ref = object(json(await metadata(`${REPOSITORY}/git/ref/tags/${tag}`)));
    integrity(ref.ref === `refs/tags/${tag}`, 'GitHub tag reference mismatch');
    let target = object(ref.object);
    for (let depth = 0; depth < 5; depth++) {
      integrity(typeof target.sha === 'string' && /^[0-9a-f]{40}$/.test(target.sha), 'invalid GitHub tag object');
      if (target.type === 'commit') return target.sha;
      integrity(target.type === 'tag', 'GitHub tag does not resolve to a commit');
      const annotated = object(json(await metadata(`${REPOSITORY}/git/tags/${target.sha}`)));
      integrity(annotated.sha === target.sha && (depth !== 0 || annotated.tag === tag), 'annotated GitHub tag mismatch');
      target = object(annotated.object);
    }
    throw new BosunError('unverified', 'GitHub release tag nesting exceeds the supported bound. No binary was installed or started.');
  }
  const latest = githubRelease(await metadata(`${REPOSITORY}/releases/latest`));
  if (options.currentVersion !== undefined) {
    const installed = options.currentVersion.split('.'), available = latest.version.split('.');
    let difference = 0;
    for (let part = 0; part < 3; part++) {
      difference = Number(available[part]) - Number(installed[part]);
      if (difference !== 0) break;
    }
    if (difference <= 0) return { state: difference === 0 ? 'current' : 'newer-installed', binary: null, version: latest.version, releaseUrl: latest.url };
  }
  const commit = await tagCommit(latest.tag);
  const total = latest.assets.reduce((sum, asset) => sum + asset.size, 0);
  const directory = path.join(options.directory, `release-${crypto.randomUUID()}`); absent(directory);
  const staging = path.join(directory, 'extracted');
  if (!await options.confirm({ message: `Download Bosun ${latest.version} for macOS arm64 (${total} bytes, ${(total / MIB).toFixed(1)} MiB) from ${latest.url}? This only downloads and verifies; it does not install or start Bosun.`, initialValue: false })) {
    throw new BosunError('cancelled', 'Release download cancelled. Nothing was downloaded, installed or started.');
  }
  privateDirectory(options.directory); fs.mkdirSync(directory, { mode: 0o700 }); privateDirectory(directory);
  options.write(`Downloading and verifying Bosun ${latest.version} (${total} bytes).\n`);
  for (const asset of latest.assets) {
    privateDirectory(directory);
    const file = path.join(directory, asset.name); const fd = fs.openSync(file, 'wx', 0o600); const digest = crypto.createHash('sha256'); let size = 0;
    try {
      await receive(`${REPOSITORY}/releases/assets/${asset.id}`, asset.size, chunk => {
        let offset = 0;
        while (offset < chunk.byteLength) { const written = fs.writeSync(fd, chunk, offset, chunk.byteLength - offset); integrity(written > 0, 'download write failed'); offset += written; }
        size += chunk.byteLength; digest.update(chunk);
      }, true);
      fs.fsyncSync(fd); integrity(size === asset.size && digest.digest('hex') === asset.digest, 'GitHub asset SHA256/size mismatch');
    } finally { fs.closeSync(fd); }
  }
  // Pin the original release, not a moving latest endpoint, and reject asset/tag drift.
  const fresh = githubRelease(await metadata(`${REPOSITORY}/releases/${latest.id}`));
  integrity(JSON.stringify(fresh) === JSON.stringify(latest) && await tagCommit(latest.tag) === commit, 'release, tag commit or asset identity changed during download');
  const checksums = latest.assets.filter(asset => asset.name !== 'SHA256SUMS').map(asset => `${asset.digest}  ${asset.name}\n`).join('');
  integrity(text(regularBytes(path.join(directory, 'SHA256SUMS'), 1024)) === checksums, 'top-level SHA256SUMS mismatch');
  const release = decode(releaseSchema, regularBytes(path.join(directory, 'release.json')));
  const archiveName = `bosun-${latest.version}-darwin-arm64.zip`; const original = `bosun-${latest.version}-darwin-arm64.tar.gz`;
  integrity(release.tag === latest.tag && release.version === latest.version && release.commit === commit && release.source.commit === release.commit
    && release.source.project === `https://github.com/vprodan/bosun/tree/${latest.tag}`
    && release.source.bun.url === `https://github.com/oven-sh/bun/tree/${release.source.bun.commit}`, 'release/source identity mismatch');
  for (const [index, name] of [archiveName, 'RELEASE_NOTES.md'].entries()) {
    const asset = latest.assets.find(item => item.name === name); const declared = release.assets[index];
    integrity(asset && declared.name === name && declared.bytes === asset.size && declared.sha256 === asset.digest, 'asset manifest mismatch');
  }
  manifestInventory(release.members, original);
  const archive = path.join(directory, archiveName); const inventory = zipInventory(archive, release.members);
  try { await verifyCompressedMembers(archive, inventory); }
  catch (error) { if (error instanceof BosunError) throw error; throw new BosunError('unverified', 'Release ZIP decompression/integrity preflight failed. Nothing was extracted, installed or started.'); }
  privateDirectory(directory); fs.mkdirSync(staging, { mode: 0o700 }); privateDirectory(staging);
  try { await command('/usr/bin/ditto', ['-x', '-k', '--norsrc', '--noextattr', archive, staging], 65536, () => {}, 120000); }
  catch { throw new BosunError('unavailable', 'macOS ditto extraction failed or timed out. Check available disk space and the retained private download directory. Nothing was installed or started.'); }
  verifyExtractedTree(staging, release.members); verifyBonds(staging, release, latest.version, original);
  await verifyOriginalArchive(staging, original);
  const binary = path.join(staging, 'bosun'); fs.chmodSync(binary, 0o700);
  options.write(`Verified Bosun ${latest.version}. The downloaded binary has not been executed or installed.\n`);
  return { state: 'downloaded', binary, version: latest.version, releaseUrl: latest.url };
}
