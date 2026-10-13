// Review-only exact-artifact batch. Product execution needs a new explicit
// owner exception; importing the probes performs no runtime/build operations.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { pathToFileURL } from 'node:url';
import { collectInputs } from './distribution.mjs';
import { isolatedConfig } from './check-compiled-runtime.mjs';
import { renderRuntimeConfig } from '../src/platform/config.ts';
import { streamProcess } from '../src/platform/process.ts';
export { isolatedConfig };

const ROOT = path.resolve(import.meta.dirname, '..');
export const CURRENT_PINS = Object.freeze({
  binary: '8466c8ffabab081687bd737d6aa610138c74abe8aa3c21a5694757df0b217176',
  archive: 'eff6591f0810b20eb2666b5a0827da344c24db5372175846ca7958ac312287ee',
  metadata: '19a528774461db0e3ad0cf116589bfceff447808101faa4471fd9ebf95cf2b55',
  source: 'a06890a071197bd9fc2b6948e0bc97dac918ce8b564a59442f09a598f4c29367',
  checkout: 'a484016981086346c94b1ba72eb11a8c884edac4d9905bc9fac34dcbd2c74bab',
  compiler: '35d20dd0263e5c950194434b925454fdfa9ba6e4467da960410fa05b08a7a5b5',
  variant: 'bb7bd6da321e5107a82fb728532cfff4069feb488f40e1cf8a6d697447e674ae',
  generator: '69ac97416f32430352f9a1b26b513c1fafcc62b81766d1a97ea69265c4ece00f',
  sqliteRuntime: '12287d5e5c3eb481a00f5609a1bbc429ed248ee147bfb382a75714ed4d20a2a4',
  oldRuntimeDriver: '7302ce86925f9d425742170278b7ea928b703b9d678614033b1659960ad0e109',
  process: '4a0bb56e34b10a0e802856d1cfba869fb47d6d11eb9d25a07be93a8aef589e4b',
});
const OUTPUT = 1048576, DISK = 512 * 1024 * 1024;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const finiteCode = error => ['invalid', 'unavailable', 'timeout', 'cancelled'].includes(error?.code) ? error.code : 'failed';
function read(file, maximum = 4 * 1024 * 1024) {
  const before = fs.lstatSync(file);
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size <= maximum);
  assert.equal(fs.realpathSync(file), file);
  const bytes = fs.readFileSync(file), after = fs.lstatSync(file);
  assert.equal(before.dev, after.dev); assert.equal(before.ino, after.ino);
  assert.equal(before.size, bytes.length); assert.equal(before.mtimeMs, after.mtimeMs); assert.equal(before.ctimeMs, after.ctimeMs);
  return bytes;
}

// The private copy has precisely the archived variant verifier and its two
// pure local dependencies. It neither compiles nor weakens production flags.
export async function verifyCurrentArtifact(directory, privateRoot) {
  directory = path.resolve(directory);
  const verifyRoot = path.join(privateRoot, 'static-verifier');
  fs.mkdirSync(verifyRoot, { mode: 0o700 });
  const copies = [
    ['docs/research/checkpoints/2026-10-11-compiled-current-build-tool.txt', 'scripts/distribution.mjs', CURRENT_PINS.variant],
    ['scripts/generate-assets.mjs', 'scripts/generate-assets.mjs', CURRENT_PINS.generator],
    ['src/platform/sqlite-runtime.ts', 'src/platform/sqlite-runtime.ts', CURRENT_PINS.sqliteRuntime],
  ];
  for (const [source, target, expected] of copies) {
    const bytes = read(path.join(ROOT, source)); assert.equal(sha(bytes), expected);
    const file = path.join(verifyRoot, target); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
  }
  try {
    const { verifyDistribution } = await import(pathToFileURL(path.join(verifyRoot, 'scripts/distribution.mjs')).href);
    const result = verifyDistribution(directory);
    assert.equal(result.version, '0.2.0'); assert.equal(result.inputs, 7282);
    assert.equal(result.binarySha256, CURRENT_PINS.binary); assert.equal(result.archiveSha256, CURRENT_PINS.archive);
    assert.equal(result.sourceDigest, CURRENT_PINS.source);
    const metadataBytes = read(path.join(directory, 'build.json'));
    assert.equal(sha(metadataBytes), CURRENT_PINS.metadata);
    const metadata = JSON.parse(metadataBytes);
    assert.equal(metadata.compiler.version, '1.4.2'); assert.equal(metadata.compiler.sha256, CURRENT_PINS.compiler);
    assert.equal(metadata.flags.includes('--bytecode'), false);
    assert.ok(metadata.flags.includes('--format=esm') && metadata.flags.includes('--splitting'));
    return result;
  } finally { fs.rmSync(verifyRoot, { recursive: true, force: true }); }
}

