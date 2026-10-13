import crypto from 'node:crypto';
import { BosunError } from '../core/errors.ts';
import { requirePublicInput } from '../core/policy.ts';
import { CONSOLIDATION_LIMITS, type ConsolidationStorage, type ConsolidationWindow } from '../core/domain/consolidation.ts';
import { extractConsolidation } from '../core/use-cases/extract-consolidation.ts';
import type { Ctx } from '../core/domain/memory.ts';
import type { RuntimeConfig } from '../core/domain/config.ts';
import type { AgentRunner } from '../core/ports/runner.ts';
import type { ModelProvider } from '../core/ports/model.ts';
import type { JobScope, Admission } from '../core/domain/job.ts';
import type { openDaemonJobs } from './jobs.ts';
import { consolidationSubmitSchema, checkConsolidationRequest } from '../contracts/consolidation.ts';
import { project } from '../platform/project.ts';
import { localOllamaSelection } from '../adapters/models/own-inference-policy.ts';

export const CONSOLIDATION_RUNNER = 'bosun-consolidation';
export type ConsolidationPolicy = { maxOutstanding: number; maxSources: number; maxProposals: number; maxInputBytes: number; timeoutMs: number; allowRemoteApi: boolean };
export function createConsolidationService(options: {
  config: RuntimeConfig; providers: Readonly<Record<string, ModelProvider>>; storage: ConsolidationStorage; jobs: ReturnType<typeof openDaemonJobs>;
  schedule(): void; publish(): Promise<void>; policy?: Partial<ConsolidationPolicy>;
  admit?(providerId: string, model: string, signal: AbortSignal): Promise<Admission>;
}) {
  const policy: ConsolidationPolicy = { maxOutstanding: CONSOLIDATION_LIMITS.outstanding, maxSources: CONSOLIDATION_LIMITS.sources, maxProposals: CONSOLIDATION_LIMITS.proposals,
    maxInputBytes: CONSOLIDATION_LIMITS.inputBytes, timeoutMs: CONSOLIDATION_LIMITS.timeoutMs, allowRemoteApi: false, ...options.policy };
  const integer = (value: number, min: number, max: number) => Number.isSafeInteger(value) && value >= min && value <= max;
  if (!integer(policy.maxOutstanding, 1, 20) || !integer(policy.maxSources, 1, 8) || !integer(policy.maxProposals, 1, 4)
    || !integer(policy.maxInputBytes, 4096, 24576) || !integer(policy.timeoutMs, 1, 300000) || typeof policy.allowRemoteApi !== 'boolean') throw new BosunError('invalid', 'Invalid consolidation policy');
  const scope = (value: JobScope, sessionId: string | null): Ctx => {
    options.jobs.assertOwner(); if (value.audience !== 'owner' || !value.projectId || sessionId !== null && (typeof sessionId !== 'string' || sessionId.length > 200 || sessionId.includes('\0'))) throw new BosunError('unsupported', 'Owner operation required');
    return { projectId: value.projectId, sessionId, linked: [], audience: 'owner' };
  };
  function configured() {
    if (!options.config.graph.enabled || !options.config.graph.extraction) throw new BosunError('unsupported', 'Graph extraction disabled');
    const providerId = options.config.graph.provider; const settings = options.config.providers[providerId]; const provider = options.providers[providerId];
    if (!settings || !provider) throw new BosunError('unsupported', 'Consolidation provider unavailable');
    if (!['ollama', 'openai-compatible'].includes(settings.kind)) throw new BosunError('unsupported', 'Native subscription own inference unsupported');
    if (settings.kind === 'openai-compatible' && !policy.allowRemoteApi) throw new BosunError('unsupported', 'Remote consolidation requires owner opt-in');
    if (settings.kind === 'ollama' && /(?:^|:)cloud(?:-|$)/i.test(settings.model)) throw new BosunError('unsupported', 'Local consolidation model required');
    return { providerId, settings, provider };
  }
  async function admitted(providerId: string, model: string, kind: string, signal: AbortSignal): Promise<Admission> {
    if (options.admit) return options.admit(providerId, model, signal);
    return kind === 'ollama' ? { allowed: true } : { allowed: false, reason: 'admission_unavailable' };
  }
  const fitParents = (window: ConsolidationWindow): ConsolidationWindow => {
    const sources = window.sources.map((s) => ({ id: s.id, title: s.title, text: s.text })); let bytes = 2048 + Buffer.byteLength(JSON.stringify(sources)); const parents = [];
    for (const parent of window.parents) { const size = Buffer.byteLength(JSON.stringify(parent)); if (bytes + size > policy.maxInputBytes) continue; bytes += size; parents.push(parent); }
    return { ...window, parents };
  };
  return {
    policy: Object.freeze(policy),
    async submit(input: unknown, ownerScope: JobScope, workspace: string, sessionId: string | null, signal: AbortSignal = new AbortController().signal) {
      const ctx = scope(ownerScope, sessionId); const parsed = consolidationSubmitSchema.safeParse(input); if (!parsed.success) throw new BosunError('invalid', 'Invalid consolidation request');
      if (project(workspace).id !== ctx.projectId) throw new BosunError('conflict', 'Consolidation workspace changed');
      const requestId = 'consolidation_' + crypto.createHash('sha256').update(parsed.data.requestId).digest('hex');
      const duplicate = options.jobs.findRequest(ownerScope, requestId); if (duplicate) return { state: 'duplicate' as const, job: duplicate, duplicate: true as const };
      const window = options.storage.window(ctx, { maxSources: policy.maxSources, maxInputBytes: policy.maxInputBytes, maxOutstanding: policy.maxOutstanding });
      if (window.state !== 'ready') return { state: 'held' as const, reason: window.state === 'backpressure' ? 'proposal_backpressure' : 'source_reservation', cursor: window.cursor };
      if (window.through === window.cursor && !window.sources.length) return { state: 'idle' as const, cursor: window.cursor };
      const { providerId, settings } = configured(); const admission = await admitted(providerId, settings.model, settings.kind, signal);
      if (admission.allowed === false) return { state: 'held' as const, reason: admission.reason, cursor: window.cursor };
      options.jobs.assertOwner(); if (signal.aborted) throw new BosunError('cancelled', 'Consolidation cancelled');
      const request = { requestId: parsed.data.requestId, projectId: ctx.projectId!, sessionId: ctx.sessionId, cursor: window.cursor, through: window.through,
        sources: window.sources.map((s) => ({ memoryId: s.id, version: s.version, hash: s.hash })), providerId, model: settings.model };
      const result = options.jobs.submit({ privacy: 'public', ownerOnly: true, requestId, taskId: crypto.randomUUID(),
        runnerId: CONSOLIDATION_RUNNER, prompt: JSON.stringify(request), cwd: workspace, access: 'read', model: settings.model }, ownerScope);
      options.schedule(); return { state: 'queued' as const, ...result };
    },
    status(ownerScope: JobScope, sessionId: string | null) { return options.storage.status(scope(ownerScope, sessionId)); },
    proposals(ownerScope: JobScope, sessionId: string | null, limit = 20) { return options.storage.proposals(scope(ownerScope, sessionId), limit); },
    async abandon(ownerScope: JobScope, sessionId: string | null, id: string, version: number) {
      const result = options.storage.abandon(scope(ownerScope, sessionId), id, version); await options.publish(); options.jobs.assertOwner(); return result;
    },
    runner(): AgentRunner {
      return { id: CONSOLIDATION_RUNNER, caps: { vendor: 'configured-provider', readOnly: 'verified', sandbox: 'none', mcpInject: 'unsupported', effort: 'unsupported', localBackend: 'unverified', billing: 'unknown' },
        detect: async () => ({ installed: true }), async *run(spec) {
          requirePublicInput(spec); const deadline = AbortSignal.any([spec.signal, AbortSignal.timeout(policy.timeoutMs)]);
          if (deadline.aborted) throw new BosunError('cancelled', 'Consolidation cancelled');
          let parsed: unknown; try { parsed = JSON.parse(spec.prompt); } catch { throw new BosunError('invalid', 'Invalid consolidation request'); }
          const request = checkConsolidationRequest(parsed); const ownerScope = { projectId: project(spec.cwd).id, audience: 'owner' as const }; const ctx = scope(ownerScope, request.sessionId);
          if (request.projectId !== ctx.projectId || spec.access !== 'read') throw new BosunError('conflict', 'Consolidation scope changed');
          const { providerId, settings, provider } = configured(); if (request.providerId !== providerId || request.model !== settings.model || spec.model !== settings.model) throw new BosunError('conflict', 'Consolidation model changed');
          // Before provider access, validate all references with their current source flags/content.
          const claimed = options.storage.claim(ctx, request, policy.maxOutstanding); await options.publish();
          options.jobs.assertOwner(); if (deadline.aborted) throw new BosunError('cancelled', 'Consolidation cancelled', { details: { outcome: 'unknown' } });
          if (claimed.window.sources.length) {
            const admission = await admitted(providerId, settings.model, settings.kind, deadline); if (admission.allowed === false) throw new BosunError('unavailable', 'Consolidation admission held');
            if (settings.kind === 'ollama' && !await localOllamaSelection(settings, deadline)) throw new BosunError('unavailable', 'Local consolidation model unavailable');
            const window = fitParents(options.storage.capture(ctx, claimed.claim));
            const generated = await extractConsolidation({ privacy: 'public', window }, { provider, providerId, model: settings.model, transport: settings.kind,
              maxInputBytes: policy.maxInputBytes, maxProposals: Math.min(policy.maxProposals, policy.maxOutstanding - window.outstanding), signal: deadline });
            options.jobs.assertOwner(); if (deadline.aborted) throw new BosunError('cancelled', 'Consolidation cancelled', { details: { outcome: 'unknown' } });
            const receipt = options.storage.commit(ctx, claimed.claim, generated.proposals, policy.maxOutstanding); await options.publish();
            if (generated.tokensIn !== undefined || generated.tokensOut !== undefined) yield { t: 'usage', ...(generated.tokensIn === undefined ? {} : { tokensIn: generated.tokensIn }), ...(generated.tokensOut === undefined ? {} : { tokensOut: generated.tokensOut }) };
            yield { t: 'done', code: 0, result: JSON.stringify(receipt) };
          } else {
            const receipt = options.storage.commit(ctx, claimed.claim, [], policy.maxOutstanding); await options.publish(); yield { t: 'done', code: 0, result: JSON.stringify(receipt) };
          }
        } };
    },
  };
}
