import './bootstrap.ts';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import { BosunError } from '../src/core/errors.ts';
import { createOpenCodeControl, type OpenCodeControlSettings, type OpenCodeControlDependencies } from '../src/adapters/hosts/opencode/control.ts';
export const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/opencode-v2.0.27.json', import.meta.url), 'utf8'));
const hash = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}
type Options = {
  version?: string; modifyCreate?: (value: any, index: number) => void;
  modifySeed?: (entry: any) => void; modifyReadback?: (entry: any) => void;
  modifyHistory?: (rows: any[]) => void; modifyCompletion?: (row: any) => void;
  createFault?: boolean; seedFault?: boolean; turnFault?: boolean;
  holdTurn?: boolean; holdAbort?: boolean; busyAfterSeed?: boolean;
  nextCursor?: string; hideCursor?: boolean; seedStatus?: number;
  pid?: number; extraEntries?: any[]; pendingInbox?: any[];
};
export async function nativeOpenCodeFixture(options: Options = {}) {
  const requests: { method: string; path: string; body: any }[] = [];
  const sessions = new Map<string, { value: any; messages: any[]; entries: any[]; busy: boolean }>();
  const started = deferred(), aborted = deferred(), status = deferred();
  let serial = 0, currentGeneration = 5;
  const server = http.createServer((req, res) => {
    let source = ''; req.on('data', (chunk) => { source += chunk; });
    req.on('end', () => {
      const body = source ? JSON.parse(source) : undefined;
      const url = new URL(req.url!, 'http://fixture'), route = url.pathname;
      requests.push({ method: req.method!, path: req.url!, body });
      const send = (value: unknown, code = 200) => {
        if (res.destroyed) return;
        res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(value));
      };
      if (route === '/api/info') return send({ ...fixture.server, version: options.version ?? '2.0.27', pid: options.pid ?? 4242 });
      if (route === '/api/model') return send({ location: { directory: url.searchParams.get('location[directory]') }, data: [{
        id: 'gpt-6.1-sol', modelID: 'gpt-6.1-sol', providerID: 'openai', enabled: true,
        variants: [{ id: 'high' }], capabilities: { tools: true, input: ['text'], output: ['text'] },
        name: 'Invented model', time: { released: 0 }, cost: [], status: 'active', limit: { context: 1000000, output: 8192 },
      }] });
      if (route === '/api/session' && req.method === 'POST') {
        const value = { ...structuredClone(fixture.session.data), id: body.id, location: body.location,
          time: { created: 1000, updated: 1000 }, agent: body.agent, model: body.model,
          permissions: body.permissions, metadata: body.metadata };
        options.modifyCreate?.(value, sessions.size + 1);
        sessions.set(body.id, { value, messages: [], entries: [], busy: false });
        if (options.createFault) return req.socket.destroy();
        return send({ data: value });
      }
      if (route === '/api/session/active') {
        status.resolve(); return send({ data: Object.fromEntries([...sessions].filter(([, s]) => s.busy).map(([id]) => [id, { type: 'running' }])) });
      }
      const match = /^\/api\/(experimental\/)?session\/([^/]+)(?:\/(.*))?$/.exec(route);
      const sessionID = match?.[2], action = match?.[3];
      const session = sessionID ? sessions.get(sessionID) : undefined;
      if (!session) return send({ error: 'SECRET-FOREIGN-SESSION' }, 404);
      if (!action) return send({ data: session.value });
      if (action === 'instructions/entries') {
        const entries = structuredClone(session.entries);
        entries.forEach((entry) => options.modifyReadback?.(entry));
        return send({ data: [...entries, ...(options.extraEntries ?? [])] });
      }
      if (action?.startsWith('instructions/entries/') && req.method === 'PUT') {
        const entry = { key: action.slice('instructions/entries/'.length), value: body.value };
        options.modifySeed?.(entry); session.entries.push(entry);
        if (options.seedFault) return req.socket.destroy();
        session.busy = options.busyAfterSeed ?? false;
        if ((options.seedStatus ?? 204) !== 204) return send({ error: 'SECRET-SEED-STATUS' }, options.seedStatus);
        res.writeHead(204); return res.end();
      }
      if (action === 'inbox') return send({ data: options.pendingInbox ?? [] });
      if (action === 'interrupt') {
        aborted.resolve(); if (!options.holdAbort) finish(sessionID);
        return send({ interrupted: true });
      }
      if (action === 'message' && req.method === 'GET') {
        const rows = structuredClone(session.messages); options.modifyHistory?.(rows);
        const limit = Number(url.searchParams.get('limit'));
        const offset = Number((url.searchParams.get('cursor') ?? 'c_0').slice(2));
        const data = rows.slice(Number.isFinite(offset) ? offset : 0, (Number.isFinite(offset) ? offset : 0) + limit);
        return send({ data, cursor: data.length && !options.hideCursor ? { next: options.nextCursor ?? 'c_' + (offset + data.length) } : {} });
      }
      if (action === 'prompt' && req.method === 'POST') {
        const user = { id: body.id, type: 'user', time: { created: 90000 }, text: body.text };
        session.messages.push(user); session.busy = true; started.resolve();
        const number = session.messages.length;
        const assistant = { ...structuredClone(fixture.page.data[1]), id: `msg_assistant_${number}`,
          model: session.value.model, agent: session.value.agent,
          time: { created: 99000, streamed: 99980, ...(options.holdTurn ? {} : { completed: 100000 }) },
          content: [{ type: 'text', text: 'Synthetic fixture response only.' },
            { type: 'tool', id: `call_${number}`, name: 'read', time: { created: 99000 }, state: {
              status: options.holdTurn ? 'running' : 'completed', input: { secret: 'SECRET-TOOL-INPUT' },
              content: [{ type: 'text', text: 'SECRET-TOOL-OUTPUT' }],
            } }],
        };
        options.modifyCompletion?.(assistant); session.messages.push(assistant);
        if (!options.holdTurn) {
          session.messages.push({ id: `msg_idle_${number}`, type: 'idle', time: { created: 100000 }, outcome: 'succeeded' });
          session.busy = false; session.value.time.idle = 100000; session.value.outcome = 'succeeded';
        }
        session.value.time.updated = 100000;
        if (options.turnFault) return req.socket.destroy();
        return send({ data: { id: body.id, sessionID, type: 'user', time: { created: 90000 },
          payload: { text: body.text }, delivery: body.delivery } });
      }
      return send({ error: 'SECRET-UNSUPPORTED-ROUTE' }, 404);
    });
  });
  function finish(id?: string) {
    for (const [sessionID, session] of sessions) if (!id || sessionID === id) {
      session.busy = false;
      for (const row of session.messages) if (row.type === 'assistant') {
        row.time.completed ??= 100000;
        for (const part of row.content) if (part.type === 'tool' && ['streaming', 'running'].includes(part.state.status)) part.state.status = 'completed';
      }
      if (session.messages.length && session.messages.at(-1).type !== 'idle') {
        session.messages.push({ id: 'msg_interrupted_' + session.messages.length, type: 'idle',
          time: { created: 100000 }, outcome: 'interrupted' });
        session.value.time.idle = 100000; session.value.outcome = 'interrupted';
      }
    }
  }
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const deps = { assertOwner(expected: { ownerId: string; generation: number }) {
    if (expected.ownerId !== 'owner_fixture' || expected.generation !== currentGeneration) throw new BosunError('unverified', 'Owner unavailable');
  }, hash, now: () => 100001, id: () => `fixture_${++serial}` };
  const driver = (extra: Partial<OpenCodeControlSettings> = {}, injected: Partial<OpenCodeControlDependencies> = {}) =>
    createOpenCodeControl({ url, requestTimeoutMs: 1000, runTimeoutMs: 2000, abortTimeoutMs: 1000, pollIntervalMs: 5, ...extra }, { ...deps, ...injected });
  return { url, requests, sessions, options, driver, deps, started: started.promise, aborted: aborted.promise, status: status.promise,
    finish, changeOwner() { currentGeneration++; },
    async close() { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}
