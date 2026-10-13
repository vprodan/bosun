export const HOSTS = ['omp', 'opencode', 'codex', 'claude'] as const;
export type HostId = (typeof HOSTS)[number];
export type ModelBinding = { model?: string; effort?: string };
export type RoleBindings = Record<string, Partial<Record<HostId, ModelBinding>>>;
export type AcpSettings = {
  enabled: boolean;
  command: string;
  args: string[];
  agentName: string;
  agentVersion: string;
  protocolVersion: 1;
  timeoutMs: number;
  modelOption?: string;
  effortOption?: string;
};
export type ProviderSettings = {
  kind: 'ollama' | 'openai-compatible' | 'claude-cli' | 'codex-cli';
  model: string;
  url?: string;
  apiKeyEnv?: string;
  timeoutMs: number;
};
export type RuntimeConfig = {
  schemaVersion: 1;
  hosts: {
    primary: HostId;
    omp: { enabled: boolean; command: string; home?: string };
    opencode: {
      enabled: boolean;
      command: string;
      url: string;
      username?: string;
      passwordEnv?: string;
    };
    codex: { enabled: boolean; command: string; home?: string };
    claude: { enabled: boolean; command: string; home?: string };
  };
  roles: RoleBindings;
  acp: Record<string, AcpSettings>;
  router: {
    provider: 'ollama';
    model: string;
    url: string;
    timeoutMs: number;
    minConfidence: number;
    digest?: string;
  };
  providers: Record<string, ProviderSettings>;
  local: {
    model: string;
    fallback: string;
    contextTokens: number;
    maxTurns: number;
    timeoutMs: number;
  };
  daemon: {
    maxQueuedJobs: number;
    maxStoredJobs: number;
    maxStoredEvents: number;
    maxStoredReceipts: number;
    maxDailyUsageGroups: number;
    jobRetentionDays: number;
    maxConcurrency: 1;
    drainMs: number;
  };
  memory: {
    linkedProjects: string[];
    sessionTtlDays: number;
    purgeAfterDays: number;
    claudeMem: boolean;
    claudeMemDb?: string;
  };
  context: {
    hookBudgetTokens: number;
    hookMinScore: number;
    hookMinTerms: number;
    itemChars: number;
  };
  handoff: {
    enabled: boolean;
    threshold: number;
    provider: string;
    maxSummaryTokens: number;
    maxInputTokens: number;
  };
  graph: {
    enabled: boolean;
    maxHops: number;
    maxCandidates: number;
    extraction: boolean;
    vectors: boolean;
    provider: string;
    embedding: {
      model: string;
      url: string;
      dimensions: number;
      transform: 'embeddinggemma-v1' | 'plain-v1';
      digest?: string;
      timeoutMs: number;
      keepAlive: string;
      minCosine: number;
      backend: 'disabled' | 'reference' | 'sqlite-vec';
      extension?: { file: string; sha256: string; version: '0.1.9' };
      queryCacheSize: number;
      queryCacheTtlMs: number;
    };
    consolidation: {
      maxOutstanding: number;
      maxSources: number;
      maxProposals: number;
      maxInputBytes: number;
      timeoutMs: number;
      allowRemoteApi: boolean;
      schedule: { enabled: boolean; intervalMs: number };
    };
  };
  notifications: { enabled: boolean; maxReceipts: number; maxPending: number; timeoutMs: number };
  remote: {
    enabled: boolean;
    bind: string;
    port: number;
    tokenEnv: string;
    modelTokenEnv: string;
    allow: string[];
    authority?: string;
    authorityId?: string;
    timeoutMs: number;
    caFile?: string;
    tls?: { keyFile: string; certFile: string };
    projects: { workspace: string; tokenEnv?: string; modelTokenEnv?: string }[];
  };
};

// Fresh values per administrative load; roots validate/freeze their own settings.
// Existing Codex/Claude role choices and the generative local model stay intact.
// OMP/OpenCode models require explicit native role or call bindings; no fuzzy fallback.
export function defaultConfig(): RuntimeConfig {
  const roles: RoleBindings = {};
  for (const name of ['architect', 'scout', 'worker', 'tester', 'debugger', 'reviewer']) {
    roles[name] = {
      codex: {
        model: name === 'architect' ? 'gpt-6-astra' : 'gpt-6-luna',
        effort: name === 'scout' ? 'low' : 'high',
      },
      claude: {
        model: name === 'architect' ? 'opus' : name === 'scout' ? 'haiku' : 'sonnet',
        ...(name === 'architect' ? { effort: 'high' } : {}),
      },
    };
  }
  return {
    schemaVersion: 1,
    hosts: {
      primary: 'omp',
      omp: { enabled: true, command: 'omp' },
      opencode: { enabled: true, command: 'opencode2', url: 'http://127.0.0.1:4096' },
      codex: { enabled: true, command: 'codex' },
      claude: { enabled: true, command: 'claude' },
    },
    roles,
    acp: {},
    router: {
      provider: 'ollama',
      model: 'clef-flash:9b',
      url: 'http://127.0.0.1:11434',
      timeoutMs: 1000,
      minConfidence: 0.7,
    },
    providers: {
      default: {
        kind: 'ollama',
        model: 'qwen3.6:35b-a3b-coding-nvfp4',
        url: 'http://127.0.0.1:11434',
        timeoutMs: 60_000,
      },
    },
    local: {
      model: 'qwen3.6:35b-a3b-coding-nvfp4',
      fallback: 'devstral-small-2:24b',
      contextTokens: 65536,
      maxTurns: 40,
      timeoutMs: 30 * 60_000,
    },
    daemon: {
      maxQueuedJobs: 64,
      maxStoredJobs: 1024,
      maxStoredEvents: 32768,
      maxStoredReceipts: 16384,
      maxDailyUsageGroups: 16384,
      jobRetentionDays: 30,
      maxConcurrency: 1,
      drainMs: 5000,
    },
    memory: { linkedProjects: [], sessionTtlDays: 7, purgeAfterDays: 90, claudeMem: true },
    context: { hookBudgetTokens: 400, hookMinScore: 0.35, hookMinTerms: 2, itemChars: 400 },
    handoff: {
      enabled: true,
      threshold: 0.7,
      provider: 'default',
      maxSummaryTokens: 4096,
      maxInputTokens: 32_000,
    },
    graph: {
      enabled: true,
      maxHops: 2,
      maxCandidates: 100,
      extraction: false,
      vectors: false,
      provider: 'default',
      embedding: {
        model: 'embeddinggemma:300m-qat-q4_0',
        url: 'http://127.0.0.1:11434',
        dimensions: 768,
        transform: 'embeddinggemma-v1',
        timeoutMs: 5000,
        keepAlive: '1m',
        minCosine: 0.6,
        backend: 'disabled',
        queryCacheSize: 0,
        queryCacheTtlMs: 5000,
      },
      consolidation: {
        maxOutstanding: 20,
        maxSources: 8,
        maxProposals: 4,
        maxInputBytes: 24576,
        timeoutMs: 60000,
        allowRemoteApi: false,
        schedule: { enabled: false, intervalMs: 300000 },
      },
    },
    notifications: { enabled: false, maxReceipts: 4096, maxPending: 64, timeoutMs: 1500 },
    remote: {
      enabled: false,
      bind: '127.0.0.1',
      port: 8788,
      tokenEnv: 'BOSUN_REMOTE_TOKEN',
      modelTokenEnv: 'BOSUN_REMOTE_MODEL_TOKEN',
      allow: ['127.0.0.1/32'],
      timeoutMs: 5000,
      projects: [],
    },
  };
}
