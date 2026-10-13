import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { bosun, mock, type Sandbox } from './helpers.ts';
import { runtimeFixture } from './runtime-fixture.ts';
import { routeFixture, publicDecision, ROUTE_MODEL } from './route-fixture.ts';

const BODY = 'private-body-canary-9d271b';
const TITLE = 'private-title-canary-8f614c';
const TAG = 'private-tag-canary-561cea';
const ECHO = 'provider-echo-canary-214b95';
const logs = ['route-log.jsonl', 'route-labels.jsonl', 'llm-usage.jsonl', 'bosun.log', 'metrics.jsonl', 'daemon.log'];
function noContent(sb: Sandbox, canaries = [BODY, TITLE, TAG, ECHO]): void {
  for (const name of logs) {
    const file = path.join(sb.home, '.bosun', name);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const canary of canaries) assert.equal(text.includes(canary), false, `${name} leaked ${canary}`);
  }
}
test('privacy: route flags/private or malformed hook markers skip inference and remote retrieval', async () => {
  const server = await mock();
  const f = await runtimeFixture(`[router]\nurl=${JSON.stringify(server.url)}\n[remote]\nauthority=${JSON.stringify(server.url)}\nauthorityId=${JSON.stringify(crypto.randomUUID())}\n`);
  try {
    const env = f.env;
    for (const marker of [{ private: true }, { private: 'true' }, { private: null }, { privacy: 'private' }, { privacy: 'unknown' }]) {
      const result = await bosun(['hook'], { env, cwd: f.workspace, input: JSON.stringify({ prompt: `${BODY} rename a to b`, ...marker }) });
      assert.deepEqual([result.code, result.out, result.err], [0, '', '']);
    }
    for (const args of [['route', '--private', BODY], ['route', '--hook', '--private']]) {
      const result = await bosun(args, { env, cwd: f.workspace, input: JSON.stringify({ prompt: `${BODY} rename a to b`, privacy: 'public' }) });
      assert.deepEqual([result.code, result.out, result.err], [0, '', '']);
    }
    assert.equal(server.requests.length, 0);
    assert.equal(f.sb.calls().length, 0);
    for (const privacy of [undefined, 'public']) {
      const hook = await bosun(['hook'], { env, cwd: f.workspace, input: JSON.stringify({ prompt: 'rename a to b in ordinary tooling', privacy }) });
      assert.deepEqual([hook.code, hook.out, hook.err], [0, '', '']);
    }
    assert.equal(server.requests.length, 0, 'hooks perform no inference or remote retrieval');
    assert.equal(f.calls(), 0);
    noContent(f.sb);
  } finally { await f.close(); await server.close(); }
});

