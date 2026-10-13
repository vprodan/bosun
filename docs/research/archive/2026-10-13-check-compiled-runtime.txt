// Review-only local-runtime qualification. Not registered in application tests.
// Running requires the owner's separate exact-binary Bun/runtime exception.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { verifyDistribution } from './distribution.mjs';
import { defaultConfig } from '../src/core/domain/config.ts';
import { renderRuntimeConfig } from '../src/platform/config.ts';

const expectedHash = '39fa79df688a7d3f52bf26213745d24d76f3d41382ec0a3a9f6bc032ea6f7f19';
const expectedSource = 'd62e28cdb141adcbaa19c11ad4ddd6165cad7f313bc15e1fc1041b41650ab725';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const outputLimit = 1024 * 1024;
const assertions = [];
let temporary, daemon;
let stage = 'admission', failure = null, cleaned = false;

// The schema requires an enabled primary. Registry construction is lazy; no
// selection/job is submitted here. Its command is absent inside the owned tree.
export function isolatedConfig(home) {
  const config = defaultConfig();
  config.hosts.primary = 'opencode'; config.hosts.omp.enabled = false;
  config.hosts.codex.enabled = false; config.hosts.claude.enabled = false;
  config.hosts.opencode.command = path.join(home, 'empty-path', 'no-opencode');
  config.hosts.opencode.url = 'http://127.0.0.1:1';
  config.handoff.enabled = false; config.memory.claudeMem = false;
  config.graph.enabled = false; config.graph.vectors = false; config.graph.extraction = false;
  config.graph.consolidation.schedule.enabled = false; config.notifications.enabled = false; config.remote.enabled = false;
  config.router.url = 'http://127.0.0.1:1'; config.providers.default.url = 'http://127.0.0.1:1';
  return config;
}

