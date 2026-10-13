import { stringify } from 'smol-toml';
import path from 'node:path';
import { CODEX_VERSION } from './runner.ts';
import type {
  HostAdapter,
  HostBundle,
  HostSettings,
  FileChange,
} from '../../../core/ports/host.ts';
import {
  hostBundle,
  hostSettings,
  sharedHostFiles,
  skillLinks,
  rolePolicy,
  nativeRole,
  installedHost,
  profileDoctor,
  removeHostFiles,
  nativePrompt,
} from '../../../platform/host-files.ts';

const VERSIONS = [CODEX_VERSION];
function files(input: HostBundle, settings: HostSettings): FileChange[] {
  const bundle = hostBundle(input);
  hostSettings(settings, VERSIONS);
  return [
    ...sharedHostFiles(bundle),
    ...skillLinks(bundle),
    ...bundle.roles.map((role) => ({
      op: 'write' as const,
      path: `agents/${nativeRole(role.id)}.toml`,
      text:
        stringify({
          developer_instructions: rolePolicy(bundle, role.id),
          ...(role.model ? { model: role.model } : {}),
          ...(role.effort ? { model_reasoning_effort: role.effort } : {}),
          ...(role.access === 'read' ? { sandbox_mode: 'read-only' } : {}),
        }) + '\n',
    })),
  ];
}
export function createCodexHost(command = 'codex'): HostAdapter {
  return {
    id: 'codex',
    caps: {
      subagents: 'unverified',
      plugins: 'unverified',
      promptHook: 'unverified',
      hookTrust: 'unverified',
      mcpStdio: 'unverified',
      readsAgentsMd: 'unverified',
      skillsDirs: ['.agents/skills'],
    },
    detect: (env) => installedHost(command, env),
    plan: async (bundle, settings) => files(bundle, settings),
    planUninstall: async (changes) => removeHostFiles(changes),
    doctor: async (bundle, settings) => profileDoctor(settings.root, files(bundle, settings)),
    launch: (input, settings) => {
      const bundle = hostBundle(input);
      hostSettings(settings, VERSIONS);
      const args: string[] = [];
      const add = (key: string, value: unknown) =>
        args.push('-c', `${key}=${JSON.stringify(value)}`);
      for (const role of bundle.roles) {
        const name = nativeRole(role.id);
        add(`agents.${name}.description`, role.description);
        add(`agents.${name}.config_file`, path.join(settings.root, 'agents', `${name}.toml`));
      }
      add('mcp_servers.bosun.command', bundle.mcp.command);
      add('mcp_servers.bosun.args', bundle.mcp.args);
      for (const [key, value] of Object.entries(bundle.mcp.env))
        add(`mcp_servers.bosun.env.${key}`, value);
      return { args, env: { BOSUN_CALLER: 'model' } };
    },
    roleRef: nativeRole,
    session: (env) => ({
      active: !!env.CODEX_THREAD_ID,
      ...(env.CODEX_THREAD_ID ? { sessionId: env.CODEX_THREAD_ID } : {}),
    }),
    hook: { parse: nativePrompt, format: (context) => context },
  };
}