export function prepareIsolation(root, name) {
  const home = path.join(root, name), cwd = path.join(home, 'workspace');
  fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(cwd, '.git'), { mode: 0o700 });
  fs.writeFileSync(path.join(cwd, '.git/config'), '[remote "origin"]\n url = https://fixture.invalid/compiled-current.git\n', { mode: 0o600 });
  const directories = Object.fromEntries(['runtime', 'config', 'cache', 'data', 'state', 'tmp', 'empty-path']
    .map(name => [name, path.join(home, name)]));
  for (const directory of Object.values(directories)) fs.mkdirSync(directory, { mode: 0o700 });
  const socket = path.join(root, 'b.sock');
  const env = { HOME: home, BOSUN_HOME: directories.runtime, BOSUN_SOCKET: socket,
    XDG_CONFIG_HOME: directories.config, XDG_CACHE_HOME: directories.cache,
    XDG_DATA_HOME: directories.data, XDG_STATE_HOME: directories.state,
    TMPDIR: directories.tmp, TMP: directories.tmp, TEMP: directories.tmp,
    PATH: directories['empty-path'], LANG: 'C', LC_ALL: 'C', TZ: 'UTC' };
  return { cwd, env, home, runtime: directories.runtime, socket };
}

export function cleanupAllowed({ rootsJoined, benchmarkAttempted, benchmarkVerified }) {
  return rootsJoined === true && (benchmarkAttempted !== true || benchmarkVerified === true);
}
export function ownedTreeBytes(root) {
  let total = 0, count = 0;
  function walk(directory, depth) {
    assert.ok(depth <= 20);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      assert.ok(++count <= 16384 && !entry.isSymbolicLink());
      const file = path.join(directory, entry.name), stat = fs.lstatSync(file);
      if (stat.isDirectory()) walk(file, depth + 1);
      else if (stat.isFile()) { total += stat.size; assert.ok(total <= DISK); }
      else assert.ok(stat.isSocket());
    }
  }
  walk(root, 0); return total;
}

export const entryCases = Object.freeze([
  { name: 'version', args: ['--version'], input: '' },
  { name: 'help', args: ['--help'], input: '' },
  { name: 'private-hook', args: ['hook', '--private'], input: '{invented-malformed' },
  { name: 'private-route-hook', args: ['route', '--hook', '--private'], input: '{invented-malformed' },
  { name: 'mcp-initialize-eof', args: ['mcp'], initialize: true },
]);
export async function processProbe(context, args, { execute = streamProcess, timeoutMs = 15000, input = '', stdin, stdout, controller = new AbortController(), receipt } = {}) {
  const state = receipt ?? { args, joined: false, code: null, signal: null, error: null };
  const chunks = []; const started = performance.now();
  try {
    for await (const event of execute({ command: context.binary, args, cwd: context.cwd, env: context.env,
      signal: controller.signal, timeoutMs, killGraceMs: 1000, maxOutputBytes: OUTPUT,
      ...(stdin ? { stdin } : { input }),
      stdout(chunk) { chunks.push(Buffer.from(chunk)); stdout?.(chunk); },
      onClosed() { state.joined = true; },
    })) if (event.t === 'exit') { state.code = event.code; state.signal = event.signal; }
  } catch (error) { state.error = finiteCode(error); }
  state.wallMs = performance.now() - started;
  const text = Buffer.concat(chunks).toString('utf8');
  state.stdoutBytes = Buffer.byteLength(text); state.stdoutSha256 = sha(text);
  return { receipt: state, text };
}

