import './bootstrap.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SqliteDatabase } from '../src/platform/sqlite.ts';
import { sandbox } from './helpers.ts';
import { BosunError } from '../src/core/errors.ts';
import { createHandoffController, type HandoffDependencies, type HandoffSeed, type ManagedOwnership } from '../src/core/use-cases/handoff.ts';
import { SqliteJobStore } from '../src/adapters/jobs/sqlite-jobs.ts';
import { DaemonOwner } from '../src/platform/daemon-owner.ts';
import type { ManagedSessionControl } from '../src/core/ports/host.ts';
import type { ContextSample, ManagedSession } from '../src/core/domain/session.ts';

const hash = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
const signal = () => new AbortController().signal;
const source: ManagedSession = { hostId: 'opencode', sessionId: 'ses_source', ownerId: 'owner_a', generation: 0, model: 'selected/model:exact', access: 'edit' };
const destination: ManagedSession = { ...source, sessionId: 'ses_destination', generation: 1 };
const options = { automatic: true, threshold: 0.7, latestTurnId: 'turn_latest' };
const seed = (): HandoffSeed => ({ privacy: 'public', text: 'Objective: continue approved task. Constraints: preserve selected model. Next: inspect src/app.', hash: hash('Objective: continue approved task. Constraints: preserve selected model. Next: inspect src/app.') });
const code = (name: string) => (error: unknown) => error instanceof BosunError && error.code === name;
const unknown = (error: unknown) => error instanceof BosunError && error.details?.outcome === 'unknown' && !error.message.includes('CANARY');
function fixture() {
  const sb = sandbox(); const dir = path.join(sb.root, 'managed'); fs.mkdirSync(dir, { mode: 0o700 });
  const file = path.join(dir, 'state.db'); const ownerFile = path.join(dir, 'owner.db');
  const owner = new DaemonOwner(ownerFile); const store = new SqliteJobStore({ file, assertOwner: () => owner.assert() });
  return { sb, dir, file, ownerFile, owner, store, close() { store.close(); owner.close(); sb.cleanup(); } };
}
function harness(f: ReturnType<typeof fixture>, overrides: Partial<ManagedSessionControl> = {}, prepare?: (source: Readonly<ManagedOwnership>, signal: AbortSignal) => Promise<HandoffSeed>, bootstrap?: HandoffDependencies['bootstrap']) {
  const calls: string[] = []; const held = (call: () => unknown) => assert.throws(call, code('unavailable'));
  let sample: ContextSample = { sessionId: source.sessionId, turnId: 'turn_latest', modelId: source.model, usedTokens: 700, windowTokens: 1000,
    scope: 'active-total', observedAt: 100000, generation: 0, quality: 'observed' };
  let controller!: ReturnType<typeof createHandoffController>;
  const gates = () => controller.gates('p_a', 'task_a');
  const control: ManagedSessionControl = {
    caps: { contextTelemetry: 'verified', promptAdmission: 'verified', toolQuiescence: 'verified', freshSession: 'verified', seedWithoutInference: 'verified', freshReadiness: 'verified' },
    async observeContext() { calls.push('observe'); return sample; },
    async fenceAdmission(s) { calls.push('fence'); held(() => gates().assertDispatchOwner(s)); return { sessionId: s.sessionId, generation: s.generation, token: 'fence_a' }; },
    async quiesce(s) { calls.push('quiesce'); return { sessionId: s.sessionId, generation: s.generation, pendingTools: 0, idle: true }; },
    async startFresh(s) { calls.push('fresh'); assert.deepEqual(gates().freshClaim(s), { ownerId: source.ownerId, generation: 1 }); gates().assertOwner(destination); held(() => gates().assertDispatchOwner(destination)); return destination; },
    async seed(s, input) { calls.push('seed'); assert.deepEqual(input, seed()); gates().assertOwner(s); held(() => gates().assertDispatchOwner(s)); },
    async ready(s, expected) { calls.push('ready'); held(() => gates().assertDispatchOwner(s)); return { sessionId: s.sessionId, generation: s.generation, model: s.model, access: s.access, idle: true, root: true, seedHash: expected.seedHash }; },
    ...overrides,
  };
  controller = createHandoffController({ storage: f.store, now: () => 100000, id: () => 'attempt_a', hash, control: () => control,
    prepare: prepare ?? (async () => { calls.push('prepare'); return seed(); }), bootstrap });
  controller.register({ id: 'task_a', projectId: 'p_a', cwd: '/synthetic/project', session: source });
  return { controller, calls, control, setSample(value: Partial<ContextSample>) { sample = { ...sample, ...value }; } };
}

