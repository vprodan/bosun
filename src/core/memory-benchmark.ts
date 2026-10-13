import { BosunError } from './errors.ts';

export type BenchmarkHookProcess = {
  status: number | null;
  stdout: string;
  error?: unknown;
  signal?: unknown;
};
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
