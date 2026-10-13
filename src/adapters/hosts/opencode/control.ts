// Process-local owned-session driver over OpenCode 2's pinned schema. No adoption, DB, process or server startup.
import path from 'node:path';
import { BosunError, type BosunErrorCode } from '../../../core/errors.ts';
import { requirePublicInput } from '../../../core/policy.ts';
import { screenPublicText } from '../../../core/secret-screen.ts';
import type { InferenceInput } from '../../../core/domain/inference.ts';
import type {
  ManagedSession,
  ContextSample,
  AdmissionFence,
  Quiescence,
} from '../../../core/domain/session.ts';
import type { ManagedSessionControl } from '../../../core/ports/host.ts';
import type { RunEvent } from '../../../core/ports/runner.ts';
import { httpJson, httpNoContent } from '../../../platform/http-json.ts';
import { captureOpenCodeEvidence, evidenceCursor, OPENCODE_EVIDENCE_LIMITS } from './evidence.ts';
import {
  decodeServerInfo,
  decodeMessagePage,
  decodeActive,
  contextCandidate,
  OPENCODE2_MANAGED_CAPS,
  type ModelSelection,
} from './v2-protocol.ts';
import {
  own,
  object,
  string,
  sameModel,
  openCodeSelection,
  openCodePermissions,
  requestConfiguration,
  availableModel,
  validateSession,
  pause,
  completion,
  validateAdmission,
  hash as nativeHash,
  type OpenCodeRunnerSettings,
} from './v2-native.ts';

export type OpenCodeControlDependencies = {
  assertOwner: (expected: { ownerId: string; generation: number }) => void;
  hash: (text: string) => string;
  now: () => number;
  id: () => string;
  freshClaim?: (source: ManagedSession) => { ownerId: string; generation: number };
  assertDispatchOwner?: (expected: {
    ownerId: string;
    generation: number;
    sessionId: string;
  }) => void;
};
export type OpenCodeCreate = {
  privacy: 'public';
  ownerId: string;
  generation: number;
  requestId: string;
  cwd: string;
  model: string;
  effort?: string;
  access: 'read' | 'edit';
};
export type OpenCodeTurn = InferenceInput & { turnId: string };
export type OpenCodeControlSettings = OpenCodeRunnerSettings & { quiesceMode?: 'wait' | 'abort' };
// Internal adapter API for the durable controller, not a second public port or ownership authority.
export interface OpenCodeManagedDriver extends ManagedSessionControl {
  create(input: OpenCodeCreate, signal: AbortSignal): Promise<ManagedSession>;
  run(session: ManagedSession, input: OpenCodeTurn, signal: AbortSignal): Promise<RunEvent[]>;
  resumeFenced(session: ManagedSession, fence: AdmissionFence, signal: AbortSignal): Promise<void>;
  capture: NonNullable<ManagedSessionControl['capture']>;
}
type UserBinding = { messageID: string; hash: string };
type Owned = {
  session: ManagedSession;
  cwd: string;
  selection: ModelSelection;
  agent: string;
  association: string;
  phase: 'fresh' | 'seeded' | 'ready' | 'unknown' | 'invalid';
  identityHash?: string;
  serverPid?: number;
  serverVersion?: string;
  modelHash?: string;
  locked: boolean;
  users: Map<string, UserBinding>;
  assistants: Set<string>;
  idles: Set<string>;
  turns: Set<string>;
  seed?: { key: string; text: string; hash: string };
  activeMessage?: string;
  fence?: AdmissionFence;
  freshAttempted: boolean;
  abort?: Promise<void>;
  active?: AbortController;
};
const fail = (code: BosunErrorCode = 'unavailable', unknown = false) =>
  new BosunError(
    code,
    code === 'invalid'
      ? 'Invalid OpenCode managed request'
      : code === 'unverified'
        ? 'OpenCode managed control unverified'
        : code === 'unsupported'
          ? 'OpenCode managed selection unsupported'
          : code === 'cancelled'
            ? 'OpenCode managed request cancelled'
            : code === 'timeout'
              ? 'OpenCode managed request timed out'
              : 'OpenCode managed session unavailable',
    unknown ? { details: { outcome: 'unknown' } } : undefined,
  );
const normalize = (e: unknown, unknown = false) =>
  fail(e instanceof BosunError ? e.code : 'unavailable', unknown);
const integer = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const hashValue = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
function signalValid(signal: AbortSignal): void {
  if (
    !signal ||
    typeof signal.aborted !== 'boolean' ||
    typeof signal.addEventListener !== 'function'
  )
    throw fail('invalid');
  if (signal.aborted) throw fail('cancelled');
}
function exactKeys(value: object, keys: string[]): void {
  if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !keys.includes(key)))
    throw fail('unsupported');
}

