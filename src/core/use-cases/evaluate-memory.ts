import type { MemoryStore } from '../ports/memory.ts';
import type { ContextBundle, CandidateIdentity } from '../domain/context.ts';
import type { Ctx } from '../domain/memory.ts';
import type { MemoryEvalDataset, MemoryEvalObservation } from '../domain/memory-evaluation.ts';
import { MEMORY_EVAL_CATEGORIES } from '../domain/memory-evaluation.ts';
import { createCuratedSource } from '../memory-source.ts';
import type { ContextSource } from '../ports/context-source.ts';
import { BosunError } from '../errors.ts';
import { norm, terms } from '../text.ts';
import { pairedMemoryComparison } from '../memory-comparison.ts';
import { benchmarkDistribution } from '../memory-benchmark.ts';
import type { ContextOptions } from './retrieve-context.ts';

export const MEMORY_EVAL_PACK: Readonly<Required<ContextOptions>> = Object.freeze({
  budgetTokens: 400,
  minScore: 0.35,
  minMatched: 2,
  itemChars: 400,
  includeCandidates: false,
});
const fraction = (n: number, total: number) => (total ? n / total : null);
export function memoryEvaluationMetrics(
  samples: readonly MemoryEvalObservation[],
  budgetTokens = 400,
) {
  const positive = samples.filter((s) => s.task.supports.length > 0),
    negative = samples.filter((s) => s.task.supports.length === 0);
  let recall = 0,
    mrr = 0,
    packedRecall = 0,
    relevantItems = 0,
    packedItems = 0;
  let gained = 0,
    maximumGain = 0;
  for (const s of positive) {
    const expected = new Set(s.task.supports.map((ref) => ref.id));
    recall +=
      s.task.supports.filter((ref) =>
        supportChoices(ref).some((choice) => s.rawIds.slice(0, 5).includes(choice.id)),
      ).length / expected.size;
    const relevant = new Set(
      s.task.supports.flatMap((ref) => supportChoices(ref).map((choice) => choice.id)),
    );
    const first = s.rawIds.slice(0, 20).findIndex((id) => relevant.has(id));
    mrr += first < 0 ? 0 : 1 / (first + 1);
    packedRecall += s.visibleSupportIds.length / expected.size;
    for (const support of s.task.supports) {
      maximumGain += support.grade;
      if (s.visibleSupportIds.includes(support.id)) gained += support.grade;
    }
  }
  for (const s of samples) {
    packedItems += s.packedIds.length;
    relevantItems += s.packedIds.filter((id) =>
      s.task.supports.some((ref) => supportChoices(ref).some((choice) => choice.id === id)),
    ).length;
  }
  return {
    queries: samples.length,
    positive: positive.length,
    negative: negative.length,
    recallAt5: fraction(recall, positive.length),
    mrrAt20: fraction(mrr, positive.length),
    packedEvidenceRecall: fraction(packedRecall, positive.length),
    gradedEvidenceRecall: fraction(gained, maximumGain),
    packedPrecision: fraction(relevantItems, packedItems),
    negativeInjectionRate: fraction(
      negative.filter((s) => s.packedIds.length).length,
      negative.length,
    ),
    supportsLostToTruncation: samples.reduce((n, s) => n + s.truncatedSupportIds.length, 0),
    tokens: {
      estimator: 'char/4',
      actualHostTokens: 'unverified',
      budget: budgetTokens,
      maximumEstimate: Math.max(0, ...samples.map((s) => s.estimatedTokens)),
      overBudget: samples.filter((s) => s.estimatedTokens > budgetTokens).length,
    },
    latency: {
      search: benchmarkDistribution(samples.map((s) => s.searchMs)),
      packing: benchmarkDistribution(samples.map((s) => s.packingMs)),
      compiledHook: 'unverified',
    },
  };
}
export type MemoryEvalArm = {
  raw(text: string, ctx: Ctx): Promise<CandidateIdentity[]>;
  retrieve(
    text: string,
    ctx: Ctx,
    options: ContextOptions,
  ): Promise<Pick<ContextBundle, 'text' | 'estTokens'> & { items: CandidateIdentity[] }>;
};
export type MemoryEvalArms = {
  A: MemoryEvalArm;
  B?: MemoryEvalArm;
  C?: MemoryEvalArm;
  D?: MemoryEvalArm;
  E?: MemoryEvalArm;
};
const supportChoices = (ref: MemoryEvalDataset['cases'][number]['supports'][number]) => [
  { id: ref.id, quote: ref.quote },
  ...(ref.alternatives ?? []),
];
function headerId(line: string): string | undefined {
  return line.match(/^- \[[^\]]+ ([mg]_[a-z0-9]+)\]/)?.[1];
}
async function observeMemoryArm(
  dataset: MemoryEvalDataset,
  arm: MemoryEvalArm,
  monotonic: () => number,
  valid: () => boolean,
  settings: Readonly<Required<ContextOptions>>,
) {
  const samples: MemoryEvalObservation[] = [],
    notes = new Set(dataset.notes.map((note) => note.id)),
    graph = new Set((dataset.graph ?? []).map((item) => item.id));
  const live = () => {
    if (!valid()) throw new BosunError('conflict', 'Memory evaluation source changed');
  };
  const checkHit = (hit: CandidateIdentity) => {
    if (
      !(
        ((hit.source === 'curated' || hit.source === 'vectors') && notes.has(hit.id)) ||
        (hit.source === 'graph' && graph.has(hit.id))
      )
    )
      throw new BosunError('unavailable', 'Memory evaluation source mismatch');
    return hit.id;
  };
  for (const task of dataset.cases) {
    live();
    const ctx: Ctx = { ...task.scope, linked: [], audience: 'model' };
    Object.freeze(ctx.linked);
    Object.freeze(ctx);
    let started = monotonic();
    const raw = await arm.raw(task.query, ctx);
    live();
    if (!Array.isArray(raw) || raw.length > 40)
      throw new BosunError('unavailable', 'Memory evaluation result unavailable');
    const rawIds = raw.map(checkHit);
    if (new Set(rawIds).size !== rawIds.length)
      throw new BosunError('unavailable', 'Memory evaluation duplicate identity');
    const searchMs = Math.max(0, monotonic() - started);
    started = monotonic();
    const packed = await arm.retrieve(task.query, ctx, settings);
    live();
    const packedIds = packed.items.map(checkHit),
      lines = packed.text.split('\n').slice(1);
    const visibleSupportIds = task.supports
      .filter((ref) =>
        supportChoices(ref).some(
          (choice) =>
            packedIds.includes(choice.id) &&
            lines.some(
              (line) => headerId(line) === choice.id && norm(line).includes(norm(choice.quote)),
            ),
        ),
      )
      .map((ref) => ref.id);
    const zeroOverlap = (source: 'graph' | 'vectors') =>
      packed.items
        .filter(
          (item) =>
            item.source === source &&
            !terms(task.query).some((term) =>
              lines.some(
                (line) =>
                  headerId(line) === item.id &&
                  terms(line.slice(line.indexOf(']') + 1)).includes(term),
              ),
            ),
        )
        .map((item) => item.id);
    samples.push({
      task,
      rawIds,
      packedIds,
      visibleSupportIds,
      truncatedSupportIds: task.supports
        .filter(
          (ref) =>
            supportChoices(ref).some((choice) => packedIds.includes(choice.id)) &&
            !visibleSupportIds.includes(ref.id),
        )
        .map((ref) => ref.id),
      zeroOverlapGraphIds: zeroOverlap('graph'),
      zeroOverlapVectorIds: zeroOverlap('vectors'),
      estimatedTokens: packed.estTokens,
      searchMs,
      packingMs: Math.max(0, monotonic() - started),
    });
  }
  return samples;
}
export async function evaluateMemoryComparisons(
  dataset: MemoryEvalDataset,
  arms: MemoryEvalArms,
  monotonic: () => number,
  valid: () => boolean = () => true,
  policy: { surface?: 'hook-packing' | 'mcp'; budgetTokens?: number } = {},
) {
  const surface = policy.surface ?? 'hook-packing';
  const budget = policy.budgetTokens ?? (surface === 'mcp' ? 1000 : 400);
  if (
    !Number.isSafeInteger(budget) ||
    budget < 50 ||
    budget > 4000 ||
    (surface === 'hook-packing' && budget !== 400)
  )
    throw new BosunError('invalid', 'Invalid evaluation budget');
  const settings = Object.freeze({
    ...MEMORY_EVAL_PACK,
    budgetTokens: budget,
    ...(surface === 'mcp' ? { minScore: 0, minMatched: 1 } : {}),
  });
  const observations: Partial<Record<'A' | 'B' | 'C' | 'D' | 'E', MemoryEvalObservation[]>> = {};
  // Settings are fixed before capture. No held-out labels tune any strategy.
  for (const name of ['A', 'B', 'C', 'D', 'E'] as const)
    if (arms[name])
      observations[name] = await observeMemoryArm(dataset, arms[name], monotonic, valid, settings);
  const reportArm = (samples: MemoryEvalObservation[]) => {
    const heldout = samples.filter((s) => s.task.split === 'heldout');
    return {
      status: 'measured' as const,
      development: memoryEvaluationMetrics(
        samples.filter((s) => s.task.split === 'development'),
        budget,
      ),
      heldout: memoryEvaluationMetrics(heldout, budget),
      categories: Object.fromEntries(
        MEMORY_EVAL_CATEGORIES.map((category) => [
          category,
          memoryEvaluationMetrics(
            heldout.filter((s) => s.task.category === category),
            budget,
          ),
        ]),
      ),
      cases: samples.map(({ task, ...sample }) => ({ id: task.id, split: task.split, ...sample })),
      zeroOverlapGraphCases: heldout
        .filter((s) => s.zeroOverlapGraphIds?.length)
        .map((s) => ({ id: s.task.id, ids: s.zeroOverlapGraphIds })),
      zeroOverlapVectorCases: heldout
        .filter((s) => s.zeroOverlapVectorIds?.length)
        .map((s) => ({ id: s.task.id, ids: s.zeroOverlapVectorIds })),
    };
  };
  const baseline = observations.A;
  if (!baseline) throw new BosunError('unavailable', 'Memory evaluation baseline missing');
  const reports = {
    A: reportArm(baseline),
    B: observations.B ? reportArm(observations.B) : { status: 'unavailable' as const },
    C: observations.C ? reportArm(observations.C) : { status: 'unavailable' as const },
    D: observations.D ? reportArm(observations.D) : { status: 'unavailable' as const },
    E: observations.E ? reportArm(observations.E) : { status: 'unavailable' as const },
  };
  const compare = (base: 'A' | 'B' | 'C' | 'D', candidate: 'B' | 'C' | 'D' | 'E') => {
    const first = observations[base],
      second = observations[candidate];
    return first && second ? pairedMemoryComparison(first, second) : null;
  };
  const comparisons = {
    BvsA: compare('A', 'B'),
    CvsA: compare('A', 'C'),
    CvsB: compare('B', 'C'),
    DvsC: compare('C', 'D'),
    EvsC: compare('C', 'E'),
    EvsD: compare('D', 'E'),
  };
  const qualityFailures: string[] = [];
  if (!observations.C || reports.C.status !== 'measured' || reports.B.status !== 'measured')
    qualityFailures.push('complete-A-B-C-required');
  else {
    const c = reports.C.heldout,
      b = reports.B.heldout;
    for (const [name, base, comparison] of [
      ['A', reports.A.heldout, comparisons.CvsA],
      ['B', b, comparisons.CvsB],
    ] as const) {
      if (!comparison) {
        qualityFailures.push(`comparison-${name}-missing`);
        continue;
      }
      const gain = (delta: number, baseline: number | null, reduction: number | null) =>
        delta >= 0.08 - 1e-12 ||
        (baseline !== null && baseline >= 0.9 && reduction !== null && reduction >= 0.2 - 1e-12);
      if (
        !gain(
          comparison.recallAt5Delta.mean,
          base.recallAt5,
          comparison.rawMissedSupports.reduction,
        )
      )
        qualityFailures.push(`raw-recall-vs-${name}`);
      if (
        !gain(
          comparison.packedEvidenceRecallDelta.mean,
          base.packedEvidenceRecall,
          comparison.missedSupports.reduction,
        )
      )
        qualityFailures.push(`packed-recall-vs-${name}`);
      if (comparison.mrrAt20Delta.mean < -1e-12) qualityFailures.push(`MRR-vs-${name}`);
      if (comparison.relationshipPackedRecallDelta < 0.1 - 1e-12)
        qualityFailures.push(`relationship-recall-vs-${name}`);
      if (
        comparison.groups < 5 ||
        (comparison.recallAt5Delta.interval95?.lower ?? 0) <= 0 ||
        (comparison.packedEvidenceRecallDelta.interval95?.lower ?? 0) <= 0
      )
        qualityFailures.push(`paired-uncertainty-vs-${name}`);
    }
    if (
      (c.packedPrecision ?? 0) < 0.9 ||
      (c.packedPrecision ?? 0) < (b.packedPrecision ?? 0) - 1e-12
    )
      qualityFailures.push('packed-precision');
    if (
      c.negativeInjectionRate === null ||
      c.negativeInjectionRate > 0.05 ||
      c.negativeInjectionRate > (b.negativeInjectionRate ?? 0) + 1e-12
    )
      qualityFailures.push('negative-injection');
    if (c.tokens.overBudget) qualityFailures.push('estimated-token-budget');
  }
  const incrementalFailures = (base: 'C' | 'D', candidate: 'D' | 'E') => {
    const failures: string[] = [],
      first = reports[base],
      second = reports[candidate],
      comparison = compare(base, candidate);
    if (!comparison || second.status !== 'measured' || first.status !== 'measured')
      failures.push(`complete-${base}-${candidate}-required`);
    else {
      const e = second.heldout,
        c = first.heldout;
      if (
        comparison.groups < 5 ||
        (comparison.recallAt5Delta.interval95?.lower ?? 0) <= 0 ||
        (comparison.packedEvidenceRecallDelta.interval95?.lower ?? 0) <= 0
      )
        failures.push('paired-incremental-gain');
      if (comparison.mrrAt20Delta.mean < -1e-12) failures.push('MRR-regression');
      if (
        (e.packedPrecision ?? 0) < 0.9 ||
        (e.packedPrecision ?? 0) < (c.packedPrecision ?? 0) - 1e-12
      )
        failures.push('packed-precision');
      if (
        e.negativeInjectionRate === null ||
        e.negativeInjectionRate > 0.05 ||
        e.negativeInjectionRate > (c.negativeInjectionRate ?? 0) + 1e-12
      )
        failures.push('negative-injection');
      if (e.tokens.overBudget) failures.push('estimated-token-budget');
    }
    return failures;
  };
  const dFailures = incrementalFailures('C', 'D'),
    eBaseline = observations.D ? ('D' as const) : ('C' as const),
    eFailures = incrementalFailures(eBaseline, 'E');
  return {
    schema: 1,
    evidence: dataset.evidence,
    baseline: 'fts',
    surface,
    rawPolicy:
      surface === 'mcp'
        ? 'permitted-context-candidates-before-packing'
        : 'permitted-source-candidates',
    settings,
    tuning: 'none',
    arms: reports,
    comparisons,
    incremental: {
      D: {
        baseline: 'C',
        status: 'held',
        qualified: false,
        metricsPass: dFailures.length === 0,
        metricFailures: dFailures,
      },
      E: {
        baseline: eBaseline,
        status: 'held',
        qualified: false,
        metricsPass: eFailures.length === 0,
        metricFailures: eFailures,
      },
    },
    activation: {
      status: 'held',
      qualified: false,
      metricsPass: qualityFailures.length === 0,
      metricFailures: qualityFailures,
      reasons: [
        ...(!observations.C ? ['graph-arm-unavailable'] : []),
        'policy-canaries-separate',
        'zero-overlap-review-separate',
        'actual-host-tokens-unverified',
        'compiled-latency-unverified',
        ...(dataset.evidence === 'synthetic' ? ['synthetic-corpus'] : []),
      ],
    },
    cases: baseline.map(({ task, ...sample }) => ({
      id: task.id,
      split: task.split,
      ...sample,
    })),
  };
}
export async function evaluateMemory(
  dataset: MemoryEvalDataset,
  memory: Pick<MemoryStore, 'search'>,
  retrieve: MemoryEvalArm['retrieve'],
  monotonic: () => number,
  valid: () => boolean = () => true,
) {
  const source: ContextSource = createCuratedSource(memory);
  return evaluateMemoryComparisons(
    dataset,
    { A: { raw: (text, ctx) => source.search(text, ctx, 20), retrieve } },
    monotonic,
    valid,
  );
}
