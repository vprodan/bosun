import './bootstrap.ts';
import { ROUTE_MODEL, ROUTE_DIGEST } from './route-fixture.ts';
import type { RouterEvalDataset, RouterEvalCase } from '../src/core/domain/router-evaluation.ts';
import { ROUTER_EVAL_CATEGORIES } from '../src/core/domain/router-evaluation.ts';
import type { Decision } from '../src/core/domain/route.ts';

// Test-authored synthetic data. Never owner-authored or real outcome evidence.
export function syntheticRouterCorpus(): RouterEvalDataset {
  const cases: RouterEvalCase[] = [];
  for (let i = 0; i < 80; i++) {
    const category = ROUTER_EVAL_CATEGORIES[i % ROUTER_EVAL_CATEGORIES.length];
    const split = i < 20 ? ('development' as const) : ('heldout' as const);
    const projectId = 'p_' + (i < 20 ? 'a' : 'b').repeat(16);
    const id = `task_${String(i).padStart(2, '0')}`;
    const operation =
      category === 'high-risk'
        ? 'payments'
        : category === 'inspection'
          ? 'inspect'
          : category === 'implementation' || category === 'cross-vendor'
            ? 'implementation'
            : 'mechanical';
    const lane =
      category === 'high-risk' ||
      category === 'ambiguous' ||
      category === 'no-delegation' ||
      category === 'cross-vendor'
        ? 'main'
        : category === 'inspection'
          ? 'scout'
          : category === 'implementation'
            ? 'worker'
            : 'local';
    const risk = category === 'high-risk' ? 'high' : 'low';
    const bad = [2, 3, 4, 23, 24, 25, 30, 31, 32].includes(i);
    const observed: Decision = {
      lane: bad ? (lane === 'worker' ? 'local' : 'worker') : lane,
      conf: bad ? 0.3 : 0.9,
      risk,
      risk_conf: 0.9,
      ms: 12 + i,
      router: ROUTE_MODEL,
    };
    cases.push({
      privacy: 'public',
      id,
      split,
      repositoryGroup: projectId,
      sessionGroup: `session_${split}`,
      category,
      text: `${id}: Public ${category} evaluation task with distinct case ${i}.`,
      access: category === 'inspection' ? 'read' : 'edit',
      selectedModel: 'gpt-6.1-sol',
      policy: {
        operation,
        files: [`src/task-${i}.ts`],
        ...(category === 'no-delegation' ? { noDelegation: true } : {}),
        ...(category === 'cross-vendor' ? { exactModel: 'claude-sonnet-owner-pin' } : {}),
      },
      expected: { lane, risk },
      outcome: {
        kind: 'synthetic',
        reference: `outcome_${id}`,
        projectId,
        revision: 'c'.repeat(64),
        result: i % 13 === 0 ? 'escalated' : i % 11 === 0 ? 'failed' : 'passed',
        executedLane: lane,
      },
      observed: { decision: observed, residency: 'warm', totalMs: 20 + i },
    });
  }
  return {
    schema: 1,
    privacy: 'public',
    evidence: 'synthetic',
    model: ROUTE_MODEL,
    digest: ROUTE_DIGEST,
    cases,
  };
}
export function evaluationWire(decision: Decision) {
  const confidence = decision.conf,
    probability = (1 + 3 * confidence) / 4,
    other = (1 - confidence) / 4;
  const lanes = Object.fromEntries(
    ['main', 'worker', 'local', 'scout'].map((lane) => [
      lane,
      lane === decision.lane ? probability : other,
    ]),
  );
  const riskProbability = (1 + decision.risk_conf) / 2;
  return {
    model: decision.router,
    usage: { input_tokens: 100, output_tokens: 2 },
    answers: {
      lane: { type: 'choice', choice: decision.lane, confidence, probabilities: lanes },
      risk: {
        type: 'choice',
        choice: decision.risk,
        confidence: decision.risk_conf,
        probabilities: {
          high: decision.risk === 'high' ? riskProbability : 1 - riskProbability,
          low: decision.risk === 'low' ? riskProbability : 1 - riskProbability,
        },
      },
    },
  };
}
