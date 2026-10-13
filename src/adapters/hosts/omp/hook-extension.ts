import type { Env } from '../../../core/domain/inference.ts';
import type { HostBundle, PromptEvent } from '../../../core/ports/host.ts';
import path from 'node:path';
import { BosunError } from '../../../core/errors.ts';
import { screenPublicText } from '../../../core/secret-screen.ts';
import { ompRoleRef } from './roles.ts';

export function parseOmpPrompt(stdin: string, _env: Env): PromptEvent | null {
  try {
    if (Buffer.byteLength(stdin) > 32768) return null;
    const value = JSON.parse(stdin);
    if (!value || Array.isArray(value) || value.host !== 'omp' || value.privacy !== 'public' ||
        (value.private !== undefined && value.private !== false) || typeof value.prompt !== 'string' ||
        typeof value.cwd !== 'string' || !path.isAbsolute(value.cwd) ||
        path.resolve(value.cwd) !== value.cwd || /[\x00-\x1f\x7f]/.test(value.cwd) ||
        (value.session_id !== null && value.session_id !== undefined &&
          (typeof value.session_id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.session_id))))
      return null;
    screenPublicText(value.prompt);
    screenPublicText(value.cwd);
    return { text: value.prompt, privacy: 'public', cwd: value.cwd, sessionId: value.session_id ?? null };
  } catch { return null; }
}
export function formatOmpContext(context: string): string {
  screenPublicText(context);
  const line = JSON.stringify({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context },
  });
  if (Buffer.byteLength(line) > 16384)
    throw new BosunError('invalid', 'OMP hook context exceeds the native bound');
  return line;
}

