import crypto from 'node:crypto';
import type { RuntimeConfig } from '../core/domain/config.ts';
import type { Env } from '../core/domain/inference.ts';
import type { Ctx } from '../core/domain/memory.ts';
import { BosunError } from '../core/errors.ts';
import {
  parseRemoteView,
  remoteViewContains,
  type RemoteViewSnapshot,
} from '../core/remote-view.ts';
import { mayDeliverMemoryToModel } from '../core/memory-policy.ts';
import { publicMemory } from '../core/memory-presentation.ts';
import { methodParams } from '../contracts/methods.ts';
import type { RpcRequest } from '../contracts/rpc.ts';
import { contentHash } from '../platform/content-hash.ts';
import { project } from '../platform/project.ts';
import { remoteToken } from '../platform/remote-policy.ts';
import { RemoteLeaseStore } from '../adapters/memory/remote-leases.ts';
import { RemoteViewCache } from '../adapters/memory/remote-view-cache.ts';
import type {
  RemoteViewBinding,
  RemoteViewIntent,
} from '../adapters/memory/remote-view-protocol.ts';
import { callRemoteRpc } from '../adapters/transport/remote-rpc.ts';
import type { openDaemonMemory } from './memory.ts';

export function createRemoteViewAuthority(options: {
  leases: RemoteLeaseStore;
  memory: ReturnType<typeof openDaemonMemory>;
  authorityId: string;
  sourceId: string;
  now: () => number;
}) {
  return async (request: RpcRequest, grantHash: string, signal: AbortSignal) => {
    const params = methodParams(request) as { id: string; clientId: string };
    if (!request.scope || request.scope.audience !== 'owner' || signal.aborted)
      throw new BosunError('unsupported', 'Remote view owner required');
    const projectId = project(request.scope.workspace).id;
    if (request.method === 'remote.view.release')
      return options.leases.release(params.id, projectId, params.clientId, options.now());
    if (request.method === 'remote.view.get')
      return { lease: options.leases.get(params.id, projectId, params.clientId) };
    if (request.method !== 'remote.view.acquire')
      throw new BosunError('unsupported', 'Remote view method unavailable');
    // Reserve before yielding to any source read. No source DML can succeed after this commit.
    const lease = options.leases.acquire({
      id: params.id,
      clientId: params.clientId,
      sourceId: options.sourceId,
      projectId,
      grantHash,
      createdAt: options.now(),
    });
    const ctx: Ctx = {
      projectId,
      sessionId: request.scope.sessionId,
      linked: [],
      source: 'remote:view',
      audience: 'model',
    };
    const hits = await options.memory.memory.search(
      { limit: 50, includePrivate: false, status: ['active'] },
      ctx,
    );
    const rows = hits
      .filter(
        (row) =>
          mayDeliverMemoryToModel(row) && row.expiresAt === null && remoteViewContains(row, ctx),
      )
      .flatMap((row) => {
        const projected = publicMemory(row);
        if (projected.body.length > 4000) return [];
        return [projected];
      });
    return parseRemoteView(
      {
        schemaVersion: 1,
        id: lease.id,
        clientId: lease.clientId,
        authorityId: options.authorityId,
        sourceId: lease.sourceId,
        projectId,
        sessionId: ctx.sessionId,
        grantHash: lease.grantHash,
        createdAt: lease.createdAt,
        rows,
      },
      contentHash,
    );
  };
}

