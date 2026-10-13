import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { SqliteDatabase } from '../src/platform/sqlite.ts';
import { sandbox, fresh, gitRepo, REPO } from './helpers.ts';
import { memoryEvaluationFixture } from './memory-evaluation-fixture.ts';
import { memoryEvaluationDataset } from '../src/contracts/memory-evaluation.ts';
import { runMemoryEvaluation } from '../src/app/memory-evaluation.ts';
import {
  evaluateMemoryComparisons,
  evaluateMemory,
  memoryEvaluationMetrics,
  MEMORY_EVAL_PACK,
} from '../src/core/use-cases/evaluate-memory.ts';
import { main } from '../src/app/cli.ts';
import { setupRuntime } from '../src/app/setup.ts';
import { defaultConfig } from '../src/core/domain/config.ts';
import { runtimePaths } from '../src/platform/paths.ts';
import { DaemonOwner } from '../src/platform/daemon-owner.ts';
import { openDaemonMemory } from '../src/app/memory.ts';
import { terms } from '../src/core/text.ts';
import { contentHash } from '../src/platform/content-hash.ts';
import { createCuratedSource } from '../src/core/memory-source.ts';
import { createRetrieveContext } from '../src/core/use-cases/retrieve-context.ts';
import { footprint } from './read-view-prototype.ts';

const privateInput = (e: unknown) => (e as { code?: string }).code === 'private_input';
const invalid = (e: unknown) => (e as { code?: string }).code === 'invalid';

test('memory fixture is synthetic, exact100/20/80, grouped and contains20 negative queries', () => {
  const dataset = memoryEvaluationDataset(memoryEvaluationFixture());
  assert.equal(dataset.evidence, 'synthetic');
  assert.equal(dataset.cases.filter((c) => c.split === 'development').length, 20);
  assert.equal(dataset.cases.filter((c) => c.split === 'heldout').length, 80);
  assert.equal(dataset.cases.filter((c) => !c.supports.length).length, 20);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(REPO, 'test/fixtures/memory-eval.json'), 'utf8')),
    dataset,
  );
});

test('all public classifications precede any export/query/label payload getters', () => {
  for (const where of ['notes', 'cases'] as const) {
    const input = memoryEvaluationFixture();
    Object.defineProperty(input.notes[0], 'title', {
      get() {
        throw Error('public payload read too early');
      },
    });
    Object.defineProperty(input.cases[0], 'query', {
      get() {
        throw Error('query read too early');
      },
    });
    Object.defineProperty(input.cases[0], 'supports', {
      get() {
        throw Error('label read too early');
      },
    });
    Object.defineProperty(input[where].at(-1)!, 'privacy', { value: 'private' });
    assert.throws(() => memoryEvaluationDataset(input), privateInput);
  }
  const input = memoryEvaluationFixture();
  Object.defineProperty(input.notes[0], 'privacy', {
    get() {
      throw Error('classification getter');
    },
  });
  assert.throws(() => memoryEvaluationDataset(input), privateInput);
});

test('closed dataset rejects split leakage, duplicate queries/IDs, hidden or invalid support and extra fields', () => {
  const changes = [
    (d: ReturnType<typeof memoryEvaluationFixture>) => {
      d.cases[20].sourceGroup = d.cases[0].sourceGroup;
    },
    (d: ReturnType<typeof memoryEvaluationFixture>) => {
      d.cases[20].sessionGroup = d.cases[0].sessionGroup;
    },
    (d: ReturnType<typeof memoryEvaluationFixture>) => {
      d.cases[20].query = d.cases[0].query;
    },
    (d: ReturnType<typeof memoryEvaluationFixture>) => {
      d.notes[1].id = d.notes[0].id;
    },
    (d: ReturnType<typeof memoryEvaluationFixture>) => {
      d.cases[20].supports[0].id = 'm_unknown';
    },
    (d: ReturnType<typeof memoryEvaluationFixture>) => {
      d.cases[20].supports[0].quote = 'unsupported evidence';
    },
    (d: ReturnType<typeof memoryEvaluationFixture>) => {
      d.cases[20].supports = [];
    },
    (d: ReturnType<typeof memoryEvaluationFixture>) => {
      Object.assign(d.notes[0], { private: false, extra: 'provider content' });
    },
  ];
  for (const change of changes) {
    const d = memoryEvaluationFixture();
    change(d);
    assert.throws(() => memoryEvaluationDataset(d), invalid);
  }
  const secret = memoryEvaluationFixture();
  secret.notes[0].body += ' api_key=' + 'x'.repeat(40);
  assert.throws(() => memoryEvaluationDataset(secret), privateInput);
});

