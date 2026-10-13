import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BosunError } from '../core/errors.ts';
import { requirePublicInput } from '../core/policy.ts';
import {
  data,
  jobId,
  jobScope,
  type JobScope,
  type JobSnapshot,
  type AdmissionMetadata,
} from '../core/domain/job.ts';
import {
  CHECK_RUNNER,
  CHECK_LIMITS,
  checkArgs,
  checkRecord,
  type CheckRecord,
  type CheckOutcome,
  type CheckExecutable,
} from '../core/domain/check.ts';
import { workspaceText } from '../core/domain/workspace.ts';
import { assertReviewRequestHash } from '../platform/review-hash.ts';
import {
  assertCheckHash,
  captureCheckExecutable,
  checkEnvironment,
  checkEnvironmentHash,
  checkCommandHash,
  checkRequestHash,
} from '../platform/check-command.ts';
import { createGitReviewSource } from '../adapters/review/git.ts';
import { privateDirectory } from '../platform/private-file.ts';
import { project } from '../platform/project.ts';
import { streamProcess } from '../platform/process.ts';
import type { Env } from '../core/domain/inference.ts';
import type { AgentRunner } from '../core/ports/runner.ts';
import type { openDaemonJobs } from './jobs.ts';
import type { ReviewRecord } from '../core/domain/review.ts';

