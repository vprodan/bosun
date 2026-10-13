import { BosunError } from '../core/errors.ts';
import { HOSTS } from '../core/domain/config.ts';
import type { HostId } from '../core/domain/config.ts';
import type { RuntimePaths } from './paths.ts';
import { readPrivateFile } from './private-file.ts';

export type HookConfig = {
  schemaVersion: 1;
  configRevision: string;
  generatedAt: number;
  primaryHost: HostId;
  socket: string;
  memory: {
    primary: string;
    view: string;
    sourceId: string | null;
    linkedProjects: string[];
    remoteAuthorityId?: string;
    remoteClientId?: string;
  };
  context: { budgetTokens: number; minScore: number; minMatched: number; itemChars: number };
};
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new BosunError('invalid', 'Invalid hook configuration');
  return value as Record<string, unknown>;
}
const integer = (value: unknown, max: number): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max;
// Lean validation of the generated projection; no TOML, Zod, adapter registry or writes.
export function parseHookConfig(text: string, paths: RuntimePaths): HookConfig {
  try {
    const value = object(JSON.parse(text), [
      'schemaVersion',
      'configRevision',
      'generatedAt',
      'primaryHost',
      'socket',
      'memory',
      'context',
    ]);
    const memory = object(value.memory, [
      'primary',
      'view',
      'sourceId',
      'linkedProjects',
      ...(value.memory &&
      typeof value.memory === 'object' &&
      Object.hasOwn(value.memory, 'remoteAuthorityId')
        ? ['remoteAuthorityId']
        : []),
      ...(value.memory &&
      typeof value.memory === 'object' &&
      Object.hasOwn(value.memory, 'remoteClientId')
        ? ['remoteClientId']
        : []),
    ]);
    if (
      memory.remoteAuthorityId !== undefined &&
      (typeof memory.remoteAuthorityId !== 'string' ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
          memory.remoteAuthorityId,
        ))
    )
      throw 0;
    if (
      memory.remoteClientId !== undefined &&
      (!memory.remoteAuthorityId ||
        typeof memory.remoteClientId !== 'string' ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
          memory.remoteClientId,
        ))
    )
      throw 0;
    const context = object(value.context, ['budgetTokens', 'minScore', 'minMatched', 'itemChars']);
    if (
      value.schemaVersion !== 1 ||
      typeof value.configRevision !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.configRevision) ||
      !integer(value.generatedAt, 8640000000000000) ||
      !HOSTS.includes(value.primaryHost as HostId) ||
      value.socket !== paths.socket ||
      memory.primary !== paths.memory ||
      memory.view !== paths.view ||
      (memory.sourceId !== null &&
        (typeof memory.sourceId !== 'string' ||
          !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
            memory.sourceId,
          ))) ||
      !Array.isArray(memory.linkedProjects) ||
      memory.linkedProjects.length > 100 ||
      memory.linkedProjects.some((id) => typeof id !== 'string' || !/^p_[a-f0-9]{16}$/.test(id)) ||
      !integer(context.budgetTokens, 4000) ||
      !integer(context.minMatched, 20) ||
      !integer(context.itemChars, 4000) ||
      Number(context.itemChars) < 1 ||
      typeof context.minScore !== 'number' ||
      !Number.isFinite(context.minScore) ||
      context.minScore < 0 ||
      context.minScore > 10
    )
      throw 0;
    const snapshot: HookConfig = {
      schemaVersion: 1,
      configRevision: value.configRevision,
      generatedAt: Number(value.generatedAt),
      primaryHost: value.primaryHost as HostId,
      socket: paths.socket,
      memory: {
        primary: paths.memory,
        view: paths.view,
        sourceId: memory.sourceId as string | null,
        linkedProjects: [...memory.linkedProjects],
        ...(memory.remoteAuthorityId
          ? { remoteAuthorityId: memory.remoteAuthorityId as string }
          : {}),
        ...(memory.remoteClientId ? { remoteClientId: memory.remoteClientId as string } : {}),
      },
      context: {
        budgetTokens: Number(context.budgetTokens),
        minScore: context.minScore,
        minMatched: Number(context.minMatched),
        itemChars: Number(context.itemChars),
      },
    };
    Object.freeze(snapshot.memory.linkedProjects);
    Object.freeze(snapshot.memory);
    Object.freeze(snapshot.context);
    return Object.freeze(snapshot);
  } catch {
    throw new BosunError('unavailable', 'Hook configuration unavailable');
  }
}
export function loadHookConfig(paths: RuntimePaths): HookConfig | null {
  try {
    return parseHookConfig(readPrivateFile(paths.hookConfig, 16384), paths);
  } catch {
    return null;
  } // Hook omits context until administrative initialization/reload; no file creation.
}
