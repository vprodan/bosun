import { BosunError } from '../../core/errors.ts';
import type { Env } from '../../core/domain/inference.ts';
import { cardBinding, type CardBinding } from '../../core/domain/card.ts';
import { WATCH_LIMITS, terminalHandle } from '../../core/domain/watch.ts';
import type { WorkspaceWatch } from '../../core/ports/workspace.ts';
import { streamProcess } from '../../platform/process.ts';
import { createOrcaCard, selectedOrcaCommand } from './orca-card.ts';

const unavailable = () => new BosunError('unavailable', 'Orca terminal contract unavailable');
export function createOrcaWatch(options: {
  env: Env;
  command?: string;
  gitCommand?: string;
}): WorkspaceWatch {
  const command = options.command ?? selectedOrcaCommand(options.env);
  const cards = createOrcaCard({ ...options, command });
  const env: Record<string, string> = {};
  for (const key of ['HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'ORCA_DEV_REPO_ROOT']) {
    const descriptor = Object.getOwnPropertyDescriptor(options.env, key);
    if (descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string')
      env[key] = descriptor.value;
  }
  async function call(
    binding: CardBinding,
    args: string[],
    signal: AbortSignal,
    entered?: () => void,
  ) {
    const chunks: Buffer[] = [];
    let code: number | null = null;
    if (signal.aborted) throw unavailable();
    entered?.();
    for await (const event of streamProcess({
      command,
      args: [...args, '--json'],
      cwd: binding.root,
      env,
      signal,
      timeoutMs: WATCH_LIMITS.timeoutMs,
      killGraceMs: 100,
      maxOutputBytes: 131072,
      stdout: (chunk) => chunks.push(Buffer.from(chunk)),
    }))
      if (event.t === 'exit') code = event.code;
    const bytes = Buffer.concat(chunks),
      text = bytes.toString('utf8');
    if (code !== 0 || !Buffer.from(text).equals(bytes)) throw unavailable();
    try {
      const value = JSON.parse(text);
      if (value?.ok !== true || !value.result || typeof value.result !== 'object')
        throw unavailable();
      return value.result;
    } catch {
      throw unavailable();
    }
  }
  async function terminal(binding: CardBinding, handle: string, signal: AbortSignal) {
    const result = await call(
      binding,
      ['terminal', 'show', '--terminal', terminalHandle(handle)],
      signal,
    );
    const row = result.terminal;
    // Project paths alone cannot identify SSH/runtime hosts. Never keep preview, title or tool data.
    if (
      !row ||
      row.handle !== handle ||
      row.executionHostId !== 'local' ||
      row.worktreeId !== binding.id ||
      row.worktreePath !== binding.root ||
      typeof row.connected !== 'boolean' ||
      row.orphaned === true
    )
      throw unavailable();
    return row.connected ? ('connected' as const) : ('closed' as const);
  }
  return {
    async prepare(root, near, signal) {
      const current = await cards.current(root, signal);
      if (near !== null && (await terminal(current.binding, near, signal)) !== 'connected')
        throw unavailable();
      return current.binding;
    },
    async open(input, near, observer, signal, entered) {
      const binding = cardBinding(input);
      await cards.observe(binding, signal);
      if (near !== null && (await terminal(binding, near, signal)) !== 'connected')
        throw unavailable();
      const result = await call(
        binding,
        near === null
          ? [
              'terminal',
              'create',
              '--worktree',
              `identity:local|${binding.id}`,
              '--title',
              'bosun job observer',
              '--command',
              observer,
            ]
          : [
              'terminal',
              'split',
              '--terminal',
              near,
              '--direction',
              'horizontal',
              '--command',
              observer,
            ],
        signal,
        entered,
      );
      const handle = terminalHandle(near === null ? result.terminal?.handle : result.split?.handle);
      await cards.observe(binding, signal);
      await terminal(binding, handle, signal);
      return handle;
    },
    async observe(input, handle, signal) {
      const binding = cardBinding(input);
      await cards.observe(binding, signal);
      return terminal(binding, handle, signal);
    },
  };
}
