import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { sandbox, fresh, REPO } from './helpers.ts';
import { createRetrieveContext, estTokens, type ContextDependencies, type ContextMeasurement } from '../src/core/use-cases/retrieve-context.ts';
import { contentHash } from '../src/platform/content-hash.ts';
import { contentHash as legacyHash } from '../lib/memory/sqlite.ts';
import { curated, retrieve, estTokens as legacyEstTokens } from '../lib/context.ts';
import { MemoryError } from '../src/core/errors.ts';
import { terms, norm } from '../src/core/text.ts';
import type { ContextSource, MemoryProvider } from '../src/core/ports/context-source.ts';
import type { Hit } from '../src/core/domain/context.ts';
import type { Ctx, Found } from '../src/core/domain/memory.ts';

const CTX: Ctx = { projectId: 'p_fixture', sessionId: null, linked: [] };
const O = { budgetTokens: 400, minScore: 0, itemChars: 400 };
const NOW = Date.UTC(2026, 9, 6);
const DAY = 86400000;
function hit(id: string, values: Partial<Hit> = {}): Hit {
  return { source: 'curated', id, title: id, text: `${id} unique payload`, category: 'project', rank: -1, at: NOW, accessCount: 0, ...values };
}
function source(hits: Hit[], values: Partial<ContextSource> = {}): ContextSource {
  return { id: 'curated', trust: 'verified', weight: 1, halfLifeDays: 60, search: async () => hits, ...values };
}
function dependencies(values: Partial<ContextDependencies> = {}) {
  const metrics: ContextMeasurement[] = [];
  let ticks = 100;
  const deps: ContextDependencies = { now: () => NOW, monotonic: () => ticks++, hash: contentHash,
    dateLabel: (at) => new Date(at).toISOString().slice(0, 10), measure: (metric) => metrics.push(metric), ...values };
  return { deps, metrics };
}
const finiteError = (code: 'invalid' | 'unavailable') => (e: unknown) => e instanceof MemoryError && e.code === code
  && e.message === (code === 'invalid' ? 'invalid context request' : 'context unavailable');

test('context pipeline: exact hash and estimate forward identities retain normalized SHA-256 behavior', () => {
  assert.equal(legacyHash, contentHash); assert.equal(legacyEstTokens, estTokens);
  assert.equal(contentHash('  Title\n', 'BODY  words'), createHash('sha256').update(norm('  Title\n\nBODY  words')).digest('hex').slice(0, 32));
  assert.equal(contentHash('Title', 'Body words'), contentHash('TITLE', 'BODY   WORDS'));
});

test('context pipeline: deterministic injected dependencies, score, rendering, fractional dates and numeric metrics', async () => {
  const events: unknown[] = [];
  const f = dependencies({ hash(title, text) { events.push(['hash', title, text]); return contentHash(title, text); },
    dateLabel(at) { events.push(['day', at]); return new Date(at).toISOString().slice(0, 10); } });
  const at = Date.UTC(2026, 8, 1) + 0.875;
  const h = hit('m_1', { title: 'Title', text: 'line one\nline two\n\n- bullet', at });
  const r = await createRetrieveContext([source([h])], f.deps)('title', CTX, O);
  assert.equal(r.items[0].at, at);
  assert.equal(r.items[0].score, 1 + 0.3 * 2 ** (-(NOW - at) / DAY / 60));
  assert.equal(r.text, '[bosun memory: 1 note; memory_get <id> for details]\n- [curated project 2026-09-01 m_1] Title: line one line two - bullet');
  assert.deepEqual(r.sources, { curated: 1 }); assert.equal(r.ms, 1);
  assert.deepEqual(events, [['hash', 'Title', h.text], ['day', at]]);
  assert.deepEqual(f.metrics, [{ op: 'context.retrieve', ms: 1, n: 1, chars: r.text.length, estTokens: estTokens(r.text) }]);
  assert.ok(Object.entries(f.metrics[0]).every(([key, value]) => key === 'op' || typeof value === 'number' && Number.isFinite(value)));
});