export async function runEntryProbe(context, entry, dependencies = {}) {
  const controller = new AbortController();
  const decoder = new StringDecoder('utf8');
  let writer, pending = '', initialized = false, eofSent = !entry.initialize, inputFailed = false;
  const initialization = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'bosun-current-entry-check', version: '1' } } }) + '\n';
  const result = await processProbe(context, entry.args, { ...dependencies, controller, timeoutMs: 5000, input: entry.input,
    ...(entry.initialize ? {
      stdin(input) { writer = input; void input.write(initialization).catch(() => { inputFailed = true; controller.abort(); }); },
      stdout(chunk) {
        pending += decoder.write(chunk);
        for (;;) {
          const newline = pending.indexOf('\n'); if (newline < 0) break;
          const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
          if (!line.trim()) continue;
          const message = JSON.parse(line);
          assert.equal(initialized, false); assert.equal(message.jsonrpc, '2.0'); assert.equal(message.id, 1);
          assert.equal(message.error, undefined); assert.equal(message.result?.serverInfo?.name, 'bosun');
          assert.equal(message.result?.serverInfo?.version, '0.2.0'); assert.equal(message.result?.protocolVersion, '2025-11-25');
          initialized = true; eofSent = true; writer.end();
        }
      },
    } : {}),
  });
  let passed = false;
  try {
    assert.equal(result.receipt.joined, true); assert.equal(result.receipt.code, 0);
    assert.equal(result.receipt.signal, null); assert.equal(result.receipt.error, null); assert.equal(inputFailed, false);
    if (entry.name === 'version') assert.equal(result.text.trim(), '0.2.0');
    else if (entry.name === 'help') {
      assert.match(result.text, /Usage: bosun/);
      for (const command of ['run', 'mcp', 'managed', 'upgrade']) assert.match(result.text, new RegExp('\\b' + command + '\\b'));
    } else if (entry.initialize) { assert.ok(initialized && eofSent); assert.equal(pending.trim(), ''); }
    else assert.equal(result.text, '');
    passed = true;
  } catch { /* finite failed receipt, no raw output */ }
  return { check: entry.name, ...result.receipt, initialized: entry.initialize ? initialized : undefined, eofSent, passed };
}

export function foregroundDaemon(context, dependencies = {}) {
  const controller = new AbortController();
  const receipt = { args: ['daemon', 'run'], joined: false, code: null, signal: null, error: null };
  let readyResolve; const ready = new Promise(resolve => { readyResolve = resolve; });
  let prefix = '', announced = false;
  const pumping = processProbe(context, receipt.args, { ...dependencies, receipt, controller, timeoutMs: 60000,
    stdout(chunk) { prefix += Buffer.from(chunk).toString('utf8'); if (!announced && prefix.includes('bosun daemon ready\n')) { announced = true; readyResolve(); } },
  });
  return {
    receipt,
    async ready() {
      let timer;
      try { await Promise.race([ready, pumping.then(() => { if (!announced) throw Error('readiness'); }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Error('readiness')), 15000); })]); }
      finally { clearTimeout(timer); }
      assert.equal(announced, true); assert.equal(receipt.joined, false);
    },
    async close() {
      controller.abort(); await pumping;
      return { ...receipt, controlledCancellation: receipt.error === 'cancelled',
        gracefulExitCode: 'unqualified-not-exposed-on-controlled-cancellation' };
    },
  };
}

export async function runSqliteRequests(call) {
  const publicText = 'COMPILED_PUBLIC_FIXTURE_431 build rules use pnpm install packages';
  const privateText = 'COMPILED_PRIVATE_FIXTURE_927 build rules use a secret package registry';
  const publicNote = await call('owner', 'memory.store', { category: 'project', title: 'Build rules public', body: publicText, source: 'cli' });
  const privateNote = await call('owner', 'memory.store', { category: 'project', title: 'Build rules private', body: privateText, private: true, source: 'cli' });
  assert.match(publicNote.memory.id, /^m_[a-z0-9]+$/); assert.match(privateNote.memory.id, /^m_[a-z0-9]+$/);
  assert.notEqual(publicNote.memory.id, privateNote.memory.id);
  const owner = await call('owner', 'memory.get', { id: privateNote.memory.id });
  assert.ok(JSON.stringify(owner).includes(privateText));
  const rejected = await call('model', 'memory.search', { text: 'build rules', includePrivate: true }, true);
  assert.equal(rejected.code, 'invalid');
  const model = await call('model', 'memory.search', { text: 'build rules' });
  assert.ok(JSON.stringify(model).includes(publicText)); assert.ok(!JSON.stringify(model).includes(privateText));
  const context = await call('model', 'context.retrieve', { task: 'build rules pnpm install packages', sources: ['lexical'], privacy: 'public', includeCandidates: true });
  assert.ok(JSON.stringify(context).includes('COMPILED_PUBLIC_FIXTURE_431')); assert.ok(!JSON.stringify(context).includes('COMPILED_PRIVATE_FIXTURE_927'));
  const status = await call('owner', 'daemon.status', {}); assert.ok(status);
  return { requests: 7, originalMutations: 2, privateOwnerReadable: true, modelPrivateOverrideRejected: true,
    modelPrivateSearchExcluded: true, modelPrivateContextExcluded: true, ownerStatusReceived: true };
}

