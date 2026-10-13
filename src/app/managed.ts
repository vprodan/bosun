import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { RuntimeConfig, HostId } from '../core/domain/config.ts';
import type { Env } from '../core/domain/inference.ts';
import type { AgentRunner } from '../core/ports/runner.ts';
import type { ManagedSessionControl, ManagedSessionDriver } from '../core/ports/host.ts';
import type { ManagedSession } from '../core/domain/session.ts';
import {
  managedSession,
  createHandoffController,
  handoffContextIsCurrent,
  type ManagedOwnership,
} from '../core/use-cases/handoff.ts';
import { MANAGED_START_RUNNER, MANAGED_HANDOFF_RUNNER } from '../core/domain/managed.ts';
import { bootstrapUsesInference, requireManagedControl } from '../core/managed-policy.ts';
import { nativeUsage } from '../core/domain/usage.ts';
import { BosunError } from '../core/errors.ts';
import { requirePublicInput } from '../core/policy.ts';
import { screenPublicText } from '../core/secret-screen.ts';
import {
  data,
  jobId,
  type AdmissionMetadata,
  type JobSnapshot,
  type JobScope,
} from '../core/domain/job.ts';
import {
  managedStartSchema,
  managedTurnSchema,
  managedAuthoritySchema,
  managedHandoffSchema,
} from '../contracts/managed.ts';
import { configRevision } from '../platform/config.ts';
import { project } from '../platform/project.ts';
import type { openDaemonJobs } from './jobs.ts';
import type { createHandoffArtifacts } from './handoff.ts';
import type { createSummaryService } from './summary.ts';
import { prepareManagedHandoff } from './managed-preparation.ts';

type Gates = {
  assertOwner(expected: { ownerId: string; generation: number }): void;
  assertDispatchOwner(expected: { ownerId: string; generation: number; sessionId: string }): void;
  freshClaim(source: ManagedSession): { ownerId: string; generation: number };
  hash(text: string): string;
  now(): number;
  id(): string;
};
export type ManagedFactories = Partial<
  Record<HostId, (gates: Gates) => ManagedSessionDriver | Promise<ManagedSessionDriver>>
>;
const hash = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
const failure = () => new BosunError('unavailable', 'Managed native source unavailable');

