import { BosunError } from './errors.ts';
import { screenPublicText } from './secret-screen.ts';

export type RouterMigrationInput = {
  // The upgrade's reviewed inventory supplies fingerprints. This pure planner discovers or changes no files/services.
  configHash: string;
  legacy: { routerUrl: string | null; routerPort: number; trainingRun: string; minConfidence: number; timeoutSeconds: number };
  target: { url: string; model: string; digest?: string; timeoutMs: number; minConfidence: number };
  service: { state: 'absent' } | { state: 'present'; label: string; file: string; hash: string; argv: string[];
    ownership: { installationId: string; installedHash: string } | null; reviewedAdoptionHash?: string };
};
export type RouterMigrationPlan = {
  schema: 1; state: 'prepared' | 'held'; reason: 'ready' | 'service_unowned' | 'service_changed' | 'service_shape_unknown';
  configHash: string;
  router: { provider: 'ollama'; protocol: 'systemone'; url: string; model: string; digest?: string; timeoutMs: number; minConfidence: number };
  retiredKeys: readonly ['ROUTER_RUN', 'ROUTER_PORT', 'ROUTER_URL', 'ROUTER_MIN_CONF', 'ROUTER_TIMEOUT'];
  endpoint: { legacyWasExplicit: boolean; selection: 'owner_supplied' };
  confidence: { calibration: 'unverified'; legacyThresholdCarried: false };
  steps: ({ op: 'backup-config'; hash: string } | { op: 'write-router-config' } | { op: 'record-reviewed-service-adoption'; file: string; hash: string }
    | { op: 'backup-launchagent'; file: string; hash: string } | { op: 'stop-legacy-router'; label: 'com.bosun.router'; file: string; hash: string }
    | { op: 'archive-launchagent'; file: string; hash: string })[];
};
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const invalid = (): never => { throw new BosunError('invalid', 'Invalid router migration inventory'); };
function endpoint(value: unknown): void {
  try {
    if (typeof value !== 'string' || value.length > 2048) throw 0;
    const parsed = new URL(value); if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw 0;
  } catch { invalid(); }
}
export function planRouterMigration(input: RouterMigrationInput): RouterMigrationPlan {
  if (!input || !hash(input.configHash) || !input.legacy || !input.target || !input.service) invalid();
  const { legacy, target, service } = input;
  if (!(legacy.routerUrl === null || typeof legacy.routerUrl === 'string') || !Number.isSafeInteger(legacy.routerPort) || legacy.routerPort < 1 || legacy.routerPort > 65535
    || typeof legacy.trainingRun !== 'string' || legacy.trainingRun.length > 200 || !legacy.trainingRun.trim()
    || !Number.isFinite(legacy.timeoutSeconds) || legacy.timeoutSeconds <= 0 || !Number.isFinite(legacy.minConfidence) || legacy.minConfidence < 0 || legacy.minConfidence > 1) invalid();
  // An explicit legacy Kev endpoint is never guessed into an Ollama endpoint. The owner supplies the exact target.
  endpoint(target.url);
  if (typeof target.model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,99}$/.test(target.model)
    || target.digest !== undefined && !/^(?:sha256:)?[a-f0-9]{64}$/.test(target.digest)
    || !Number.isSafeInteger(target.timeoutMs) || target.timeoutMs < 1 || target.timeoutMs > 30000
    || !Number.isFinite(target.minConfidence) || target.minConfidence < 0 || target.minConfidence > 1) invalid();
  screenPublicText(target.url); screenPublicText(target.model);
  const plan: RouterMigrationPlan = { schema: 1, state: 'prepared', reason: 'ready', configHash: input.configHash,
    router: { provider: 'ollama', protocol: 'systemone', url: target.url, model: target.model, ...(target.digest === undefined ? {} : { digest: target.digest }), timeoutMs: target.timeoutMs, minConfidence: target.minConfidence },
    retiredKeys: ['ROUTER_RUN', 'ROUTER_PORT', 'ROUTER_URL', 'ROUTER_MIN_CONF', 'ROUTER_TIMEOUT'],
    endpoint: { legacyWasExplicit: !!legacy.routerUrl?.trim(), selection: 'owner_supplied' }, confidence: { calibration: 'unverified', legacyThresholdCarried: false },
    steps: [{ op: 'backup-config', hash: input.configHash }] };
  const hold = (reason: RouterMigrationPlan['reason']) => { plan.state = 'held'; plan.reason = reason; return plan; };
  if (service.state === 'present') {
    if (!hash(service.hash) || typeof service.file !== 'string' || !service.file.startsWith('/') || service.file.length > 4096 || service.file.includes('\0')
      || service.file.split('/').some((piece) => piece === '.' || piece === '..') || !Array.isArray(service.argv) || service.argv.length > 32
      || service.argv.some((arg) => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0'))) invalid();
    const expected = ['run', '--extra', 'serve', 'python', '-m', 'kev.serve', '--run', legacy.trainingRun, '--port', String(legacy.routerPort)];
    if (service.label !== 'com.bosun.router' || !service.file.endsWith('/Library/LaunchAgents/com.bosun.router.plist')
      || service.argv.length !== expected.length + 1 || !/^(?:\/[^\0]+\/)?uv$/.test(service.argv[0]) || expected.some((arg, index) => service.argv[index + 1] !== arg)) return hold('service_shape_unknown');
    if (service.ownership) {
      if (typeof service.ownership.installationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(service.ownership.installationId) || !hash(service.ownership.installedHash)) invalid();
      if (service.ownership.installedHash !== service.hash) return hold('service_changed');
    } else {
      // Legacy services.ts recorded neither plist fingerprints nor service ownership.
      // A matching name/command is a review candidate, not proof that bosun owns it.
      if (service.reviewedAdoptionHash === undefined) return hold('service_unowned');
      if (!hash(service.reviewedAdoptionHash) || service.reviewedAdoptionHash !== service.hash) return hold('service_changed');
      plan.steps.push({ op: 'record-reviewed-service-adoption', file: service.file, hash: service.hash });
    }
    plan.steps.push({ op: 'backup-launchagent', file: service.file, hash: service.hash },
      { op: 'stop-legacy-router', label: 'com.bosun.router', file: service.file, hash: service.hash },
      { op: 'archive-launchagent', file: service.file, hash: service.hash });
  } else if (service.state !== 'absent') invalid();
  plan.steps.push({ op: 'write-router-config' });
  return plan;
}
