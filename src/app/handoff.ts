import crypto from 'node:crypto';
import { BosunError } from '../core/errors.ts';
import { requirePublicInput } from '../core/policy.ts';
import { handoffCreateSchema, type HandoffBundle } from '../contracts/handoff.ts';
import { buildHandoffBundle, publishHandoff, readHandoff, validateHandoffBundle } from '../adapters/handoff/artifacts.ts';
import type { JobScope } from '../core/domain/job.ts';
import type { HandoffPointer } from '../core/domain/session.ts';
import type { openDaemonJobs } from './jobs.ts';
import type { EvidenceSummary } from '../core/domain/summary.ts';
import type { HandoffFacts } from '../contracts/handoff.ts';

export function createHandoffArtifacts(options: { root: string; jobs: ReturnType<typeof openDaemonJobs>; now?: () => number; id?: () => string }) {
  const now = options.now ?? Date.now; const id = options.id ?? crypto.randomUUID;
  function owner(scope: JobScope): string {
    options.jobs.assertOwner();
    if (scope.audience !== 'owner' || !scope.projectId || !/^p_[a-f0-9]{16}$/.test(scope.projectId)) throw new BosunError('unsupported', 'Owner operation required');
    return scope.projectId;
  }
  const load = (scope: JobScope, pointer: HandoffPointer) => readHandoff(options.root, pointer.id, pointer);
  function save(scope: JobScope, requestId: string, bundle: HandoffBundle) {
    const projectId = owner(scope);
    if (bundle.manifest.facts.repository.projectId !== projectId) throw new BosunError('invalid', 'Handoff project mismatch');
    publishHandoff(options.root, bundle); options.jobs.assertOwner();
    return options.jobs.handoffs.put(scope, { id: bundle.manifest.id, requestId, projectId, createdAt: bundle.manifest.createdAt,
      manifestHash: bundle.manifestHash, markdownHash: bundle.markdownHash });
  }
  return {
    createSummary(scope: JobScope, requestId: string, facts: HandoffFacts, summary: EvidenceSummary) {
      owner(scope);
      const previous = options.jobs.handoffs.findRequest(scope, requestId);
      if (previous) { load(scope, previous); return { artifact: previous, duplicate: true }; }
      const bundle = buildHandoffBundle({ schemaVersion: 1, privacy: 'public', id: id(), createdAt: now(), facts, summary });
      return { artifact: save(scope, requestId, bundle), duplicate: false };
    },
    create(input: unknown, scope: JobScope) {
      owner(scope); requirePublicInput(input as { privacy?: unknown });
      const parsed = handoffCreateSchema.safeParse(input); if (!parsed.success) throw new BosunError('invalid', 'Invalid handoff request');
      const previous = options.jobs.handoffs.findRequest(scope, parsed.data.requestId); if (previous) { load(scope, previous); return { artifact: previous, duplicate: true }; }
      const bundle = buildHandoffBundle({ schemaVersion: 1, privacy: 'public', id: id(), createdAt: now(), facts: parsed.data.facts, summary: null });
      return { artifact: save(scope, parsed.data.requestId, bundle), duplicate: false };
    },
    get(scope: JobScope, artifactId: string) { owner(scope); return load(scope, options.jobs.handoffs.get(scope, artifactId)); },
    list(scope: JobScope, limit?: number) { owner(scope); return options.jobs.handoffs.list(scope, limit); },
    import(scope: JobScope, requestId: string, input: HandoffBundle) {
      owner(scope); const bundle = validateHandoffBundle(input);
      const previous = options.jobs.handoffs.findRequest(scope, requestId);
      if (previous) {
        const existing = load(scope, previous);
        if (existing.manifestHash !== bundle.manifestHash || existing.markdownHash !== bundle.markdownHash) throw new BosunError('conflict', 'Handoff request exists');
        return { artifact: previous, duplicate: true, continuation: 'manual-review-required' as const };
      }
      return { artifact: save(scope, requestId, bundle), duplicate: false, continuation: 'manual-review-required' as const };
    },
  };
}
