import crypto from 'node:crypto';
import type { AgentRunner } from '../core/ports/runner.ts';
import { BosunError } from '../core/errors.ts';
import { project } from '../platform/project.ts';
import { methodParams, type MethodParams } from '../contracts/methods.ts';
import type { RpcRequest } from '../contracts/rpc.ts';
import type { Ctx } from '../core/domain/memory.ts';
import type { openDaemonJobs } from './jobs.ts';
import type { openDaemonMemory } from './memory.ts';

export const ADMIN_RUNNER = 'bosun-admin';
export type AdminMethod = 'docs.index' | 'memory.maintain' | 'memory.publish';
export function enqueueAdmin(jobs: ReturnType<typeof openDaemonJobs>, schedule: () => void, method: AdminMethod,
  params: Record<string, unknown>, request: RpcRequest, ctx: Ctx) {
  const result = jobs.submit({ privacy: 'public', ownerOnly: true, requestId: request.id, taskId: crypto.randomUUID(), runnerId: ADMIN_RUNNER,
    prompt: JSON.stringify({ method, params, projectId: ctx.projectId }), cwd: request.scope!.workspace, access: 'edit', model: 'bosun' },
    { projectId: ctx.projectId, audience: 'owner' });
  schedule(); return result;
}
// Trusted owner operations use the same durable executor and cancellation/drain
// lifecycle. This adapter performs native IO and never invokes a model.
export function createAdminRunner(memory: ReturnType<typeof openDaemonMemory>, index: (workspace: string, projectId: string) => unknown): AgentRunner {
  return {
    id: ADMIN_RUNNER,
    caps: { vendor: 'bosun', readOnly: 'unsupported', sandbox: 'none', mcpInject: 'unsupported', effort: 'unsupported', localBackend: 'unsupported', billing: 'local' },
    detect: async () => ({ installed: true }),
    async *run(spec) {
      if (spec.signal.aborted) throw new BosunError('cancelled', 'Administration cancelled');
      const payload = JSON.parse(spec.prompt) as { method: string; params: Record<string, unknown>; projectId: string };
      if (!['docs.index', 'memory.maintain', 'memory.publish'].includes(payload.method)) throw new BosunError('unsupported', 'Administration unavailable');
      const identity = project(spec.cwd);
      if (identity.id !== payload.projectId) throw new BosunError('conflict', 'Workspace identity changed');
      const request: RpcRequest = { version: 1, id: 'admin', method: payload.method, params: payload.params, scope: { workspace: spec.cwd, sessionId: null, audience: 'owner' } };
      const params = methodParams(request); let result: unknown;
      if (payload.method === 'docs.index') {
        result = index(spec.cwd, identity.id);
      } else if (payload.method === 'memory.publish') result = await memory.publish();
      else {
        const action = params as MethodParams<'memory.maintain'>;
        if (action.action === 'expire') result = { archived: memory.expire() };
        else if (action.action === 'prune') result = memory.prune();
        else { if (!action.ids) throw new BosunError('invalid', 'Memory ids required'); memory.touch(action.ids); result = { touched: action.ids.length }; }
      }
      if (payload.method !== 'memory.publish') await memory.publish();
      yield { t: 'done', code: 0, result: JSON.stringify(result) };
    },
  };
}