test('durable handoff blocks both dispatch paths until exact native acknowledgement and one ownership CAS retires source', async () => {
  const f = fixture(); const h = harness(f);
  try {
    h.controller.gates('p_a', 'task_a').assertDispatchOwner(source);
    const result = await h.controller.handoff('p_a', 'task_a', options, signal());
    assert.equal(result.state, 'transferred'); assert.equal(result.ownership.phase, 'active'); assert.deepEqual(result.ownership.session, destination);
    assert.deepEqual(result.ownership.retired, { sessionId: source.sessionId, generation: 0 }); assert.equal(result.ownership.stage, null);
    h.controller.gates('p_a', 'task_a').assertDispatchOwner(destination);
    assert.throws(() => h.controller.gates('p_a', 'task_a').assertDispatchOwner(source), code('unavailable'));
    assert.deepEqual(h.calls, ['observe', 'fence', 'quiesce', 'prepare', 'fresh', 'seed', 'ready']);
    const db = new SqliteDatabase(f.file, { readOnly: true });
    try { assert.deepEqual({ ...db.prepare('SELECT * FROM managed_retirements').get() }, { owner_id: 'owner_a', generation: 0, session_id: 'ses_source' }); assert.equal(JSON.stringify(db.prepare('SELECT payload FROM managed_ownership').all()).includes('Objective'), false); }
    finally { db.close(); }
    assert.throws(() => h.controller.status('p_b', 'task_a'), code('not_found'));
  } finally { h.controller.close(); f.close(); }
});

test('unverified host controls and stale/foreign/body-only/estimated context never fence or prepare a source', async () => {
  const f = fixture(); const h = harness(f);
  try {
    for (const change of [{ usedTokens: 699 }, { usedTokens: null }, { scope: 'body-only' as const }, { quality: 'estimated' as const }, { turnId: 'old_turn' }, { sessionId: 'ses_other' }, { generation: 1 }, { modelId: 'other' }, { observedAt: 69999 }, { nativeAutoLimit: 699 }, { usedTokens: 1001 }]) {
      h.setSample({ sessionId: source.sessionId, turnId: 'turn_latest', modelId: source.model, usedTokens: 700, windowTokens: 1000, scope: 'active-total', quality: 'observed', generation: 0, observedAt: 100000, nativeAutoLimit: undefined, ...change });
      if (change.usedTokens === 699) assert.equal((await h.controller.handoff('p_a', 'task_a', options, signal())).state, 'below-threshold');
      else await assert.rejects(h.controller.handoff('p_a', 'task_a', options, signal()), code('unverified'));
      assert.equal(h.controller.status('p_a', 'task_a').phase, 'active');
    }
    assert.equal(h.calls.some(call => call !== 'observe'), false);
    h.control.caps.promptAdmission = 'unverified'; await assert.rejects(h.controller.handoff('p_a', 'task_a', { ...options, automatic: false }, signal()), code('unverified'));
  } finally { h.controller.close(); f.close(); }
});

test('bad quiescence, public classification/secret/hash/acknowledgement failures preserve source ownership and retain a held attempt', async () => {
  const cases: { control?: Partial<ManagedSessionControl>; prepare?: () => Promise<HandoffSeed> }[] = [
    { control: { async quiesce(s) { return { sessionId: s.sessionId, generation: s.generation, pendingTools: 1, idle: true } as never; } } },
    { prepare: async () => ({ privacy: 'private', get text(): never { throw Error('PRIVATE_CONTENT_CANARY'); }, hash: 'a'.repeat(64) } as never) },
    { prepare: async () => ({ ...seed(), hash: 'b'.repeat(64) }) },
    { prepare: async () => { const text = 'api_key=sk-proj-' + 'a'.repeat(40); return { privacy: 'public', text, hash: hash(text) }; } },
    { control: { async startFresh() { return { ...destination, model: 'silent-fallback' }; } } },
    { control: { async ready(s, expected) { return { ...expected, sessionId: s.sessionId, generation: s.generation, root: true, idle: true, seedHash: 'b'.repeat(64) }; } } },
  ];
  for (const value of cases) {
    const f = fixture(); const h = harness(f, value.control, value.prepare);
    try {
      await assert.rejects(h.controller.handoff('p_a', 'task_a', options, signal()), unknown);
      const row = h.controller.status('p_a', 'task_a'); assert.equal(row.phase, 'held'); assert.deepEqual(row.session, source);
      assert.throws(() => h.controller.gates('p_a', 'task_a').assertDispatchOwner(source), code('unavailable'));
      assert.throws(() => h.controller.gates('p_a', 'task_a').assertDispatchOwner(destination), code('unavailable'));
      await assert.rejects(h.controller.handoff('p_a', 'task_a', options, signal()), code('conflict'));
    } finally { h.controller.close(); f.close(); }
  }
});

