// Actual Hono server. This module is never imported by the hook's built-in-only local client.
import fs from 'node:fs';
import http from 'node:http';
import type { Socket } from 'node:net';
import { Hono } from 'hono';
import { getRequestListener, type HttpBindings } from '@hono/node-server';
import { BosunError } from '../../core/errors.ts';
import { rpcRequest, rpcError, RPC_LIMITS, type RpcRequest, type RpcResponse } from '../../contracts/rpc.ts';
import { jobEventsRequest, projectJobEvent, JOB_STREAM_LIMITS } from '../../contracts/job-events.ts';
import { readBody, socketIdentity, socketPath } from '../../platform/local-socket.ts';

export type RpcHandler = (request: RpcRequest, signal: AbortSignal) => Promise<unknown>;
export type StreamTiming = { pollMs?: number; heartbeatMs?: number; stallMs?: number; lifetimeMs?: number };
type Subscription = { stop(destroy?: boolean): void };
function response(value: RpcResponse): Response {
  let body: string;
  try { body = JSON.stringify(value); if (Buffer.byteLength(body) > RPC_LIMITS.responseBytes) throw 0; }
  catch { body = JSON.stringify({ version: 1, id: value.id, ok: false, error: rpcError(new BosunError('unavailable', '', { details: { outcome: 'unknown' } })) }); }
  return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)), 'Cache-Control': 'no-store', Connection: 'close' } });
}
function timing(settings: StreamTiming = {}): Required<StreamTiming> {
  const chosen = { pollMs: settings.pollMs ?? JOB_STREAM_LIMITS.pollMs, heartbeatMs: settings.heartbeatMs ?? JOB_STREAM_LIMITS.heartbeatMs,
    stallMs: settings.stallMs ?? JOB_STREAM_LIMITS.stallMs, lifetimeMs: settings.lifetimeMs ?? JOB_STREAM_LIMITS.lifetimeMs };
  if (Object.values(chosen).some(value => !Number.isSafeInteger(value) || value < 5 || value > JOB_STREAM_LIMITS.lifetimeMs)
    || chosen.pollMs > chosen.heartbeatMs || chosen.stallMs > JOB_STREAM_LIMITS.stallMs) throw new BosunError('invalid', 'Invalid event timing');
  return chosen;
}