test('context pipeline: source relevance, session half-life, usage, stable ties and source counts stay compatible', async () => {
  const f = dependencies();
  const input = [hit('weak-old', { rank: -2, at: NOW - DAY * 365 }), hit('strong-old', { rank: -10, at: NOW - DAY * 365 }),
    hit('weak-new', { rank: -2 }), hit('session-old', { category: 'session', rank: -2, at: NOW - DAY * 30 })];
  const r = await createRetrieveContext([source(input)], f.deps)('alpha beta', CTX, O);
  assert.deepEqual(r.items.map((h) => h.id), ['strong-old', 'weak-new', 'weak-old', 'session-old']);
  const tied = await createRetrieveContext([source([hit('first'), hit('second'), hit('used', { accessCount: 50 })]),
    source([hit('docs', { source: 'docs' })], { id: 'docs', weight: 0.8, halfLifeDays: 90 })], f.deps)('alpha', CTX, O);
  assert.deepEqual(tied.items.map((h) => h.id), ['used', 'first', 'second', 'docs']);
  assert.deepEqual(tied.sources, { curated: 3, docs: 1 });
});

test('context pipeline: supplied hash, fallback hash and Jaccard dedupe retain the highest stable score', async () => {
  let hashes = 0; const f = dependencies({ hash(title, text) { hashes++; return contentHash(title, text); } });
  const first = hit('first', { hash: 'same', text: 'one alpha' });
  const docs = source([hit('hash-dupe', { source: 'docs', hash: 'same', text: 'two beta' }),
    hit('word-dupe', { source: 'docs', title: 'first', text: 'one alpha!' }),
    hit('unique', { source: 'docs', text: 'three gamma' })], { id: 'docs', weight: 0.8 });
  const r = await createRetrieveContext([docs, source([first])], f.deps)('alpha beta', CTX, O);
  assert.deepEqual(r.items.map((h) => h.id), ['first', 'unique']); assert.equal(hashes, 2);
  const exact = await createRetrieveContext([source([hit('a', { title: 'Title', text: 'BODY' }), hit('b', { title: 'TITLE', text: 'body' })])], f.deps)('alpha', CTX, O);
  assert.deepEqual(exact.items.map((h) => h.id), ['a']);
});

test('context pipeline: real greedy token edges, one-character truncation, min score and empty terms', async () => {
  const f = dependencies(); const run = createRetrieveContext([source([hit('long', { text: 'large '.repeat(100), rank: -2 }), hit('short')])], f.deps);
  for (const budgetTokens of [0, 10, 16, 30, 100, 400]) {
    const r = await run('alpha', CTX, { ...O, budgetTokens });
    assert.ok(r.estTokens <= budgetTokens); assert.equal(r.estTokens, estTokens(r.text));
    assert.ok(r.text.split('\n').slice(1).every((line) => line.length <= O.itemChars));
  }
  const short = await run('alpha', CTX, { ...O, budgetTokens: 35 });
  assert.deepEqual(short.items.map((h) => h.id), ['short'], 'a smaller lower-score item can fit after the first is skipped');
  assert.equal((await run('alpha', CTX, { ...O, itemChars: 1 })).text.split('\n')[1], '…');
  assert.equal((await run('alpha', CTX, { ...O, minScore: 2 })).text, '');
  let called = 0;
  const empty = await createRetrieveContext([source([], { search: async () => { called++; return []; } })], f.deps)('the a of', CTX, O);
  assert.equal(called, 0); assert.deepEqual(empty, { items: [], text: '', estTokens: 0, sources: {}, ms: 1 });
  assert.equal(f.metrics.length, 9, 'the legacy empty-term fast path records no retrieval metric');
});

test('context pipeline: bounded large task query and matched term gating precede payload access', async () => {
  const f = dependencies(); const task = `fetchCart cart ${'alpha beta gamma '.repeat(4000)}`; let query = '';
  const omitted = hit('unavailable', { matched: 0 });
  Object.defineProperty(omitted, 'text', { get() { throw Error('PRIVATE skipped payload'); } });
  const run = createRetrieveContext([source([], { async search(text, caller, limit) {
    query = text; assert.deepEqual(caller, CTX); assert.equal(limit, 20);
    return [omitted, hit('matched', { matched: terms(task).length }), hit('uncounted')];
  } })], f.deps);
  assert.deepEqual((await run(task, CTX, { ...O, minMatched: 99 })).items.map((h) => h.id), ['matched', 'uncounted']);
  assert.equal(query, terms(task).join(' ')); assert.ok(query.length < 100); assert.ok(task.length > 50000);
});