export function createOpenCodeControl(
  settings: OpenCodeControlSettings,
  dependencies: OpenCodeControlDependencies,
): OpenCodeManagedDriver {
  // No settings/dependency getters are evaluated until a screened operation is selected.
  const sessions = new Map<string, Owned>();
  const attempts = new Set<string>();
  const identifiers = new Set<string>();
  function deps() {
    const assertOwner = own(dependencies, 'assertOwner');
    const hash = own(dependencies, 'hash');
    const now = own(dependencies, 'now');
    const id = own(dependencies, 'id');
    const freshClaim = own(dependencies, 'freshClaim');
    const assertDispatchOwner = own(dependencies, 'assertDispatchOwner');
    if (![assertOwner, hash, now, id].every((v) => typeof v === 'function')) throw fail('invalid');
    if ([freshClaim, assertDispatchOwner].some((v) => v !== undefined && typeof v !== 'function'))
      throw fail('invalid');
    return {
      assertOwner: assertOwner as OpenCodeControlDependencies['assertOwner'],
      hash: hash as (v: string) => string,
      now: now as () => number,
      id: id as () => string,
      freshClaim: freshClaim as OpenCodeControlDependencies['freshClaim'],
      assertDispatchOwner:
        assertDispatchOwner as OpenCodeControlDependencies['assertDispatchOwner'],
    };
  }
  function authority(record: Owned): void {
    deps().assertOwner({ ownerId: record.session.ownerId, generation: record.session.generation });
  }
  function dispatch(record: Owned): void {
    const selected = deps();
    if (selected.assertDispatchOwner)
      selected.assertDispatchOwner({
        ownerId: record.session.ownerId,
        generation: record.session.generation,
        sessionId: record.session.sessionId,
      });
    else if (selected.freshClaim) throw fail('unverified');
    else authority(record); // Explicit manual sessions without staging retain their ordinary owner gate.
  }
  function identifier(prefix: string): string {
    const value = deps().id();
    if (!string(value, 100) || !/^[A-Za-z0-9_-]+$/.test(value)) throw fail('invalid');
    const result = `${prefix}_${value}`;
    if (identifiers.has(result) || identifiers.size >= 1024) throw fail('invalid');
    identifiers.add(result);
    return result;
  }
  function digest(text: string): string {
    const result = deps().hash(text);
    if (!hashValue(result)) throw fail('invalid');
    return result;
  }
  function owned(session: ManagedSession, allowInvalid = false): Owned {
    const id = own(session, 'sessionId');
    const record = typeof id === 'string' ? sessions.get(id) : undefined;
    if (
      !record ||
      ['hostId', 'ownerId', 'generation', 'model', 'access'].some(
        (key) => own(session, key) !== own(record.session, key),
      )
    )
      throw fail('unverified');
    authority(record);
    if (!allowInvalid && (record.phase === 'unknown' || record.phase === 'invalid'))
      throw fail('unverified');
    return record;
  }
  function configuration() {
    const cfg = requestConfiguration(settings);
    const mode = own(settings, 'quiesceMode') ?? 'abort';
    if (mode !== 'wait' && mode !== 'abort') throw fail('unsupported');
    return { ...cfg, mode };
  }
  type Configuration = ReturnType<typeof configuration>;
  async function json(
    record: Owned,
    cfg: Configuration,
    route: string,
    method: string,
    body: unknown,
    signal: AbortSignal,
    maximum = 1024 * 1024,
    timeout = cfg.requestTimeout,
    requireDispatch = false,
  ) {
    authority(record);
    if (requireDispatch) dispatch(record);
    signalValid(signal);
    const value = await httpJson(
      cfg.base + route,
      {
        method,
        headers: { ...cfg.headers, 'content-type': 'application/json' },
        signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      timeout,
      maximum,
    );
    authority(record);
    if (requireDispatch) dispatch(record);
    if (route === '/api/info') {
      const info = decodeServerInfo(value);
      if (record.serverPid !== undefined && (record.serverPid !== info.pid || record.serverVersion !== info.version)) throw fail('unverified');
      record.serverPid = info.pid; record.serverVersion = info.version;
    }
    return value;
  }
  function bound(value: unknown, record: Owned): ReturnType<typeof validateSession> {
    const session = validateSession(value, {
      id: record.session.sessionId, cwd: record.cwd, selection: record.selection,
      access: record.session.access, agent: record.agent, association: record.association,
    });
    const raw = object(object(value)?.data)!;
    const binding = object(object(raw.metadata)?.bosun);
    if (
      session.id !== record.session.sessionId ||
      !binding ||
      binding.ownerId !== record.session.ownerId ||
      binding.generation !== record.session.generation ||
      binding.association !== record.association ||
      (record.identityHash !== undefined && session.identityHash !== record.identityHash) ||
      raw.time.archived !== undefined ||
      raw.revert !== undefined
    )
      throw fail('unverified');
    return session;
  }
  function history(value: unknown, record: Owned, expected = true) {
    let decoded: ReturnType<typeof decodeMessagePage>['messages'];
    try { decoded = decodeMessagePage({ data: value, cursor: {} }, record.session.sessionId, { privacy: 'public' }).messages; }
    catch { throw fail('unverified'); }
    const rows = value as Record<string, any>[];
    let pending = 0;
    let currentUser: string | undefined, terminal = true;
    const toolIDs = new Set<string>();
    const allowed = new Set(['read', 'glob', 'grep', ...(record.session.access === 'edit' ? ['edit', 'write', 'patch'] : [])]);
    for (const [index, row] of rows.entries()) {
      const info = decoded[index];
      if (row.privacy !== undefined && row.privacy !== 'public') throw fail('unverified');
      if (info.type === 'user') {
        const user = record.users.get(info.id);
        if (!user || !terminal || typeof row.text !== 'string' || Buffer.byteLength(row.text) > 32768 ||
          digest(row.text) !== user.hash || [row.files, row.agents, row.skills].some((v) => v !== undefined && (!Array.isArray(v) || v.length)))
          throw fail('unverified');
        currentUser = info.id; terminal = false;
      } else if (info.type === 'assistant') {
        if (!currentUser || terminal || !sameModel(info.selection, record.selection) || row.agent !== record.agent ||
          (!record.assistants.has(info.id) && (expected || currentUser !== record.activeMessage))) throw fail('unverified');
        if (record.assistants.has(info.id) && info.failed) throw fail('unverified');
        for (const content of row.content) {
          if (content.privacy !== undefined && content.privacy !== 'public') throw fail('unverified');
          if (content.type === 'tool') {
            if (!allowed.has(content.name) || !string(content.id, 200) || toolIDs.has(content.id)) throw fail('unverified');
            toolIDs.add(content.id);
          }
        }
        pending += info.pendingTools;
      } else if (info.type === 'idle') {
        if (!currentUser || terminal || (!record.idles.has(info.id) && (expected || currentUser !== record.activeMessage))) throw fail('unverified');
        if (record.idles.has(info.id) && (info.failed || info.outcome !== 'succeeded')) throw fail('unverified');
        terminal = true;
      } else throw fail('unverified'); // Unknown/native compaction, shell, model/agent/location switches are never admitted.
    }
    if (expected && rows.length !== record.users.size + record.assistants.size + record.idles.size)
      throw fail('unverified');
    return { decoded, rows, pending, terminal };
  }
  function seedReadback(value: unknown, record: Owned): void {
    const entries = object(value)?.data;
    if (!Array.isArray(entries) || entries.length !== (record.seed ? 1 : 0)) throw fail('unverified');
    if (!record.seed) return;
    const entry = object(entries[0]);
    if (!entry || (entry.privacy !== undefined && entry.privacy !== 'public') ||
      entry.key !== record.seed.key || (entry.sessionID !== undefined && entry.sessionID !== record.session.sessionId) ||
      typeof entry.value !== 'string' || Buffer.byteLength(entry.value) > 16384 || digest(entry.value) !== record.seed.hash)
      throw fail('unverified');
  }
  async function snapshot(
    record: Owned,
    cfg: Configuration,
    signal: AbortSignal,
    expected = true,
    requireDispatch = false,
  ) {
    const session = bound(
      await json(
        record,
        cfg,
        `/api/session/${record.session.sessionId}`,
        'GET',
        undefined,
        signal,
        65536,
        cfg.requestTimeout,
        requireDispatch,
      ),
      record,
    );
    const messages = history(
      await pagedMessages(record, cfg, signal, requireDispatch),
      record,
      expected,
    );
    const inbox = object(await json(record, cfg, `/api/session/${record.session.sessionId}/inbox`, 'GET', undefined,
      signal, 65536, cfg.requestTimeout, requireDispatch))?.data;
    if (!Array.isArray(inbox) || inbox.length > 1) throw fail('unverified');
    for (const row of inbox) {
      const input = object(row), payload = object(input?.payload), user = record.users.get(input?.id);
      if (!user || input!.id !== record.activeMessage || input!.sessionID !== record.session.sessionId ||
        input!.type !== 'user' || input!.delivery !== 'queue' || typeof payload?.text !== 'string' || digest(payload.text) !== user.hash ||
        [payload.files, payload.agents, payload.skills].some((v) => v !== undefined && (!Array.isArray(v) || v.length))) throw fail('unverified');
    }
    seedReadback(await json(record, cfg, entriesPath(record), 'GET', undefined, signal, 65536, cfg.requestTimeout, requireDispatch), record);
    const active = decodeActive(
      await json(
        record,
        cfg,
        '/api/session/active',
        'GET',
        undefined,
        signal,
        256 * 1024,
        cfg.requestTimeout,
        requireDispatch,
      ),
      record.session.sessionId,
      { privacy: 'public' },
    );
    const repeated = bound(await json(record, cfg, `/api/session/${record.session.sessionId}`, 'GET', undefined,
      signal, 65536, cfg.requestTimeout, requireDispatch), record);
    return { session: repeated, ...messages, isIdle: !active.running && !inbox.length && messages.terminal,
      stable: session.bindingHash === repeated.bindingHash };
  }
  const entriesPath = (record: Owned) => `/api/experimental/session/${record.session.sessionId}/instructions/entries`;
  async function pagedMessages(
    record: Owned,
    cfg: Configuration,
    signal: AbortSignal,
    requireDispatch: boolean,
  ) {
    const rows: Record<string, any>[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null,
      bytes = 0;
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(cfg.requestTimeout)]);
    const ids = new Set<string>();
    for (let page = 0; page <= OPENCODE_EVIDENCE_LIMITS.messages; page++) {
      authority(record);
      if (requireDispatch) dispatch(record);
      signalValid(bounded);
      const route =
        `/api/session/${record.session.sessionId}/message?limit=1` +
        (cursor === null ? '&order=asc' : `&cursor=${encodeURIComponent(cursor)}`);
      const value = await json(record, cfg, route, 'GET', undefined, bounded, 1024 * 1024, cfg.requestTimeout, requireDispatch);
      let decoded: ReturnType<typeof decodeMessagePage>;
      try { decoded = decodeMessagePage(value, record.session.sessionId, { privacy: 'public' }); }
      catch { throw fail('unverified'); }
      const result = object(value)!;
      authority(record);
      if (requireDispatch) dispatch(record);
      if (!Array.isArray(result.data) || result.data.length > 1) throw fail('unverified');
      bytes += Buffer.byteLength(JSON.stringify(result.data));
      if (
        bytes > OPENCODE_EVIDENCE_LIMITS.sourceBytes ||
        rows.length + result.data.length > OPENCODE_EVIDENCE_LIMITS.messages
      )
        throw fail('unverified');
      for (const row of result.data) { if (ids.has(row.id)) throw fail('unverified'); ids.add(row.id); }
      rows.push(...result.data);
      const next = decoded.nextCursor;
      if (!result.data.length) { if (next !== null) throw fail('unverified'); return rows; }
      if (
        next === null ||
        cursors.has(next)
      )
        throw fail('unverified');
      cursors.add(next);
      cursor = next;
    }
    throw fail('unverified');
  }
  async function settle(
    record: Owned,
    cfg: Configuration,
    signal: AbortSignal,
    expected = true,
    requireDispatch = false,
  ): Promise<void> {
    for (let poll = 0; poll < 1000; poll++) {
      const state = await snapshot(record, cfg, signal, expected, requireDispatch);
      if (state.stable && state.isIdle && state.pending === 0) return;
      await pause(cfg.pollInterval, signal);
    }
    throw fail('timeout', true);
  }
  function abort(record: Owned, cfg: Configuration): Promise<void> {
    // A concurrent run failure/quiesce shares one native abort, never a replayed prompt or cleanup loop.
    return (record.abort ??= (async () => {
      const stop = AbortSignal.timeout(cfg.abortTimeout);
      await json(record, cfg, '/api/info', 'GET', undefined, stop, 16384);
      bound(
        await json(
          record,
          cfg,
          `/api/session/${record.session.sessionId}`,
          'GET',
          undefined,
          stop,
          65536,
        ),
        record,
      );
      const interrupted = object(await json(
          record,
          cfg,
          `/api/session/${record.session.sessionId}/interrupt?resume=false`,
          'POST',
          undefined,
          stop,
          16384,
        ));
      if (!interrupted || typeof interrupted.interrupted !== 'boolean') throw fail('unavailable', true);
      await settle(record, cfg, stop, false);
      await json(record, cfg, '/api/info', 'GET', undefined, stop, 16384);
    })());
  }
  function exclusive(record: Owned): void {
    if (record.locked) throw fail('unverified');
    record.locked = true;
  }
  const driver: OpenCodeManagedDriver = {
    caps: OPENCODE2_MANAGED_CAPS,
    async create(input, signal) {
      requirePublicInput(input);
      let attempted = false;
      let record: Owned | undefined;
      try {
        signalValid(signal);
        exactKeys(input, [
          'privacy',
          'ownerId',
          'generation',
          'requestId',
          'cwd',
          'model',
          'effort',
          'access',
        ]);
        const ownerId = own(input, 'ownerId');
        const generation = own(input, 'generation');
        const requestId = own(input, 'requestId');
        const cwd = own(input, 'cwd');
        const access = own(input, 'access');
        if (
          !string(ownerId, 200) ||
          !integer(generation) ||
          !string(requestId, 200) ||
          !string(cwd, 4096) ||
          !path.isAbsolute(cwd) ||
          path.resolve(cwd) !== cwd ||
          (access !== 'read' && access !== 'edit')
        )
          throw fail('invalid');
        const selection = openCodeSelection(own(input, 'model'), own(input, 'effort'));
        const model = `${selection.providerID}/${selection.modelID}`;
        deps().assertOwner({ ownerId, generation });
        const key = JSON.stringify([ownerId, generation, requestId]);
        if (attempts.has(key) || attempts.size >= 64 || sessions.size >= 16)
          throw fail('unverified');
        const cfg = configuration();
        signal = AbortSignal.any([signal, AbortSignal.timeout(cfg.requestTimeout)]);
        const agent = own(settings, 'agent') ?? 'build';
        if (!string(agent, 100) || !/^[A-Za-z0-9_-]+$/.test(agent)) throw fail('invalid');
        record = {
          session: { hostId: 'opencode', sessionId: identifier('ses'), ownerId, generation, model, access },
          cwd,
          selection,
          agent,
          association: identifier('owned'),
          phase: 'fresh',
          locked: false,
          users: new Map(),
          assistants: new Set(),
          idles: new Set(),
          turns: new Set(),
          freshAttempted: false,
        };
        await json(record, cfg, '/api/info', 'GET', undefined, signal, 16384);
        record.modelHash = availableModel(
          await json(record, cfg, `/api/model?location[directory]=${encodeURIComponent(cwd)}`, 'GET', undefined, signal, 4 * 1024 * 1024),
          selection,
          cwd,
        );
        await json(record, cfg, '/api/info', 'GET', undefined, signal, 16384);
        attempts.add(key);
        attempted = true;
        const value = await json(
          record,
          cfg,
          '/api/session',
          'POST',
          {
            id: record.session.sessionId,
            location: { directory: cwd },
            agent,
            model: {
              id: selection.modelID,
              providerID: selection.providerID,
              variant: selection.variant,
            },
            permissions: openCodePermissions(access),
            metadata: { bosun: { ownerId, generation, association: record.association } },
          },
          signal,
          65536,
        );
        const created = bound(value, record);
        if (sessions.has(created.id)) throw fail('unverified');
        record.identityHash = created.identityHash;
        bound(value, record);
        const state = await snapshot(record, cfg, signal);
        if (!state.stable || !state.isIdle || state.pending || state.rows.length || state.session.idleAt !== undefined) throw fail('unverified');
        sessions.set(created.id, record);
        return { ...record.session };
      } catch (e) {
        if (record && attempted) record.phase = 'unknown';
        throw normalize(e, attempted);
      }
    },
    async seed(session, input, signal) {
      requirePublicInput(input); // before text/hash/session/config/dependency getters
      let record: Owned | undefined;
      let attempted = false;
      let locked = false;
      try {
        exactKeys(input, ['privacy', 'text', 'hash']);
        const text = own(input, 'text');
        const suppliedHash = own(input, 'hash');
        if (typeof text === 'string') screenPublicText(text);
        if (
          typeof text !== 'string' ||
          !text.trim() ||
          text.includes('\0') ||
          Buffer.byteLength(text) > 16384 ||
          !hashValue(suppliedHash) ||
          digest(text) !== suppliedHash
        )
          throw fail('invalid');
        signalValid(signal);
        record = owned(session);
        if (record.phase !== 'fresh' || record.fence) throw fail('unverified');
        exclusive(record);
        locked = true;
        const cfg = configuration();
        signal = AbortSignal.any([signal, AbortSignal.timeout(cfg.requestTimeout)]);
        await json(record, cfg, '/api/info', 'GET', undefined, signal, 16384);
        const before = await snapshot(record, cfg, signal);
        if (!before.stable || !before.isIdle || before.rows.length || record.fence) throw fail('unverified');
        const binding = {
          key: 'bosun.seed.' + digest(record.association + identifier('seed')),
          text,
          hash: suppliedHash,
        };
        const model = availableModel(await json(record, cfg, `/api/model?location[directory]=${encodeURIComponent(record.cwd)}`,
          'GET', undefined, signal, 4 * 1024 * 1024), record.selection, record.cwd);
        if (model !== record.modelHash) throw fail('unverified');
        await json(record, cfg, '/api/info', 'GET', undefined, signal, 16384);
        bound(await json(record, cfg, `/api/session/${record.session.sessionId}`, 'GET', undefined, signal, 65536), record);
        record.seed = binding;
        attempted = true;
        authority(record); signalValid(signal);
        await httpNoContent(cfg.base + entriesPath(record) + '/' + binding.key, {
          method: 'PUT', headers: { ...cfg.headers, 'content-type': 'application/json' }, signal,
          body: JSON.stringify({ value: text }),
        }, cfg.requestTimeout);
        authority(record);
        seedReadback(await json(record, cfg, entriesPath(record), 'GET', undefined, signal, 65536), record);
        const after = await snapshot(record, cfg, signal);
        if (!after.stable || !after.isIdle || after.pending || after.rows.length) throw fail('unverified');
        await json(record, cfg, '/api/info', 'GET', undefined, signal, 16384);
        record.phase = 'seeded';
      } catch (e) {
        if (record && attempted) record.phase = 'unknown';
        throw normalize(e, attempted);
      } finally {
        if (record && locked) record.locked = false;
      }
    },
    async ready(session, expected, signal) {
      let record: Owned | undefined;
      let locked = false;
      try {
        signalValid(signal);
        exactKeys(expected, ['seedHash', 'model', 'access']);
        record = owned(session);
        if (
          record.phase !== 'seeded' ||
          !record.seed ||
          own(expected, 'seedHash') !== record.seed.hash ||
          own(expected, 'model') !== record.session.model ||
          own(expected, 'access') !== record.session.access
        )
          throw fail('unverified');
        exclusive(record);
        locked = true;
        const cfg = configuration();
        signal = AbortSignal.any([signal, AbortSignal.timeout(cfg.requestTimeout)]);
        await json(record, cfg, '/api/info', 'GET', undefined, signal, 16384);
        const state = await snapshot(record, cfg, signal);
        if (!state.stable || !state.isIdle || state.pending || state.rows.length) throw fail('unverified');
        seedReadback(await json(record, cfg, entriesPath(record), 'GET', undefined, signal, 65536), record);
        if (availableModel(await json(record, cfg, `/api/model?location[directory]=${encodeURIComponent(record.cwd)}`,
          'GET', undefined, signal, 4 * 1024 * 1024), record.selection, record.cwd) !== record.modelHash) throw fail('unverified');
        await json(record, cfg, '/api/info', 'GET', undefined, signal, 16384);
        record.phase = 'ready';
        return {
          sessionId: record.session.sessionId,
          root: true,
          idle: true,
          seedHash: record.seed.hash,
          model: record.session.model,
          access: record.session.access,
          generation: record.session.generation,
        };
      } catch (e) {
        if (record && locked && e instanceof BosunError && e.code !== 'cancelled')
          record.phase = 'invalid';
        throw normalize(e);
      } finally {
        if (record && locked) record.locked = false;
      }
    },
    async run(session, input, signal) {
      requirePublicInput(input);
      let record: Owned | undefined;
      let attempted = false;
      let locked = false;
      try {
        exactKeys(input, ['privacy', 'text', 'turnId']);
        signalValid(signal);
        const text = own(input, 'text');
        const turnId = own(input, 'turnId');
        if (typeof text === 'string') screenPublicText(text);
        if (
          typeof text !== 'string' ||
          !text.trim() ||
          text.includes('\0') ||
          Buffer.byteLength(text) > 32768 ||
          !string(turnId, 200)
        )
          throw fail('invalid');
        record = owned(session);
        if (
          record.phase !== 'ready' ||
          record.fence ||
          record.turns.has(turnId) ||
          record.turns.size >= 32
        )
          throw fail('unverified');
        dispatch(record); // Bootstrap permission never authorizes a staged destination work turn.
        exclusive(record);
        locked = true;
        const cfg = configuration();
        record.active = new AbortController();
        record.abort = undefined;
        const bounded = AbortSignal.any([
          signal,
          record.active.signal,
          AbortSignal.timeout(cfg.runTimeout),
        ]);
        await json(record, cfg, '/api/info', 'GET', undefined, bounded, 16384, cfg.requestTimeout, true);
        const before = await snapshot(record, cfg, bounded, true, true);
        if (!before.stable || !before.isIdle || before.pending || record.fence) throw fail('unverified');
        if (availableModel(await json(record, cfg, `/api/model?location[directory]=${encodeURIComponent(record.cwd)}`,
          'GET', undefined, bounded, 4 * 1024 * 1024, cfg.requestTimeout, true), record.selection, record.cwd) !== record.modelHash) throw fail('unverified');
        await json(record, cfg, '/api/info', 'GET', undefined, bounded, 16384, cfg.requestTimeout, true);
        bound(await json(record, cfg, `/api/session/${record.session.sessionId}`, 'GET', undefined, bounded, 65536,
          cfg.requestTimeout, true), record);
        const binding = {
          messageID: identifier('msg'),
          hash: digest(text),
        };
        record.users.set(binding.messageID, binding);
        record.activeMessage = binding.messageID;
        record.turns.add(turnId);
        attempted = true;
        const response = await json(
          record,
          cfg,
          `/api/session/${record.session.sessionId}/prompt`,
          'POST',
          {
            id: binding.messageID,
            text,
            delivery: 'queue',
            resume: true,
          },
          bounded,
          1024 * 1024,
          cfg.runTimeout,
          true,
        );
        validateAdmission(response, record.session.sessionId, binding.messageID, text);
        let final: Awaited<ReturnType<typeof snapshot>> | undefined;
        for (let poll = 0; poll < 1000; poll++) {
          const state = await snapshot(record, cfg, bounded, false, true);
          const last = state.decoded.at(-1);
          if (last?.type === 'idle' && last.outcome !== 'succeeded') throw fail('unavailable', true);
          if (state.stable && state.isIdle && last?.type === 'idle') {
            if (state.pending || state.session.outcome !== 'succeeded' || state.session.idleAt === undefined ||
              state.session.idleAt < last.created) throw fail('unavailable', true);
            final = state; break;
          }
          await pause(cfg.pollInterval, bounded);
        }
        if (!final) throw fail('timeout', true);
        if (nativeHash(final.rows.slice(0, before.rows.length)) !== nativeHash(before.rows)) throw fail('unverified', true);
        const events = completion(final.rows.slice(before.rows.length), {
          id: record.session.sessionId, cwd: record.cwd, selection: record.selection,
          access: record.session.access, agent: record.agent, association: record.association,
        }, binding.messageID, text);
        const repeated = await snapshot(record, cfg, bounded, false, true);
        if (!repeated.stable || !repeated.isIdle || repeated.pending || nativeHash(final.rows) !== nativeHash(repeated.rows) ||
          final.session.bindingHash !== repeated.session.bindingHash) throw fail('unverified', true);
        await json(record, cfg, '/api/info', 'GET', undefined, bounded, 16384, cfg.requestTimeout, true);
      for (const message of final.decoded) {
          if (message.type === 'assistant') record.assistants.add(message.id);
          if (message.type === 'idle') record.idles.add(message.id);
        }
        if (record.fence) throw fail('cancelled', true);
        return events;
      } catch (e) {
        if (record && attempted) {
          record.phase = 'unknown';
          try {
            await abort(record, configuration());
          } catch {}
        }
        throw normalize(e, attempted);
      } finally {
        if (record && locked) {
          record.locked = false;
          record.active = undefined;
          if (record.phase !== 'unknown') record.activeMessage = undefined;
        }
      }
    },
    async observeContext(session, signal) {
      let record: Owned | undefined;
      try {
        signalValid(signal);
        record = owned(session, true);
        const now = deps().now();
        if (!integer(now)) throw fail('invalid');
        const unknown = (generation = record!.session.generation): ContextSample => ({
          sessionId: record!.session.sessionId,
          turnId: '',
          modelId: record!.session.model,
          usedTokens: null,
          windowTokens: null,
          scope: 'unknown',
          quality: 'unknown',
          observedAt: now,
          generation,
        });
        if (record.phase === 'invalid' || record.phase === 'unknown')
          return unknown(record.session.generation + 1);
        const cfg = configuration();
        await json(record, cfg, '/api/info', 'GET', undefined, signal, 16384);
        try {
          const state = await snapshot(record, cfg, signal);
          if (!state.stable || !state.isIdle || state.pending) return unknown();
          // Catalog max/cumulative billing are not a qualified effective active window/occupancy.
          return contextCandidate(state.session, state.decoded.toReversed(), {
            now,
            generation: record.session.generation,
            selection: record.selection,
            running: !state.isIdle,
          }).sample;
        } catch (e) {
          if (e instanceof BosunError && ['unverified', 'unsupported'].includes(e.code)) {
            record.phase = 'invalid';
            return unknown(record.session.generation + 1);
          }
          throw e;
        }
      } catch (e) {
        throw normalize(e);
      }
    },
    async fenceAdmission(session, signal) {
      try {
        signalValid(signal);
        const record = owned(session);
        if (!record.fence)
          record.fence = {
            sessionId: record.session.sessionId,
            generation: record.session.generation,
            token: identifier('fence'),
          };
        // Stops this driver's admissions before HTTP; it does not fence arbitrary native clients/plugins.
        const cfg = configuration();
        await json(record, cfg, '/api/info', 'GET', undefined, signal, 16384);
        bound(
          await json(
            record,
            cfg,
            `/api/session/${record.session.sessionId}`,
            'GET',
            undefined,
            signal,
            65536,
          ),
          record,
        );
        return { ...record.fence };
      } catch (e) {
        throw normalize(e);
      }
    },
    async capture(session, input, signal) {
      requirePublicInput(input); // before cursor/session/native source getters
      const after = evidenceCursor(input);
      let record: Owned | undefined;
      let locked = false;
      try {
        signalValid(signal);
        record = owned(session);
        if (record.phase !== 'ready' || record.locked) throw fail('unverified');
        exclusive(record);
        locked = true;
        const cfg = configuration();
        const bounded = AbortSignal.any([signal, AbortSignal.timeout(cfg.requestTimeout)]);
        await json(record, cfg, '/api/info', 'GET', undefined, bounded, 16384);
        const before = await snapshot(record, cfg, bounded);
        if (!before.stable || !before.isIdle || before.pending) throw fail('unverified');
        const binding = { cwd: record.cwd, association: record.association, serverVersion: record.serverVersion!, seed: record.seed };
        const captured = captureOpenCodeEvidence(
          record.session,
          before.rows,
          after,
          digest,
          binding,
        );
        const afterState = await snapshot(record, cfg, bounded);
        if (!afterState.stable || !afterState.isIdle || afterState.pending) throw fail('unverified');
        const repeated = captureOpenCodeEvidence(
          record.session,
          afterState.rows,
          after,
          digest,
          binding,
        );
        if (JSON.stringify(captured) !== JSON.stringify(repeated)) throw fail('unverified');
        await json(record, cfg, '/api/info', 'GET', undefined, bounded, 16384);
        owned(record.session);
        signalValid(bounded);
        return captured;
      } catch (error) {
        throw normalize(error);
      } finally {
        if (record && locked) record.locked = false;
      }
    },
    async quiesce(session, fence, signal): Promise<Quiescence> {
      try {
        signalValid(signal);
        const record = owned(session, true);
        if (
          !record.fence ||
          ['sessionId', 'generation', 'token'].some(
            (key) => own(fence, key) !== own(record.fence, key),
          )
        )
          throw fail('unverified');
        const cfg = configuration();
        await json(record, cfg, '/api/info', 'GET', undefined, signal, 16384);
        const state = await snapshot(record, cfg, signal, false);
        if (!state.stable || !state.isIdle || state.pending) {
          if (cfg.mode === 'abort') {
            record.active?.abort();
            await abort(record, cfg);
          } else
            await settle(
              record,
              cfg,
              AbortSignal.any([signal, AbortSignal.timeout(cfg.abortTimeout)]),
              false,
            );
        }
        authority(record);
        signalValid(signal);
        return {
          sessionId: record.session.sessionId,
          generation: record.session.generation,
          pendingTools: 0,
          idle: true,
        };
      } catch (e) {
        throw normalize(e, true);
      }
    },
    async startFresh(source, signal) {
      try {
        signalValid(signal);
        const record = owned(source);
        if (!record.fence || record.freshAttempted) throw fail('unverified');
        const selected = deps();
        if (!selected.freshClaim || !selected.assertDispatchOwner) throw fail('unverified');
        const claim = selected.freshClaim({ ...record.session });
        const ownerId = own(claim, 'ownerId');
        const generation = own(claim, 'generation');
        if (
          !string(ownerId, 200) ||
          !integer(generation) ||
          !Number.isSafeInteger(record.session.generation + 1) ||
          generation !== record.session.generation + 1
        )
          throw fail('unverified');
        selected.assertOwner({ ownerId, generation });
        await driver.quiesce(source, record.fence, signal);
        owned(source);
        record.freshAttempted = true;
        // The controller supplies its already staged next-generation claim; only its dispatch gate can activate it after CAS.
        return await driver.create(
          {
            privacy: 'public',
            ownerId,
            generation,
            requestId: identifier('fresh'),
            cwd: record.cwd,
            model: record.session.model,
            ...(record.selection.variant === 'default' ? {} : { effort: record.selection.variant }),
            access: record.session.access,
          },
          signal,
        );
      } catch (e) {
        throw normalize(e, e instanceof BosunError && e.details?.outcome === 'unknown');
      }
    },
    async resumeFenced(session, fence, signal) {
      let record: Owned | undefined;
      let locked = false;
      try {
        signalValid(signal);
        record = owned(session);
        if (
          !record.fence ||
          ['sessionId', 'generation', 'token'].some(
            (key) => own(fence, key) !== own(record!.fence, key),
          )
        )
          throw fail('unverified');
        dispatch(record);
        exclusive(record);
        locked = true;
        const cfg = configuration();
        await json(record, cfg, '/api/info', 'GET', undefined, signal, 16384, cfg.requestTimeout, true);
        const state = await snapshot(record, cfg, signal, true, true);
        if (!state.stable || !state.isIdle || state.pending) throw fail('unverified');
        owned(session);
        dispatch(record);
        signalValid(signal);
        // Caller must first prove no transfer/uncertain destination. Clearing this local fence never restarts or replays a turn.
        record.fence = undefined;
      } catch (e) {
        throw normalize(e);
      } finally {
        if (record && locked) record.locked = false;
      }
    },
  };
  return driver;
}
