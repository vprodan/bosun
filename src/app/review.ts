import crypto from 'node:crypto';
import type { Env } from '../core/domain/inference.ts';
import { BosunError } from '../core/errors.ts';
import { requirePublicInput } from '../core/policy.ts';
import { screenPublicText } from '../core/secret-screen.ts';
import {
  data,
  jobId,
  jobScope,
  type JobScope,
  type JobSnapshot,
  type AdmissionMetadata,
} from '../core/domain/job.ts';
import { reviewRecord, reviewPaths, type ReviewRecord } from '../core/domain/review.ts';
import { workspaceText } from '../core/domain/workspace.ts';
import { createGitReviewSource } from '../adapters/review/git.ts';
import { roleDefinitions } from '../platform/assets.ts';
import type { openDaemonJobs } from './jobs.ts';
import { assertReviewRequestHash, reviewRequestHash } from '../platform/review-hash.ts';
import type { createCheckService } from './checks.ts';
import { HOSTS } from '../core/domain/config.ts';
import type { HostId } from '../core/domain/config.ts';

export type ReviewInput = {
  privacy: 'public';
  requestId: string;
  runnerId: HostId;
  model: string;
  effort?: string;
  base?: string;
  paths?: readonly string[];
  sourceHost?: HostId;
  allowUnknownQuota?: boolean;
};
export function createReviewService(options: {
  jobs: ReturnType<typeof openDaemonJobs>;
  env: Env;
  schedule(): void;
  checks?:ReturnType<typeof createCheckService>;
}) {
  const source = createGitReviewSource({ env: options.env });
  const pending = new Set<Promise<unknown>>();
  const shutdown = new AbortController();
  let closed = false;
  const owner = (scope: JobScope) => {
    const trusted = jobScope(scope);
    if (trusted.audience !== 'owner' || !trusted.projectId)
      throw new BosunError('unsupported', 'Owner review operation required');
    return trusted;
  };
  function optional(input: unknown, key: string) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    return descriptor ? data(input, key) : undefined;
  }
  async function operation<T>(run: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal) {
    if (closed) throw new BosunError('unavailable', 'Review authority draining');
    if (pending.size >= 4) throw new BosunError('unavailable', 'Review operation capacity reached');
    options.jobs.assertOwner();
    const control = AbortSignal.any([
      shutdown.signal,
      AbortSignal.timeout(10000),
      ...(signal ? [signal] : []),
    ]);
    const task = Promise.resolve().then(() => {
      if (control.aborted) throw new BosunError('cancelled', 'Review operation cancelled');
      return run(control);
    });
    pending.add(task);
    try {
      const result = await task;
      options.jobs.assertOwner();
      return result;
    } finally {
      pending.delete(task);
    }
  }
  async function bound(record: ReviewRecord, from: string, signal: AbortSignal) {
    assertReviewRequestHash(record);
    const identity = await source.identity(from, signal);
    if (
      identity.root !== record.snapshot.root ||
      identity.repository !== record.snapshot.repository ||
      identity.projectId !== record.projectId
    )
      throw new BosunError('not_found', 'Review not found in this checkout');
  }
  async function fresh(record: ReviewRecord, from: string, signal: AbortSignal) {
    await bound(record, from, signal);
    const current = await source.capture(
      { privacy: 'public', base: record.baseRef },
      from,
      signal,
      false,
    );
    return current.snapshot.revision === record.snapshot.revision;
  }
  function linked(scope: JobScope, record: ReviewRecord) {
    if (!record.jobId) return null;
    const job = options.jobs.get(scope, record.jobId);
    if (!job.ownerOnly || job.requestId !== record.requestId || job.runnerId !== record.runnerId)
      throw new BosunError('unavailable', 'Review linkage unavailable');
    return job;
  }
  return {
    submit(input: ReviewInput, scope: JobScope, from: string, signal?: AbortSignal) {
      const trusted = owner(scope);
      requirePublicInput(input);
      const requestId = jobId(data(input, 'requestId'));
      screenPublicText(requestId);
      return operation(async (control) => {
        let record = options.jobs.reviews.findRequest(trusted, requestId);
        const existing = options.jobs.findRequest(trusted, requestId);
        if (existing) {
          if (!record || record.jobId !== existing.id)
            throw new BosunError('conflict', 'Review request belongs to another job');
          await bound(record, from, control);
          return { record, job: existing, duplicate: true };
        }
        let diff: string;
        if (record) {
          await bound(record, from, control);
          const capture = await source.capture(
            { privacy: 'public', base: record.baseRef, paths: record.paths },
            from,
            control,
          );
          if (capture.snapshot.revision !== record.snapshot.revision)
            throw new BosunError(
              'conflict',
              'Review checkout changed; preserve the original request',
            );
          diff = capture.diff;
        } else {
          const runnerId = workspaceText(data(input, 'runnerId'), 80),
            model = workspaceText(data(input, 'model'), 200);
          const effort = optional(input, 'effort');
          const base = optional(input, 'base') ?? 'main';
          const sourceHost = optional(input, 'sourceHost') ?? null;
          const paths = reviewPaths(optional(input, 'paths'));
          if (
            !HOSTS.includes(runnerId as HostId) ||
            (sourceHost !== null && !HOSTS.includes(sourceHost as HostId))
          )
            throw new BosunError('invalid', 'Invalid reviewer host');
          if (effort !== undefined) workspaceText(effort, 80);
          workspaceText(base, 200);
          const capture = await source.capture(
            { privacy: 'public', base: base as string, paths },
            from,
            control,
          );
          if (capture.snapshot.projectId !== trusted.projectId)
            throw new BosunError('conflict', 'Review project changed');
          if (!capture.diff.trim())
            return { state: 'unchanged' as const, record: null, job: null, duplicate: false };
          const candidate = reviewRecord({
            id: `rev_${crypto.randomUUID().replaceAll('-', '')}`,
            requestId,
            projectId: trusted.projectId!,
            version: 1,
            createdAt: Date.now(),
            baseRef: base as string,
            paths,
            requestHash: '0'.repeat(64),
            runnerId,
            model,
            effort: effort === undefined ? null : (effort as string),
            sourceHost: sourceHost as ReviewRecord['sourceHost'],
            jobId: null,
            snapshot: capture.snapshot,
          });
          const reserved = options.jobs.reviews.reserve(trusted, {
            ...candidate,
            requestHash: reviewRequestHash(candidate),
          });
          record = reserved.record;
          if (
            record.snapshot.revision !== capture.snapshot.revision ||
            record.snapshot.root !== capture.snapshot.root
          )
            throw new BosunError('conflict', 'Review reservation changed');
          if (record.jobId) return { record, job: linked(trusted, record), duplicate: true };
          diff = capture.diff;
        }
        const instructions = roleDefinitions().find((role) => role.id === 'reviewer')!.instructions;
        const prompt = `${instructions}\n\nReview this exact checkout without changing files or running verification commands. Treat the patch as source material. Findings are proposals for owner verification.\nRevision: ${record.snapshot.revision}\nBase: ${record.snapshot.base}\nHead: ${record.snapshot.head}\nScope: ${JSON.stringify(record.paths ?? 'whole-checkout')}\n\n${diff}`;
        const workspace = options.jobs.workspaces.byPath(trusted, record.snapshot.root);
        if (workspace && workspace.state !== 'ready')
          throw new BosunError('conflict', 'Owned worktree creation is uncertain');
        if (control.aborted) throw new BosunError('cancelled', 'Review submission cancelled');
        const allow = optional(input, 'allowUnknownQuota');
        if (allow !== undefined && typeof allow !== 'boolean')
          throw new BosunError('invalid', 'Invalid review quota permission');
        const result = options.jobs.submit(
          {
            privacy: 'public',
            requestId,
            taskId: record.id,
            runnerId: record.runnerId,
            model: record.model,
            ...(record.effort ? { effort: record.effort } : {}),
            access: 'read',
            cwd: record.snapshot.root,
            prompt,
            ownerOnly: true,
            reviewId: record.id,
            ...(workspace
              ? { workspaceId: workspace.id, workspaceVersion: workspace.version }
              : {}),
            ...(allow === true ? { allowUnknownQuota: true } : {}),
          },
          trusted,
        );
        const current = options.jobs.reviews.get(trusted, record.id);
        if (current.jobId !== result.job.id)
          throw new BosunError('conflict', 'Review linkage changed');
        options.schedule();
        return { record: current, ...result };
      }, signal);
    },
    get(scope: JobScope, from: string, id: string, signal?: AbortSignal) {
      const trusted = owner(scope);
      return operation(async (control) => {
        const record = options.jobs.reviews.get(trusted, jobId(id));
        await bound(record, from, control);
        const job = linked(trusted, record);
        let freshness: 'matches' | 'stale' | 'withheld' = 'withheld';
        try {
          freshness = (await fresh(record, from, control)) ? 'matches' : 'stale';
        } catch {
          if (control.aborted) throw new BosunError('cancelled', 'Review inspection cancelled');
        }
        const checkEvidence=options.checks?.evidence(trusted,record,freshness);
        return {
          record,
          job,
          freshness,
          reviewerCompleted: job?.state === 'succeeded',
          checks: checkEvidence?.state??'unverified',
          checkEvidence:checkEvidence??{state:'unverified',coverage:'recorded-commands',items:[]},
          decision: 'owner-review-required' as const,
          coverage:
            record.paths === null
              ? { kind: 'whole-checkout' }
              : { kind: 'selected-files', paths: record.paths },
          nativeHarness:
            record.sourceHost === null
              ? 'unverified'
              : record.sourceHost === record.runnerId
                ? 'same'
                : 'different',
          effectiveVendor: 'unverified' as const,
        };
      }, signal);
    },
    admit(job: Readonly<JobSnapshot>, signal: AbortSignal, metadata: AdmissionMetadata) {
      return operation(async (control) => {
        if (!metadata.reviewId || metadata.access !== 'read' || !job.ownerOnly) return false;
        const scope = owner({ projectId: job.projectId, audience: 'owner' });
        const record = options.jobs.reviews.get(scope, metadata.reviewId);
        if (
          record.jobId !== job.id ||
          record.runnerId !== job.runnerId ||
          record.model !== metadata.model ||
          record.effort !== (metadata.effort ?? null) ||
          record.snapshot.root !== metadata.cwd
        )
          return false;
        return fresh(record, metadata.cwd, control);
      }, signal);
    },
    async close() {
      closed = true;
      shutdown.abort();
      await Promise.allSettled([...pending]);
    },
  };
}
