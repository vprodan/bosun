// A new one-run owner exception is required. Importing this file runs no probe.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { pathToFileURL } from 'node:url';
import { collectInputs } from './distribution.mjs';
import { CURRENT_PINS, classifyBenchmark, cleanupAllowed, ownedTreeBytes,
  prepareIsolation, processProbe } from './check-compiled-current.mjs';
import { BosunError, isBosunErrorCode } from '../src/core/errors.ts';
import { rpcError } from '../src/contracts/rpc.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
export const CONSUMED_DRIVER_SHA256 = '09e42b5a564cf285a31be8f8696780d588731abb4e17e3744cc5180c69c014b7';
// Root must supply reviewed fresh static-build pins before an execution proposal.
// Historical current-candidate hashes do not identify the instrumented source.
export const INSTRUMENTED_PINS = Object.freeze({
  "binary": "bba7bfb39c530363de72e6462844b46b132088f4e738b7429430dee7af31a02a",
  "archive": "bb776df39db6530b976708ecf92a53b8a27c552ebc742ee45f0065977163315b",
  "metadata": "a49eeca3447549e2227fa322dbcce26abaf22f970ccf3b9ba6d7e5d5d163a651",
  "source": "1197aa21b3ef31c052bf096e9c4099ab64188c887c9ffe35a076e74100657441",
  "checkout": "0d053310d840abd41b722ffe662d1fdac2c2096190a7612303fe7e517161cf2e",
  "compiler": "35d20dd0263e5c950194434b925454fdfa9ba6e4467da960410fa05b08a7a5b5"
});
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const OUTPUT = 1048576;
// streamProcess deliberately discards stderr. This private Node relay preserves
// its unchanged lifecycle and byte bound. The compiled child is NOT detached:
// its original close and the relay's original/group join are separate receipts.
// Separately grouped hook producers still require the successful product report.
export const RELAY = `import { spawn } from 'node:child_process';
const child=spawn(process.argv[2],['memory','bench','--n','10000','--public-view'],
 {cwd:process.cwd(),env:process.env,shell:false,detached:false,stdio:['pipe','pipe','pipe']});
let failed=false;
function frame(value){
 if(!process.stdout.write(JSON.stringify(value)+'\\n')){
  child.stdout.pause();child.stderr.pause();
  process.stdout.once('drain',()=>{child.stdout.resume();child.stderr.resume();});
 }
}
frame({t:'started',pid:child.pid??null});
child.stdout.on('data',data=>frame({t:'stdout',data:data.toString('base64')}));
child.stderr.on('data',data=>frame({t:'stderr',data:data.toString('base64')}));
child.once('error',()=>{failed=true;});
child.stdin.on('error',()=>{failed=true;child.kill('SIGTERM');});child.stdin.end();
child.once('close',(code,signal)=>{
 frame({t:'closed',pid:child.pid??null,code,signal,spawnFailed:failed});
 process.exitCode=failed?1:code??1;
});
`;

export function finiteCliError(stderr) {
  try {
    const value = JSON.parse(stderr), error = value.error;
    assert.deepEqual(Object.keys(value), ['error']); assert.ok(isBosunErrorCode(error?.code));
    const normalized = rpcError(new BosunError(error.code, '', { details: error.details }));
    assert.deepEqual(error, normalized); return normalized;
  } catch { return null; }
}
export function failureDiagnostic(stderr) {
  const lines = stderr.trim().split('\n');
  if (lines.length !== 2 || finiteCliError(lines[1]) === null) return null;
  try {
    const value = JSON.parse(lines[0]), d = value.benchmarkFailure;
    assert.deepEqual(Object.keys(value), ['benchmarkFailure']);
    assert.deepEqual(Object.keys(d).sort(), ['completedContexts', 'completedEpochs', 'completedHooks', 'completedSearches', 'completedStores', 'kind', 'phase']);
    assert.equal(d.kind, 'memory-benchmark-failure');
    assert.ok(['prepare', 'setup', 'owner-acquire', 'memory-open', 'store', 'epoch-close', 'epoch-open', 'search', 'context',
      'publication', 'memory-close', 'owner-close', 'hook', 'report', 'cleanup-memory', 'cleanup-owner', 'cleanup-tree'].includes(d.phase));
    for (const [key, max] of Object.entries({ completedStores: 10000, completedSearches: 200, completedContexts: 200, completedHooks: 21, completedEpochs: 39 }))
      assert.ok(Number.isSafeInteger(d[key]) && d[key] >= 0 && d[key] <= max);
    return d;
  } catch { return null; }
}

