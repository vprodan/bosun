import fs from 'node:fs';
import path from 'node:path';
import type { InferenceInput } from '../../../core/domain/inference.ts';
import type { ManagedSession, AdmissionFence, ContextSample } from '../../../core/domain/session.ts';
import type { ManagedSessionCreate, ManagedSessionDriver } from '../../../core/ports/host.ts';
import type { RunEvent } from '../../../core/ports/runner.ts';
import type { OmpClient, OmpClientSettings } from './client.ts';
import type { OmpFrame, OmpSelection } from './protocol.ts';
import type { OmpHistory } from './evidence.ts';
import { requirePublicInput } from '../../../core/policy.ts';
import { screenPublicText } from '../../../core/secret-screen.ts';
import { privateDirectory, readPrivateFile } from '../../../platform/private-file.ts';
import { connectOmpRpc } from './client.ts';
import { identifier, integer, object, own, ompFailure, selection, sameTools, OMP_VERSION, OMP_SOURCE_COMMIT, OMP_LIMITS } from './protocol.ts';
import { OMP_BRIDGE_COMMAND, OMP_BRIDGE_ENTRY, OMP_SEED_ENTRY, OMP_SYSTEM_POLICY, renderOmpManagedBridge } from './managed-bridge.ts';
import { admittedOmpEntries, captureOmpEvidence, decodeOmpHistory, ompMessageText } from './evidence.ts';

export type OmpControlGates = {
  assertOwner(expected: { ownerId: string; generation: number }): void;
  assertDispatchOwner(expected: { ownerId: string; generation: number; sessionId: string }): void;
  freshClaim(source: ManagedSession): { ownerId: string; generation: number };
  hash(text: string): string; now(): number; id(): string;
};
type Turn = { id: string; started: boolean; terminal: boolean; settled: boolean; tools: Set<string> };
type Owned = {
  session: ManagedSession; cwd: string; cwdDev: number; cwdIno: number; selected: OmpSelection;
  nonce: string; root: string; sessionDir: string; bridge: string; bridgeText: string;
  client: OmpClient; lifetime: AbortController; phase: 'fresh' | 'seeded' | 'ready' | 'unknown';
  locked: boolean; freshAttempted: boolean; seedAttempted: boolean; seedHash: string | null;
  basePromptHash: string; turn?: Turn; turns: Map<string, string>; controls: Map<string, string>;
  fence?: AdmissionFence; nativeFile: string;
};
const CONTROL_RECEIPT_KEYS: Readonly<Record<string, true>> = Object.freeze({
  privacy: true, id: true, op: true, version: true, sourceCommit: true, cwd: true,
  sessionDir: true, sessionFile: true, sessionId: true, root: true, model: true,
  effort: true, access: true, tools: true, idle: true, queued: true, pendingTools: true,
  asyncRunning: true, inferenceSystemPromptHash: true, baseSystemPromptHash: true,
  fenced: true, armed: true,
});

