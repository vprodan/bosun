import path from 'node:path';
import { BosunError } from '../../../core/errors.ts';
import { requirePublicInput } from '../../../core/policy.ts';
import { screenPublicText } from '../../../core/secret-screen.ts';
import type { Detect, Env } from '../../../core/domain/inference.ts';
import type { AgentRunner, RunEvent, RunSpec } from '../../../core/ports/runner.ts';
import { executable, streamProcess } from '../../../platform/process.ts';

export const CODEX_VERSION = '0.161.0';
export type CodexRunnerOptions = {
  env: Env; command?: string; timeoutMs?: number; killGraceMs?: number;
};
const unavailable = () => new BosunError('unavailable', 'Codex execution unavailable', { details: { outcome: 'unknown' } });
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function text(value: unknown, max = 65536): value is string {
  return typeof value === 'string' && !value.includes('\0') && Buffer.byteLength(value) <= max;
}
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0; }

// Native credentials and provider configuration stay with Codex. Bosun neither
// imports tokens into another host nor replaces the selected native provider.
// An OS sandbox alone cannot constrain configured MCP/apps/plugin effects, so
// read jobs remain held until a managed native tool policy is qualified.
export function createCodexRunner(options: CodexRunnerOptions): AgentRunner {
  const caps: AgentRunner['caps'] = Object.freeze({ vendor: 'openai', readOnly: 'unverified', sandbox: 'os',
    mcpInject: 'unsupported', effort: 'verified', localBackend: 'unverified', billing: 'unknown' });
  async function detect(env: Env): Promise<Detect> {
    const command = executable(options.command ?? 'codex', env);
    if (!command) return { installed: false };
    let output = ''; let code: number | null = null;
    try {
      if (!env.HOME || !path.isAbsolute(env.HOME)) return { installed: true, path: command, notes: ['version_unverified'] };
      for await (const event of streamProcess({ command, args: ['--version'], cwd: env.HOME, env,
        signal: new AbortController().signal, timeoutMs: 3000, maxOutputBytes: 4096, maxLineBytes: 1024 })) {
        if (event.t === 'line') output += event.text + '\n'; else code = event.code;
      }
      const version = code === 0 ? /^codex-cli ([0-9]+\.[0-9]+\.[0-9]+)\s*$/.exec(output)?.[1] : undefined;
      return { installed: true, path: command, ...(version ? { version } : { notes: ['version_unverified'] }) };
    } catch { return { installed: true, path: command, notes: ['version_unverified'] }; }
  }
  return {
    id: 'codex', caps, detect,
    async *run(spec: RunSpec): AsyncGenerator<RunEvent> {
      requirePublicInput(spec);
      if (spec.access !== 'read' && spec.access !== 'edit') throw new BosunError('invalid', 'Invalid Codex access');
      if (spec.access === 'read') throw new BosunError('unverified', 'Codex read-only tool policy is unverified');
      if (spec.maxTurns !== undefined || spec.mcp?.length || spec.env && Object.keys(spec.env).length) {
        throw new BosunError('unsupported', 'Codex execution option unsupported');
      }
      if (!text(spec.cwd, 4096) || !path.isAbsolute(spec.cwd) || !text(spec.model, 256)
        || !spec.model || /\s/.test(spec.model) || spec.model.startsWith('-')
        || spec.effort !== undefined && !/^[a-z][a-z0-9_-]{0,63}$/.test(spec.effort)
        || !text(spec.prompt, 32768) || !spec.prompt.trim()) throw new BosunError('invalid', 'Invalid Codex request');
      screenPublicText(spec.prompt);
      if (spec.signal.aborted) throw new BosunError('cancelled', 'Codex execution cancelled');
      const env = { ...options.env, BOSUN_DEPTH: '1', BOSUN_CALLER: 'model' };
      const detected = await detect(env);
      if (!detected.installed) throw new BosunError('unavailable', 'Codex executable unavailable');
      if (detected.version !== CODEX_VERSION) throw new BosunError('unverified', 'Codex version unverified');
      const args = ['exec', '--json', '--color', 'never', '--ephemeral', '--skip-git-repo-check', '--ignore-rules',
        '-s', 'workspace-write', '-C', spec.cwd, '-m', spec.model,
        '-c', 'approval_policy="never"', '-c', 'sandbox_workspace_write.network_access=false',
        '-c', 'features.hooks=false', '-c', 'notify=[]'];
      if (spec.effort !== undefined) args.push('-c', `model_reasoning_effort=${JSON.stringify(spec.effort)}`);
      args.push('-');
      let thread = false; let turn = false; let completed = false; let result: string | undefined; let count = 0;
      try {
        for await (const event of streamProcess({ command: detected.path!, args, cwd: spec.cwd, env, input: spec.prompt,
          signal: spec.signal, timeoutMs: options.timeoutMs, killGraceMs: options.killGraceMs })) {
          if (event.t === 'exit') {
            if (event.code !== 0 || event.signal !== null || !completed || result === undefined) throw unavailable();
            yield { t: 'done', code: 0, result }; continue;
          }
          if (++count > 2048) throw unavailable();
          let row: unknown; try { row = JSON.parse(event.text); } catch { throw unavailable(); }
          if (!object(row) || typeof row.type !== 'string' || completed) throw unavailable();
          switch (row.type) {
            case 'thread.started':
              if (thread || !text(row.thread_id, 256) || !row.thread_id) throw unavailable();
              thread = true; break;
            case 'turn.started':
              if (!thread || turn) throw unavailable(); turn = true; break;
            case 'turn.failed': case 'error': throw unavailable();
            case 'turn.completed': {
              if (!turn || !object(row.usage) || !integer(row.usage.input_tokens) || !integer(row.usage.output_tokens)
                || row.usage.cached_input_tokens !== undefined && !integer(row.usage.cached_input_tokens)) throw unavailable();
              completed = true;
              yield { t: 'usage', tokensIn: row.usage.input_tokens, tokensOut: row.usage.output_tokens }; break;
            }
            case 'item.started': case 'item.updated': case 'item.completed': {
              if (!turn || !object(row.item) || !text(row.item.id, 256) || !row.item.id || typeof row.item.type !== 'string') throw unavailable();
              if (row.type !== 'item.completed') break;
              if (row.item.type === 'agent_message') {
                if (!text(row.item.text)) throw unavailable(); result = row.item.text; yield { t: 'text', text: result };
              } else if (row.item.type === 'command_execution') yield { t: 'tool', name: 'command_execution' };
              else if (row.item.type === 'mcp_tool_call') yield { t: 'tool', name: 'mcp_tool_call' };
              else if (row.item.type === 'web_search') yield { t: 'tool', name: 'web_search' };
              else if (row.item.type === 'file_change') {
                if (!Array.isArray(row.item.changes) || row.item.changes.length > 256) throw unavailable();
                for (const change of row.item.changes) {
                  if (!object(change) || !text(change.path, 4096) || !change.path || !['add', 'update', 'delete'].includes(String(change.kind))) throw unavailable();
                  yield { t: 'file', path: change.path, op: change.kind === 'add' ? 'create' : change.kind === 'update' ? 'edit' : 'delete' };
                }
              }
              break;
            }
            default: throw unavailable();
          }
        }
      } catch (error) {
        if (error instanceof BosunError && (error.code === 'cancelled' || error.code === 'timeout')) {
          throw new BosunError(error.code, error.code === 'cancelled' ? 'Codex execution cancelled' : 'Codex execution timed out', { details: { outcome: 'unknown' } });
        }
        throw unavailable();
      }
    },
  };
}