test('context pipeline: disabled sources are skipped before callback or hit access; verified open IDs work', async () => {
  const f = dependencies();
  const skipped = ['unsupported', 'unverified'].map((trust) => ({ trust, get id() { throw Error('PRIVATE metadata'); }, get search() { throw Error('PRIVATE callback'); } }) as unknown as ContextSource);
  const r = await createRetrieveContext([...skipped, source([hit('graph', { source: 'graph-fixture' })], { id: 'graph-fixture' })], f.deps)('graph', CTX, O);
  assert.deepEqual(r.items.map((h) => h.id), ['graph']); assert.deepEqual(r.sources, { 'graph-fixture': 1 });
  const proto = await createRetrieveContext([source([hit('open-id', { source: '__proto__' })], { id: '__proto__' })], f.deps)('alpha', CTX, O);
  assert.equal(Object.getPrototypeOf(proto.sources), Object.prototype); assert.equal(Object.getOwnPropertyDescriptor(proto.sources, '__proto__')?.value, 1);
});

test('context pipeline: mismatched hit identity and undeclared throwing getters never expose content', async () => {
  let reads = 0; const f = dependencies();
  const denied = { source: 'new-source', get title() { reads++; throw Error('PRIVATE title'); }, get matched() { reads++; throw Error('PRIVATE count'); } } as unknown as Hit;
  const allowed = hit('allowed');
  for (const key of ['derivative', 'toJSON', 'private', 'secret']) Object.defineProperty(allowed, key, { enumerable: true, get() { reads++; throw Error('PRIVATE extras'); } });
  const r = await createRetrieveContext([source([denied, allowed])], f.deps)('alpha', CTX, O);
  assert.equal(reads, 0); assert.deepEqual(r.items.map((h) => h.id), ['allowed']); assert.equal(r.sources.curated, 2);
  assert.deepEqual(Object.keys(r.items[0]).sort(), ['source', 'id', 'title', 'text', 'category', 'rank', 'at', 'accessCount', 'score'].sort());
  assert.doesNotMatch(JSON.stringify(r), /PRIVATE|derivative|secret/);
  const explicit = await createRetrieveContext([source([hit('explicit', { hash: undefined, matched: undefined })])], f.deps)('alpha', CTX, O);
  assert.ok(Object.hasOwn(explicit.items[0], 'hash')); assert.ok(Object.hasOwn(explicit.items[0], 'matched'));
  assert.equal(explicit.items[0].hash, undefined); assert.equal(explicit.items[0].matched, undefined);
});

test('context pipeline: composition snapshots metadata, callbacks, dependencies and trusted caller scope', async () => {
  const f = dependencies(); const caller = { ...CTX, linked: ['p_linked'] };
  const adapter = source([], { async search(_text, ctx) {
    assert.equal(this, adapter); assert.notEqual(ctx, caller); assert.ok(Object.isFrozen(ctx)); assert.ok(Object.isFrozen(ctx.linked));
    await Promise.resolve(); assert.deepEqual(ctx.linked, ['p_linked']); return [hit('saved')];
  } });
  const run = createRetrieveContext([adapter], f.deps);
  Object.assign(adapter, { weight: 0, halfLifeDays: 0, id: 'changed' });
  adapter.search = async () => { throw Error('PRIVATE replaced source'); }; f.deps.hash = () => { throw Error('PRIVATE replaced hash'); };
  const pending = run('alpha', caller, O); caller.linked.push('new');
  const r = await pending; assert.equal(r.items[0].source, 'curated'); assert.equal(r.items[0].score, 1.3);
});

test('context pipeline: malformed options and trusted scope fail with finite errors before provider calls', async () => {
  let calls = 0; const run = createRetrieveContext([source([], { async search() { calls++; return []; } })], dependencies().deps);
  for (const bad of [{ ...O, budgetTokens: NaN }, { ...O, budgetTokens: -1 }, { ...O, minScore: Infinity },
    { ...O, itemChars: 0 }, { ...O, itemChars: 1.5 }, { ...O, minMatched: -1 }, { ...O, minMatched: Infinity }]) {
    await assert.rejects(run('alpha', CTX, bad), finiteError('invalid'));
  }
  for (const ctx of [{ ...CTX, projectId: 1 }, { ...CTX, linked: [''] }, { ...CTX, sessionId: '' }, { ...CTX, linked: null }, { ...CTX, source: '\0' }]) {
    await assert.rejects(run('alpha', ctx as Ctx, O), finiteError('invalid'));
  }
  await assert.rejects(run(null as never, CTX, O), finiteError('invalid')); assert.equal(calls, 0);
});

