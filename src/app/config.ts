import type { RuntimeConfig } from '../core/domain/config.ts';
import { BosunError } from '../core/errors.ts';
import { configRevision } from '../platform/config.ts';
import { parseHookConfig, type HookConfig } from '../platform/hook-config.ts';
import { writePrivateFile } from '../platform/private-file.ts';
import type { RuntimePaths } from '../platform/paths.ts';

export function publishHookConfig(
  config: RuntimeConfig,
  paths: RuntimePaths,
  binding: { sourceId: string | null; installationId?: string; now: number },
): HookConfig {
  const candidate: HookConfig = {
    schemaVersion: 1,
    configRevision: configRevision(config),
    generatedAt: binding.now,
    primaryHost: config.hosts.primary,
    socket: paths.socket,
    memory: {
      primary: paths.memory,
      view: paths.view,
      sourceId: binding.sourceId,
      linkedProjects: [...config.memory.linkedProjects],
      ...(config.remote.authority && config.remote.authorityId
        ? {
            remoteAuthorityId: config.remote.authorityId,
            ...(binding.installationId ? { remoteClientId: binding.installationId } : {}),
          }
        : {}),
    },
    context: {
      budgetTokens: config.context.hookBudgetTokens,
      minScore: config.context.hookMinScore,
      minMatched: config.context.hookMinTerms,
      itemChars: config.context.itemChars,
    },
  };
  let checked: HookConfig;
  try {
    checked = parseHookConfig(JSON.stringify(candidate), paths);
  } catch {
    throw new BosunError('invalid', 'Invalid hook configuration');
  }
  writePrivateFile(paths.hookConfig, JSON.stringify(checked) + '\n');
  return checked;
}
