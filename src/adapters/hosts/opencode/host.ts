import type {
  HostAdapter,
  HostBundle,
  HostSettings,
  FileChange,
} from '../../../core/ports/host.ts';
import path from 'node:path';
import { BosunError } from '../../../core/errors.ts';
import { OPENCODE2_VERSION } from '../../../core/domain/host-install.ts';
import { renderOpenCodeHookPlugin } from './hook-plugin.ts';
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

const VERSIONS = [OPENCODE2_VERSION];
function files(input: HostBundle, settings: HostSettings): FileChange[] {
  const bundle = hostBundle(input);
  hostSettings(settings, VERSIONS);
  const agents = Object.fromEntries(bundle.roles.map(role => {
    if (role.effort && !role.model || role.model && !/^[^/#]+\/[^#]+$/.test(role.model))
      throw new BosunError('unsupported', 'OpenCode 2 roles require an exact provider/model with a separate variant');
    const slash = role.model?.indexOf('/') ?? -1;
    return [nativeRole(role.id), {
      description: role.description,
      mode: 'subagent',
      system: rolePolicy(bundle, role.id),
      ...(role.model ? { model: { providerID: role.model.slice(0, slash),
        model: role.model.slice(slash + 1), ...(role.effort ? { variant: role.effort } : {}) } } : {}),
      permissions: [
        ...(role.access === 'read' ? [
          { action: '*', resource: '*', effect: 'deny' },
          ...['read', 'glob', 'grep'].map(action => ({ action, resource: '*', effect: 'allow' })),
          ...['bosun_memory_search', 'bosun_context_retrieve', 'bosun_project_knowledge_search']
            .map(action => ({ action, resource: '*', effect: 'ask' })),
        ] : []),
        { action: 'subagent', resource: '*', effect: 'deny' },
      ],
    }];
  }));
  return [
    ...sharedHostFiles(bundle),
    ...skillLinks(bundle),
    { op: 'write', path: 'plugin/index.ts', text: renderOpenCodeHookPlugin(bundle) },
    {
      op: 'write',
      path: 'opencode.json',
      text:
        JSON.stringify(
          {
            $schema: 'https://opencode.ai/config.json',
            agents,
            instructions: [path.join(settings.root, 'shared', 'policy.md')],
            skills: [path.join(settings.root, 'shared', 'skills')],
            plugins: [path.join(settings.root, 'plugin')],
            mcp: { servers: { bosun: {
              type: 'local',
              command: [bundle.mcp.command, ...bundle.mcp.args],
              environment: bundle.mcp.env,
              disabled: false,
              codemode: false,
            } } },
          },
          null,
          2,
        ) + '\n',
    },
  ];
}
export function createOpenCodeHost(command = 'opencode2'): HostAdapter {
  return {
    id: 'opencode',
    caps: {
      subagents: 'unverified',
      plugins: 'unverified',
      promptHook: 'unverified',
      hookTrust: 'unverified',
      mcpStdio: 'unverified',
      readsAgentsMd: 'unverified',
      skillsDirs: ['.agents/skills', '.opencode/skills'],
    },
    detect: (env) => installedHost(command, env),
    plan: async (bundle, settings) => files(bundle, settings),
    planUninstall: async (changes) => removeHostFiles(changes),
    doctor: async (bundle, settings) => profileDoctor(settings.root, files(bundle, settings)),
    launch: (bundle, settings) => {
      const changes = files(bundle, settings);
      const config = changes.find(change => change.op === 'write' && change.path === 'opencode.json');
      if (!config || config.op !== 'write') throw new BosunError('invalid', 'OpenCode 2 profile unavailable');
      return {
        // The default V2 TUI can reuse a background service with different
        // configuration. A standalone child inherits this exact owned overlay.
        args: ['--standalone'],
        env: { OPENCODE_CONFIG: path.join(settings.root, 'opencode.json'),
          OPENCODE_CONFIG_CONTENT: config.text, BOSUN_CALLER: 'model' },
      };
    },
    roleRef: nativeRole,
    session: (env) => ({
      active: !!env.OPENCODE_SESSION_ID,
      ...(env.OPENCODE_PROJECT_DIR ? { projectDir: env.OPENCODE_PROJECT_DIR } : {}),
      ...(env.OPENCODE_SESSION_ID ? { sessionId: env.OPENCODE_SESSION_ID } : {}),
    }),
    hook: { parse: nativePrompt, format: (context) => context },
  };
}