export function createRemoteViews(options: {
  file: string;
  binding: RemoteViewBinding;
  settings: RuntimeConfig['remote'];
  env: Env;
  assertOwner(): void;
}) {
  const cache = new RemoteViewCache(options.file, options.assertOwner);
  let busy = false;
  const exclusive = async <T>(operation: () => Promise<T>) => {
    if (busy) throw new BosunError('conflict', 'Remote view operation in progress');
    busy = true;
    try {
      return await operation();
    } finally {
      busy = false;
    }
  };
  const bound = (intent: RemoteViewIntent) => {
    if (
      Object.entries(options.binding).some(
        ([key, value]) => intent[key as keyof RemoteViewIntent] !== value,
      )
    )
      throw new BosunError('conflict', 'Original remote view authority differs');
  };
  const call = (
    method: string,
    params: Record<string, unknown>,
    intent: RemoteViewIntent,
    signal: AbortSignal,
    inspectIdentity?: (identity: import('../contracts/remote.ts').RemoteIdentity) => void,
  ) =>
    callRemoteRpc<any>({
      settings: options.settings,
      env: options.env,
      projectId: intent.projectId,
      request: {
        version: 1,
        id: crypto.randomUUID(),
        method,
        params,
        scope: { workspace: '/', sessionId: intent.sessionId, audience: 'owner' },
      },
      signal,
      inspectIdentity,
    });
  async function release(signal: AbortSignal) {
    const previous = cache.hold();
    if (!previous) return { state: 'empty' };
    bound(previous.intent);
    if (['pending', 'acquire-unknown', 'release-unknown'].includes(previous.state))
      throw new BosunError('unverified', 'Reconcile the original remote lease first');
    try {
      const row = await call(
        'remote.view.release',
        { id: previous.intent.id, clientId: previous.intent.clientId },
        previous.intent,
        signal,
      );
      if (
        row?.id !== previous.intent.id ||
        row?.projectId !== previous.intent.projectId ||
        row?.clientId !== previous.intent.clientId ||
        row?.state !== 'retired'
      )
        throw new BosunError('unavailable', 'Remote release receipt unknown', {
          details: { outcome: 'unknown' },
        });
      cache.clear();
      return { state: 'empty' };
    } catch (error) {
      if (error instanceof BosunError && error.details?.outcome === 'unknown')
        cache.phase('release-unknown');
      throw error;
    }
  }
  return {
    refresh(ctx: Ctx, ttlMs: number, signal: AbortSignal) {
      return exclusive(async () => {
        await release(signal);
        if (!ctx.projectId) throw new BosunError('invalid', 'Remote view project required');
        const intent: RemoteViewIntent = {
          ...options.binding,
          id: crypto.randomUUID(),
          projectId: ctx.projectId,
          sessionId: ctx.sessionId,
        };
        cache.reserve(intent);
        try {
          let sourceId: string | undefined;
          const snapshot: RemoteViewSnapshot = parseRemoteView(
            await call(
              'remote.view.acquire',
              { privacy: 'public', id: intent.id, clientId: intent.clientId },
              intent,
              signal,
              (identity) => {
                sourceId = identity.sourceId;
              },
            ),
            contentHash,
          );
          if (
            snapshot.sourceId !== sourceId ||
            snapshot.grantHash !==
              crypto
                .createHash('sha256')
                .update(remoteToken(options.env, options.settings.tokenEnv)!)
                .digest('hex')
          )
            throw new BosunError('unavailable', 'Remote grant binding differs', {
              details: { outcome: 'unknown' },
            });
          cache.ready(snapshot, Date.now(), ttlMs);
          return { state: 'ready', id: intent.id, rows: snapshot.rows.length, ttlMs };
        } catch (error) {
          cache.phase('acquire-unknown');
          throw error;
        }
      });
    },
    invalidate(signal: AbortSignal) {
      return exclusive(() => release(signal));
    },
    reconcile(signal: AbortSignal) {
      return exclusive(async () => {
        const previous = cache.hold();
        if (!previous) return { state: 'empty' };
        bound(previous.intent);
        const response = await call(
          'remote.view.get',
          { id: previous.intent.id, clientId: previous.intent.clientId },
          previous.intent,
          signal,
        );
        const row = response?.lease;
        if (row === null) {
          if (previous.state === 'release-unknown')
            throw new BosunError('conflict', 'Remote lease history missing');
          cache.clear();
          return { state: 'empty' };
        }
        if (
          row?.id !== previous.intent.id ||
          row?.clientId !== previous.intent.clientId ||
          row?.projectId !== previous.intent.projectId ||
          !['active', 'retired'].includes(row?.state)
        )
          throw new BosunError('unavailable', 'Remote lease reconciliation unavailable');
        if (row.state === 'retired') {
          cache.clear();
          return { state: 'empty' };
        }
        cache.phase('held');
        return { state: 'held', id: row.id };
      });
    },
    rejectAccess() {
      cache.hold();
    },
    status() {
      return cache.status();
    },
    close() {
      cache.close();
    },
  };
}
