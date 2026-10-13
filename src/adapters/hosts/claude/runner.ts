import path from 'node:path';
import { BosunError } from '../../../core/errors.ts';
import { requirePublicInput } from '../../../core/policy.ts';
import { screenPublicText } from '../../../core/secret-screen.ts';
import type { Detect, Env } from '../../../core/domain/inference.ts';
import { sameNativeMajor } from '../../../core/domain/host-version.ts';
import type { AgentRunner, RunEvent, RunSpec } from '../../../core/ports/runner.ts';
import { executable, streamProcess } from '../../../platform/process.ts';

export const CLAUDE_VERSION = '2.1.292';
export type ClaudeRunnerOptions = {
  env: Env;
  command?: string;
  timeoutMs?: number;
  killGraceMs?: number;
};
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max = 65536): value is string =>
  typeof value === 'string' && !value.includes('\0') && Buffer.byteLength(value) <= max;
const integer = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const unavailable = () =>
  new BosunError('unavailable', 'Claude execution unavailable', {
    details: { outcome: 'unknown' },
  });
function selectedModel(requested: string, actual: unknown): actual is string {
  if (!text(actual, 256) || !actual) return false;
  // Native aliases resolve inside Claude, including user-configured providers.
  // Literal model IDs must match exactly; aliases may resolve only in their family.
  return (
    actual === requested ||
    (['opus', 'sonnet', 'haiku', 'fable'].includes(requested) &&
      new RegExp(`^(?:anthropic\\.)?claude-${requested}-`).test(actual))
  );
}