test('quality denominator retains missed positive labels and separately counts negative injections', () => {
  const task = memoryEvaluationFixture().cases[0],
    id = task.supports[0].id;
  const sample = (hit: boolean) => ({
    task,
    rawIds: hit ? [id] : [],
    packedIds: hit ? [id] : [],
    visibleSupportIds: hit ? [id] : [],
    truncatedSupportIds: [],
    estimatedTokens: 30,
    searchMs: 1,
    packingMs: 2,
  });
  const scored = memoryEvaluationMetrics([sample(true), sample(true), sample(false)]);
  assert.equal(scored.recallAt5, 2 / 3);
  assert.equal(scored.mrrAt20, 2 / 3);
  assert.equal(scored.packedEvidenceRecall, 2 / 3);
  const withNegative = memoryEvaluationMetrics([
    sample(true),
    { ...sample(true), task: { ...task, supports: [] } },
  ]);
  assert.equal(withNegative.negativeInjectionRate, 1);
  assert.equal(withNegative.packedPrecision, 0.5);
});

test('actual final runtime evaluates100 permitted queries, original IDs and real packing without owner writes/models', async () => {
  const sb = sandbox();
  fresh(sb);
  try {
    const home = path.join(sb.home, '.bosun');
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, 'memory.db'), 'OWNER DATABASE MUST NOT OPEN');
    fs.writeFileSync(path.join(home, 'config.toml'), 'OWNER CONFIG MUST NOT READ');
    const before = footprint(home);
    const report = await runMemoryEvaluation({
      input: memoryEvaluationFixture(),
      env: sb.env({ MEMORY_URL: 'http://owner.invalid' }),
    });
    assert.deepEqual(footprint(home), before);
    assert.equal(report.arms.A.heldout.queries, 80);
    assert.equal(report.arms.A.heldout.positive, 64);
    assert.equal(report.arms.A.heldout.recallAt5, 1);
    assert.equal(report.arms.A.heldout.packedEvidenceRecall, 1);
    assert.equal(report.arms.A.heldout.packedPrecision, 1);
    assert.equal(report.arms.A.heldout.negativeInjectionRate, 0);
    assert.equal(report.arms.A.heldout.tokens.overBudget, 0);
    assert.ok(report.arms.A.heldout.tokens.maximumEstimate <= 400);
    assert.equal(report.cases[20].packedIds[0], 'm_eval2');
    assert.equal(report.activation.qualified, false);
    assert.equal(report.activation.status, 'held');
    assert.equal(report.arms.B.status, 'measured');
    assert.equal(report.comparisons.BvsA!.groups, 8);
    assert.equal(report.comparisons.BvsA!.packedEvidenceRecallDelta.mean, 0);
    assert.equal(report.arms.C.status, 'measured');
    assert.equal(report.comparisons.CvsA!.packedEvidenceRecallDelta.mean, 0);
    assert.equal(report.ownerStorageOpened, false);
    assert.equal(report.modelsCalled, false);
    assert.doesNotMatch(
      JSON.stringify(report),
      /OWNER|owner\.invalid|uses pnpm for reproducible|question/,
    );
    assert.deepEqual(sb.calls(), []);
  } finally {
    sb.cleanup();
  }
});

