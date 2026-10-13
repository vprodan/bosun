import fs from 'node:fs';
import path from 'node:path';
import { BosunError } from '../../../core/errors.ts';
import { requirePublicInput } from '../../../core/policy.ts';
import { screenPublicText } from '../../../core/secret-screen.ts';
import type { InferenceInput } from '../../../core/domain/inference.ts';
import type {
  ManagedSession,
  ContextSample,
  AdmissionFence,
} from '../../../core/domain/session.ts';
import type { ManagedSessionCreate, ManagedSessionDriver } from '../../../core/ports/host.ts';
import type { RunEvent } from '../../../core/ports/runner.ts';
import { connectCodexAppServer, type CodexClient, type CodexClientOptions } from './client.ts';
import { CODEX_VERSION } from './runner.ts';
import { bindRollout, readRolloutSeed, type RolloutBinding } from './rollout.ts';
import { captureCodexEvidence } from './evidence.ts';

type Gates = {
  assertOwner(expected: { ownerId: string; generation: number }): void;
  assertDispatchOwner(expected: { ownerId: string; generation: number; sessionId: string }): void;
  freshClaim(source: ManagedSession): { ownerId: string; generation: number };
  hash(text: string): string;
  now(): number;
  id(): string;
};
type Turn = {
  id?: string;
  observed?: string;
  terminal?: Record<string, unknown>;
  receipt?: boolean;
  items: Map<string, { type: string; terminal: boolean }>;
  events: RunEvent[];
  wake(): void;
  changed: Promise<void>;
};
type Owned = {
  session: ManagedSession;
  cwd: string;
  effort: string | null;
  client: CodexClient;
  lifetime: AbortController;
  rollout: RolloutBinding;
  phase: 'fresh' | 'seeded' | 'ready' | 'unknown';
  seed?: { text: string; hash: string };
  fence?: AdmissionFence;
  locked: boolean;
  freshAttempted: boolean;
  turn?: Turn;
  turns: Set<string>;
  users: Map<string, { clientId: string; text: string; turnId: string }>;
  sample?: ContextSample;
};
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const integer = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const string = (v: unknown, max = 256): v is string =>
  typeof v === 'string' && !!v && !/[\x00-\x1f\x7f]/.test(v) && Buffer.byteLength(v) <= max;
const text = (v: unknown, max: number): v is string =>
  typeof v === 'string' && !!v.trim() && !v.includes('\0') && Buffer.byteLength(v) <= max;
const uuid = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const own = (v: object, key: string): unknown => Object.getOwnPropertyDescriptor(v, key)?.value;
const fail = (
  code: 'invalid' | 'unverified' | 'unavailable' | 'cancelled' = 'unavailable',
  unknown = false,
) =>
  new BosunError(
    code,
    code === 'invalid'
      ? 'Invalid Codex managed request'
      : code === 'unverified'
        ? 'Codex managed control unverified'
        : code === 'cancelled'
          ? 'Codex managed request cancelled'
          : 'Codex managed source unavailable',
    unknown ? { details: { outcome: 'unknown' } } : undefined,
  );
const caps: ManagedSessionDriver['caps'] = Object.freeze({
  contextTelemetry: 'unverified',
  promptAdmission: 'unverified',
  toolQuiescence: 'unverified',
  freshSession: 'unverified',
  seedWithoutInference: 'unverified',
  freshReadiness: 'unverified',
});
const terminalTools = new Set(['completed', 'failed', 'declined']);
const tools = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall']);
const lost = (owned: Owned) => owned.phase === 'unknown';

