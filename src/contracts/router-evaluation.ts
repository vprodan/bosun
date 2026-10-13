import { z } from 'zod';
import { BosunError } from '../core/errors.ts';
import { screenPublicText } from '../core/secret-screen.ts';
import { dispatchPolicy, OPERATIONS } from '../core/dispatch-policy.ts';
import {
  ROUTER_EVAL_CATEGORIES,
  ROUTER_EVAL_LIMITS,
  routerEvaluationPrivacy,
  type RouterEvalDataset,
} from '../core/domain/router-evaluation.ts';

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  sha = z.string().regex(/^[a-f0-9]{64}$/);
const lane = z.enum(['scout', 'local', 'worker', 'main']),
  risk = z.enum(['high', 'low']);
const model = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,99}$/);
const decision = z.strictObject({
  lane,
  risk,
  conf: z.number().min(0).max(1),
  risk_conf: z.number().min(0).max(1),
  ms: z.number().min(0).max(3600000),
  router: model,
});
const policy = z.strictObject({
  operation: z.enum(OPERATIONS),
  files: z.array(z.string().min(1).max(512)).max(64),
  noDelegation: z.boolean().optional(),
  exactModel: model.optional(),
});
export const routerEvalObservationSchema = z.strictObject({
  decision: decision.nullable(),
  residency: z.enum(['warm', 'cold', 'unknown']),
  totalMs: z.number().min(0).max(3600000),
});
const datasetSchema = z.strictObject({
  schema: z.literal(1),
  privacy: z.literal('public'),
  evidence: z.enum(['synthetic', 'owner-reviewed']),
  model,
  digest: sha,
  cases: z
    .array(
      z.strictObject({
        privacy: z.literal('public'),
        id: identifier,
        split: z.enum(['development', 'heldout']),
        repositoryGroup: identifier,
        sessionGroup: identifier,
        category: z.enum(ROUTER_EVAL_CATEGORIES),
        text: z.string().min(1).max(1000),
        access: z.enum(['read', 'edit']),
        selectedModel: model,
        policy,
        expected: z.strictObject({ lane, risk }),
        outcome: z.strictObject({
          kind: z.enum(['synthetic', 'owner-review', 'check']),
          reference: identifier,
          projectId: z.string().regex(/^p_[a-f0-9]{16}$/),
          revision: sha,
          result: z.enum(['passed', 'failed', 'escalated']),
          executedLane: lane,
        }),
        observed: routerEvalObservationSchema.optional(),
      }),
    )
    .length(ROUTER_EVAL_LIMITS.cases),
});
const invalid = () => new BosunError('invalid', 'Invalid router evaluation dataset');
export function routerEvaluationDataset(input: unknown): RouterEvalDataset {
  routerEvaluationPrivacy(input);
  const parsed = datasetSchema.safeParse(input);
  if (!parsed.success) throw invalid();
  const dataset: RouterEvalDataset = parsed.data;
  const ids = new Set<string>(),
    texts = new Set<string>(),
    references = new Set<string>();
  const groups = {
    development: { repos: new Set<string>(), sessions: new Set<string>() },
    heldout: { repos: new Set<string>(), sessions: new Set<string>() },
  };
  const categories = { development: new Set<string>(), heldout: new Set<string>() };
  for (const task of dataset.cases) {
    if (
      !task.text.trim() ||
      task.repositoryGroup !== task.outcome.projectId ||
      ids.has(task.id) ||
      texts.has(task.text.trim().replace(/\s+/g, ' ').toLowerCase()) ||
      references.has(task.outcome.reference) ||
      (task.observed?.decision && task.observed.decision.router !== dataset.model) ||
      (dataset.evidence === 'owner-reviewed' && task.outcome.kind === 'synthetic')
    )
      throw invalid();
    ids.add(task.id);
    texts.add(task.text.trim().replace(/\s+/g, ' ').toLowerCase());
    references.add(task.outcome.reference);
    groups[task.split].repos.add(task.repositoryGroup);
    groups[task.split].sessions.add(task.sessionGroup);
    categories[task.split].add(task.category);
    task.policy = dispatchPolicy(task.policy);
    screenPublicText(JSON.stringify(task));
  }
  if (
    dataset.cases.filter((task) => task.split === 'development').length !==
      ROUTER_EVAL_LIMITS.development ||
    dataset.cases.filter((task) => task.split === 'heldout').length !==
      ROUTER_EVAL_LIMITS.heldout ||
    [...groups.development.repos].some((group) => groups.heldout.repos.has(group)) ||
    [...groups.development.sessions].some((group) => groups.heldout.sessions.has(group)) ||
    ROUTER_EVAL_CATEGORIES.some(
      (category) => !categories.development.has(category) || !categories.heldout.has(category),
    )
  )
    throw invalid();
  screenPublicText(dataset.model);
  return dataset;
}
export const routerEvaluationRequest = z.strictObject({
  privacy: z.literal('public'),
  file: z.string().min(1).max(512),
  sha256: sha,
});
export const routerCaptureRequest = routerEvaluationRequest.extend({ requestId: identifier });
const fraction = z.number().min(0).max(1),
  count = z.number().int().min(0).max(80);
const confidenceInterval = z.strictObject({ lower: fraction, upper: fraction }).nullable();
const latency = z.strictObject({
  samples: count,
  p50: z.number().min(0).max(3600000).nullable(),
  p95: z.number().min(0).max(3600000).nullable(),
});
const metricSchema = z.strictObject({
  n: count,
  offered: count,
  correct: count,
  coverage: fraction,
  abstention: fraction,
  offeredAccuracy: fraction.nullable(),
  accuracyInterval95: confidenceInterval,
  correctPerTask: fraction,
  rawAccuracy: fraction.nullable(),
  riskMisses: count,
  riskUnavailable: count,
  harmfulDelegations: count,
  overrideRate: fraction,
  outcomes: z.strictObject({ attributed: count, failed: count, escalated: count, verified: count }),
  confusion: z.record(
    z.string().regex(/^(scout|local|worker|main)->(scout|local|worker|main)$/),
    count,
  ),
  concentrationReliability: z
    .array(
      z.strictObject({
        from: fraction,
        to: fraction,
        n: count,
        meanConcentration: fraction.nullable(),
        observedAccuracy: fraction.nullable(),
        accuracyInterval95: confidenceInterval,
      }),
    )
    .length(5),
  latency: z.strictObject({ warm: latency, cold: latency, unknown: latency }),
});
export const routerFrozenSchema = z.strictObject({
  schema: z.literal(1),
  jobId: identifier,
  projectId: z.string().regex(/^p_[a-f0-9]{16}$/),
  datasetSha256: sha,
  model,
  digest: sha,
  selection: z.strictObject({
    threshold: fraction,
    eligible: z.boolean(),
    selectedFrom: z.literal('development-only'),
    developmentCases: z.array(identifier).length(20),
    trials: z.array(z.strictObject({ threshold: fraction, metrics: metricSchema })).length(9),
  }),
});
