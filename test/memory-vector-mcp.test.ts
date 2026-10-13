import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { sandbox, fresh, mock, gitRepo } from './helpers.ts';
import { memoryEvaluationFixture } from './memory-evaluation-fixture.ts';
import { runMemoryEvaluation } from '../src/app/memory-evaluation.ts';
import { defaultConfig } from '../src/core/domain/config.ts';
import { setupRuntime } from '../src/app/setup.ts';
import { runtimePaths } from '../src/platform/paths.ts';
import { main } from '../src/app/cli.ts';
import { footprint } from './read-view-prototype.ts';
import { BosunError } from '../src/core/errors.ts';

const MODEL = 'embeddinggemma:eval-fixture',
  DIGEST = 'a'.repeat(64);
const code = (name: string) => (error: unknown) =>
  error instanceof BosunError && error.code === name;
const settings = (url: string) => ({
  ...defaultConfig().graph.embedding,
  model: MODEL,
  url,
  digest: DIGEST,
  dimensions: 3,
  backend: 'reference' as const,
  queryCacheSize: 4,
});
function ownerFiles(dir: string): unknown {
  return fs
    .readdirSync(dir)
    .sort()
    .map((name) => {
      const file = path.join(dir, name),
        stat = fs.lstatSync(file, { bigint: true });
      return {
        name,
        dev: String(stat.dev),
        ino: String(stat.ino),
        mode: String(stat.mode),
        mtime: String(stat.mtimeNs),
        ctime: String(stat.ctimeNs),
        value: stat.isDirectory()
          ? ownerFiles(file)
          : stat.isSymbolicLink()
            ? fs.readlinkSync(file)
            : crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
      };
    });
}
async function backend(onTags?: () => void) {
  return mock({
    '/api/tags': () => {
      onTags?.();
      return { json: { models: [{ model: MODEL, digest: DIGEST }] } };
    },
    '/api/show': () => ({ json: { capabilities: ['embedding'] } }),
    '/api/embed': (body) => ({
      json: {
        model: MODEL,
        embeddings: body.input.map((text: string) =>
          text.includes('unrelated nebula') ? [0, 1, 0] : [1, 0, 0],
        ),
        prompt_eval_count: 7,
      },
    }),
  });
}

test('vector evaluation requires public export and a public pinned MCP selection before payload, files or model calls', async () => {
  const sb = sandbox();
  fresh(sb);
  const server = await backend();
  try {
    let touched = 0;
    const input = memoryEvaluationFixture();
    const privateCase = {
      privacy: 'unknown',
      get query() {
        touched++;
        throw Error('payload');
      },
    };
    await assert.rejects(
      runMemoryEvaluation({
        input: { ...input, cases: [...input.cases.slice(0, -1), privateCase] },
        env: sb.env(),
        surface: 'mcp',
        embedding: {
          privacy: 'public',
          get settings() {
            touched++;
            throw Error('model metadata');
          },
        },
      }),
      code('private_input'),
    );
    await assert.rejects(
      runMemoryEvaluation({
        input,
        env: sb.env(),
        surface: 'mcp',
        embedding: {
          privacy: 'private',
          get settings() {
            touched++;
            throw Error('model metadata');
          },
        },
      }),
      code('private_input'),
    );
    assert.equal(touched, 0);
    for (const candidate of [
      { ...settings(server.url), digest: undefined },
      { ...settings(server.url), backend: 'disabled' },
      { ...settings(server.url), dimensions: 0 },
      { ...settings(server.url), url: 'https://remote.invalid' },
    ])
      await assert.rejects(
        runMemoryEvaluation({
          input,
          env: sb.env(),
          surface: 'mcp',
          embedding: { privacy: 'public', settings: candidate },
        }),
      );
    await assert.rejects(
      runMemoryEvaluation({
        input,
        env: sb.env(),
        surface: 'hook-packing',
        embedding: { privacy: 'public', settings: settings(server.url) },
      }),
      code('unsupported'),
    );
    assert.deepEqual(server.requests, []);
    assert.deepEqual(sb.calls(), []);
  } finally {
    await server.close();
    sb.cleanup();
  }
});

