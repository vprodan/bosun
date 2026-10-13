import crypto from 'node:crypto';
import { BosunError } from '../core/errors.ts';
import {
  CARD_LIMITS,
  cardOwner,
  cardRecord,
  cardStatus,
  type CardRecord,
  type CardObservation,
} from '../core/domain/card.ts';
import { data, jobId, type JobScope } from '../core/domain/job.ts';
import { requirePublicInput } from '../core/policy.ts';
import { workspaceText } from '../core/domain/workspace.ts';
import type { Env } from '../core/domain/inference.ts';
import type { WorkspaceCard } from '../core/ports/workspace.ts';
import { createOfflineGit } from '../platform/git.ts';
import { createOrcaCard } from '../adapters/workspaces/orca-card.ts';
import { assertCardHash, cardRequestHash, cardTextHash } from '../platform/card-hash.ts';
import type { openDaemonJobs } from './jobs.ts';

export function createCardService(options: {
  jobs: ReturnType<typeof openDaemonJobs>;
  env: Env;
  driver?: WorkspaceCard;
  gitCommand?: string;
}) {
  const driver =
    options.driver ?? createOrcaCard({ env: options.env, gitCommand: options.gitCommand });
  const git = createOfflineGit({
    env: options.env,
    command: options.gitCommand,
  });
  const shutdown = new AbortController();
  const pending = new Set<Promise<unknown>>();
  let closed = false;
  async function bound(scope: JobScope, from: string, record: CardRecord, signal: AbortSignal) {
    cardOwner(scope);
    assertCardHash(record);
    const source = await git.repository(from, undefined, signal);
    if (
      source.projectId !== scope.projectId ||
      record.projectId !== source.projectId ||
      record.binding.root !== source.root ||
      record.binding.common !== source.common
    )
      throw new BosunError('conflict', 'Card receipt belongs to another checkout');
    return record;
  }
  function report(record: CardRecord, observation?: CardObservation) {
    return {
      record,
      ...(observation
        ? {
            observation,
            observationHash: cardTextHash(JSON.stringify(observation)),
            matches:
              observation.status === record.status &&
              (record.commentHash === null || observation.commentHash === record.commentHash),
          }
        : {}),
    };
  }
  async function operation<T>(
    run: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (closed) throw new BosunError('unavailable', 'Card authority draining');
    options.jobs.assertOwner();
    if (pending.size >= CARD_LIMITS.pending)
      throw new BosunError('unavailable', 'Card operation capacity reached');
    const control = AbortSignal.any([
      shutdown.signal,
      AbortSignal.timeout(CARD_LIMITS.timeoutMs),
      ...(signal ? [signal] : []),
    ]);
    const task = Promise.resolve().then(() => {
      if (control.aborted) throw new BosunError('cancelled', 'Card operation cancelled');
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
  return {
    submit(
      input: { privacy: 'public'; requestId: string; status: string; comment?: string },
      scope: JobScope,
      from: string,
      signal?: AbortSignal,
    ) {
      const trusted = cardOwner(scope);
      requirePublicInput(input);
      const requestId = jobId(data(input, 'requestId'));
      workspaceText(requestId, 200);
      return operation(async (control) => {
        const previous = options.jobs.cards.findRequest(trusted, requestId);
        if (previous)
          return { ...report(await bound(trusted, from, previous, control)), duplicate: true };
        requirePublicInput(input);
        const status = cardStatus(data(input, 'status'));
        const descriptor = Object.getOwnPropertyDescriptor(input, 'comment');
        const comment = descriptor
          ? workspaceText(data(input, 'comment'), CARD_LIMITS.commentBytes)
          : undefined;
        const source = await git.repository(from, undefined, control);
        if (source.projectId !== trusted.projectId)
          throw new BosunError('conflict', 'Card project changed');
        const current = await driver.current(source.root, control);
        if (
          current.binding.root !== source.root ||
          current.binding.common !== source.common ||
          current.binding.projectId !== trusted.projectId ||
          current.binding.hostId !== 'local'
        )
          throw new BosunError('conflict', 'Orca worktree belongs to another checkout');
        const at = Date.now();
        const fields = {
          id: `card_${crypto.randomUUID().replaceAll('-', '')}`,
          requestId,
          projectId: source.projectId,
          binding: current.binding,
          status,
          commentHash: comment === undefined ? null : cardTextHash(comment),
        };
        const reservation = options.jobs.cards.reserve(
          trusted,
          cardRecord({
            ...fields,
            requestHash: cardRequestHash(fields),
            state: 'pending',
            acknowledged: false,
            version: 1,
            createdAt: at,
            updatedAt: at,
          }),
        );
        if (reservation.duplicate)
          return {
            ...report(await bound(trusted, from, reservation.record, control)),
            duplicate: true,
          };
        const record = reservation.record;
        let entered = false;
        let state: 'applied' | 'unknown' | 'not_started' = 'not_started';
        try {
          await bound(trusted, from, record, control);
          if (control.aborted) throw new BosunError('cancelled', 'Card operation cancelled');
          entered = true;
          const result = await driver.update(record.binding, status, comment, control);
          await bound(trusted, from, record, control);
          if (
            JSON.stringify(result.binding) !== JSON.stringify(record.binding) ||
            result.status !== status ||
            (record.commentHash !== null && result.commentHash !== record.commentHash)
          )
            throw new BosunError('conflict', 'Orca update receipt differs from request');
          state = 'applied';
        } catch {
          state = entered ? 'unknown' : 'not_started';
        }
        return {
          ...report(
            options.jobs.cards.finish(trusted, record.id, record.version, state, Date.now()),
          ),
          duplicate: false,
        };
      }, signal);
    },
    get(scope: JobScope, from: string, id: string, signal?: AbortSignal) {
      const trusted = cardOwner(scope);
      return operation(
        async (control) =>
          report(await bound(trusted, from, options.jobs.cards.get(trusted, id), control)),
        signal,
      );
    },
    reconcile(scope: JobScope, from: string, id: string, signal?: AbortSignal) {
      const trusted = cardOwner(scope);
      return operation(async (control) => {
        const record = await bound(trusted, from, options.jobs.cards.get(trusted, id), control);
        return report(record, await driver.observe(record.binding, control));
      }, signal);
    },
    acknowledge(
      input: { id: string; expectedVersion: number; observationHash: string },
      scope: JobScope,
      from: string,
      signal?: AbortSignal,
    ) {
      const trusted = cardOwner(scope);
      const id = jobId(data(input, 'id'));
      const expectedVersion = data(input, 'expectedVersion');
      const observationHash = data(input, 'observationHash');
      if (
        !Number.isSafeInteger(expectedVersion) ||
        Number(expectedVersion) < 1 ||
        typeof observationHash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(observationHash)
      )
        throw new BosunError('invalid', 'Invalid card acknowledgement');
      return operation(async (control) => {
        const record = await bound(trusted, from, options.jobs.cards.get(trusted, id), control);
        if (record.version !== expectedVersion || record.state !== 'unknown')
          throw new BosunError('conflict', 'Card receipt changed');
        const observation = await driver.observe(record.binding, control);
        if (cardTextHash(JSON.stringify(observation)) !== observationHash)
          throw new BosunError('conflict', 'Card observation changed');
        return report(
          options.jobs.cards.acknowledge(trusted, record.id, record.version, Date.now()),
          observation,
        );
      }, signal);
    },
    async close() {
      closed = true;
      shutdown.abort();
      await Promise.allSettled([...pending]);
    },
  };
}
