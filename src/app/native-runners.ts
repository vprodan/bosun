import { BosunError } from '../core/errors.ts';
import type { RuntimeConfig } from '../core/domain/config.ts';
import type { Env } from '../core/domain/inference.ts';
import type { AgentRunner } from '../core/ports/runner.ts';
import type { SupportedQuotaSource } from '../core/use-cases/quota.ts';

export type RunnerFactories = Readonly<Record<string, (signal: AbortSignal) => Promise<AgentRunner>>>;

// Building the registry does not import an adapter, inspect auth, probe a host,
// start a server or create a directory. Only the queued selection is loaded.
export function nativeRunners(config: RuntimeConfig, environment: Env): RunnerFactories {
  const result: Record<string, (signal: AbortSignal) => Promise<AgentRunner>> = {};
  const selected = (signal: AbortSignal) => { if (signal.aborted) throw new BosunError('cancelled', 'Runner selection cancelled'); };
  // Selected-host registry: static imports would evaluate unselected native integrations before admission.
  if (config.hosts.omp.enabled) result.omp = async signal => {
    selected(signal); const { createOmpRunner } = await import('../adapters/hosts/omp/runner.ts'); selected(signal);
    return createOmpRunner({ command: config.hosts.omp.command,
      env: { ...environment, ...(config.hosts.omp.home ? { PI_CODING_AGENT_DIR: config.hosts.omp.home } : {}) },
      timeoutMs: config.local.timeoutMs });
  };
  if (config.hosts.opencode.enabled) result.opencode = async signal => {
    selected(signal); const { createOpenCodeRunner } = await import('../adapters/hosts/opencode/runner.ts'); selected(signal);
    return createOpenCodeRunner({ url: config.hosts.opencode.url, username: config.hosts.opencode.username,
      passwordEnv: config.hosts.opencode.passwordEnv, env: environment, runTimeoutMs: config.local.timeoutMs });
  };
  if (config.hosts.codex.enabled) result.codex = async signal => {
    selected(signal); const { createCodexRunner } = await import('../adapters/hosts/codex/runner.ts'); selected(signal);
    return createCodexRunner({ command: config.hosts.codex.command,
      env: { ...environment, ...(config.hosts.codex.home ? { CODEX_HOME: config.hosts.codex.home } : {}) }, timeoutMs: config.local.timeoutMs });
  };
  if (config.hosts.claude.enabled) result.claude = async signal => {
    selected(signal); const { createClaudeRunner } = await import('../adapters/hosts/claude/runner.ts'); selected(signal);
    return createClaudeRunner({ command: config.hosts.claude.command,
      env: { ...environment, ...(config.hosts.claude.home ? { CLAUDE_CONFIG_DIR: config.hosts.claude.home } : {}) }, timeoutMs: config.local.timeoutMs });
  };
  for (const [name, profile] of Object.entries(config.acp)) if (profile.enabled) result[`acp-${name}`] = async signal => {
    selected(signal); const { createAcpRunner } = await import('../adapters/hosts/acp/runner.ts'); selected(signal);
    return createAcpRunner({ id: `acp-${name}`, profile, env: environment });
  };
  return Object.freeze(result);
}

export function nativeQuotaSources(config: RuntimeConfig, environment: Env, cwd: string): Readonly<Record<string, SupportedQuotaSource>> {
  const sources: Record<string, SupportedQuotaSource> = {};
  if (config.hosts.codex.enabled) sources.codex = {
    async read(selection, signal) {
      if (signal.aborted) throw new BosunError('cancelled', 'Quota refresh cancelled');
      const { createCodexQuotaSource } = await import('../adapters/hosts/codex/quota-source.ts');
      return createCodexQuotaSource({ cwd, command: config.hosts.codex.command, now: Date.now,
        env: { ...environment, ...(config.hosts.codex.home ? { CODEX_HOME: config.hosts.codex.home } : {}) },
        requestTimeoutMs: 3000, timeoutMs: 15000 }).read(selection, signal);
    },
  };
  return Object.freeze(sources);
}
