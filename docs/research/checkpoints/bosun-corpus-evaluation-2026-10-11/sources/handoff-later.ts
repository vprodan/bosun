import { BosunError } from '../errors.ts';
import { bootstrapUsesInference, requireManagedControl } from '../managed-policy.ts';
import { requirePublicInput } from '../policy.ts';
import { screenPublicText } from '../secret-screen.ts';
import type { ManagedSession, ContextSample, AdmissionFence } from '../domain/session.ts';
import type { ManagedSessionControl } from '../ports/host.ts';
import { utf8Bytes } from '../domain/job.ts';

export type HandoffPhase =
  | 'starting'
  | 'seeding'
  | 'active'
  | 'fenced'
  | 'staged'
  | 'held'
  | 'retired';
export type ManagedOwnership = {
  id: string;
  projectId: string;
  cwd: string;
  version: number;
  phase: HandoffPhase;
  session: ManagedSession;
  stage: {
    generation: number;
    attemptId: string;
    destination: ManagedSession | null;
    artifactHash: string | null;
  } | null;
  retired: { sessionId: string; generation: number } | null;
  seedHash?: string | null;
  authorityArtifactId?: string | null;
  activationJobId?: string | null;
  bootstrap?: {
    jobId: string;
    configHash: string;
    seedHash: string;
    cwdDev: number;
    cwdIno: number;
    effort: string | null;
  } | null;
};
export interface HandoffStorage {
  registerOwnership(
    claim: Omit<ManagedOwnership, 'version' | 'phase' | 'stage' | 'retired'>,
  ): ManagedOwnership;
  ownership(projectId: string, id: string): ManagedOwnership;
  fenceOwnership(expected: ManagedOwnership): ManagedOwnership;
  stageOwnership(
    expected: ManagedOwnership,
    attemptId: string,
    artifactHash: string,
  ): ManagedOwnership;
  destinationOwnership(expected: ManagedOwnership, destination: ManagedSession): ManagedOwnership;
  transferOwnership(expected: ManagedOwnership): ManagedOwnership;
  holdOwnership(expected: ManagedOwnership): ManagedOwnership;
  recoverOwnership(): number;
}
export type HandoffSeed = { privacy: 'public'; text: string; hash: string };
// Both the scheduler and the controller require the same current, complete
// telemetry. The controller repeats this check immediately before fencing.
export function handoffContextIsCurrent(
  sample: ContextSample,
  session: ManagedSession,
  options: { now: number; threshold: number; latestTurnId?: string },
): boolean {
  return (
    Number.isFinite(options.threshold) &&
    options.threshold > 0 &&
    options.threshold < 1 &&
    sample.sessionId === session.sessionId &&
    sample.generation === session.generation &&
    sample.modelId === session.model &&
    !!options.latestTurnId &&
    sample.turnId === options.latestTurnId &&
    sample.quality === 'observed' &&
    sample.scope === 'active-total' &&
    Number.isSafeInteger(sample.usedTokens) &&
    Number.isSafeInteger(sample.windowTokens) &&
    sample.usedTokens! >= 0 &&
    sample.windowTokens! >= 1 &&
    sample.usedTokens! <= sample.windowTokens! &&
    Number.isSafeInteger(options.now) &&
    Number.isSafeInteger(sample.observedAt) &&
    options.now >= sample.observedAt &&
    options.now - sample.observedAt <= 30000 &&
    (sample.nativeAutoLimit === undefined ||
      (Number.isSafeInteger(sample.nativeAutoLimit) &&
        sample.nativeAutoLimit > sample.windowTokens! * options.threshold))
  );
}
export type HandoffDependencies = {
  storage: HandoffStorage;
  now(): number;
  id(): string;
  hash(text: string): string;
  control(hostId: string): ManagedSessionControl;
  // Snapshot and persist the completed cursor/constraints/evidence before returning the seed.
  // This callback never advances an incomplete cursor or reads unscreened source payloads.
  prepare(source: Readonly<ManagedOwnership>, signal: AbortSignal): Promise<HandoffSeed>;
  // A model-backed bootstrap must use the application's existing quota and
  // usage authority. The core never silently dispatches an unadmitted turn.
  bootstrap?(control: ManagedSessionControl, session: ManagedSession,
    seed: HandoffSeed, signal: AbortSignal): Promise<void>;
};
const unavailable = (unknown = false) =>
  new BosunError(
    'unavailable',
    'Managed handoff unavailable',
    unknown ? { details: { outcome: 'unknown' } } : undefined,
  );