export type CheckInput = {
  privacy: 'public';
  requestId: string;
  reviewId: string;
  command: string;
  args: readonly string[];
  timeoutMs?: number;
};
export function createCheckService(options: {
  jobs: ReturnType<typeof openDaemonJobs>;
  env: Env;
  home: string;
  schedule(): void;
}) {
  const source = createGitReviewSource({ env: options.env });
  const shutdown = new AbortController();
  const pending = new Set<Promise<unknown>>();
  let closed = false;
  const owner = (scope: JobScope) => {
    const trusted = jobScope(scope);
    if (trusted.audience !== 'owner' || !trusted.projectId)
      throw new BosunError('unsupported', 'Owner verification operation required');
    return trusted;
  };
  const optional = (input: unknown, key: string) =>
    Object.getOwnPropertyDescriptor(input, key) ? data(input, key) : undefined;
  async function operation<T>(run: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal) {
    if (closed || pending.size >= 4)
      throw new BosunError('unavailable', 'Verification authority unavailable');
    options.jobs.assertOwner();
    const control = AbortSignal.any([
      shutdown.signal,
      AbortSignal.timeout(10000),
      ...(signal ? [signal] : []),
    ]);
    const task = Promise.resolve().then(() => {
      if (control.aborted) throw new BosunError('cancelled', 'Verification operation cancelled');
      return run(control);
    });
    pending.add(task);
    try {
      return await task;
    } finally {
      pending.delete(task);
    }
  }
  async function bound(record: CheckRecord, scope: JobScope, from: string, signal: AbortSignal) {
    assertCheckHash(record);
    const review = options.jobs.reviews.get(scope, record.reviewId);
    assertReviewRequestHash(review);
    const identity = await source.identity(from, signal);
    if (
      identity.root !== record.root ||
      identity.repository !== review.snapshot.repository ||
      identity.projectId !== record.projectId ||
      record.revision !== review.snapshot.revision
    )
      throw new BosunError('not_found', 'Verification evidence not found in this checkout');
    return review;
  }
  async function current(record: CheckRecord, scope: JobScope, from: string, signal: AbortSignal) {
    const review = await bound(record, scope, from, signal);
    const captured = await source.capture(
      { privacy: 'public', base: review.baseRef },
      from,
      signal,
      false,
    );
    const command = captureCheckExecutable(record.executable.path, options.env);
    return {
      checkout: captured.snapshot.revision === record.revision,
      command:
        JSON.stringify(command) === JSON.stringify(record.executable) &&
        checkEnvironmentHash(options.env) === record.environmentHash,
      revision: captured.snapshot.revision,
    };
  }
  function linked(scope: JobScope, record: CheckRecord) {
    if (!record.jobId) return null;
    const job = options.jobs.get(scope, record.jobId);
    if (!job.ownerOnly || job.runnerId !== CHECK_RUNNER || job.requestId !== record.requestId)
      throw new BosunError('unavailable', 'Verification linkage unavailable');
    return job;
  }
  function home(record: CheckRecord) {
    privateDirectory(options.home);
    const parent = path.join(options.home, 'checks');
    try {
      fs.mkdirSync(parent, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    privateDirectory(parent);
    const folder = path.join(parent, record.id);
    fs.mkdirSync(folder, { mode: 0o700 });
    privateDirectory(folder);
    return folder;
  }
  return {
    submit(input: CheckInput, scope: JobScope, from: string, signal?: AbortSignal) {
      const trusted = owner(scope);
      requirePublicInput(input);
      const requestId = jobId(data(input, 'requestId'));
      workspaceText(requestId);
      return operation(async (control) => {
        let record = options.jobs.checks.findRequest(trusted, requestId);
        const existing = options.jobs.findRequest(trusted, requestId);
        if (existing) {
          if (!record || record.jobId !== existing.id)
            throw new BosunError('conflict', 'Verification request belongs to another job');
          await bound(record, trusted, from, control);
          return { record, job: existing, duplicate: true };
        }
        if (!record) {
          const reviewId = jobId(data(input, 'reviewId'));
          const review = options.jobs.reviews.get(trusted, reviewId);
          assertReviewRequestHash(review);
          const identity = await source.identity(from, control);
          if (
            identity.root !== review.snapshot.root ||
            identity.repository !== review.snapshot.repository ||
            identity.projectId !== trusted.projectId
          )
            throw new BosunError('not_found', 'Review not found in this checkout');
          const command = workspaceText(data(input, 'command'));
          const args = checkArgs(data(input, 'args'));
          const executable = captureCheckExecutable(command, options.env);
          const timeoutMs = optional(input, 'timeoutMs') ?? CHECK_LIMITS.timeoutMs;
          const candidate = checkRecord({
            id: `chk_${crypto.randomUUID().replaceAll('-', '')}`,
            projectId: trusted.projectId!,
            requestId,
            reviewId,
            jobId: null,
            version: 1,
            createdAt: Date.now(),
            root: review.snapshot.root,
            revision: review.snapshot.revision,
            executable,
            args,
            environmentHash: checkEnvironmentHash(options.env),
            timeoutMs: timeoutMs as number,
            commandHash: '0'.repeat(64),
            requestHash: '0'.repeat(64),
            outcome: null,
          });
          const commandHash = checkCommandHash(candidate);
          const accepted = checkRecord({ ...candidate, commandHash });
          const prior = options.jobs.checks
            .list(trusted, reviewId)
            .find(
              (item) =>
                item.executable.path === accepted.executable.path &&
                JSON.stringify(item.args) === JSON.stringify(accepted.args) &&
                item.jobId &&
                ['queued', 'held', 'running', 'unknown'].includes(
                  options.jobs.get(trusted, item.jobId).state,
                ),
            );
          if (prior)
            throw new BosunError('conflict', 'This command has an unsettled original request');
          // Seal before source qualification; fingerprints contain immutable inputs only.
          const sealed = checkRecord({ ...accepted, requestHash: checkRequestHash(accepted) });
          const ready = await current(sealed, trusted, from, control);
          if (!ready.checkout || !ready.command)
            throw new BosunError('conflict', 'Verification source or command changed');
          record = options.jobs.checks.reserve(trusted, sealed).record;
        }
        if (record.jobId) {
          const job = linked(trusted, record);
          if (!job) throw new BosunError('unavailable', 'Verification linkage unavailable');
          return { record, job, duplicate: true };
        }
        const ready = await current(record, trusted, from, control);
        if (!ready.checkout || !ready.command)
          throw new BosunError('conflict', 'Verification source or command changed');
        const workspace = options.jobs.workspaces.byPath(trusted, record.root);
        if (workspace && workspace.state !== 'ready')
          throw new BosunError('conflict', 'Owned checkout creation is uncertain');
        if (control.aborted) throw new BosunError('cancelled', 'Verification submission cancelled');
        const result = options.jobs.submit(
          {
            privacy: 'public',
            requestId,
            taskId: record.id,
            runnerId: CHECK_RUNNER,
            prompt: JSON.stringify({ checkId: record.id }),
            cwd: record.root,
            access: 'edit',
            model: 'verification',
            ownerOnly: true,
            checkId: record.id,
            ...(workspace
              ? { workspaceId: workspace.id, workspaceVersion: workspace.version }
              : {}),
          },
          trusted,
        );
        const saved = options.jobs.checks.get(trusted, record.id);
        if (saved.jobId !== result.job.id)
          throw new BosunError('conflict', 'Verification link changed');
        options.schedule();
        return { record: saved, ...result };
      }, signal);
    },
    get(scope: JobScope, from: string, id: string, signal?: AbortSignal) {
      const trusted = owner(scope);
      return operation(async (control) => {
        const record = options.jobs.checks.get(trusted, jobId(id));
        await bound(record, trusted, from, control);
        const job = linked(trusted, record);
        let freshness: 'matches' | 'stale' | 'withheld' = 'withheld';
        let command: 'matches' | 'changed' | 'withheld' = 'withheld';
        try {
          const state = await current(record, trusted, from, control);
          freshness = state.checkout ? 'matches' : 'stale';
          command = state.command ? 'matches' : 'changed';
        } catch {
          if (control.aborted)
            throw new BosunError('cancelled', 'Verification inspection cancelled');
        }
        const outcome = record.outcome;
        const usable =
          job?.state === 'succeeded' &&
          outcome?.phase === 'closed' &&
          outcome.exitCode === 0 &&
          outcome.checkout === 'matches' &&
          outcome.postRevision === record.revision &&
          outcome.command === 'matches' &&
          freshness === 'matches' &&
          command === 'matches';
        return {
          record,
          job,
          freshness,
          command,
          usable,
          decision: 'owner-review-required' as const,
        };
      }, signal);
    },
    evidence(scope: JobScope, review: ReviewRecord, freshness: 'matches' | 'stale' | 'withheld') {
      const trusted = owner(scope);
      assertReviewRequestHash(review);
      const identities = new Map<string, CheckExecutable | null>();
      const environment = checkEnvironmentHash(options.env);
      const latest = new Map<string, string>();
      const items = options.jobs.checks.list(trusted, review.id).map((record) => {
        assertCheckHash(record);
        if (record.revision !== review.snapshot.revision || record.root !== review.snapshot.root)
          throw new BosunError('unavailable', 'Verification review linkage unavailable');
        const job = linked(trusted, record);
        const outcome = record.outcome;
        let state: 'passed' | 'failed' | 'pending' | 'unknown' | 'stale' | 'not_started' =
          'pending';
        if (job?.state === 'unknown' || outcome?.phase === 'unknown') state = 'unknown';
        else if (job?.state === 'cancelled' || outcome?.phase === 'not_started')
          state = 'not_started';
        else if (job && ['queued', 'held', 'running'].includes(job.state)) state = 'pending';
        else if (outcome?.phase === 'closed') {
          if (outcome.exitCode !== 0) state = 'failed';
          else {
            let actual = identities.get(record.executable.path);
            if (actual === undefined) {
              try {
                actual = captureCheckExecutable(record.executable.path, options.env);
              } catch {
                actual = null;
              }
              identities.set(record.executable.path, actual);
            }
            const command =
              actual !== null && JSON.stringify(actual) === JSON.stringify(record.executable);
            state =
              job?.state === 'succeeded' &&
              freshness === 'matches' &&
              outcome.checkout === 'matches' &&
              outcome.postRevision === record.revision &&
              outcome.command === 'matches' &&
              command &&
              environment === record.environmentHash
                ? 'passed'
                : 'stale';
          }
        }
        const invocation = crypto
          .createHash('sha256')
          .update(JSON.stringify([record.executable.path, record.args]))
          .digest('hex');
        latest.set(invocation, record.id);
        return {
          id: record.id,
          jobId: record.jobId,
          state,
          commandHash: record.commandHash,
          invocation,
          exitCode: outcome?.phase === 'closed' ? outcome.exitCode : null,
        };
      });
      const selected = items.filter((item) => latest.get(item.invocation) === item.id);
      const state =
        items.length === 0
          ? 'unverified'
          : items.some((item) => item.state === 'unknown')
            ? 'unknown'
            : selected.some((item) => item.state === 'failed')
              ? 'failed'
              : selected.some((item) => item.state === 'pending')
                ? 'pending'
                : selected.every((item) => item.state === 'passed')
                  ? 'passed'
                  : 'stale';
      return {
        state,
        coverage: 'recorded-commands' as const,
        items: items.map((item) => ({ ...item, current: latest.get(item.invocation) === item.id })),
      };
    },
    admit(job: Readonly<JobSnapshot>, signal: AbortSignal, metadata: AdmissionMetadata) {
      return operation(async (control) => {
        if (
          !metadata.checkId ||
          job.runnerId !== CHECK_RUNNER ||
          !job.ownerOnly ||
          metadata.model !== 'verification'
        )
          return false;
        const scope = owner({ projectId: job.projectId, audience: 'owner' });
        const record = options.jobs.checks.get(scope, metadata.checkId);
        if (record.jobId !== job.id || record.root !== metadata.cwd) return false;
        const state = await current(record, scope, metadata.cwd, control);
        return state.checkout && state.command;
      }, signal);
    },
    runner(): AgentRunner {
      return {
        id: CHECK_RUNNER,
        caps: {
          vendor: 'bosun',
          readOnly: 'unsupported',
          sandbox: 'none',
          mcpInject: 'unsupported',
          effort: 'unsupported',
          localBackend: 'unsupported',
          billing: 'local',
        },
        detect: async () => ({ installed: true }),
        async *run(spec) {
          requirePublicInput(spec);
          if (spec.signal.aborted) throw new BosunError('cancelled', 'Verification cancelled');
          const payload = JSON.parse(spec.prompt);
          const scope = owner({ projectId: project(spec.cwd).id, audience: 'owner' });
          const record = options.jobs.checks.get(scope, jobId(data(payload, 'checkId')));
          const before = await current(
            record,
            scope,
            spec.cwd,
            AbortSignal.any([spec.signal, AbortSignal.timeout(10000)]),
          );
          if (!before.checkout || !before.command)
            throw new BosunError('conflict', 'Verification source changed before native dispatch');
          const folder = home(record);
          const env = { ...checkEnvironment(options.env), HOME: folder, TMPDIR: folder };
          const digest = crypto.createHash('sha256');
          let stdoutBytes = 0;
          let exitCode: number | null = null;
          for await (const event of streamProcess({
            command: record.executable.path,
            args: record.args,
            cwd: record.root,
            env,
            signal: spec.signal,
            timeoutMs: record.timeoutMs,
            killGraceMs: 100,
            maxOutputBytes: CHECK_LIMITS.outputBytes,
            stdout: (bytes) => {
              stdoutBytes += bytes.length;
              digest.update(bytes);
            },
          }))
            if (event.t === 'exit') exitCode = event.code;
          if (exitCode === null)
            throw new BosunError('unavailable', 'Verification exit receipt unavailable');
          let postRevision: string | null = null;
          let checkout: CheckOutcome['checkout'] = 'withheld',
            command: CheckOutcome['command'] = 'withheld';
          try {
            const after = await current(record, scope, spec.cwd, AbortSignal.timeout(10000));
            postRevision = after.revision;
            checkout = after.checkout ? 'matches' : 'stale';
            command = after.command ? 'matches' : 'changed';
          } catch {}
          const outcome: CheckOutcome = {
            phase: 'closed',
            exitCode,
            stdoutHash: digest.digest('hex'),
            stdoutBytes,
            postRevision,
            checkout,
            command,
          };
          yield {
            t: 'done',
            code: exitCode,
            result: JSON.stringify({
              checkId: record.id,
              commandHash: record.commandHash,
              revision: record.revision,
              outcome,
            }),
          };
        },
      };
    },
    async close() {
      closed = true;
      shutdown.abort();
      await Promise.allSettled([...pending]);
    },
  };
}
