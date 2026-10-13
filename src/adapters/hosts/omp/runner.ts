import { createHash, randomUUID } from 'node:crypto';
import type { Env } from '../../../core/domain/inference.ts';
import type { ManagedSession } from '../../../core/domain/session.ts';
import type { AgentRunner } from '../../../core/ports/runner.ts';
import { BosunError } from '../../../core/errors.ts';
import { requirePublicInput } from '../../../core/policy.ts';
import { screenPublicText } from '../../../core/secret-screen.ts';
import { createOmpControl } from './control.ts';
import { detectOmp } from './client.ts';
import { identifier, ompFailure, selection } from './protocol.ts';
import { OMP_SYSTEM_POLICY } from './managed-bridge.ts';

export type OmpRunnerOptions = { command?: string; env: Env; timeoutMs?: number; killGraceMs?: number };
// The factory captures configuration only. Native credentials and processes are
// accessed only for an explicitly selected, screened original job.
export function createOmpRunner(options: OmpRunnerOptions): AgentRunner {
  const attempts = new Set<string>();
  return {
    id: 'omp',
    caps: Object.freeze({ vendor: 'omp', readOnly: 'unverified', sandbox: 'tool-allowlist',
      mcpInject: 'unsupported', effort: 'verified', localBackend: 'unverified', billing: 'unknown' }),
    detect: env => detectOmp(options.command ?? 'omp', env),
    async *run(spec) {
      requirePublicInput(spec); screenPublicText(spec.prompt);
      if (spec.signal.aborted) throw ompFailure('cancelled');
      if (spec.managed !== undefined || spec.maxTurns !== undefined || spec.mcp?.length || spec.env && Object.keys(spec.env).length)
        throw new BosunError('unsupported', 'OMP execution option requires separately qualified native support');
      if (spec.access === 'read') throw new BosunError('unverified', 'OMP read-only tool policy remains unqualified');
      selection(spec.model, spec.effort ?? 'off', spec.access);
      const nonce = randomUUID().replaceAll('-', ''), ownerId = 'run_' + nonce;
      const requestId = spec.jobId ?? nonce;
      if (!identifier(requestId) || attempts.has(requestId)) throw ompFailure('unavailable', true);
      attempts.add(requestId);
      let session: ManagedSession | undefined;
      const driver = createOmpControl(options, {
        hash: value => createHash('sha256').update(value).digest('hex'), now: Date.now,
        id: () => randomUUID().replaceAll('-', ''),
        assertOwner(value) {
          if (value.ownerId !== ownerId || value.generation !== 0) throw ompFailure('unavailable', true);
        },
        assertDispatchOwner(value) {
          if (!session || value.ownerId !== ownerId || value.generation !== 0 || value.sessionId !== session.sessionId)
            throw ompFailure('unavailable', true);
        },
        freshClaim() { throw new BosunError('unsupported', 'Ordinary jobs do not authorize managed ownership transfer'); },
      });
      let joined = false;
      try {
        session = await driver.create({ privacy: 'public', requestId, ownerId, generation: 0, cwd: spec.cwd,
          model: spec.model!, effort: spec.effort, access: spec.access }, spec.signal);
        const seedHash = createHash('sha256').update(OMP_SYSTEM_POLICY).digest('hex');
        await driver.seed(session, { privacy: 'public', text: OMP_SYSTEM_POLICY, hash: seedHash }, spec.signal);
        await driver.ready(session, { seedHash, model: session.model, access: session.access }, spec.signal);
        const events = await driver.run(session, { privacy: 'public', text: spec.prompt, turnId: requestId }, spec.signal);
        await driver.close!(); joined = true;
        // Native success stays buffered until the original process and ordinary
        // descendants have joined. A lost close/result never releases replay.
        for (const event of events) yield event;
      } finally { if (!joined) await driver.close!(); }
    },
  };
}