// Capability qualification is separate from source implementation. No fixture
// can grant live ingress/tool isolation or observed active-total occupancy.
export function createOmpControl(settings: OmpClientSettings, gates: OmpControlGates): ManagedSessionDriver {
  const sessions = new Map<string, Owned>();
  const attempts = new Set<string>();
  const opening = new Set<Promise<ManagedSession>>();
  const constructing = new Set<AbortController>();
  let closed = false;
  function digest(value: string): string {
    const hash = gates.hash(value);
    if (!/^[a-f0-9]{64}$/.test(hash)) throw ompFailure('invalid');
    return hash;
  }
  function signal(value: AbortSignal) {
    if (closed) throw ompFailure();
    if (value.aborted) throw ompFailure('cancelled');
  }
  function selected(value: ManagedSession): Owned {
    const row = sessions.get(own(value, 'sessionId') as string);
    if (!row || row.phase === 'unknown' || closed || value.hostId !== 'omp' || value.ownerId !== row.session.ownerId
      || value.generation !== row.session.generation || value.model !== row.session.model || value.access !== row.session.access)
      throw ompFailure('unavailable', true);
    gates.assertOwner(row.session);
    const stat = fs.statSync(row.cwd);
    if (stat.dev !== row.cwdDev || stat.ino !== row.cwdIno || fs.realpathSync(row.cwd) !== row.cwd
      || readPrivateFile(row.bridge, 65536) !== row.bridgeText) throw ompFailure('unavailable', true);
    return row;
  }
  function state(row: Owned, value: unknown): Record<string, unknown> {
    if (!object(value) || value.sessionId !== row.session.sessionId || value.sessionFile !== row.nativeFile
      || !object(value.model) || value.model.provider !== row.selected.provider || value.model.id !== row.selected.modelId
      || value.thinkingLevel !== row.selected.effort || value.autoCompactionEnabled !== false
      || value.goal !== null || !integer(value.messageCount) || value.messageCount > OMP_LIMITS.messages
      || typeof value.isStreaming !== 'boolean' || typeof value.isCompacting !== 'boolean'
      || typeof value.hasPendingAsyncWork !== 'boolean' || typeof value.isSettled !== 'boolean'
      || !integer(value.queuedMessageCount) || !object(value.queuedMessages)
      || !Array.isArray(value.queuedMessages.steering) || !Array.isArray(value.queuedMessages.followUp)
      || !Array.isArray(value.dumpTools) || !sameTools(value.dumpTools.map(tool => object(tool) ? tool.name : null), row.selected.tools))
      throw ompFailure('unavailable', true);
    if (value.queuedMessages.liveSteered !== undefined && (!Array.isArray(value.queuedMessages.liveSteered)
      || value.queuedMessages.liveSteered.length)) throw ompFailure('unavailable', true);
    if (value.queuedMessageCount !== 0 || value.queuedMessages.steering.length || value.queuedMessages.followUp.length)
      throw ompFailure('unavailable', true);
    if (!Array.isArray(value.systemPrompt) || digest(JSON.stringify(value.systemPrompt)) !== row.basePromptHash)
      throw ompFailure('unavailable', true);
    return value;
  }
  async function snapshot(row: Owned, abort: AbortSignal): Promise<{ state: Record<string, unknown>; history: OmpHistory }> {
    signal(abort); selected(row.session);
    const observed = state(row, await row.client.request('get_state', {}, abort));
    const history = decodeOmpHistory(await row.client.request('get_entries', {}, abort));
    const repeated = state(row, await row.client.request('get_state', {}, abort));
    if (observed.messageCount !== repeated.messageCount || observed.isSettled !== repeated.isSettled
      || observed.isStreaming !== repeated.isStreaming || observed.isCompacting !== repeated.isCompacting
      || observed.hasPendingAsyncWork !== repeated.hasPendingAsyncWork) throw ompFailure('unavailable', true);
    selected(row.session);
    return { state: repeated, history };
  }
  function idle(value: Record<string, unknown>): void {
    if (value.isStreaming !== false || value.isCompacting !== false || value.hasPendingAsyncWork !== false
      || value.isSettled !== true) throw ompFailure('unavailable', true);
  }
  function binding(row: Owned, value: unknown, fenced: boolean, armed = false): Record<string, unknown> {
    if (!object(value) || value.privacy !== 'public' || value.version !== OMP_VERSION || value.sourceCommit !== OMP_SOURCE_COMMIT
      || value.sessionId !== row.session.sessionId || value.sessionFile !== row.nativeFile || value.cwd !== row.cwd
      || value.sessionDir !== row.sessionDir || value.root !== true || value.model !== row.selected.model
      || value.effort !== row.selected.effort || value.access !== row.selected.access || value.fenced !== fenced
      || value.armed !== armed || !Array.isArray(value.tools)
      || !sameTools(value.tools.map(tool => object(tool) ? tool.name : null), row.selected.tools)
      || value.tools.some(tool => !object(tool) || Object.keys(tool).length !== 3
        || tool.source !== 'builtin' || tool.path !== '<builtin:' + tool.name + '>')
      || value.inferenceSystemPromptHash !== digest(OMP_SYSTEM_POLICY) || value.baseSystemPromptHash !== row.basePromptHash)
      throw ompFailure('unavailable', true);
    return value;
  }
  async function command(row: Owned, op: string, params: Record<string, unknown>, abort: AbortSignal): Promise<Record<string, unknown>> {
    const id = digest('control:' + gates.id());
    const message = '/' + OMP_BRIDGE_COMMAND + ' ' + JSON.stringify({ ...params, id, op, nonce: row.nonce });
    await row.client.request('prompt', { message }, abort, id);
    await row.client.waitPrompt(id, abort);
    const history = decodeOmpHistory(await row.client.request('get_entries', {}, abort));
    const matches = history.entries.filter(entry => entry.type === 'custom' && entry.customType === OMP_BRIDGE_ENTRY
      && object(entry.data) && entry.data.id === id);
    if (matches.length !== 1 || !object(matches[0].data) || matches[0].data.op !== op) throw ompFailure('unavailable', true);
    const receipt = binding(row, matches[0].data, !!row.fence || op === 'fence', op === 'run');
    if (Object.keys(receipt).some(key => !Object.hasOwn(CONTROL_RECEIPT_KEYS, key)
      && !(op === 'ready' && key === 'seedHash')) || row.controls.has(id)
      || typeof receipt.idle !== 'boolean' || typeof receipt.queued !== 'boolean'
      || !integer(receipt.pendingTools) || !integer(receipt.asyncRunning)
      || op === 'ready' && receipt.seedHash !== params.hash) throw ompFailure('unavailable', true);
    row.controls.set(id, digest(JSON.stringify(receipt)));
    return receipt;
  }
  function notice(row: Owned | undefined, frame: OmpFrame) {
    if (!row) return;
    const turn = row.turn;
    if (frame.type === 'agent_start') {
      if (!turn || turn.started) { row.phase = 'unknown'; throw ompFailure('unavailable', true); }
      turn.started = true;
    } else if (frame.type === 'tool_execution_start') {
      if (!turn || !identifier(frame.toolCallId) || !identifier(frame.toolName) || turn.tools.has(frame.toolCallId)
        || !row.selected.tools.includes(frame.toolName)) throw ompFailure('unavailable', true);
      turn.tools.add(frame.toolCallId);
    } else if (frame.type === 'tool_execution_end') {
      if (!turn || !identifier(frame.toolCallId) || !turn.tools.delete(frame.toolCallId)) throw ompFailure('unavailable', true);
    } else if (frame.type === 'agent_end') {
      if (!turn || !turn.started || turn.tools.size || frame.isTerminal !== true || frame.yielded !== true
        || frame.awaitingAsyncWork === true) throw ompFailure('unavailable', true);
      turn.terminal = true;
    } else if (frame.type === 'session_settled') {
      if (!turn || !turn.terminal || turn.tools.size) throw ompFailure('unavailable', true);
      turn.settled = true;
    }
  }
  async function create(input: ManagedSessionCreate, abort: AbortSignal): Promise<ManagedSession> {
    requirePublicInput(input); signal(abort);
    if (!identifier(input.ownerId) || !identifier(input.requestId) || !integer(input.generation)
      || !path.isAbsolute(input.cwd) || path.resolve(input.cwd) !== input.cwd || fs.realpathSync(input.cwd) !== input.cwd
      || attempts.has(input.requestId) || sessions.size >= 32) throw ompFailure('invalid');
    screenPublicText(JSON.stringify({ model: input.model, effort: input.effort, cwd: input.cwd }));
    const choice = selection(input.model, input.effort ?? 'off', input.access);
    gates.assertOwner(input); attempts.add(input.requestId);
    const cwd = fs.statSync(input.cwd);
    if (!cwd.isDirectory()) throw ompFailure('invalid');
    const base = settings.env.BOSUN_HOME ?? path.join(settings.env.HOME ?? '', '.bosun');
    privateDirectory(base);
    const roots = path.join(base, 'native-omp');
    if (!fs.existsSync(roots)) fs.mkdirSync(roots, { mode: 0o700 });
    privateDirectory(roots);
    const nonce = digest('native:' + gates.id()), root = path.join(roots, nonce), sessionDir = path.join(root, 'sessions');
    fs.mkdirSync(root, { mode: 0o700 }); fs.mkdirSync(sessionDir, { mode: 0o700 });
    const bridge = path.join(root, 'bridge.ts');
    const bridgeText = renderOmpManagedBridge({ nonce, cwd: input.cwd, sessionDir, selection: choice });
    fs.writeFileSync(bridge, bridgeText, { flag: 'wx', mode: 0o600 });
    // Explicit startup overlay suppresses cache/model side requests. Effective
    // model/tools/maintenance are independently read back after connection.
    const config = path.join(root, 'config.yml');
    fs.writeFileSync(config, 'providers:\n  cacheWarming: off\nmcp:\n  enabled: false\nlsp:\n  enabled: false\nmemory:\n  enabled: false\nadvisor:\n  enabled: false\n', { flag: 'wx', mode: 0o600 });
    const lifetime = new AbortController();
    constructing.add(lifetime);
    const cancelCreation = () => lifetime.abort();
    abort.addEventListener('abort', cancelCreation, { once: true });
    if (abort.aborted) cancelCreation();
    let row: Owned | undefined, client: OmpClient | undefined;
    try {
      client = await connectOmpRpc({ ...settings, cwd: input.cwd,
        args: ['--mode', 'rpc', '--no-ui', '--no-title', '--no-lsp', '--no-skills', '--no-rules',
          '--trusted-extension', bridge, '--config', config, '--session-dir', sessionDir,
          '--model', choice.model, '--thinking', choice.effort, '--tools', choice.tools.join(',')],
        event(frame) { notice(row, frame); }, closed() { if (row) row.phase = 'unknown'; } }, lifetime.signal);
      signal(abort); gates.assertOwner(input);
      await client.request('set_auto_compaction', { enabled: false }, abort);
      await client.request('set_auto_retry', { enabled: false }, abort);
      await client.request('set_cache_warming', { mode: 'off' }, abort);
      const initial = await client.request('get_state', {}, abort);
      if (!object(initial) || !identifier(initial.sessionId) || typeof initial.sessionFile !== 'string'
        || !path.isAbsolute(initial.sessionFile) || !initial.sessionFile.startsWith(sessionDir + path.sep)
        || !Array.isArray(initial.systemPrompt)) throw ompFailure('unavailable', true);
      const session: ManagedSession = { hostId: 'omp', sessionId: initial.sessionId, ownerId: input.ownerId,
        generation: input.generation, model: input.model, access: input.access };
      row = { session, cwd: input.cwd, cwdDev: cwd.dev, cwdIno: cwd.ino, selected: choice, nonce, root,
        sessionDir, bridge, bridgeText, nativeFile: initial.sessionFile, client, lifetime, phase: 'fresh',
        locked: false, freshAttempted: false, seedAttempted: false, seedHash: null,
        basePromptHash: digest(JSON.stringify(initial.systemPrompt)), turns: new Map(), controls: new Map() };
      sessions.set(session.sessionId, row);
      state(row, initial); idle(initial);
      const observed = binding(row, await command(row, 'observe', {}, abort), false);
      if (observed.idle !== true || observed.queued !== false || observed.pendingTools !== 0 || observed.asyncRunning !== 0)
        throw ompFailure('unavailable', true);
      const fresh = await snapshot(row, abort); idle(fresh.state);
      if (fresh.state.messageCount !== 0 || fresh.history.entries.some(entry => entry.type === 'message' || entry.type === 'custom_message'))
        throw ompFailure('unavailable', true);
      admittedOmpEntries(fresh.history, { seedHash: null, turns: row.turns, controls: row.controls, binding: '' });
      return { ...session };
    } catch (error) {
      if (row) row.phase = 'unknown';
      await Promise.allSettled(client ? [client.close()] : []);
      throw error;
    }
    finally { constructing.delete(lifetime); abort.removeEventListener('abort', cancelCreation); }
  }
  const driver: ManagedSessionDriver = {
    caps: Object.freeze({ contextTelemetry: 'unverified', promptAdmission: 'unverified', toolQuiescence: 'unverified',
      freshSession: 'unverified', seedWithoutInference: 'unverified', freshReadiness: 'unverified' }),
    async create(input, abort) {
      const operation = create(input, abort); opening.add(operation);
      try { return await operation; } finally { opening.delete(operation); }
    },
    async seed(session, input: InferenceInput & { hash: string }, abort) {
      requirePublicInput(input); signal(abort); const row = selected(session);
      if (row.phase !== 'fresh' || row.seedAttempted || row.locked || !input.text.trim()
        || Buffer.byteLength(input.text) > OMP_LIMITS.seedBytes || digest(input.text) !== input.hash) throw ompFailure('invalid');
      screenPublicText(input.text); row.seedAttempted = true; row.locked = true;
      try {
        await command(row, 'seed', { text: input.text, hash: input.hash }, abort);
        const observed = await snapshot(row, abort); idle(observed.state);
        const messages = observed.history.entries.filter(entry => entry.type === 'message' || entry.type === 'custom_message');
        if (messages.length !== 1 || messages[0].type !== 'custom_message' || messages[0].customType !== OMP_SEED_ENTRY
          || messages[0].content !== input.text || !object(messages[0].details) || messages[0].details.privacy !== 'public'
          || messages[0].details.hash !== input.hash) throw ompFailure('unavailable', true);
        row.seedHash = input.hash; row.phase = 'seeded';
      } catch (error) { row.phase = 'unknown'; throw error; }
      finally { row.locked = false; }
    },
    async ready(session, expected, abort) {
      signal(abort); const row = selected(session);
      if (row.phase !== 'seeded' || row.locked || row.seedHash !== expected.seedHash
        || session.model !== expected.model || session.access !== expected.access) throw ompFailure('invalid');
      row.locked = true;
      try {
        const ready = binding(row, await command(row, 'ready', { hash: expected.seedHash }, abort), false);
        if (ready.seedHash !== expected.seedHash || ready.idle !== true || ready.queued !== false
          || ready.pendingTools !== 0 || ready.asyncRunning !== 0) throw ompFailure('unavailable', true);
        const observed = await snapshot(row, abort); idle(observed.state);
        admittedOmpEntries(observed.history, { seedHash: row.seedHash, turns: row.turns, controls: row.controls, binding: '' });
        if (observed.state.messageCount !== 1) throw ompFailure('unavailable', true);
        row.phase = 'ready';
        return { sessionId: session.sessionId, root: true, idle: true, seedHash: expected.seedHash,
          model: session.model, access: session.access, generation: session.generation };
      } catch (error) { row.phase = 'unknown'; throw error; }
      finally { row.locked = false; }
    },
    async run(session, input, abort) {
      requirePublicInput(input); signal(abort); const row = selected(session);
      if (row.phase !== 'ready' || row.fence || row.locked || !identifier(input.turnId) || row.turns.has(input.turnId)
        || typeof input.text !== 'string' || !input.text.trim() || Buffer.byteLength(input.text) > OMP_LIMITS.promptBytes)
        throw ompFailure('invalid');
      screenPublicText(input.text); gates.assertDispatchOwner(session);
      row.locked = true; row.turn = { id: input.turnId, started: false, terminal: false, settled: false, tools: new Set() };
      let attempted = false;
      try {
        const before = await snapshot(row, abort); idle(before.state);
        const prior = admittedOmpEntries(before.history, { seedHash: row.seedHash, turns: row.turns, controls: row.controls, binding: '' });
        const hash = digest(input.text); row.turns.set(input.turnId, hash); attempted = true;
        await command(row, 'run', { turnId: input.turnId, text: input.text, hash }, abort);
        const deadline = performance.now() + (settings.timeoutMs ?? 1800000);
        while (!row.turn.settled) {
          signal(abort);
          if (sessions.get(session.sessionId)?.phase === 'unknown' || performance.now() >= deadline)
            throw ompFailure('unavailable', true);
          const { promise, resolve } = Promise.withResolvers<void>();
          setTimeout(resolve, 10); await promise;
        }
        const observed = binding(row, await command(row, 'observe', {}, abort), false);
        if (observed.idle !== true || observed.queued !== false || observed.pendingTools !== 0 || observed.asyncRunning !== 0)
          throw ompFailure('unavailable', true);
        const after = await snapshot(row, abort); idle(after.state);
        const entries = admittedOmpEntries(after.history, { seedHash: row.seedHash, turns: row.turns, controls: row.controls, binding: '' });
        if (JSON.stringify(entries.slice(0, prior.length)) !== JSON.stringify(prior)) throw ompFailure('unavailable', true);
        const newMessages = entries.slice(prior.length).filter(entry => entry.type === 'message');
        const users = newMessages.filter(entry => object(entry.message) && entry.message.role === 'user');
        const last = newMessages.at(-1)?.message;
        if (users.length !== 1 || !object(users[0].message) || ompMessageText(users[0].message) !== input.text
          || !object(last) || last.role !== 'assistant' || last.model !== row.selected.modelId
          || last.provider !== row.selected.provider || last.stopReason !== 'stop') throw ompFailure('unavailable', true);
        const result = ompMessageText(last); screenPublicText(result);
        const events: RunEvent[] = [];
        if (object(last.usage) && integer(last.usage.input) && integer(last.usage.output)
          && integer(last.usage.cacheRead) && integer(last.usage.cacheWrite)) {
          const tokensIn = last.usage.input + last.usage.cacheRead + last.usage.cacheWrite;
          if (!Number.isSafeInteger(tokensIn)) throw ompFailure('unavailable', true);
          events.push({ t: 'usage', tokensIn, tokensOut: last.usage.output });
        }
        events.push({ t: 'done', code: 0, result });
        return events;
      } catch (error) {
        row.phase = 'unknown';
        if (attempted) await Promise.allSettled([row.client.request('abort_and_restore_queue', {}, AbortSignal.timeout(3000))]);
        throw attempted ? ompFailure(abort.aborted ? 'cancelled' : 'unavailable', true) : error;
      } finally { row.locked = false; row.turn = undefined; }
    },
    async observeContext(session, abort): Promise<ContextSample> {
      signal(abort); const row = selected(session);
      const current = await snapshot(row, abort); idle(current.state);
      const usage = current.state.contextUsage;
      const available = object(usage) && integer(usage.tokens) && integer(usage.contextWindow) && usage.contextWindow > 0;
      return { sessionId: session.sessionId, turnId: [...row.turns.keys()].at(-1) ?? 'fresh', modelId: session.model,
        usedTokens: available ? usage.tokens as number : null, windowTokens: available ? usage.contextWindow as number : null,
        scope: 'unknown', quality: available ? 'estimated' : 'unknown', observedAt: gates.now(), generation: session.generation };
    },
    async fenceAdmission(session, abort) {
      signal(abort); const row = selected(session);
      if (row.phase !== 'ready' || row.locked || row.fence) throw ompFailure('invalid');
      row.locked = true;
      try {
        const current = await snapshot(row, abort); idle(current.state);
        const result = binding(row, await command(row, 'fence', {}, abort), true);
        if (result.idle !== true || result.pendingTools !== 0 || result.asyncRunning !== 0 || result.queued !== false)
          throw ompFailure('unavailable', true);
        row.fence = { sessionId: session.sessionId, generation: session.generation, token: digest('fence:' + gates.id()) };
        return { ...row.fence };
      } catch (error) { row.phase = 'unknown'; throw error; }
      finally { row.locked = false; }
    },
    async quiesce(session, fence, abort) {
      signal(abort); const row = selected(session);
      if (!row.fence || row.fence.token !== fence.token || fence.sessionId !== session.sessionId
        || fence.generation !== session.generation || row.locked) throw ompFailure('invalid');
      const observed = await snapshot(row, abort); idle(observed.state);
      const native = binding(row, await command(row, 'observe', {}, abort), true);
      if (native.idle !== true || native.pendingTools !== 0 || native.asyncRunning !== 0 || native.queued !== false)
        throw ompFailure('unavailable', true);
      return { sessionId: session.sessionId, generation: session.generation, pendingTools: 0, idle: true };
    },
    async startFresh(source, abort) {
      signal(abort); const row = selected(source);
      if (!row.fence || row.freshAttempted || row.locked) throw ompFailure('invalid');
      row.freshAttempted = true;
      const claim = gates.freshClaim(source);
      return driver.create({ privacy: 'public', ...claim, requestId: digest('fresh:' + gates.id()), cwd: row.cwd,
        model: source.model, effort: row.selected.effort, access: source.access }, abort);
    },
    async capture(session, input, abort) {
      requirePublicInput(input); signal(abort); const row = selected(session);
      if (row.phase !== 'ready' || row.locked) throw ompFailure('invalid');
      const current = await snapshot(row, abort); idle(current.state);
      const sourceBinding = digest(JSON.stringify({ session, cwd: row.cwd, dev: row.cwdDev, ino: row.cwdIno,
        nativeFile: row.nativeFile, version: OMP_VERSION, sourceCommit: OMP_SOURCE_COMMIT,
        tools: row.selected.tools, basePromptHash: row.basePromptHash, inferencePromptHash: digest(OMP_SYSTEM_POLICY) }));
      return captureOmpEvidence(session, current.history, { seedHash: row.seedHash, turns: row.turns,
        controls: row.controls, binding: sourceBinding }, input.afterCursor);
    },
    async close() {
      closed = true;
      for (const lifetime of constructing) lifetime.abort();
      for (const row of sessions.values()) if (row.locked || row.turn) row.lifetime.abort();
      await Promise.allSettled([...opening]);
      const results = await Promise.allSettled([...sessions.values()].map(row => row.client.close()));
      if (results.some(result => result.status === 'rejected')) throw ompFailure('unavailable', true);
    },
  };
  return driver;
}
