import type { HostAdapter, HostBundle, HostSettings, FileChange } from '../../../core/ports/host.ts';
import path from 'node:path';
import { BosunError } from '../../../core/errors.ts';
import {
  hostBundle, hostSettings, sharedHostFiles, skillLinks, installedHost,
  profileDoctor, removeHostFiles, HOST_FILES_LIMITS,
} from '../../../platform/host-files.ts';
import { OMP_VERSION } from './protocol.ts';
import { ompRoleRef, renderOmpRole } from './roles.ts';
import { parseOmpPrompt, formatOmpContext, renderOmpHookExtension } from './hook-extension.ts';

function files(input: HostBundle, settings: HostSettings): FileChange[] {
  const bundle = hostBundle(input);
  hostSettings(settings, [OMP_VERSION]);
  const changes: FileChange[] = [
    ...sharedHostFiles(bundle),
    ...skillLinks(bundle),
    { op: 'write', path: 'index.ts', text: renderOmpHookExtension(bundle) },
    {
      op: 'write', path: '.mcp.json',
      text: JSON.stringify({ mcpServers: { bosun: {
        type: 'stdio', command: bundle.mcp.command, args: bundle.mcp.args,
        env: bundle.mcp.env, timeout: 30000, instructions: false,
      } } }, null, 2) + '\n',
    },
    ...bundle.roles.map(role => ({
      op: 'write' as const, path: `agents/${ompRoleRef(role.id)}.md`, text: renderOmpRole(bundle, role),
    })),
  ];
  let bytes = 0;
  for (const change of changes) {
    if (change.op !== 'write') continue;
    const size = Buffer.byteLength(change.text);
    if (size > HOST_FILES_LIMITS.fileBytes)
      throw new BosunError('invalid', 'OMP profile file exceeds the owned bound');
    bytes += size;
  }
  if (changes.length > HOST_FILES_LIMITS.files || bytes > HOST_FILES_LIMITS.totalBytes)
    throw new BosunError('invalid', 'OMP profile exceeds the owned bound');
  return changes;
}
function owned(changes: readonly FileChange[]): readonly FileChange[] {
  if (!Array.isArray(changes) || changes.length > HOST_FILES_LIMITS.files)
    throw new BosunError('invalid', 'Invalid OMP ownership manifest');
  const seen = new Set<string>();
  for (const change of changes) {
    if (!change || typeof change.path !== 'string' || seen.has(change.path) ||
        !['write', 'link'].includes(change.op) ||
        !(change.path === 'index.ts' || change.path === '.mcp.json' ||
          change.path === 'shared/policy.md' ||
          /^agents\/bosun_[a-z][a-z0-9_]{0,39}\.md$/.test(change.path) ||
          /^(?:shared\/skills\/bosun-[a-z][a-z0-9-]*\/SKILL\.md|skills\/bosun-[a-z][a-z0-9-]*)$/.test(change.path)))
      throw new BosunError('invalid', 'OMP removal is outside the owned profile');
    if (change.op === 'link' &&
        (!/^skills\/bosun-[a-z][a-z0-9-]*$/.test(change.path) ||
          change.target !== `../shared/skills/${path.basename(change.path)}`))
      throw new BosunError('invalid', 'OMP removal has an invalid owned link');
    if (change.op === 'write' && change.path.startsWith('skills/'))
      throw new BosunError('invalid', 'OMP removal has an invalid owned file');
    seen.add(change.path);
  }
  return changes;
}
export function createOmpHost(command = 'omp'): HostAdapter {
  return {
    id: 'omp',
    caps: {
      subagents: 'unverified', plugins: 'unverified', promptHook: 'unverified',
      hookTrust: 'unverified', mcpStdio: 'unverified', readsAgentsMd: 'unverified',
      skillsDirs: ['.omp/skills', '.agents/skills'],
    },
    detect: env => installedHost(command, env),
    plan: async (bundle, settings) => files(bundle, settings),
    planUninstall: async changes => removeHostFiles(owned(changes)),
    doctor: async (bundle, settings) => profileDoctor(settings.root, files(bundle, settings)),
    launch: (bundle, settings) => {
      // Validate the complete recipe before returning launch effects. Detection,
      // planning and construction never invoke the host or mutate native homes.
      files(bundle, settings);
      return {
        args: ['--no-extensions', '--extension', settings.root,
          '--append-system-prompt', path.join(settings.root, 'shared', 'policy.md')],
        env: { BOSUN_CALLER: 'model' },
      };
    },
    roleRef: ompRoleRef,
    session: env => {
      // These are published by the owned extension from native getSessionId/cwd,
      // not guessed from configuration paths or an ambient host executable.
      const id = env.BOSUN_OMP_SESSION_ID;
      const cwd = env.BOSUN_OMP_PROJECT_DIR;
      return {
        active: typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id),
        ...(typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id) ? { sessionId: id } : {}),
        ...(typeof cwd === 'string' && path.isAbsolute(cwd) && path.resolve(cwd) === cwd &&
          !/[\x00-\x1f\x7f]/.test(cwd) ? { projectDir: cwd } : {}),
      };
    },
    hook: { parse: parseOmpPrompt, format: formatOmpContext },
  };
}
