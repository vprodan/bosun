import { BosunError, MemoryError } from './errors.ts';

export type BenchmarkHookProcess = {
  status: number | null;
  stdout: string;
  error?: unknown;
  signal?: unknown;
};
const HOOK_PHASES = ['admission', 'config', 'scope', 'candidates', 'reader-open', 'reader-search',
  'context', 'reader-validate', 'envelope', 'delivery'] as const;
const READ_REASONS = ['input', 'path', 'missing', 'identity', 'size', 'format', 'wal_requires_writes',
  'journal_pending', 'schema', 'state', 'data', 'storage', 'runtime', 'deadline', 'closed'] as const;
const HOOK_REASONS = [...READ_REASONS, 'depth', 'sink', 'privacy', 'prompt', 'secret', 'config',
  'candidates', 'aborted', 'remote-binding', 'empty', 'output-limit', 'delivery', 'exception'] as const;
export type BenchmarkHookDiagnostic = {
  phase: typeof HOOK_PHASES[number];
  reason: typeof HOOK_REASONS[number];
};
export function benchmarkHookErrorReason(error: unknown): BenchmarkHookDiagnostic['reason'] {
  try {
    if (error instanceof MemoryError && Object.getOwnPropertyDescriptor(error, 'code')?.value === 'unavailable') {
      const message: unknown = Object.getOwnPropertyDescriptor(error, 'message')?.value;
      return READ_REASONS.find(reason => message === `local public memory unavailable (${reason})`
        || message === `local memory unavailable (${reason})`) ?? 'exception';
    }
  } catch { /* Untrusted errors never supply diagnostic text or getters. */ }
  return 'exception';
}
export function benchmarkHookDiagnostic(stderr: string): BenchmarkHookDiagnostic | null {
  if (stderr.length > 1024) return null;
  try {
    const parsed: unknown = JSON.parse(stderr);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || Object.keys(parsed).length !== 1 || !Object.hasOwn(parsed, 'hookDiagnostic')) return null;
    const value: unknown = (parsed as Record<string, unknown>).hookDiagnostic;
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2) return null;
    const { phase, reason } = value as Record<string, unknown>;
    const knownPhase = HOOK_PHASES.find(candidate => candidate === phase);
    const knownReason = HOOK_REASONS.find(candidate => candidate === reason);
    return knownPhase && knownReason ? { phase: knownPhase, reason: knownReason } : null;
  } catch { return null; }
}
// A successful process alone is not retrieval evidence. Validate the actual
// delivered envelope and exact synthetic identities before reporting injection.
export function benchmarkHookOutcome(
  child: BenchmarkHookProcess,
  knownIds: ReadonlySet<string>,
): 'failed' | 'held' | 'unqualified' | 'injected' {
  if (child.status !== 0 || child.error || child.signal) return 'failed';
  if (!child.stdout.trim()) return 'held';
  try {
    const lines = child.stdout.trim().split('\n');
    if (lines.length !== 1) return 'unqualified';
    const parsed = JSON.parse(lines[0]),
      envelope = parsed?.hookSpecificOutput;
    if (
      envelope?.hookEventName !== 'UserPromptSubmit' ||
      typeof envelope.additionalContext !== 'string'
    )
      return 'unqualified';
    const text = envelope.additionalContext as string,
      count = text.match(/^\[bosun memory: ([1-9][0-9]*) notes?;/)?.[1];
    const ids = [
      ...text.matchAll(/^- \[curated (?:project|personal|session) [^\]]+ (m_[a-z0-9]+)\]/gm),
    ].map((match) => match[1]);
    if (
      !count ||
      Number(count) !== ids.length ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !knownIds.has(id))
    )
      return 'unqualified';
    return 'injected';
  } catch {
    return 'unqualified';
  }
}
export function benchmarkCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10000)
    throw new BosunError('invalid', 'Benchmark corpus must contain 1–10000 notes');
  return value;
}
export function benchmarkDistribution(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const p = (fraction: number) =>
    sorted.length ? sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)] : null;
  return { samples: sorted.length, p50: p(0.5), p95: p(0.95) };
}
