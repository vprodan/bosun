import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ManagedSession } from '../src/core/domain/session.ts';
import type { RunSpec } from '../src/core/ports/runner.ts';
import { BosunError } from '../src/core/errors.ts';
import { createOmpControl } from '../src/adapters/hosts/omp/control.ts';
import { createOmpRunner } from '../src/adapters/hosts/omp/runner.ts';
import { OmpFrameDecoder, OMP_VERSION, object } from '../src/adapters/hosts/omp/protocol.ts';
import { ompFixture } from './omp-native-fixture.ts';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function controlFixture(mode = 'normal', version = OMP_VERSION) {
  const native = ompFixture(mode, version);
  let active: ManagedSession | undefined;
  const driver = createOmpControl({ env: native.env, timeoutMs: 5000, requestTimeoutMs: 2000, killGraceMs: 50 }, {
    hash, now: Date.now, id: () => randomUUID().replaceAll('-', ''),
    assertOwner(value) { assert.equal(value.ownerId, 'fixture-owner'); assert.ok([1, 2].includes(value.generation)); },
    assertDispatchOwner(value) { assert.ok(active); assert.equal(value.sessionId, active.sessionId); assert.equal(value.generation, active.generation); },
    freshClaim(source) { assert.equal(source.generation, 1); return { ownerId: source.ownerId, generation: 2 }; },
  });
  async function start() {
    const session = await driver.create({ privacy: 'public', ownerId: 'fixture-owner', generation: 1,
      requestId: 'create-original', cwd: native.workspace, model: 'openai-codex/gpt-6.1-sol', effort: 'high', access: 'edit' }, new AbortController().signal);
    const text = 'Approved public factual seed.';
    await driver.seed(session, { privacy: 'public', text, hash: hash(text) }, new AbortController().signal);
    await driver.ready(session, { model: session.model, access: session.access, seedHash: hash(text) }, new AbortController().signal);
    active = session; return session;
  }
  return { native, driver, start, activate(session: ManagedSession) { active = session; } };
}
const unknown = (error: unknown) => error instanceof BosunError && error.details?.outcome === 'unknown';

test('native OMP source owns one literal turn, captures only admitted evidence and transfers to a distinct idle seeded root', async () => {
  const f = controlFixture();
  try {
    const source = await f.start();
    const prompt = '/literal-command $HOME $(not-a-shell) — public.';
    const events = await f.driver.run(source, { privacy: 'public', turnId: 'original-turn', text: prompt }, new AbortController().signal);
    assert.deepEqual(events, [{ t: 'usage', tokensIn: 10, tokensOut: 3 }, { t: 'done', code: 0, result: 'Synthetic native OMP result — owner verifies.' }]);
    assert.equal(f.native.calls().filter(call => call.op === 'run').length, 1);
    const capture = await f.driver.capture!(source, { privacy: 'public', afterCursor: null }, new AbortController().signal);
    assert.deepEqual(capture.evidence.map(item => item.text), ['Approved public factual seed.', prompt, 'Synthetic native OMP result — owner verifies.']);
    const sample = await f.driver.observeContext(source, new AbortController().signal);
    assert.deepEqual([sample.scope, sample.quality, sample.usedTokens, sample.windowTokens], ['unknown', 'estimated', 100, 200000]);
    const fence = await f.driver.fenceAdmission(source, new AbortController().signal);
    assert.deepEqual(await f.driver.quiesce(source, fence, new AbortController().signal), { sessionId: source.sessionId, generation: 1, pendingTools: 0, idle: true });
    const destination = await f.driver.startFresh(source, new AbortController().signal);
    assert.notEqual(destination.sessionId, source.sessionId); assert.equal(destination.generation, 2);
    const seed = 'Reviewed handoff with the original constraints.';
    await f.driver.seed(destination, { privacy: 'public', text: seed, hash: hash(seed) }, new AbortController().signal);
    const ready = await f.driver.ready(destination, { seedHash: hash(seed), model: source.model, access: source.access }, new AbortController().signal);
    assert.equal(ready.seedHash, hash(seed)); assert.equal(ready.root, true); assert.equal(ready.idle, true);
    const before = f.native.calls().length;
    await assert.rejects(f.driver.run(source, { privacy: 'public', turnId: 'retired-turn', text: 'Do not dispatch old source.' }, new AbortController().signal));
    assert.equal(f.native.calls().length, before);
    f.activate(destination);
  } finally { await f.driver.close!(); f.native.close(); }
});