test('privacy: route observations contain closed metadata and fresh IDs, never prompt hashes or echoed model fields', async () => {
  const f = await routeFixture(() => ({ json: { ...publicDecision(), modelEcho: ECHO, latency_ms: ECHO, prompt: BODY } }));
  try {
    const prompt = `${BODY} rename title ${TITLE} tag ${TAG}`;
    for (let i = 0; i < 2; i++) {
      const result = await f.cli(['route', prompt]);
      assert.equal(result.code, 0, result.err);
      assert.equal(JSON.parse(result.out).route.decision.router, ROUTE_MODEL);
      assert.equal(result.out.includes(ECHO), false);
    }
    const records = (await f.rpc('route.observations', {})).observations;
    assert.equal(records.length, 2);
    assert.notEqual(records[0].id, records[1].id);
    for (const row of records) {
      assert.match(row.id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
      assert.deepEqual(Object.keys(row).sort(), ['at', 'audience', 'conf', 'digest', 'final', 'id', 'label', 'lane', 'ms', 'projectId', 'risk', 'risk_conf', 'router', 'schema', 'sessionKey', 'threshold', 'why']);
    }
    const canaries = [BODY, TITLE, TAG, ECHO, crypto.createHash('sha1').update(prompt).digest('hex').slice(0, 10), crypto.createHash('sha256').update(prompt).digest('hex')];
    for (const canary of canaries) assert.ok(!JSON.stringify(records).includes(canary));
    noContent(f.sb, canaries);
  } finally { await f.close(); }
});

test('privacy: malformed router choices/confidence and provider parse errors produce no content-bearing telemetry', async () => {
  let response: any;
  const f = await routeFixture(() => response);
  try {
    for (const field of ['lane', 'risk', 'confidence', 'model', 'parse']) {
      const data = publicDecision();
      if (field === 'lane') data.answers.lane.choice = ECHO;
      if (field === 'risk') data.answers.risk.choice = ECHO;
      if (field === 'confidence') data.answers.lane.confidence = ECHO;
      if (field === 'model') data.model = ECHO;
      response = field === 'parse' ? { text: ECHO } : { json: data };
      const result = await f.cli(['route', `${BODY} ordinary coding task`]);
      assert.equal(result.code, 0, result.err);
      assert.equal(JSON.parse(result.out).route, null);
      assert.equal(JSON.parse(result.out).observation, null);
      assert.equal(JSON.parse(result.out).reason, 'classification_unavailable');
      assert.doesNotMatch(result.out + result.err, /canary/);
      const hook = await bosun(['hook'], { env: f.env, cwd: f.workspace, input: JSON.stringify({ prompt: `${BODY} ordinary coding task` }) });
      assert.deepEqual([hook.code, hook.out, hook.err], [0, '', '']);
    }
    assert.equal(f.server.requests.filter((row) => row.path === '/v1/systemone').length, 5, 'one request per explicit classification; hooks never infer');
    assert.deepEqual((await f.rpc('route.observations', {})).observations, []);
    assert.equal(fs.existsSync(path.join(f.paths.home, 'route-log.jsonl')), false);
    noContent(f.sb);
  } finally { await f.close(); }
});

test('privacy: metadata-only labels and legacy IDs work without redisplaying historical prompts or mutating logs', async () => {
  const f = await runtimeFixture();
  try {
    const file = path.join(f.paths.home, 'route-log.jsonl');
    const legacy = { ts: 1, id: '0123456789', prompt: BODY, lane: 'local', conf: 0.9, risk: 'low', risk_conf: 0.3, ms: 12, router: ECHO, final: 'local', why: ECHO };
    const original = JSON.stringify(legacy) + '\n' + JSON.stringify({ ...legacy, id: TITLE }) + '\n';
    fs.writeFileSync(file, original, { mode: 0o600 });
    const inspected = await f.cli(['router', 'observations', '--legacy']);
    assert.equal(inspected.code, 0, inspected.err);
    assert.deepEqual(JSON.parse(inspected.out).observations.map((row: any) => row.id), [legacy.id]);
    assert.doesNotMatch(inspected.out, /canary/);
    const first = await f.cli(['router', 'label', legacy.id, 'local', '--legacy']);
    assert.equal(first.code, 0, first.err);
    assert.equal(JSON.parse(first.out).label.id, legacy.id);
    assert.doesNotMatch(first.out, /canary/);
    assert.equal(fs.readFileSync(file, 'utf8'), original, 'historical raw log content is never automatically rewritten/deleted');
    const id = crypto.randomUUID();
    const appended = JSON.stringify({ ...legacy, id, prompt: undefined }) + '\n';
    fs.appendFileSync(file, appended);
    const second = await f.cli(['router', 'label', id, 'worker', '--legacy']);
    assert.equal(second.code, 0, second.err);
    assert.equal(JSON.parse(second.out).label.id, id);
    assert.doesNotMatch(second.out, /canary/);
    const rows = (await f.rpc('route.observations', { legacy: true })).observations;
    assert.deepEqual(rows.map((row: any) => [row.label.id, row.label.label]).sort(), [[legacy.id, 'local'], [id, 'worker']].sort());
    assert.equal(fs.readFileSync(file, 'utf8'), original + appended);
    assert.equal(fs.existsSync(path.join(f.paths.home, 'route-labels.jsonl')), false, 'feedback belongs to the existing daemon state');
    const stats = await f.cli(['router', 'stats', '--legacy']);
    assert.equal(stats.code, 0, stats.err);
    assert.equal(JSON.parse(stats.out).decisions, 2);
    assert.equal(JSON.parse(stats.out).scope, 'unscoped');
    assert.equal(JSON.parse(stats.out).calibration, 'unverified');
    assert.doesNotMatch(stats.out, /canary/);
    assert.deepEqual((await f.rpc('route.observations', {})).observations, [], 'historical rows never become current scoped evidence');
  } finally { await f.close(); }
});