test('raw recall cannot hide a missed query or evidence removed by actual item truncation', async () => {
  const sb = sandbox();
  fresh(sb);
  try {
    const input = memoryEvaluationFixture();
    input.notes[2].body += ' ' + 'padding '.repeat(65) + 'Final supported decision.';
    input.cases[20].supports[0].quote = 'Final supported decision.';
    input.cases[20].supports[0].alternatives = [];
    input.cases[21].query = 'unmatchednovel querynotstored';
    const report = await runMemoryEvaluation({ input, env: sb.env() });
    const held = report.arms.A.heldout;
    assert.equal(held.recallAt5, 63 / 64);
    assert.equal(held.mrrAt20, 63 / 64);
    assert.equal(held.packedEvidenceRecall, 62 / 64);
    assert.equal(held.supportsLostToTruncation, 1);
    assert.deepEqual(report.cases[20].truncatedSupportIds, ['m_eval2']);
    assert.deepEqual(report.cases[20].visibleSupportIds, []);
  } finally {
    sb.cleanup();
  }
});

test('final CLI requires public approval and a pinned workspace JSON; rejects escaped/symlinked sources', async () => {
  const sb = sandbox();
  fresh(sb);
  try {
    const workspace = gitRepo(sb, 'evaluation');
    fs.writeFileSync(
      path.join(workspace, 'public.json'),
      JSON.stringify(memoryEvaluationFixture()),
    );
    fs.symlinkSync(path.join(workspace, 'public.json'), path.join(workspace, 'linked.json'));
    const cli = async (args: string[]) => {
      let out = '',
        err = '';
      const code = await main(args, {
        env: sb.env(),
        cwd: workspace,
        stdout: (s) => (out += s),
        stderr: (s) => (err += s),
      });
      return { code, out, err };
    };
    for (const args of [
      ['memory', 'eval', 'public.json'],
      ['memory', 'eval', '../public.json', '--public'],
      ['memory', 'eval', 'linked.json', '--public'],
    ])
      assert.notEqual((await cli(args)).code, 0);
    const result = await cli(['memory', 'eval', 'public.json', '--public']);
    assert.equal(result.code, 0, result.err);
    assert.match(JSON.parse(result.out).sha256, /^[a-f0-9]{64}$/);
    assert.equal(JSON.parse(result.out).arms.A.heldout.queries, 80);
    assert.ok(!fs.existsSync(path.join(sb.home, '.bosun')));
  } finally {
    sb.cleanup();
  }
});

test('changed source aborts evaluation without reading owner state or retrying callbacks', async () => {
  const sb = sandbox();
  fresh(sb);
  try {
    let checks = 0;
    await assert.rejects(
      runMemoryEvaluation({
        input: memoryEvaluationFixture(),
        env: sb.env(),
        valid: () => ++checks < 4,
      }),
      (e: unknown) => ['conflict', 'unavailable'].includes((e as { code?: string }).code ?? ''),
    );
    assert.equal(checks, 4);
    assert.ok(!fs.existsSync(path.join(sb.home, '.bosun')));
  } finally {
    sb.cleanup();
  }
});