// This is an ordinary input extension, never the managed RPC ownership bridge.
// Pinned 18.10.3 input has no privacy field, so only a leading per-turn #public
// token admits text to the real bosun hook; native user text is never rewritten.
export function renderOmpHookExtension(bundle: HostBundle): string {
  const roles = Object.fromEntries(bundle.roles.map(role => [ompRoleRef(role.id), {
    model: role.model ?? null,
  }]));
  return `import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';
import { spawn } from 'node:child_process';
import path from 'node:path';
const hook = ${JSON.stringify(bundle.hook)};
const roles: Record<string, { model: string | null }> = ${JSON.stringify(roles)};

function runHook(request: string, cwd: string): Promise<string | null> {
  const { promise, resolve } = Promise.withResolvers<string | null>();
    let child;
    try {
      child = spawn(hook.command, hook.args, {
        cwd, env: { ...process.env, ...hook.env },
        stdio: ['pipe', 'pipe', 'ignore'], detached: process.platform !== 'win32',
      });
    } catch { resolve(null); return promise; }
    let bytes = 0, chunks: Buffer[] = [], failed = false, finished = false;
    let killTimer: NodeJS.Timeout | undefined;
    let stopTimer: NodeJS.Timeout | undefined;
    const kill = (signal: 'SIGTERM' | 'SIGKILL') => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {}
    };
    const finish = (value: string | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); clearTimeout(killTimer); clearTimeout(stopTimer);
      chunks = [];
      child.stdout.destroy(); child.stdin.destroy();
      resolve(value);
    };
    const cancel = () => {
      if (failed || finished) return;
      failed = true; chunks = [];
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 100);
      stopTimer = setTimeout(() => { kill('SIGKILL'); finish(null); }, 300);
    };
    const timer = setTimeout(cancel, hook.timeoutS * 1000);
    child.on('error', cancel);
    child.stdin.on('error', cancel);
    child.stdout.on('error', cancel);
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 16384) cancel();
      else if (!failed) chunks.push(Buffer.from(chunk));
    });
    child.on('close', (code, signal) => {
      if (failed || code !== 0 || signal) { kill('SIGKILL'); finish(null); return; }
      const text = Buffer.concat(chunks).toString('utf8');
      // A producer that escaped into descendants must not retain owned pipes.
      kill('SIGKILL');
      finish(text);
    });
    child.stdin.end(request);
  return promise;
}
export default function bosunInput(pi: ExtensionAPI) {
  let pending: { prompt: string; context: string; sessionId: string } | undefined;
  let generation = 0;
  pi.on('session_start', (_event, ctx) => {
    pending = undefined; generation++;
    if (ctx.agent.kind === 'main') {
      process.env.BOSUN_OMP_SESSION_ID = ctx.sessionManager.getSessionId();
      process.env.BOSUN_OMP_PROJECT_DIR = ctx.cwd;
    }
  });
  pi.on('session_switch', (_event, ctx) => {
    pending = undefined; generation++;
    if (ctx.agent.kind === 'main') {
      process.env.BOSUN_OMP_SESSION_ID = ctx.sessionManager.getSessionId();
      process.env.BOSUN_OMP_PROJECT_DIR = ctx.cwd;
    }
  });
  pi.on('session_shutdown', (_event, ctx) => {
    pending = undefined; generation++;
    if (ctx.agent.kind === 'main' && process.env.BOSUN_OMP_SESSION_ID === ctx.sessionManager.getSessionId()) {
      delete process.env.BOSUN_OMP_SESSION_ID; delete process.env.BOSUN_OMP_PROJECT_DIR;
    }
  });
  pi.on('before_subagent_spawn', (event, ctx) => {
    const role = roles[event.agent];
    if (!role || role.model === null) return;
    const expected = role.model.startsWith('@') ? ctx.models.resolve(role.model) :
      ctx.models.list().find(model => model.provider + '/' + model.id === role.model);
    if (!expected) return { block: true, reason: 'Bosun native role model unavailable' };
    const exact = expected.provider + '/' + expected.id;
    if (event.patterns.length !== 1 || event.patterns[0] !== exact && event.patterns[0] !== role.model)
      return { block: true, reason: 'Bosun native role model override requires owner review' };
    return { model: [exact] };
  });
  pi.on('input', async (event, ctx) => {
    pending = undefined;
    const admittedGeneration = ++generation;
    if (ctx.agent.kind !== 'main' || event.source === 'extension' || event.images?.length ||
        process.env.BOSUN_DEPTH || !/^#public(?:[ \\t]|\\r?\\n|$)/.test(event.text)) return;
    const prompt = event.text.replace(/^#public(?:[ \\t]+|\\r?\\n|$)/, '');
    if (!prompt.trim() || prompt.length > 8000 || prompt.trimStart().startsWith('/') ||
        prompt.trimStart().startsWith('!') || prompt.includes('#noroute') ||
        !path.isAbsolute(ctx.cwd) || path.resolve(ctx.cwd) !== ctx.cwd) return;
    const sessionId = ctx.sessionManager.getSessionId();
    const request = JSON.stringify({ host: 'omp', privacy: 'public', prompt, cwd: ctx.cwd, session_id: sessionId });
    if (Buffer.byteLength(request) > 32768) return;
    try {
      const output = await runHook(request, ctx.cwd);
      if (admittedGeneration !== generation || !output?.trim() || Buffer.byteLength(output) > 16384) return;
      const result = JSON.parse(output);
      const context = result?.hookSpecificOutput;
      if (context?.hookEventName !== 'UserPromptSubmit' || typeof context.additionalContext !== 'string' ||
          !context.additionalContext.trim()) return;
      pending = { prompt: event.text, context: context.additionalContext, sessionId };
    } catch { /* Privacy-safe omission: never log input, output, or provider data. */ }
  });
  pi.on('before_agent_start', (event, ctx) => {
    const value = pending; pending = undefined; generation++;
    if (!value || event.images?.length || value.prompt !== event.prompt ||
        value.sessionId !== ctx.sessionManager.getSessionId()) return;
    return { systemPrompt: [...event.systemPrompt, value.context] };
  });
}
`;
}