export function createManagedService(options: {
  jobs: ReturnType<typeof openDaemonJobs>;
  config: RuntimeConfig;
  env: Env;
  schedule(): void;
  factories?: ManagedFactories;
  handoffs: () => ReturnType<typeof createHandoffArtifacts>;
  summaries: () => ReturnType<typeof createSummaryService>;
}) {
  const drivers = new Map<string, Promise<ManagedSessionDriver>>();
  const scopes = new Map<string, string>();
  let closed = false;
  function owner(scope: JobScope): string {
    options.jobs.assertOwner();
    if (
      closed ||
      scope.audience !== 'owner' ||
      !scope.projectId ||
      !/^p_[a-f0-9]{16}$/.test(scope.projectId)
    )
      throw new BosunError('unsupported', 'Owner managed operation required');
    return scope.projectId;
  }
  function root(workspace: string): string {
    if (
      !path.isAbsolute(workspace) ||
      path.resolve(workspace) !== workspace ||
      fs.realpathSync(workspace) !== workspace ||
      !fs.statSync(workspace).isDirectory()
    )
      throw failure();
    for (let current = workspace; ; current = path.dirname(current)) {
      try {
        const stat = fs.lstatSync(path.join(current, '.git'));
        if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw failure();
        return current;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (path.dirname(current) === current) return workspace;
    }
  }
  function from(scope: JobScope, workspace: string) {
    const projectId = owner(scope),
      cwd = root(workspace);
    if (project(cwd).id !== projectId) throw new BosunError('conflict', 'Managed project changed');
    return { projectId, cwd };
  }
  function record(scope: JobScope, workspace: string, id: string): ManagedOwnership {
    const bound = from(scope, workspace);
    const value = options.jobs.managed.ownership(bound.projectId, id);
    if (value.cwd !== bound.cwd)
      throw new BosunError('conflict', 'Managed source belongs to another checkout');
    return value;
  }
  function assertDirectory(value: ManagedOwnership) {
    const stat = fs.statSync(value.cwd);
    if (
      !value.bootstrap ||
      !stat.isDirectory() ||
      stat.dev !== value.bootstrap.cwdDev ||
      stat.ino !== value.bootstrap.cwdIno ||
      fs.realpathSync(value.cwd) !== value.cwd ||
      value.bootstrap.configHash !== configRevision(options.config)
    )
      throw failure();
  }
  function current(projectId: string, id: string) {
    options.jobs.assertOwner();
    const value = options.jobs.managed.ownership(projectId, id);
    assertDirectory(value);
    return value;
  }
  function gates(projectId: string, id: string): Gates {
    return {
      hash,
      now: Date.now,
      id: () => crypto.randomUUID().replaceAll('-', ''),
      assertOwner(expected) {
        const value = current(projectId, id);
        if (
          ['held', 'retired'].includes(value.phase) ||
          value.session.ownerId !== expected.ownerId ||
          (expected.generation !== value.session.generation &&
            !(value.phase === 'staged' && expected.generation === value.stage!.generation))
        )
          throw failure();
      },
      assertDispatchOwner(expected) {
        const value = current(projectId, id);
        if (
          value.phase !== 'active' ||
          ['ownerId', 'generation', 'sessionId'].some(
            (key) =>
              value.session[key as keyof ManagedSession] !== expected[key as keyof typeof expected],
          ) ||
          options.jobs.get(
            { projectId, audience: 'owner' },
            value.activationJobId ?? value.bootstrap!.jobId,
          ).state !== 'succeeded'
        )
          throw failure();
      },
      freshClaim(source) {
        const value = current(projectId, id);
        if (
          value.phase !== 'staged' ||
          !value.stage ||
          value.stage.destination ||
          JSON.stringify(value.session) !== JSON.stringify(source)
        )
          throw failure();
        return { ownerId: value.session.ownerId, generation: value.stage.generation };
      },
    };
  }
  async function driver(value: ManagedOwnership) {
    if (!drivers.has(value.id)) {
      if (drivers.size >= 64) throw failure();
      const factory = options.factories?.[value.session.hostId as HostId];
      scopes.set(value.id, value.projectId);
      drivers.set(
        value.id,
        (async () => {
          const selected = gates(value.projectId, value.id);
          if (factory) return factory(selected);
          // Rehydrate only this owned host; static imports would evaluate unselected native integrations.
          if (value.session.hostId === 'omp') {
            const { createOmpControl } = await import('../adapters/hosts/omp/control.ts');
            const host = options.config.hosts.omp;
            return createOmpControl({ command: host.command,
              env: { ...options.env, ...(host.home ? { PI_CODING_AGENT_DIR: host.home } : {}) },
              timeoutMs: options.config.local.timeoutMs }, selected);
          }
          if (value.session.hostId === 'codex') {
            const { createCodexControl } = await import('../adapters/hosts/codex/control.ts');
            const host = options.config.hosts.codex;
            return createCodexControl({ command: host.command,
              env: { ...options.env, ...(host.home ? { CODEX_HOME: host.home } : {}) } }, selected);
          }
          if (value.session.hostId !== 'opencode')
            throw new BosunError('unverified', 'Native managed driver is not qualified');
          const { createOpenCodeControl } = await import('../adapters/hosts/opencode/control.ts');
          const host = options.config.hosts.opencode;
          return createOpenCodeControl(
            {
              url: host.url,
              username: host.username,
              passwordEnv: host.passwordEnv,
              env: options.env,
            },
            selected,
          );
        })(),
      );
    }
    return drivers.get(value.id)!;
  }
  function hold(projectId: string, id: string) {
    try {
      const value = options.jobs.managed.ownership(projectId, id);
      if (value.phase !== 'held' && value.phase !== 'retired')
        options.jobs.managed.holdOwnership(value);
    } catch {}
  }
  async function admitBootstrap(control: ManagedSessionControl, session: ManagedSession,
    cwd: string, allowUnknownQuota: boolean, signal: AbortSignal) {
    if (!bootstrapUsesInference(control)) return;
    if (signal.aborted) throw failure();
    const admission = await options.jobs.quota.admit(
      { runnerId: session.hostId, model: session.model }, signal, { cwd, allowUnknownQuota });
    if (!admission.allowed || signal.aborted) throw failure();
  }
  function bootstrapUsage(event: Awaited<ReturnType<ManagedSessionControl['seed']>>) {
    if (event === undefined) return undefined;
    if (event.t !== 'usage') throw failure();
    const counts = nativeUsage(event);
    return { t: 'usage' as const,
      ...(counts.tokensIn === null ? {} : { tokensIn: counts.tokensIn }),
      ...(counts.tokensOut === null ? {} : { tokensOut: counts.tokensOut }) };
  }
  const startRequest = (scope: JobScope, requestId: string) =>
    'ms_start_' + hash(JSON.stringify([scope.projectId, requestId]));
  const turnRequest = (scope: JobScope, requestId: string) =>
    'ms_turn_' + hash(JSON.stringify([scope.projectId, requestId]));
  const handoffRequest = (scope: JobScope, requestId: string) =>
    'ms_hof_' + hash(JSON.stringify([scope.projectId, requestId]));
  const observing = new Map<string, Promise<void>>();
  const service = {
    start(input: unknown, scope: JobScope, workspace: string) {
      owner(scope);
      requirePublicInput(input as { privacy?: unknown });
      const requestId = jobId(data(input, 'requestId'));
      screenPublicText(requestId);
      const bound = from(scope, workspace);
      const existing = options.jobs.findRequest(scope, startRequest(scope, requestId));
      if (existing) {
        const binding = options.jobs.managed.job(scope, existing.id);
        if (!binding || binding.cwd !== bound.cwd)
          throw new BosunError('conflict', 'Managed request belongs to another checkout');
        return { id: binding.id, job: existing, duplicate: true };
      }
      const parsed = managedStartSchema.safeParse(input);
      if (!parsed.success) throw new BosunError('invalid', 'Invalid managed start');
      const accepted = parsed.data;
      screenPublicText(JSON.stringify(accepted));
      if (Buffer.byteLength(accepted.seed) > 16384)
        throw new BosunError('invalid', 'Managed seed exceeds its native budget');
      if (
        !options.config.hosts[accepted.hostId].enabled ||
        (accepted.hostId === 'codex' && accepted.access === 'read' && !options.factories?.codex) ||
        (!['opencode', 'codex'].includes(accepted.hostId) && !options.factories?.[accepted.hostId])
      )
        throw new BosunError('unverified', 'Native managed startup unavailable');
      const id = 'ms_' + crypto.randomUUID().replaceAll('-', '');
      if (
        options.jobs.managed
          .ownerships(bound.projectId)
          .some((value) => value.cwd === bound.cwd && value.phase !== 'retired')
      )
        throw new BosunError('conflict', 'Managed checkout already has a retained source');
      const payload = {
        ...accepted,
        id,
        cwd: bound.cwd,
        projectId: bound.projectId,
        configHash: configRevision(options.config),
      };
      const result = options.jobs.submit(
        {
          privacy: 'public',
          requestId: startRequest(scope, requestId),
          taskId: id,
          runnerId: MANAGED_START_RUNNER,
          prompt: JSON.stringify(payload),
          cwd: bound.cwd,
          access: 'read',
          model: accepted.model,
          ownerOnly: true,
          managedId: id,
          managedVersion: 0,
        },
        scope,
      );
      options.schedule();
      return { id, ...result };
    },
    turn(input: unknown, scope: JobScope, workspace: string) {
      owner(scope);
      requirePublicInput(input as { privacy?: unknown });
      const requestId = jobId(data(input, 'requestId'));
      screenPublicText(requestId);
      const bound = from(scope, workspace);
      const existing = options.jobs.findRequest(scope, turnRequest(scope, requestId));
      if (existing) {
        const binding = options.jobs.managed.job(scope, existing.id);
        if (!binding || binding.cwd !== bound.cwd)
          throw new BosunError('conflict', 'Managed request belongs to another checkout');
        return { job: existing, duplicate: true };
      }
      const parsed = managedTurnSchema.safeParse(input);
      if (!parsed.success) throw new BosunError('invalid', 'Invalid managed turn');
      const accepted = parsed.data;
      screenPublicText(accepted.text);
      const value = record(scope, workspace, accepted.id);
      assertDirectory(value);
      if (value.phase !== 'active' || value.version !== accepted.expectedVersion)
        throw new BosunError('conflict', 'Managed source version changed');
      const result = options.jobs.submit(
        {
          privacy: 'public',
          requestId: turnRequest(scope, requestId),
          taskId: crypto.randomUUID(),
          runnerId: value.session.hostId,
          prompt: accepted.text,
          cwd: value.cwd,
          access: value.session.access,
          model: value.session.model,
          ...(value.bootstrap?.effort ? { effort: value.bootstrap.effort } : {}),
          ownerOnly: true,
          managedId: value.id,
          managedVersion: value.version,
          ...(accepted.allowUnknownQuota ? { allowUnknownQuota: true } : {}),
          ...(accepted.policy ? { policy: accepted.policy } : {}),
        },
        scope,
      );
      options.schedule();
      return result;
    },
    authorize(input: unknown, scope: JobScope, workspace: string) {
      owner(scope);
      requirePublicInput(input as { privacy?: unknown });
      const parsed = managedAuthoritySchema.safeParse(input);
      if (!parsed.success) throw new BosunError('invalid', 'Invalid managed authority');
      const accepted = parsed.data;
      screenPublicText(JSON.stringify(accepted));
      let value = record(scope, workspace, accepted.id);
      assertDirectory(value);
      const facts = {
        ...accepted.facts,
        parentId: null,
        source: {
          ...accepted.facts.source,
          hostId: value.session.hostId as HostId,
          sessionId: value.session.sessionId,
          model: value.session.model,
          generation: value.session.generation,
          access: value.session.access,
          ...(value.bootstrap?.effort ? { effort: value.bootstrap.effort } : {}),
          completedEventCursor: 'authority_' + hash(accepted.requestId).slice(0, 32),
        },
      };
      const requestId = 'authority_' + hash(JSON.stringify([value.id, accepted.requestId]));
      if (value.authorityArtifactId) {
        const currentArtifact = options.handoffs().get(scope, value.authorityArtifactId);
        if (
          currentArtifact.manifest.facts.source.completedEventCursor ===
          facts.source.completedEventCursor
        )
          return { ownership: value, artifact: currentArtifact.manifest.id, duplicate: true };
      }
      if (
        value.phase !== 'active' ||
        value.version !== accepted.expectedVersion ||
        facts.repository.projectId !== value.projectId ||
        facts.source.uncertainEffects.length ||
        facts.runningJobs.length
      )
        throw new BosunError('conflict', 'Managed authority binding changed');
      const artifact = options.handoffs().create({ privacy: 'public', requestId, facts }, scope);
      value = options.jobs.managed.authorityOwnership(value, artifact.artifact.id);
      return { ownership: value, artifact: artifact.artifact.id, duplicate: artifact.duplicate };
    },
    handoff(input: unknown, scope: JobScope, workspace: string) {
      owner(scope);
      requirePublicInput(input as { privacy?: unknown });
      const requestId = jobId(data(input, 'requestId'));
      screenPublicText(requestId);
      const bound = from(scope, workspace);
      const existing = options.jobs.findRequest(scope, handoffRequest(scope, requestId));
      if (existing) {
        const link = options.jobs.managed.job(scope, existing.id);
        if (!link || link.cwd !== bound.cwd)
          throw new BosunError('conflict', 'Managed handoff belongs to another checkout');
        return { job: existing, duplicate: true };
      }
      const parsed = managedHandoffSchema.safeParse(input);
      if (!parsed.success) throw new BosunError('invalid', 'Invalid managed handoff');
      const accepted = parsed.data,
        value = record(scope, workspace, accepted.id);
      assertDirectory(value);
      if (
        value.phase !== 'active' ||
        value.version !== accepted.expectedVersion ||
        !value.authorityArtifactId
      )
        throw new BosunError('conflict', 'Current managed authority required');
      if (options.jobs.managed.unsettled(scope, value.id).length)
        throw new BosunError('conflict', 'Managed jobs require settlement before handoff');
      const model = options.config.providers[options.config.handoff.provider]?.model;
      if (!model) throw failure();
      const result = options.jobs.submit(
        {
          privacy: 'public',
          ownerOnly: true,
          requestId: handoffRequest(scope, requestId),
          taskId: crypto.randomUUID(),
          runnerId: MANAGED_HANDOFF_RUNNER,
          prompt: JSON.stringify(accepted),
          cwd: value.cwd,
          access: 'read',
          model,
          managedId: value.id,
          managedVersion: value.version,
        },
        scope,
      );
      options.schedule();
      return result;
    },
    observe(job: Readonly<JobSnapshot>) {
      if (
        closed ||
        job.state !== 'succeeded' ||
        job.runnerId === MANAGED_START_RUNNER ||
        job.runnerId === MANAGED_HANDOFF_RUNNER ||
        !job.projectId ||
        !options.config.handoff.enabled
      )
        return;
      const scope: JobScope = { projectId: job.projectId, audience: 'owner' };
      let link: ReturnType<typeof options.jobs.managed.job>;
      try {
        link = options.jobs.managed.job(scope, job.id);
      } catch {
        return;
      }
      if (!link || observing.has(link.id)) return;
      const id = link.id;
      const operation = Promise.resolve()
        .then(async () => {
          try {
            const value = current(job.projectId!, id);
            if (
              value.phase !== 'active' ||
              !value.authorityArtifactId ||
              options.jobs.managed.unsettled(scope, id).length
            )
              return;
            const control = await driver(value);
            requireManagedControl({ control });
            if (!control.capture) return;
            const sample = await control.observeContext(value.session, AbortSignal.timeout(10000));
            if (
              !handoffContextIsCurrent(sample, value.session, {
                now: Date.now(),
                threshold: options.config.handoff.threshold,
                latestTurnId: sample.turnId,
              }) ||
              sample.usedTokens! < sample.windowTokens! * options.config.handoff.threshold
            )
              return;
            service.handoff(
              {
                privacy: 'public',
                requestId:
                  'auto_' + hash(JSON.stringify([id, value.session.generation])).slice(0, 64),
                id,
                expectedVersion: value.version,
                automatic: true,
                latestTurnId: sample.turnId,
              },
              scope,
              value.cwd,
            );
          } catch {}
        })
        .finally(() => {
          observing.delete(id);
        });
      observing.set(id, operation);
    },
    get(scope: JobScope, workspace: string, id: string) {
      const value = record(scope, workspace, id);
      return {
        ownership: value,
        bootstrapJob: value.bootstrap ? options.jobs.get(scope, value.bootstrap.jobId) : null,
        nativeQualification: 'unverified' as const,
      };
    },
    async capture(
      input: { privacy: 'public'; id: string; afterCursor: string | null },
      scope: JobScope,
      workspace: string,
      signal: AbortSignal,
    ) {
      owner(scope);
      requirePublicInput(input);
      const value = record(scope, workspace, input.id);
      assertDirectory(value);
      if (value.phase !== 'active') throw failure();
      const control = await driver(value);
      if (!control.capture)
        throw new BosunError('unsupported', 'Native source capture unavailable');
      return control.capture(
        value.session,
        { privacy: 'public', afterCursor: input.afterCursor },
        signal,
      );
    },
    async retire(
      input: { id: string; expectedVersion: number },
      scope: JobScope,
      workspace: string,
      signal: AbortSignal,
    ) {
      let value = record(scope, workspace, input.id);
      if (value.phase === 'retired') return { ownership: value, duplicate: true };
      if (value.phase !== 'active' || value.version !== input.expectedVersion)
        throw new BosunError('conflict', 'Managed retirement requires current active source');
      if (options.jobs.managed.unsettled(scope, value.id).length)
        throw new BosunError('conflict', 'Managed jobs require settlement before retirement');
      assertDirectory(value);
      const control = await driver(value);
      value = options.jobs.managed.fenceOwnership(value);
      try {
        const fence = await control.fenceAdmission(value.session, signal);
        const quiet = await control.quiesce(value.session, fence, signal);
        if (
          quiet.sessionId !== value.session.sessionId ||
          quiet.generation !== value.session.generation ||
          quiet.idle !== true ||
          quiet.pendingTools !== 0
        )
          throw failure();
        await control.close?.();
        return { ownership: options.jobs.managed.retireOwnership(value), duplicate: false };
      } catch {
        hold(value.projectId, value.id);
        throw new BosunError('unavailable', 'Managed retirement remains held', {
          details: { outcome: 'unknown' },
        });
      }
    },
    async admit(job: Readonly<JobSnapshot>, _signal: AbortSignal, metadata: AdmissionMetadata) {
      if (job.runnerId === MANAGED_HANDOFF_RUNNER) {
        if (!job.ownerOnly || !job.projectId || !metadata.managedId) return false;
        const value = current(job.projectId, metadata.managedId);
        if (
          value.phase !== 'active' ||
          value.version !== metadata.managedVersion ||
          metadata.model !== options.config.providers[options.config.handoff.provider]?.model ||
          metadata.cwd !== value.cwd ||
          options.jobs.managed
            .unsettled({ projectId: job.projectId, audience: 'owner' }, value.id)
            .some((id) => id !== job.id)
        )
          return false;
        try {
          const control = await driver(value);
          requireManagedControl({ control });
          return !!control.capture;
        } catch {
          return false;
        }
      }
      if (
        job.ownerOnly &&
        [
          MANAGED_START_RUNNER,
          'bosun-admin',
          'bosun-summary',
          'bosun-consolidation',
          'bosun-checks',
        ].includes(job.runnerId)
      ) {
        if (job.runnerId !== MANAGED_START_RUNNER) return true;
        return !options.jobs.managed
          .ownerships(job.projectId!)
          .some((value) => value.cwd === root(metadata.cwd) && value.phase !== 'retired');
      }
      const sources = job.projectId ? options.jobs.managed.ownerships(job.projectId) : [];
      const matching = sources.find(
        (value) => value.cwd === root(metadata.cwd) && value.phase !== 'retired',
      );
      if (!metadata.managedId) return !matching;
      if (
        !job.ownerOnly ||
        !matching ||
        matching.id !== metadata.managedId ||
        matching.phase !== 'active' ||
        matching.version !== metadata.managedVersion ||
        matching.session.hostId !== job.runnerId ||
        matching.session.model !== metadata.model ||
        matching.session.access !== metadata.access ||
        (matching.bootstrap?.effort ?? null) !== (metadata.effort ?? null)
      )
        return false;
      assertDirectory(matching);
      gates(matching.projectId, matching.id).assertDispatchOwner(matching.session);
      return true;
    },
    bootstrapRunner(): AgentRunner {
      return {
        id: MANAGED_START_RUNNER,
        caps: {
          vendor: 'native-control',
          readOnly: 'verified',
          sandbox: 'none',
          mcpInject: 'unsupported',
          effort: 'unsupported',
          localBackend: 'unverified',
          billing: 'unknown',
        },
        detect: async () => ({ installed: true }),
        async *run(spec) {
          requirePublicInput(spec);
          if (spec.signal.aborted) throw failure();
          let value: ManagedOwnership | undefined;
          try {
            const payload = JSON.parse(spec.prompt);
            const parsed = managedStartSchema.parse({
              privacy: payload.privacy,
              requestId: payload.requestId,
              hostId: payload.hostId,
              model: payload.model,
              ...(payload.effort ? { effort: payload.effort } : {}),
              access: payload.access,
              seed: payload.seed,
              ...(payload.allowUnknownQuota === undefined ? {} : { allowUnknownQuota: payload.allowUnknownQuota }),
            });
            if (
              !spec.jobId ||
              !spec.projectId ||
              !spec.managed ||
              spec.managed.version !== 0 ||
              spec.managed.id !== payload.id ||
              spec.cwd !== payload.cwd ||
              spec.projectId !== payload.projectId ||
              spec.model !== parsed.model ||
              payload.configHash !== configRevision(options.config) ||
              options.jobs.get({ projectId: spec.projectId, audience: 'owner' }, spec.jobId)
                .state !== 'running'
            )
              throw failure();
            screenPublicText(spec.prompt);
            const stat = fs.statSync(spec.cwd);
            value = options.jobs.managed.reserveOwnership({
              id: payload.id,
              projectId: spec.projectId,
              cwd: spec.cwd,
              session: {
                hostId: parsed.hostId,
                sessionId: 'pending_' + payload.id,
                ownerId: 'owner_' + payload.id,
                generation: 0,
                model: parsed.model,
                access: parsed.access,
              },
              bootstrap: {
                jobId: spec.jobId,
                configHash: payload.configHash,
                seedHash: hash(parsed.seed),
                cwdDev: stat.dev,
                cwdIno: stat.ino,
                effort: parsed.effort ?? null,
              },
            });
            const control = await driver(value);
            await admitBootstrap(control, value.session, spec.cwd, parsed.allowUnknownQuota === true, spec.signal);
            const session = managedSession(
              await control.create(
                {
                  privacy: 'public',
                  ownerId: value.session.ownerId,
                  generation: 0,
                  requestId: parsed.requestId,
                  cwd: spec.cwd,
                  model: parsed.model,
                  access: parsed.access,
                  ...(parsed.effort ? { effort: parsed.effort } : {}),
                },
                spec.signal,
              ),
            );
            value = options.jobs.managed.bindOwnership(value, session);
            const seededUsage = bootstrapUsage(await control.seed(
              session,
              { privacy: 'public', text: parsed.seed, hash: value.bootstrap!.seedHash },
              spec.signal,
            ));
            if (seededUsage) yield seededUsage;
            const ready = await control.ready(
              session,
              { seedHash: value.bootstrap!.seedHash, model: session.model, access: session.access },
              spec.signal,
            );
            if (
              ready.sessionId !== session.sessionId ||
              ready.generation !== 0 ||
              ready.root !== true ||
              ready.idle !== true ||
              ready.seedHash !== value.bootstrap!.seedHash ||
              ready.model !== session.model ||
              ready.access !== session.access
            )
              throw failure();
            if (spec.signal.aborted) throw failure();
            value = options.jobs.managed.activateOwnership(value, ready.seedHash);
            yield {
              t: 'done',
              code: 0,
              result: JSON.stringify({
                managedId: value.id,
                version: value.version,
                sessionId: value.session.sessionId,
              }),
            };
          } catch {
            if (value) hold(value.projectId, value.id);
            throw new BosunError('unavailable', 'Managed bootstrap receipt unavailable', {
              details: { outcome: 'unknown' },
            });
          }
        },
      };
    },
    handoffRunner(): AgentRunner {
      return {
        id: MANAGED_HANDOFF_RUNNER,
        caps: {
          vendor: 'configured-summary-provider',
          readOnly: 'verified',
          sandbox: 'none',
          mcpInject: 'unsupported',
          effort: 'unsupported',
          localBackend: 'unverified',
          billing: 'unknown',
        },
        detect: async () => ({ installed: true }),
        async *run(spec) {
          requirePublicInput(spec);
          if (!spec.jobId || !spec.projectId || !spec.managed) throw failure();
          const value = current(spec.projectId, spec.managed.id);
          const accepted = managedHandoffSchema.parse(JSON.parse(spec.prompt));
          if (
            value.phase !== 'active' ||
            value.version !== spec.managed.version ||
            accepted.id !== value.id ||
            accepted.expectedVersion !== value.version ||
            spec.model !== options.config.providers[options.config.handoff.provider]?.model
          )
            throw failure();
          const control = await driver(value);
          const usage: Extract<import('../core/ports/runner.ts').RunEvent, { t: 'usage' }>[] = [];
          const bootstrap: Extract<import('../core/ports/runner.ts').RunEvent, { t: 'usage' }>[] = [];
          let usageEmitted = false;
          const total = (key: 'tokensIn' | 'tokensOut') => {
            let sum = 0;
            for (const event of usage) {
              if (!Number.isSafeInteger(event[key]) || event[key]! < 0) return undefined;
              sum += event[key]!;
              if (!Number.isSafeInteger(sum)) return undefined;
            }
            return sum;
          };
          const aggregate = () => ({
            t: 'usage' as const,
            ...(total('tokensIn') === undefined ? {} : { tokensIn: total('tokensIn') }),
            ...(total('tokensOut') === undefined ? {} : { tokensOut: total('tokensOut') }),
          });
          const controller = createHandoffController({
            storage: options.jobs.managed,
            now: Date.now,
            id: () => spec.jobId!,
            hash,
            control: () => control,
            async bootstrap(native, session, seed, signal) {
              await admitBootstrap(native, session, value.cwd, accepted.allowUnknownQuota === true, signal);
              const event = bootstrapUsage(await native.seed(session, seed, signal));
              // Missing native totals remain explicitly unknown for a model
              // bootstrap. They must not become the summary model's counts.
              if (event || bootstrapUsesInference(native)) bootstrap.push(event ?? { t: 'usage' });
            },
            prepare: (source) =>
              prepareManagedHandoff({
                source,
                control,
                jobId: spec.jobId!,
                config: options.config,
                env: options.env,
                handoffs: options.handoffs(),
                summaries: options.summaries(),
                signal: spec.signal,
                usage: (event) => usage.push(event),
              }),
          });
          try {
            const result = await controller.handoff(
              value.projectId,
              value.id,
              {
                automatic: accepted.automatic,
                threshold: options.config.handoff.threshold,
                ...(accepted.latestTurnId ? { latestTurnId: accepted.latestTurnId } : {}),
              },
              spec.signal,
            );
            if (usage.length) yield aggregate();
            for (const event of bootstrap) yield event;
            usageEmitted = true;
            yield { t: 'done', code: 0, result: JSON.stringify({ ...result,
              ...(bootstrap.length ? { usage: {
                summary: { model: spec.model, ...(usage.length ? aggregate() : {}) },
                bootstrap: { hostId: value.session.hostId, model: value.session.model, ...bootstrap[0] },
              } } : {}) }) };
          } catch (error) {
            if (!usageEmitted) {
              if (usage.length) yield aggregate();
              for (const event of bootstrap) yield event;
            }
            // A rejected pre-fence sample leaves the original source usable.
            // A lost transfer receipt must hold the selected destination too.
            try {
              const latest = current(value.projectId, value.id);
              if (
                latest.phase === 'active' &&
                latest.version === value.version &&
                latest.activationJobId !== spec.jobId &&
                error instanceof BosunError &&
                error.details?.outcome !== 'unknown'
              ) {
                yield {
                  t: 'done',
                  code: 1,
                  result: JSON.stringify({ state: 'precondition-failed' }),
                };
                return;
              }
              if (latest.phase !== 'active' || latest.activationJobId === spec.jobId)
                hold(value.projectId, value.id);
            } catch {
              /* storage uncertainty already prevents dispatch */
            }
            throw error;
          } finally {
            controller.close();
          }
        },
      };
    },
    wrap(hostId: string, ordinary: AgentRunner): AgentRunner {
      return {
        ...ordinary,
        async *run(spec) {
          if (!spec.managed) {
            yield* ordinary.run(spec);
            return;
          }
          requirePublicInput(spec);
          let value: ManagedOwnership | undefined;
          try {
            if (!spec.projectId || !spec.jobId || spec.managed.version < 1) throw failure();
            value = current(spec.projectId, spec.managed.id);
            if (
              value.phase !== 'active' ||
              value.version !== spec.managed.version ||
              value.session.hostId !== hostId ||
              spec.cwd !== value.cwd ||
              spec.model !== value.session.model ||
              spec.access !== value.session.access ||
              (spec.effort ?? null) !== (value.bootstrap?.effort ?? null)
            )
              throw failure();
            gates(value.projectId, value.id).assertDispatchOwner(value.session);
            const control = await driver(value);
            const events = await control.run(
              value.session,
              { privacy: 'public', text: spec.prompt, turnId: spec.jobId },
              spec.signal,
            );
            for (const event of events) yield event;
          } catch (error) {
            if (value) hold(value.projectId, value.id);
            throw error;
          }
        },
      };
    },
    async close() {
      closed = true;
      await Promise.allSettled(observing.values());
      for (const [id, projectId] of scopes) hold(projectId, id);
      const resolved = await Promise.allSettled(drivers.values());
      const joined = await Promise.allSettled(resolved.map(async result => {
        if (result.status === 'fulfilled') await result.value.close?.();
      }));
      drivers.clear();
      scopes.clear();
      if (joined.some(result => result.status === 'rejected'))
        throw new BosunError('unavailable', 'Managed native shutdown remains unknown', { details: { outcome: 'unknown' } });
    },
  };
  return service;
}
