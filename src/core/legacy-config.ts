import { defaultConfig, type RuntimeConfig } from './domain/config.ts';
import { BosunError } from './errors.ts';

// One explicit import, never a runtime fallback or shell evaluation.
export function importLegacyConfig(text: string): { config: RuntimeConfig; retained: string[];
  legacyRouter: { explicitEndpoint: boolean; routerPort: number; trainingRun: string; minConfidence: number; timeoutSeconds: number } } {
  const values: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.split('#')[0].trim();
    if (!line) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match || Object.hasOwn(values, match[1]) || /[\x00-\x1f\x7f]/.test(match[2]))
      throw new BosunError('invalid', 'Legacy configuration requires review');
    values[match[1]] = match[2].trim();
  }
  const config = defaultConfig(),
    consumed = new Set<string>();
  const take = (key: string) => {
    consumed.add(key);
    return values[key];
  };
  const number = (key: string, set: (n: number) => void) => {
    const value = take(key);
    if (value === undefined) return;
    if (!value || !Number.isFinite(Number(value)))
      throw new BosunError('invalid', 'Legacy numeric setting requires review');
    set(Number(value));
  };
  const assign = (key: string, set: (s: string) => void) => {
    const value = take(key);
    if (value) set(value);
  };
  assign('LOCAL_MODEL', (v) => {
    config.local.model = v;
  });
  assign('LOCAL_FALLBACK', (v) => {
    config.local.fallback = v;
  });
  number('CTX', (n) => {
    config.local.contextTokens = n;
  });
  number('LOCAL_MAX_TURNS', (n) => {
    config.local.maxTurns = n;
  });
  number('RUN_TIMEOUT_MIN', (n) => {
    config.local.timeoutMs = n * 60000;
  });
  const ollama = take('OLLAMA_URL');
  if (ollama) {
    config.router.url = ollama;
    config.providers.default.url = ollama;
  }
  const providers = take('LLM_PROVIDERS') || 'ollama';
  if (
    !['ollama', 'openai'].includes(providers) ||
    (take('LLM_REMOTE') || 'off') !== 'off' ||
    take('MEMORY_URL')
  )
    throw new BosunError(
      'unsupported',
      'Legacy provider or remote authority requires reviewed configuration',
    );
  const openai = take('LLM_OPENAI_URL');
  config.providers.default.model = take('LLM_MODEL') || config.local.model;
  if (providers === 'openai') {
    config.providers.default.kind = 'openai-compatible';
    config.providers.default.url = openai || 'http://127.0.0.1:8080';
  }
  number('LLM_TIMEOUT_S', (n) => {
    config.providers.default.timeoutMs = n * 1000;
  });
  const binding = (value: string) => {
    const parts = value.split(':');
    if (!parts[0] || parts.length > 2 || parts.some((part) => /\s/.test(part)))
      throw new BosunError('invalid', 'Legacy native model binding requires review');
    return { model: parts[0], ...(parts[1] ? { effort: parts[1] } : {}) };
  };
  for (const role of ['architect', 'scout', 'worker', 'tester', 'debugger', 'reviewer'])
    for (const host of ['codex', 'claude'] as const) {
      const value = take(`ROLE_${role.toUpperCase()}_${host.toUpperCase()}`);
      if (value) config.roles[role][host] = binding(value);
    }
  for (const [prefix, role] of [
    ['WORKER_BY', 'executor'],
    ['REVIEW_BY', 'cross-reviewer'],
  ])
    for (const host of ['codex', 'claude'] as const) {
      const value = take(`${prefix}_${host.toUpperCase()}`);
      if (value) {
        config.roles[role] ??= {};
        config.roles[role][host] = binding(value);
      }
    }
  const hosts = take('HOSTS');
  if (hosts && !['auto', 'both', 'claude', 'codex', 'claude,codex', 'codex,claude'].includes(hosts))
    throw new BosunError('unsupported', 'Legacy host selection requires review');
  if (hosts === 'claude') config.hosts.codex.enabled = false;
  if (hosts === 'codex') config.hosts.claude.enabled = false;
  number('MEMORY_SESSION_TTL_DAYS', (n) => {
    config.memory.sessionTtlDays = n;
  });
  number('MEMORY_PURGE_AFTER_DAYS', (n) => {
    config.memory.purgeAfterDays = n;
  });
  const linked = take('MEMORY_LINKED_PROJECTS');
  if (linked) config.memory.linkedProjects = linked.split(',').map((s) => s.trim());
  const claudeMem = take('CLAUDE_MEM');
  if (claudeMem && !['on', 'off'].includes(claudeMem))
    throw new BosunError('invalid', 'Legacy source setting requires review');
  if (claudeMem) config.memory.claudeMem = claudeMem === 'on';
  assign('CLAUDE_MEM_DB', (v) => {
    config.memory.claudeMemDb = v;
  });
  number('CONTEXT_HOOK_BUDGET', (n) => {
    config.context.hookBudgetTokens = n;
  });
  number('CONTEXT_HOOK_MIN_SCORE', (n) => {
    config.context.hookMinScore = n;
  });
  number('CONTEXT_HOOK_MIN_TERMS', (n) => {
    config.context.hookMinTerms = n;
  });
  number('CONTEXT_ITEM_CHARS', (n) => {
    config.context.itemChars = n;
  });
  // Paths to a pre-existing cutover select a different layout; do not adopt it.
  for (const key of ['MEMORY_VIEW_PATH', 'MEMORY_SOURCE_ID', 'MEMORY_BACKUP_DIR'])
    if (take(key))
      throw new BosunError('unsupported', 'Existing memory binding requires manual upgrade review');
  const router = take('ROUTER_RUN');
  if (router && router !== 'jaredpalmer/kev-0.8b')
    throw new BosunError('unsupported', 'Custom legacy router requires review');
  // Retained original file records retired interfaces/auth; none is executed,
  // imported as a credential, or guessed into a new service configuration.
  const retained = [
    'LOCAL_HARNESS',
    'WATCH',
    'ROUTER_PORT',
    'ROUTER_URL',
    'ROUTER_MIN_CONF',
    'ROUTER_TIMEOUT',
    'MEMORY_TOKEN',
    'MCP_MAX_CHARS',
    'LLM_RETRIES',
    'SERVE_BIND',
    'SERVE_ALLOW',
    'MEMORY_PORT',
    'REMOTE_TIMEOUT_MS',
    'REMOTE_HOOK_TIMEOUT_MS',
  ];
  for (const key of retained) consumed.add(key);
  if (Object.keys(values).some((key) => !consumed.has(key)))
    throw new BosunError('unsupported', 'Unknown legacy configuration fields require review');
  // Presence is sufficient for review. Never promote an old URL's credentials,
  // query or path into the imported configuration or migration metadata.
  const legacyRouter = { explicitEndpoint: !!values.ROUTER_URL?.trim(),
    routerPort: Number(values.ROUTER_PORT ?? 8009), trainingRun: router || 'jaredpalmer/kev-0.8b',
    minConfidence: Number(values.ROUTER_MIN_CONF ?? 0.5), timeoutSeconds: Number(values.ROUTER_TIMEOUT ?? 1.5) };
  if (!Number.isSafeInteger(legacyRouter.routerPort) || legacyRouter.routerPort < 1 || legacyRouter.routerPort > 65535
    || !Number.isFinite(legacyRouter.minConfidence) || legacyRouter.minConfidence < 0 || legacyRouter.minConfidence > 1
    || !Number.isFinite(legacyRouter.timeoutSeconds) || legacyRouter.timeoutSeconds <= 0)
    throw new BosunError('invalid', 'Legacy router settings require review');
  return { config, retained: retained.filter((key) => Object.hasOwn(values, key)), legacyRouter };
}
