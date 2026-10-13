import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runtimeFixture } from './runtime-fixture.ts';
import { sandbox, fresh, REPO } from './helpers.ts';
import { footprint } from './read-view-prototype.ts';
import { memoryEvaluationFixture } from './memory-evaluation-fixture.ts';
import { runMemoryEvaluation } from '../src/app/memory-evaluation.ts';
import { memoryEvaluationDataset } from '../src/contracts/memory-evaluation.ts';
import type { GraphArtifact } from '../src/core/domain/graph.ts';
import type { Memory } from '../src/core/domain/memory.ts';

function overviewFixture() {
  const input = memoryEvaluationFixture(),
    base = input.notes[2],
    quote = 'Source maintenance requires an owner review window.';
  input.notes.push({
    ...base,
    id: 'm_overview2',
    title: 'Maintenance detail',
    body: quote,
    tags: [],
  });
  const supports = [
    { id: base.id, quote: 'uses pnpm for reproducible builds' },
    { id: 'm_overview2', quote },
  ];
  input.graph!.push(
    {
      privacy: 'public',
      reviewed: true,
      id: 'g_summary2',
      kind: 'summary',
      sourceGroup: base.sourceGroup,
      sessionGroup: base.sessionGroup,
      scope: base.scope,
      title: 'releaseoverview2 preferred workflow',
      text: quote,
      supports,
      parents: ['g_eval2'],
    },
    {
      privacy: 'public',
      reviewed: true,
      id: 'g_profile2',
      kind: 'profile',
      sourceGroup: base.sourceGroup,
      sessionGroup: base.sessionGroup,
      scope: base.scope,
      title: 'releaseoverview2 reviewed preference',
      text: quote,
      supports,
      parents: ['g_summary2'],
    },
  );
  input.cases[26].query = 'releaseoverview2 preferred workflow';
  input.cases[26].supports = [
    {
      id: 'm_overview2',
      grade: 3,
      quote,
      alternatives: [
        { id: 'g_summary2', quote },
        { id: 'g_profile2', quote },
      ],
    },
  ];
  return input;
}

test('native L3/L4 overview is explicit, keeps current parent lineage and revokes with original source privacy', async () => {
  const f = await runtimeFixture();
  try {
    const m = (
      await f.rpc<{ memory: Memory }>('memory.store', {
        category: 'project',
        title: 'Skywave decision',
        body: 'Skywave uses owner-reviewed maintenance windows.',
      })
    ).memory;
    const review = async (input: Record<string, unknown>) => {
      const proposal = (await f.rpc<{ artifact: GraphArtifact }>('graph.create', input)).artifact;
      return (
        await f.rpc<{ artifact: GraphArtifact }>('graph.review', {
          id: proposal.id,
          expectedVersion: proposal.version,
          action: 'accept',
        })
      ).artifact;
    };
    const supports = [{ memoryId: m.id, version: m.version, hash: m.hash }];
    const node = await review({
      kind: 'entity',
      title: 'Skywave source',
      text: 'Reviewed Skywave source',
      supports,
      entity: { type: 'concept', key: 'skywave', aliases: [] },
    });
    const summary = await review({
      kind: 'summary',
      title: 'Skywave broad summary',
      text: 'Skywave uses owner-reviewed maintenance windows.',
      supports,
      parents: [{ id: node.id, version: node.version }],
    });
    const profile = await review({
      kind: 'profile',
      title: 'Skywave reviewed preference',
      text: 'Skywave uses owner-reviewed maintenance windows.',
      supports,
      parents: [{ id: summary.id, version: summary.version }],
    });
    const ordinary = await f.rpc<{ ids: string[] }>('context.retrieve', {
      task: 'Skywave broad summary',
    });
    assert.ok(!ordinary.ids.includes(summary.id) && !ordinary.ids.includes(profile.id));
    const c = await f.rpc<{ ids: string[] }>('context.retrieve', {
      task: 'Skywave broad summary',
      sources: ['graph'],
    });
    assert.ok(!c.ids.includes(summary.id) && !c.ids.includes(profile.id));
    const e = await f.rpc<{ ids: string[]; text: string }>('context.retrieve', {
      task: 'Skywave broad summary',
      sources: ['overview'],
    });
    assert.ok(e.ids.includes(summary.id) || e.ids.includes(profile.id));
    assert.match(e.text, /owner-reviewed maintenance windows/);
    await f.rpc('memory.update', { id: m.id, expectedVersion: 1, patch: { private: true } });
    const revoked = await f.rpc<{ ids: string[]; text: string }>('context.retrieve', {
      task: 'Skywave broad summary',
      sources: ['overview'],
    });
    assert.deepEqual(revoked.ids, []);
    assert.equal(revoked.text, '');
    assert.equal(
      (await f.rpc<{ memory: Memory }>('memory.get', { id: m.id })).memory.private,
      true,
    );
    assert.equal(f.calls(), 0);
  } finally {
    await f.close();
  }
});

