import type { HostBundle } from '../../../core/ports/host.ts';

// Pinned V2 Promise plugin: prompt has no privacy field. Admit only an explicit
// leading #public token, then bind one context insertion to that same input.
export function renderOpenCodeHookPlugin(bundle: HostBundle): string {
  return `import type { Plugin } from '@opencode/plugin';
import { spawn } from 'node:child_process';
import path from 'node:path';
const hook = ${JSON.stringify(bundle.hook)};
function runHook(request: string, cwd: string): Promise<string | null> {
  const { promise, resolve } = Promise.withResolvers<string | null>();
  let child;
  try { child = spawn(hook.command, hook.args, { cwd, env: { ...process.env, ...hook.env },
    stdio: ['pipe', 'pipe', 'ignore'], detached: process.platform !== 'win32' }); }
  catch { resolve(null); return promise; }
  let bytes = 0, chunks: Buffer[] = [], failed = false, finished = false;
  let killTimer: NodeJS.Timeout | undefined, stopTimer: NodeJS.Timeout | undefined;
  const kill = (signal: 'SIGTERM' | 'SIGKILL') => {
    try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch {}
  };
  const finish = (value: string | null) => {
    if (finished) return;
    finished = true; clearTimeout(timer); clearTimeout(killTimer); clearTimeout(stopTimer);
    chunks = []; child.stdout.destroy(); child.stdin.destroy(); resolve(value);
  };
  const cancel = () => {
    if (failed || finished) return;
    failed = true; chunks = []; kill('SIGTERM');
    killTimer = setTimeout(() => kill('SIGKILL'), 100);
    stopTimer = setTimeout(() => { kill('SIGKILL'); finish(null); }, 300);
  };
  const timer = setTimeout(cancel, hook.timeoutS * 1000);
  child.on('error', cancel); child.stdin.on('error', cancel); child.stdout.on('error', cancel);
  child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 16384) cancel(); else if (!failed) chunks.push(Buffer.from(chunk)); });
  child.on('close', (code, signal) => {
    if (failed || code !== 0 || signal) { kill('SIGKILL'); finish(null); return; }
    const output = Buffer.concat(chunks).toString('utf8'); kill('SIGKILL'); finish(output);
  });
  child.stdin.end(request); return promise;
}
export default {
  id: 'bosun.public-input',
  setup: async (ctx) => {
    // Bounded per-location state. A newer/private input invalidates an older
    // in-flight result before any provider context can consume it.
    const pending = new Map<string, { messageId: string; prompt: string; context: string | null }>();
    await ctx.session.hook('prompt', async (event) => {
      pending.delete(event.sessionID);
      const text = event.prompt.text, cwd = ctx.location.directory;
      if (process.env.BOSUN_DEPTH || pending.size >= 32 || !/^#public(?:[ \\t]|\\r?\\n|$)/.test(text)
        || event.prompt.files?.length || event.prompt.agents?.length || event.prompt.skills?.length
        || event.metadata?.privacy !== undefined && event.metadata.privacy !== 'public'
        || event.metadata?.private !== undefined && event.metadata.private !== false
        || !path.isAbsolute(cwd) || path.resolve(cwd) !== cwd) return;
      const prompt = text.replace(/^#public(?:[ \\t]+|\\r?\\n|$)/, '');
      if (!prompt.trim() || prompt.length > 8000 || prompt.trimStart().startsWith('/')
        || prompt.trimStart().startsWith('!') || prompt.includes('#noroute')) return;
      const request = JSON.stringify({ host: 'opencode', privacy: 'public', prompt, cwd, session_id: event.sessionID });
      if (Buffer.byteLength(request) > 32768) return;
      const value = { messageId: event.messageID, prompt: text, context: null as string | null };
      pending.set(event.sessionID, value);
      try {
        const output = await runHook(request, cwd);
        if (pending.get(event.sessionID) !== value || !output?.trim()) return;
        const result = JSON.parse(output), envelope = result?.hookSpecificOutput;
        if (envelope?.hookEventName !== 'UserPromptSubmit' || typeof envelope.additionalContext !== 'string'
          || !envelope.additionalContext.trim()) { pending.delete(event.sessionID); return; }
        value.context = envelope.additionalContext;
      } catch { if (pending.get(event.sessionID) === value) pending.delete(event.sessionID); }
    });
    await ctx.session.hook('context', (event) => {
      const value = pending.get(event.sessionID); pending.delete(event.sessionID);
      if (!value?.context) return;
      const message = event.messages.findLast(message => message.role === 'user');
      if (!message || message.id !== value.messageId || message.content.some(part => part.type !== 'text')
        || message.content.map(part => part.type === 'text' ? part.text : '').join('') !== value.prompt) return;
      event.system.push({ type: 'text', text: value.context });
    });
    return () => pending.clear();
  },
} satisfies Plugin.Plugin;
`;
}
