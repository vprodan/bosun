// Pinned native OpenCode 2 only. No SDK, spawn, auth mutation or implicit server start.
import crypto from 'node:crypto';
import { BosunError } from '../../../core/errors.ts';
import { requirePublicInput } from '../../../core/policy.ts';
import type { AgentRunner } from '../../../core/ports/runner.ts';
import { httpJson } from '../../../platform/http-json.ts';
import { decodeServerInfo, decodeMessagePage, decodeActive } from './v2-protocol.ts';
import { OPENCODE2_VERSION } from '../../../core/domain/host-install.ts';
import { failure, requestConfiguration, requestSpec, availableModel, validateSession, validateAdmission,
  pendingInbox, inspectHistory, object, hash, pause, completion, openCodePermissions,
  type SessionBinding, type OpenCodeRunnerSettings } from './v2-native.ts';
export { openCodeSelection, openCodePermissions, type OpenCodeRunnerSettings } from './v2-native.ts';

export function createOpenCodeRunner(settings: OpenCodeRunnerSettings): AgentRunner {
  // Capturing settings does not read URL/environment properties, probe, load a SDK or start a server.
  return {
    id: 'opencode', caps: { vendor: 'opencode', readOnly: 'verified', sandbox: 'tool-allowlist',
      mcpInject: 'unsupported', effort: 'verified', localBackend: 'verified', billing: 'unknown' },
    async detect(env) {
      try {
        const cfg = requestConfiguration(settings, env);
        decodeServerInfo(await httpJson(cfg.base + '/api/info', { method: 'GET', headers: cfg.headers, signal: AbortSignal.timeout(cfg.requestTimeout) }, cfg.requestTimeout, 16384));
        return { installed: true, version: OPENCODE2_VERSION, notes: ['Pinned V2 native HTTP; live host/plugin qualification pending'] };
      } catch { return { installed: false, notes: ['OpenCode endpoint unavailable or unsupported'] }; }
    },
    async *run(spec) {
      requirePublicInput(spec);
      let requested: ReturnType<typeof requestSpec>; let cfg: ReturnType<typeof requestConfiguration>;
      try { requested = requestSpec(spec, settings); cfg = requestConfiguration(settings, requested.env); }
      catch (e) { throw failure(e instanceof BosunError ? e.code : 'invalid'); }
      if (requested.signal.aborted) throw failure('cancelled');
      const timeout = AbortSignal.timeout(cfg.runTimeout); const signal = AbortSignal.any([requested.signal, timeout]);
      const headers = { ...cfg.headers, 'content-type': 'application/json' };
      const json = (route: string, method: string, body: unknown, requestSignal: AbortSignal, maximum: number, requestTimeout = cfg.requestTimeout) =>
        httpJson(cfg.base + route, { method, headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: requestSignal }, requestTimeout, maximum);
      const binding: SessionBinding = { id: `ses_${crypto.randomUUID().replaceAll('-', '')}`,
        association: crypto.randomUUID(), cwd: requested.cwd, selection: requested.selection,
        access: requested.access, agent: requested.agent };
      const messageID = `msg_${crypto.randomUUID().replaceAll('-', '')}`;
      let serverPid: number | undefined, identityHash: string | undefined;
      let mutationAttempted = false, promptAttempted = false;
      const modelPath = `/api/model?location[directory]=${encodeURIComponent(requested.cwd)}`;
      const sessionPath = `/api/session/${binding.id}`;
      async function serverIdentity(current: AbortSignal) {
        const info = decodeServerInfo(await json('/api/info', 'GET', undefined, current, 16384));
        if (serverPid !== undefined && info.pid !== serverPid) throw failure('unverified');
        return info;
      }
      async function bound(current: AbortSignal) {
        const result = validateSession(await json(sessionPath, 'GET', undefined, current, 65536), binding);
        if (identityHash !== undefined && result.identityHash !== identityHash) throw failure('unverified');
        return result;
      }
      async function messages(current: AbortSignal) {
        const rows: Record<string, any>[] = [], cursors = new Set<string>(), ids = new Set<string>();
        let cursor: string | null = null, bytes = 0;
        const bounded = AbortSignal.any([current, AbortSignal.timeout(cfg.requestTimeout)]);
        for (let pages = 0; pages < 129; pages++) {
          const route = sessionPath + '/message?limit=32' + (cursor === null ? '&order=asc' : `&cursor=${encodeURIComponent(cursor)}`);
          const value = await json(route, 'GET', undefined, bounded, 1024 * 1024);
          const page = decodeMessagePage(value, binding.id, { privacy: 'public' });
          const raw = object(value)!.data as Record<string, any>[];
          bytes += Buffer.byteLength(JSON.stringify(raw));
          if (raw.length > 32 || rows.length + raw.length > 128 || bytes > 4 * 1024 * 1024) throw failure('unverified');
          for (const row of raw) { if (ids.has(row.id)) throw failure('unverified'); ids.add(row.id); }
          rows.push(...raw);
          // The pinned handler returns anchors even on a short page. Reach an
          // empty terminal page; a missing cursor on nonempty data is truncation.
          if (!raw.length) { if (page.nextCursor !== null) throw failure('unverified'); return rows; }
          if (page.nextCursor === null || cursors.has(page.nextCursor)) throw failure('unverified');
          cursors.add(page.nextCursor); cursor = page.nextCursor;
        }
        throw failure('unverified');
      }
      async function snapshot(current: AbortSignal) {
        const before = await bound(current);
        const rows = await messages(current);
        const history = inspectHistory(rows, binding, messageID, requested.prompt);
        const inbox = pendingInbox(await json(sessionPath + '/inbox', 'GET', undefined, current, 65536), binding.id, messageID, requested.prompt);
        const active = decodeActive(await json('/api/session/active', 'GET', undefined, current, 256 * 1024), binding.id, { privacy: 'public' });
        const after = await bound(current);
        return { rows, ...history, inbox, running: active.running, session: after, stable: before.bindingHash === after.bindingHash };
      }
      async function abortAndSettle(): Promise<void> {
        const stop = AbortSignal.timeout(cfg.abortTimeout);
        await serverIdentity(stop); await bound(stop); // Never interrupt a replaced server or foreign/rebound root.
        const reply = object(await json(sessionPath + '/interrupt?resume=false', 'POST', undefined, stop, 16384));
        if (!reply || typeof reply.interrupted !== 'boolean') throw failure('unavailable', true);
        // Interruption only acknowledges acceptance; await the original model
        // tools/terminal and empty inbox as well as process-local inactivity.
        for (let polls = 0; polls < 1000; polls++) {
          const state = await snapshot(stop);
          if (state.stable && !state.running && !state.pendingTools && !state.inbox && state.terminal) {
            await serverIdentity(stop); return;
          }
          await pause(cfg.pollInterval, stop);
        }
        throw failure('unavailable', true);
      }
      try {
        serverPid = (await serverIdentity(signal)).pid;
        const modelHash = availableModel(await json(modelPath, 'GET', undefined, signal, 4 * 1024 * 1024), requested.selection, requested.cwd);
        await serverIdentity(signal);
        mutationAttempted = true;
        const created = validateSession(await json('/api/session', 'POST', { id: binding.id, agent: requested.agent,
          location: { directory: requested.cwd }, model: { id: requested.selection.modelID, providerID: requested.selection.providerID, variant: requested.selection.variant },
          permissions: openCodePermissions(requested.access), metadata: { bosun: { association: binding.association } } }, signal, 65536), binding);
        identityHash = created.identityHash;
        const initial = await snapshot(signal);
        if (!initial.stable || initial.running || initial.rows.length || initial.inbox || initial.session.idleAt !== undefined) throw failure('unverified');
        if (availableModel(await json(modelPath, 'GET', undefined, signal, 4 * 1024 * 1024), requested.selection, requested.cwd) !== modelHash) throw failure('unverified');
        await serverIdentity(signal); await bound(signal);
        promptAttempted = true;
        validateAdmission(await json(sessionPath + '/prompt', 'POST', { id: messageID, text: requested.prompt,
          delivery: 'queue', resume: true }, signal, 65536), binding.id, messageID, requested.prompt);
        let completed: Awaited<ReturnType<typeof snapshot>> | undefined;
        for (let polls = 0; polls < 1000; polls++) {
          const state = await snapshot(signal);
          if (state.terminal && state.terminal.outcome !== 'succeeded') throw failure('unavailable', true);
          if (state.stable && state.terminal && !state.running && !state.pendingTools && !state.inbox) {
            if (state.session.outcome !== 'succeeded' || state.session.idleAt === undefined || state.session.idleAt < state.terminal.created) throw failure('unavailable', true);
            completed = state; break;
          }
          await pause(cfg.pollInterval, signal);
        }
        if (!completed) throw failure('timeout', true);
        const events = completion(completed.rows, binding, messageID, requested.prompt);
        const repeated = await snapshot(signal);
        if (!repeated.stable || repeated.running || repeated.pendingTools || repeated.inbox ||
          hash(repeated.rows) !== hash(completed.rows) || repeated.session.bindingHash !== completed.session.bindingHash) throw failure('unverified', true);
        await serverIdentity(signal);
        for (const event of events) yield event;
      } catch (e) {
        if (promptAttempted) try { await abortAndSettle(); } catch {}
        const interrupted = requested.signal.aborted ? 'cancelled' : timeout.aborted ? 'timeout' : e instanceof BosunError ? e.code : 'unavailable';
        // Create/admission uncertainty stays sticky even if interruption settles.
        // Never retry, wake, delete, cancel a foreign inbox item or adopt an old session.
        throw failure(interrupted, mutationAttempted);
      }
    },
  };
}
