import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { sandbox, fresh } from './helpers.ts';
import type { Sandbox } from './helpers.ts';
import { object, identifier, OMP_VERSION } from '../src/adapters/hosts/omp/protocol.ts';

export type OmpFixture = { sb: Sandbox; env: NodeJS.ProcessEnv; workspace: string; calls(): Record<string, unknown>[]; close(): void };
export function ompFixture(mode = 'normal', version = OMP_VERSION): OmpFixture {
  const sb = sandbox({ stubs: ['omp'] }); fresh(sb);
  const env = sb.env({ OMP_FIXTURE_MODE: mode, OMP_FIXTURE_VERSION: version });
  fs.mkdirSync(env.BOSUN_HOME!, { recursive: true, mode: 0o700 });
  const workspace = path.join(sb.home, 'workspace'); fs.mkdirSync(workspace, { mode: 0o700 });
  const implementation = fileURLToPath(import.meta.url);
  fs.writeFileSync(path.join(sb.bin, 'omp'), `#!/usr/bin/env bun\nif(process.argv.includes('--version')){console.log('omp/'+process.env.OMP_FIXTURE_VERSION);process.exit(0);}\nrequire(${JSON.stringify(implementation)}).serveOmpFixture().catch(()=>process.exit(2));\n`, { mode: 0o755 });
  return { sb, env, workspace,
    calls() { return fs.existsSync(sb.out) ? fs.readFileSync(sb.out, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []; },
    close() { sb.cleanup(); } };
}
// This process executes the actual generated ownership bridge. Only provider
// work and the documented native session APIs are deterministic public fixtures.
export async function serveOmpFixture(): Promise<void> {
  const args = process.argv.slice(2);
  const value = (flag: string) => args[args.indexOf(flag) + 1];
  const mode = process.env.OMP_FIXTURE_MODE;
  const model = value('--model'), slash = model.indexOf('/');
  const selected = { provider: model.slice(0, slash), id: model.slice(slash + 1) };
  const tools = value('--tools').split(',').sort(), sessionDir = value('--session-dir');
  const sessionId = 'fixture_' + path.basename(path.dirname(sessionDir)).slice(0, 24);
  const sessionFile = path.join(sessionDir, sessionId + '.jsonl');
  const header = { id: sessionId, cwd: process.cwd(), additionalDirectories: [], previousSessionFiles: [] };
  fs.writeFileSync(sessionFile, JSON.stringify({ type: 'session', ...header }) + '\n', { mode: 0o600, flag: 'wx' });
  type Entry = Record<string, unknown> & { id: string; type: string; parentId: string | null };
  type FixtureContext = typeof ctx;
  type Handler = (event: Record<string, unknown>, context: FixtureContext) => unknown | Promise<unknown>;
  const entries: Entry[] = [], messages: Record<string, unknown>[] = [];
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, { handler(args: string, context: FixtureContext): Promise<void> }>();
  let active = false, asyncWork = false, autoCompaction = true, serial = 0;
  const emit = (row: unknown) => process.stdout.write(JSON.stringify(row) + '\n');
  function append(entry: Record<string, unknown>) {
    if (typeof entry.type !== 'string') throw Error('Invalid fixture entry');
    const stored: Entry = { ...entry, type: entry.type, id: 'e_' + (++serial), parentId: entries.at(-1)?.id ?? null };
    entries.push(stored); fs.appendFileSync(sessionFile, JSON.stringify(stored) + '\n'); return stored;
  }
  const basePrompt = ['Public deterministic native base policy'];
  const ctx = {
    cwd: process.cwd(), model: selected,
    sessionManager: { getHeader: () => header, getSessionId: () => sessionId, getSessionFile: () => sessionFile,
      getSessionDir: () => sessionDir, getCwd: () => process.cwd(), getRecordedCwd: () => process.cwd(), getEntries: () => entries },
    isIdle: () => !active, hasPendingMessages: () => false, getAsyncJobSnapshot: () => ({ running: [] }),
    getSystemPrompt: () => basePrompt,
  };
  async function dispatch(name: string, event: Record<string, unknown>) {
    let result: unknown;
    for (const handler of handlers.get(name) ?? []) result = await handler(event, ctx);
    return result;
  }
  const pi = {
    pi: { VERSION: mode === 'runtime-version-mismatch' ? '18.99.0' : process.env.OMP_FIXTURE_VERSION },
    on(name: string, handler: Handler) {
      const callbacks = handlers.get(name) ?? []; callbacks.push(handler); handlers.set(name, callbacks);
    },
    registerCommand(name: string, command: { handler(args: string, context: FixtureContext): Promise<void> }) { commands.set(name, command); },
    getActiveTools: () => tools,
    getAllTools: () => tools.map(name => ({ name, sourceInfo: { source: 'builtin', path: '<builtin:' + name + '>' } })),
    getThinkingLevel: () => value('--thinking'),
    appendEntry(customType: string, data: unknown) {
      if (customType === 'bosun-native-control' && object(data) && data.op === 'run') {
        if (mode === 'version-drift') data.version = '18.99.1';
        if (mode === 'source-drift') data.sourceCommit = '0'.repeat(40);
      }
      append({ type: 'custom', customType, data });
    },
    sendMessage(message: Record<string, unknown>, options: { triggerTurn?: boolean }) {
      if (options.triggerTurn !== false || typeof message.content !== 'string') throw Error('Fixture requires a text-only no-inference seed');
      const content = mode === 'bad-seed' ? message.content + ' changed' : message.content;
      append({ type: 'custom_message', ...message, content }); messages.push({ role: 'custom', ...message, content });
    },
    sendUserMessage(body: string) {
      active = true;
      queueMicrotask(async () => {
        try {
          emit({ type: 'agent_start' }); await dispatch('before_agent_start', { prompt: body, systemPrompt: basePrompt });
          const user = { role: 'user', content: [{ type: 'text', text: body }] };
          append({ type: 'message', message: user }); messages.push(user);
          const assistant = { role: 'assistant', provider: selected.provider, model: selected.id, stopReason: 'stop',
            content: [{ type: 'text', text: mode === 'secret-echo' ? 'api_key=' + 'z'.repeat(40) : 'Synthetic native OMP result — owner verifies.' }],
            usage: { input: 7, output: 3, cacheRead: 2, cacheWrite: 1 } };
          append({ type: 'message', message: assistant }); messages.push(assistant);
          if (mode === 'foreign-history') append({ type: 'message', message: { role: 'user', content: 'Unadmitted source text' } });
          if (mode === 'foreign-control') append({ type: 'custom', customType: 'bosun-native-control',
            data: { privacy: 'public', id: 'foreign-control', op: 'observe' } });
          if (mode === 'private-control') {
            const control = entries.find(entry => entry.customType === 'bosun-native-control');
            if (!control || !object(control.data)) throw Error('Missing fixture control');
            control.data.privacy = 'private';
          }
          if (mode === 'model-drift') selected.id = 'different-native-model';
          if (mode === 'selection-event') emit({ type: 'model_changed', model: { ...selected } });
          if (mode === 'async-work') asyncWork = true;
          active = false; emit({ type: 'agent_end', messages: [assistant], isTerminal: true, yielded: true, awaitingAsyncWork: false });
          emit({ type: 'session_settled' });
        } catch { active = false; emit({ type: 'extension_error', error: 'Fixture native admission failed' }); }
      });
    },
  };
  // The file is runtime-selected by the admitted CLI recipe, not a known import.
  const bridge: unknown = await import(pathToFileURL(value('--trusted-extension')).href);
  if (!object(bridge) || typeof bridge.default !== 'function') throw Error('Invalid fixture bridge');
  bridge.default(pi);
  emit({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 });
  const input = createInterface({ input: process.stdin });
  for await (const line of input) {
    const request: unknown = JSON.parse(line);
    if (!object(request) || !identifier(request.type) || !identifier(request.id)) throw Error('Invalid fixture request');
    const type = request.type;
    let data: unknown;
    try {
      if (type === 'negotiate_protocol') data = { protocolVersion: 2 };
      else if (type === 'set_auto_compaction') {
        if (typeof request.enabled !== 'boolean') throw Error('Invalid fixture setting');
        autoCompaction = request.enabled;
      }
      else if (type === 'set_auto_retry') { /* source-level fixture has no retries */ }
      else if (type === 'set_cache_warming') data = { mode: request.mode };
      else if (type === 'get_state') data = { model: { ...selected }, thinkingLevel: value('--thinking'), sessionId, sessionFile,
        isStreaming: active, isCompacting: false, isSettled: !active && !asyncWork, hasPendingAsyncWork: asyncWork,
        autoCompactionEnabled: autoCompaction, goal: null, messageCount: messages.length,
        queuedMessageCount: 0, queuedMessages: { steering: [], followUp: [], liveSteered: [] },
        systemPrompt: basePrompt, dumpTools: tools.map(name => ({ name })), contextUsage: { tokens: 100, contextWindow: 200000 } };
      else if (type === 'get_entries') data = { entries, leafId: entries.at(-1)?.id ?? null };
      else if (type === 'prompt') {
        if (typeof request.message !== 'string') throw Error('Invalid fixture prompt');
        await dispatch('input', { source: 'rpc', text: request.message });
        const split = request.message.indexOf(' '), name = request.message.slice(1, split), payload = request.message.slice(split + 1);
        const control: unknown = JSON.parse(payload);
        if (!object(control) || typeof control.op !== 'string') throw Error('Invalid fixture control');
        fs.appendFileSync(process.env.STUB_OUT!, JSON.stringify({ op: control.op, id: request.id, pid: process.pid }) + '\n');
        const command = commands.get(name); if (!command) throw Error('Unknown fixture command');
        await command.handler(payload, ctx);
        if (mode === 'fenced-tool' && control.op === 'fence') {
          const decision = await dispatch('tool_call', { toolName: 'write', toolCallId: 'unadmitted-tool' });
          if (!object(decision) || decision.block !== true)
            fs.writeFileSync(path.join(process.cwd(), 'unauthorized-tool'), 'Native tool ran after fencing.');
        }
        if (mode === 'lost-run-receipt' && control.op === 'run') continue;
        data = { agentInvoked: false };
      } else if (type === 'abort_and_restore_queue') { active = false; asyncWork = false; data = { steering: [], followUp: [] }; }
      else throw Error('Unsupported fixture command');
      emit({ type: 'response', command: type, id: request.id, success: true, ...(data === undefined ? {} : { data }) });
    } catch { emit({ type: 'response', command: type, id: request.id, success: false, error: 'PRIVATE native fixture error' }); }
  }
}
