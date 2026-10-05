import type { InferenceInput } from '../domain/inference.ts';
import { finite, isDecision, type RouteResult } from '../domain/route.ts';
import { BosunError } from '../errors.ts';
import { publicInput } from '../policy.ts';
import type { Router } from '../ports/router.ts';
import { decide } from '../route-policy.ts';

export function createRoutePrompt({ router, minConfidence }: { router: Router; minConfidence: number }) {
  if (!finite(minConfidence, 1)) throw new BosunError('invalid', 'Invalid routing confidence threshold');
  return async (input: InferenceInput, signal: AbortSignal): Promise<RouteResult | null> => {
    publicInput(input); // before reading text, checking abort, or invoking the port
    signal.throwIfAborted();
    const raw = await router.classify(input, signal);
    if (raw === null) return null;
    // Copy only declared fields, with trusted configured metadata. Never read a response's router/extra fields.
    const decision = { lane: raw?.lane, conf: raw?.conf, risk: raw?.risk, risk_conf: raw?.risk_conf, ms: raw?.ms, router: router.label };
    if (!isDecision(decision)) throw new BosunError('invalid', 'Invalid router decision');
    const [final, why] = decide(decision, minConfidence);
    return { decision, final, why };
  };
}
