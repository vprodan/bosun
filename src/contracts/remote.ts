import { z } from 'zod';
import { BosunError } from '../core/errors.ts';
import { RPC_VERSION, rpcRequest, type RpcRequest } from './rpc.ts';
import { methodParams } from './methods.ts';

export const REMOTE_METHODS = new Set([
  'remote.vectors.search',
  'remote.graph.search',
  'remote.lexical.search',
  'consolidation.run',
  'consolidation.status',
  'consolidation.proposals',
  'consolidation.abandon',
  'remote.view.acquire',
  'remote.view.release',
  'remote.view.get',
  'memory.store',
  'memory.autoStore',
  'memory.embed',
  'memory.search',
  'memory.get',
  'memory.update',
  'memory.delete',
  'memory.accept',
  'memory.reject',
  'memory.purge',
  'memory.stats',
  'memory.maintain',
  'memory.publish',
  'graph.create',
  'graph.get',
  'graph.query',
  'graph.explain',
  'graph.review',
  'graph.revoke',
  'graph.backfill',
  'graph.exportProfile',
  'job.get',
  'job.result',
  'job.policy',
]);
export const remoteRequestSchema = z.strictObject({
  version: z.literal(RPC_VERSION),
  id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  method: z.string().min(1).max(80),
  params: z.record(z.string(), z.unknown()),
  scope: z.strictObject({
    projectId: z.string().regex(/^p_[a-f0-9]{16}$/),
    sessionId: z.string().min(1).max(200).nullable(),
    audience: z.enum(['owner', 'model']),
  }),
});
export type RemoteRequest = z.infer<typeof remoteRequestSchema>;
export const remoteIdentitySchema = z.strictObject({
  protocol: z.literal(1),
  version: z.string().min(1).max(80),
  memorySchema: z.literal(2),
  authorityId: z.string().uuid(),
  sourceId: z.string().uuid(),
  projectId: z.string().regex(/^p_[a-f0-9]{16}$/),
  serverTime: z.number().int().min(0).max(8640000000000000),
});
export type RemoteIdentity = z.infer<typeof remoteIdentitySchema>;
export function remoteRequest(
  input: unknown,
  workspace: string,
): { wire: RemoteRequest; local: RpcRequest } {
  const parsed = remoteRequestSchema.safeParse(input);
  if (!parsed.success || !REMOTE_METHODS.has(parsed.data.method))
    throw new BosunError('unsupported', 'Remote method unavailable');
  const wire = parsed.data;
  const local = rpcRequest({
    version: wire.version,
    id: wire.id,
    method: wire.method,
    params: wire.params,
    scope: { workspace, sessionId: wire.scope.sessionId, audience: wire.scope.audience },
  });
  methodParams(local);
  return { wire, local };
}