test('E independently measures reviewed summaries/profiles over C, preserving original quotes and holding weak gain', async () => {
  const sb = sandbox();
  fresh(sb);
  try {
    const input = overviewFixture();
    memoryEvaluationDataset(input);
    const r = await runMemoryEvaluation({ input, env: sb.env() });
    assert.equal(r.arms.C.status, 'measured');
    assert.equal(r.arms.E.status, 'measured');
    if (r.arms.C.status !== 'measured' || r.arms.E.status !== 'measured')
      throw Error('arm missing');
    assert.equal(r.arms.C.heldout.packedEvidenceRecall, 63 / 64);
    assert.equal(r.arms.E.heldout.packedEvidenceRecall, 1);
    assert.deepEqual(r.arms.E.cases[26].visibleSupportIds, ['m_overview2']);
    assert.equal(r.comparisons.EvsC!.packedEvidenceRecallDelta.mean, 1 / 64);
    assert.equal(r.comparisons.EvsC!.packedEvidenceRecallDelta.interval95!.lower, 0);
    assert.equal(r.incremental.E.qualified, false);
    assert.equal(r.incremental.E.metricsPass, false);
    assert.equal(r.modelsCalled, false);
    const bad = overviewFixture();
    bad.graph!.at(-1)!.parents = ['g_unknown'];
    assert.throws(() => memoryEvaluationDataset(bad));
  } finally {
    sb.cleanup();
  }
});

test('actual MCP stdio evaluates the same100-case E corpus with separate budget and no owner footprint/models', async () => {
  const sb = sandbox();
  fresh(sb);
  try {
    const home = path.join(sb.home, '.bosun');
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, 'memory.db'), 'OWNER DATABASE CANARY');
    fs.writeFileSync(path.join(home, 'config.toml'), 'OWNER CONFIG CANARY');
    const before = footprint(home);
    const r = await runMemoryEvaluation({
      input: overviewFixture(),
      env: sb.env(),
      surface: 'mcp',
      budgetTokens: 1000,
      temporaryRoot: process.env.BOSUN_TEST_RUN_ROOT!,
    });
    assert.equal(r.surface, 'mcp');
    assert.equal(r.settings.budgetTokens, 1000);
    assert.equal(r.mcp?.transport, 'native-node-stdio');
    assert.equal(r.mcp?.protocol, '2026-07-28');
    assert.equal(r.mcp?.calls, 800);
    assert.equal(r.mcp?.replyBytes.samples, 800);
    assert.equal(r.mcp?.maximumClients, 8);
    assert.equal(r.scopeProjection?.bindings.length, 10);
    assert.equal(r.arms.E.status, 'measured');
    if (r.arms.E.status !== 'measured') throw Error('E missing');
    assert.equal(r.arms.E.heldout.packedEvidenceRecall, 1);
    assert.equal(r.arms.E.heldout.tokens.budget, 1000);
    assert.equal(r.arms.E.heldout.tokens.overBudget, 0);
    assert.equal(r.incremental.E.qualified, false);
    assert.equal(r.activation.qualified, false);
    assert.deepEqual(footprint(home), before);
    assert.equal(r.ownerStorageOpened, false);
    assert.equal(r.modelsCalled, false);
    assert.deepEqual(sb.calls(), []);
  } finally {
    sb.cleanup();
  }
});

test('guarded standalone MCP surface uses actual pinned protocol and never starts model tooling', () => {
  const sb = sandbox();
  fresh(sb);
  try {
    const child = spawnSync(
      process.execPath,
      [
        path.join(REPO, 'scripts/eval-memory.mjs'),
        '--fixture',
        'test/fixtures/memory-eval.json',
        '--baseline',
        'fts',
        '--surface',
        'mcp',
      ],
      {
        cwd: sb.root,
        env: sb.env({
          TMPDIR: process.env.BOSUN_TEST_RUN_ROOT!,
          TMP: process.env.BOSUN_TEST_RUN_ROOT!,
          TEMP: process.env.BOSUN_TEST_RUN_ROOT!,
        }),
        encoding: 'utf8',
        timeout: 60000,
        maxBuffer: 1048576,
      },
    );
    assert.equal(child.status, 0, child.stderr);
    const r = JSON.parse(child.stdout);
    assert.equal(r.surface, 'mcp');
    assert.equal(r.mcp.calls, 600);
    assert.equal(r.modelsCalled, false);
    assert.equal(r.activation.qualified, false);
  } finally {
    sb.cleanup();
  }
});
