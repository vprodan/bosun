import crypto from 'node:crypto';
import { BosunError } from '../core/errors.ts';
import { requireCapability, requirePublicInput } from '../core/policy.ts';
import { screenPublicText } from '../core/secret-screen.ts';
import { SUMMARY_LIMITS, type EvidenceSummary } from '../core/domain/summary.ts';
import { publicSummaryEvidence, summarizeEvidence } from '../core/use-cases/summarize-evidence.ts';
import { handoffSummarizeSchema } from '../contracts/handoff.ts';
import type { RuntimeConfig } from '../core/domain/config.ts';
import type { AgentRunner } from '../core/ports/runner.ts';
import type { ModelProvider } from '../core/ports/model.ts';
import type { JobScope } from '../core/domain/job.ts';
import { data } from '../core/domain/job.ts';
import type { openDaemonJobs } from './jobs.ts';
import type { createHandoffArtifacts } from './handoff.ts';
import { project } from '../platform/project.ts';

export const SUMMARY_RUNNER = 'bosun-summary';
export function createSummaryService(options: { config: RuntimeConfig; providers: Readonly<Record<string, ModelProvider>>;
  jobs: ReturnType<typeof openDaemonJobs>; handoffs: ReturnType<typeof createHandoffArtifacts>; schedule(): void }) {
  function validate(input: unknown, scope: JobScope) {
    options.jobs.assertOwner(); if (scope.audience !== 'owner' || !scope.projectId) throw new BosunError('unsupported', 'Owner operation required');
    requirePublicInput(input as { privacy?: unknown });
    // Classification of every event precedes schema/content reads. The model
    // receives only these excerpts, never the factual authority fields below.
    const raw = Object.getOwnPropertyDescriptor(input as object, 'evidence');
    if (!raw || !Object.hasOwn(raw, 'value') || !Array.isArray(raw.value) || raw.value.length > SUMMARY_LIMITS.events) throw new BosunError('invalid', 'Invalid summary request');
    const evidence = raw.value.map(publicSummaryEvidence);
    const parsed = handoffSummarizeSchema.safeParse({ privacy: 'public', requestId: data(input, 'requestId'), facts: data(input, 'facts'), afterCursor: data(input, 'afterCursor'), evidence });
    if (!parsed.success || parsed.data.facts.repository.projectId !== scope.projectId) throw new BosunError('invalid', 'Invalid summary request');
    const request = parsed.data; screenPublicText(JSON.stringify(request));
    if (request.evidence.at(-1)!.cursor !== request.facts.source.completedEventCursor) throw new BosunError('invalid', 'Summary cursor mismatch');
    let previous: EvidenceSummary | undefined;
    if (request.facts.parentId) {
      const parent = options.handoffs.get(scope, request.facts.parentId).manifest;
      const current = request.facts.source; const source = parent.facts.source;
      if (!parent.summary || request.afterCursor !== source.completedEventCursor || current.completedEventCursor === source.completedEventCursor
        || current.hostId !== source.hostId || current.sessionId !== source.sessionId || current.generation !== source.generation
        || current.model !== source.model || current.access !== source.access || current.effort !== source.effort) throw new BosunError('conflict', 'Summary source changed');
      previous = parent.summary;
    } else if (request.afterCursor !== null) throw new BosunError('invalid', 'Initial summary cursor required');
    const providerId = options.config.handoff.provider; const settings = options.config.providers[providerId]; const provider = options.providers[providerId];
    if (!settings || !provider) throw new BosunError('unsupported', 'Summary provider unavailable');
    requireCapability(provider.caps.structured, 'structured summary'); requireCapability(provider.caps.toolFree, 'tool-free summary');
    return { request, previous, providerId, settings, provider };
  }
  return {
    submit(input: unknown, scope: JobScope, workspace: string) {
      const { request, settings } = validate(input, scope);
      const result = options.jobs.submit({ privacy: 'public', ownerOnly: true, requestId: 'summary_' + crypto.createHash('sha256').update(request.requestId).digest('hex'), taskId: crypto.randomUUID(), runnerId: SUMMARY_RUNNER,
        prompt: JSON.stringify(request), cwd: workspace, access: 'read', model: settings.model }, scope);
      options.schedule(); return result;
    },
    runner(): AgentRunner {
      return { id: SUMMARY_RUNNER,
        caps: { vendor: 'configured-provider', readOnly: 'verified', sandbox: 'none', mcpInject: 'unsupported', effort: 'unsupported', localBackend: 'unverified', billing: 'unknown' },
        detect: async () => ({ installed: true }),
        async *run(spec) {
          requirePublicInput(spec); if (spec.signal.aborted) throw new BosunError('cancelled', 'Summary cancelled');
          let input: unknown; try { input = JSON.parse(spec.prompt); } catch { throw new BosunError('invalid', 'Invalid summary request'); }
          const scope = { projectId: project(spec.cwd).id, audience: 'owner' as const };
          const { request, previous, providerId, settings, provider } = validate(input, scope);
          if (spec.model !== settings.model || spec.access !== 'read') throw new BosunError('conflict', 'Summary model changed');
          const maxInputBytes = Math.min(SUMMARY_LIMITS.chunkBytes, options.config.handoff.maxInputTokens,
            settings.kind === 'ollama' ? options.config.local.contextTokens - options.config.handoff.maxSummaryTokens - 2048 : SUMMARY_LIMITS.chunkBytes);
          const result = await summarizeEvidence({ privacy: 'public', evidence: request.evidence, ...(previous ? { previous } : {}) },
            { provider, providerId, model: settings.model, maxInputBytes, signal: spec.signal,
              hash: value => crypto.createHash('sha256').update(value).digest('hex') });
          options.jobs.assertOwner(); if (spec.signal.aborted) throw new BosunError('cancelled', 'Summary cancelled');
          const artifact = options.handoffs.createSummary(scope, 'summary_' + crypto.createHash('sha256').update(request.requestId).digest('hex'), request.facts, result.summary);
          if (result.tokensIn !== undefined || result.tokensOut !== undefined) yield { t: 'usage',
            ...(result.tokensIn === undefined ? {} : { tokensIn: result.tokensIn }), ...(result.tokensOut === undefined ? {} : { tokensOut: result.tokensOut }) };
          yield { t: 'done', code: 0, result: JSON.stringify(artifact) };
        },
      };
    },
  };
}
