// Temporary v0.2 migration seam; replace service/config/model together in the Clef slice.
import { finite, isLane, isRisk, LANES, RISK } from '../../core/domain/route.ts';
import type { Router } from '../../core/ports/router.ts';
import { publicInput } from '../../core/policy.ts';
import { BosunError } from '../../core/errors.ts';

const round = (value: number) => Math.round(value * 1000) / 1000;
export function createLegacyRouter({ url }: { url: string }): Router {
  return {
    id: 'legacy-kev',
    label: 'kev-latest',
    async classify(input, signal) {
      publicInput(input);
      const body = {
        state: { request: input.text.slice(0, 4000) }, model: 'kev-latest',
        questions: {
          lane: { type: 'choice', instructions: 'Which executor should handle this coding request?', criteria: LANES },
          risk: { type: 'choice', instructions: 'How risky is a mistake in this change?', criteria: RISK },
        },
      };
      const started = Date.now();
      const response = await fetch(`${url.replace(/\/$/, '')}/v1/systemone`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal,
      });
      if (!response.ok) throw new BosunError('unavailable', 'Legacy router unavailable');
      const out: unknown = await response.json();
      const data = out as { answers?: { lane?: { choice?: unknown; confidence?: unknown }; risk?: { choice?: unknown; confidence?: unknown } }; latency_ms?: unknown } | null;
      const lane = data?.answers?.lane;
      const risk = data?.answers?.risk;
      if (!isLane(lane?.choice) || !isRisk(risk?.choice) || !finite(lane?.confidence, 1) || !finite(risk?.confidence, 1)) {
        throw new BosunError('invalid', 'Invalid router response');
      }
      return { lane: lane.choice, conf: round(lane.confidence), risk: risk.choice, risk_conf: round(risk.confidence),
        ms: finite(data?.latency_ms, 3_600_000) ? data.latency_ms : Date.now() - started };
    },
  };
}
