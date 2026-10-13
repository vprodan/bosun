import fs from 'node:fs';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { isIP, type Socket } from 'node:net';
import { Hono } from 'hono';
import { getRequestListener, type HttpBindings } from '@hono/node-server';
import { BosunError } from '../../core/errors.ts';
import type { RuntimeConfig } from '../../core/domain/config.ts';
import type { Env } from '../../core/domain/inference.ts';
import { remoteRequest, type RemoteIdentity } from '../../contracts/remote.ts';
import { rpcError, RPC_LIMITS, type RpcRequest } from '../../contracts/rpc.ts';
import { readBody } from '../../platform/local-socket.ts';
import { project } from '../../platform/project.ts';
import { readPrivateFile } from '../../platform/private-file.ts';
import { remoteNetwork, remoteToken, remoteTokenMatches } from '../../platform/remote-policy.ts';

export async function serveRemoteRpc(options: {
  settings: RuntimeConfig['remote'];
  env: Env;
  identity: Omit<RemoteIdentity, 'projectId' | 'serverTime'>;
  assertOwner(): void;
  dispatch(request: RpcRequest, signal: AbortSignal): Promise<unknown>;
  dispatchView?(request: RpcRequest, grantHash: string, signal: AbortSignal): Promise<unknown>;
  port?: number;
  now?: () => number;
}) {
  const cfg = options.settings,
    allowed = remoteNetwork(cfg.allow);
  if (
    !isIP(cfg.bind) ||
    (!['127.0.0.1', '::1'].includes(cfg.bind) && !cfg.tls) ||
    !cfg.projects.length
  )
    throw new BosunError('invalid', 'Remote bind requires TLS and registered projects');
  const roots = new Map<
    string,
    { workspace: string; dev: number; ino: number; tokenEnv: string; modelTokenEnv: string }
  >();
  for (const entry of cfg.projects) {
    const stat = fs.statSync(entry.workspace),
      id = project(entry.workspace).id;
    if (
      !stat.isDirectory() ||
      fs.realpathSync(entry.workspace) !== entry.workspace ||
      roots.has(id)
    )
      throw new BosunError('invalid', 'Remote project registration unavailable');
    const tokenEnv = entry.tokenEnv ?? cfg.tokenEnv,
      modelTokenEnv = entry.modelTokenEnv ?? cfg.modelTokenEnv;
    const ownerToken = remoteToken(options.env, tokenEnv)!,
      modelToken = remoteToken(options.env, modelTokenEnv, false);
    if (ownerToken === modelToken)
      throw new BosunError('invalid', 'Remote audiences require separate credentials');
    roots.set(id, {
      workspace: entry.workspace,
      dev: stat.dev,
      ino: stat.ino,
      tokenEnv,
      modelTokenEnv,
    });
  }
  let stopping = false,
    closing: Promise<void> | undefined;
  const sockets = new Set<Socket>(),
    work = new Set<Promise<void>>(),
    controllers = new Set<AbortController>();
  const app = new Hono<{ Bindings: HttpBindings }>();
  const send = (status: number, value: unknown, authority = false) => {
    let text: string;
    try {
      text = JSON.stringify(value);
      if (Buffer.byteLength(text) > RPC_LIMITS.responseBytes) throw 0;
    } catch {
      status = 503;
      text = JSON.stringify({
        version: 1,
        id: 'invalid',
        ok: false,
        error: rpcError(new BosunError('unavailable', '')),
      });
    }
    return new Response(text, {
      status,
      headers: {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(text)),
        'cache-control': 'no-store',
        connection: 'close',
        ...(authority ? { 'x-bosun-authority': options.identity.authorityId } : {}),
      },
    });
  };
  app.onError(() =>
    send(503, {
      version: 1,
      id: 'invalid',
      ok: false,
      error: rpcError(new BosunError('unavailable', '')),
    }),
  );
  app.all('*', async (context) => {
    const req = context.env.incoming;
    let id = 'invalid',
      authorized = false;
    const control = new AbortController();
    controllers.add(control);
    const abort = () => control.abort();
    context.env.outgoing.once('close', abort);
    try {
      if (stopping) throw new BosunError('unavailable', '');
      options.assertOwner();
      if (!allowed(req.socket.remoteAddress))
        return send(403, {
          version: 1,
          id,
          ok: false,
          error: rpcError(new BosunError('unsupported', '')),
        });
      const projectId = req.headers['x-bosun-project'];
      const root = typeof projectId === 'string' ? roots.get(projectId) : undefined;
      if (!root)
        return send(401, {
          version: 1,
          id,
          ok: false,
          error: rpcError(new BosunError('unsupported', '')),
        });
      const ownerToken = remoteToken(options.env, root.tokenEnv)!,
        modelToken = remoteToken(options.env, root.modelTokenEnv, false);
      if (ownerToken === modelToken) throw new BosunError('unavailable', '');
      const audience = remoteTokenMatches(req.headers.authorization, ownerToken)
        ? 'owner'
        : remoteTokenMatches(req.headers.authorization, modelToken)
          ? 'model'
          : null;
      if (!audience)
        return send(401, {
          version: 1,
          id,
          ok: false,
          error: rpcError(new BosunError('unsupported', '')),
        });
      authorized = true;
      const stat = fs.statSync(root.workspace);
      if (
        !stat.isDirectory() ||
        stat.dev !== root.dev ||
        stat.ino !== root.ino ||
        fs.realpathSync(root.workspace) !== root.workspace ||
        project(root.workspace).id !== projectId
      )
        throw new BosunError('conflict', '');
      if (req.url === '/v1/identity' && req.method === 'GET')
        return send(
          200,
          { ...options.identity, projectId, serverTime: (options.now ?? Date.now)() },
          true,
        );
      if (
        req.url !== '/v1/rpc' ||
        req.method !== 'POST' ||
        req.headers['content-type'] !== 'application/json'
      )
        throw new BosunError('invalid', '');
      if (req.headers['x-bosun-authority'] !== options.identity.authorityId)
        return send(
          409,
          { version: 1, id, ok: false, error: rpcError(new BosunError('conflict', '')) },
          true,
        );
      const body = await readBody(req, RPC_LIMITS.requestBytes);
      const raw = (() => {
        try {
          return JSON.parse(body);
        } catch {
          throw new BosunError('invalid', 'Malformed remote request');
        }
      })();
      if (
        raw?.scope?.projectId !== projectId ||
        (raw?.scope?.audience !== audience &&
          !(audience === 'owner' && raw?.scope?.audience === 'model'))
      )
        throw new BosunError('unsupported', '');
      const request = remoteRequest(raw, root.workspace);
      id = request.local.id;
      if (stopping || control.signal.aborted) throw new BosunError('cancelled', '');
      options.assertOwner();
      const result = ['remote.view.acquire', 'remote.view.release', 'remote.view.get'].includes(
        request.local.method,
      )
        ? await (() => {
            if (!options.dispatchView)
              throw new BosunError('unavailable', 'Remote views unavailable');
            return options.dispatchView(
              request.local,
              crypto
                .createHash('sha256')
                .update(audience === 'owner' ? ownerToken : modelToken!)
                .digest('hex'),
              control.signal,
            );
          })()
        : await options.dispatch(request.local, control.signal);
      return send(200, { version: 1, id, ok: true, result }, true);
    } catch (error) {
      return send(
        error instanceof BosunError && error.code === 'conflict' ? 409 : 400,
        { version: 1, id, ok: false, error: rpcError(error) },
        authorized,
      );
    } finally {
      controllers.delete(control);
      context.env.outgoing.off('close', abort);
    }
  });
  const listener = getRequestListener(app.fetch);
  const handle: http.RequestListener = (req, res) => {
    const operation = Promise.resolve(listener(req, res)).catch(() => {
      res.destroy();
    });
    work.add(operation);
    void operation.finally(() => work.delete(operation));
  };
  const server = cfg.tls
    ? https.createServer(
        {
          key: readPrivateFile(cfg.tls.keyFile, 65536),
          cert: readPrivateFile(cfg.tls.certFile, 65536),
        },
        handle,
      )
    : http.createServer(handle);
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.headersTimeout = 5000;
  server.requestTimeout = 10000;
  server.maxRequestsPerSocket = 1;
  server.maxConnections = 64;
  const port = options.port ?? cfg.port;
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new BosunError('invalid', 'Invalid remote port');
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, cfg.bind, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new BosunError('unavailable', 'Remote endpoint unavailable');
  return {
    url: `${cfg.tls ? 'https' : 'http'}://${isIP(cfg.bind) === 6 ? `[${cfg.bind}]` : cfg.bind}:${address.port}`,
    stopAdmission() {
      stopping = true;
    },
    close() {
      if (closing) return closing;
      stopping = true;
      closing = (async () => {
        for (const control of controllers) control.abort();
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        await Promise.allSettled(work);
      })();
      return closing;
    },
  };
}
