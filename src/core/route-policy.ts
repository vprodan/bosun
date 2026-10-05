import type { Decision, Lane } from './domain/route.ts';

// Risk takes precedence over confidence, retaining the deterministic v0.2 fences.
export function decide(decision: Decision, minConfidence: number): [Lane | null, string] {
  if (decision.risk === 'high' && (decision.lane === 'local' || decision.lane === 'worker')) {
    return ['main', `risk=high overrides ${decision.lane}`];
  }
  if (decision.conf < minConfidence) return [null, 'low confidence'];
  return [decision.lane, ''];
}