test('native evaluation policy canaries remain excluded; reads preserve floor, files and original private audit', async () => {
  const sb = sandbox();
  fresh(sb);
  const home = path.join(sb.root, 'eval-runtime'),
    paths = runtimePaths(sb.env({ BOSUN_HOME: home }));
  await setupRuntime(paths, defaultConfig());
  const owner = new DaemonOwner(paths.owner),
    dataset = memoryEvaluationDataset(memoryEvaluationFixture());
  let nextId = '',
    now = dataset.capturedAt;
  const clock = {
    now: () => now,
    monotonic: () => performance.now(),
    hash: contentHash,
    dateLabel: (at: number) => new Date(at).toISOString().slice(0, 10),
    measure() {},
  };
  const runtime = openDaemonMemory({
    paths: { primary: paths.memory, view: paths.view, backups: paths.backups },
    assertOwner: () => owner.assert(),
    memory: { ...clock, id: () => nextId, retention: { sessionTtlDays: 7, purgeAfterDays: 90 } },
    context: clock,
    docsIndex: { monotonic: clock.monotonic, measure() {} },
    publicationId: crypto.randomUUID,
  });
  let observer: SqliteDatabase | undefined;
  try {
    for (const note of dataset.notes) {
      nextId = note.id;
      await runtime.memory.store(
        { category: note.category, title: note.title, body: note.body },
        { ...note.scope, linked: [], audience: 'owner' },
      );
    }
    const ctx = { ...dataset.cases[20].scope, linked: [], audience: 'owner' as const };
    for (const kind of ['private', 'foreign', 'expired', 'archived', 'purged']) {
      nextId = `m_canary${kind}`;
      if (kind === 'expired') now -= 2 * 86400000;
      const caller = kind === 'foreign' ? { ...ctx, projectId: 'p_ffffffffffffffff' } : ctx;
      const m = (
        await runtime.memory.store(
          {
            category: kind === 'expired' ? 'session' : 'project',
            title: `Forbidden ${kind}`,
            body: 'canary distinctive evidence',
            private: kind === 'private',
            ...(kind === 'expired' ? { ttlDays: 1 } : {}),
          },
          caller,
        )
      ).memory;
      now = dataset.capturedAt;
      if (kind === 'archived' || kind === 'purged') await runtime.memory.delete(m.id, caller);
      if (kind === 'purged') await runtime.memory.purge(m.id, caller);
    }
    observer = new SqliteDatabase(paths.memory, { readOnly: true });
    const generation = observer
      .prepare('SELECT generation FROM bosun_source_floor')
      .get()!.generation;
    const privateBefore = await runtime.memory.get('m_canaryprivate', ctx, { events: true });
    const filesSnapshot = () => [
      Object.fromEntries(
        ['', '-wal', '-shm']
          .filter((suffix) => fs.existsSync(paths.memory + suffix))
          .map((suffix) => {
            const file = paths.memory + suffix,
              stat = fs.statSync(file, { bigint: true });
            return [
              suffix,
              {
                hash: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
                size: String(stat.size),
                mtime: String(stat.mtimeNs),
                ctime: String(stat.ctimeNs),
              },
            ];
          }),
      ),
      footprint(path.dirname(paths.view)),
      footprint(paths.backups),
    ];
    const files = filesSnapshot();
    const retrieve = createRetrieveContext([createCuratedSource(runtime.memory)], clock);
    const publicCtx = { ...ctx, audience: 'model' as const };
    assert.equal(
      (
        await runtime.memory.search(
          { text: 'canary distinctive', includePrivate: false, touch: false },
          publicCtx,
        )
      ).length,
      0,
    );
    assert.equal(
      (await retrieve('canary distinctive', publicCtx, MEMORY_EVAL_PACK)).items.length,
      0,
    );
    assert.deepEqual(await runtime.lexical.search('canary distinctive', publicCtx, 20), []);
    await evaluateMemory(dataset, runtime.memory, retrieve, clock.monotonic);
    assert.equal(
      observer.prepare('SELECT generation FROM bosun_source_floor').get()!.generation,
      generation,
    );
    assert.deepEqual(
      await runtime.memory.get('m_canaryprivate', ctx, { events: true }),
      privateBefore,
    );
    assert.deepEqual(filesSnapshot(), files);
    const purged = observer
      .prepare('SELECT op FROM memory_events WHERE memory_id=? ORDER BY id')
      .all('m_canarypurged');
    assert.deepEqual(
      purged.map((r) => r.op),
      ['store', 'archive', 'purge'],
    );
  } finally {
    observer?.close();
    await runtime.close();
    owner.close();
    sb.cleanup();
  }
});

test('standalone guarded memory evaluation implements the roadmap FTS interface', () => {
  const sb = sandbox();
  fresh(sb);
  try {
    const child = spawnSync(
      process.execPath,
      [
        path.join(REPO, 'scripts/eval-memory.mts'),
        '--fixture',
        'test/fixtures/memory-eval.json',
        '--baseline',
        'fts',
      ],
      { cwd: sb.root, env: sb.env(), encoding: 'utf8', timeout: 30000 },
    );
    assert.equal(child.status, 0, child.stderr);
    const report = JSON.parse(child.stdout);
    assert.equal(report.arms.A.heldout.queries, 80);
    assert.equal(report.activation.qualified, false);
    assert.equal(report.modelsCalled, false);
  } finally {
    sb.cleanup();
  }
});

