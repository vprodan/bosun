import type { MemoryEvalObservation } from './domain/memory-evaluation.ts';

const ratio = (n: number, total: number) => (total ? n / total : 0);
const choices = (ref: MemoryEvalObservation['task']['supports'][number]) => [
  ref.id,
  ...(ref.alternatives ?? []).map((r) => r.id),
];
function scores(s: MemoryEvalObservation) {
  const refs = s.task.supports,
    first = s.rawIds.slice(0, 20).findIndex((id) => refs.some((ref) => choices(ref).includes(id)));
  return {
    raw: ratio(
      refs.filter((ref) => choices(ref).some((id) => s.rawIds.slice(0, 5).includes(id))).length,
      refs.length,
    ),
    packed: ratio(s.visibleSupportIds.length, refs.length),
    mrr: first < 0 ? 0 : 1 / (first + 1),
    rawMissed:
      refs.length -
      refs.filter((ref) => choices(ref).some((id) => s.rawIds.slice(0, 5).includes(id))).length,
    missed: refs.length - s.visibleSupportIds.length,
  };
}
export function pairedMemoryComparison(
  baseline: readonly MemoryEvalObservation[],
  candidate: readonly MemoryEvalObservation[],
) {
  const byId = new Map(candidate.map((s) => [s.task.id, s]));
  const rows = baseline
    .filter((s) => s.task.split === 'heldout' && s.task.supports.length)
    .map((s) => {
      const next = byId.get(s.task.id);
      if (!next || next.task !== s.task)
        throw new Error('Memory comparison requires the identical labelled corpus');
      const a = scores(s),
        b = scores(next);
      return {
        id: s.task.id,
        group: `${s.task.sourceGroup}/${s.task.sessionGroup}`,
        category: s.task.category,
        raw: b.raw - a.raw,
        packed: b.packed - a.packed,
        mrr: b.mrr - a.mrr,
        baselineRawMissed: a.rawMissed,
        candidateRawMissed: b.rawMissed,
        baselineMissed: a.missed,
        candidateMissed: b.missed,
        missed: s.task.supports
          .filter((ref) => !next.visibleSupportIds.includes(ref.id))
          .map((ref) => ref.id),
      };
    });
  const groups = [...new Set(rows.map((r) => r.group))],
    clusters = groups.map((group) => rows.filter((r) => r.group === group));
  const mean = (key: 'raw' | 'packed' | 'mrr', values = rows) =>
    ratio(
      values.reduce((n, r) => n + r[key], 0),
      values.length,
    );
  let seed = 82731;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    return (seed >>> 0) / 4294967296;
  };
  const draws = { raw: [] as number[], packed: [] as number[], mrr: [] as number[] };
  if (groups.length >= 2)
    for (let i = 0; i < 2000; i++) {
      const sample = Array.from(
        { length: groups.length },
        () => clusters[Math.floor(random() * clusters.length)],
      ).flat();
      for (const key of ['raw', 'packed', 'mrr'] as const) draws[key].push(mean(key, sample));
    }
  const interval = (key: keyof typeof draws) => {
    const values = draws[key].sort((a, b) => a - b);
    return values.length
      ? {
          lower: values[Math.floor(values.length * 0.025)],
          upper: values[Math.ceil(values.length * 0.975) - 1],
        }
      : null;
  };
  const baselineMissed = rows.reduce((n, r) => n + r.baselineMissed, 0),
    candidateMissed = rows.reduce((n, r) => n + r.candidateMissed, 0);
  return {
    queries: rows.length,
    groups: groups.length,
    uncertainty: 'source-session-cluster-bootstrap',
    resamples: 2000,
    recallAt5Delta: { mean: mean('raw'), interval95: interval('raw') },
    packedEvidenceRecallDelta: { mean: mean('packed'), interval95: interval('packed') },
    mrrAt20Delta: { mean: mean('mrr'), interval95: interval('mrr') },
    rawMissedSupports: {
      baseline: rows.reduce((n, r) => n + r.baselineRawMissed, 0),
      candidate: rows.reduce((n, r) => n + r.candidateRawMissed, 0),
      reduction: rows.reduce((n, r) => n + r.baselineRawMissed, 0)
        ? (rows.reduce((n, r) => n + r.baselineRawMissed, 0) -
            rows.reduce((n, r) => n + r.candidateRawMissed, 0)) /
          rows.reduce((n, r) => n + r.baselineRawMissed, 0)
        : null,
    },
    missedSupports: {
      baseline: baselineMissed,
      candidate: candidateMissed,
      reduction: baselineMissed ? (baselineMissed - candidateMissed) / baselineMissed : null,
    },
    relationshipPackedRecallDelta: mean(
      'packed',
      rows.filter((r) => r.category === 'relationship'),
    ),
    losses: rows.filter((r) => r.missed.length).map((r) => ({ id: r.id, supports: r.missed })),
  };
}
