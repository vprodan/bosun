import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { routerEvaluationDataset } from '../src/contracts/router-evaluation.ts';
import {
  freezeRouterThreshold,
  routerEvaluationReport,
  deterministicRoute,
  evaluatedRoute,
} from '../src/core/use-cases/evaluate-router.ts';
import { BosunError } from '../src/core/errors.ts';
import { methodParams } from '../src/contracts/methods.ts';
import { readEvaluationFile } from '../src/platform/evaluation-file.ts';
import { syntheticRouterCorpus, evaluationWire } from './router-evaluation-fixture.ts';
import { routeFixture } from './route-fixture.ts';
import { gitEnvelope } from './git-fixture.ts';
import type { RouterEvalSample } from '../src/core/domain/router-evaluation.ts';
const CANARY = 'PRIVATE_EVALUATION_CANARY_89234';
const code = (expected: string) => (error: unknown) =>
  error instanceof BosunError && error.code === expected;
const sample = (data = syntheticRouterCorpus()): RouterEvalSample[] =>
  data.cases.map((task) => ({ task, observed: task.observed!, outcomeVerified: false }));
function save(f: Awaited<ReturnType<typeof routeFixture>>, data = syntheticRouterCorpus()) {
  const file = path.join(f.workspace, 'evaluation.json'),
    text = JSON.stringify(data);
  fs.writeFileSync(file, text);
  return {
    file: 'evaluation.json',
    sha256: crypto.createHash('sha256').update(text).digest('hex'),
    text,
  };
}
async function terminal(f: Awaited<ReturnType<typeof routeFixture>>, id: string) {
  let job = await f.rpc('job.get', { id });
  for (let n = 0; n < 400 && ['queued', 'running'].includes(job.state); n++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    job = await f.rpc('job.get', { id });
  }
  assert.ok(!['queued', 'running'].includes(job.state));
  return job;
}
test('entire corpus privacy is checked before any task payload, including the last held-out entry', () => {
  const data = syntheticRouterCorpus();
  let inspected = 0;
  Object.defineProperty(data.cases[0], 'text', {
    get() {
      inspected++;
      throw Error(CANARY);
    },
  });
  Object.defineProperty(data.cases[79], 'privacy', { value: 'private' });
  assert.throws(() => routerEvaluationDataset(data), code('private_input'));
  assert.equal(inspected, 0);
  const request = {
    version: 1 as const,
    id: 'private',
    method: 'route.capture',
    params: {
      privacy: 'private',
      get file(): never {
        inspected++;
        throw Error(CANARY);
      },
    },
    scope: { workspace: '/', sessionId: null, audience: 'owner' as const },
  };
  assert.throws(() => methodParams(request), code('private_input'));
  assert.equal(inspected, 0);
  assert.throws(
    () => methodParams({ ...request, scope: { ...request.scope, audience: 'model' } }),
    code('unsupported'),
  );
});
test('fixed split rejects duplicate tasks/references, repository or session leakage, missing categories, model skew and credentials', () => {
  const arms = [
    'count',
    'repo',
    'session',
    'alias',
    'text',
    'reference',
    'category',
    'model',
    'secret',
  ] as const;
  for (const arm of arms) {
    const data = syntheticRouterCorpus();
    if (arm === 'count') data.cases.pop();
    if (arm === 'repo') data.cases[20].repositoryGroup = data.cases[0].repositoryGroup;
    if (arm === 'session') data.cases[20].sessionGroup = data.cases[0].sessionGroup;
    if (arm === 'alias') data.cases[20].repositoryGroup = 'different_alias_for_same_project';
    if (arm === 'text') data.cases[20].text = data.cases[0].text;
    if (arm === 'reference') data.cases[20].outcome.reference = data.cases[0].outcome.reference;
    if (arm === 'category')
      data.cases
        .filter((c) => c.category === 'ambiguous')
        .forEach((c) => (c.category = 'mechanical'));
    if (arm === 'model') data.cases[20].observed!.decision!.router = 'silent-fallback';
    if (arm === 'secret') data.cases[79].text = 'api_key=' + 'x'.repeat(40);
    assert.throws(
      () => routerEvaluationDataset(data),
      code(arm === 'secret' ? 'private_input' : 'invalid'),
    );
  }
  assert.equal(routerEvaluationDataset(syntheticRouterCorpus()).cases.length, 80);
});
test('threshold freezes only development evidence; held-out relabeling cannot tune it and synthetic/imported metrics cannot qualify calibration', () => {
  const data = routerEvaluationDataset(syntheticRouterCorpus()),
    captured = sample(data);
  const frozen = freezeRouterThreshold(captured.filter((s) => s.task.split === 'development'));
  assert.equal(frozen.threshold, 0.4);
  assert.equal(frozen.selectedFrom, 'development-only');
  const report = routerEvaluationReport(data, captured, frozen, 'imported', 'a'.repeat(64));
  assert.equal(report.split.development, 20);
  assert.equal(report.split.heldout, 60);
  assert.equal(report.proposal.state, 'held');
  assert.equal(report.automaticDispatch, false);
  assert.equal(report.calibration, 'unverified');
  assert.ok(report.clef.offeredAccuracy! >= 0.9);
  assert.ok(report.clef.correctPerTask > report.baseline.correctPerTask);
  assert.ok(report.clef.accuracyInterval95!.lower < report.clef.offeredAccuracy!);
  assert.equal(report.categories.length, 7);
  assert.ok(report.clef.latency.warm.samples > 0);
  assert.equal(report.clef.latency.cold.p95, null);
  for (const s of captured.filter((s) => s.task.split === 'heldout'))
    s.task.expected.lane = 'scout';
  assert.deepEqual(
    freezeRouterThreshold(captured.filter((s) => s.task.split === 'development')),
    frozen,
  );
  assert.throws(() => freezeRouterThreshold(captured.slice(20, 40)), code('invalid'));
  assert.throws(
    () =>
      routerEvaluationReport(
        data,
        [...captured.slice(0, 79), captured[0]],
        frozen,
        'imported',
        'a'.repeat(64),
      ),
    code('invalid'),
  );
  assert.throws(
    () =>
      routerEvaluationReport(
        data,
        captured,
        { ...frozen, threshold: 0.2 },
        'imported',
        'a'.repeat(64),
      ),
    code('conflict'),
  );
});
test('deterministic permissions/model/no-delegation fences remain authoritative and risk-miss/outcome metrics expose harmful offered hints', () => {
  const data = syntheticRouterCorpus(),
    captured = sample(data),
    task = data.cases[0];
  const bad = {
    ...task.observed!,
    decision: {
      ...task.observed!.decision!,
      risk: 'low' as const,
      lane: 'local' as const,
      conf: 1,
    },
  };
  assert.equal(deterministicRoute(task), 'main');
  assert.equal(evaluatedRoute(task, bad, 0.2), 'main');
  task.policy = { operation: 'mechanical', files: ['src/public.ts'] };
  captured[0].observed = bad;
  const report = routerEvaluationReport(
    data,
    captured,
    freezeRouterThreshold(captured.slice(0, 20)),
    'native',
    'a'.repeat(64),
  );
  // Held-out task deliberately has hidden owner risk absent from the trusted policy.
  const held = data.cases[21];
  held.expected.risk = 'high';
  held.access = 'edit';
  held.policy = { operation: 'mechanical', files: ['src/public.ts'] };
  captured[21].observed = {
    ...held.observed!,
    decision: { ...held.observed!.decision!, lane: 'local', risk: 'low', conf: 1 },
  };
  const harm = routerEvaluationReport(
    data,
    captured,
    freezeRouterThreshold(captured.slice(0, 20)),
    'native',
    'a'.repeat(64),
  );
  assert.ok(harm.clef.harmfulDelegations > 0);
  assert.ok(harm.clef.riskMisses > 0);
  assert.equal(harm.gates.noHarmfulDelegation, false);
  assert.ok(report.clef.outcomes.escalated > 0);
  assert.ok(report.clef.outcomes.failed > 0);
});
test('final CLI offline analysis uses the complete corpus, reports outcome uncertainty, leaves sources/config intact and calls no model', async () => {
  const f = await routeFixture();
  try {
    const input = save(f),
      config = fs.readFileSync(f.paths.config),
      before = fs.readdirSync(f.paths.artifacts);
    const result = await f.cli(['router', 'eval', input.file, '--public']);
    assert.equal(result.code, 0, result.err);
    const report = JSON.parse(result.out);
    assert.equal(report.capture, 'imported');
    assert.equal(report.split.heldout, 60);
    assert.equal(report.gates.groundTruth, false);
    assert.equal(report.configurationChanged, false);
    assert.deepEqual(fs.readFileSync(f.paths.config), config);
    assert.deepEqual(fs.readdirSync(f.paths.artifacts), before);
    assert.equal(fs.readFileSync(path.join(f.workspace, input.file), 'utf8'), input.text);
    assert.equal(f.server.requests.length, 0);
    await assert.rejects(
      f.rpc(
        'route.evaluate',
        { privacy: 'public', file: input.file, sha256: input.sha256 },
        { ...f.scope, audience: 'model' },
      ),
      code('unsupported'),
    );
  } finally {
    await f.close();
  }
});
test('native capture evaluates development first, persists its selection before held-out requests and never sends labels or verification data to the classifier', async () => {
  const data = syntheticRouterCorpus();
  let f: Awaited<ReturnType<typeof routeFixture>> | undefined,
    n = 0;
  f = await routeFixture(() => {
    const task = data.cases[n++];
    if (n === 21)
      assert.equal(
        fs.readdirSync(f!.paths.artifacts).filter((file) => file.startsWith('router-evaluation-'))
          .length,
        1,
      );
    return { json: evaluationWire(task.observed!.decision!) };
  });
  try {
    const input = save(f, data),
      config = fs.readFileSync(f.paths.config);
    const queued = await f.cli([
      'router',
      'eval',
      input.file,
      '--public',
      '--run',
      '--hash',
      input.sha256,
      '--request-id',
      'native_eval',
    ]);
    assert.equal(queued.code, 0, queued.err);
    const job = JSON.parse(queued.out).job;
    assert.equal((await terminal(f, job.id)).state, 'succeeded');
    const report = JSON.parse((await f.rpc('job.result', { id: job.id })).result);
    assert.equal(report.capture, 'native');
    assert.equal(report.selection.threshold, 0.4);
    assert.equal(report.proposal.state, 'held');
    assert.equal(n, 80);
    const frozen = JSON.parse((await f.cli(['router', 'frozen', job.id])).out);
    assert.equal(frozen.selection.threshold, 0.4);
    assert.equal(frozen.selection.developmentCases.length, 20);
    assert.equal(frozen.datasetSha256, input.sha256);
    const requests = f.server.requests.filter((r) => r.path === '/v1/systemone');
    for (const [i, request] of requests.entries()) {
      const state = JSON.parse(request.body.state);
      assert.deepEqual(Object.keys(state).sort(), ['access', 'policy', 'selectedModel', 'task']);
      assert.equal(state.task, data.cases[i].text);
      assert.equal(request.body.model, data.model);
    }
    const duplicate = await f.rpc('route.capture', {
      privacy: 'public',
      file: input.file,
      sha256: input.sha256,
      requestId: 'native_eval',
    });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.job.id, job.id);
    assert.equal(n, 80);
    assert.deepEqual(fs.readFileSync(f.paths.config), config);
    assert.equal(f.calls(), 0);
  } finally {
    await f.close();
  }
});
test('public declaration and source pin reject private late cases, secret input and external/symlink paths before inference or artifacts', async () => {
  const f = await routeFixture();
  try {
    for (const arm of ['private', 'secret']) {
      const data = syntheticRouterCorpus();
      if (arm === 'private') Object.defineProperty(data.cases[79], 'privacy', { value: 'private' });
      else data.cases[79].text = 'api_key=' + 'x'.repeat(40);
      const input = save(f, data);
      await assert.rejects(
        f.rpc('route.capture', {
          privacy: 'public',
          file: input.file,
          sha256: input.sha256,
          requestId: arm,
        }),
        code('private_input'),
      );
    }
    const input = save(f);
    await assert.rejects(
      f.rpc('route.capture', {
        privacy: 'public',
        file: input.file,
        sha256: '0'.repeat(64),
        requestId: 'skew',
      }),
      code('conflict'),
    );
    assert.throws(() => readEvaluationFile(f.workspace, '../auth.json'), code('invalid'));
    fs.symlinkSync(path.join(f.workspace, input.file), path.join(f.workspace, 'linked.json'));
    assert.throws(() => readEvaluationFile(f.workspace, 'linked.json'), code('invalid'));
    assert.equal(f.server.requests.length, 0);
    assert.equal(fs.readdirSync(f.paths.artifacts).length, 0);
    assert.deepEqual((await f.rpc('job.list', {})).jobs, []);
  } finally {
    await f.close();
  }
});
test('a dataset change during capture preserves one unknown original job, never starts held-out capture and never replays the request', async () => {
  const data = syntheticRouterCorpus();
  let f: Awaited<ReturnType<typeof routeFixture>> | undefined,
    n = 0;
  f = await routeFixture(() => {
    n++;
    fs.appendFileSync(path.join(f!.workspace, 'evaluation.json'), '\n');
    return { json: evaluationWire(data.cases[0].observed!.decision!) };
  });
  try {
    const input = save(f, data),
      request = {
        privacy: 'public',
        file: input.file,
        sha256: input.sha256,
        requestId: 'changed_eval',
      };
    const queued = await f.rpc('route.capture', request);
    assert.equal((await terminal(f, queued.job.id)).state, 'unknown');
    assert.equal(n, 1);
    const prior = await f.rpc('route.capture', request);
    assert.equal(prior.duplicate, true);
    assert.equal(prior.job.id, queued.job.id);
    await assert.rejects(f.rpc('job.release', { id: queued.job.id }), code('conflict'));
    assert.equal(n, 1);
    assert.equal(fs.readdirSync(f.paths.artifacts).length, 0);
  } finally {
    await f.close();
  }
});
test('reviewed digest mismatch holds before generation; a tagged model is never silently evaluated with different weights', async () => {
  const f = await routeFixture();
  try {
    const data = syntheticRouterCorpus();
    data.digest = 'b'.repeat(64);
    const input = save(f, data),
      queued = await f.rpc('route.capture', {
        privacy: 'public',
        file: input.file,
        sha256: input.sha256,
        requestId: 'wrong_digest',
      });
    assert.equal((await terminal(f, queued.job.id)).state, 'unknown');
    assert.equal(f.server.requests.filter((request) => request.path === '/v1/systemone').length, 0);
    assert.equal(fs.readdirSync(f.paths.artifacts).length, 0);
  } finally {
    await f.close();
  }
});
test('lost actual frozen-file publication retains its original selection after20 calls and starts no held-out request or replay', async () => {
  const data = syntheticRouterCorpus();
  let n = 0;
  const f = await routeFixture(() => ({
      json: evaluationWire(data.cases[n++].observed!.decision!),
    })),
    rename = fs.renameSync;
  let lost = 0;
  try {
    const input = save(f, data);
    fs.renameSync = ((from, to) => {
      const result = rename(from, to);
      if (String(to).includes('/router-evaluation-') && String(to).endsWith('.json')) {
        lost++;
        throw Error(CANARY);
      }
      return result;
    }) as typeof rename;
    const request = {
        privacy: 'public',
        file: input.file,
        sha256: input.sha256,
        requestId: 'lost_freeze',
      },
      queued = await f.rpc('route.capture', request);
    assert.equal((await terminal(f, queued.job.id)).state, 'unknown');
    fs.renameSync = rename;
    assert.equal(lost, 1);
    assert.equal(n, 20);
    const frozen = await f.rpc('route.frozen', { id: queued.job.id });
    assert.equal(frozen.selection.threshold, 0.4);
    const again = await f.rpc('route.capture', request);
    assert.equal(again.duplicate, true);
    assert.equal(again.job.id, queued.job.id);
    assert.equal(n, 20);
    await assert.rejects(f.rpc('job.release', { id: queued.job.id }), code('conflict'));
    const file = path.join(f.paths.artifacts, `router-evaluation-${queued.job.id}.json`);
    const invalid = { ...JSON.parse(fs.readFileSync(file, 'utf8')), body: CANARY };
    fs.writeFileSync(file, JSON.stringify(invalid));
    await assert.rejects(f.rpc('route.frozen', { id: queued.job.id }), code('unavailable'));
  } finally {
    fs.renameSync = rename;
    await f.close();
  }
});
test('cancellation during held-out capture keeps the frozen selection and unknown job without more inference or release', async () => {
  const data = syntheticRouterCorpus();
  let n = 0;
  const f = await routeFixture(() => {
    const task = data.cases[n++];
    return {
      ...(n === 21 ? { delayMs: 300 } : {}),
      json: evaluationWire(task.observed!.decision!),
    };
  });
  try {
    const input = save(f, data),
      request = {
        privacy: 'public',
        file: input.file,
        sha256: input.sha256,
        requestId: 'cancelled_eval',
      };
    const queued = await f.rpc('route.capture', request);
    for (let wait = 0; wait < 400 && n < 21; wait++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(n, 21);
    await f.rpc('job.cancel', { id: queued.job.id });
    assert.equal((await terminal(f, queued.job.id)).state, 'unknown');
    assert.equal((await f.rpc('route.frozen', { id: queued.job.id })).selection.threshold, 0.4);
    assert.equal((await f.rpc('route.capture', request)).job.id, queued.job.id);
    assert.equal(n, 21);
    await assert.rejects(f.rpc('job.release', { id: queued.job.id }), code('conflict'));
  } finally {
    await f.close();
  }
});
test('outcome proof resolves an actual closed revision-bound check; owner assertions and mismatched revisions remain unverified', async () => {
  const f = await routeFixture();
  try {
    await gitEnvelope(f.sb, async () => {
      fs.writeFileSync(path.join(f.workspace, 'change.ts'), 'export const checked=true;');
      const reviewed = await f.rpc('review.submit', {
        privacy: 'public',
        requestId: 'evaluation_review',
        runnerId: 'codex',
        model: 'PINNED',
      });
      assert.equal((await terminal(f, reviewed.job.id)).state, 'succeeded');
      const command = path.join(f.sb.root, 'verify-router-evidence');
      fs.writeFileSync(command, `#!${process.execPath}\nprocess.stdout.write('verified');\n`, {
        mode: 0o755,
      });
      const checked = await f.rpc('check.submit', {
        privacy: 'public',
        requestId: 'evaluation_check',
        reviewId: reviewed.record.id,
        command,
        args: [],
      });
      assert.equal((await terminal(f, checked.job.id)).state, 'succeeded');
      const proof = (await f.rpc('check.get', { id: checked.record.id })).record;
      assert.equal(proof.outcome.phase, 'closed');
      assert.equal(proof.outcome.checkout, 'matches');
      const data = syntheticRouterCorpus();
      for (const task of data.cases.filter((item) => item.split === 'development')) {
        task.repositoryGroup = proof.projectId;
        task.outcome.projectId = proof.projectId;
      }
      data.cases[0].outcome = {
        ...data.cases[0].outcome,
        kind: 'check',
        reference: proof.id,
        revision: proof.revision,
        result: 'passed',
      };
      let input = save(f, data),
        report = await f.rpc('route.evaluate', {
          privacy: 'public',
          file: input.file,
          sha256: input.sha256,
        });
      assert.equal(report.observations[0].outcomeVerified, true);
      assert.equal(
        report.gates.groundTruth,
        false,
        'other synthetic outcomes cannot inherit one verified receipt',
      );
      data.cases[0].outcome.revision = 'd'.repeat(64);
      input = save(f, data);
      report = await f.rpc('route.evaluate', {
        privacy: 'public',
        file: input.file,
        sha256: input.sha256,
      });
      assert.equal(report.observations[0].outcomeVerified, false);
      data.cases[0].outcome.kind = 'owner-review';
      data.cases[0].outcome.revision = proof.revision;
      input = save(f, data);
      report = await f.rpc('route.evaluate', {
        privacy: 'public',
        file: input.file,
        sha256: input.sha256,
      });
      assert.equal(report.observations[0].outcomeVerified, false);
      assert.equal(f.server.requests.length, 0, 'evidence inspection itself performs no inference');
    });
  } finally {
    await f.close();
  }
});
