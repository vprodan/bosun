import fs from 'node:fs';
import path from 'node:path';
import type { Env } from '../core/domain/inference.ts';
import { BosunError } from '../core/errors.ts';
import { WORKSPACE_LIMITS, workspaceText } from '../core/domain/workspace.ts';
import { streamProcess } from './process.ts';
import { project } from './project.ts';

const unavailable = () => new BosunError('unavailable', 'Git inspection unavailable');
export function gitDirectory(value: string): string {
  workspaceText(value);
  if (
    !path.isAbsolute(value) ||
    path.resolve(value) !== value ||
    fs.realpathSync(value) !== value ||
    !fs.statSync(value).isDirectory()
  )
    throw unavailable();
  return value;
}
// Explicit fixed calls from adapters only. No shell, inherited auth, global
// Git config, hooks, fsmonitor, attributes file or recursive submodules.
export function createOfflineGit(options: { env: Env; command?: string }) {
  function environment(): Env {
    const env: Record<string, string> = {};
    for (const key of ['HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL']) {
      const descriptor = Object.getOwnPropertyDescriptor(options.env, key);
      if (descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string')
        env[key] = descriptor.value;
    }
    Object.assign(env, {
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_ATTR_NOSYSTEM: '1',
      GIT_CONFIG_COUNT: '5',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: '/dev/null',
      GIT_CONFIG_KEY_1: 'core.fsmonitor',
      GIT_CONFIG_VALUE_1: 'false',
      GIT_CONFIG_KEY_2: 'submodule.recurse',
      GIT_CONFIG_VALUE_2: 'false',
      GIT_CONFIG_KEY_3: 'core.untrackedCache',
      GIT_CONFIG_VALUE_3: 'false',
      GIT_CONFIG_KEY_4: 'core.attributesFile',
      GIT_CONFIG_VALUE_4: '/dev/null',
    });
    return env;
  }
  async function run(cwd: string, args: string[], signal?: AbortSignal) {
    gitDirectory(cwd);
    const chunks: Buffer[] = [];
    let code: number | null = null;
    for await (const event of streamProcess({
      command: options.command ?? 'git',
      args,
      cwd,
      env: environment(),
      signal: signal ?? new AbortController().signal,
      timeoutMs: WORKSPACE_LIMITS.timeoutMs,
      killGraceMs: 100,
      maxOutputBytes: WORKSPACE_LIMITS.outputBytes,
      stdout: (bytes) => chunks.push(Buffer.from(bytes)),
    }))
      if (event.t === 'exit') code = event.code;
    if (code === null) throw unavailable();
    const bytes = Buffer.concat(chunks);
    return { code, bytes, text: bytes.toString('utf8') };
  }
  async function plainCheckout(cwd: string, signal?: AbortSignal) {
    // Status/diff can invoke clean/process filters too. Repeat this gate before
    // each content-reading operation, including after an owned worktree exists.
    const config = await run(
      cwd,
      [
        'config',
        '--null',
        '--local',
        '--includes',
        '--get-regexp',
        '^(filter\\..*\\.(clean|smudge|process)|core\\.(worktree|bare)|extensions\\..*)$',
      ],
      signal,
    );
    if (config.code !== 0 && config.code !== 1) throw unavailable();
    for (const field of config.text.split('\0').filter(Boolean)) {
      const newline = field.indexOf('\n');
      if (newline < 1) throw unavailable();
      const key = field.slice(0, newline),
        value = field.slice(newline + 1);
      if (
        (key === 'core.bare' && value === 'false') ||
        (key === 'extensions.objectformat' && value === 'sha256')
      )
        continue;
      throw new BosunError(
        'unsupported',
        'Repository filters or layout require manual configuration review',
      );
    }
  }
  async function repository(from: string, base = 'HEAD', signal?: AbortSignal) {
    gitDirectory(from);
    workspaceText(base, 200);
    if (
      !/^[A-Za-z0-9][A-Za-z0-9_./-]{0,199}$/.test(base) ||
      base.includes('..') ||
      base.includes('//')
    )
      throw new BosunError('invalid', 'Invalid workspace base');
    const identity = await run(
      from,
      ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'],
      signal,
    );
    const fields = identity.text.trimEnd().split('\n');
    if (identity.code !== 0 || fields.length !== 2) throw unavailable();
    const root = gitDirectory(fields[0]);
    const common = gitDirectory(fields[1]);
    const revision = await run(
      root,
      ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`],
      signal,
    );
    const head = revision.text.trim();
    if (revision.code !== 0 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head)) throw unavailable();
    return { root, common, head, projectId: project(root).id };
  }
  return { run, plainCheckout, repository };
}
