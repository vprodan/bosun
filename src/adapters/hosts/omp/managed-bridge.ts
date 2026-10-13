import type { OmpSelection } from './protocol.ts';
import { OMP_SOURCE_COMMIT } from './protocol.ts';

export const OMP_BRIDGE_COMMAND = 'bosun-native-control';
export const OMP_BRIDGE_ENTRY = 'bosun-native-control';
export const OMP_SEED_ENTRY = 'bosun-native-seed';
export const OMP_ADMISSION_ENTRY = 'bosun-native-admission';
export const OMP_SYSTEM_POLICY = 'You are the coding assistant for one explicitly public Bosun job. Use only the effective native tool allowlist. Do not start unrelated work, delegate, change model, or request session transitions. Native tool payloads and reasoning remain in their source, not handoff evidence.';
export type OmpBridgeBinding = { nonce: string; cwd: string; sessionDir: string; selection: OmpSelection };

// Pinned ExtensionAPI: commands may finish locally; sendMessage is a void facade
// over async idle append, so it is NOT its own seed receipt. A separate command
// inspects getEntries and acknowledges only the exact persisted custom message.
export function renderOmpManagedBridge(binding: OmpBridgeBinding): string {
  return `import { createHash } from 'node:crypto';
import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent';
const expected = ${JSON.stringify(binding)};
const systemPolicy = ${JSON.stringify(OMP_SYSTEM_POLICY)};
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
export default function bosunNativeControl(pi: ExtensionAPI) {
  let fenced = false, seedAttempted = false;
  let activeTurnHash: string | undefined;
  const received = new Set<string>();
  const pendingTools = new Set<string>();
  function binding(ctx: ExtensionContext) {
    const sm = ctx.sessionManager, header = sm.getHeader();
    const active = [...pi.getActiveTools()].sort();
    if (ctx.cwd !== expected.cwd || sm.getCwd() !== expected.cwd || sm.getRecordedCwd() !== expected.cwd
      || sm.getSessionDir() !== expected.sessionDir || !header || header.id !== sm.getSessionId()
      || header.cwd !== expected.cwd || header.parentSession !== undefined
      || (header.additionalDirectories?.length ?? 0) !== 0 || (header.previousSessionFiles?.length ?? 0) !== 0
      || !ctx.model || ctx.model.provider !== expected.selection.provider || ctx.model.id !== expected.selection.modelId
      || pi.getThinkingLevel() !== expected.selection.effort
      || JSON.stringify(active) !== JSON.stringify(expected.selection.tools)) throw new Error('Owned native binding unavailable');
    const catalog = pi.getAllTools();
    const tools = active.map((name) => {
      const rows = catalog.filter((tool) => tool.name === name);
      if (rows.length !== 1 || rows[0].sourceInfo.source !== 'builtin') throw new Error('Effective builtin policy unavailable');
      return { name, source: rows[0].sourceInfo.source, path: rows[0].sourceInfo.path };
    });
    return { version: pi.pi.VERSION, sourceCommit: ${JSON.stringify(OMP_SOURCE_COMMIT)},
      cwd: ctx.cwd, sessionDir: sm.getSessionDir(), sessionFile: sm.getSessionFile(), sessionId: sm.getSessionId(),
      root: true, model: expected.selection.model, effort: pi.getThinkingLevel(), access: expected.selection.access,
      tools, idle: ctx.isIdle(), queued: ctx.hasPendingMessages(), pendingTools: pendingTools.size,
      asyncRunning: ctx.getAsyncJobSnapshot()?.running.length ?? 0,
      inferenceSystemPromptHash: digest(systemPolicy), baseSystemPromptHash: digest(JSON.stringify(ctx.getSystemPrompt())),
      fenced, armed: activeTurnHash !== undefined };
  }
  pi.on('before_agent_start', async (event, ctx) => {
    binding(ctx);
    if (fenced || !activeTurnHash || digest(event.prompt) !== activeTurnHash)
      throw new Error('Literal public input changed before inference');
    // Exact request-local policy; discovered native context never enters this
    // provider prompt. Keep the hash through policy-preparation re-entry.
    return { systemPrompt: [systemPolicy] };
  });
  pi.on('input', async (event, ctx) => {
    binding(ctx);
    if (event.source !== 'rpc' || !event.text.startsWith('/' + ${JSON.stringify(OMP_BRIDGE_COMMAND)} + ' '))
      throw new Error('Input outside owned control transport');
    const request = JSON.parse(event.text.slice(${OMP_BRIDGE_COMMAND.length + 2}));
    if (request.nonce !== expected.nonce) throw new Error('Foreign native control');
    return { action: 'continue' };
  });
  pi.on('tool_call', async (event, ctx) => {
    binding(ctx);
    if (fenced || !activeTurnHash || !expected.selection.tools.includes(event.toolName)
      || pendingTools.has(event.toolCallId))
      return { block: true, reason: 'Tool outside owned active admission' };
    pendingTools.add(event.toolCallId);
  });
  pi.on('tool_result', async (event) => { pendingTools.delete(event.toolCallId); });
  pi.registerCommand(${JSON.stringify(OMP_BRIDGE_COMMAND)}, {
    description: 'Owned Bosun native lifecycle control',
    handler: async (args, ctx) => {
      if (Buffer.byteLength(args) > 65536) throw new Error('Control bound exceeded');
      const request = JSON.parse(args);
      if (request.nonce !== expected.nonce || typeof request.id !== 'string' || !/^[a-f0-9]{64}$/.test(request.id)
        || received.has(request.id) || received.size >= 1024
        || !['observe', 'fence', 'seed', 'ready', 'run'].includes(request.op)) throw new Error('Control unavailable');
      received.add(request.id);
      const state = binding(ctx);
      if (!state.idle || state.queued || state.asyncRunning || state.pendingTools) throw new Error('Session not idle');
      // Consume a previous admission only after native quiescence, never at an
      // agent yield while async work can wake it.
      if (request.op === 'observe') activeTurnHash = undefined;
      if (request.op === 'run') {
        if (fenced || activeTurnHash || typeof request.turnId !== 'string'
          || typeof request.text !== 'string' || !request.text.trim() || Buffer.byteLength(request.text) > 32768
          || digest(request.text) !== request.hash) throw new Error('Admission unavailable');
        activeTurnHash = request.hash;
        pi.appendEntry(${JSON.stringify(OMP_ADMISSION_ENTRY)}, { privacy: 'public', turnId: request.turnId, hash: request.hash });
        // Pinned sendUserMessage bypasses slash-command/template handling.
        // Independent admission/history/settlement, not this void facade, is
        // the model-turn receipt.
        pi.sendUserMessage(request.text, { attribution: 'user' });
      } else {
        if (activeTurnHash) throw new Error('Native admission still armed');
        if (request.op === 'fence') fenced = true;
        if (request.op === 'seed') {
          const entries = ctx.sessionManager.getEntries();
          if (seedAttempted || entries.some((entry) => entry.type === 'message' || entry.type === 'custom_message')
            || typeof request.text !== 'string' || !request.text.trim() || Buffer.byteLength(request.text) > 16384
            || digest(request.text) !== request.hash) throw new Error('Seed unavailable');
          seedAttempted = true;
          pi.sendMessage({ customType: ${JSON.stringify(OMP_SEED_ENTRY)}, content: request.text, display: false,
            details: { privacy: 'public', hash: request.hash }, attribution: 'user' }, { triggerTurn: false });
        }
        if (request.op === 'ready') {
          const messages = ctx.sessionManager.getEntries().filter((entry) => entry.type === 'message' || entry.type === 'custom_message');
          const seed = messages[0];
          if (messages.length !== 1 || !seed || seed.type !== 'custom_message' || seed.customType !== ${JSON.stringify(OMP_SEED_ENTRY)}
            || seed.display !== false || !seed.details || typeof seed.details !== 'object'
            || !('privacy' in seed.details) || seed.details.privacy !== 'public'
            || !('hash' in seed.details) || seed.details.hash !== request.hash
            || typeof seed.content !== 'string' || digest(seed.content) !== request.hash)
            throw new Error('Exact seed acknowledgement unavailable');
        }
      }
      pi.appendEntry(${JSON.stringify(OMP_BRIDGE_ENTRY)}, { privacy: 'public', id: request.id, op: request.op,
        ...(request.op === 'ready' ? { seedHash: request.hash } : {}), ...binding(ctx) });
    },
  });
}
`;
}
