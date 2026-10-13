import crypto from 'node:crypto';
import { BosunError } from '../core/errors.ts';
import { requireCapability, requirePublicInput } from '../core/policy.ts';
import { screenPublicText } from '../core/secret-screen.ts';
import { suggestMemory } from '../core/use-cases/suggest-memory.ts';
import type { RuntimeConfig } from '../core/domain/config.ts';
import type { Ctx } from '../core/domain/memory.ts';
import type { Admission } from '../core/domain/job.ts';
import type { ModelProvider } from '../core/ports/model.ts';
import type { AgentRunner } from '../core/ports/runner.ts';
import { memoryAutoStoreSchema } from '../contracts/memory-suggestion.ts';
import { project } from '../platform/project.ts';
import { localOllamaSelection } from '../adapters/models/own-inference-policy.ts';
import type { openDaemonJobs } from './jobs.ts';
import type { openDaemonMemory } from './memory.ts';

export const MEMORY_SUGGESTION_RUNNER = 'bosun-memory-suggestion';
export function createMemorySuggestions(options: {
  config: RuntimeConfig;
  providers: Readonly<Record<string, ModelProvider>>;
  jobs: ReturnType<typeof openDaemonJobs>;
  memory: ReturnType<typeof openDaemonMemory>;
  schedule(): void;
  admit?(providerId: string, model: string, signal: AbortSignal): Promise<Admission>;
}) {
  function validate(input: unknown, ctx: Ctx, workspace: string) {
    options.jobs.assertOwner();
    if (ctx.audience !== 'owner' || !ctx.projectId)
      throw new BosunError('unsupported', 'Owner operation required');
    requirePublicInput(input as { privacy?: unknown });
    const parsed = memoryAutoStoreSchema.safeParse(input);
    if (!parsed.success) throw new BosunError('invalid', 'Invalid memory suggestion');
    if (project(workspace).id !== ctx.projectId)
      throw new BosunError('conflict', 'Memory workspace changed');
    screenPublicText(JSON.stringify(parsed.data));
    return parsed.data;
  }
  function configured(request: ReturnType<typeof validate>) {
    const settings = options.config.providers[request.providerId],
      provider = options.providers[request.providerId];
    if (!settings || !provider)
      throw new BosunError('unsupported', 'Memory suggestion provider unavailable');
    if (!['ollama', 'openai-compatible'].includes(settings.kind))
      throw new BosunError('unverified', 'Native own inference isolation unverified');
    if (settings.kind === 'openai-compatible' && !request.allowRemoteApi)
      throw new BosunError('unsupported', 'Remote memory suggestion requires owner opt-in');
    if (settings.kind === 'ollama' && /(?:^|:)cloud(?:-|$)/i.test(settings.model))
      throw new BosunError('unsupported', 'Local memory suggestion model required');
    requireCapability(provider.caps.structured, 'structured memory suggestion');
    requireCapability(provider.caps.toolFree, 'tool-free memory suggestion');
    return { settings, provider };
  }
  const admitted = async (
    providerId: string,
    model: string,
    kind: string,
    signal: AbortSignal,
  ): Promise<Admission> =>
    options.admit
      ? options.admit(providerId, model, signal)
      : kind === 'ollama'
        ? { allowed: true }
        : { allowed: false, reason: 'admission_unavailable' };
  return {
    async submit(input: unknown, ctx: Ctx, workspace: string, signal: AbortSignal) {
      const request = validate(input, ctx, workspace);
      const requestId = `memory_auto_${crypto.createHash('sha256').update(request.requestId).digest('hex')}`;
      const scope = { projectId: ctx.projectId, audience: 'owner' as const };
      const previous = options.jobs.findRequest(scope, requestId);
      if (previous) return { job: previous, duplicate: true };
      const { settings } = configured(request);
      const admission = await admitted(request.providerId, settings.model, settings.kind, signal);
      if (!admission.allowed) return { state: 'held', reason: admission.reason };
      options.jobs.assertOwner();
      if (signal.aborted) throw new BosunError('cancelled', 'Memory suggestion cancelled');
      const result = options.jobs.submit(
        {
          privacy: 'public',
          ownerOnly: true,
          requestId,
          taskId: crypto.randomUUID(),
          runnerId: MEMORY_SUGGESTION_RUNNER,
          model: settings.model,
          cwd: workspace,
          access: 'edit',
          prompt: JSON.stringify({
            request,
            ctx: {
              projectId: ctx.projectId,
              sessionId: ctx.sessionId,
              linked: ctx.linked,
              audience: 'owner',
            },
          }),
        },
        scope,
      );
      options.schedule();
      return result;
    },
    runner(): AgentRunner {
      return {
        id: MEMORY_SUGGESTION_RUNNER,
        caps: {
          vendor: 'configured-provider',
          readOnly: 'unsupported',
          sandbox: 'none',
          mcpInject: 'unsupported',
          effort: 'unsupported',
          localBackend: 'unverified',
          billing: 'unknown',
        },
        detect: async () => ({ installed: true }),
        async *run(spec) {
          requirePublicInput(spec);
          const payload = JSON.parse(spec.prompt) as { request: unknown; ctx: Ctx };
          const request = validate(payload.request, payload.ctx, spec.cwd),
            { settings, provider } = configured(request);
          if (spec.model !== settings.model || spec.access !== 'edit')
            throw new BosunError('conflict', 'Memory suggestion model changed');
          const deadline = AbortSignal.any([spec.signal, AbortSignal.timeout(settings.timeoutMs)]);
          const admission = await admitted(
            request.providerId,
            settings.model,
            settings.kind,
            deadline,
          );
          if (!admission.allowed)
            throw new BosunError('unavailable', 'Memory suggestion admission held');
          if (settings.kind === 'ollama' && !(await localOllamaSelection(settings, deadline)))
            throw new BosunError('unavailable', 'Local memory suggestion unavailable');
          const generated = await suggestMemory(
            { privacy: 'public', body: request.body },
            { provider, model: settings.model, signal: deadline },
          );
          if (generated.tokensIn !== undefined || generated.tokensOut !== undefined)
            yield {
              t: 'usage',
              ...(generated.tokensIn === undefined ? {} : { tokensIn: generated.tokensIn }),
              ...(generated.tokensOut === undefined ? {} : { tokensOut: generated.tokensOut }),
            };
          if (settings.kind === 'ollama' && !(await localOllamaSelection(settings, deadline)))
            throw new BosunError('unavailable', 'Local memory suggestion changed', {
              details: { outcome: 'unknown' },
            });
          options.jobs.assertOwner();
          if (project(spec.cwd).id !== payload.ctx.projectId)
            throw new BosunError('conflict', 'Memory workspace changed', {
              details: { outcome: 'unknown' },
            });
          if (deadline.aborted)
            throw new BosunError('cancelled', 'Memory suggestion cancelled', {
              details: { outcome: 'unknown' },
            });
          const result = await options.memory.memory.store(
            {
              category: request.category,
              title: request.title ?? generated.title,
              body: request.body,
              tags: request.tags ?? generated.tags,
              private: false,
              ...(request.shared === undefined ? {} : { shared: request.shared }),
              ...(request.status === undefined ? {} : { status: request.status }),
            },
            { ...payload.ctx, source: 'rpc:owner' },
          );
          await options.memory.publish();
          yield { t: 'done', code: 0, result: JSON.stringify(result) };
        },
      };
    },
  };
}
