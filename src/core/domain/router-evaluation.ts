import { requirePublicInput } from '../policy.ts';
import { data } from './job.ts';
import type { Decision, Lane, Risk } from './route.ts';
import type { DispatchPolicy } from '../dispatch-policy.ts';

export const ROUTER_EVAL_RUNNER = 'bosun-router-evaluation';
export const ROUTER_EVAL_LIMITS = {
  cases: 80,
  development: 20,
  heldout: 60,
  bytes: 262144,
  deadlineMs: 120000,
  artifacts: 512,
} as const;
export const ROUTER_EVAL_CATEGORIES = [
  'high-risk',
  'ambiguous',
  'mechanical',
  'implementation',
  'inspection',
  'cross-vendor',
  'no-delegation',
] as const;
export type RouterEvalObservation = {
  decision: Decision | null;
  residency: 'warm' | 'cold' | 'unknown';
  totalMs: number;
};
export type RouterEvalCase = {
  privacy: 'public';
  id: string;
  split: 'development' | 'heldout';
  repositoryGroup: string;
  sessionGroup: string;
  category: (typeof ROUTER_EVAL_CATEGORIES)[number];
  text: string;
  access: 'read' | 'edit';
  selectedModel: string;
  policy: DispatchPolicy;
  expected: { lane: Lane; risk: Risk };
  outcome: {
    kind: 'synthetic' | 'owner-review' | 'check';
    reference: string;
    projectId: string;
    revision: string;
    result: 'passed' | 'failed' | 'escalated';
    executedLane: Lane;
  };
  observed?: RouterEvalObservation;
};
export type RouterEvalDataset = {
  schema: 1;
  privacy: 'public';
  evidence: 'synthetic' | 'owner-reviewed';
  model: string;
  digest: string;
  cases: RouterEvalCase[];
};
export type RouterEvalSample = {
  task: RouterEvalCase;
  observed: RouterEvalObservation;
  outcomeVerified: boolean;
};
export function routerEvaluationPrivacy(input: unknown): void {
  requirePublicInput(input as { privacy?: unknown });
  const cases = data(input, 'cases');
  if (!Array.isArray(cases)) return; // The closed schema rejects shape; no content inspected here.
  for (let i = 0; i < cases.length; i++)
    requirePublicInput(data(cases, String(i)) as { privacy?: unknown });
}