test('OMP admits major 18 releases and retains the actual CLI/runtime version in owned receipts and captures', async () => {
  for (const version of ['18.0.0', '18.10.4', '18.17.2']) {
    const f = controlFixture('normal', version);
    try {
      const runner = createOmpRunner({ env: f.native.env, timeoutMs: 5000, killGraceMs: 50 });
      assert.equal((await runner.detect(f.native.env)).version, version);
      const session = await f.start();
      assert.ok(Object.values(f.driver.caps).every(value => value === 'unverified'));
      const root = path.join(f.native.env.BOSUN_HOME!, 'native-omp');
      const owned = fs.readdirSync(root);
      assert.equal(owned.length, 1);
      const entries = fs.readFileSync(path.join(root, owned[0]!, 'sessions', session.sessionId + '.jsonl'), 'utf8')
        .trim().split('\n').map((line): unknown => JSON.parse(line));
      const receipts = entries.filter(entry => object(entry) && entry.customType === 'bosun-native-control');
      assert.ok(receipts.length >= 3);
      for (const receipt of receipts) {
        assert.ok(object(receipt) && object(receipt.data));
        assert.equal(receipt.data.version, version);
      }
      const first = await f.driver.capture!(session, { privacy: 'public', afterCursor: null }, new AbortController().signal);
      const repeated = await f.driver.capture!(session, { privacy: 'public', afterCursor: null }, new AbortController().signal);
      assert.equal(first.sourceBindingHash, repeated.sourceBindingHash);
    } finally { await f.driver.close!(); f.native.close(); }
  }
});

test('OMP unsupported major or nonrelease versions fail before native session requests; runtime identity mismatch cannot be admitted', async () => {
  for (const version of ['17.99.0', '19.0.0', '18.1', '18.1.0-preview', '18.1.0+build', '018.1.0']) {
    const f = controlFixture('normal', version);
    try {
      await assert.rejects(f.start(), error => error instanceof BosunError && error.code === 'unverified');
      assert.deepEqual(f.native.calls(), []);
    } finally { await Promise.allSettled([f.driver.close!()]); f.native.close(); }
  }
  const mismatch = controlFixture('runtime-version-mismatch', '18.10.4');
  try {
    await assert.rejects(mismatch.start(), unknown);
    assert.equal(mismatch.native.calls().filter(call => call.op === 'observe').length, 1);
    assert.equal(mismatch.native.calls().filter(call => call.op === 'seed' || call.op === 'run').length, 0);
  } finally { await Promise.allSettled([mismatch.driver.close!()]); mismatch.native.close(); }
});

test('no-inference seed mismatch holds the original root without a second seed attempt', async () => {
  const f = controlFixture('bad-seed');
  try {
    await assert.rejects(f.start(), unknown);
    assert.equal(f.native.calls().filter(call => call.op === 'seed').length, 1);
    assert.equal(f.native.calls().filter(call => call.op === 'run').length, 0);
  } finally { await Promise.allSettled([f.driver.close!()]); f.native.close(); }
});

test('native OMP admission fence blocks a later builtin tool effect even when the selected tool is normally permitted', async () => {
  const f = controlFixture('fenced-tool');
  try {
    const source = await f.start();
    const fence = await f.driver.fenceAdmission(source, new AbortController().signal);
    assert.equal(fs.existsSync(path.join(f.native.workspace, 'unauthorized-tool')), false);
    assert.deepEqual(await f.driver.quiesce(source, fence, new AbortController().signal),
      { sessionId: source.sessionId, generation: source.generation, pendingTools: 0, idle: true });
  } finally { await Promise.allSettled([f.driver.close!()]); f.native.close(); }
});

