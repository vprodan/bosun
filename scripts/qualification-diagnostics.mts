// Bounded, import-only diagnostics. No historical admission or artifact execution.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { classifyBenchmark, processProbe, type BenchmarkQualification, type CheckContext,
  type ProbeDependencies, type ProcessReceipt } from './qualification.mts';
import { BosunError, isBosunErrorCode, type ErrorDetails } from '../src/core/errors.ts';
import { rpcError, type RpcError } from '../src/contracts/rpc.ts';
import type { BenchmarkFailureDiagnostic } from '../src/app/memory-benchmark.ts';

export type CompiledChildReceipt = { pid: number; code: number | null; signal: string | null; spawnFailed: boolean };
export type DiagnosticOutput = { bytes: number; sha256: string; base64: string };
export type DiagnosticReceipt = {
  relay: ProcessReceipt; compiledChild: CompiledChildReceipt | null; framedBytes: number; rawBytes: number;
  output: Record<'stdout' | 'stderr', DiagnosticOutput>; finiteCliError: RpcError | null;
  failureDiagnostic: BenchmarkFailureDiagnostic | null; benchmark: BenchmarkQualification | null;
  benchmarkVerified: boolean; nestedHookJoins: number | 'unknown';
};
const OUTPUT = 1048576;
const sha = (bytes: Uint8Array): string => crypto.createHash('sha256').update(bytes).digest('hex');
function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
// The runtime relay preserves the unchanged streamProcess lifecycle and bound.
// The non-detached child's original close is separate from the relay group join.
// Hook producer joins remain unknown without the successful product report.
export const RELAY: string = `import { spawn } from 'node:child_process';
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

export function finiteCliError(stderr: string): RpcError | null {
  try {
    const value = record(JSON.parse(stderr)), error = record(value.error);
    assert.deepEqual(Object.keys(value), ['error']); assert.ok(isBosunErrorCode(error.code));
    let details: ErrorDetails | undefined;
    if (error.details !== undefined) {
      const input = record(error.details);
      details = { ...(typeof input.currentVersion === 'number' ? { currentVersion: input.currentVersion } : {}),
        ...(input.outcome === 'unknown' ? { outcome: 'unknown' as const } : {}) };
    }
    const normalized = rpcError(new BosunError(error.code, '', { details }));
    assert.deepEqual(error, normalized); return normalized;
  } catch { return null; }
}
export function failureDiagnostic(stderr: string): BenchmarkFailureDiagnostic | null {
  const lines = stderr.trim().split('\n');
  if (lines.length !== 2 || finiteCliError(lines[1]) === null) return null;
  try {
    const value = record(JSON.parse(lines[0])), diagnostic = record(value.benchmarkFailure);
    assert.deepEqual(Object.keys(value), ['benchmarkFailure']);
    assert.deepEqual(Object.keys(diagnostic).sort(), ['completedContexts', 'completedEpochs', 'completedHooks', 'completedSearches', 'completedStores', 'kind', 'phase']);
    assert.equal(diagnostic.kind, 'memory-benchmark-failure');
    const phases: readonly BenchmarkFailureDiagnostic['phase'][] = ['prepare', 'setup', 'owner-acquire', 'memory-open', 'store', 'epoch-close', 'epoch-open', 'search', 'context',
      'publication', 'memory-close', 'owner-close', 'hook', 'report', 'cleanup-memory', 'cleanup-owner', 'cleanup-tree'];
    const phase = phases.find(phase => phase === diagnostic.phase); assert.ok(phase);
    const count = (key: string, maximum: number): number => {
      const value = diagnostic[key];
      assert.ok(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum); return value;
    };
    return { kind: 'memory-benchmark-failure', phase,
      completedStores: count('completedStores', 10000), completedSearches: count('completedSearches', 200),
      completedContexts: count('completedContexts', 200), completedHooks: count('completedHooks', 21), completedEpochs: count('completedEpochs', 39) };
  } catch { return null; }
}

export async function diagnosticProbe(context: CheckContext, relay: string,
  dependencies: ProbeDependencies & { timeoutMs?: number } = {}): Promise<DiagnosticReceipt> {
  const decoder = new StringDecoder('utf8'), chunks: Record<'stdout' | 'stderr', Buffer[]> = { stdout: [], stderr: [] };
  let pending = '', framedBytes = 0, rawBytes = 0, childPid: number | null = null;
  const state: { childClose: CompiledChildReceipt | null } = { childClose: null };
  const result = await processProbe({ ...context, binary: process.execPath }, [relay, context.binary], {
    ...dependencies, timeoutMs: dependencies.timeoutMs ?? 180000,
    stdout(chunk) {
      framedBytes += chunk.length; assert.ok(framedBytes <= OUTPUT);
      pending += decoder.write(chunk);
      for (;;) {
        const newline = pending.indexOf('\n'); if (newline < 0) break;
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        const frame = record(JSON.parse(line)); assert.equal(state.childClose, null);
        if (frame.t === 'started') {
          assert.equal(childPid, null); assert.ok(typeof frame.pid === 'number' && Number.isSafeInteger(frame.pid) && frame.pid > 0);
          assert.deepEqual(Object.keys(frame).sort(), ['pid', 't']); childPid = frame.pid;
        } else if (frame.t === 'stdout' || frame.t === 'stderr') {
          assert.ok(childPid); assert.deepEqual(Object.keys(frame).sort(), ['data', 't']);
          assert.ok(typeof frame.data === 'string'); const bytes = Buffer.from(frame.data, 'base64');
          assert.equal(bytes.toString('base64'), frame.data); rawBytes += bytes.length; assert.ok(rawBytes <= OUTPUT);
          chunks[frame.t].push(bytes);
        } else {
          assert.equal(frame.t, 'closed'); assert.equal(frame.pid, childPid); assert.ok(childPid);
          assert.deepEqual(Object.keys(frame).sort(), ['code', 'pid', 'signal', 'spawnFailed', 't']);
          assert.ok(frame.code === null || typeof frame.code === 'number' && Number.isSafeInteger(frame.code) && frame.code >= 0 && frame.code <= 255);
          assert.ok(frame.signal === null || typeof frame.signal === 'string' && /^SIG[A-Z0-9]{1,16}$/.test(frame.signal));
          assert.ok(typeof frame.spawnFailed === 'boolean');
          state.childClose = { pid: childPid, code: frame.code, signal: frame.signal, spawnFailed: frame.spawnFailed };
        }
      }
    },
  });
  pending += decoder.end();
  const childClose = state.childClose, invalid = result.receipt.error !== null || pending !== '' || childClose === null;
  const channel = (values: Buffer[]): DiagnosticOutput => {
    const bytes = Buffer.concat(values); return { bytes: bytes.length, sha256: sha(bytes), base64: bytes.toString('base64') };
  };
  const output = { stdout: channel(chunks.stdout), stderr: channel(chunks.stderr) };
  let benchmark: BenchmarkQualification | null = null;
  try {
    assert.equal(invalid, false); assert.equal(result.receipt.joined, true);
    assert.equal(result.receipt.code, 0); assert.equal(result.receipt.signal, null); assert.ok(childClose);
    assert.equal(childClose.code, 0); assert.equal(childClose.signal, null); assert.equal(childClose.spawnFailed, false);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(output.stdout.base64, 'base64'));
    benchmark = classifyBenchmark(JSON.parse(text));
  } catch { /* Failed parents cannot prove separately grouped producers joined. */ }
  const stderr = Buffer.from(output.stderr.base64, 'base64').toString('utf8');
  return { relay: result.receipt, compiledChild: childClose, framedBytes, rawBytes, output,
    finiteCliError: finiteCliError(stderr.trim().split('\n').at(-1) ?? ''), failureDiagnostic: failureDiagnostic(stderr), benchmark, benchmarkVerified: benchmark !== null,
    nestedHookJoins: benchmark?.nestedProducersReportedJoined ?? 'unknown' };
}