// Caller holds the existing daemon owner for the entire lifetime. No TCP or autonomous startup.
export async function serveLocalRpc(options: { socket: string; assertOwner(): void; dispatch: RpcHandler; events?: StreamTiming }) {
  const assertOwner = options.assertOwner; const dispatch = options.dispatch; const timers = timing(options.events);
  assertOwner(); socketPath(options.socket);
  try { socketIdentity(options.socket); fs.unlinkSync(options.socket); }
  catch (error) { if ((error as { code?: string }).code !== 'ENOENT') throw error; }
  let stopping = false; let closing: Promise<void> | undefined;
  const work = new Set<Promise<void>>(); const pulls = new Set<Promise<void>>(); const sockets = new Set<Socket>(); const subscriptions = new Set<Subscription>();
  const app = new Hono<{ Bindings: HttpBindings }>();
  const controllers = new WeakMap<http.ServerResponse, AbortController>();
  const fail = (id = 'invalid', error: unknown = new BosunError('unavailable', '')) => response({ version: 1, id, ok: false, error: rpcError(error) });
  app.onError((_error, context) => { context.env.outgoing.setHeader('Connection', 'close'); return fail(); });
  app.all('*', async context => {
    const req = context.env.incoming; const res = context.env.outgoing; const control = controllers.get(res)!;
    let id = 'invalid';
    try {
      if (stopping) throw new BosunError('unavailable', ''); assertOwner();
      if (req.method !== 'POST' || !['/rpc', '/events'].includes(req.url ?? '') || req.headers['content-type'] !== 'application/json') throw new BosunError('invalid', '');
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > RPC_LIMITS.requestBytes) throw new BosunError('invalid', '');
      let value: unknown;
      try { value = JSON.parse(await readBody(req, RPC_LIMITS.requestBytes)); } catch (error) { throw error instanceof BosunError ? error : new BosunError('invalid', ''); }
      const request = rpcRequest(value); id = request.id;
      if (control.signal.aborted || stopping) throw new BosunError('cancelled', ''); assertOwner();
      if (req.url === '/rpc') {
        const result = await dispatch(request, control.signal);
        return response({ version: 1, id, ok: true, result: result === undefined ? null : result });
      }
      const query = jobEventsRequest(request);
      if (subscriptions.size >= JOB_STREAM_LIMITS.subscribers) throw new BosunError('unavailable', '');
      let streamController: ReadableStreamDefaultController<Uint8Array>;
      let closed = false; let cursor = query.params.after; let pending: Uint8Array[] = []; let lastHeartbeat = Date.now();
      let stall: ReturnType<typeof setTimeout> | undefined; let lifetime: ReturnType<typeof setTimeout> | undefined;
      let wait: ReturnType<typeof setTimeout> | undefined; let wake: (() => void) | undefined;
      const subscription: Subscription = {
        stop(destroy = false) {
          if (closed) return; closed = true; clearTimeout(stall); clearTimeout(lifetime); clearTimeout(wait); wake?.();
          pending = []; subscriptions.delete(subscription); control.signal.removeEventListener('abort', aborted);
          try { streamController?.close(); } catch {} control.abort(); if (destroy) res.destroy();
        },
      };
      const aborted = () => subscription.stop();
      const delay = () => new Promise<void>(resolve => { wake = resolve; wait = setTimeout(() => { wait = undefined; wake = undefined; resolve(); }, timers.pollMs); wait.unref(); });
      const frame = (event: unknown): Uint8Array => {
        const item = projectJobEvent(event); const bytes = Buffer.from(`id: ${item.seq}\nevent: job\ndata: ${JSON.stringify(item)}\n\n`);
        if (bytes.length > JOB_STREAM_LIMITS.frameBytes) throw new BosunError('unavailable', ''); return bytes;
      };
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller; subscriptions.add(subscription); control.signal.addEventListener('abort', aborted, { once: true });
          lifetime = setTimeout(() => subscription.stop(true), timers.lifetimeMs); lifetime.unref();
          if (control.signal.aborted) subscription.stop();
        },
        pull(controller) {
          const operation = (async () => {
          clearTimeout(stall);
          try {
            while (!closed && !stopping) {
              if (pending.length) {
                controller.enqueue(pending.shift()!);
                stall = setTimeout(() => subscription.stop(true), timers.stallMs); stall.unref(); return;
              }
              assertOwner();
              const batch = await dispatch({ ...query, params: { after: cursor, limit: query.params.limit } }, control.signal) as { events?: unknown; cursor?: unknown };
              if (closed || stopping || control.signal.aborted) return;
              if (!batch || !Array.isArray(batch.events) || batch.events.length > query.params.limit || !Number.isSafeInteger(batch.cursor) || Number(batch.cursor) < cursor) throw new BosunError('unavailable', '');
              let next = cursor; let bytes = 0;
              for (const raw of batch.events) {
                const item = projectJobEvent(raw); if (item.seq <= next) continue;
                const encoded = frame(item); bytes += encoded.length; if (bytes > JOB_STREAM_LIMITS.batchBytes || item.seq > Number(batch.cursor)) throw new BosunError('unavailable', '');
                next = item.seq; pending.push(encoded);
              }
              cursor = Number(batch.cursor);
              if (pending.length) continue;
              const now = Date.now();
              if (now - lastHeartbeat >= timers.heartbeatMs) {
                lastHeartbeat = now; controller.enqueue(Buffer.from(': heartbeat\n\n'));
                stall = setTimeout(() => subscription.stop(true), timers.stallMs); stall.unref(); return;
              }
              await delay();
            }
          } catch {
            if (!closed) {
              try { controller.enqueue(Buffer.from(`event: error\ndata: ${JSON.stringify(rpcError(new BosunError('unavailable', '')))}\n\n`)); } catch {}
              subscription.stop();
            }
          }
          })().finally(() => pulls.delete(operation));
          pulls.add(operation); return operation;
        },
        cancel() { subscription.stop(); },
      }, { highWaterMark: 1 });
      // Chunked mode avoids the adapter's optional eager pre-read/error-reporting path.
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'Transfer-Encoding': 'chunked', Connection: 'keep-alive' } });
    } catch (error) { return fail(id, error); }
  });
  const listener = getRequestListener(app.fetch, { overrideGlobalObjects: false, autoCleanupIncoming: false, errorHandler: () => fail() });
  const server = http.createServer({ maxHeaderSize: 4096 }, (req, res) => {
    const control = new AbortController(); controllers.set(res, control);
    const deadline = setTimeout(() => { if (req.url !== '/events' || !res.headersSent) { control.abort(); res.destroy(); } }, RPC_LIMITS.timeoutMs); deadline.unref();
    res.once('close', () => { clearTimeout(deadline); if (!res.writableFinished) control.abort(); });
    const operation = listener(req, res); work.add(operation);
    void operation.catch(() => { control.abort(); res.destroy(); }).finally(() => { clearTimeout(deadline); work.delete(operation); });
  });
  server.requestTimeout = RPC_LIMITS.timeoutMs; server.headersTimeout = RPC_LIMITS.timeoutMs;
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.socket, () => { server.off('error', reject); resolve(); }); });
  let identity: fs.Stats;
  try { const created = fs.lstatSync(options.socket); if (!created.isSocket()) throw new BosunError('unavailable', ''); fs.chmodSync(options.socket, 0o600); identity = socketIdentity(options.socket); assertOwner(); }
  catch (error) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); throw error; }
  return {
    stopAdmission() { stopping = true; for (const subscription of [...subscriptions]) subscription.stop(true); },
    activeStreams(): number { return subscriptions.size; },
    close(): Promise<void> {
      if (closing) return closing;
      stopping = true; for (const subscription of [...subscriptions]) subscription.stop(true);
      closing = (async () => {
        const done = new Promise<void>(resolve => server.close(() => resolve())); for (const socket of sockets) socket.destroy();
        await Promise.allSettled([...work]); await Promise.allSettled([...pulls]); await done;
        try { const current = fs.lstatSync(options.socket); if (current.dev === identity.dev && current.ino === identity.ino) fs.unlinkSync(options.socket); }
        catch (error) { if ((error as { code?: string }).code !== 'ENOENT') throw new BosunError('unavailable', 'Local socket cleanup unavailable'); }
      })(); return closing;
    },
  };
}