for (const mode of ['lost-run-receipt', 'model-drift', 'selection-event', 'foreign-history', 'foreign-control', 'private-control', 'async-work', 'secret-echo', 'version-drift', 'source-drift']) {
  test(`OMP ${mode} retains unknown ownership and never replays or exposes a success`, async () => {
    const f = controlFixture(mode);
    try {
      const source = await f.start();
      await assert.rejects(f.driver.run(source, { privacy: 'public', turnId: 'original-turn', text: 'Inspect public source.' }, new AbortController().signal), error => {
        assert.ok(unknown(error)); assert.ok(error instanceof BosunError); assert.doesNotMatch(error.message, /PRIVATE|api_key|z{20}/); return true;
      });
      const count = f.native.calls().length;
      await assert.rejects(f.driver.run(source, { privacy: 'public', turnId: 'later-turn', text: 'No replay.' }, new AbortController().signal), unknown);
      assert.equal(f.native.calls().length, count);
      assert.equal(f.native.calls().filter(call => call.op === 'run').length, 1);
    } finally { await Promise.allSettled([f.driver.close!()]); f.native.close(); }
  });
}

test('ordinary OMP result is released only after its native process joins; reused job IDs cannot start another root', async () => {
  const f = ompFixture('normal', '18.17.2');
  try {
    const runner = createOmpRunner({ env: f.env, timeoutMs: 5000, killGraceMs: 50 });
    const spec: RunSpec = { privacy: 'public', prompt: 'Inspect approved public source.', cwd: f.workspace,
      access: 'edit', model: 'ollama/qwen3.6:owner-tag', effort: 'off', jobId: 'original-job', signal: new AbortController().signal };
    const events = [];
    for await (const event of runner.run(spec)) events.push(event);
    assert.equal(events.at(-1)?.t, 'done');
    const pid = Number(f.calls().find(call => call.op === 'run')!.pid);
    assert.throws(() => process.kill(pid, 0), (error: NodeJS.ErrnoException) => error.code === 'ESRCH');
    const count = f.calls().length;
    await assert.rejects(async () => { for await (const event of runner.run(spec)) void event; }, unknown);
    assert.equal(f.calls().length, count);
  } finally { f.close(); }
});

test('private OMP requests cannot inspect prompt, cwd, models or native environment', async () => {
  let reads = 0;
  const runner = createOmpRunner({ get env(): never { reads++; throw Error('AUTH_CANARY'); } });
  const spec = { privacy: 'private', get prompt(): never { reads++; throw Error('PRIVATE_CANARY'); } };
  // Intentionally invalid consumer input establishes the before-getter boundary.
  const privateSpec = spec as unknown as RunSpec;
  await assert.rejects(async () => { for await (const event of runner.run(privateSpec)) void event; }, error => error instanceof BosunError && error.code === 'private_input');
  assert.equal(reads, 0);
});

test('OMP v2 frames preserve split UTF-8 content and reject interrupted chunks or elided evidence', () => {
  const bytes = Buffer.from(JSON.stringify({ type: 'message_end', text: 'Public 世界 — exact.' }) + '\n');
  const decoder = new OmpFrameDecoder(), frames: unknown[] = [];
  for (let at = 0; at < bytes.length; at += 3) decoder.push(bytes.subarray(at, at + 3), frame => frames.push(frame));
  decoder.finish(); assert.deepEqual(frames, [{ type: 'message_end', text: 'Public 世界 — exact.' }]);
  const interrupted = new OmpFrameDecoder();
  interrupted.push(Buffer.from(JSON.stringify({ type: 'rpc_chunk', chunkId: 'c', count: 2, index: 0, byteLength: 8, data: Buffer.from('{"ty').toString('base64') }) + '\n'), () => assert.fail('Incomplete logical frame must not escape'));
  assert.throws(() => interrupted.push(Buffer.from('{"type":"session_settled"}\n'), () => {}), unknown);
  const elided = new OmpFrameDecoder();
  assert.throws(() => elided.push(Buffer.from('{"type":"message_end","rpcFrameElidedKeys":["text"]}\n'), () => {}), unknown);
});