test('concurrent ownership changes during summary cancel destination bootstrap and do not replay source work', async () => {
  const f = fixture(); let proceed!: () => void; let entered!: () => void;
  const pending = new Promise<void>(resolve => { proceed = resolve; }); const reached = new Promise<void>(resolve => { entered = resolve; });
  const h = harness(f, {}, async () => { entered(); await pending; return seed(); });
  try {
    const operation = h.controller.handoff('p_a', 'task_a', options, signal()); await reached;
    await assert.rejects(h.controller.handoff('p_a', 'task_a', options, signal()), code('conflict'));
    f.store.holdOwnership(h.controller.status('p_a', 'task_a')); proceed(); await assert.rejects(operation, unknown);
    assert.equal(h.calls.includes('fresh'), false); assert.equal(h.controller.status('p_a', 'task_a').phase, 'held');
  } finally { proceed(); h.controller.close(); f.close(); }
});

test('actual ownership transfer COMMIT then lost receipt fences both owners; reopen preserves destination retirement and holds without replay', async () => {
  const f = fixture(); let armed = false; const exec = SqliteDatabase.prototype.exec;
  const h = harness(f, { async ready(s, expected) { armed = true; return { ...expected, sessionId: s.sessionId, generation: s.generation, root: true, idle: true }; } });
  let reopened: SqliteJobStore | undefined;
  try {
    SqliteDatabase.prototype.exec = function(sql) { const value = exec.call(this, sql); if (armed && sql === 'COMMIT') { armed = false; throw Error('PRIVATE_COMMIT_CANARY'); } return value; };
    await assert.rejects(h.controller.handoff('p_a', 'task_a', options, signal()), unknown);
    assert.throws(() => h.controller.gates('p_a', 'task_a').assertDispatchOwner(source), code('unavailable'));
    assert.throws(() => h.controller.gates('p_a', 'task_a').assertDispatchOwner(destination), code('unavailable'));
    SqliteDatabase.prototype.exec = exec; f.store.close();
    reopened = new SqliteJobStore({ file: f.file, assertOwner: () => f.owner.assert() });
    assert.deepEqual(reopened.ownership('p_a', 'task_a').session, destination); assert.equal(reopened.recoverOwnership(), 1);
    assert.equal(reopened.ownership('p_a', 'task_a').phase, 'held'); assert.equal(reopened.recoverOwnership(), 0);
    assert.equal(h.calls.filter(call => call === 'fresh').length, 1);
  } finally { SqliteDatabase.prototype.exec = exec; reopened?.close(); h.controller.close(); f.close(); }
});

test('an isolated readiness turn requires bootstrap admission before any source effects', async () => {
  for (const mode of ['missing', 'denied', 'admitted'] as const) {
    const f = fixture();
    const caps: ManagedSessionControl['caps'] = {
      contextTelemetry: 'verified', promptAdmission: 'verified', toolQuiescence: 'verified',
      freshSession: 'verified', freshReadiness: 'verified', seedWithoutInference: 'unsupported',
      isolatedBootstrapTurn: 'verified',
    };
    let admissions = 0;
    const h = harness(f, { caps }, undefined, mode === 'missing' ? undefined : async (control, session, input, abort) => {
      admissions++;
      assert.equal(session.sessionId, destination.sessionId);
      if (mode === 'denied') throw new BosunError('unavailable', 'Quota held');
      await control.seed(session, input, abort);
    });
    try {
      if (mode === 'admitted') {
        assert.equal((await h.controller.handoff('p_a', 'task_a', options, signal())).state, 'transferred');
        assert.equal(admissions, 1);
        assert.equal(h.calls.filter(call => call === 'seed').length, 1);
      } else {
        await assert.rejects(h.controller.handoff('p_a', 'task_a', options, signal()), code(mode === 'missing' ? 'unsupported' : 'unavailable'));
        assert.equal(h.calls.includes('seed'), false);
        assert.equal(h.controller.status('p_a', 'task_a').phase, mode === 'missing' ? 'active' : 'held');
        if (mode === 'missing') assert.deepEqual(h.calls, []);
      }
    } finally { h.controller.close(); f.close(); }
  }
});
