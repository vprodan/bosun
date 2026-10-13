import http from 'node:http';
import https from 'node:https';
import { BosunError } from '../../core/errors.ts';
import type { Env } from '../../core/domain/inference.ts';
import type { RuntimeConfig } from '../../core/domain/config.ts';
import { rpcRequest, rpcResponse, RPC_LIMITS, type RpcRequest } from '../../contracts/rpc.ts';
import { methodDefinition, methodParams } from '../../contracts/methods.ts';
import {
  remoteRequest,
  remoteIdentitySchema,
  type RemoteIdentity,
} from '../../contracts/remote.ts';
import { readBody } from '../../platform/local-socket.ts';
import { readPrivateFile } from '../../platform/private-file.ts';
import { remoteEndpoint, remoteToken } from '../../platform/remote-policy.ts';
export class RemoteAccessError extends BosunError {}

export async function callRemoteRpc<T>(options: {
  settings: RuntimeConfig['remote'];
  env: Env;
  projectId: string;
  request: RpcRequest;
  signal: AbortSignal;
  inspectIdentity?(identity: RemoteIdentity): void;
}): Promise<T> {
  const request = rpcRequest(options.request);
  methodParams(request);
  if (!request.scope) throw new BosunError('invalid', 'Remote scope required');
  const wire = remoteRequest(
    {
      version: 1,
      id: request.id,
      method: request.method,
      params: request.params,
      scope: {
        projectId: options.projectId,
        sessionId: request.scope.sessionId,
        audience: request.scope.audience,
      },
    },
    request.scope.workspace,
  ).wire;
  if (options.signal.aborted) throw new BosunError('cancelled', 'Remote request cancelled');
  const cfg = options.settings;
  if (!cfg.authority || !cfg.authorityId)
    throw new BosunError('unavailable', 'Remote authority unavailable');
  const endpoint = remoteEndpoint(cfg.authority);
  const token = remoteToken(
    options.env,
    request.scope.audience === 'owner' ? cfg.tokenEnv : cfg.modelTokenEnv,
  )!;
  const ca = cfg.caFile ? readPrivateFile(cfg.caFile, 65536) : undefined;
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(cfg.timeoutMs)]);
  const exchange = async (route: string, body?: string) => {
    const mutating = body !== undefined && methodDefinition(request.method).mutation;
    const lost = () =>
      new BosunError(
        'unavailable',
        'Remote response unavailable',
        mutating ? { details: { outcome: 'unknown' } } : undefined,
      );
    try {
      return await new Promise<{ status: number; authority: unknown; data: unknown }>(
        (resolve, reject) => {
          const req = (endpoint.protocol === 'https:' ? https : http).request(
            new URL(route, endpoint),
            {
              method: body === undefined ? 'GET' : 'POST',
              agent: false,
              signal,
              ...(ca ? { ca } : {}),
              headers: {
                authorization: `Bearer ${token}`,
                'x-bosun-project': options.projectId,
                'x-bosun-authority': cfg.authorityId!,
                'content-type': 'application/json',
                ...(body === undefined ? {} : { 'content-length': Buffer.byteLength(body) }),
              },
            },
            (res) => {
              void (async () => {
                try {
                  if (res.headers['content-type'] !== 'application/json') throw lost();
                  const text = await readBody(
                    res,
                    body === undefined ? 8192 : RPC_LIMITS.responseBytes,
                  );
                  resolve({
                    status: res.statusCode ?? 0,
                    authority: res.headers['x-bosun-authority'],
                    data: JSON.parse(text),
                  });
                } catch {
                  res.destroy();
                  reject(lost());
                }
              })();
            },
          );
          req.once('error', () => reject(lost()));
          req.end(body);
        },
      );
    } catch {
      throw lost();
    }
  };
  const started = Date.now();
  const observed = await exchange('/v1/identity');
  if (observed.status !== 200)
    throw new RemoteAccessError('unavailable', 'Remote authentication or authority unavailable');
  let identity: RemoteIdentity;
  try {
    identity = remoteIdentitySchema.parse(observed.data);
  } catch {
    throw new RemoteAccessError('unverified', 'Remote identity unavailable');
  }
  if (
    identity.authorityId !== cfg.authorityId ||
    observed.authority !== cfg.authorityId ||
    identity.projectId !== options.projectId
  )
    throw new RemoteAccessError('conflict', 'Remote authority identity changed');
  if (identity.serverTime < started - 5000 || identity.serverTime > Date.now() + 5000)
    throw new RemoteAccessError('unverified', 'Remote authority clock differs');
  options.inspectIdentity?.(identity);
  const body = JSON.stringify(wire);
  if (Buffer.byteLength(body) > RPC_LIMITS.requestBytes)
    throw new BosunError('invalid', 'Remote request too large');
  const response = await exchange('/v1/rpc', body);
  if (response.authority !== cfg.authorityId)
    throw new BosunError(
      'unavailable',
      'Remote authority receipt unavailable',
      methodDefinition(request.method).mutation ? { details: { outcome: 'unknown' } } : undefined,
    );
  let value: ReturnType<typeof rpcResponse<T>>;
  try {
    value = rpcResponse<T>(response.data, request.id);
  } catch {
    throw new BosunError(
      'unavailable',
      'Remote receipt unavailable',
      methodDefinition(request.method).mutation ? { details: { outcome: 'unknown' } } : undefined,
    );
  }
  if (!value.ok)
    throw new BosunError(value.error.code, value.error.message, {
      details:
        value.error.details ??
        (methodDefinition(request.method).mutation &&
        ['unavailable', 'internal', 'timeout'].includes(value.error.code)
          ? { outcome: 'unknown' }
          : undefined),
    });
  if (response.status !== 200) throw new BosunError('unavailable', 'Remote receipt unavailable');
  return value.result;
}
