import crypto from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { parse, stringify } from 'smol-toml';
import { defaultConfig, HOSTS, type RuntimeConfig } from '../core/domain/config.ts';
import { BosunError } from '../core/errors.ts';
import type { Env } from '../core/domain/inference.ts';
import type { RuntimePaths } from './paths.ts';
import { readPrivateFile, writePrivateFile } from './private-file.ts';

const text = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => !value.includes('\0'));
const key = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
const variable = z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/);
const directory = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) => path.isAbsolute(value) && path.resolve(value) === value && !value.includes('\0'),
  );
const endpoint = z
  .string()
  .max(2048)
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  });
const integer = (min: number, max: number) => z.number().int().min(min).max(max);
const binding = z.strictObject({ model: text.optional(), effort: text.optional() });
const provider = z.strictObject({
  kind: z.enum(['ollama', 'openai-compatible', 'claude-cli', 'codex-cli']),
  model: text,
  url: endpoint.optional(),
  apiKeyEnv: variable.optional(),
  timeoutMs: integer(1, 300000),
});
export const configSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    hosts: z.strictObject({
      primary: z.enum(HOSTS),
      omp: z.strictObject({ enabled: z.boolean(), command: text, home: directory.optional() }),
      opencode: z.strictObject({
        enabled: z.boolean(),
        command: text,
        url: endpoint,
        username: text.optional(),
        passwordEnv: variable.optional(),
      }),
      codex: z.strictObject({ enabled: z.boolean(), command: text, home: directory.optional() }),
      claude: z.strictObject({ enabled: z.boolean(), command: text, home: directory.optional() }),
    }),
    roles: z.record(
      key,
      z.strictObject({
        omp: binding.optional(),
        opencode: binding.optional(),
        codex: binding.optional(),
        claude: binding.optional(),
      }),
    ),
    acp: z.record(key, z.strictObject({
      enabled: z.boolean(), command: z.string().min(1).max(4096).refine(value => !/[\x00-\x1f\x7f]/.test(value)),
      args: z.array(z.string().max(4096).refine(value => !value.includes('\0'))).max(64),
      agentName: text, agentVersion: text, protocolVersion: z.literal(1), timeoutMs: integer(1000, 86400000),
      modelOption: text.optional(), effortOption: text.optional(),
    })),
    router: z.strictObject({
      provider: z.literal('ollama'),
      model: text,
      url: endpoint,
      timeoutMs: integer(1, 30000),
      minConfidence: z.number().min(0).max(1),
      digest: z
        .string()
        .regex(/^(?:sha256:)?[a-f0-9]{64}$/)
        .optional(),
    }),
    providers: z.record(key, provider),
    local: z.strictObject({
      model: text,
      fallback: text,
      contextTokens: integer(1024, 1048576),
      maxTurns: integer(1, 100),
      timeoutMs: integer(1000, 86400000),
    }),
    daemon: z.strictObject({
      maxQueuedJobs: integer(1, 256),
      maxStoredJobs: integer(1, 1024),
      maxStoredEvents: integer(3, 32768),
      maxStoredReceipts: integer(1, 16384),
      maxDailyUsageGroups: integer(1, 16384),
      jobRetentionDays: integer(1, 3650),
      maxConcurrency: z.literal(1),
      drainMs: integer(1, 300000),
    }),
    memory: z.strictObject({
      linkedProjects: z.array(z.string().regex(/^p_[a-f0-9]{16}$/)).max(100),
      sessionTtlDays: z.number().min(0).max(3650),
      purgeAfterDays: z.number().min(0).max(3650),
      claudeMem: z.boolean(),
      claudeMemDb: directory.optional(),
    }),
    context: z.strictObject({
      hookBudgetTokens: integer(0, 4000),
      hookMinScore: z.number().min(0).max(10),
      hookMinTerms: integer(0, 20),
      itemChars: integer(1, 4000),
    }),
    handoff: z.strictObject({
      enabled: z.boolean(),
      threshold: z.number().min(0.1).max(0.95),
      provider: key,
      maxSummaryTokens: integer(256, 16384),
      maxInputTokens: integer(1024, 262144),
    }),
    graph: z.strictObject({
      enabled: z.boolean(),
      maxHops: integer(1, 2),
      maxCandidates: integer(1, 1000),
      extraction: z.boolean(),
      vectors: z.boolean(),
      provider: key,
      embedding: z.strictObject({
        model: text,
        url: endpoint,
        dimensions: integer(1, 4096),
        transform: z.enum(['embeddinggemma-v1', 'plain-v1']),
        digest: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        timeoutMs: integer(1, 60000),
        keepAlive: z.string().regex(/^(?:0|[1-9][0-9]{0,4}(?:ms|s|m))$/),
        minCosine: z.number().min(0).max(1),
        backend: z.enum(['disabled', 'reference', 'sqlite-vec']),
        extension: z.strictObject({ file: z.string().min(1).max(4096).refine(value => value.startsWith('/') && !/[\x00-\x1f\x7f]/.test(value)),
          sha256: z.string().regex(/^[a-f0-9]{64}$/), version: z.literal('0.1.9') }).optional(),
        queryCacheSize: z.number().int().min(0).max(64),
        queryCacheTtlMs: z.number().int().min(1).max(30000),
      }),
      consolidation: z.strictObject({
        maxOutstanding: integer(1, 20),
        maxSources: integer(1, 8),
        maxProposals: integer(1, 4),
        maxInputBytes: integer(4096, 24576),
        timeoutMs: integer(1, 300000),
        allowRemoteApi: z.boolean(),
        schedule: z.strictObject({ enabled: z.boolean(), intervalMs: integer(60000, 86400000) }),
      }),
    }),
    notifications: z.strictObject({
      enabled: z.boolean(),
      maxReceipts: integer(1, 16384),
      maxPending: integer(1, 64),
      timeoutMs: integer(1, 10000),
    }),
    remote: z.strictObject({
      enabled: z.boolean(),
      bind: z.string().min(1).max(200),
      port: integer(1, 65535),
      tokenEnv: variable,
      modelTokenEnv: variable,
      allow: z.array(z.string().min(1).max(200)).max(100),
      authority: endpoint.optional(),
      authorityId: z.string().uuid().optional(),
      timeoutMs: integer(1, 30000),
      caFile: directory.optional(),
      tls: z.strictObject({ keyFile: directory, certFile: directory }).optional(),
      projects: z
        .array(
          z.strictObject({
            workspace: directory,
            tokenEnv: variable.optional(),
            modelTokenEnv: variable.optional(),
          }),
        )
        .max(64),
    }),
  })
  .superRefine((config, context) => {
    const issue = (path: string[], message: string) =>
      context.addIssue({ code: 'custom', path, message });
    if (!config.hosts[config.hosts.primary].enabled)
      issue(['hosts', 'primary'], 'Primary host disabled');
    if (
      config.daemon.maxStoredJobs < config.daemon.maxQueuedJobs ||
      config.daemon.maxStoredEvents < config.daemon.maxStoredJobs * 3
    )
      issue(['daemon'], 'Invalid ledger capacity');
    if (Object.keys(config.roles).length > 32 || Object.keys(config.providers).length > 16)
      issue(['providers'], 'Too many entries');
    if (Object.keys(config.acp).length > 16) issue(['acp'], 'Too many ACP profiles');
    for (const [id, profile] of Object.entries(config.acp))
      if (profile.modelOption && profile.modelOption === profile.effortOption)
        issue(['acp', id], 'ACP selectors must be distinct');
    for (const section of ['handoff', 'graph'] as const)
      if (!Object.hasOwn(config.providers, config[section].provider))
        issue([section, 'provider'], 'Provider not configured');
    for (const [id, value] of Object.entries(config.providers))
      if (['ollama', 'openai-compatible'].includes(value.kind) && !value.url)
        issue(['providers', id, 'url'], 'Provider endpoint required');
    if (config.remote.enabled && !config.remote.allow.length)
      issue(['remote', 'allow'], 'Remote allowlist required');
    if (config.remote.enabled && (!config.remote.projects.length || config.remote.authority))
      issue(['remote'], 'Select one remote authority mode and registered projects');
    if (config.remote.authority && !config.remote.authorityId)
      issue(['remote', 'authorityId'], 'Remote identity pin required');
    if (config.notifications.maxPending > config.notifications.maxReceipts)
      issue(['notifications', 'maxPending'], 'Notification pending capacity exceeds receipts');
  });
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function merge(base: unknown, update: unknown, depth = 0): unknown {
  if (depth > 10) throw new BosunError('invalid', 'Configuration nesting too deep');
  if (!object(base) || !object(update)) return update;
  const result: ObjectValue = { ...base };
  for (const [name, value] of Object.entries(update)) {
    if (['__proto__', 'prototype', 'constructor'].includes(name))
      throw new BosunError('invalid', 'Invalid configuration field');
    result[name] = Object.hasOwn(base, name) ? merge(base[name], value, depth + 1) : value;
  }
  return result;
}
const ENV_FIELDS = {
  BOSUN_PRIMARY_HOST: ['hosts', 'primary', 'text'],
  BOSUN_OMP_HOME: ['hosts', 'omp', 'home', 'text'],
  BOSUN_OPENCODE_URL: ['hosts', 'opencode', 'url', 'text'],
  BOSUN_CODEX_HOME: ['hosts', 'codex', 'home', 'text'],
  BOSUN_CLAUDE_HOME: ['hosts', 'claude', 'home', 'text'],
  BOSUN_ROUTER_MODEL: ['router', 'model', 'text'],
  BOSUN_ROUTER_URL: ['router', 'url', 'text'],
  BOSUN_ROUTER_TIMEOUT_MS: ['router', 'timeoutMs', 'number'],
  BOSUN_ROUTER_DIGEST: ['router', 'digest', 'text'],
  BOSUN_ROUTER_MIN_CONFIDENCE: ['router', 'minConfidence', 'number'],
  BOSUN_LOCAL_MODEL: ['local', 'model', 'text'],
  BOSUN_LOCAL_TIMEOUT_MS: ['local', 'timeoutMs', 'number'],
  BOSUN_LOCAL_CONTEXT_TOKENS: ['local', 'contextTokens', 'number'],
  BOSUN_HANDOFF_ENABLED: ['handoff', 'enabled', 'boolean'],
  BOSUN_HANDOFF_THRESHOLD: ['handoff', 'threshold', 'number'],
  BOSUN_HANDOFF_PROVIDER: ['handoff', 'provider', 'text'],
  BOSUN_GRAPH_ENABLED: ['graph', 'enabled', 'boolean'],
  BOSUN_GRAPH_EXTRACTION: ['graph', 'extraction', 'boolean'],
  BOSUN_GRAPH_PROVIDER: ['graph', 'provider', 'text'],
  BOSUN_CONSOLIDATION_ENABLED: ['graph', 'consolidation', 'schedule', 'enabled', 'boolean'],
  BOSUN_NOTIFICATIONS_ENABLED: ['notifications', 'enabled', 'boolean'],
  BOSUN_JOB_RETENTION_DAYS: ['daemon', 'jobRetentionDays', 'number'],
  BOSUN_DRAIN_MS: ['daemon', 'drainMs', 'number'],
  BOSUN_REMOTE_ENABLED: ['remote', 'enabled', 'boolean'],
  BOSUN_REMOTE_BIND: ['remote', 'bind', 'text'],
  BOSUN_REMOTE_PORT: ['remote', 'port', 'number'],
} as const;
function environment(env: Env): ObjectValue {
  const result: ObjectValue = {};
  function put(parts: readonly string[], value: unknown) {
    if (parts.some((part) => ['__proto__', 'prototype', 'constructor'].includes(part)))
      throw new BosunError('invalid', 'Invalid configuration field');
    let cursor = result;
    for (const part of parts.slice(0, -1)) {
      cursor[part] ??= {};
      cursor = cursor[part] as ObjectValue;
    }
    cursor[parts.at(-1)!] = value;
  }
  // Preserve explicitly selected native bindings from the documented old CLI.
  // These closed aliases precede canonical fields, so BOSUN_ROLE_* wins.
  for (const name of Object.keys(env)) {
    const role = name.match(
      /^ROLE_(ARCHITECT|SCOUT|WORKER|TESTER|DEBUGGER|REVIEWER)_(CODEX|CLAUDE)$/,
    );
    const operation = name.match(/^(WORKER_BY|REVIEW_BY)_(CODEX|CLAUDE)$/);
    const match = role ?? operation;
    if (!match) continue;
    const field = Object.getOwnPropertyDescriptor(env, name);
    if (!field || !Object.hasOwn(field, 'value') || typeof field.value !== 'string')
      throw new BosunError('invalid', `Invalid setting ${name}`);
    if (!field.value) continue;
    const parts = field.value.split(':');
    // biome-ignore lint/suspicious/noControlCharactersInRegex: reject whitespace and ASCII controls in legacy bindings.
    if (!parts[0] || parts.length > 2 || parts.some((part) => /\s|[\x00-\x1f\x7f]/.test(part)))
      throw new BosunError('invalid', `Invalid setting ${name}`);
    const selected = role
      ? role[1].toLowerCase()
      : match[1] === 'WORKER_BY'
        ? 'executor'
        : 'cross-reviewer';
    const host = match[2].toLowerCase();
    put(['roles', selected, host], {
      model: parts[0],
      ...(parts[1] ? { effort: parts[1] } : { effort: undefined }),
    });
  }
  for (const [name, route] of Object.entries(ENV_FIELDS)) {
    const value = env[name];
    if (value === undefined) continue;
    const kind = route.at(-1);
    let parsed: unknown = value;
    if (kind === 'boolean') {
      if (!['true', 'false'].includes(value))
        throw new BosunError('invalid', `Invalid setting ${name}`);
      parsed = value === 'true';
    }
    if (kind === 'number') {
      if (!value.trim()) throw new BosunError('invalid', `Invalid setting ${name}`);
      parsed = Number(value);
    }
    put(route.slice(0, -1), parsed);
  }
  for (const name of Object.keys(env)) {
    const match = name.match(
      /^BOSUN_ROLE_([A-Z][A-Z0-9_]*)_(OMP|OPENCODE|CODEX|CLAUDE)_(MODEL|EFFORT)$/,
    );
    // Inspect only declared settings. Enumerating values would read unrelated
    // authentication getters during metadata-only config/doctor/preview calls.
    if (match) {
      const selectedRole = match[1].toLowerCase().replaceAll('_', '-');
      if (['__proto__', 'prototype', 'constructor'].includes(selectedRole))
        throw new BosunError('invalid', 'Invalid configuration field');
      const value = env[name];
      if (value !== undefined)
        put(['roles', selectedRole, match[2].toLowerCase(), match[3].toLowerCase()], value);
    }
  }
  return result;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export function parseRuntimeConfig(toml: string, env: Env = {}): RuntimeConfig {
  if (Buffer.byteLength(toml) > 262144)
    throw new BosunError('invalid', 'Configuration file too large');
  let fields: unknown;
  try {
    fields = parse(toml);
  } catch {
    throw new BosunError('invalid', 'Invalid TOML configuration');
  }
  const parsed = configSchema.safeParse(merge(merge(defaultConfig(), fields), environment(env)));
  if (!parsed.success) {
    const field =
      parsed.error.issues[0]?.path
        .map((part) =>
          String(part)
            .replace(/[^a-zA-Z0-9_-]/g, '')
            .slice(0, 64),
        )
        .join('.') || 'root';
    throw new BosunError('invalid', `Invalid configuration at ${field}`);
  }
  return freeze(parsed.data);
}
export function loadRuntimeConfig(paths: RuntimePaths, env: Env): RuntimeConfig {
  let toml = '';
  try {
    toml = readPrivateFile(paths.config, 262144);
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT')
      throw new BosunError(
        error instanceof BosunError ? error.code : 'unavailable',
        'Configuration unavailable',
      );
  }
  return parseRuntimeConfig(toml, env);
}
export function renderRuntimeConfig(config: RuntimeConfig): string {
  const checked = configSchema.safeParse(config);
  if (!checked.success) throw new BosunError('invalid', 'Invalid configuration');
  return '# bosun configuration\n' + stringify(checked.data) + '\n';
}
export function saveRuntimeConfig(paths: RuntimePaths, config: RuntimeConfig): void {
  writePrivateFile(paths.config, renderRuntimeConfig(config));
}
function canonical(value: unknown): unknown {
  return Array.isArray(value)
    ? value.map(canonical)
    : object(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
}
export function configRevision(config: RuntimeConfig): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonical(config)))
    .digest('hex');
}
