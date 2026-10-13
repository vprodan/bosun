import { BosunError } from '../errors.ts';
import { decide } from '../route-policy.ts';
import { assessDispatch } from '../dispatch-policy.ts';
import type { Lane } from '../domain/route.ts';
import {
  ROUTER_EVAL_LIMITS,
  ROUTER_EVAL_CATEGORIES,
  type RouterEvalCase,
  type RouterEvalSample,
  type RouterEvalDataset,
} from '../domain/router-evaluation.ts';

export const ROUTER_THRESHOLDS = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1] as const;
function forcedMain(task: RouterEvalCase): boolean {
  return (
    !assessDispatch({
      access: task.access,
      model: task.selectedModel,
      submittedBy: 'model',
      policy: task.policy,
    }).allowed || task.policy.operation === 'planning'
  );
}
export function deterministicRoute(task: RouterEvalCase): Lane | null {
  if (forcedMain(task)) return 'main';
  if (task.access === 'read') return 'scout';
  return task.policy.operation === 'mechanical'
    ? 'local'
    : task.policy.operation === 'implementation'
      ? 'worker'
      : null;
}
export function evaluatedRoute(
  task: RouterEvalCase,
  sample: RouterEvalSample['observed'],
  threshold: number,
): Lane | null {
  if (forcedMain(task)) return 'main';
  return sample.decision ? decide(sample.decision, threshold)[0] : null;
}
function interval(right: number, total: number) {
  if (!total) return null;
  const z2 = 3.8416,
    fraction = right / total,
    divisor = 1 + z2 / total;
  const midpoint = (fraction + z2 / (2 * total)) / divisor;
  const radius =
    Math.sqrt(z2 * ((fraction * (1 - fraction)) / total + z2 / (4 * total * total))) / divisor;
  return { lower: Math.max(0, midpoint - radius), upper: Math.min(1, midpoint + radius) };
}
function metrics(
  samples: readonly RouterEvalSample[],
  offer: (sample: RouterEvalSample) => Lane | null,
) {
  let offered = 0,
    correct = 0,
    rawCorrect = 0,
    riskMisses = 0,
    riskUnavailable = 0,
    harmfulDelegations = 0,
    overrides = 0,
    failures = 0,
    escalations = 0,
    attributed = 0;
  const confusion: Record<string, number> = {},
    bins = Array.from({ length: 5 }, (_, i) => ({
      from: i / 5,
      to: (i + 1) / 5,
      n: 0,
      correct: 0,
      concentration: 0,
    }));
  const latencies = { warm: [] as number[], cold: [] as number[], unknown: [] as number[] };
  for (const sample of samples) {
    const task = sample.task,
      selected = offer(sample),
      decision = sample.observed.decision;
    if (selected !== null) {
      offered++;
      if (selected === task.expected.lane) correct++;
      if (
        task.access === 'edit' &&
        task.expected.risk === 'high' &&
        (selected === 'local' || selected === 'worker')
      )
        harmfulDelegations++;
      const key = `${task.expected.lane}->${selected}`;
      confusion[key] = (confusion[key] ?? 0) + 1;
      if (task.outcome.executedLane === selected) {
        attributed++;
        if (task.outcome.result === 'failed') failures++;
        if (task.outcome.result === 'escalated') escalations++;
      }
    }
    if (decision) {
      if (decision.lane === task.expected.lane) rawCorrect++;
      if (task.expected.risk === 'high' && decision.risk === 'low') riskMisses++;
      if (selected !== decision.lane) overrides++;
      const bin = bins[Math.min(4, Math.floor(decision.conf * 5))];
      bin.n++;
      bin.concentration += decision.conf;
      if (decision.lane === task.expected.lane) bin.correct++;
    } else riskUnavailable++;
    latencies[sample.observed.residency].push(sample.observed.totalMs);
  }
  const latency = (values: number[]) => {
    values.sort((a, b) => a - b);
    const p = (fraction: number) =>
      values.length ? values[Math.max(0, Math.ceil(values.length * fraction) - 1)] : null;
    return { samples: values.length, p50: p(0.5), p95: p(0.95) };
  };
  return {
    n: samples.length,
    offered,
    correct,
    coverage: samples.length ? offered / samples.length : 0,
    abstention: samples.length ? 1 - offered / samples.length : 1,
    offeredAccuracy: offered ? correct / offered : null,
    accuracyInterval95: interval(correct, offered),
    correctPerTask: samples.length ? correct / samples.length : 0,
    rawAccuracy: samples.length ? rawCorrect / samples.length : null,
    riskMisses,
    riskUnavailable,
    harmfulDelegations,
    overrideRate: samples.length ? overrides / samples.length : 0,
    outcomes: {
      attributed,
      failed: failures,
      escalated: escalations,
      verified: samples.filter((s) => s.outcomeVerified).length,
    },
    confusion,
    concentrationReliability: bins.map((b) => ({
      from: b.from,
      to: b.to,
      n: b.n,
      meanConcentration: b.n ? b.concentration / b.n : null,
      observedAccuracy: b.n ? b.correct / b.n : null,
      accuracyInterval95: interval(b.correct, b.n),
    })),
    latency: {
      warm: latency(latencies.warm),
      cold: latency(latencies.cold),
      unknown: latency(latencies.unknown),
    },
  };
}
export function freezeRouterThreshold(development: readonly RouterEvalSample[]) {
  if (
    development.length !== ROUTER_EVAL_LIMITS.development ||
    development.some((sample) => sample.task.split !== 'development')
  )
    throw new BosunError('invalid', 'Development split required');
  const trials = ROUTER_THRESHOLDS.map((threshold) => ({
    threshold,
    metrics: metrics(development, (sample) =>
      evaluatedRoute(sample.task, sample.observed, threshold),
    ),
  }));
  const eligible = trials.filter(
    (trial) =>
      trial.metrics.harmfulDelegations === 0 &&
      trial.metrics.offeredAccuracy !== null &&
      trial.metrics.offeredAccuracy >= 0.9,
  );
  eligible.sort((a, b) => b.metrics.coverage - a.metrics.coverage || a.threshold - b.threshold);
  return Object.freeze({
    threshold: eligible[0]?.threshold ?? 1,
    eligible: eligible.length > 0,
    selectedFrom: 'development-only' as const,
    developmentCases: development.map((sample) => sample.task.id),
    trials,
  });
}
export function routerEvaluationReport(
  dataset: RouterEvalDataset,
  samples: readonly RouterEvalSample[],
  freeze: ReturnType<typeof freezeRouterThreshold>,
  capture: 'imported' | 'native',
  datasetSha256: string,
) {
  if (
    samples.length !== ROUTER_EVAL_LIMITS.cases ||
    new Set(samples.map((s) => s.task.id)).size !== ROUTER_EVAL_LIMITS.cases ||
    samples.some((s) => !dataset.cases.some((c) => c.id === s.task.id))
  )
    throw new BosunError('invalid', 'Complete evaluation required');
  const dev = samples.filter((s) => s.task.split === 'development'),
    held = samples.filter((s) => s.task.split === 'heldout');
  const expected = freezeRouterThreshold(dev);
  if (JSON.stringify(freeze) !== JSON.stringify(expected))
    throw new BosunError('conflict', 'Frozen development selection changed');
  const clef = metrics(held, (sample) =>
      evaluatedRoute(sample.task, sample.observed, freeze.threshold),
    ),
    baseline = metrics(held, (sample) => deterministicRoute(sample.task));
  const gates = {
    developmentSelection: freeze.eligible,
    noHarmfulDelegation: clef.harmfulDelegations === 0,
    offeredAccuracy: clef.offeredAccuracy !== null && clef.offeredAccuracy >= 0.9,
    heldoutImprovement: clef.correctPerTask > baseline.correctPerTask,
    groundTruth: samples.every((s) => s.outcomeVerified) && dataset.evidence === 'owner-reviewed',
    nativeCapture: capture === 'native',
  };
  const metricsPass =
    gates.developmentSelection &&
    gates.noHarmfulDelegation &&
    gates.offeredAccuracy &&
    gates.heldoutImprovement;
  return {
    schema: 1,
    datasetSha256,
    model: dataset.model,
    digest: dataset.digest,
    capture,
    evidence: dataset.evidence,
    split: { development: dev.length, heldout: held.length },
    selection: freeze,
    clef,
    baseline,
    categories: ROUTER_EVAL_CATEGORIES.map((category) => ({
      category,
      clef: metrics(
        held.filter((s) => s.task.category === category),
        (s) => evaluatedRoute(s.task, s.observed, freeze.threshold),
      ),
      baseline: metrics(
        held.filter((s) => s.task.category === category),
        (s) => deterministicRoute(s.task),
      ),
    })),
    gates,
    metricsPass,
    proposal: {
      state: Object.values(gates).every(Boolean) ? 'reviewable' : 'held',
      threshold: freeze.threshold,
    },
    calibration: 'unverified',
    automaticDispatch: false,
    configurationChanged: false,
    hookInference: false,
    observations: samples.map((s) => ({
      id: s.task.id,
      split: s.task.split,
      observed: s.observed,
      outcomeVerified: s.outcomeVerified,
    })),
  };
}