test('context pipeline: malformed verified metadata and dependency functions fail before callback acquisition', () => {
  const f = dependencies();
  for (const values of [{ weight: NaN }, { weight: -1 }, { halfLifeDays: 0 }, { halfLifeDays: Infinity }, { id: '' }, { trust: 'unknown' }]) {
    let reads = 0;
    const adapter = source([], values as Partial<ContextSource>);
    Object.defineProperty(adapter, 'search', { get() { reads++; throw Error('PRIVATE callback acquisition'); } });
    assert.throws(() => createRetrieveContext([adapter], f.deps), finiteError('invalid'));
    assert.equal(reads, 0, 'invalid metadata must precede callback acquisition');
  }
  assert.throws(() => createRetrieveContext([source([])], { ...f.deps, now: 1 } as never), finiteError('invalid'));
  assert.throws(() => createRetrieveContext([source([])], { ...f.deps, get measure(): ContextDependencies['measure'] { throw Error('PRIVATE sink acquisition'); } }), finiteError('invalid'));
});

test('context pipeline: nonfinite and malformed hit metadata fail without payload access or content-bearing errors', async () => {
  const f = dependencies();
  for (const values of [{ rank: NaN }, { rank: Infinity }, { at: NaN }, { at: 8640000000000001 }, { accessCount: -1 }, { accessCount: Infinity }, { matched: 0.5 }, { hash: 1 }]) {
    let reads = 0;
    const malformed = hit('bad', values as Partial<Hit>);
    Object.defineProperty(malformed, 'text', { get() { reads++; throw Error('PRIVATE body'); } });
    await assert.rejects(createRetrieveContext([source([malformed])], f.deps)('alpha', CTX, O), finiteError('unavailable'));
    assert.equal(reads, 0, 'invalid metadata must precede payload access');
  }
  await assert.rejects(createRetrieveContext([source([], { search: async () => null as never })], f.deps)('alpha', CTX, O), finiteError('unavailable'));
  await assert.rejects(createRetrieveContext([source([hit('bad', { text: 4 as never })])], f.deps)('alpha', CTX, O), finiteError('unavailable'));
});

test('context pipeline: excessive callback/source counts hold before returned hit payload getters', async () => {
  const f = dependencies(); let reads = 0;
  const excessive = Array.from({ length: 1001 }, () => hit('extra'));
  Object.defineProperty(excessive[0], 'source', { get() { reads++; throw Error('PRIVATE hit'); } });
  await assert.rejects(createRetrieveContext([source(excessive)], f.deps)('alpha', CTX, O), finiteError('unavailable'));
  assert.equal(reads, 0); assert.deepEqual(f.metrics, []);
  const allowed = createRetrieveContext(Array.from({ length: 64 }, () => source([])), f.deps);
  assert.deepEqual((await allowed('alpha', CTX, O)).items, []);
  assert.throws(() => createRetrieveContext(Array.from({ length: 65 }, () => source([])), f.deps), finiteError('invalid'));
});

test('context pipeline: timing and sink failures preserve completed results and exact provider-domain errors', async () => {
  const error = new MemoryError('conflict', 'PRIVATE provider message', 17);
  for (const monotonic of [() => NaN, () => Infinity, () => -1, () => { throw Error('PRIVATE timing'); }, (() => { let tick = 2; return () => tick--; })()]) {
    const run = createRetrieveContext([source([hit('good')])], dependencies({ monotonic, measure() { throw Error('PRIVATE sink'); } }).deps);
    const r = await run('alpha', CTX, O); assert.equal(r.ms, 0); assert.deepEqual(r.items.map((h) => h.id), ['good']);
  }
  let ticks = 0; let metrics: ContextMeasurement | undefined;
  const r = await createRetrieveContext([source([hit('good')])], dependencies({ monotonic() { if (++ticks === 1) throw Error('start'); return 50; }, measure(m) { metrics = m; } }).deps)('alpha', CTX, O);
  assert.equal(r.ms, 0); assert.equal(metrics?.ms, 0);
  await assert.rejects(createRetrieveContext([source([], { async search() { throw error; } })], dependencies({
    now() { throw Error('PRIVATE semantic clock'); }, monotonic() { throw Error('PRIVATE timing'); }, measure() { throw Error('PRIVATE sink'); },
  }).deps)('alpha', CTX, O), (e) => e === error);
});