test('A/B/C comparisons share labels, do not double-count graph alternatives and keep zero-gain graph held', async () => {
  const sb = sandbox();
  fresh(sb);
  try {
    const report = await runMemoryEvaluation({ input: memoryEvaluationFixture(), env: sb.env() });
    assert.equal(report.arms.B.status, 'measured');
    assert.equal(report.arms.C.status, 'measured');
    if (report.arms.C.status !== 'measured') throw Error('graph arm missing');
    assert.equal(report.arms.C.heldout.recallAt5, 1);
    assert.equal(report.arms.C.heldout.packedEvidenceRecall, 1);
    assert.equal(report.arms.C.heldout.gradedEvidenceRecall, 1);
    assert.equal(report.comparisons.CvsA!.recallAt5Delta.mean, 0);
    assert.deepEqual(report.comparisons.CvsA!.recallAt5Delta.interval95, { lower: 0, upper: 0 });
    assert.equal(report.activation.metricsPass, false);
    assert.equal(report.activation.qualified, false);
    assert.ok(report.activation.metricFailures.includes('raw-recall-vs-A'));
  } finally {
    sb.cleanup();
  }
});

test('reviewed one-hop link supplies a distinct supported source missed by FTS/aliases, with paired uncertainty and no activation', async () => {
  const sb = sandbox();
  fresh(sb);
  try {
    const input = memoryEvaluationFixture(),
      base = input.notes[2],
      quote = 'Required lockfile verification precedes deployment.';
    input.notes.push({
      ...base,
      id: 'm_target2',
      title: 'Verification details',
      body: quote,
      tags: [],
    });
    input.graph!.push(
      {
        privacy: 'public',
        reviewed: true,
        id: 'g_target2',
        sourceGroup: base.sourceGroup,
        sessionGroup: base.sessionGroup,
        scope: base.scope,
        kind: 'entity',
        title: 'Verification details',
        text: quote,
        supports: [{ id: 'm_target2', quote }],
        entity: { type: 'concept', key: 'verification detail', aliases: [] },
      },
      {
        privacy: 'public',
        reviewed: true,
        id: 'g_edge2',
        sourceGroup: base.sourceGroup,
        sessionGroup: base.sessionGroup,
        scope: base.scope,
        kind: 'relation',
        title: 'Approved dependency',
        text: 'Operations require verification.',
        supports: [
          { id: base.id, quote: 'uses pnpm for reproducible builds' },
          { id: 'm_target2', quote },
        ],
        relation: { from: 'g_eval2', to: 'g_target2', predicate: 'depends_on', weight: 1 },
      },
    );
    input.cases[22].query = 'launchtool2 relationship question';
    input.cases[22].category = 'relationship';
    input.cases[22].supports = [
      { id: 'm_target2', grade: 3, quote, alternatives: [{ id: 'g_target2', quote }] },
    ];
    const report = await runMemoryEvaluation({ input, env: sb.env() });
    assert.equal(report.arms.B.status, 'measured');
    assert.equal(report.arms.C.status, 'measured');
    if (report.arms.B.status !== 'measured' || report.arms.C.status !== 'measured')
      throw Error('comparison missing');
    assert.equal(report.arms.A.heldout.recallAt5, 63 / 64);
    assert.equal(report.arms.B.heldout.packedEvidenceRecall, 63 / 64);
    assert.equal(report.arms.C.heldout.packedEvidenceRecall, 1);
    assert.ok(report.arms.C.cases[22].visibleSupportIds.includes('m_target2'));
    assert.ok(report.arms.C.cases[22].zeroOverlapGraphIds!.includes('g_target2'));
    assert.equal(report.comparisons.CvsB!.recallAt5Delta.mean, 1 / 64);
    assert.equal(report.comparisons.CvsB!.groups, 8);
    assert.equal(report.comparisons.CvsB!.recallAt5Delta.interval95!.lower, 0);
    assert.equal(report.activation.qualified, false);
    assert.equal(report.activation.metricsPass, false);
    assert.equal(report.modelsCalled, false);
  } finally {
    sb.cleanup();
  }
});