export async function currentRpc(socket, workspace, audience, method, params, sequence, invalid = false) {
  const id = 'current_' + sequence;
  const body = JSON.stringify({ version: 1, id, method, params, scope: { workspace, sessionId: null, audience } });
  const reply = await new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    const request = http.request({ socketPath: socket, path: '/rpc', method: 'POST', agent: false,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, response => {
      response.on('data', chunk => { if ((size += chunk.length) > OUTPUT) request.destroy(Error('bound')); else chunks.push(chunk); });
      response.once('error', reject);
      response.once('end', () => { try { assert.equal(response.statusCode, 200); resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(Error('receipt')); } });
    });
    const timer = setTimeout(() => request.destroy(Error('deadline')), 5000);
    request.once('close', () => clearTimeout(timer)); request.once('error', reject); request.end(body);
  });
  assert.equal(reply.version, 1); assert.equal(reply.id, id);
  if (invalid) { assert.equal(reply.ok, false); assert.equal(reply.error?.code, 'invalid'); return reply.error; }
  assert.equal(reply.ok, true); return reply.result;
}

export function classifyBenchmark(report) {
  const distribution = (value, samples) => {
    assert.equal(value?.samples, samples);
    if (!samples) { assert.equal(value.p50, null); assert.equal(value.p95, null); }
    else { assert.ok(Number.isFinite(value.p50) && Number.isFinite(value.p95) && value.p50 >= 0 && value.p95 >= value.p50 && value.p95 <= 180000); }
    return { samples, p50: value.p50, p95: value.p95 };
  };
  assert.equal(report.schema, 1); assert.deepEqual(report.corpus, { notes: 10000, seed: 42, synthetic: true });
  assert.equal(report.runtime?.engine, 'bun'); assert.equal(report.runtime.version, '1.4.2'); assert.equal(Object.hasOwn(report.runtime, 'node'), false);
  assert.equal(report.queries, 200);
  const store = distribution(report.store, 10000), search = distribution(report.search, 200), context = distribution(report.context, 200);
  assert.equal(report.corpusLoading?.epochNotes, 256); distribution(report.corpusLoading.lifecycle, 39);
  assert.equal(report.tokens?.estimator, 'char/4'); assert.equal(report.tokens.hostTokens, 'unverified'); assert.equal(report.tokens.budget, 400);
  assert.equal(report.tokens.withinEstimate, 200); assert.ok(Number.isFinite(report.tokens.maximumEstimate) && report.tokens.maximumEstimate >= 0 && report.tokens.maximumEstimate <= 400);
  assert.equal(report.hook?.processStartup, 'new-process-per-attempt'); assert.equal(report.hook.processCompletion, 'original-and-group-confirmed');
  assert.equal(report.hook.daemon, 'absent'); assert.equal(report.hook.runs, 20);
  assert.deepEqual(report.hook.outcomes, { injected: 20, held: 0, failed: 0, unqualified: 0 });
  assert.equal(report.hook.firstRun?.outcome, 'injected'); assert.ok(Number.isFinite(report.hook.firstRun.wallMs) && report.hook.firstRun.wallMs >= 0 && report.hook.firstRun.wallMs <= 180000);
  const wall = distribution(report.hook.wall, 20), injectedWall = distribution(report.hook.verifiedInjectionWall, 20);
  assert.deepEqual(wall, injectedWall); assert.equal(report.hook.componentLatency, null);
  assert.equal(report.publicView, 'ready-synthetic'); assert.equal(report.designatedMacLatency, 'unverified');
  assert.equal(report.ownerStorageOpened, false); assert.equal(report.modelsCalled, false);
  for (const key of ['primary', 'view']) assert.ok(Number.isSafeInteger(report.bytes?.[key]) && report.bytes[key] > 0 && report.bytes[key] <= DISK);
  return { corpus: report.corpus, engine: 'bun', runtimeVersion: '1.4.2', queries: 200, store, search, context,
    firstRun: { wallMs: report.hook.firstRun.wallMs, outcome: 'injected' }, outcomes: report.hook.outcomes, wall, verifiedInjectionWall: injectedWall,
    nestedProducersReportedJoined: 21, componentLatency: null, hostTokens: 'unverified', designatedMacLatency: 'unverified' };
}

