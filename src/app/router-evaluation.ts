import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BosunError } from '../core/errors.ts';
import { requirePublicInput } from '../core/policy.ts';
import { jobId } from '../core/domain/job.ts';
import type { Ctx } from '../core/domain/memory.ts';
import type { RuntimeConfig } from '../core/domain/config.ts';
import type { AgentRunner } from '../core/ports/runner.ts';
import {
  ROUTER_EVAL_RUNNER,
  ROUTER_EVAL_LIMITS,
  type RouterEvalCase,
  type RouterEvalDataset,
  type RouterEvalSample,
} from '../core/domain/router-evaluation.ts';
import {
  freezeRouterThreshold,
  routerEvaluationReport,
} from '../core/use-cases/evaluate-router.ts';
import {
  routerEvaluationDataset,
  routerEvaluationRequest,
  routerCaptureRequest,
  routerFrozenSchema,
} from '../contracts/router-evaluation.ts';
import { readEvaluationFile } from '../platform/evaluation-file.ts';
import { privateDirectory, writePrivateFile, readPrivateFile } from '../platform/private-file.ts';
import { project } from '../platform/project.ts';
import { createRouteService } from './route.ts';
import type { openDaemonJobs } from './jobs.ts';

export function createRouterEvaluation(options: {
  config: RuntimeConfig;
  jobs: ReturnType<typeof openDaemonJobs>;
  artifacts: string;
  schedule(): void;
}) {
  function owner(ctx: Ctx, workspace: string) {
    options.jobs.assertOwner();
    if (ctx.audience !== 'owner' || !ctx.projectId)
      throw new BosunError('unsupported', 'Owner evaluation required');
    if (project(workspace).id !== ctx.projectId)
      throw new BosunError('conflict', 'Evaluation workspace changed');
    return { projectId: ctx.projectId, audience: 'owner' as const };
  }
  function outcome(task: RouterEvalCase) {
    if (task.outcome.kind !== 'check') return false;
    try {
      const record = options.jobs.checks.get(
        { projectId: task.outcome.projectId, audience: 'owner' },
        task.outcome.reference,
      );
      const receipt = record.outcome;
      return (
        record.revision === task.outcome.revision &&
        receipt?.phase === 'closed' &&
        receipt.checkout === 'matches' &&
        receipt.command === 'matches' &&
        receipt.postRevision === record.revision &&
        ((task.outcome.result === 'passed' && receipt.exitCode === 0) ||
          (task.outcome.result === 'failed' && receipt.exitCode !== 0))
      );
    } catch {
      return false;
    }
  }
  function load(input: unknown, ctx: Ctx, workspace: string) {
    const scope = owner(ctx, workspace);
    requirePublicInput(input as { privacy?: unknown });
    const parsed = routerEvaluationRequest.safeParse(input);
    if (!parsed.success) throw new BosunError('invalid', 'Invalid evaluation request');
    const source = readEvaluationFile(workspace, parsed.data.file, parsed.data.sha256),
      dataset = routerEvaluationDataset(source.input);
    return { source, dataset, scope, request: parsed.data };
  }
  function samples(dataset: RouterEvalDataset): RouterEvalSample[] {
    return dataset.cases.map((task) => {
      if (!task.observed)
        throw new BosunError('invalid', 'Captured observations required for offline evaluation');
      return { task, observed: task.observed, outcomeVerified: outcome(task) };
    });
  }
  const frozenFile = (id: string) =>
    path.join(options.artifacts, `router-evaluation-${jobId(id)}.json`);
  return {
    evaluate(input: unknown, ctx: Ctx, workspace: string) {
      const { source, dataset } = load(input, ctx, workspace),
        captured = samples(dataset);
      const frozen = freezeRouterThreshold(
        captured.filter((sample) => sample.task.split === 'development'),
      );
      const report = routerEvaluationReport(dataset, captured, frozen, 'imported', source.sha256);
      if (!source.valid()) throw new BosunError('conflict', 'Evaluation source changed');
      return report;
    },
    submit(input: unknown, ctx: Ctx, workspace: string) {
      const scope = owner(ctx, workspace);
      requirePublicInput(input as { privacy?: unknown });
      const parsed = routerCaptureRequest.safeParse(input);
      if (!parsed.success) throw new BosunError('invalid', 'Invalid capture request');
      const requestId = `router_eval_${crypto.createHash('sha256').update(parsed.data.requestId).digest('hex')}`;
      const existing = options.jobs.findRequest(scope, requestId);
      if (existing) return { job: existing, duplicate: true };
      const { source, dataset } = load(
        { privacy: 'public', file: parsed.data.file, sha256: parsed.data.sha256 },
        ctx,
        workspace,
      );
      if (dataset.model !== options.config.router.model)
        throw new BosunError('conflict', 'Evaluation model differs from configured router');
      privateDirectory(options.artifacts);
      if (
        fs
          .readdirSync(options.artifacts)
          .filter((name) => /^router-evaluation-.*\.json$/.test(name)).length >=
        ROUTER_EVAL_LIMITS.artifacts
      )
        throw new BosunError('unavailable', 'Evaluation artifact capacity held');
      if (!source.valid()) throw new BosunError('conflict', 'Evaluation source changed');
      const result = options.jobs.submit(
        {
          privacy: 'public',
          ownerOnly: true,
          requestId,
          taskId: crypto.randomUUID(),
          runnerId: ROUTER_EVAL_RUNNER,
          prompt: JSON.stringify({
            request: { privacy: 'public', file: parsed.data.file, sha256: parsed.data.sha256 },
            projectId: ctx.projectId,
          }),
          cwd: workspace,
          access: 'read',
          model: dataset.model,
        },
        scope,
      );
      options.schedule();
      return result;
    },
    frozen(ctx: Ctx, workspace: string, id: string) {
      const scope = owner(ctx, workspace),
        job = options.jobs.get(scope, id);
      if (job.runnerId !== ROUTER_EVAL_RUNNER)
        throw new BosunError('not_found', 'Evaluation job not found');
      let input: unknown;
      try {
        input = JSON.parse(readPrivateFile(frozenFile(id), 32768));
      } catch {
        throw new BosunError('unavailable', 'Frozen selection unavailable');
      }
      const parsed = routerFrozenSchema.safeParse(input);
      if (!parsed.success || parsed.data.jobId !== id || parsed.data.projectId !== ctx.projectId)
        throw new BosunError('unavailable', 'Frozen selection binding unavailable');
      return parsed.data;
    },
    runner(): AgentRunner {
      return {
        id: ROUTER_EVAL_RUNNER,
        caps: {
          vendor: 'ollama',
          readOnly: 'verified',
          sandbox: 'none',
          mcpInject: 'unsupported',
          effort: 'unsupported',
          localBackend: 'verified',
          billing: 'local',
        },
        detect: async () => ({ installed: true }),
        async *run(spec) {
          requirePublicInput(spec);
          const payload = JSON.parse(spec.prompt) as { request: unknown; projectId: string };
          const ctx: Ctx = {
            projectId: payload.projectId,
            sessionId: null,
            linked: [],
            audience: 'owner',
          };
          const { source, dataset } = load(payload.request, ctx, spec.cwd);
          if (
            spec.model !== dataset.model ||
            spec.model !== options.config.router.model ||
            spec.access !== 'read' ||
            !spec.jobId
          )
            throw new BosunError('conflict', 'Evaluation selection changed');
          const signal = AbortSignal.any([
              spec.signal,
              AbortSignal.timeout(ROUTER_EVAL_LIMITS.deadlineMs),
            ]),
            routing = createRouteService({
              ...options.config,
              router: { ...options.config.router, digest: dataset.digest },
            });
          const captured: RouterEvalSample[] = [];
          const assertFresh = () => {
            owner(ctx, spec.cwd);
            if (!source.valid())
              throw new BosunError('conflict', 'Evaluation source changed', {
                details: { outcome: 'unknown' },
              });
            if (signal.aborted)
              throw new BosunError('cancelled', 'Evaluation cancelled', {
                details: { outcome: 'unknown' },
              });
          };
          const observe = async (task: RouterEvalCase) => {
            assertFresh();
            const started = performance.now();
            // Labels, categories, splits, group IDs and outcome evidence never enter the classifier prompt.
            const text = JSON.stringify({
              task: task.text,
              access: task.access,
              selectedModel: task.selectedModel,
              policy: task.policy,
            });
            const result = await routing.classify({ privacy: 'public', text }, signal);
            assertFresh();
            if (result.status.model !== dataset.model || result.status.digest !== dataset.digest)
              throw new BosunError('conflict', 'Evaluation model digest changed', {
                details: { outcome: 'unknown' },
              });
            return {
              task,
              observed: {
                decision: result.route?.decision ?? null,
                residency: result.residencyBefore,
                totalMs: Math.max(0, performance.now() - started),
              },
              outcomeVerified: outcome(task),
            };
          };
          for (const task of dataset.cases.filter((item) => item.split === 'development'))
            captured.push(await observe(task));
          const selection = freezeRouterThreshold(captured),
            file = frozenFile(spec.jobId);
          privateDirectory(options.artifacts);
          if (
            fs.existsSync(file) ||
            fs
              .readdirSync(options.artifacts)
              .filter((name) => /^router-evaluation-.*\.json$/.test(name)).length >=
              ROUTER_EVAL_LIMITS.artifacts
          )
            throw new BosunError('conflict', 'Frozen selection already exists or capacity held');
          const frozenText = `${JSON.stringify({
            schema: 1,
            jobId: spec.jobId,
            projectId: ctx.projectId,
            datasetSha256: source.sha256,
            model: dataset.model,
            digest: dataset.digest,
            selection,
          })}\n`;
          writePrivateFile(file, frozenText);
          if (readPrivateFile(file, 32768) !== frozenText)
            throw new BosunError('unavailable', 'Frozen selection confirmation unavailable', {
              details: { outcome: 'unknown' },
            });
          yield { t: 'text', text: 'Development selection frozen before held-out capture.' };
          for (const task of dataset.cases.filter((item) => item.split === 'heldout')) {
            assertFresh();
            if (readPrivateFile(file, 32768) !== frozenText)
              throw new BosunError('conflict', 'Frozen selection changed', {
                details: { outcome: 'unknown' },
              });
            captured.push(await observe(task));
          }
          assertFresh();
          if (readPrivateFile(file, 32768) !== frozenText)
            throw new BosunError('conflict', 'Frozen selection changed', {
              details: { outcome: 'unknown' },
            });
          const report = routerEvaluationReport(
            dataset,
            captured,
            selection,
            'native',
            source.sha256,
          );
          const output = JSON.stringify(report);
          if (Buffer.byteLength(output) > 65536)
            throw new BosunError('unavailable', 'Evaluation report exceeds limit', {
              details: { outcome: 'unknown' },
            });
          yield { t: 'done', code: 0, result: output };
        },
      };
    },
  };
}
