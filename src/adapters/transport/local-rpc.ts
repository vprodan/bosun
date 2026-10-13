// Lean local client: hooks never import the server/framework closure.
import http from 'node:http';
import { BosunError } from '../../core/errors.ts';
import { rpcRequest, rpcResponse, RPC_LIMITS, type RpcRequest, type RpcResponse } from '../../contracts/rpc.ts';
import { readBody, socketIdentity, socketPath } from '../../platform/local-socket.ts';
import { jobEventsRequest, projectJobEvent, JOB_STREAM_LIMITS } from '../../contracts/job-events.ts';
import type { JobEvent } from '../../core/domain/job.ts';

export async function callLocalRpc<T>(options: { socket: string; request: RpcRequest; mutation?: boolean; signal?: AbortSignal; timeoutMs?: number }): Promise<T> {
  if (options.signal?.aborted) throw new BosunError('cancelled', 'Request cancelled');
  try { socketPath(options.socket); socketIdentity(options.socket); }
  catch (error) { throw error instanceof BosunError ? error : new BosunError('unavailable', 'Daemon unavailable'); }
  const request = rpcRequest(options.request); const body = JSON.stringify(request);
  if (Buffer.byteLength(body) > RPC_LIMITS.requestBytes) throw new BosunError('invalid', 'Request too large');
  const timeout = options.timeoutMs ?? RPC_LIMITS.timeoutMs;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 300000) throw new BosunError('invalid', 'Invalid request timeout');
  const lost = () => new BosunError('unavailable', 'Daemon reply unavailable', options.mutation ? { details: { outcome: 'unknown' } } : undefined);
  let reply: RpcResponse<T>;
  try {
    const value = await new Promise<unknown>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const finish = (fn: (value: unknown) => void, value: unknown) => { clearTimeout(timer); fn(value); };
      const req = http.request({ socketPath: options.socket, path: '/rpc', method: 'POST', agent: false,
        signal: options.signal, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
        void (async () => {
          try {
            if (res.statusCode !== 200 || res.headers['content-type'] !== 'application/json') throw lost();
            const text = await readBody(res, RPC_LIMITS.responseBytes); finish(resolve, JSON.parse(text));
          } catch { finish(reject, lost()); }
        })();
      });
      req.once('error', () => finish(reject, lost()));
      timer = setTimeout(() => req.destroy(), timeout); timer.unref(); req.end(body);
    });
    reply = rpcResponse<T>(value, request.id);
  } catch { throw lost(); }
  if (!reply.ok) throw new BosunError(reply.error.code, reply.error.message, { details: reply.error.details });
  return reply.result;
}

// Explicit cursor resume, never automatic retries. Disconnecting this read stream never cancels a job.
export async function* streamLocalJobEvents(options: { socket: string; request: RpcRequest; signal?: AbortSignal }): AsyncGenerator<JobEvent> {
  if (options.signal?.aborted) throw new BosunError('cancelled', 'Event request cancelled');
  socketPath(options.socket); socketIdentity(options.socket);
  const request = jobEventsRequest(options.request); const body = JSON.stringify(request); let cursor = request.params.after;
  if (Buffer.byteLength(body) > RPC_LIMITS.requestBytes) throw new BosunError('invalid', 'Request too large');
  let connection: http.ClientRequest | undefined; let incoming: http.IncomingMessage | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    incoming = await new Promise<http.IncomingMessage>((resolve, reject) => {
      connection = http.request({ socketPath: options.socket, path: '/events', method: 'POST', agent: false, signal: options.signal,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, response => { clearTimeout(timer); resolve(response); });
      connection.once('error', () => reject(new BosunError('unavailable', 'Job events unavailable')));
      timer = setTimeout(() => connection!.destroy(), RPC_LIMITS.timeoutMs); timer.unref(); connection.end(body);
    });
    if (incoming.statusCode !== 200 || incoming.headers['content-type'] !== 'text/event-stream') throw new BosunError('unavailable', 'Job events unavailable');
    // A malformed/old peer cannot keep a declared finite subscription alive forever.
    timer = setTimeout(() => { incoming?.destroy(); connection?.destroy(); }, JOB_STREAM_LIMITS.lifetimeMs + RPC_LIMITS.timeoutMs); timer.unref();
    const decoder = new TextDecoder('utf8', { fatal: true }); let buffered = '';
    for await (const part of incoming) {
      buffered += decoder.decode(part as Uint8Array, { stream: true });
      if (Buffer.byteLength(buffered) > JOB_STREAM_LIMITS.batchBytes + JOB_STREAM_LIMITS.frameBytes) throw new BosunError('unavailable', 'Job events unavailable');
      for (let end = buffered.indexOf('\n\n'); end >= 0; end = buffered.indexOf('\n\n')) {
        const frame = buffered.slice(0, end); buffered = buffered.slice(end + 2);
        if (Buffer.byteLength(frame) > JOB_STREAM_LIMITS.frameBytes) throw new BosunError('unavailable', 'Job events unavailable');
        if (frame.startsWith(':')) continue;
        const lines = frame.split('\n'); const kind = lines.find(line => line.startsWith('event: '))?.slice(7);
        if (kind === 'error') throw new BosunError('unavailable', 'Job events unavailable');
        if (kind !== 'job') throw new BosunError('unavailable', 'Job events unavailable');
        const id = lines.find(line => line.startsWith('id: '))?.slice(4); const data = lines.find(line => line.startsWith('data: '))?.slice(6);
        if (!id || !/^\d{1,16}$/.test(id) || !data) throw new BosunError('unavailable', 'Job events unavailable');
        const event = projectJobEvent(JSON.parse(data)); if (event.seq !== Number(id)) throw new BosunError('unavailable', 'Job events unavailable');
        if (event.seq > cursor) { cursor = event.seq; yield event; }
      }
      if (Buffer.byteLength(buffered) > JOB_STREAM_LIMITS.frameBytes) throw new BosunError('unavailable', 'Job events unavailable');
    }
    buffered += decoder.decode(); if (buffered.trim()) throw new BosunError('unavailable', 'Job events unavailable');
  } catch { throw new BosunError(options.signal?.aborted ? 'cancelled' : 'unavailable', 'Job events unavailable'); }
  finally { clearTimeout(timer); incoming?.destroy(); connection?.destroy(); }
}
