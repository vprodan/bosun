import "./bootstrap.ts";
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bosun } from './helpers.ts';
import { syntheticRouterCorpus } from './router-evaluation-fixture.ts';
import { routeFixture, publicDecision } from './route-fixture.ts';

test('final routing retains lane/risk policy while hooks stay silent without notes and perform no inference for any host', async () => {
  let decision = publicDecision();
  const f = await routeFixture(() => ({ json: decision }));
  try {
    decision.answers.lane = { type: 'choice', choice: 'local', confidence: 0.9, probabilities: { main: 0.02, worker: 0.03, local: 0.9, scout: 0.05 } };
    decision.answers.risk = { type: 'choice', choice: 'low', confidence: 0.9, probabilities: { high: 0.1, low: 0.9 } };
    const mechanical = await f.cli(['route', 'rename getCart to fetchCart in cart-service']);
    assert.equal(mechanical.code, 0, mechanical.err);
    assert.equal(JSON.parse(mechanical.out).route.final, 'local');
    decision = publicDecision();
    const risky = JSON.parse((await f.cli(['route', 'implement refund in payment-service'])).out);
    assert.equal(risky.route.final, 'main');
    assert.equal(risky.route.why, 'risk=high overrides worker');
    decision.answers.lane.confidence = 0.1;
    decision.answers.risk = { type: 'choice', choice: 'low', confidence: 0.9, probabilities: { high: 0.1, low: 0.9 } };
    const uncertain = JSON.parse((await f.cli(['route', 'Public low confidence request'])).out);
    assert.equal(uncertain.route.final, null); assert.equal(uncertain.route.why, 'low confidence');
    const calls = f.server.requests.length;
    for (const host of ['opencode', 'codex', 'claude']) {
      for (const prompt of ['rename getCart to fetchCart', '/help me with this', '!ls -la here', 'fix it', 'rename a to b #noroute']) {
        const hook = await bosun(['hook'], { env: f.env, cwd: f.workspace, input: JSON.stringify({ prompt, host }) });
        assert.deepEqual([hook.code, hook.out, hook.err], [0, '', '']);
      }
    }
    const recursive = await bosun(['hook'], { env: { ...f.env, BOSUN_DEPTH: '1' }, cwd: f.workspace, input: JSON.stringify({ prompt: 'Public recursive task' }) });
    assert.deepEqual([recursive.code, recursive.out, recursive.err], [0, '', '']);
    assert.equal((await bosun(['hook'], { env: f.env, input: 'not json' })).code, 0);
    assert.equal(f.server.requests.length, calls, 'no hook inference or readiness/network probe');
    const stats = await f.cli(['router', 'stats']);
    assert.equal(JSON.parse(stats.out).decisions, 3); assert.equal(JSON.parse(stats.out).automaticDispatch, false);
    assert.equal(f.calls(), 0);
  } finally { await f.close(); }
});

test('final router evaluation reports frozen development thresholds and keeps corrupt historical labels separate from held-out evidence', async () => {
  const f = await routeFixture();
  try {
    const rows = [], labels = [];
    for (let i = 0; i < 12; i++) {
      const right = i < 10, id = i.toString(16).padStart(10, '0');
      rows.push(JSON.stringify({ ts: i, id, prompt: `p${i}`, lane: 'local', conf: right ? 0.9 : 0.3, risk: 'low', risk_conf: 0.3, ms: 10 + i, router: 'kev', final: 'local', why: '' }));
      labels.push(JSON.stringify({ id, label: right ? 'local' : 'worker' }));
    }
    const log = rows.join('\n') + '\n{"half-writ\n', feedback = labels.join('\n') + '\n';
    fs.writeFileSync(path.join(f.paths.home, 'route-log.jsonl'), log, { mode: 0o600 });
    fs.writeFileSync(path.join(f.paths.home, 'route-labels.jsonl'), feedback, { mode: 0o600 });
    const stats = JSON.parse((await f.cli(['router', 'stats', '--legacy'])).out);
    assert.equal(stats.decisions, 12); assert.equal(stats.labeled, 12); assert.equal(stats.rawLabelAgreement, 10 / 12);
    assert.equal(stats.scope, 'unscoped'); assert.equal(stats.calibration, 'unverified');
    const data = syntheticRouterCorpus(); fs.writeFileSync(path.join(f.workspace, 'evaluation.json'), JSON.stringify(data));
    const evaluation = await f.cli(['router', 'eval', 'evaluation.json', '--public']); assert.equal(evaluation.code, 0, evaluation.err);
    const report = JSON.parse(evaluation.out);
    assert.equal(report.selection.threshold, 0.4); assert.equal(report.selection.selectedFrom, 'development-only');
    assert.equal(report.clef.offeredAccuracy, 1); assert.ok(report.clef.correctPerTask > report.baseline.correctPerTask);
    assert.equal(report.proposal.state, 'held'); assert.equal(report.automaticDispatch, false);
    assert.equal(fs.readFileSync(path.join(f.paths.home, 'route-log.jsonl'), 'utf8'), log);
    assert.equal(fs.readFileSync(path.join(f.paths.home, 'route-labels.jsonl'), 'utf8'), feedback);
    assert.equal(f.server.requests.length, 0, 'offline evaluation never calls the classifier');
  } finally { await f.close(); }
});

test('final router evaluation rejects an insufficient corpus and documents the complete required split', async () => {
  const f = await routeFixture();
  try {
    const data = syntheticRouterCorpus(); data.cases = [];
    fs.writeFileSync(path.join(f.workspace, 'empty.json'), JSON.stringify(data));
    const result = await f.cli(['router', 'eval', 'empty.json', '--public']);
    assert.equal(result.code, 2); assert.equal(result.out, '');
    const help = await f.cli(['router', 'eval', '--help']);
    assert.equal(help.code, 0, help.err); assert.match(help.out, /80 public cases/); assert.match(help.out, /20 development/); assert.match(help.out, /60 held-out/);
    assert.equal(f.server.requests.length, 0);
  } finally { await f.close(); }
});
