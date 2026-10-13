import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SqliteDatabase } from '../src/platform/sqlite.ts';
import { routeFixture, publicDecision, ROUTE_DIGEST, ROUTE_MODEL } from './route-fixture.ts';
import { runtimeFixture } from './runtime-fixture.ts';
import { gitRepo, sandbox } from './helpers.ts';
import { routeObservation, routeStatistics } from '../src/core/domain/route-observation.ts';
import { BosunError } from '../src/core/errors.ts';
import { readLegacyRouteLog } from '../src/platform/legacy-route-log.ts';
import { SqliteJobStore } from '../src/adapters/jobs/sqlite-jobs.ts';
import { DaemonOwner } from '../src/platform/daemon-owner.ts';
import { mcpFixture } from './mcp-fixture.ts';

const CANARY = 'PRIVATE_CONTENT_CANARY_9394';
const code = (expected: string) => (error: unknown) =>
  error instanceof BosunError && error.code === expected;
const storedRows = (file: string, table = 'route_observations') => {
  const db = new SqliteDatabase(file, { readOnly: true });
  try {
    return db.prepare(`SELECT * FROM ${table}`).all();
  } finally {
    db.close();
  }
};
test('record projection selects finite metadata, rejects accessor/extra fields and never serializes arbitrary nested content', () => {
  let touched = 0;
  const base = {
    schema: 1,
    id: crypto.randomUUID(),
    at: 1000,
    projectId: 'p_' + 'a'.repeat(16),
    sessionKey: null,
    audience: 'owner',
    digest: ROUTE_DIGEST,
    threshold: 0.7,
    lane: 'worker',
    conf: 0.7,
    risk: 'high',
    risk_conf: 0.7,
    ms: 4,
    router: ROUTE_MODEL,
    final: 'main',
    why: 'risk=high overrides worker',
  };
  assert.equal(routeObservation(base).id, base.id);
  for (const extra of ['body', 'prompt', 'toJSON', 'cause']) {
    const value = { ...base };
    Object.defineProperty(value, extra, {
      enumerable: true,
      get() {
        touched++;
        throw Error(CANARY);
      },
    });
    assert.throws(() => routeObservation(value), code('invalid'));
  }
  const bad = {
    ...base,
    audience: {
      toString() {
        touched++;
        return CANARY;
      },
    },
  };
  assert.throws(() => routeObservation(bad), code('invalid'));
  assert.equal(touched, 0);
  assert.deepEqual(routeStatistics([]).latency, { p50: null, p95: null });
});
test('real final classification records random scoped metadata, label CAS history and diagnostic stats without model input or hashes', async () => {
  const f = await routeFixture(() => ({
    json: { ...publicDecision(), extra: CANARY, prompt: CANARY, latency_ms: CANARY },
  }));
  try {
    const task = CANARY + ' implement ordinary tooling';
    const a = await f.rpc('route.classify', { privacy: 'public', text: task }),
      b = await f.rpc('route.classify', { privacy: 'public', text: task });
    assert.equal(a.observation.state, 'recorded');
    assert.notEqual(a.observation.id, b.observation.id);
    assert.equal(a.route.final, 'main');
    assert.equal(a.automaticDispatch, false);
    const listed = await f.rpc('route.observations', {});
    assert.equal(listed.observations.length, 2);
    for (const row of listed.observations) {
      assert.equal(row.router, ROUTE_MODEL);
      assert.equal(row.digest, ROUTE_DIGEST);
      assert.equal(row.threshold, 0.7);
      assert.equal(row.sessionKey, null);
    }
    const output = JSON.stringify([a, b, listed, storedRows(f.paths.state)]);
    for (const denied of [
      CANARY,
      crypto.createHash('sha256').update(task).digest('hex'),
      crypto.createHash('sha1').update(task).digest('hex').slice(0, 10),
    ])
      assert.ok(!output.includes(denied));
    const first = await f.cli(['router', 'label', a.observation.id, 'main']);
    assert.equal(first.code, 0, first.err);
    assert.equal(JSON.parse(first.out).label.version, 1);
    await assert.rejects(
      f.rpc('route.label', { id: a.observation.id, label: 'local', expectedVersion: 0 }),
      code('conflict'),
    );
    const corrected = await f.rpc('route.label', {
      id: a.observation.id,
      label: 'worker',
      expectedVersion: 1,
    });
    assert.equal(corrected.label.version, 2);
    assert.deepEqual(
      storedRows(f.paths.state, 'route_label_events').map((row) => row.label),
      ['main', 'worker'],
    );
    const stats = JSON.parse((await f.cli(['router', 'stats'])).out);
    assert.equal(stats.decisions, 2);
    assert.equal(stats.labeled, 1);
    assert.equal(stats.rawLabelAgreement, 1);
    assert.equal(stats.calibration, 'unverified');
    assert.equal(stats.automaticDispatch, false);
    assert.ok(!fs.readFileSync(path.join(f.paths.home, 'daemon.log'), 'utf8').includes(CANARY));
    assert.equal(f.calls(), 0);
    assert.deepEqual(f.sb.calls(), []);
  } finally {
    await f.close();
  }
});
test('recorded observations are project-bound; model callers cannot list or label them and MCP exposes no feedback tool', async () => {
  const f = await routeFixture();
  let mcp: Awaited<ReturnType<typeof mcpFixture>> | undefined;
  try {
    const value = await f.rpc(
      'route.classify',
      { privacy: 'public', text: 'Public coding task' },
      { ...f.scope, audience: 'model', sessionId: 'native_session_id' },
    );
    const rows = (await f.rpc('route.observations', {})).observations;
    assert.equal(rows[0].audience, 'model');
    assert.match(rows[0].sessionKey, /^[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(rows).includes('native_session_id'));
    for (const [method, params] of [
      ['route.observations', {}],
      ['route.stats', {}],
      ['route.label', { id: value.observation.id, label: 'main', expectedVersion: 0 }],
    ] as const)
      await assert.rejects(
        f.rpc(method, params, { ...f.scope, audience: 'model' }),
        code('unsupported'),
      );
    const other = gitRepo(f.sb, 'other');
    assert.equal(
      (await f.rpc('route.observations', {}, { ...f.scope, workspace: other })).observations.length,
      0,
    );
    await assert.rejects(
      f.rpc(
        'route.label',
        { id: value.observation.id, label: 'main', expectedVersion: 0 },
        { ...f.scope, workspace: other },
      ),
      code('not_found'),
    );
    mcp = await mcpFixture(f.env, f.workspace);
    assert.ok(
      !(await mcp.client.listTools()).tools.some((tool) =>
        /observations|route_label|route_stats/.test(tool.name),
      ),
    );
    assert.equal(storedRows(f.paths.state, 'route_labels').length, 0);
  } finally {
    await mcp?.close();
    await f.close();
  }
});
test('legacy inspection filters malformed or duplicate IDs and rejects links/oversize without rewriting original raw logs', async () => {
  const f = await runtimeFixture();
  const file = path.join(f.paths.home, 'route-log.jsonl'),
    id = '0123456789';
  const row = {
    id,
    ts: 1,
    lane: 'local',
    conf: 0.9,
    risk: 'low',
    risk_conf: 0.3,
    ms: 2,
    router: CANARY,
    prompt: CANARY,
    final: 'local',
    why: CANARY,
  };
  try {
    const original = JSON.stringify(row) + '\n' + JSON.stringify({ ...row, id: CANARY }) + '\n';
    fs.writeFileSync(file, original, { mode: 0o600 });
    const inspected = readLegacyRouteLog(f.paths.home);
    assert.equal(inspected.rows.length, 1);
    assert.ok(!JSON.stringify(inspected.rows).includes(CANARY));
    const result = await f.rpc('route.observations', { legacy: true });
    assert.equal(result.scope, 'unscoped');
    assert.equal(result.observations[0].router, 'legacy');
    await f.rpc('route.label', { id, label: 'worker', expectedVersion: 0, legacy: true });
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    assert.equal(fs.existsSync(path.join(f.paths.home, 'route-labels.jsonl')), false);
    fs.appendFileSync(file, JSON.stringify(row) + '\n');
    assert.equal(inspected.valid(), false);
    assert.equal((await f.rpc('route.observations', { legacy: true })).observations.length, 0);
    await assert.rejects(
      f.rpc('route.label', { id, label: 'main', expectedVersion: 1, legacy: true }),
      code('not_found'),
    );
    fs.unlinkSync(file);
    const outside = path.join(f.sb.root, 'raw-history');
    fs.writeFileSync(outside, original);
    fs.symlinkSync(outside, file);
    assert.throws(() => readLegacyRouteLog(f.paths.home), code('unavailable'));
    assert.equal(fs.readFileSync(outside, 'utf8'), original);
    fs.unlinkSync(file);
    fs.writeFileSync(file, original, { mode: 0o600 });
    fs.truncateSync(file, 1048577);
    assert.throws(() => readLegacyRouteLog(f.paths.home), code('unavailable'));
  } finally {
    await f.close();
  }
});
test('lost actual label COMMIT preserves its original native event, fences storage, and stale CAS cannot replay it on reopen', async () => {
  const f = await routeFixture();
  let id = '';
  try {
    id = (await f.rpc('route.classify', { privacy: 'public', text: 'Public task' })).observation.id;
  } finally {
    await f.runtime.close();
  }
  const owner = new DaemonOwner(f.paths.owner);
  let storage: SqliteJobStore | undefined;
  const exec = SqliteDatabase.prototype.exec;
  let commits = 0;
  try {
    storage = new SqliteJobStore({ file: f.paths.state, assertOwner: () => owner.assert() });
    SqliteDatabase.prototype.exec = function (sql) {
      const value = exec.call(this, sql);
      if (sql === 'COMMIT') {
        commits++;
        throw Error(CANARY);
      }
      return value;
    };
    const scope = {
      projectId: storedRows(f.paths.state)[0].project_key as string,
      audience: 'owner' as const,
    };
    assert.throws(
      () => storage!.labelRoute(scope, id, 'worker', 0, 'recorded', Date.now()),
      (error: unknown) => error instanceof BosunError && error.details?.outcome === 'unknown',
    );
    SqliteDatabase.prototype.exec = exec;
    assert.equal(commits, 1);
    assert.equal(storedRows(f.paths.state, 'route_label_events').length, 1);
    assert.throws(() => storage!.labelRoute(scope, id, 'worker', 0, 'recorded', Date.now()));
    storage.close();
    storage = new SqliteJobStore({ file: f.paths.state, assertOwner: () => owner.assert() });
    assert.equal(storage.routeLabels(scope, 'recorded')[0].version, 1);
    assert.throws(
      () => storage!.labelRoute(scope, id, 'worker', 0, 'recorded', Date.now()),
      code('conflict'),
    );
    assert.equal(storedRows(f.paths.state, 'route_label_events').length, 1);
  } finally {
    SqliteDatabase.prototype.exec = exec;
    storage?.close();
    owner.close();
    await f.close();
  }
});
test('historical labels stay read-only references with unknown time; explicit daemon feedback overrides them without copying raw files', async () => {
  const f = await runtimeFixture();
  try {
    const id = '0123456789',
      file = path.join(f.paths.home, 'route-log.jsonl'),
      labels = path.join(f.paths.home, 'route-labels.jsonl');
    const log =
      JSON.stringify({
        id,
        ts: 1,
        lane: 'local',
        conf: 0.9,
        risk: 'low',
        risk_conf: 0.3,
        ms: 12,
        router: CANARY,
        prompt: CANARY,
      }) + '\n{"half-writ\n';
    const feedback =
      JSON.stringify({ id, label: 'main', extra: CANARY }) +
      '\n' +
      JSON.stringify({ id, label: 'worker' }) +
      '\n';
    fs.writeFileSync(file, log, { mode: 0o600 });
    fs.writeFileSync(labels, feedback, { mode: 0o600 });
    const snapshot = readLegacyRouteLog(f.paths.home);
    const listed = await f.rpc('route.observations', { legacy: true });
    assert.equal(listed.observations[0].label.label, 'worker');
    assert.equal(listed.observations[0].label.version, 0);
    assert.equal(listed.observations[0].label.at, null);
    assert.ok(!JSON.stringify(listed).includes(CANARY));
    await f.rpc('route.label', { id, label: 'local', expectedVersion: 0, legacy: true });
    const current = (await f.rpc('route.observations', { legacy: true })).observations[0].label;
    assert.equal(current.label, 'local');
    assert.equal(current.version, 1);
    assert.ok(current.at > 0);
    assert.equal(fs.readFileSync(file, 'utf8'), log);
    assert.equal(fs.readFileSync(labels, 'utf8'), feedback);
    fs.appendFileSync(labels, '\n');
    assert.equal(snapshot.valid(), false);
    assert.equal(storedRows(f.paths.state).length, 0);
  } finally {
    await f.close();
  }
});
test('actual observation capacity remains bounded, and source change after label DML rolls back label and original history', () => {
  const sb = sandbox(),
    dir = path.join(sb.root, 'route-state');
  fs.mkdirSync(dir, { mode: 0o700 });
  const owner = new DaemonOwner(path.join(dir, 'owner.db'));
  const store = new SqliteJobStore({
    file: path.join(dir, 'state.db'),
    assertOwner: () => owner.assert(),
  });
  const scope = { projectId: 'p_' + 'a'.repeat(16), audience: 'owner' as const };
  let id = '';
  try {
    for (let i = 0; i < 4096; i++) {
      id = crypto.randomUUID();
      store.recordRoute(scope, {
        schema: 1,
        id,
        at: i,
        projectId: scope.projectId,
        sessionKey: null,
        audience: 'owner',
        digest: ROUTE_DIGEST,
        threshold: 0.7,
        lane: 'worker',
        conf: 0.7,
        risk: 'high',
        risk_conf: 0.7,
        ms: 4,
        router: ROUTE_MODEL,
        final: 'main',
        why: 'risk=high overrides worker',
      });
    }
    const prior = store.listRoutes(scope, 4096);
    assert.throws(
      () => store.recordRoute(scope, { ...prior[0], id: crypto.randomUUID() }),
      code('unavailable'),
    );
    assert.deepEqual(store.listRoutes(scope, 4096), prior);
    let checks = 0;
    assert.throws(
      () => store.labelRoute(scope, id, 'main', 0, 'recorded', 10000, () => ++checks === 1),
      code('conflict'),
    );
    assert.equal(checks, 2);
    assert.deepEqual(store.routeLabels(scope, 'recorded'), []);
    assert.equal(storedRows(path.join(dir, 'state.db'), 'route_label_events').length, 0);
    assert.equal(store.labelRoute(scope, id, 'worker', 0, 'recorded', 10001).version, 1);
  } finally {
    store.close();
    owner.close();
    sb.cleanup();
  }
});
test('lost native observation COMMIT returns usable advice with its unknown original ID and records no prompt or automatic retry', async () => {
  const f = await routeFixture(),
    exec = SqliteDatabase.prototype.exec;
  let commits = 0;
  try {
    SqliteDatabase.prototype.exec = function (sql) {
      const value = exec.call(this, sql);
      if (sql === 'COMMIT') {
        commits++;
        throw Error(CANARY);
      }
      return value;
    };
    const result = await f.rpc('route.classify', {
      privacy: 'public',
      text: 'Public task ' + CANARY,
    });
    SqliteDatabase.prototype.exec = exec;
    assert.equal(result.route.final, 'main');
    assert.equal(result.observation.state, 'unknown');
    assert.equal(commits, 1);
    const persisted = storedRows(f.paths.state);
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].id, result.observation.id);
    assert.ok(!JSON.stringify(persisted).includes(CANARY));
    assert.equal(f.server.requests.filter((row) => row.path === '/v1/systemone').length, 1);
    await assert.rejects(f.rpc('route.stats', {}), code('unavailable'));
  } finally {
    SqliteDatabase.prototype.exec = exec;
    try {
      await f.close();
    } catch (error) {
      assert.ok(error instanceof BosunError);
    }
  }
});
