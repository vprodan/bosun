import { BosunError } from '../../core/errors.ts';
import { publicInput } from '../../core/policy.ts';
import { screenPublicText } from '../../core/secret-screen.ts';
import { finite, LANES, RISK, type Lane, type Risk } from '../../core/domain/route.ts';
import type { Router } from '../../core/ports/router.ts';
import { httpJson, protocolBase } from '../../platform/http-json.ts';

export type ClefSettings = { url: string; model?: string; timeoutMs?: number; digest?: string };
export const CLEF_DEFAULT_MODEL = 'clef-flash:9b';
export const CLEF_REQUEST_BYTES = 64 * 1024;
export const CLEF_TEXT_CHARS = 24_000;
const LANE_ORDER: Lane[] = ['main', 'worker', 'local', 'scout'];
const RISK_ORDER: Risk[] = ['high', 'low'];
export const CLEF_QUALIFICATION = Object.freeze({ calibration: 'unverified', liveReadiness: 'unverified', autonomousDelegation: 'unsupported' } as const);
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const sameKeys = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const invalid = (): never => { throw new BosunError('invalid', 'Invalid decision protocol response'); };
function model(value: unknown): string {
  const selected = value === undefined ? CLEF_DEFAULT_MODEL : value;
  if (typeof selected !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,99}$/.test(selected)) throw new BosunError('invalid', 'Invalid decision model configuration');
  return selected;
}
function answer<T extends string>(value: unknown, order: readonly T[]): { choice: T; confidence: number } {
  const a = object(value);
  const probabilities = object(a?.probabilities);
  if (!a || a.type !== 'choice' || !order.includes(a.choice as T) || !finite(a.confidence, 1) || !probabilities || !sameKeys(probabilities, order)) return invalid();
  const values = order.map((key) => probabilities[key]);
  if (!values.every((p) => finite(p, 1))) return invalid();
  const numbers = values as number[];
  // Official examples round probabilities; tolerate only that small rounding drift.
  if (Math.abs(numbers.reduce((sum, p) => sum + p, 0) - 1) > 0.001) return invalid();
  const preferred = order[numbers.indexOf(Math.max(...numbers))];
  if (a.choice !== preferred) return invalid();
  return { choice: preferred, confidence: a.confidence };
}

// Explicitly selected fixture-stage adapter. Construction neither reads config nor starts/probes a model.
export function createClefRouter(settings: ClefSettings): Router & { readonly qualification: typeof CLEF_QUALIFICATION; prepare(input: Parameters<Router['classify']>[0]): string } {
  let selected: { url: string; model: string; timeoutMs: number } | undefined;
  return {
    id: 'ollama-clef',
    get label() { return selected?.model ?? model(settings.model); },
    qualification: CLEF_QUALIFICATION,
    prepare(input) {
      publicInput(input); // before config/payload access, including getter-backed malformed inputs
      if (!input.text.trim() || input.text.length > CLEF_TEXT_CHARS) throw new BosunError('invalid', 'Decision input exceeds text limit or is empty');
      screenPublicText(input.text);
      if (!selected) {
        const timeoutMs = settings.timeoutMs ?? 1000;
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new BosunError('invalid', 'Invalid decision deadline configuration');
        selected = { url: protocolBase(settings.url), model: model(settings.model), timeoutMs };
      }
      const body = JSON.stringify({ model: selected.model, state: input.text, questions: {
        lane: { type: 'choice', instructions: 'Which executor should handle this coding request?', criteria: Object.fromEntries(LANE_ORDER.map((key) => [key, LANES[key]])) },
        risk: { type: 'choice', instructions: 'How risky is a mistake in this change?', criteria: Object.fromEntries(RISK_ORDER.map((key) => [key, RISK[key]])) },
      } });
      if (Buffer.byteLength(body, 'utf8') > CLEF_REQUEST_BYTES) throw new BosunError('invalid', 'Decision request exceeds byte limit');
      return body;
    },
    async classify(input, signal) {
      const body = this.prepare(input); const current = selected!;
      const started = Date.now();
      const response = object(await httpJson(`${current.url}/v1/systemone`, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal }, current.timeoutMs, 64 * 1024));
      const answers = object(response?.answers);
      const usage = object(response?.usage);
      if (!response || response.model !== current.model || !answers || !sameKeys(answers, ['lane', 'risk']) || !usage
        || !Number.isSafeInteger(usage.input_tokens) || Number(usage.input_tokens) < 0 || !Number.isSafeInteger(usage.output_tokens) || Number(usage.output_tokens) < 0) return invalid();
      const lane = answer(answers.lane, LANE_ORDER);
      const risk = answer(answers.risk, RISK_ORDER);
      return { lane: lane.choice, conf: lane.confidence, risk: risk.choice, risk_conf: risk.confidence, ms: Date.now() - started };
    },
  };
}
