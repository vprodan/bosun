import './bootstrap.ts';
import http from 'node:http';
import { once } from 'node:events';
import { createOpenCodeRunner, type OpenCodeRunnerSettings } from '../src/adapters/hosts/opencode/runner.ts';
import { OPENCODE2_VERSION } from '../src/core/domain/host-install.ts';

export const CWD = '/synthetic/project', MODEL = 'qwen3:8b/tag:exact';
export const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
};
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
export type Recorded = { path: string; method: string; body: any; headers: http.IncomingHttpHeaders };
export type NativeOptions = {
  version?: string; healthStatus?: number; variants?: Record<string, object>; pending?: boolean;
  holdAbort?: boolean; holdCompletion?: boolean; abortReply?: unknown; provider?: string; modelEnabled?: boolean;
  modifySession?: (session: any) => void; modifyCompletion?: (completion: any) => void;
  modifyAdmission?: (admission: any) => void; modifyHistory?: (rows: any[], read: number) => void;
  modifyReadback?: (session: any, read: number) => void; modifyCatalog?: (model: any, read: number) => void;
  modifyInfo?: (info: any, read: number) => void;
  messageFault?: 'drop' | 'malformed' | 'oversize'; createFault?: boolean;
  nextCursor?: string; hideCursor?: boolean; pageSize?: number;
};

