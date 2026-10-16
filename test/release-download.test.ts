import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BosunError } from '../src/core/errors.ts';
import crypto from 'node:crypto';
import { deflateRawSync, gzipSync } from 'node:zlib';
import { sandbox } from './helpers.ts';
import { binaryArchive } from '../scripts/distribution.mts';
import { downloadLatestRelease } from '../src/app/release-download.ts';
import type { ReleaseDownloadDependencies, ReleaseDownloadQuestion } from '../src/app/release-download.ts';
import { streamProcess } from '../src/platform/process.ts';
import type { ProcessEvent, ProcessSpec } from '../src/platform/process.ts';

const API = 'https://api.github.com/repos/vprodan/bosun';
const VERSION = '1.1.0';
const TAG = `v${VERSION}`;
const COMMIT = 'a'.repeat(40);
const ZIP = `bosun-${VERSION}-darwin-arm64.zip`;
const ORIGINAL = `bosun-${VERSION}-darwin-arm64.tar.gz`;
const sha = (bytes: Uint8Array | string): string => crypto.createHash('sha256').update(bytes).digest('hex');
const encode = (value: unknown): Buffer => Buffer.from(JSON.stringify(value) + '\n');
interface ZipEntry { name: string; data: Buffer; mode?: number; expanded?: Buffer }
function crc32(bytes: Buffer): number {
  let value = 0xffffffff;
  for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); }
  return (value ^ 0xffffffff) >>> 0;
}
function zip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = []; const central: Buffer[] = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name); const data = entry.expanded ? deflateRawSync(entry.expanded) : entry.data;
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.expanded ? 8 : 0, 8); local.writeUInt32LE(crc32(entry.data), 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(entry.data.length, 22); local.writeUInt16LE(name.length, 26);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(0x0314, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(entry.expanded ? 8 : 0, 10); directory.writeUInt32LE(crc32(entry.data), 16);
    directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(entry.data.length, 24); directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38); directory.writeUInt32LE(offset, 42);
    locals.push(local, name, data); central.push(directory, name); offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
function fixture() {
  const sb = sandbox(); const directory = path.join(sb.root, 'downloads'); fs.mkdirSync(directory, { mode: 0o700 });
  const binary = Buffer.alloc(64); binary.writeUInt32LE(0xfeedfacf, 0); binary.writeUInt32LE(0x0100000c, 4); binary.writeUInt32LE(2, 12);
  binary.writeUInt32LE(1, 16); binary.writeUInt32LE(32, 20); binary.writeUInt32LE(0x19, 32); binary.writeUInt32LE(32, 36);
  const notice = Buffer.from('Example license\n');
  const inputs = [{ path: 'node_modules/example/LICENSE', bytes: notice.length, sha256: sha(notice) },
    { path: 'node_modules/example/package.json', bytes: 2, sha256: sha('{}') }];
  const flags = ['--compile', '--target=bun-darwin-arm64', '--format=esm', '--splitting', '--bytecode', '--minify', '--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig', '--no-compile-autoload-tsconfig', '--no-compile-autoload-package-json', '--define', 'process.env.DEV="false"', '--external', 'react-devtools-core'];
  const source = { project: `https://github.com/vprodan/bosun/tree/${TAG}`, commit: COMMIT,
    bun: { version: '1.4.3', commit: 'c6da4a4d3', url: 'https://github.com/oven-sh/bun/tree/c6da4a4d3' },
    sqlite: { archives: ['better-sqlite3', 'node-addon-api', 'node-api-headers'].map(name => ({ name, url: `https://registry.npmjs.org/${name}`, sha256: 'b'.repeat(64) })),
      patch: { path: 'patches/better-sqlite3.patch', sha256: 'c'.repeat(64) }, publicDomain: 'https://www.sqlite.org/copyright.html' } };
  const packages = [{ name: 'example', version: '1.0.0', source: 'https://registry.npmjs.org/example/-/example-1.0.0.tgz', files: ['licenses/packages/example/LICENSE'] }];
  const qualification = { version: VERSION, binarySha256: sha(binary), scope: 'compiled-local-release-safety',
    checks: ['version', 'help', 'private-hook', 'private-route', 'mcp', 'storage-privacy', 'shutdown-and-reacquire', 'public-hook'].map(name => ({ name, passed: true,
      ...(name === 'storage-privacy' ? { requests: 7, originalMutations: 2, privateOwnerReadable: true, modelPrivateOverrideRejected: true, modelPrivateSearchExcluded: true, modelPrivateContextExcluded: true, ownerStatusReceived: true } : {}),
      ...(name === 'public-hook' ? { notes: 10000, injections: 21 } : {}) })),
    allJoined: true, liveHosts: false, liveModels: false, personalActivation: false };
  const build = encode({ schema: 1, product: 'bosun', version: VERSION, target: 'bun-darwin-arm64', compiler: { version: '1.4.3', sha256: 'd'.repeat(64) },
    flags, inputs, sourceDigest: sha(JSON.stringify(inputs)), dependenciesDigest: sha(JSON.stringify(inputs)), assetsDigest: sha('[]'),
    binary: { bytes: binary.length, sha256: sha(binary) }, developmentDebugger: 'disabled-before-imports', runtimeQualification: 'unverified' });
  const original = gzipSync(binaryArchive(binary));
  const files: Record<string, Buffer> = { bosun: binary, 'build.json': build, [ORIGINAL]: original,
    'qualification.json': encode(qualification), LICENSE: Buffer.from('Project license\n'),
    'THIRD_PARTY.json': encode({ schema: 1, source, packages, disclaimer: 'Not a legal-clearance opinion' }),
    'licenses/packages/example/LICENSE': notice };
  for (const name of ['bun-LICENSE.md', 'yoga-LICENSE', 'RELINKING.md', 'LGPL-2.0.txt', 'LGPL-2.1.txt']) files[`licenses/runtime/${name}`] = Buffer.from('LGPL runtime notice\n');
  files.SHA256SUMS = Buffer.from(['bosun', 'build.json', ORIGINAL].sort().map(name => `${sha(files[name])}  ${name}\n`).join(''));
  const names = Object.keys(files).sort();
  const entries = names.map(name => ({ name, data: files[name] }));
  const archive = zip(entries); const notes = Buffer.from('Release notes\n');
  const manifest = { schema: 1, product: 'bosun', tag: TAG, version: VERSION, commit: COMMIT, target: 'bun-darwin-arm64', runtimeQualification: 'unverified', compiledSafety: 'passed',
    binarySha256: sha(binary), buildSha256: sha(build), originalArchive: { name: ORIGINAL, sha256: sha(original) }, qualificationSha256: sha(files['qualification.json']), source, packages,
    members: names.map(name => ({ path: name, bytes: files[name].length, sha256: sha(files[name]) })),
    assets: [{ name: ZIP, bytes: archive.length, sha256: sha(archive) }, { name: 'RELEASE_NOTES.md', bytes: notes.length, sha256: sha(notes) }] };
  const assets: Record<string, Buffer> = { [ZIP]: archive, 'release.json': encode(manifest), 'RELEASE_NOTES.md': notes, SHA256SUMS: Buffer.alloc(0) };
  function refresh(): void {
    manifest.assets[0] = { name: ZIP, bytes: assets[ZIP].length, sha256: sha(assets[ZIP]) };
    assets['release.json'] = encode(manifest);
    assets.SHA256SUMS = Buffer.from([ZIP, 'release.json', 'RELEASE_NOTES.md'].sort().map(name => `${sha(assets[name])}  ${name}\n`).join(''));
  }
  refresh();
  function github() {
    return { id: 7, tag_name: TAG, draft: false, prerelease: false, html_url: `https://github.com/vprodan/bosun/releases/tag/${TAG}`, url: `${API}/releases/7`,
      assets: Object.keys(assets).sort().map((name, index) => ({ id: 100 + index, name, state: 'uploaded', size: assets[name].length, digest: `sha256:${sha(assets[name])}`,
        url: `${API}/releases/assets/${100 + index}`, browser_download_url: `https://github.com/vprodan/bosun/releases/download/${TAG}/${name}` })) };
  }
  const requests: string[] = []; const commands: string[] = []; const questions: ReleaseDownloadQuestion[] = [];
  const deps: ReleaseDownloadDependencies = {
    platform: 'darwin', architecture: 'arm64', executable: () => null,
    async fetch(url) {
      requests.push(url);
      if (url === `${API}/releases/latest` || url === `${API}/releases/7`) return Response.json(github());
      if (url === `${API}/git/ref/tags/${TAG}`) return Response.json({ ref: `refs/tags/${TAG}`, object: { type: 'commit', sha: COMMIT } });
      const asset = github().assets.find(item => item.url === url); assert.ok(asset, `Unexpected network request: ${url}`);
      return new Response(new Uint8Array(assets[asset.name]!));
    },
    async *process(spec: ProcessSpec): AsyncGenerator<ProcessEvent> { commands.push(spec.command); yield* streamProcess(spec); },
  };
  const options = { env: sb.env(), directory, async confirm(question: ReleaseDownloadQuestion) { questions.push(question); return true; }, write(_value: string) {} };
  return { sb, binary, entries, assets, manifest, refresh, github, deps, options, requests, commands, questions };
}

test('verified release download returns matching bytes without executing or installing them', async () => {
  const f = fixture();
  try {
    const result = await downloadLatestRelease({ ...f.options, currentVersion: '1.0.99' }, f.deps);
    assert.ok(result.state === 'downloaded');
    assert.equal(result.version, VERSION); assert.equal(result.releaseUrl, `https://github.com/vprodan/bosun/releases/tag/${TAG}`);
    assert.deepEqual(fs.readFileSync(result.binary), f.binary); assert.equal(fs.statSync(result.binary).mode & 0o777, 0o700);
    assert.deepEqual(f.commands, ['/usr/bin/ditto']);
    assert.equal(f.requests.filter(url => url.endsWith(`/git/ref/tags/${TAG}`)).length, 2);
  } finally { f.sb.cleanup(); }
});
test('declining download performs no asset request or filesystem mutation', async () => {
  const f = fixture();
  try {
    await assert.rejects(downloadLatestRelease({ ...f.options, confirm: async () => false }, f.deps), (error: unknown) => error instanceof BosunError && error.code === 'cancelled');
    assert.deepEqual(fs.readdirSync(f.options.directory), []); assert.deepEqual(f.commands, []);
    assert.equal(f.requests.some(url => url.includes('/releases/assets/')), false);
  } finally { f.sb.cleanup(); }
});
test('authenticated gh failures never retry anonymously or print credentials', async () => {
  const f = fixture();
  try {
    const env = { ...f.options.env, GH_DEBUG: 'api', GH_TOKEN: 'SYNTHETIC_DO_NOT_PRINT' };
    const deps: ReleaseDownloadDependencies = { ...f.deps, executable: () => '/synthetic/gh',
      async *process(spec: ProcessSpec): AsyncGenerator<ProcessEvent> {
        assert.equal(spec.env.GH_DEBUG, undefined); assert.equal(spec.env.GH_PROMPT_DISABLED, '1');
        assert.equal(spec.args.includes('SYNTHETIC_DO_NOT_PRINT'), false); yield { t: 'exit', code: 1, signal: null };
      } };
    await assert.rejects(downloadLatestRelease({ ...f.options, env }, deps), (error: unknown) => error instanceof BosunError && error.code === 'unavailable' && !error.message.includes(env.GH_TOKEN));
    assert.deepEqual(f.requests, []); assert.deepEqual(fs.readdirSync(f.options.directory), []);
  } finally { f.sb.cleanup(); }
});
test('existing gh authentication transports verified bytes without exposing a token', async () => {
  const f = fixture(); const serve = f.deps.fetch;
  try {
    const deps: ReleaseDownloadDependencies = { ...f.deps, executable: () => '/synthetic/gh',
      async fetch() { throw new Error('Anonymous fallback must not run'); },
      async *process(spec: ProcessSpec): AsyncGenerator<ProcessEvent> {
        if (spec.command !== '/synthetic/gh') { f.commands.push(spec.command); yield* streamProcess(spec); return; }
        assert.equal(spec.args[0], 'api'); assert.equal(spec.args.includes('--hostname'), true);
        const response = await serve(`https://api.github.com/${spec.args.at(-1)}`, {});
        assert.ok(spec.stdout); spec.stdout(new Uint8Array(await response.arrayBuffer()));
        yield { t: 'exit', code: 0, signal: null };
      } };
    const result = await downloadLatestRelease(f.options, deps);
    assert.ok(result.state === 'downloaded');
    assert.deepEqual(fs.readFileSync(result.binary), f.binary); assert.deepEqual(f.commands, ['/usr/bin/ditto']);
  } finally { f.sb.cleanup(); }
});
test('asset digest corruption holds before extraction', async () => {
  const f = fixture(); const originalFetch = f.deps.fetch;
  try {
    f.deps.fetch = async (url, init) => {
      const asset = f.github().assets.find(item => item.name === ZIP);
      if (url === asset?.url) return new Response(Buffer.alloc(f.assets[ZIP].length));
      return originalFetch(url, init);
    };
    await assert.rejects(downloadLatestRelease(f.options, f.deps), (error: unknown) => error instanceof BosunError && error.code === 'unverified'); assert.deepEqual(f.commands, []);
  } finally { f.sb.cleanup(); }
});
for (const kind of ['traversal', 'symlink', 'oversized-expansion', 'duplicate'] as const) {
  test(`unsafe ZIP ${kind} is rejected before native extraction`, async () => {
    const f = fixture();
    try {
      const entries: ZipEntry[] = f.entries.map(entry => ({ ...entry })); const bosun = entries.find(entry => entry.name === 'bosun'); assert.ok(bosun);
      if (kind === 'traversal') bosun.name = '../xx';
      if (kind === 'symlink') bosun.mode = 0o120777;
      if (kind === 'oversized-expansion') bosun.expanded = Buffer.alloc(bosun.data.length + 65536);
      if (kind === 'duplicate') entries.push({ ...bosun });
      f.assets[ZIP] = zip(entries); f.refresh();
      await assert.rejects(downloadLatestRelease(f.options, f.deps), (error: unknown) => error instanceof BosunError && error.code === 'unverified');
      assert.deepEqual(f.commands, []);
      for (const child of fs.readdirSync(f.options.directory)) assert.equal(fs.existsSync(path.join(f.options.directory, child, 'extracted')), false);
    } finally { f.sb.cleanup(); }
  });
}
test('unknown release manifest fields are denied before extraction', async () => {
  const f = fixture();
  try {
    Object.assign(f.manifest, { unexpected: true }); f.refresh();
    await assert.rejects(downloadLatestRelease(f.options, f.deps), (error: unknown) => error instanceof BosunError && error.code === 'unverified'); assert.deepEqual(f.commands, []);
    assert.equal(fs.readdirSync(f.options.directory).length, 1);
  } finally { f.sb.cleanup(); }
});
test('repeated approved downloads retain prior artifacts without overwriting parent files', async () => {
  const f = fixture(); const sentinel = path.join(f.options.directory, ZIP);
  try {
    fs.writeFileSync(sentinel, 'existing owner artifact', { flag: 'wx', mode: 0o600 });
    const first = await downloadLatestRelease(f.options, f.deps);
    const second = await downloadLatestRelease(f.options, f.deps);
    assert.ok(first.state === 'downloaded' && second.state === 'downloaded');
    assert.notEqual(first.binary, second.binary); assert.deepEqual(fs.readFileSync(first.binary), f.binary);
    assert.deepEqual(fs.readFileSync(second.binary), f.binary); assert.equal(fs.readFileSync(sentinel, 'utf8'), 'existing owner artifact');
  } finally { f.sb.cleanup(); }
});
test('missing GitHub digest is an actionable hold before confirmation or download', async () => {
  const f = fixture(); const serve = f.deps.fetch;
  try {
    f.deps.fetch = async (url, init) => {
      if (url === `${API}/releases/latest`) {
        const release = f.github(); release.assets[0].digest = '';
        return Response.json(release);
      }
      return serve(url, init);
    };
    await assert.rejects(downloadLatestRelease(f.options, f.deps), (error: unknown) => error instanceof BosunError && error.code === 'unverified');
    assert.deepEqual(f.questions, []); assert.deepEqual(fs.readdirSync(f.options.directory), []); assert.deepEqual(f.commands, []);
  } finally { f.sb.cleanup(); }
});
test('release tag commit drift is rejected after downloading without extraction', async () => {
  const f = fixture(); const originalFetch = f.deps.fetch; let calls = 0;
  try {
    f.deps.fetch = async (url, init) => {
      if (url === `${API}/git/ref/tags/${TAG}` && ++calls === 2) return Response.json({ ref: `refs/tags/${TAG}`, object: { type: 'commit', sha: 'e'.repeat(40) } });
      return originalFetch(url, init);
    };
    await assert.rejects(downloadLatestRelease(f.options, f.deps), (error: unknown) => error instanceof BosunError && error.code === 'unverified'); assert.deepEqual(f.commands, []);
  } finally { f.sb.cleanup(); }
});

test('already-current release checks metadata without download approval, asset transfer or filesystem changes', async () => {
  const f = fixture();
  try {
    const result = await downloadLatestRelease({ ...f.options, currentVersion: VERSION, confirm: async () => assert.fail('Current release needs no download approval') }, f.deps);
    assert.equal(result.state, 'current'); assert.equal(result.binary, null);
    assert.ok(f.requests.includes(`${API}/releases/latest`));
    assert.equal(f.requests.some(url => url.includes('/releases/assets/')), false);
    assert.deepEqual(fs.readdirSync(f.options.directory), []); assert.deepEqual(f.commands, []);
  } finally { f.sb.cleanup(); }
});

test('newer installed version refuses downgrade before fetching or extracting release assets', async () => {
  const f = fixture();
  try {
    const result = await downloadLatestRelease({ ...f.options, currentVersion: '2.0.0', confirm: async () => assert.fail('Downgrade must not ask to download') }, f.deps);
    assert.equal(result.state, 'newer-installed'); assert.equal(result.binary, null);
    assert.ok(f.requests.includes(`${API}/releases/latest`));
    assert.equal(f.requests.some(url => url.includes('/releases/assets/')), false);
    assert.deepEqual(fs.readdirSync(f.options.directory), []); assert.deepEqual(f.commands, []);
  } finally { f.sb.cleanup(); }
});
