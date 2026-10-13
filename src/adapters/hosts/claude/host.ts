import type {
  HostAdapter,
  HostBundle,
  HostSettings,
  FileChange,
} from '../../../core/ports/host.ts';
import path from 'node:path';
import { CLAUDE_VERSION } from './runner.ts';
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

const VERSIONS = [CLAUDE_VERSION];
function files(input: HostBundle, settings: HostSettings): FileChange[] {
  const bundle = hostBundle(input);
  hostSettings(settings, VERSIONS);
  return [
    ...sharedHostFiles(bundle),
    ...skillLinks(bundle),
    {
      op: 'write',
      path: '.claude-plugin/plugin.json',
      text:
        JSON.stringify(
          { name: 'bosun', description: 'Scoped bosun roles, skills and MCP.' },
          null,
          2,
        ) + '\n',
    },
    {
      op: 'write',
      path: '.mcp.json',
      text:
        JSON.stringify(
          {
            mcpServers: {
              bosun: {
                type: 'stdio',
                command: bundle.mcp.command,
                args: bundle.mcp.args,
                env: bundle.mcp.env,
              },
            },
          },
          null,
          2,
        ) + '\n',
    },
    ...bundle.roles.map((role) => ({
      op: 'write' as const,
      path: `agents/${nativeRole(role.id)}.md`,
      text: `---\nname: ${nativeRole(role.id)}\ndescription: ${JSON.stringify(role.description)}\n${role.model ? `model: ${JSON.stringify(role.model)}\n` : ''}${role.effort ? `effort: ${JSON.stringify(role.effort)}\n` : ''}${role.access === 'read' ? 'tools: Read, Grep, Glob\ndisallowedTools: Write, Edit, Bash, Agent, Task\n' : ''}---\n\n${rolePolicy(bundle, role.id)}`,
    })),
  ];
}
export function createClaudeHost(command = 'claude'): HostAdapter {
  return {
    id: 'claude',
    caps: {
      subagents: 'unverified',
      plugins: 'unverified',
      promptHook: 'unverified',
      hookTrust: 'unverified',
      mcpStdio: 'unverified',
      readsAgentsMd: 'unsupported',
      skillsDirs: ['.claude/skills'],
    },
    detect: (env) => installedHost(command, env),
    plan: async (bundle, settings) => files(bundle, settings),
    planUninstall: async (changes) => removeHostFiles(changes),
    doctor: async (bundle, settings) => profileDoctor(settings.root, files(bundle, settings)),
    launch: (_bundle, settings) => {
      hostSettings(settings, VERSIONS);
      return {
        args: [
          '--plugin-dir',
          settings.root,
          '--append-system-prompt-file',
          path.join(settings.root, 'shared', 'policy.md'),
        ],
        env: { BOSUN_CALLER: 'model' },
      };
    },
    roleRef: (id) => `bosun:${nativeRole(id)}`,
    session: (env) => ({
      active: !!env.CLAUDE_CODE_ENTRYPOINT,
      ...(env.CLAUDE_PROJECT_DIR ? { projectDir: env.CLAUDE_PROJECT_DIR } : {}),
    }),
    hook: {
      parse: nativePrompt,
      format: (context) =>
        JSON.stringify({
          hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context },
        }),
    },
  };
}