function launch(binary, args, cwd, env) {
  const child = spawn(binary, args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', bytes = 0, failed = null, result;
  const kill = signal => { try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') failed ??= 'termination'; } };
  for (const [stream, name] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) stream.on('data', data => {
    bytes += data.length;
    if (bytes > outputLimit) { failed ??= 'output-bound'; kill('SIGKILL'); return; }
    if (name === 'stdout') stdout += data.toString('utf8'); else stderr += data.toString('utf8');
  });
  child.stdin.on('error', () => { failed ??= 'stdin'; kill('SIGKILL'); });
  const joined = new Promise(resolve => {
    child.once('error', () => { failed ??= 'spawn'; });
    child.once('close', (code, signal) => { result = { code, signal }; resolve(result); });
  });
  child.stdin.end();
  return { child, joined, kill, stdout: () => stdout, stopped: () => result !== undefined,
    async stop() {
      if (!result) kill('SIGTERM');
      const timer = setTimeout(() => { if (!result) { failed ??= 'join-deadline'; kill('SIGKILL'); } }, 10000);
      try { return await joined; } finally { clearTimeout(timer); }
    },
    report() { return { args, ...result, failure: failed, stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr), stdoutSha256: sha(stdout), stderrSha256: sha(stderr) }; },
  };
}
async function run(binary, args, cwd, env) {
  const spawned = launch(binary, args, cwd, env);
  const timer = setTimeout(() => spawned.kill('SIGKILL'), 15000);
  try {
    const result = await spawned.joined;
    assertions.push({ check: args.join(' '), ...spawned.report() });
    assert.equal(result.code, 0); assert.equal(result.signal, null); assert.equal(spawned.report().failure, null);
    return spawned.stdout();
  } finally { clearTimeout(timer); if (!spawned.stopped()) await spawned.stop(); }
}
async function rpc(socket, workspace, audience, method, params, sequence, invalid = false) {
  const id = 'qualification_' + sequence;
  const body = JSON.stringify({ version: 1, id, method, params, scope: { workspace, sessionId: null, audience } });
  const reply = await new Promise((resolve, reject) => {
    let size = 0, text = '';
    const request = http.request({ socketPath: socket, path: '/rpc', method: 'POST', agent: false,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, response => {
      response.on('data', data => { size += data.length; if (size > outputLimit) request.destroy(Error('bound')); else text += data.toString('utf8'); });
      response.once('error', reject);
      response.once('end', () => { try { assert.equal(response.statusCode, 200); resolve(JSON.parse(text)); } catch { reject(Error('receipt')); } });
    });
    const timer = setTimeout(() => request.destroy(Error('deadline')), 5000);
    request.once('close', () => clearTimeout(timer)); request.once('error', reject); request.end(body);
  });
  assert.equal(reply.version, 1); assert.equal(reply.id, id);
  if (invalid) { assert.equal(reply.ok, false); assert.equal(reply.error?.code, 'invalid'); return reply.error; }
  assert.equal(reply.ok, true);
  return reply.result;
}
async function main() {
try {
  assert.equal(process.versions.bun, undefined); assert.ok(Number(process.versions.node.split('.')[0]) >= 24);
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
  const [scope, artifact, ...extra] = process.argv.slice(2);
  assert.equal(scope, '--approved-local-runtime-only'); assert.equal(extra.length, 0); assert.ok(artifact);
  stage = 'artifact-integrity';
  const directory = path.resolve(artifact), verified = verifyDistribution(directory);
  assert.equal(verified.version, '0.2.0'); assert.equal(verified.binarySha256, expectedHash); assert.equal(verified.sourceDigest, expectedSource);
  const bytes = fs.readFileSync(path.join(directory, 'bosun')); assert.equal(sha(bytes), expectedHash);
  temporary = fs.realpathSync(fs.mkdtempSync('/tmp/bosun-runtime-')); fs.chmodSync(temporary, 0o700);
  const binary = path.join(temporary, 'bosun'); fs.writeFileSync(binary, bytes, { mode: 0o700, flag: 'wx' });
  assert.equal(sha(fs.readFileSync(binary)), expectedHash);
  const home = path.join(temporary, 'home'), workspace = path.join(home, 'workspace'), runtime = path.join(home, 'runtime');
  fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(workspace, '.git'), { mode: 0o700 });
  fs.writeFileSync(path.join(workspace, '.git', 'config'), '[remote "origin"]\n url = https://fixture.invalid/compiled-qualification.git\n', { mode: 0o600 });
  const directories = Object.fromEntries(['config', 'cache', 'data', 'state', 'tmp', 'empty-path'].map(name => [name, path.join(home, name)]));
  for (const value of Object.values(directories)) fs.mkdirSync(value, { mode: 0o700 });
  const socket = path.join(temporary, 'bosun.sock');
  const env = { HOME: home, BOSUN_HOME: runtime, BOSUN_SOCKET: socket, XDG_CONFIG_HOME: directories.config,
    XDG_CACHE_HOME: directories.cache, XDG_DATA_HOME: directories.data, XDG_STATE_HOME: directories.state,
    TMPDIR: directories.tmp, PATH: directories['empty-path'], LANG: 'C', TZ: 'UTC' };
  stage = 'temporary-setup';
  await run(binary, ['setup'], workspace, env);
  stage = 'temporary-config-validation';
  const config = isolatedConfig(home);
  fs.writeFileSync(path.join(runtime, 'config.toml'), renderRuntimeConfig(config), { mode: 0o600 });
  stage = 'temporary-daemon-readiness';
  daemon = launch(binary, ['daemon', 'run'], workspace, env);
  const deadline = Date.now() + 15000;
  while (!daemon.stdout().includes('bosun daemon ready\n')) {
    if (daemon.stopped() || Date.now() > deadline) throw Error('daemon-readiness');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  let sequence = 0;
  const call = (audience, method, params, invalid = false) => rpc(socket, workspace, audience, method, params, ++sequence, invalid);
  const publicText = 'COMPILED_PUBLIC_FIXTURE_431 build rules use pnpm install packages';
  const privateText = 'COMPILED_PRIVATE_FIXTURE_927 build rules use a secret package registry';
  stage = 'original-public-store';
  const publicNote = await call('owner', 'memory.store', { category: 'project', title: 'Build rules public', body: publicText, source: 'cli' });
  stage = 'original-private-store';
  const privateNote = await call('owner', 'memory.store', { category: 'project', title: 'Build rules private', body: privateText, private: true, source: 'cli' });
  assert.ok(publicNote.memory.id); assert.ok(privateNote.memory.id);
  stage = 'owner-private-get';
  const owner = await call('owner', 'memory.get', { id: privateNote.memory.id });
  assert.ok(JSON.stringify(owner).includes(privateText));
  stage = 'model-private-search-exclusion';
  await call('model', 'memory.search', { text: 'build rules', includePrivate: true }, true);
  const model = await call('model', 'memory.search', { text: 'build rules' });
  assert.ok(JSON.stringify(model).includes(publicText)); assert.ok(!JSON.stringify(model).includes(privateText));
  stage = 'model-private-context-exclusion';
  const context = await call('model', 'context.retrieve', { task: 'build rules pnpm install packages', sources: ['lexical'], privacy: 'public', includeCandidates: true });
  assert.ok(JSON.stringify(context).includes('COMPILED_PUBLIC_FIXTURE_431')); assert.ok(!JSON.stringify(context).includes('COMPILED_PRIVATE_FIXTURE_927'));
  assertions.push({ check: 'temporary-sqlite-owner-model-context', passed: true, originalMutations: 2, modelPrivateRequestRejected: true, modelPrivateExcluded: true });
  stage = 'temporary-daemon-status';
  const status = await call('owner', 'daemon.status', {}); assert.ok(status);
  stage = 'temporary-daemon-join';
  const terminal = await daemon.stop();
  assert.equal(terminal.code, 0); assert.equal(terminal.signal, null); assert.equal(daemon.report().failure, null);
} catch {
  failure = stage;
} finally {
  try {
    if (daemon && !daemon.stopped()) await daemon.stop();
    if (daemon) assertions.push({ check: 'temporary-daemon-join', ...daemon.report() });
  } catch { failure ??= 'cleanup-join'; }
  // Never remove a runtime while its original producer may still own it.
  if (!daemon || daemon.stopped()) {
    try {
      if (temporary) { fs.rmSync(temporary, { recursive: true, force: true }); cleaned = !fs.existsSync(temporary); }
    } catch { failure ??= 'temporary-cleanup'; }
  } else failure ??= 'cleanup-join';
}
if (temporary && !cleaned) failure ??= 'temporary-cleanup';
console.log(JSON.stringify({ coverage: 'compiled-local-runtime-only', binarySha256: expectedHash, sourceDigest: expectedSource,
  applicationSuiteRuntime: 'node', publicHookDelivery: 'unqualified-held', assertions,
  originalDaemonJoined: daemon ? daemon.stopped() : null, temporaryRemoved: temporary ? cleaned : null,
  qualified: failure === null, failure }, null, 2));
if (failure) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
