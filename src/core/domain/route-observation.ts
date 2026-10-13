import { BosunError } from '../errors.ts';
import { data, jobTime } from './job.ts';
import { finite, isLane, isRisk, type Decision, type Lane } from './route.ts';

export const ROUTE_OBSERVATION_LIMITS = {
  records: 4096,
  labels: 4096,
  labelEvents: 16384,
  recordBytes: 2048,
} as const;
export const ROUTE_REASONS = [
  '',
  'low confidence',
  'risk=high overrides local',
  'risk=high overrides worker',
] as const;
export function observationId(input: unknown, legacy = false): string {
  if (
    typeof input !== 'string' ||
    !(
      legacy
        ? /^(?:[a-f0-9]{10}|[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/
        : /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
    ).test(input)
  )
    throw new BosunError('invalid', 'Invalid observation identifier');
  return input;
}
export type RouteMetadata = Decision & {
  id: string;
  at: number | null;
  final: Lane | null;
  why: string;
};
export type RouteObservation = RouteMetadata & {
  schema: 1;
  projectId: string;
  sessionKey: string | null;
  audience: 'owner' | 'model';
  digest: string;
  threshold: number;
};
export type RouteLabel = {
  id: string;
  source: 'recorded' | 'legacy';
  label: Lane;
  version: number;
  at: number | null;
};
const KEYS = [
  'schema',
  'id',
  'at',
  'projectId',
  'sessionKey',
  'audience',
  'digest',
  'threshold',
  'lane',
  'conf',
  'risk',
  'risk_conf',
  'ms',
  'router',
  'final',
  'why',
].sort();
export function routeObservation(input: unknown): RouteObservation {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).sort().join() !== KEYS.join()
  )
    throw new BosunError('invalid', 'Invalid route observation');
  const id = observationId(data(input, 'id')),
    at = jobTime(data(input, 'at') as number);
  const projectId = data(input, 'projectId'),
    sessionKey = data(input, 'sessionKey'),
    audience = data(input, 'audience');
  const digest = data(input, 'digest'),
    threshold = data(input, 'threshold'),
    router = data(input, 'router');
  const lane = data(input, 'lane'),
    conf = data(input, 'conf'),
    risk = data(input, 'risk'),
    risk_conf = data(input, 'risk_conf'),
    ms = data(input, 'ms');
  const final = data(input, 'final'),
    why = data(input, 'why');
  if (
    data(input, 'schema') !== 1 ||
    typeof projectId !== 'string' ||
    !/^p_[a-f0-9]{16}$/.test(projectId) ||
    !(
      sessionKey === null ||
      (typeof sessionKey === 'string' && /^[a-f0-9]{64}$/.test(sessionKey))
    ) ||
    !(audience === 'owner' || audience === 'model') ||
    typeof digest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(digest) ||
    !finite(threshold, 1) ||
    typeof router !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,99}$/.test(router) ||
    !isLane(lane) ||
    !isRisk(risk) ||
    !finite(conf, 1) ||
    !finite(risk_conf, 1) ||
    !finite(ms, 3600000) ||
    !(final === null || isLane(final)) ||
    typeof why !== 'string' ||
    !ROUTE_REASONS.includes(why as never)
  )
    throw new BosunError('invalid', 'Invalid route observation');
  return {
    schema: 1,
    id,
    at,
    projectId,
    sessionKey,
    audience: audience as RouteObservation['audience'],
    digest,
    threshold,
    router,
    lane,
    conf,
    risk,
    risk_conf,
    ms,
    final,
    why,
  };
}
export function routeStatistics(rows: readonly (RouteMetadata & { label?: RouteLabel | null })[]) {
  const raw = { scout: 0, local: 0, worker: 0, main: 0 },
    final = { ...raw, none: 0 };
  let labeled = 0,
    agreeing = 0;
  const latencies: number[] = [];
  for (const row of rows) {
    raw[row.lane]++;
    final[row.final ?? 'none']++;
    latencies.push(row.ms);
    if (row.label) {
      labeled++;
      if (row.label.label === row.lane) agreeing++;
    }
  }
  latencies.sort((a, b) => a - b);
  const percentile = (p: number) =>
    latencies.length ? latencies[Math.max(0, Math.ceil(p * latencies.length) - 1)] : null;
  return {
    coverage: 'metadata-only' as const,
    calibration: 'unverified' as const,
    automaticDispatch: false as const,
    decisions: rows.length,
    labeled,
    raw,
    final,
    latency: { p50: percentile(0.5), p95: percentile(0.95) },
    rawLabelAgreement: labeled ? agreeing / labeled : null,
  };
}