test('graph export preflight rejects private/unreviewed graph, forged alternative citations and cross-source links before effects', () => {
  const privateGraph = memoryEvaluationFixture();
  Object.defineProperty(privateGraph.notes[0], 'title', {
    get() {
      throw Error('payload before graph classification');
    },
  });
  Object.defineProperty(privateGraph.graph!.at(-1)!, 'privacy', { value: 'private' });
  assert.throws(() => memoryEvaluationDataset(privateGraph), privateInput);
  for (const edit of [
    (d: ReturnType<typeof memoryEvaluationFixture>) => {
      Object.defineProperty(d.graph![0], 'reviewed', { value: false });
    },
    (d: ReturnType<typeof memoryEvaluationFixture>) => {
      d.graph![0].supports[0].quote = 'unsupported quote';
    },
    (d: ReturnType<typeof memoryEvaluationFixture>) => {
      d.cases[0].supports[0].alternatives![0].id = 'g_eval1';
    },
    (d: ReturnType<typeof memoryEvaluationFixture>) => {
      d.cases[0].supports[0].alternatives![0].quote = 'unsupported graph quote';
    },
    (d: ReturnType<typeof memoryEvaluationFixture>) => {
      d.graph![0].sourceGroup = 'foreign';
    },
  ]) {
    const d = memoryEvaluationFixture();
    edit(d);
    assert.throws(() => memoryEvaluationDataset(d), invalid);
  }
});

test('near-ceiling gate requires measured miss reduction and still holds synthetic/host qualification', async () => {
  const dataset = memoryEvaluationDataset(memoryEvaluationFixture());
  const byQuery = new Map(dataset.cases.map((task) => [terms(task.query).join(' '), task]));
  const notes = new Map(dataset.notes.map((note) => [note.id, note]));
  const clock = {
    now: () => dataset.capturedAt,
    monotonic: () => performance.now(),
    hash: contentHash,
    dateLabel: (at: number) => new Date(at).toISOString().slice(0, 10),
    measure() {},
  };
  const make = (miss: boolean) => {
    const source = {
      id: 'curated',
      trust: 'verified' as const,
      weight: 1,
      halfLifeDays: 60,
      async search(query: string) {
        const task = byQuery.get(terms(query).join(' '))!;
        if (!task.supports.length || (miss && /^q_[2-6]_3$/.test(task.id))) return [];
        const note = notes.get(task.supports[0].id)!;
        return [
          {
            source: 'curated',
            id: note.id,
            title: note.title,
            text: note.body,
            category: note.category,
            rank: -1,
            at: dataset.capturedAt,
            accessCount: 0,
            hash: contentHash(note.title, note.body),
            matched: 2,
          },
        ];
      },
    };
    return {
      raw: (text: string) => source.search(text),
      retrieve: createRetrieveContext([source], clock),
    };
  };
  const report = await evaluateMemoryComparisons(
    dataset,
    { A: make(true), B: make(true), C: make(false) },
    clock.monotonic,
  );
  assert.equal(report.arms.A.heldout.recallAt5, 59 / 64);
  assert.equal(report.comparisons.CvsA!.recallAt5Delta.mean, 5 / 64);
  assert.ok(report.comparisons.CvsA!.recallAt5Delta.mean < 0.08);
  assert.equal(report.comparisons.CvsA!.rawMissedSupports.reduction, 1);
  assert.ok(report.comparisons.CvsA!.recallAt5Delta.interval95!.lower > 0);
  assert.equal(report.activation.metricsPass, true);
  assert.deepEqual(report.activation.metricFailures, []);
  assert.equal(report.activation.qualified, false);
  assert.equal(report.activation.status, 'held');
});