const invalid = () => new BosunError('invalid', 'Invalid managed ownership');
const idValue = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const hashValue = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const generation = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) < Number.MAX_SAFE_INTEGER;
export function managedSession(value: ManagedSession): ManagedSession {
  if (
    !value ||
    !['opencode', 'codex', 'claude'].includes(value.hostId) ||
    !idValue(value.sessionId) ||
    !idValue(value.ownerId) ||
    !generation(value.generation) ||
    typeof value.model !== 'string' ||
    !value.model.length ||
    value.model.length > 256 ||
    /[\s\0]/.test(value.model) ||
    !['read', 'edit'].includes(value.access)
  )
    throw invalid();
  return {
    hostId: value.hostId,
    sessionId: value.sessionId,
    ownerId: value.ownerId,
    generation: value.generation,
    model: value.model,
    access: value.access,
  };
}
export function managedOwnership(value: ManagedOwnership): ManagedOwnership {
  if (
    !value ||
    !idValue(value.id) ||
    typeof value.projectId !== 'string' ||
    !value.projectId ||
    value.projectId.length > 200 ||
    value.projectId.includes('\0') ||
    typeof value.cwd !== 'string' ||
    !value.cwd.startsWith('/') ||
    value.cwd.includes('\0') ||
    value.cwd.length > 4096 ||
    !generation(value.version) ||
    value.version < 1 ||
    !['starting', 'seeding', 'active', 'fenced', 'staged', 'held', 'retired'].includes(value.phase)
  )
    throw invalid();
  const session = managedSession(value.session);
  let stage: ManagedOwnership['stage'] = null;
  if (value.stage !== null) {
    const raw = value.stage;
    if (
      !raw ||
      raw.generation !== session.generation + 1 ||
      !idValue(raw.attemptId) ||
      !hashValue(raw.artifactHash)
    )
      throw invalid();
    const destination = raw.destination === null ? null : managedSession(raw.destination);
    if (
      destination &&
      (destination.ownerId !== session.ownerId ||
        destination.generation !== raw.generation ||
        destination.hostId !== session.hostId ||
        destination.sessionId === session.sessionId ||
        destination.model !== session.model ||
        destination.access !== session.access)
    )
      throw invalid();
    stage = {
      generation: raw.generation,
      attemptId: raw.attemptId,
      artifactHash: raw.artifactHash,
      destination,
    };
  }
  if ((value.phase === 'staged' && !stage) || (value.phase === 'active' && stage)) throw invalid();
  let retired: ManagedOwnership['retired'] = null;
  if (value.retired !== null) {
    if (
      !idValue(value.retired?.sessionId) ||
      !generation(value.retired?.generation) ||
      value.retired.generation >= session.generation ||
      value.retired.sessionId === session.sessionId
    )
      throw invalid();
    retired = { sessionId: value.retired.sessionId, generation: value.retired.generation };
  }
  const seedHash = value.seedHash ?? null;
  const authorityArtifactId = value.authorityArtifactId ?? null;
  const activationJobId = value.activationJobId ?? null;
  if (activationJobId !== null && !idValue(activationJobId)) throw invalid();
  if (authorityArtifactId !== null && !idValue(authorityArtifactId)) throw invalid();
  if (seedHash !== null && !hashValue(seedHash)) throw invalid();
  const bootstrap = value.bootstrap ?? null;
  if (
    bootstrap &&
    (!idValue(bootstrap.jobId) ||
      !hashValue(bootstrap.configHash) ||
      !hashValue(bootstrap.seedHash) ||
      !generation(bootstrap.cwdDev) ||
      !generation(bootstrap.cwdIno) ||
      bootstrap.cwdIno < 1 ||
      (bootstrap.effort !== null &&
        (typeof bootstrap.effort !== 'string' ||
          !bootstrap.effort.length ||
          bootstrap.effort.length > 80 ||
          /[\x00-\x1f\x7f]/.test(bootstrap.effort))))
  )
    throw invalid();
  if (
    ['starting', 'seeding'].includes(value.phase) &&
    (!bootstrap || stage || retired || seedHash !== null || session.generation !== 0)
  )
    throw invalid();
  return {
    id: value.id,
    projectId: value.projectId,
    cwd: value.cwd,
    version: value.version,
    phase: value.phase,
    session,
    stage,
    retired,
    seedHash,
    authorityArtifactId,
    activationJobId,
    bootstrap: bootstrap ? { ...bootstrap } : null,
  };
}
function sameSession(a: ManagedSession, b: ManagedSession): boolean {
  return ['hostId', 'sessionId', 'ownerId', 'generation', 'model', 'access'].every(
    (key) => a[key as keyof ManagedSession] === b[key as keyof ManagedSession],
  );
}