test('context pipeline: semantic clock, hash and day failures hold output with finite errors', async () => {
  for (const value of [NaN, Infinity, -1, 8640000000000001]) {
    await assert.rejects(createRetrieveContext([source([hit('good')])], dependencies({ now: () => value }).deps)('alpha', CTX, O), finiteError('unavailable'));
  }
  for (const values of [{ now() { throw Error('PRIVATE clock'); } }, { hash() { throw Error('PRIVATE hash'); } },
    { hash: () => 123 as never }, { dateLabel() { throw Error('PRIVATE date'); } }, { dateLabel: () => 'PRIVATE arbitrary label' }]) {
    const f = dependencies(values); await assert.rejects(createRetrieveContext([source([hit('good')])], f.deps)('alpha', CTX, O), finiteError('unavailable'));
    assert.deepEqual(f.metrics, []);
  }
  const f = dependencies();
  for (const at of [-1.75, 8640000000000000]) {
    const r = await createRetrieveContext([source([hit('date', { at })])], f.deps)('alpha', CTX, O);
    assert.ok(r.text.includes(new Date(at).toISOString().slice(0, 10)));
  }
});

test('context pipeline: real legacy delegation retains fixed metadata, receiver and denies new/prototype names before search', async () => {
  const sb = sandbox();
  try {
    fresh(sb); let reads = 0;
    const providers = ['graph', 'new-source', '__proto__', 'toString'].map((name) => ({ name, get search() { reads++; throw Error('PRIVATE unreviewed callback'); } }));
    const known: MemoryProvider & { weight: number; trust: string } = { name: 'curated', weight: 0, trust: 'unsupported', async search(_text, _ctx, limit) {
      assert.equal(this, known); assert.equal(limit, 20); return [hit('good')];
    } };
    const r = await retrieve('alpha', [...providers, known] as MemoryProvider[], CTX, O);
    assert.equal(reads, 0); assert.deepEqual(r.items.map((h) => h.id), ['good']); assert.deepEqual(r.sources, { curated: 1 });
    assert.ok(r.items[0].score > 1.29, 'legacy providers cannot replace reviewed weight/trust metadata');
    const saved = fs.readFileSync(path.join(sb.home, '.bosun', 'metrics.jsonl'), 'utf8');
    assert.match(saved, /context.retrieve/); assert.doesNotMatch(saved, /good|unique|PRIVATE/);
  } finally { sb.cleanup(); }
});

test('context pipeline: actual curated delegation denies records before all metadata/body getters', async () => {
  const sb = sandbox();
  try {
    fresh(sb); let reads = 0;
    const denied = { private: true };
    for (const key of ['id', 'title', 'body', 'updatedAt', 'category', 'rank', 'accessCount', 'hash', 'matched']) Object.defineProperty(denied, key, { enumerable: true, get() { reads++; throw Error('PRIVATE record'); } });
    const r = await retrieve('alpha', [curated({ async search(q) { assert.equal(q.includePrivate, false); return [denied] as Found[]; } })], CTX, O);
    assert.equal(reads, 0); assert.equal(r.text, ''); assert.deepEqual(r.sources, { curated: 0 });
  } finally { sb.cleanup(); }
});

test('context pipeline: direct import and use tolerate unusable ambient HOME/config/clocks with no effects', () => {
  const sb = sandbox();
  try {
    const unusable = path.join(sb.root, 'unusable-config'); fs.writeFileSync(unusable, 'PRIVATE unchanged');
    const program = `
      const saved=process.env; process.env=new Proxy(saved,{get(target,key){if(['HOME','BOSUN_HOME','MEMORY_URL'].includes(key))throw Error('PRIVATE config');return target[key];}});
      Object.defineProperty(globalThis,'Date',{get(){throw Error('PRIVATE ambient date');}});
      Object.defineProperty(globalThis,'performance',{get(){throw Error('PRIVATE ambient timer');}});
      const {createRetrieveContext}=await import(${JSON.stringify(path.join(REPO, 'src/core/use-cases/retrieve-context.ts'))});
      const retrieve=createRetrieveContext([{id:'curated',trust:'verified',weight:1,halfLifeDays:60,search:async()=>[${JSON.stringify(hit('direct'))}]}],
        {now:()=>${NOW},monotonic:()=>0,hash:()=> 'saved-hash',dateLabel:()=> '2026-10-06',measure(){throw Error('PRIVATE sink');}});
      const result=await retrieve('alpha',${JSON.stringify(CTX)},${JSON.stringify(O)});process.stdout.write(JSON.stringify(result.items.map(h=>h.id)));
    `;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', program], { env: sb.env({ BOSUN_HOME: unusable, MEMORY_URL: 'PRIVATE invalid' }), cwd: sb.root, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); assert.deepEqual(JSON.parse(r.stdout), ['direct']);
    assert.equal(fs.readFileSync(unusable, 'utf8'), 'PRIVATE unchanged'); assert.deepEqual(sb.calls(), []);
    assert.equal(fs.existsSync(path.join(sb.home, '.bosun')), false);
  } finally { sb.cleanup(); }
});
