// Build-job tooling only: never execute this in a write-token publisher.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { verifyDistribution } from './distribution.mts';
import { parseBunLock, productionPackages } from './bun-lock-inputs.mts';
import { INPUTS, PATCH, PATCH_SHA256, regularBytes, sha256 } from './sqlite-native-inputs.mts';

const MAX = 300 * 1024 * 1024;
const root = fs.realpathSync(path.join(import.meta.dirname, '..'));
const fail = (message: string): never => { throw new Error(message); };
function command(binary: string, args: string[], cwd = root): string {
  const result = spawnSync(binary, args, { cwd, shell: false, encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0) fail(`${binary} failed: ${result.stderr.slice(0, 4096)}`);
  return result.stdout.trim();
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Expected JSON object');
  return value as Record<string, unknown>;
}
interface CompiledCheck {
  name: unknown;
  passed: unknown;
  failed: unknown;
}
function compiledChecks(value: unknown): CompiledCheck[] {
  if (!Array.isArray(value)) throw new Error('Expected compiled checks array');
  return value.map((entry: unknown): CompiledCheck => {
    const check = record(entry);
    return { name: check.name, passed: check.passed, failed: check.failed };
  });
}
const args = process.argv.slice(2);
const options: Record<string, string> = {};
for (let i = 0; i < args.length; i += 2) {
  const key = args[i], value = args[i + 1];
  if (!['--artifact', '--out', '--tag', '--commit', '--qualification', '--git'].includes(key) || !value || options[key]) fail('Usage: release-package --artifact DIR --out ABSENT_DIR --tag vX.Y.Z --commit FULLSHA --qualification COMPILED_JSON [--git ABSOLUTE_GIT]');
  options[key] = value;
}
if (['--artifact', '--out', '--tag', '--commit', '--qualification'].some(key => !options[key])) fail('All five release-package flags are required');
const git = options['--git'] ?? '/usr/bin/git';
if (!path.isAbsolute(git) || !/^git version \d+\.\d+/.test(command(git, ['--version']))) fail('An absolute installed Git executable is required');
const tag = options['--tag'], commit = options['--commit'];
if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*)?$/.test(tag) || !/^[0-9a-f]{40}$/.test(commit)) fail('Invalid version tag or full Git commit');
if (command(git, ['rev-parse', 'HEAD']) !== commit || command(git, ['rev-parse', `${tag}^{commit}`]) !== commit) fail('Tag/checkout/commit mismatch');
command(git, ['diff', '--quiet', 'HEAD', '--']);
const output = path.resolve(options['--out']);
if (fs.existsSync(output) || fs.realpathSync(path.dirname(output)) !== path.dirname(output)) fail('Output must be absent with a canonical existing parent');
const artifact = path.resolve(options['--artifact']);
const verified = verifyDistribution(artifact, { root });
if (`v${verified.version}` !== tag) fail('Tag/package version mismatch');
const qualificationBytes = regularBytes(path.resolve(options['--qualification']), 1024 * 1024);
const qualification = record(JSON.parse(qualificationBytes.toString('utf8')));
const requiredChecks = ['version', 'help', 'private-hook', 'private-route', 'mcp', 'storage-privacy', 'shutdown-and-reacquire', 'public-hook'];
if (Object.keys(qualification).sort().join(',') !== ['version', 'binarySha256', 'scope', 'checks', 'allJoined', 'liveHosts', 'liveModels', 'personalActivation'].sort().join(',') || qualification.version !== verified.version || qualification.binarySha256 !== verified.binarySha256 || qualification.scope !== 'compiled-local-release-safety' || qualification.allJoined !== true || qualification.liveHosts !== false || qualification.liveModels !== false || qualification.personalActivation !== false || !Array.isArray(qualification.checks)) fail('Missing/invalid compiled safety receipt');
const checks = compiledChecks(qualification.checks);
if (checks.length !== requiredChecks.length || checks.some((check, index) => check.name !== requiredChecks[index] || check.passed !== true || check.failed === true)) fail('Compiled safety checks incomplete or failed');
const buildBytes = regularBytes(path.join(artifact, 'build.json'), 4 * 1024 * 1024);
const build = record(JSON.parse(buildBytes.toString('utf8')));
const inputs = new Map((build.inputs as {path: string; sha256: string}[]).map(input => [input.path, input.sha256]));
const files = new Map<string, Buffer>();
function add(name: string, bytes: Buffer): void {
  if (!name || name.length > 512 || /[\\\x00-\x1f\x7f]/.test(name) || name.split('/').some(part => !part || part === '.' || part === '..') || files.has(name) || bytes.length === 0 || bytes.length > MAX) fail('Invalid/duplicate/empty release file');
  if (name === 'LICENSE' || name.startsWith('licenses/')) {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (text.includes('\0') || !text.trim()) fail('Invalid or empty license text');
  }
  files.set(name, bytes);
}
for (const name of ['bosun', 'build.json', verified.archive, 'SHA256SUMS']) add(name, regularBytes(path.join(artifact, name), MAX));
add('qualification.json', qualificationBytes);
add('LICENSE', regularBytes(path.join(root, 'LICENSE'), 1024 * 1024));
if (command(git, ['hash-object', '--', 'LICENSE']) !== command(git, ['rev-parse', 'HEAD:LICENSE'])) fail('Project license is not committed source');
const guidePath = 'docs/upgrade-and-install.md';
const guideBytes = regularBytes(path.join(root, guidePath), 1024 * 1024);
if (command(git, ['hash-object', '--', guidePath]) !== command(git, ['rev-parse', `HEAD:${guidePath}`])) fail('Installation guide is not committed reviewed source');
add('INSTALL.md', guideBytes);
const lock = parseBunLock(regularBytes(path.join(root, 'bun.lock'), 4 * 1024 * 1024));
const pkg = record(JSON.parse(regularBytes(path.join(root, 'package.json'), 131072).toString('utf8')));
const packages = productionPackages(lock, pkg.dependencies as Record<string, string>);
if (packages.length !== 70) fail('Production license inventory differs from reviewed 70-package lock');
const notices: {name: string; version: string; source: string; files: string[]}[] = [];
for (const dependency of packages) {
  const directory = path.join(root, 'node_modules', dependency.name);
  const names = fs.readdirSync(directory).filter(name => /^(?:licen[sc]e|copying|notice)(?:[.-].*)?$/i.test(name)).sort();
  const bundled: string[] = [];
  for (const name of names) {
    const relative = `node_modules/${dependency.name}/${name}`;
    const bytes = regularBytes(path.join(directory, name), 1024 * 1024);
    if (inputs.get(relative) !== sha256(bytes)) fail(`Notice differs from verified build: ${relative}`);
    const destination = `licenses/packages/${dependency.name}/${name}`;
    add(destination, bytes); bundled.push(destination);
  }
  if (!bundled.length && dependency.name === 'yoga-layout' && dependency.version === '3.2.1') {
    const destination = 'licenses/packages/yoga-layout/LICENSE';
    add(destination, regularBytes(path.join(root, 'docs/licenses/yoga-LICENSE'), 1024 * 1024)); bundled.push(destination);
  }
  if (!bundled.length) fail(`Missing production license: ${dependency.name}@${dependency.version}`);
  notices.push({ ...dependency, source: `https://registry.npmjs.org/${dependency.name}/-/${dependency.name.split('/').at(-1)}-${dependency.version}.tgz`, files: bundled });
}
const licenseDirectory = path.join(root, 'docs/licenses');
const licenseNames = fs.readdirSync(licenseDirectory).sort();
for (const required of ['bun-LICENSE.md', 'yoga-LICENSE', 'RELINKING.md', 'LGPL-2.0.txt', 'LGPL-2.1.txt']) if (!licenseNames.includes(required)) fail(`Missing reviewed license/relink document: ${required}`);
for (const name of licenseNames) {
  add(`licenses/runtime/${name}`, regularBytes(path.join(licenseDirectory, name), 4 * 1024 * 1024));
  if (command(git, ['hash-object', '--', `docs/licenses/${name}`]) !== command(git, ['rev-parse', `HEAD:docs/licenses/${name}`])) fail('Runtime license/relink document is not committed reviewed source');
}
if (!files.get('licenses/runtime/bun-LICENSE.md')?.toString('utf8').includes('LGPL')) fail('Bun LGPL notice missing');
const source = { project: `https://github.com/vprodan/bosun/tree/${tag}`, commit, bun: { version: '1.4.3', commit: 'c6da4a4d3', url: 'https://github.com/oven-sh/bun/tree/c6da4a4d3' }, sqlite: { archives: INPUTS.map(({name, url, sha256}) => ({name, url, sha256})), patch: { path: PATCH, sha256: PATCH_SHA256 }, publicDomain: 'https://www.sqlite.org/copyright.html' } };
add('THIRD_PARTY.json', Buffer.from(JSON.stringify({ schema: 1, source, packages: notices, disclaimer: 'Not a legal-clearance opinion. Preserve notices and review licenses/runtime/RELINKING.md before redistribution or modification.' }, null, 2) + '\n'));
const members = [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, bytes]) => ({ path: name, bytes: bytes.length, sha256: sha256(bytes) }));
if (members.length > 1000 || members.reduce((total, member) => total + member.bytes, 0) > 600 * 1024 * 1024) fail('Release ZIP inventory exceeds bounds');
const zipName = `bosun-${verified.version}-darwin-arm64.zip`;
const notes = Buffer.from(`# Bosun ${tag}\n\n## Getting started\n\nDownload **${zipName}**, unzip it, and open **INSTALL.md** in the extracted folder. Bosun is a Terminal app for Apple Silicon Macs, not a graphical app. Bun is bundled: do not install Node, Bun or npm to use this release. You do not need to unpack the inner tar.gz.\n\nIn Terminal, open the extracted folder and run:\n\n\`\`\`sh\nshasum -a 256 -c SHA256SUMS && ./bosun install\n\`\`\`\n\nThe installer reviews preparation/reinstall, executable replacement and optional background start step by step. Optional Ollama installation, app launch and the exact configured model pull each need separate approval. Memory/settings and uncertain receipts are retained; model downloads never submit inference.\n\nAfter installation: **bosun install** offers reinstall, **bosun update** verifies the latest stable GitHub release before opening its installer, and **bosun uninstall** removes owned installation files while retaining data/tools/models. Private GitHub updates require existing authorized gh access; Bosun does not change authentication. Older binaries need this ZIP once to gain the new commands.\n\nThe complete guide is also available at https://github.com/vprodan/bosun/blob/${tag}/docs/upgrade-and-install.md . Checksums and release.json are verification files, not installers. This binary is not notarized; the guide explains macOS security prompts and safe first-run options.\n\n## Build evidence\n\nCommit: ${commit}\nTarget: macOS arm64\nBun: 1.4.3\n\nCompiled local release safety checks passed for binary SHA-256 ${verified.binarySha256}. Full runtime qualification remains unverified; live hosts, live models, and personal activation were not exercised.\n\nThe ZIP preserves the original distribution and includes dependency/runtime notices, source references, and LGPL relinking guidance. This is not a legal-clearance opinion.\n`);
const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bosun-package-')));
let created = false;
try {
  for (const [name, bytes] of files) {
    const target = path.join(temp, name); fs.mkdirSync(path.dirname(target), {recursive: true, mode: 0o700});
    fs.writeFileSync(target, bytes, {flag: 'wx', mode: name === 'bosun' ? 0o755 : 0o644});
    fs.utimesSync(target, 0, 0);
  }
  const archive = path.join(temp, 'release.zip');
  command('/usr/bin/zip', ['-X', '-q', archive, ...members.map(member => member.path)], temp);
  const zip = regularBytes(archive, MAX);
  const release = Buffer.from(JSON.stringify({ schema: 1, product: 'bosun', tag, version: verified.version, commit, target: verified.target, runtimeQualification: 'unverified', compiledSafety: 'passed', binarySha256: verified.binarySha256, buildSha256: sha256(buildBytes), originalArchive: {name: verified.archive, sha256: verified.archiveSha256}, qualificationSha256: sha256(qualificationBytes), source, packages: notices, members, assets: [{name: zipName, bytes: zip.length, sha256: sha256(zip)}, {name: 'RELEASE_NOTES.md', bytes: notes.length, sha256: sha256(notes)}] }, null, 2) + '\n');
  if (release.length > 4 * 1024 * 1024) fail('Release metadata too large');
  const outputs = new Map([[zipName, zip], ['release.json', release], ['RELEASE_NOTES.md', notes]]);
  const sums = [...outputs].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, bytes]) => `${sha256(bytes)}  ${name}\n`).join('');
  fs.mkdirSync(output, {mode: 0o755}); created = true;
  for (const [name, bytes] of outputs) fs.writeFileSync(path.join(output, name), bytes, {flag: 'wx', mode: 0o644});
  fs.writeFileSync(path.join(output, 'SHA256SUMS'), sums, {flag: 'wx', mode: 0o644});
  console.log(JSON.stringify({tag, commit, output, archive: zipName, binarySha256: verified.binarySha256}));
} catch (error) {
  if (created) fs.rmSync(output, {recursive: true});
  throw error;
} finally { fs.rmSync(temp, {recursive: true, force: true}); }
