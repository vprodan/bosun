export type Lane = 'scout' | 'local' | 'worker' | 'main';
export type Risk = 'high' | 'low';
// Keep the old risk_conf wire spelling until the shared transport DTO slice.
export type Decision = { lane: Lane; conf: number; risk: Risk; risk_conf: number; ms: number; router: string };
export type RouteResult = { decision: Decision; final: Lane | null; why: string };
export const LANES: Record<Lane, string> = {
  scout: 'Question or lookup about existing code: where is X, how does Y work, find usages, explain a file. No code changes.',
  local: 'Small mechanical code change with an obvious answer: rename, move, update imports, add a field end to end, fix a lint or type error, boilerplate that follows an existing example.',
  worker: 'Clearly specified code change that needs reasoning: new logic, writing tests, a multi-file feature from a clear plan, tricky types.',
  main: 'Needs design or judgment: architecture, an ambiguous bug, unclear requirements, planning, reviewing a PR, trade-offs.',
};
export const RISK: Record<Risk, string> = {
  high: 'Touches payments, orders, invoices, auth, secrets, data deletion, migrations, or production infrastructure.',
  low: 'None of those; ordinary application code, tests, tooling or docs.',
};
export const isLane = (value: unknown): value is Lane => typeof value === 'string' && Object.hasOwn(LANES, value);
export const isRisk = (value: unknown): value is Risk => value === 'high' || value === 'low';
export const finite = (value: unknown, max: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max;
export function isDecision(value: unknown): value is Decision {
  if (!value || typeof value !== 'object') return false;
  const d = value as Partial<Decision>;
  return isLane(d.lane) && isRisk(d.risk) && finite(d.conf, 1) && finite(d.risk_conf, 1)
    && finite(d.ms, 3_600_000) && typeof d.router === 'string' && d.router.length > 0 && d.router.length <= 100;
}