export async function verifyInstrumentedArtifact(artifact, root) {
  // Reuse the exact archived pure verifier with its unchanged local dependencies.
  // Its consumed current-artifact wrapper intentionally has historical fixed pins.
  const verifyRoot = path.join(root, 'static-verifier'); fs.mkdirSync(verifyRoot, { mode: 0o700 });
  try {
    for (const [source, target, expected] of [
      ['docs/research/checkpoints/2026-10-11-compiled-current-build-tool.txt', 'scripts/distribution.mjs', CURRENT_PINS.variant],
      ['scripts/generate-assets.mjs', 'scripts/generate-assets.mjs', CURRENT_PINS.generator],
      ['src/platform/sqlite-runtime.ts', 'src/platform/sqlite-runtime.ts', CURRENT_PINS.sqliteRuntime],
    ]) {
      const bytes = fs.readFileSync(path.join(ROOT, source)); assert.equal(sha(bytes), expected);
      const file = path.join(verifyRoot, target); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
    }
    const { verifyDistribution } = await import(pathToFileURL(path.join(verifyRoot, 'scripts/distribution.mjs')).href);
    const result = verifyDistribution(artifact);
    assert.equal(result.version, '0.2.0'); assert.equal(result.inputs, 7282);
    assert.equal(result.binarySha256, INSTRUMENTED_PINS.binary); assert.equal(result.archiveSha256, INSTRUMENTED_PINS.archive);
    assert.equal(result.sourceDigest, INSTRUMENTED_PINS.source);
    const metadataBytes = fs.readFileSync(path.join(artifact, 'build.json'));
    assert.equal(sha(metadataBytes), INSTRUMENTED_PINS.metadata);
    const metadata = JSON.parse(metadataBytes);
    assert.equal(metadata.compiler.version, '1.4.2');
    assert.equal(metadata.compiler.sha256, INSTRUMENTED_PINS.compiler);
    assert.equal(metadata.flags.includes('--bytecode'), false);
  } finally { fs.rmSync(verifyRoot, { recursive: true, force: true }); }
}

export async function diagnosticProbe(context, relay, dependencies = {}) {
  const decoder = new StringDecoder('utf8'), chunks = { stdout: [], stderr: [] };
  let pending = '', framedBytes = 0, rawBytes = 0, childPid = null, childClose = null, invalid = false;
  const result = await processProbe({ ...context, binary: process.execPath }, [relay, context.binary], {
    ...dependencies, timeoutMs: dependencies.timeoutMs ?? 180000,
    stdout(chunk) {
      framedBytes += chunk.length; assert.ok(framedBytes <= OUTPUT);
      pending += decoder.write(chunk);
      for (;;) {
        const newline = pending.indexOf('\n'); if (newline < 0) break;
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        const frame = JSON.parse(line); assert.equal(childClose, null);
        if (frame.t === 'started') {
          assert.equal(childPid, null); assert.ok(Number.isSafeInteger(frame.pid) && frame.pid > 0);
          assert.deepEqual(Object.keys(frame).sort(), ['pid', 't']); childPid = frame.pid;
        } else if (frame.t === 'stdout' || frame.t === 'stderr') {
          assert.ok(childPid); assert.deepEqual(Object.keys(frame).sort(), ['data', 't']);
          assert.equal(typeof frame.data, 'string'); const bytes = Buffer.from(frame.data, 'base64');
          assert.equal(bytes.toString('base64'), frame.data); rawBytes += bytes.length; assert.ok(rawBytes <= OUTPUT);
          chunks[frame.t].push(bytes);
        } else {
          assert.equal(frame.t, 'closed'); assert.equal(frame.pid, childPid); assert.ok(childPid);
          assert.deepEqual(Object.keys(frame).sort(), ['code', 'pid', 'signal', 'spawnFailed', 't']);
          assert.ok(frame.code === null || Number.isSafeInteger(frame.code) && frame.code >= 0 && frame.code <= 255);
          assert.ok(frame.signal === null || /^SIG[A-Z0-9]{1,16}$/.test(frame.signal));
          assert.equal(typeof frame.spawnFailed, 'boolean'); childClose = frame;
        }
      }
    },
  });
  pending += decoder.end(); invalid = result.receipt.error !== null || pending !== '' || childClose === null;
  const output = Object.fromEntries(Object.entries(chunks).map(([channel, values]) => {
    const bytes = Buffer.concat(values);
    return [channel, { bytes: bytes.length, sha256: sha(bytes), base64: bytes.toString('base64') }];
  }));
  let benchmark = null;
  try {
    assert.equal(invalid, false); assert.equal(result.receipt.joined, true);
    assert.equal(result.receipt.code, 0); assert.equal(result.receipt.signal, null);
    assert.equal(childClose.code, 0); assert.equal(childClose.signal, null); assert.equal(childClose.spawnFailed, false);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(output.stdout.base64, 'base64'));
    benchmark = classifyBenchmark(JSON.parse(text));
  } catch { /* Failed parents cannot prove separately grouped producers joined. */ }
  const stderr = Buffer.from(output.stderr.base64, 'base64').toString('utf8');
  return { relay: result.receipt, compiledChild: childClose, framedBytes, rawBytes, output,
    finiteCliError: finiteCliError(stderr.trim().split('\n').at(-1)), failureDiagnostic: failureDiagnostic(stderr), benchmark, benchmarkVerified: benchmark !== null,
    nestedHookJoins: benchmark?.nestedProducersReportedJoined ?? 'unknown' };
}

