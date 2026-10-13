import crypto from 'node:crypto';
import path from 'node:path';
import { BosunError } from '../../core/errors.ts';
import type { Env } from '../../core/domain/inference.ts';
import {
  CARD_LIMITS,
  cardBinding,
  cardStatus,
  type CardBinding,
  type CardObservation,
} from '../../core/domain/card.ts';
import type { WorkspaceCard } from '../../core/ports/workspace.ts';
import { streamProcess } from '../../platform/process.ts';
import { gitDirectory, createOfflineGit } from '../../platform/git.ts';

// Source-inspected CLI contract, not live app/terminal qualification. See protocol provenance.
export const ORCA_CARD_VERSION = '1.4.222';
const unavailable = () => new BosunError('unavailable', 'Orca card contract unavailable');
const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
export function selectedOrcaCommand(env: Env, platform = process.platform): string {
  const command =
    env.ORCA_CLI_COMMAND ||
    (env.ORCA_DEV_REPO_ROOT
      ? 'orca-dev'
      : platform === 'linux' && !env.ORCA_TERMINAL_HANDLE
        ? 'orca-ide'
        : 'orca');
  if (
    typeof command !== 'string' ||
    !command ||
    /[\x00-\x1f\x7f]/.test(command) ||
    (command.includes(' ') && !path.isAbsolute(command))
  )
    throw unavailable();
  return command;
}
export function createOrcaCard(options: {
  env: Env;
  command?: string;
  gitCommand?: string;
}): WorkspaceCard {
  const env: Record<string, string> = {};
  for (const key of ['HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'ORCA_DEV_REPO_ROOT']) {
    const descriptor = Object.getOwnPropertyDescriptor(options.env, key);
    if (descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string')
      env[key] = descriptor.value;
  }
  const command = options.command ?? selectedOrcaCommand(options.env);
  const git = createOfflineGit({
    env: options.env,
    command: options.gitCommand,
  });
  async function call(from: string, args: string[], signal: AbortSignal): Promise<string> {
    const chunks: Buffer[] = [];
    let code: number | null = null;
    for await (const event of streamProcess({
      command,
      args,
      cwd: gitDirectory(from),
      env,
      signal,
      timeoutMs: CARD_LIMITS.timeoutMs,
      killGraceMs: 100,
      maxOutputBytes: CARD_LIMITS.outputBytes,
      stdout: (chunk) => chunks.push(Buffer.from(chunk)),
    }))
      if (event.t === 'exit') code = event.code;
    if (code !== 0) throw unavailable();
    const bytes = Buffer.concat(chunks);
    const text = bytes.toString('utf8');
    if (!Buffer.from(text).equals(bytes)) throw unavailable();
    return text;
  }
  async function version(from: string, signal: AbortSignal) {
    if ((await call(from, ['--version'], signal)).trim() !== ORCA_CARD_VERSION)
      throw new BosunError('unsupported', 'Unqualified Orca CLI version');
  }
  async function observation(
    from: string,
    args: string[],
    signal: AbortSignal,
  ): Promise<CardObservation> {
    const source = await git.repository(from, undefined, signal);
    let response: any;
    try {
      response = JSON.parse(await call(source.root, [...args, '--json'], signal));
    } catch {
      throw unavailable();
    }
    const row = response?.ok === true && response.result?.worktree;
    // Missing host identity is unknown; identical path strings on SSH/runtime hosts are not local identity.
    if (
      !row ||
      row.hostId !== 'local' ||
      typeof row.id !== 'string' ||
      row.path !== source.root ||
      row.repoId === undefined ||
      row.id !== `${row.repoId}::${source.root}` ||
      (row.comment !== undefined && typeof row.comment !== 'string') ||
      (row.workspaceStatus !== undefined && typeof row.workspaceStatus !== 'string')
    )
      throw unavailable();
    return Object.freeze({
      binding: cardBinding({
        id: row.id,
        root: source.root,
        common: source.common,
        projectId: source.projectId,
        hostId: 'local',
        cliVersion: ORCA_CARD_VERSION,
      }),
      status: row.workspaceStatus ?? null,
      commentHash: hash(row.comment ?? ''),
    });
  }
  function same(actual: CardObservation, expected: CardBinding) {
    if (JSON.stringify(actual.binding) !== JSON.stringify(cardBinding(expected)))
      throw new BosunError('conflict', 'Orca worktree identity changed');
    return actual;
  }
  const selector = (binding: CardBinding) => `identity:local|${binding.id}`;
  return {
    async current(from, signal) {
      await version(from, signal);
      return observation(from, ['worktree', 'current'], signal);
    },
    async observe(input, signal) {
      const binding = cardBinding(input);
      await version(binding.root, signal);
      return same(
        await observation(
          binding.root,
          ['worktree', 'show', '--worktree', selector(binding)],
          signal,
        ),
        binding,
      );
    },
    async update(input, status, comment, signal) {
      const binding = cardBinding(input);
      cardStatus(status);
      await version(binding.root, signal);
      same(
        await observation(
          binding.root,
          ['worktree', 'show', '--worktree', selector(binding)],
          signal,
        ),
        binding,
      );
      return same(
        await observation(
          binding.root,
          [
            'worktree',
            'set',
            '--worktree',
            selector(binding),
            '--workspace-status',
            status,
            ...(comment === undefined ? [] : ['--comment', comment]),
          ],
          signal,
        ),
        binding,
      );
    },
  };
}