test('actual owner jobs and 100-query MCP D/E compare each layer, preserve owner bytes, count declared usage and hold weak synthetic gain', async () => {
  const sb = sandbox();
  fresh(sb);
  const server = await backend();
  try {
    const home = path.join(sb.home, '.bosun');
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, 'memory.db'), 'OWNER DATABASE MUST NOT OPEN');
    fs.writeFileSync(path.join(home, 'config.toml'), 'OWNER CONFIG MUST NOT OPEN');
    const before = footprint(home),
      input = memoryEvaluationFixture();
    input.cases[22].query = 'exclusive vectorphrase requisition';
    const note = input.notes[2],
      quote = 'uses pnpm for reproducible builds';
    input.graph!.push({
      privacy: 'public',
      reviewed: true,
      id: 'g_vectoroverview2',
      sourceGroup: note.sourceGroup,
      sessionGroup: note.sessionGroup,
      scope: note.scope,
      kind: 'summary',
      title: 'Reviewed operations overview',
      text: `Reviewed operations ${quote}.`,
      supports: [{ id: note.id, quote }],
      parents: ['g_eval2'],
    });
    for (const task of input.cases.filter((task) => task.sourceGroup === note.sourceGroup))
      for (const ref of task.supports) ref.alternatives!.push({ id: 'g_vectoroverview2', quote });
    const report = await runMemoryEvaluation({
      input,
      env: sb.env(),
      surface: 'mcp',
      budgetTokens: 1000,
      temporaryRoot: process.env.BOSUN_TEST_RUN_ROOT!,
      embedding: { privacy: 'public', settings: settings(server.url) },
    });
    assert.deepEqual(footprint(home), before);
    assert.equal(report.ownerStorageOpened, false);
    assert.equal(report.modelsCalled, true);
    assert.equal(report.mcp?.calls, 1000);
    assert.equal(report.mcp?.maximumClients, 8);
    assert.equal(report.arms.C.status, 'measured');
    assert.equal(report.arms.D.status, 'measured');
    if (report.arms.C.status !== 'measured' || report.arms.D.status !== 'measured')
      throw Error('C/D missing');
    assert.deepEqual(report.arms.C.cases[22].visibleSupportIds, []);
    assert.deepEqual(report.arms.D.cases[22].visibleSupportIds, ['m_eval2']);
    assert.deepEqual(report.arms.D.cases[22].zeroOverlapVectorIds, ['m_eval2']);
    assert.equal(report.arms.D.heldout.negativeInjectionRate, 0);
    assert.equal(report.arms.D.heldout.packedEvidenceRecall, 1);
    assert.equal(report.arms.D.heldout.tokens.overBudget, 0);
    assert.equal(report.comparisons.DvsC?.packedEvidenceRecallDelta.mean, 1 / 64);
    assert.equal(report.comparisons.DvsC?.packedEvidenceRecallDelta.interval95?.lower, 0);
    assert.equal(report.incremental.D.metricsPass, false);
    assert.equal(report.incremental.D.qualified, false);
    assert.equal(report.incremental.E.baseline, 'D');
    assert.equal(report.arms.E.status, 'measured');
    assert.equal(report.comparisons.EvsD?.packedEvidenceRecallDelta.mean, 0);
    assert.equal(report.incremental.E.metricsPass, false);
    assert.equal(report.activation.qualified, false);
    assert.equal(report.embedding?.digest, DIGEST);
    assert.equal(report.embedding?.selectionFrozenBeforeIndexing, true);
    assert.equal(report.embedding?.indexedJobs.length, 10);
    assert.equal(report.embedding?.usage.document.completed, 10);
    assert.equal(
      report.embedding?.usage.query.completed,
      200,
      'raw/packed query pair reuses only its eligible scoped cache entry',
    );
    assert.equal(report.embedding?.usage.document.reportedTokensIn, 70);
    assert.equal(report.embedding?.usage.query.reportedTokensIn, 1400);
    assert.equal(report.embedding?.actualHostTokens, 'unverified');
    const requests = server.requests.filter((row) => row.path === '/api/embed');
    assert.equal(requests.length, 210);
    assert.ok(requests.every((row) => row.body.model === MODEL && row.body.truncate === false));
    assert.ok(
      requests.every(
        (row) =>
          Object.keys(row.body).sort().join(',') === 'dimensions,input,keep_alive,model,truncate',
      ),
    );
    assert.ok(
      requests.every(
        (row) =>
          !JSON.stringify(row.body).includes('"supports"') &&
          !JSON.stringify(row.body).includes('"grade"') &&
          !JSON.stringify(row.body).includes('"heldout"'),
      ),
    );
    assert.deepEqual(sb.calls(), []);
  } finally {
    await server.close();
    sb.cleanup();
  }
});

test('changed approved source during model metadata prevents indexing inference, aborts evaluation and never retries', async () => {
  const sb = sandbox();
  fresh(sb);
  let valid = true;
  const server = await backend(() => {
    valid = false;
  });
  try {
    await assert.rejects(
      runMemoryEvaluation({
        input: memoryEvaluationFixture(),
        env: sb.env(),
        surface: 'mcp',
        valid: () => valid,
        temporaryRoot: process.env.BOSUN_TEST_RUN_ROOT!,
        embedding: { privacy: 'public', settings: settings(server.url) },
      }),
      code('conflict'),
    );
    assert.equal(server.requests.filter((row) => row.path === '/api/tags').length, 1);
    assert.equal(server.requests.filter((row) => row.path === '/api/embed').length, 0);
    assert.deepEqual(sb.calls(), []);
  } finally {
    await server.close();
    sb.cleanup();
  }
});

test('final CLI vector evaluation needs both public approval and the MCP surface before any model effect', async () => {
  const sb = sandbox();
  fresh(sb);
  const server = await backend();
  try {
    const workspace = gitRepo(sb, 'workspace'),
      file = path.join(workspace, 'public-evaluation.json');
    fs.writeFileSync(file, JSON.stringify(memoryEvaluationFixture()));
    const env = sb.env(),
      config = defaultConfig();
    config.graph.embedding = settings(server.url);
    await setupRuntime(runtimePaths(env), config);
    const before = ownerFiles(runtimePaths(env).home),
      callsBefore = sb.calls();
    let error = '';
    const run = (args: string[]) =>
      main(args, { env, cwd: workspace, stdout() {}, stderr: (text) => (error += text) });
    assert.equal(
      await run(['memory', 'eval', path.basename(file), '--vectors', '--surface', 'mcp']),
      2,
    );
    assert.match(error, /public/);
    error = '';
    assert.equal(
      await run(['memory', 'eval', path.basename(file), '--public', '--vectors']),
      1,
      error,
    );
    assert.equal(JSON.parse(error).error.code, 'unsupported');
    assert.deepEqual(server.requests, []);
    assert.deepEqual(ownerFiles(runtimePaths(env).home), before);
    assert.deepEqual(sb.calls(), callsBefore);
  } finally {
    await server.close();
    sb.cleanup();
  }
});