async function main() {
  let temporary, identity, report = null, failure = null, stage = 'admission', attempted = false, removed = false;
  let peakDiskBytes = 0, diskFailure = false, totalTimer, diskTimer;
  const controller = new AbortController(), interrupt = () => controller.abort();
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    assert.equal(process.versions.bun, undefined); assert.ok(Number(process.versions.node.split('.')[0]) >= 24);
    assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
    const [approval, artifact, ...extra] = process.argv.slice(2);
    assert.equal(approval, '--approved-benchmark-diagnostic-only'); assert.equal(extra.length, 0);
    assert.ok(INSTRUMENTED_PINS, 'Instrumented build pins are not supplied; execution remains held');
    assert.equal(path.resolve(artifact ?? ''), path.join(ROOT, 'dist/bosun-0.2.0-darwin-arm64-benchmark-instrumented'));
    assert.equal(sha(fs.readFileSync(path.join(ROOT, 'scripts/check-compiled-current.mjs'))), CONSUMED_DRIVER_SHA256);
    assert.equal(sha(fs.readFileSync(path.join(ROOT, 'scripts/check-compiled-runtime.mjs'))), CURRENT_PINS.oldRuntimeDriver);
    assert.equal(sha(fs.readFileSync(path.join(ROOT, 'src/platform/process.ts'))), CURRENT_PINS.process);
    assert.equal(collectInputs(ROOT).sourceDigest, INSTRUMENTED_PINS.checkout);
    temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bosun-benchmark-diagnostic-')));
    fs.chmodSync(temporary, 0o700); identity = fs.lstatSync(temporary);
    stage = 'static-artifact-verification'; await verifyInstrumentedArtifact(path.resolve(artifact), temporary);
    const bytes = fs.readFileSync(path.join(path.resolve(artifact), 'bosun')); assert.equal(sha(bytes), INSTRUMENTED_PINS.binary);
    const binary = path.join(temporary, 'bosun'); fs.writeFileSync(binary, bytes, { flag: 'wx', mode: 0o700 });
    assert.equal(sha(fs.readFileSync(binary)), INSTRUMENTED_PINS.binary);
    const relay = path.join(temporary, 'relay.mjs'); fs.writeFileSync(relay, RELAY, { flag: 'wx', mode: 0o600 });
    const context = { binary, ...prepareIsolation(temporary, 'benchmark') };
    totalTimer = setTimeout(interrupt, 360000);
    diskTimer = setInterval(() => { try { peakDiskBytes = Math.max(peakDiskBytes, ownedTreeBytes(temporary)); }
      catch { diskFailure = true; interrupt(); } }, 250);
    stage = 'one-compiled-benchmark-diagnostic'; attempted = true;
    const execute = async function*(spec) {
      const { streamProcess } = await import('../src/platform/process.ts');
      yield* streamProcess({ ...spec, signal: AbortSignal.any([spec.signal, controller.signal]) });
    };
    report = await diagnosticProbe(context, relay, { execute });
    assert.equal(report.benchmarkVerified, true); assert.equal(diskFailure, false); assert.equal(controller.signal.aborted, false);
    peakDiskBytes = Math.max(peakDiskBytes, ownedTreeBytes(temporary));
  } catch { failure = stage; }
  finally {
    clearTimeout(totalTimer); clearInterval(diskTimer);
    process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
    const safe = cleanupAllowed({ rootsJoined: attempted ? report?.relay.joined === true : true,
      benchmarkAttempted: attempted, benchmarkVerified: report?.benchmarkVerified === true });
    if (temporary && safe) {
      try { const current = fs.lstatSync(temporary); assert.ok(current.isDirectory() && !current.isSymbolicLink());
        assert.equal(current.dev, identity.dev); assert.equal(current.ino, identity.ino);
        fs.rmSync(temporary, { recursive: true, force: true }); removed = !fs.existsSync(temporary); }
      catch { failure ??= 'owned-tree-cleanup'; }
    }
    if (temporary && !removed) failure ??= 'owned-tree-retained';
  }
  console.log(JSON.stringify({ scope: 'one-instrumented-compiled-benchmark-diagnostic', pins: INSTRUMENTED_PINS,
    historicalVerifierDependencies: CURRENT_PINS,
    consumedDriverSha256: CONSUMED_DRIVER_SHA256, relaySourceSha256: sha(RELAY),
    compiledRootInvocationsAttempted: attempted ? 1 : 0, compiledInvocationsMaximum: 22,
    relayNodeInvocationsAttempted: attempted ? 1 : 0, report, peakDiskBytes,
    privateTreeRemoved: temporary ? removed : null, retainedPrivateTree: temporary && !removed ? temporary : null,
    previousRetainedTreeAccessed: false, cause: 'unresolved',
    nativeHostDelivery: 'unqualified', realDataOrModelQuality: 'unqualified', failure }, null, 2));
  if (failure) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
