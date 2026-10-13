import type { streamProcess } from '../src/platform/process.ts';
import type { BenchmarkFailureDiagnostic } from '../src/app/memory-benchmark.ts';
import type { RpcError } from '../src/contracts/rpc.ts';
import type { CheckContext, ProcessReceipt, classifyBenchmark } from './check-compiled-current.mjs';
export const RELAY: string;
export const CONSUMED_DRIVER_SHA256: string;
export const INSTRUMENTED_PINS: Readonly<Record<string, string>> | null;
export function finiteCliError(stderr: string): RpcError | null;
export function failureDiagnostic(stderr: string): BenchmarkFailureDiagnostic | null;
export function diagnosticProbe(context: CheckContext, relay: string,
  dependencies?: { execute?: typeof streamProcess; timeoutMs?: number }): Promise<{
  relay: ProcessReceipt; compiledChild: { pid: number; code: number | null; signal: string | null; spawnFailed: boolean } | null;
  framedBytes: number; rawBytes: number; output: Record<'stdout' | 'stderr', { bytes: number; sha256: string; base64: string }>;
  finiteCliError: RpcError | null; failureDiagnostic: BenchmarkFailureDiagnostic | null;
  benchmark: ReturnType<typeof classifyBenchmark> | null; benchmarkVerified: boolean; nestedHookJoins: number | 'unknown';
}>;
export function verifyInstrumentedArtifact(artifact: string, root: string): Promise<void>;