// Native auth stays in the selected Claude process. Restricted mode confines
// built-in file tools to cwd; the explicit tools and MCP deny rule constrain
// model actions. This is a tool allowlist, not an OS or managed-policy sandbox.
export function createClaudeRunner(options: ClaudeRunnerOptions): AgentRunner {
  const caps: AgentRunner['caps'] = Object.freeze({
    vendor: 'anthropic',
    readOnly: 'verified',
    sandbox: 'tool-allowlist',
    mcpInject: 'unsupported',
    effort: 'verified',
    localBackend: 'unverified',
    billing: 'unknown',
  });
  async function detect(env: Env): Promise<Detect> {
    const command = executable(options.command ?? 'claude', env);
    if (!command) return { installed: false };
    let output = '';
    let code: number | null = null;
    try {
      if (!env.HOME || !path.isAbsolute(env.HOME))
        return { installed: true, path: command, notes: ['version_unverified'] };
      for await (const event of streamProcess({
        command,
        args: ['--version'],
        cwd: env.HOME,
        env,
        signal: new AbortController().signal,
        timeoutMs: 3000,
        maxOutputBytes: 4096,
        maxLineBytes: 1024,
      })) {
        if (event.t === 'line') output += event.text + '\n';
        else code = event.code;
      }
      const version =
        code === 0 ? /^([0-9]+\.[0-9]+\.[0-9]+) \(Claude Code\)\s*$/.exec(output)?.[1] : undefined;
      return {
        installed: true,
        path: command,
        ...(version ? { version } : { notes: ['version_unverified'] }),
      };
    } catch {
      return { installed: true, path: command, notes: ['version_unverified'] };
    }
  }
  return {
    id: 'claude',
    caps,
    detect,
    async *run(spec: RunSpec): AsyncGenerator<RunEvent> {
      requirePublicInput(spec);
      if (spec.access !== 'read' && spec.access !== 'edit')
        throw new BosunError('invalid', 'Invalid Claude access');
      if (spec.mcp?.length || (spec.env && Object.keys(spec.env).length))
        throw new BosunError('unsupported', 'Claude execution option unsupported');
      if (
        !text(spec.cwd, 4096) ||
        !path.isAbsolute(spec.cwd) ||
        !text(spec.model, 256) ||
        !spec.model ||
        /\s/.test(spec.model) ||
        spec.model.startsWith('-') ||
        (spec.effort !== undefined &&
          !['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'].includes(spec.effort)) ||
        (spec.maxTurns !== undefined &&
          (!Number.isSafeInteger(spec.maxTurns) || spec.maxTurns < 1 || spec.maxTurns > 256)) ||
        !text(spec.prompt, 32768) ||
        !spec.prompt.trim()
      )
        throw new BosunError('invalid', 'Invalid Claude request');
      screenPublicText(spec.prompt);
      if (spec.signal.aborted) throw new BosunError('cancelled', 'Claude execution cancelled');
      const env: Record<string, string | undefined> = {
        ...options.env,
        BOSUN_DEPTH: '1',
        BOSUN_CALLER: 'model',
        CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      };
      delete env.CLAUDECODE;
      delete env.CLAUDE_EFFORT;
      delete env.CLAUDE_CODE_MESSAGING_SOCKET;
      const detected = await detect(env);
      if (!detected.installed) throw new BosunError('unavailable', 'Claude executable unavailable');
      if (!sameNativeMajor(detected.version, CLAUDE_VERSION))
        throw new BosunError('unverified', 'Claude version unverified');
      const tools =
        spec.access === 'read'
          ? ['Read', 'Glob', 'Grep']
          : ['Read', 'Glob', 'Grep', 'Edit', 'Write'];
      const allowed = new Set([...tools, 'EndConversation']);
      const args = [
        '-p',
        '--restricted',
        '--safe-mode',
        '--no-chrome',
        '--no-session-persistence',
        '--permission-mode',
        'dontAsk',
        '--permission-prompts',
        'none',
        '--tools',
        tools.join(','),
        '--allowedTools',
        tools.join(','),
        '--disallowedTools',
        'mcp__*',
        '--strict-mcp-config',
        '--mcp-config',
        '{"mcpServers":{}}',
        '--settings',
        JSON.stringify({ disableAllHooks: true, fallbackModel: [], switchModelsOnFlag: false }),
        '--output-format',
        'stream-json',
        '--verbose',
        '--model',
        spec.model,
      ];
      if (spec.effort !== undefined) args.push('--effort', spec.effort);
      if (spec.maxTurns !== undefined) args.push('--max-turns', String(spec.maxTurns));
      let initialized = false;
      let session = '';
      let model = '';
      let completed = false;
      let result = '';
      let count = 0;
      try {
        for await (const event of streamProcess({
          command: detected.path!,
          args,
          cwd: spec.cwd,
          env,
          input: spec.prompt,
          signal: spec.signal,
          timeoutMs: options.timeoutMs,
          killGraceMs: options.killGraceMs,
        })) {
          if (event.t === 'exit') {
            if (event.code !== 0 || event.signal !== null || !completed) throw unavailable();
            yield { t: 'done', code: 0, result };
            continue;
          }
          if (++count > 2048) throw unavailable();
          let row: unknown;
          try {
            row = JSON.parse(event.text);
          } catch {
            throw unavailable();
          }
          if (!object(row) || typeof row.type !== 'string' || completed) throw unavailable();
          if (row.type === 'system' && row.subtype === 'init') {
            if (
              initialized ||
              !text(row.session_id, 256) ||
              !row.session_id ||
              row.cwd !== spec.cwd ||
              row.permissionMode !== 'dontAsk' ||
              !selectedModel(spec.model, row.model) ||
              !Array.isArray(row.tools) ||
              row.tools.length > 32 ||
              row.tools.some((tool) => typeof tool !== 'string' || !allowed.has(tool)) ||
              !Array.isArray(row.mcp_servers) ||
              row.mcp_servers.length
            )
              throw unavailable();
            initialized = true;
            session = row.session_id;
            model = row.model;
            continue;
          }
          if (!initialized || row.session_id !== session) throw unavailable();
          switch (row.type) {
            case 'assistant': {
              if (
                !object(row.message) ||
                row.message.model !== model ||
                !Array.isArray(row.message.content) ||
                row.message.content.length > 256
              )
                throw unavailable();
              for (const part of row.message.content) {
                if (!object(part) || typeof part.type !== 'string') throw unavailable();
                if (part.type === 'text') {
                  if (!text(part.text)) throw unavailable();
                  yield { t: 'text', text: part.text };
                } else if (part.type === 'tool_use') {
                  if (typeof part.name !== 'string' || !allowed.has(part.name)) throw unavailable();
                  yield { t: 'tool', name: part.name };
                } else if (!['thinking', 'redacted_thinking'].includes(part.type))
                  throw unavailable();
              }
              break;
            }
            case 'user':
              break; // tool results are never projected or logged
            case 'result': {
              if (
                row.subtype !== 'success' ||
                row.is_error !== false ||
                !text(row.result) ||
                !object(row.usage) ||
                !integer(row.usage.input_tokens) ||
                !integer(row.usage.output_tokens) ||
                !object(row.modelUsage) ||
                !Object.hasOwn(row.modelUsage, model) ||
                Object.keys(row.modelUsage).some((name) => name !== model)
              )
                throw unavailable();
              result = row.result;
              completed = true;
              yield {
                t: 'usage',
                tokensIn: row.usage.input_tokens,
                tokensOut: row.usage.output_tokens,
              };
              break;
            }
            default:
              throw unavailable();
          }
        }
      } catch (error) {
        if (
          error instanceof BosunError &&
          (error.code === 'cancelled' || error.code === 'timeout')
        ) {
          throw new BosunError(
            error.code,
            error.code === 'cancelled'
              ? 'Claude execution cancelled'
              : 'Claude execution timed out',
            { details: { outcome: 'unknown' } },
          );
        }
        throw unavailable();
      }
    },
  };
}