// One daemon-owned task/worktree claim. No transcript parser, model loop, replay,
// source deletion or generic automatic recovery. Uncertain attempts stay held.
export function createHandoffController(dependencies: HandoffDependencies) {
  const busy = new Set<string>();
  let closed = false;
  function current(projectId: string, id: string) {
    if (closed) throw unavailable();
    return managedOwnership(dependencies.storage.ownership(projectId, id));
  }
  function selected(expected: ManagedOwnership) {
    const row = current(expected.projectId, expected.id);
    if (
      row.version !== expected.version ||
      row.phase !== expected.phase ||
      !sameSession(row.session, expected.session)
    )
      throw new BosunError('conflict', 'Managed ownership changed');
    return row;
  }
  const gates = (projectId: string, id: string) => ({
    assertOwner(expected: { ownerId: string; generation: number }) {
      const row = current(projectId, id);
      if (
        row.phase === 'held' ||
        expected.ownerId !== row.session.ownerId ||
        (expected.generation !== row.session.generation &&
          !(row.phase === 'staged' && expected.generation === row.stage!.generation))
      )
        throw unavailable();
    },
    assertDispatchOwner(expected: { ownerId: string; generation: number; sessionId: string }) {
      const row = current(projectId, id);
      if (
        row.phase !== 'active' ||
        expected.ownerId !== row.session.ownerId ||
        expected.generation !== row.session.generation ||
        expected.sessionId !== row.session.sessionId
      )
        throw unavailable();
    },
    freshClaim(source: ManagedSession) {
      const row = current(projectId, id);
      if (
        row.phase !== 'staged' ||
        !row.stage ||
        !sameSession(row.session, source) ||
        row.stage.destination
      )
        throw unavailable();
      return { ownerId: row.session.ownerId, generation: row.stage.generation };
    },
  });
  return {
    gates,
    register: (claim: Parameters<HandoffStorage['registerOwnership']>[0]) => {
      if (closed) throw unavailable();
      return dependencies.storage.registerOwnership(claim);
    },
    status: current,
    async handoff(
      projectId: string,
      id: string,
      options: { automatic: boolean; threshold: number; latestTurnId?: string },
      signal: AbortSignal,
    ) {
      let row = current(projectId, id);
      const key = `${projectId}:${id}`;
      if (row.phase !== 'active' || busy.has(key))
        throw new BosunError('conflict', 'Managed handoff already held');
      // The caller cannot turn unqualified controls into automatic/manual takeover.
      const control = requireManagedControl({ control: dependencies.control(row.session.hostId) });
      if (bootstrapUsesInference(control) && !dependencies.bootstrap)
        throw new BosunError('unsupported', 'Managed bootstrap admission unavailable');
      if (signal.aborted) throw new BosunError('cancelled', 'Managed handoff cancelled');
      if (!Number.isFinite(options.threshold) || options.threshold <= 0 || options.threshold >= 1)
        throw invalid();
      busy.add(key);
      let fenced = false;
      const live = () => {
        if (signal.aborted) throw new BosunError('cancelled', 'Managed handoff cancelled');
        selected(row);
      };
      try {
        if (options.automatic) {
          const sample: ContextSample = await control.observeContext(row.session, signal);
          live();
          if (
            !handoffContextIsCurrent(sample, row.session, { ...options, now: dependencies.now() })
          )
            throw new BosunError('unverified', 'Managed context sample unverified');
          if (sample.usedTokens! < sample.windowTokens! * options.threshold)
            return { state: 'below-threshold' as const, ownership: row };
        }
        live();
        row = dependencies.storage.fenceOwnership(row);
        fenced = true;
        const fence: AdmissionFence = await control.fenceAdmission(row.session, signal);
        live();
        if (
          fence.sessionId !== row.session.sessionId ||
          fence.generation !== row.session.generation ||
          !idValue(fence.token)
        )
          throw unavailable();
        const quiet = await control.quiesce(row.session, fence, signal);
        live();
        if (
          quiet.sessionId !== row.session.sessionId ||
          quiet.generation !== row.session.generation ||
          quiet.idle !== true ||
          quiet.pendingTools !== 0
        )
          throw unavailable();
        const seed = await dependencies.prepare(row, signal);
        live();
        requirePublicInput(seed);
        if (
          typeof seed.text !== 'string' ||
          !seed.text.trim() ||
          seed.text.includes('\0') ||
          seed.text.length > 12000 ||
          utf8Bytes(seed.text) > 16384 ||
          !hashValue(seed.hash) ||
          dependencies.hash(seed.text) !== seed.hash
        )
          throw invalid();
        screenPublicText(seed.text);
        row = dependencies.storage.stageOwnership(row, dependencies.id(), seed.hash);
        const destination = managedSession(await control.startFresh(row.session, signal));
        live();
        row = dependencies.storage.destinationOwnership(row, destination);
        if (dependencies.bootstrap) await dependencies.bootstrap(control, destination, seed, signal);
        else await control.seed(destination, seed, signal);
        live();
        const ready = await control.ready(
          destination,
          { seedHash: seed.hash, model: row.session.model, access: row.session.access },
          signal,
        );
        live();
        if (
          ready.sessionId !== destination.sessionId ||
          ready.generation !== destination.generation ||
          ready.seedHash !== seed.hash ||
          ready.root !== true ||
          ready.idle !== true ||
          ready.model !== destination.model ||
          ready.access !== destination.access
        )
          throw unavailable();
        // Bootstrap has no dispatch ownership. This one durable CAS retires the
        // source and selects the exact acknowledged native destination together.
        row = dependencies.storage.transferOwnership(row);
        return { state: 'transferred' as const, ownership: row };
      } catch (error) {
        if (fenced) {
          try {
            const latest = current(projectId, id);
            if (latest.phase !== 'active') dependencies.storage.holdOwnership(latest);
          } catch {
            /* uncertain COMMIT/storage authority remains fenced */
          }
          throw unavailable(true);
        }
        if (error instanceof BosunError) throw error;
        throw unavailable();
      } finally {
        busy.delete(key);
      }
    },
    recover() {
      if (closed) throw unavailable();
      return dependencies.storage.recoverOwnership();
    },
    close() {
      closed = true;
    },
  };
}