// Invented native V2 envelopes. No host executable, SDK, account or model is used.
export async function native(options: NativeOptions = {}) {
  const requests: Recorded[] = [];
  let session: any, rows: any[] = [], inbox: any[] = [], busy = false, promptSent = false;
  let idlePolls = 0, histories = 0, sessionReads = 0, catalogReads = 0, infoReads = 0;
  const started = deferred(), aborted = deferred(), statusRead = deferred();
  const server = http.createServer((req, res) => {
    let source = ''; req.on('data', (chunk) => { source += chunk; });
    req.on('end', async () => {
      const body = source ? JSON.parse(source) : undefined, url = new URL(req.url!, 'http://fixture');
      const route = url.pathname;
      requests.push({ path: req.url!, method: req.method!, body, headers: req.headers });
      const reply = async (value: unknown, chunked = false, status = 200) => {
        if (res.destroyed) return;
        res.writeHead(status, { 'content-type': 'application/json' });
        const json = JSON.stringify(value);
        if (chunked) { res.write(json.slice(0, 63)); await turn(); if (!res.destroyed) res.end(json.slice(63)); }
        else res.end(json);
      };
      if (route === '/api/info') {
        const info = { version: options.version ?? OPENCODE2_VERSION, pid: 4242,
          urls: ['http://127.0.0.1:4096'], paths: { tmp: '/fixture/tmp' } };
        options.modifyInfo?.(info, ++infoReads);
        return reply(options.healthStatus ? { error: req.headers.authorization } : info, false, options.healthStatus ?? 200);
      }
      if (route === '/api/model') {
        const model = { id: MODEL, modelID: MODEL, providerID: options.provider ?? 'ollama', enabled: options.modelEnabled ?? true,
          name: 'Invented model', variants: Object.entries(options.variants ?? { high: {} }).map(([id, settings]) => ({ id, settings })),
          settings: {}, capabilities: { input: ['text'], output: ['text'], tools: true },
          time: { released: 0 }, cost: [], status: 'active', limit: { context: 1000000, output: 8192 } };
        options.modifyCatalog?.(model, ++catalogReads);
        return reply({ location: { directory: url.searchParams.get('location[directory]') }, data: [model] });
      }
      if (route === '/api/session' && req.method === 'POST') {
        session = { id: body.id, projectID: 'project_fixture', title: 'SECRET-SESSION-TITLE',
          location: body.location, time: { created: 10, updated: 10 }, cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          model: body.model, permissions: body.permissions, metadata: body.metadata, agent: body.agent };
        options.modifySession?.(session);
        if (options.createFault) return req.socket.destroy();
        return reply({ data: session });
      }
      if (route === '/api/session/active') {
        if (promptSent) { idlePolls++; statusRead.resolve(); }
        return reply({ data: busy ? { [session.id]: { type: 'running' } } : {} });
      }
      const sessionPath = session ? `/api/session/${session.id}` : '';
      if (route === sessionPath) {
        const copy = structuredClone(session); options.modifyReadback?.(copy, ++sessionReads);
        return reply({ data: copy });
      }
      if (route === sessionPath + '/inbox') return reply({ data: inbox });
      if (route === sessionPath + '/message' && req.method === 'GET') {
        const data = structuredClone(rows); options.modifyHistory?.(data, ++histories);
        const offset = Number((url.searchParams.get('cursor') ?? 'c_0').slice(2));
        const count = Math.min(Number(url.searchParams.get('limit')), options.pageSize ?? 32);
        const page = data.slice(Number.isFinite(offset) ? offset : 0, (Number.isFinite(offset) ? offset : 0) + count);
        return reply({ data: page, cursor: page.length && !options.hideCursor ? { next: options.nextCursor ?? `c_${offset + page.length}` } : {} }, true);
      }
      if (route === sessionPath + '/interrupt') {
        aborted.resolve(); if (!options.holdAbort) finishAbort();
        return reply({ interrupted: options.abortReply ?? true });
      }
      if (route === sessionPath + '/prompt' && req.method === 'POST') {
        busy = true; promptSent = true; started.resolve();
        const admission = { id: body.id, sessionID: session.id, type: 'user', delivery: body.delivery,
          time: { created: 20 }, payload: { text: body.text } };
        inbox = [admission];
        const user = { id: body.id, type: 'user', time: { created: 20 }, text: body.text };
        const tool = { type: 'tool', id: 'call_fixture', name: body.text === 'edit fixture' ? 'patch' : 'read',
          time: { created: 21, ...(options.pending ? {} : { completed: 24 }) },
          state: { status: options.pending ? 'running' : 'completed', input: { file: 'SECRET-TARGET' },
            content: [{ type: 'text', text: 'SECRET-TOOL-OUTPUT' }], metadata: { secret: 'SECRET-METADATA' } } };
        const step = { id: 'msg_step1', type: 'assistant', time: { created: 21, streamed: 22, ...(options.pending ? {} : { completed: 24 }) },
          agent: session.agent, model: session.model, finish: 'tool-calls', content: [tool],
          tokens: { input: 20, output: 3, reasoning: 0, cache: { read: 30, write: 0 } } };
        const assistant = { id: 'msg_step2', type: 'assistant', time: { created: 25, streamed: 29, completed: 30 },
          agent: session.agent, model: session.model, finish: 'stop', cost: 0.01,
          content: [{ type: 'text', text: 'Public bounded result' }, { type: 'reasoning', text: 'SECRET-REASONING' }],
          tokens: { input: 6, output: 4, reasoning: 2, cache: { read: 40, write: 1 } }, providerState: { secret: 'SECRET-STATE' } };
        const idle = { id: 'msg_idle', type: 'idle', time: { created: 31 }, outcome: 'succeeded' };
        rows = options.pending ? [user, step] : [user, step, assistant, idle];
        options.modifyCompletion?.({ user, step, assistant, tool, idle, rows });
        inbox = []; session.time.updated = 30;
        if (!options.pending) { session.time.idle = 31; session.outcome = idle.outcome; }
        if (!options.pending && !options.holdCompletion) busy = false;
        options.modifyAdmission?.(admission);
        if (options.messageFault === 'drop') return req.socket.destroy();
        if (options.messageFault === 'malformed') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{SECRET-BAD'); }
        if (options.messageFault === 'oversize') return reply({ data: { text: 'SECRET-'.repeat(20000) } });
        return reply({ data: admission }, true); // A receipt is NOT the assistant result.
      }
      return reply({ error: 'SECRET-UNKNOWN-ROUTE' }, false, 404);
    });
  });
  function finishAbort() {
    busy = false; inbox = [];
    for (const row of rows) if (row.type === 'assistant') {
      row.time.completed ??= 30;
      for (const content of row.content) if (content.type === 'tool' && ['running', 'streaming'].includes(content.state.status)) {
        content.state.status = 'completed'; content.time.completed = 30;
      }
    }
    if (promptSent && rows.at(-1)?.type !== 'idle') rows.push({ id: 'msg_interrupted', type: 'idle', time: { created: 31 }, outcome: 'interrupted' });
    if (session && rows.at(-1)?.type === 'idle') { session.time.idle = 31; session.outcome = rows.at(-1).outcome; }
  }
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { url, requests, started: started.promise, aborted: aborted.promise, statusRead: statusRead.promise,
    get idlePolls() { return idlePolls; }, get sessionID() { return session?.id; }, options, finishAbort,
    runner(settings: Partial<OpenCodeRunnerSettings> = {}) { return createOpenCodeRunner({ url, requestTimeoutMs: 1000,
      runTimeoutMs: 2000, abortTimeoutMs: 1000, pollIntervalMs: 5, ...settings }); },
    async close() { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}