export async function runBenchmarkProbe(context, dependencies = {}) {
  const result = await processProbe(context, ['memory', 'bench', '--n', '10000', '--public-view'], { ...dependencies, timeoutMs: 180000 });
  let benchmark = null;
  try {
    assert.equal(result.receipt.joined, true); assert.equal(result.receipt.code, 0); assert.equal(result.receipt.signal, null); assert.equal(result.receipt.error, null);
    benchmark = classifyBenchmark(JSON.parse(result.text));
  } catch { /* failed report cannot authorize nested-producer cleanup */ }
  return { receipt: result.receipt, benchmark, passed: benchmark !== null };
}

async function main() {
  let temporary, identity, foreground, stage = 'admission', failure = null, benchmarkAttempted = false, benchmarkVerified = false, removed = false;
  const roots = [], checks = []; let benchmark = null, peakDiskBytes = 0, diskFailure = false;
  const batchController = new AbortController(); let totalTimer, diskTimer;
  const interrupt = () => batchController.abort();
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    assert.equal(process.versions.bun, undefined); assert.ok(Number(process.versions.node.split('.')[0]) >= 24);
    assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
    const [approval, artifact, ...extra] = process.argv.slice(2);
    assert.equal(approval, '--approved-current-qualification-only'); assert.equal(extra.length, 0); assert.ok(artifact);
    assert.equal(path.resolve(artifact), path.join(ROOT, 'dist/bosun-0.2.0-darwin-arm64-current-candidate'));
    assert.equal(sha(read(path.join(ROOT, 'scripts/check-compiled-runtime.mjs'))), CURRENT_PINS.oldRuntimeDriver);
    assert.equal(sha(read(path.join(ROOT, 'src/platform/process.ts'))), CURRENT_PINS.process);
    assert.equal(collectInputs(ROOT).sourceDigest, CURRENT_PINS.checkout);
    temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bosun-current-qualification-')));
    fs.chmodSync(temporary, 0o700); identity = fs.lstatSync(temporary);
    stage = 'static-artifact-verification'; await verifyCurrentArtifact(artifact, temporary);
    const bytes = read(path.join(path.resolve(artifact), 'bosun'), 256 * 1024 * 1024); assert.equal(sha(bytes), CURRENT_PINS.binary);
    const binary = path.join(temporary, 'bosun'); fs.writeFileSync(binary, bytes, { flag: 'wx', mode: 0o700 });
    assert.equal(sha(read(binary, 256 * 1024 * 1024)), CURRENT_PINS.binary);
    totalTimer = setTimeout(() => batchController.abort(), 360000);
    diskTimer = setInterval(() => { try { peakDiskBytes = Math.max(peakDiskBytes, ownedTreeBytes(temporary)); }
      catch { diskFailure = true; batchController.abort(); } }, 250);
    function execute(spec) {
      const receipt = { args: [...spec.args], joined: false, code: null, signal: null, error: null }; roots.push(receipt);
      return streamProcess({ ...spec, signal: AbortSignal.any([spec.signal, batchController.signal]),
        onClosed() { receipt.joined = true; spec.onClosed?.(); } });
    }
    for (const entry of entryCases) {
      stage = 'entry-' + entry.name;
      const context = { binary, ...prepareIsolation(temporary, 'entry-' + entry.name) };
      const check = await runEntryProbe(context, entry, { execute }); checks.push(check); assert.equal(check.passed, true);
    }
    const context = { binary, ...prepareIsolation(temporary, 'runtime') };
    stage = 'disposable-setup'; const setup = await processProbe(context, ['setup'], { execute }); checks.push({ check: stage, ...setup.receipt });
    assert.equal(setup.receipt.joined, true); assert.equal(setup.receipt.code, 0); assert.equal(setup.receipt.error, null); assert.equal(setup.receipt.signal, null);
    fs.writeFileSync(path.join(context.runtime, 'config.toml'), renderRuntimeConfig(isolatedConfig(context.home)), { mode: 0o600 });
    stage = 'foreground-daemon-readiness'; foreground = foregroundDaemon(context, { execute }); await foreground.ready();
    stage = 'seven-owned-sqlite-rpcs'; let sequence = 0;
    const runtime = await runSqliteRequests((audience, method, params, invalid = false) => {
      stage = 'owned-rpc-' + (++sequence) + '-' + audience + '-' + method;
      return currentRpc(context.socket, context.cwd, audience, method, params, sequence, invalid);
    });
    assert.equal(sequence, 7); checks.push({ check: 'seven-owned-sqlite-rpcs', ...runtime });
    stage = 'foreground-daemon-completion'; const stopped = await foreground.close(); foreground = undefined;
    checks.push({ check: stage, ...stopped }); assert.equal(stopped.joined, true); assert.equal(stopped.controlledCancellation, true);
    // Metadata only: socket removal proves owned listener cleanup. Owner.db
    // persists; mode/journal absence is not an independent lock-reacquisition test.
    const ownerFile = path.join(context.runtime, 'run/owner.db'), owner = fs.lstatSync(ownerFile);
    const artifacts = { socketAbsent: !fs.existsSync(context.socket), ownerRegularPrivate: owner.isFile() && !owner.isSymbolicLink() && owner.nlink === 1 && (owner.mode & 0o7777) === 0o600,
      ownerJournalAbsent: !fs.existsSync(ownerFile + '-journal'), ownerLockIndependentlyReacquired: false };
    assert.ok(artifacts.socketAbsent && artifacts.ownerRegularPrivate && artifacts.ownerJournalAbsent);
    checks.push({ check: 'owned-shutdown-artifacts', ...artifacts });
    stage = 'one-synthetic-compiled-benchmark'; benchmarkAttempted = true;
    const result = await runBenchmarkProbe(context, { execute }); checks.push({ check: stage, ...result.receipt, passed: result.passed });
    benchmark = result.benchmark; benchmarkVerified = result.passed; assert.equal(result.passed, true);
    assert.equal(roots.length, 8); assert.equal(diskFailure, false); assert.equal(batchController.signal.aborted, false);
    peakDiskBytes = Math.max(peakDiskBytes, ownedTreeBytes(temporary));
  } catch { failure = stage; }
  finally {
    clearTimeout(totalTimer); clearInterval(diskTimer);
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
    if (foreground) { const stopped = await foreground.close(); checks.push({ check: 'cleanup-foreground-completion', ...stopped }); if (!stopped.joined) failure ??= 'original-daemon-join-unknown'; }
    const safe = cleanupAllowed({ rootsJoined: roots.every(root => root.joined), benchmarkAttempted, benchmarkVerified });
    if (temporary && safe) {
      try { const current = fs.lstatSync(temporary); assert.ok(current.isDirectory() && !current.isSymbolicLink()); assert.equal(current.dev, identity.dev); assert.equal(current.ino, identity.ino);
        fs.rmSync(temporary, { recursive: true, force: true }); removed = !fs.existsSync(temporary); }
      catch { failure ??= 'owned-tree-cleanup'; }
    }
    if (temporary && !removed) failure ??= 'owned-tree-retained';
  }
  console.log(JSON.stringify({ coverage: 'compiled-current-entry-sqlite-synthetic-benchmark', pins: CURRENT_PINS,
    applicationSuiteRuntime: 'node', checks, compiledRootInvocationsAttempted: roots.length,
    compiledInvocationsPlannedMaximum: 29, nestedHookInvocationsReportedJoined: benchmark?.nestedProducersReportedJoined ?? null,
    rootsJoined: roots.every(root => root.joined), benchmarkVerified, benchmark, peakDiskBytes,
    privateTreeRemoved: temporary ? removed : null, retainedPrivateTree: temporary && !removed ? temporary : null,
    nativeHostDelivery: 'unqualified', nativeToolPrivacy: 'unqualified', realDataOrModelQuality: 'unqualified', gracefulDaemonExitCode: 'unqualified',
    qualifiedForThisScope: failure === null, failure }, null, 2));
  if (failure) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