// One owned app-server per fresh root. Native credentials remain native. All
// production qualification flags stay unverified; a local fence does not fence
// other clients, and sandbox policy does not qualify MCP/apps/plugins.
export function createCodexControl(
  settings: Omit<CodexClientOptions, 'cwd' | 'notification' | 'closed'>,
  gates: Gates,
): ManagedSessionDriver {
  const sessions = new Map<string, Owned>();
  const creates = new Set<string>();
  const opening = new Set<Promise<CodexClient>>();
  let closed = false;
  const digest = (value: string) => {
    const result = gates.hash(value);
    if (!/^[a-f0-9]{64}$/.test(result)) throw fail('invalid');
    return result;
  };
  function signal(signal: AbortSignal) {
    if (signal.aborted) throw fail('cancelled');
    if (closed) throw fail();
  }
  function selected(session: ManagedSession): Owned {
    const owned = sessions.get(own(session, 'sessionId') as string);
    if (
      !owned ||
      JSON.stringify(owned.session) !== JSON.stringify(session) ||
      owned.phase === 'unknown' ||
      closed
    )
      throw fail();
    gates.assertOwner(owned.session);
    return owned;
  }
  function invalidate(owned: Owned) {
    owned.phase = 'unknown';
    owned.turn?.wake();
  }
  async function closePriorSources(current: Owned) {
    // The durable dispatch gate has already accepted this destination. Retired
    // roots keep their native history, but must not keep another executor alive.
    for (const [id, prior] of sessions) {
      if (
        id === current.session.sessionId ||
        !prior.fence ||
        prior.session.generation >= current.session.generation
      )
        continue;
      invalidate(prior);
      await prior.client.close();
      sessions.delete(id);
    }
  }
  function thread(owned: Owned, value: unknown, fresh = false): Record<string, unknown> {
    if (
      !object(value) ||
      value.id !== owned.session.sessionId ||
      value.sessionId !== value.id ||
      value.forkedFromId !== null ||
      value.parentThreadId !== null ||
      value.ephemeral !== false ||
      value.historyMode !== 'legacy' ||
      value.cwd !== owned.cwd ||
      value.cliVersion !== CODEX_VERSION ||
      value.model !== owned.session.model ||
      value.reasoningEffort !== owned.effort ||
      value.path !== owned.rollout.file ||
      !object(value.status) ||
      value.status.type !== 'idle' ||
      !Array.isArray(value.turns) ||
      value.turns.length > 64 ||
      (fresh && value.turns.length !== 0)
    )
      throw fail();
    return value;
  }
  async function idle(
    owned: Owned,
    abort: AbortSignal,
    fresh = false,
  ): Promise<Record<string, unknown>[]> {
    signal(abort);
    gates.assertOwner(owned.session);
    const response = await owned.client.request(
      'thread/read',
      { threadId: owned.session.sessionId, includeTurns: true },
      abort,
    );
    if (!object(response)) throw fail();
    const root = thread(owned, response.thread, fresh);
    const turns = root.turns as unknown[];
    const result: Record<string, unknown>[] = [],
      seen = new Set<string>();
    for (const row of turns) {
      if (
        !object(row) ||
        !uuid(row.id) ||
        seen.has(row.id) ||
        !owned.turns.has(row.id) ||
        !['completed', 'failed', 'interrupted'].includes(String(row.status)) ||
        row.itemsView !== 'full' ||
        !Array.isArray(row.items) ||
        row.items.length > 256
      )
        throw fail();
      for (const item of row.items) {
        if (
          !object(item) ||
          !string(item.id) ||
          typeof item.type !== 'string' ||
          !['userMessage', 'agentMessage', 'reasoning', 'plan', ...tools].includes(item.type) ||
          (tools.has(item.type) && !terminalTools.has(String(item.status)))
        )
          throw fail();
        if (item.type === 'userMessage') {
          const admitted =
            typeof item.clientId === 'string' ? owned.users.get(item.clientId) : undefined;
          if (
            !admitted ||
            admitted.turnId !== row.id ||
            !Array.isArray(item.content) ||
            item.content.length !== 1 ||
            !object(item.content[0]) ||
            item.content[0].type !== 'text' ||
            item.content[0].text !== admitted.text
          )
            throw fail();
        }
      }
      if (row.items.filter((item) => object(item) && item.type === 'userMessage').length !== 1)
        throw fail();
      seen.add(row.id);
      result.push(row);
    }
    if (seen.size !== owned.turns.size) throw fail();
    const background = await owned.client.request(
      'thread/backgroundTerminals/list',
      { threadId: owned.session.sessionId, limit: 1 },
      abort,
    );
    if (
      !object(background) ||
      !Array.isArray(background.data) ||
      background.data.length ||
      background.nextCursor !== null
    )
      throw fail('unverified');
    if (lost(owned)) throw fail();
    return result;
  }
  function notification(owned: Owned, method: string, raw: unknown) {
    if (!object(raw)) throw fail();
    if (method === 'thread/started') {
      thread(owned, raw.thread, true);
      return;
    }
    if (raw.threadId !== owned.session.sessionId) throw fail();
    if (method === 'thread/status/changed') {
      if (!object(raw.status) || !['idle', 'active'].includes(String(raw.status.type)))
        throw fail();
      return;
    }
    const active = owned.turn;
    if (
      !active ||
      owned.phase !== 'ready' ||
      !uuid(raw.turnId ?? (object(raw.turn) ? raw.turn.id : undefined))
    )
      throw fail();
    const id = String(raw.turnId ?? (raw.turn as Record<string, unknown>).id);
    if ((active.id && id !== active.id) || (active.observed && id !== active.observed))
      throw fail();
    active.observed = id;
    if (method === 'turn/started') {
      if (active.receipt) throw fail();
      active.receipt = true;
    } else if (method === 'turn/completed') {
      if (
        active.terminal ||
        !object(raw.turn) ||
        !['completed', 'failed', 'interrupted'].includes(String(raw.turn.status))
      )
        throw fail();
      active.terminal = raw.turn;
    } else if (method === 'thread/tokenUsage/updated') {
      const usage = raw.tokenUsage;
      if (
        !object(usage) ||
        !object(usage.last) ||
        !integer(usage.last.totalTokens) ||
        (usage.modelContextWindow !== null &&
          (!integer(usage.modelContextWindow) || !usage.modelContextWindow))
      )
        throw fail();
      owned.sample = {
        sessionId: owned.session.sessionId,
        turnId: id,
        modelId: owned.session.model,
        usedTokens: usage.last.totalTokens,
        windowTokens: usage.modelContextWindow as number | null,
        scope: 'unknown',
        observedAt: gates.now(),
        generation: owned.session.generation,
        quality: 'unknown',
      };
    } else if (method === 'item/started' || method === 'item/completed') {
      if (
        !object(raw.item) ||
        !string(raw.item.id) ||
        typeof raw.item.type !== 'string' ||
        active.items.size >= 256
      )
        throw fail();
      const item = raw.item,
        type = item.type as string,
        key = item.id as string;
      const before = active.items.get(key),
        terminal = method === 'item/completed';
      if (
        before?.terminal ||
        (before && before.type !== type) ||
        !['userMessage', 'agentMessage', 'reasoning', 'plan', ...tools].includes(type) ||
        (terminal && tools.has(type) && !terminalTools.has(String(item.status)))
      )
        throw fail();
      active.items.set(key, { type, terminal });
      if (terminal && type === 'agentMessage') {
        if (!text(item.text, 65536)) throw fail();
        screenPublicText(item.text);
        active.events.push({ t: 'text', text: item.text });
      } else if (terminal && tools.has(type)) active.events.push({ t: 'tool', name: type });
    } else if (
      ![
        'item/agentMessage/delta',
        'item/reasoning/summaryTextDelta',
        'item/reasoning/textDelta',
        'item/commandExecution/outputDelta',
        'item/fileChange/outputDelta',
        'turn/diff/updated',
        'turn/plan/updated',
      ].includes(method)
    )
      throw fail();
    // Stream deltas, reasoning, command arguments/results and patch bytes never
    // enter owner/model evidence. Only terminal, screened public text does.
    active.wake();
  }
  async function create(input: ManagedSessionCreate, abort: AbortSignal): Promise<ManagedSession> {
    requirePublicInput(input);
    const access = own(input, 'access');
    if (access === 'read') throw fail('unverified');
    const cwd = own(input, 'cwd'),
      model = own(input, 'model'),
      effort = own(input, 'effort');
    const ownerId = own(input, 'ownerId'),
      generation = own(input, 'generation'),
      requestId = own(input, 'requestId');
    if (
      access !== 'edit' ||
      !string(cwd, 4096) ||
      !path.isAbsolute(cwd) ||
      path.resolve(cwd) !== cwd ||
      !string(model) ||
      /\s/.test(model) ||
      model.startsWith('-') ||
      !string(ownerId) ||
      !string(requestId) ||
      !integer(generation) ||
      (effort !== undefined &&
        !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'ultra', 'max'].includes(
          String(effort),
        ))
    )
      throw fail('invalid');
    screenPublicText(JSON.stringify({ cwd, model, ownerId, requestId, effort }));
    signal(abort);
    gates.assertOwner({ ownerId, generation });
    if (sessions.size >= 4 || fs.realpathSync(cwd) !== cwd || !fs.statSync(cwd).isDirectory())
      throw fail();
    const creationId = digest(JSON.stringify([ownerId, generation, requestId]));
    if (creates.has(creationId) || creates.size >= 64) throw fail();
    const lifetime = new AbortController();
    let client: CodexClient | undefined;
    let owned: Owned | undefined;
    try {
      const env = { ...settings.env },
        home = env.CODEX_HOME ?? (env.HOME && path.join(env.HOME, '.codex'));
      if (!home || !path.isAbsolute(home)) throw fail('invalid');
      creates.add(creationId);
      const events: { method: string; raw: unknown }[] = [];
      const connection = connectCodexAppServer(
        {
          env,
          command: settings.command,
          timeoutMs: settings.timeoutMs,
          requestTimeoutMs: settings.requestTimeoutMs,
          killGraceMs: settings.killGraceMs,
          cwd,
          notification(method, raw) {
            if (owned) {
              try {
                notification(owned, method, raw);
              } catch {
                invalidate(owned);
                throw fail();
              }
            } else {
              if (
                events.length >= 8 ||
                !['thread/started', 'thread/status/changed'].includes(method)
              )
                throw fail();
              events.push({ method, raw });
            }
          },
          closed() {
            if (owned) invalidate(owned);
          },
        },
        lifetime.signal,
      );
      opening.add(connection);
      try {
        client = await connection;
      } finally {
        opening.delete(connection);
      }
      signal(abort);
      gates.assertOwner({ ownerId, generation });
      const response = await client.request(
        'thread/start',
        {
          model,
          cwd,
          approvalPolicy: 'never',
          sandbox: 'workspace-write',
          ephemeral: false,
          config: {
            'sandbox_workspace_write.network_access': false,
            ...(effort === undefined ? {} : { model_reasoning_effort: effort }),
          },
        },
        abort,
      );
      if (
        !object(response) ||
        !object(response.thread) ||
        !uuid(response.thread.id) ||
        response.model !== model ||
        response.cwd !== cwd ||
        response.reasoningEffort !== (effort ?? null) ||
        response.approvalPolicy !== 'never' ||
        !object(response.sandbox) ||
        response.sandbox.type !== 'workspaceWrite' ||
        response.sandbox.networkAccess !== false ||
        !Array.isArray(response.sandbox.writableRoots) ||
        response.sandbox.writableRoots.some((value) => value !== cwd)
      )
        throw fail();
      const session: ManagedSession = {
        hostId: 'codex',
        sessionId: response.thread.id,
        ownerId,
        generation,
        model,
        access,
      };
      const rollout = bindRollout({ file: response.thread.path, home, cwd, id: session.sessionId });
      owned = {
        session,
        cwd,
        effort: (effort as string | undefined) ?? null,
        client,
        lifetime,
        rollout,
        phase: 'fresh',
        locked: false,
        freshAttempted: false,
        turns: new Set(),
        users: new Map(),
      };
      thread(owned, response.thread, true);
      readRolloutSeed(rollout);
      for (const event of events) notification(owned, event.method, event.raw);
      await idle(owned, abort, true);
      signal(abort);
      gates.assertOwner(session);
      if (sessions.has(session.sessionId)) throw fail();
      sessions.set(session.sessionId, owned);
      return { ...session };
    } catch {
      lifetime.abort();
      if (client) await client.close();
      throw fail('unavailable', true);
    }
  }
  const driver: ManagedSessionDriver = {
    caps,
    create,
    async seed(session, input: InferenceInput & { hash: string }, abort) {
      requirePublicInput(input);
      const body = own(input, 'text'),
        hash = own(input, 'hash');
      if (!text(body, 16384) || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))
        throw fail('invalid');
      screenPublicText(body);
      if (digest(body) !== hash) throw fail('invalid');
      signal(abort);
      const owned = selected(session);
      if (owned.phase !== 'fresh' || owned.locked) throw fail();
      owned.locked = true;
      try {
        await idle(owned, abort, true);
        readRolloutSeed(owned.rollout);
        const reply = await owned.client.request(
          'thread/inject_items',
          {
            threadId: session.sessionId,
            items: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: body }],
              },
            ],
          },
          abort,
        );
        if (!object(reply) || Object.keys(reply).length) throw fail();
        readRolloutSeed(owned.rollout, body);
        await idle(owned, abort, true);
        owned.seed = { text: body, hash };
        owned.phase = 'seeded';
      } catch {
        invalidate(owned);
        await owned.client.close();
        throw fail('unavailable', true);
      } finally {
        owned.locked = false;
      }
    },
    async ready(session, expected, abort) {
      signal(abort);
      const owned = selected(session);
      if (
        owned.locked ||
        !owned.seed ||
        !['seeded', 'ready'].includes(owned.phase) ||
        expected.seedHash !== owned.seed.hash ||
        expected.model !== session.model ||
        expected.access !== session.access
      )
        throw fail();
      owned.locked = true;
      try {
        await idle(owned, abort, true);
        readRolloutSeed(owned.rollout, owned.seed.text);
        gates.assertOwner(session);
        signal(abort);
        owned.phase = 'ready';
        return {
          sessionId: session.sessionId,
          generation: session.generation,
          root: true,
          idle: true,
          seedHash: owned.seed.hash,
          model: session.model,
          access: session.access,
        };
      } catch {
        invalidate(owned);
        throw fail('unavailable', true);
      } finally {
        owned.locked = false;
      }
    },
    async run(session, input, abort) {
      requirePublicInput(input);
      const body = own(input, 'text'),
        clientId = own(input, 'turnId');
      if (!text(body, 32768) || !string(clientId)) throw fail('invalid');
      screenPublicText(body);
      signal(abort);
      const owned = selected(session);
      if (
        owned.phase !== 'ready' ||
        owned.locked ||
        owned.fence ||
        owned.turn ||
        owned.users.has(clientId)
      )
        throw fail();
      gates.assertDispatchOwner(session);
      owned.locked = true;
      let timer: ReturnType<typeof setTimeout> | undefined,
        cancelTimer: ReturnType<typeof setTimeout> | undefined;
      const active: Turn = { items: new Map(), events: [], changed: Promise.resolve(), wake() {} };
      const rearm = () => {
        active.changed = new Promise<void>((resolve) => {
          active.wake = resolve;
        });
      };
      const cancel = () => {
        if (cancelTimer) return;
        cancelTimer = setTimeout(() => {
          invalidate(owned);
          owned.lifetime.abort();
        }, 1000);
        cancelTimer.unref();
        if (active.id)
          void owned.client
            .request('turn/interrupt', { threadId: session.sessionId, turnId: active.id })
            .catch(() => invalidate(owned));
        else invalidate(owned);
        active.wake();
      };
      try {
        await closePriorSources(owned);
        await idle(owned, abort);
        gates.assertDispatchOwner(session);
        owned.turn = active;
        rearm();
        abort.addEventListener('abort', cancel, { once: true });
        timer = setTimeout(() => {
          invalidate(owned);
          owned.lifetime.abort();
        }, 300000);
        timer.unref();
        const response = await owned.client.request(
          'turn/start',
          {
            threadId: session.sessionId,
            clientUserMessageId: clientId,
            input: [{ type: 'text', text: body, text_elements: [] }],
            cwd: owned.cwd,
            approvalPolicy: 'never',
            model: session.model,
            effort: owned.effort,
          },
          undefined,
        );
        if (
          !object(response) ||
          !object(response.turn) ||
          !uuid(response.turn.id) ||
          response.turn.status !== 'inProgress' ||
          (active.observed && active.observed !== response.turn.id)
        )
          throw fail();
        active.id = response.turn.id;
        owned.turns.add(active.id);
        owned.users.set(clientId, { clientId, text: body, turnId: active.id });
        if (abort.aborted) cancel();
        while (!active.terminal && !lost(owned)) {
          await active.changed;
          rearm();
        }
        if (
          lost(owned) ||
          !active.terminal ||
          active.terminal.id !== active.id ||
          !active.receipt ||
          [...active.items.values()].some((item) => !item.terminal)
        )
          throw fail();
        const history = await idle(owned, new AbortController().signal);
        if (
          !history.some((turn) => turn.id === active.id && turn.status === active.terminal!.status)
        )
          throw fail();
        if (abort.aborted) throw fail('cancelled', true);
        gates.assertDispatchOwner(session);
        const result = active.events
          .filter((event) => event.t === 'text')
          .map((event) => event.text)
          .join('\n');
        if (
          Buffer.byteLength(result) > 65536 ||
          (active.terminal.status === 'completed' && !result.trim())
        )
          throw fail();
        return [
          ...active.events,
          { t: 'done', code: active.terminal.status === 'completed' ? 0 : 1, result },
        ];
      } catch {
        invalidate(owned);
        await owned.client.close();
        throw fail(abort.aborted ? 'cancelled' : 'unavailable', true);
      } finally {
        clearTimeout(timer);
        clearTimeout(cancelTimer);
        abort.removeEventListener('abort', cancel);
        owned.turn = undefined;
        owned.locked = false;
      }
    },
    async observeContext(session, abort) {
      signal(abort);
      const owned = selected(session);
      await idle(owned, abort);
      return owned.sample
        ? { ...owned.sample }
        : {
            sessionId: session.sessionId,
            turnId: '',
            modelId: session.model,
            usedTokens: null,
            windowTokens: null,
            scope: 'unknown',
            observedAt: gates.now(),
            generation: session.generation,
            quality: 'unknown',
          };
    },
    async capture(session, input, abort) {
      requirePublicInput(input);
      const afterCursor = own(input, 'afterCursor');
      if (
        afterCursor !== null &&
        (typeof afterCursor !== 'string' || !/^e_[0-9]{8}_[a-f0-9]{64}$/.test(afterCursor))
      )
        throw fail('invalid');
      signal(abort);
      const owned = selected(session);
      if (owned.phase !== 'ready' || owned.locked || !owned.seed) throw fail('unverified');
      owned.locked = true;
      try {
        const turns = await idle(owned, abort);
        return captureCodexEvidence(
          session,
          turns,
          { afterCursor, cwd: owned.cwd, seedHash: owned.seed.hash, users: owned.users },
          digest,
        );
      } catch {
        invalidate(owned);
        throw fail('unavailable', true);
      } finally {
        owned.locked = false;
      }
    },
    async fenceAdmission(session, abort) {
      signal(abort);
      const owned = selected(session);
      if (owned.fence) throw fail();
      owned.fence = {
        sessionId: session.sessionId,
        generation: session.generation,
        token: gates.id(),
      };
      return { ...owned.fence };
    },
    async quiesce(session, fence, abort) {
      signal(abort);
      const owned = selected(session);
      if (
        !owned.fence ||
        JSON.stringify(fence) !== JSON.stringify(owned.fence) ||
        owned.locked ||
        owned.turn
      )
        throw fail('unverified');
      await idle(owned, abort);
      return {
        sessionId: session.sessionId,
        generation: session.generation,
        pendingTools: 0,
        idle: true,
      };
    },
    async startFresh(session, abort) {
      signal(abort);
      const owned = selected(session);
      if (!owned.fence || owned.freshAttempted || owned.locked) throw fail();
      await driver.quiesce(session, owned.fence, abort);
      const claim = gates.freshClaim(session);
      if (claim.ownerId !== session.ownerId || claim.generation !== session.generation + 1)
        throw fail();
      owned.freshAttempted = true;
      return create(
        {
          privacy: 'public',
          ...claim,
          requestId: gates.id(),
          cwd: owned.cwd,
          model: session.model,
          access: session.access,
          ...(owned.effort ? { effort: owned.effort } : {}),
        },
        abort,
      );
    },
    async close() {
      closed = true;
      // Join an in-flight connection too, rather than losing its process handle.
      const pending = await Promise.allSettled(opening);
      const clients = new Set(
        [...sessions.values()].map((owned) => {
          invalidate(owned);
          owned.lifetime.abort();
          return owned.client;
        }),
      );
      for (const result of pending) if (result.status === 'fulfilled') clients.add(result.value);
      const results = await Promise.allSettled([...clients].map((client) => client.close()));
      sessions.clear();
      if (results.some((result) => result.status === 'rejected')) throw fail('unavailable', true);
    },
  };
  return driver;
}
