import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SqliteDatabase } from '../src/platform/sqlite.ts';
import { bosun, mock, mcpSession, gitRepo } from './helpers.ts';
import { runtimeFixture } from './runtime-fixture.ts';
import { remoteFixture, OWNER } from './remote-fixture.ts';
import { remoteNetwork, remoteEndpoint } from '../src/platform/remote-policy.ts';
import { parseRuntimeConfig } from '../src/platform/config.ts';
import { RPC_LIMITS } from '../src/contracts/rpc.ts';
import { serveRemoteRpc } from '../src/adapters/transport/remote-rpc-server.ts';
import { BosunError } from '../src/core/errors.ts';
import { project } from '../src/platform/project.ts';
import { createClefRouter } from '../src/adapters/routers/ollama-clef.ts';
import { readInstallationPlan } from '../src/app/installation.ts';
import { version } from '../src/platform/assets.ts';

type Rpc = (method: string, params: Record<string, unknown>, foreign?: boolean) => Promise<any>;
async function operations(rpc: Rpc) {
  const result: unknown[] = [];
  async function error(method: string, params: Record<string, unknown>, foreign = false) {
    try {
      await rpc(method, params, foreign);
      return 'no error';
    } catch (value) {
      assert.ok(value instanceof BosunError);
      return value.code;
    }
  }
  const input = {
    category: 'project',
    title: 'Use pnpm',
    body: 'pnpm only; npm breaks the lockfile',
    tags: ['tooling'],
  };
  const created = await rpc('memory.store', input),
    id = created.memory.id;
  result.push(['store', created.duplicate, created.memory.version, created.memory.status]);
  result.push(['duplicate', (await rpc('memory.store', input)).duplicate]);
  result.push([
    'search',
    (await rpc('memory.search', { text: 'lockfile' })).hits.map((row: any) => row.title),
  ]);
  result.push([
    'audit',
    (await rpc('memory.get', { id, events: true })).memory.events.map((row: any) => row.op),
  ]);
  result.push([
    'update',
    (await rpc('memory.update', { id, expectedVersion: 1, patch: { body: 'pnpm only.' } })).memory
      .version,
  ]);
  result.push([
    'conflict',
    await error('memory.update', { id, expectedVersion: 1, patch: { body: 'stale' } }),
  ]);
  const denied = await error('memory.get', { id }, true);
  assert.ok(['not_found', 'unsupported', 'unavailable'].includes(denied), denied);
  result.push(['scope', 'denied']);
  result.push([
    'invalid',
    await error('memory.store', { category: 'nope', title: 'Invalid', body: 'Invalid' }),
  ]);
  for (const action of ['accept', 'reject']) {
    const proposal = await rpc('memory.store', {
      category: 'project',
      title: action + ' proposal',
      body: action + ' public proposal',
      status: 'proposed',
    });
    result.push([
      action,
      (await rpc('memory.' + action, { id: proposal.memory.id })).memory.status,
    ]);
  }
  result.push(['delete', (await rpc('memory.delete', { id })).memory.status]);
  return result;
}
function rows(file: string) {
  const db = new SqliteDatabase(file, { readOnly: true });
  try {
    return db.prepare('SELECT id,private,shared,version,hash,body FROM memories ORDER BY id').all();
  } finally {
    db.close();
  }
}
const headers = (f: Awaited<ReturnType<typeof remoteFixture>>) => ({
  authorization: 'Bearer ' + OWNER,
  'x-bosun-project': project(f.clientWorkspace).id,
  'x-bosun-authority': f.manifest.installationId,
  'content-type': 'application/json',
});
async function installFixture(side: 'client' | 'server' = 'client') {
  const f = await remoteFixture(
    false,
    undefined,
    '[roles.worker.codex]\nmodel="owner-server-model"\neffort="high"\n',
    '[roles.worker.codex]\nmodel="owner-client-model"\neffort="high"\n',
  );
  try {
    const original = (
      await f.rpc('client', 'memory.store', {
        category: 'project',
        title: 'Retained original',
        body: 'Original authority note.',
        private: true,
      })
    ).memory;
    await f.client.close();
    await f.server.close();
    const env = side === 'client' ? f.clientEnv : f.serverEnv;
    const paths = side === 'client' ? f.clientPaths : f.serverPaths;
    const workspace = side === 'client' ? f.clientWorkspace : f.serverWorkspace;
    const binary = path.join(f.sb.root, 'synthetic-bosun-release');
    fs.writeFileSync(
      binary,
      '#!/usr/bin/env node\nif(process.argv.slice(2).join(" ")!=="--version")process.exit(2);\nprocess.stdout.write(' +
        JSON.stringify(version + '\n') +
        ');\n',
      { mode: 0o755 },
    );
    const planFile = path.join(f.sb.root, 'install-plan.json');
    const personal = path.join(f.sb.home, '.zshrc');
    fs.writeFileSync(personal, 'Owner shell settings\n');
    const data = [
      f.clientPaths.config,
      f.serverPaths.config,
      f.clientPaths.memory,
      f.serverPaths.memory,
    ];
    const before = data.map((file) => ({
      file,
      ino: fs.statSync(file).ino,
      bytes: fs.readFileSync(file),
    }));
    const cli = (args: string[]) => bosun(args, { env, cwd: workspace });
    return { ...f, env, paths, workspace, binary, planFile, personal, original, before, cli };
  } catch (error) {
    await f.close();
    throw error;
  }
}
function retained(f: Awaited<ReturnType<typeof installFixture>>) {
  for (const record of f.before) {
    assert.equal(fs.statSync(record.file).ino, record.ino);
    assert.deepEqual(fs.readFileSync(record.file), record.bytes);
  }
  assert.equal(fs.readFileSync(f.personal, 'utf8'), 'Owner shell settings\n');
  assert.equal(rows(f.serverPaths.memory)[0].id, f.original.id);
  assert.ok(
    !f.sb
      .calls()
      .some((call) => ['ollama', 'uv', 'brew', 'launchctl', 'claude', 'codex'].includes(call.bin)),
  );
}
async function planAndApply(f: Awaited<ReturnType<typeof installFixture>>) {
  const planned = await f.cli([
    'install',
    'plan',
    '--binary',
    f.binary,
    '--request-id',
    'remote_install',
    '--output',
    f.planFile,
  ]);
  assert.equal(planned.code, 0, planned.err);
  const plan = readInstallationPlan(f.planFile);
  const applied = await f.cli([
    'install',
    'apply',
    f.planFile,
    '--hash',
    plan.planHash,
    '--clients-stopped',
  ]);
  assert.equal(applied.code, 0, applied.err);
  return { plan, applied: JSON.parse(applied.out) };
}
test('final authenticated authority and local daemon preserve identical memory operations, audit, conflict and scope outcomes', async () => {
  const remote = await remoteFixture();
  let expected: unknown[];
  try {
    const remoteRpc: Rpc = (method, params, foreign) =>
      remote.rpc(
        'client',
        method,
        params,
        'owner',
        foreign ? remote.otherWorkspace : remote.clientWorkspace,
      );
    expected = await operations(remoteRpc);
    assert.deepEqual(rows(remote.clientPaths.memory), []);
    const context = await remote.rpc('client', 'context.retrieve', {
      task: 'accept public proposal',
      sources: ['curated'],
    });
    assert.ok(context.ids.length > 0);
    assert.deepEqual(remote.sb.calls(), []);
  } finally {
    await remote.close();
  }
  // Each daemon owns one process logging authority. Compare the local arm after remote close.
  const local = await runtimeFixture();
  try {
    const other = gitRepo(local.sb, 'foreign-checkout', 'git@example.com:team/other.git');
    const localRpc: Rpc = (method, params, foreign) =>
      local.rpc(method, params, foreign ? { ...local.scope, workspace: other } : local.scope);
    assert.deepEqual(await operations(localRpc), expected);
  } finally {
    await local.close();
  }
});

test('final remote CIDRs reject unlisted peers before auth, require canonical project roots and hold public bind without TLS', async () => {
  const allow = remoteNetwork(['127.0.0.1/32', '100.64.0.0/10', '::1/128']);
  for (const address of ['127.0.0.1', '::ffff:127.0.0.1', '100.101.102.103', '::1'])
    assert.equal(allow(address), true);
  for (const address of [undefined, '8.8.8.8', 'fe80::1', '192.168.1.77'])
    assert.equal(allow(address), false);
  const lan = remoteNetwork(['192.168.1.5/24']);
  assert.equal(lan('192.168.1.77'), true);
  assert.equal(lan('192.168.2.77'), false);
  assert.throws(
    () => remoteEndpoint('http://100.101.102.103:8788'),
    (value) => value instanceof BosunError && value.code === 'invalid',
  );
  const f = await remoteFixture(false, undefined, '', '', ['10.0.0.0/8']);
  try {
    await assert.rejects(
      serveRemoteRpc({
        settings: { ...f.serverConfig.remote, bind: '0.0.0.0' },
        env: f.serverEnv,
        identity: {
          protocol: 1,
          version,
          memorySchema: 2,
          authorityId: f.manifest.installationId,
          sourceId: f.manifest.sourceId,
        },
        assertOwner() {
          throw Error('UNEXPECTED OWNER ACCESS');
        },
        async dispatch() {
          throw Error('UNEXPECTED DISPATCH');
        },
        port: 0,
      }),
      (value) => value instanceof BosunError && value.code === 'invalid',
    );
    const reply = await fetch(f.endpoint + '/v1/identity', { headers: headers(f) });
    assert.equal(reply.status, 403);
    assert.equal((await reply.json()).error.code, 'unsupported');
    assert.deepEqual(rows(f.serverPaths.memory), []);
  } finally {
    await f.close();
  }
});

test('final remote request bounds and media type errors are finite and create no memory effects', async () => {
  const f = await remoteFixture();
  try {
    for (const [type, body] of [
      ['text/plain', 'not JSON'],
      ['application/json', 'x'.repeat(RPC_LIMITS.requestBytes + 1)],
      ['application/json', '{"payload":"RAW-PARSER-CANARY"'],
    ]) {
      const reply = await fetch(f.endpoint + '/v1/rpc', {
        method: 'POST',
        headers: { ...headers(f), 'content-type': type },
        body,
      });
      assert.equal(reply.status, 400);
      const value = await reply.json();
      assert.equal(value.ok, false);
      assert.equal(value.error.code, 'invalid');
      assert.doesNotMatch(JSON.stringify(value), /RAW-PARSER-CANARY|SyntaxError|Unexpected token/);
    }
    assert.deepEqual(rows(f.serverPaths.memory), []);
  } finally {
    await f.close();
  }
});

test('final remote outage gives finite CLI and MCP failure with no queued write, local L1 fallback or hook inference', async () => {
  const f = await remoteFixture();
  try {
    await f.rpc('client', 'memory.store', {
      category: 'project',
      title: 'Authoritative package manager',
      body: 'Remote pnpm instructions.',
    });
    await f.server.close();
    const search = await bosun(['memory', 'search', 'pnpm'], {
      env: f.clientEnv,
      cwd: f.clientWorkspace,
    });
    assert.equal(search.code, 1);
    assert.equal(JSON.parse(search.err).error.code, 'unavailable');
    const session = mcpSession(f.clientEnv, f.clientWorkspace);
    try {
      const reply = await session.call('memory_store', {
        category: 'project',
        title: 'Offline write',
        body: 'Do not create this note.',
      });
      assert.equal(reply.result.isError, true);
      assert.equal(reply.result.structuredContent.error.code, 'unavailable');
    } finally {
      await session.close();
    }
    const hook = await bosun(['hook'], {
      env: f.clientEnv,
      cwd: f.clientWorkspace,
      input: JSON.stringify({ prompt: 'Remote pnpm instructions', cwd: f.clientWorkspace }),
    });
    assert.equal(hook.code, 0);
    assert.equal(hook.out, '');
    assert.deepEqual(rows(f.clientPaths.memory), []);
    assert.equal(rows(f.serverPaths.memory).length, 1);
    assert.equal(f.client.status().remote.offlineWrites, false);
  } finally {
    await f.close();
  }
});

test('foreign and hanging authorities receive no hook task or mutation payload; final hook completes without network inference', async () => {
  const peer = await mock({
    '/v1/identity': () => ({ delayMs: 1500, text: '<html>FOREIGN-REPLY-CANARY</html>' }),
  });
  const f = await remoteFixture(false, async () => peer.url);
  try {
    const count = peer.requests.length,
      start = performance.now();
    const hook = await bosun(['hook'], {
      env: f.clientEnv,
      cwd: f.clientWorkspace,
      input: JSON.stringify({ prompt: 'HOOK-PRIVATE-CANARY', cwd: f.clientWorkspace }),
    });
    assert.equal(hook.code, 0);
    assert.equal(hook.out, '');
    assert.equal(peer.requests.length, count);
    assert.ok(performance.now() - start < 5000);
    const result = await bosun(
      [
        'memory',
        'add',
        '--category',
        'project',
        '--title',
        'Never sent',
        '--body',
        'MUTATION-CANARY',
      ],
      { env: f.clientEnv, cwd: f.clientWorkspace },
    );
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.err).error.code, 'unavailable');
    assert.ok(
      peer.requests.every(
        (request) =>
          request.path === '/v1/identity' && request.method === 'GET' && request.body === null,
      ),
    );
    assert.deepEqual(rows(f.clientPaths.memory), []);
  } finally {
    try {
      await f.close();
    } finally {
      await peer.close();
    }
  }
});

test('final doctor reports filesystem evidence without opening owner data or probing remote/model endpoints', async () => {
  const peer = await mock(),
    f = await remoteFixture(false, async () => peer.url);
  try {
    const files = [f.clientPaths.memory, f.clientPaths.config, f.serverPaths.memory];
    const before = files.map((file) => ({
      ino: fs.statSync(file).ino,
      bytes: fs.readFileSync(file),
    }));
    const count = peer.requests.length,
      calls = f.sb.calls().length;
    const result = await bosun(['doctor'], { env: f.clientEnv, cwd: f.clientWorkspace });
    assert.equal(result.code, 1, result.err);
    assert.equal(JSON.parse(result.err).error.code, 'unavailable');
    const report = JSON.parse(result.out);
    assert.equal(report.prepared, false);
    assert.ok(report.checks.some((check: any) => check.state === 'held'));
    assert.equal(report.coverage, 'filesystem-metadata');
    assert.equal(report.nativeCalls, false);
    assert.equal(report.databaseOpened, false);
    assert.equal(report.schemaQualification, 'unverified');
    assert.equal(peer.requests.length, count);
    assert.equal(f.sb.calls().length, calls);
    files.forEach((file, n) => {
      assert.equal(fs.statSync(file).ino, before[n].ino);
      assert.deepEqual(fs.readFileSync(file), before[n].bytes);
    });
  } finally {
    try {
      await f.close();
    } finally {
      await peer.close();
    }
  }
});

test('explicit Clef endpoint selection preserves the model and sends only public advice; absent calibration never starts a worker or proxy', async () => {
  const selected = 'clef-flash:owner-tag';
  const peer = await mock({
    '/v1/systemone': () => ({
      json: {
        model: selected,
        latency_ms: 12,
        usage: { input_tokens: 12, output_tokens: 2 },
        answers: {
          lane: {
            type: 'choice',
            choice: 'local',
            confidence: 0.9,
            probabilities: { main: 0.01, worker: 0.05, local: 0.9, scout: 0.04 },
          },
          risk: {
            type: 'choice',
            choice: 'low',
            confidence: 0.9,
            probabilities: { high: 0.1, low: 0.9 },
          },
        },
      },
    }),
  });
  try {
    const config = parseRuntimeConfig(
      '[router]\nurl=' + JSON.stringify(peer.url) + '\nmodel=' + JSON.stringify(selected) + '\n',
    );
    const router = createClefRouter(config.router);
    const reply = await router.classify(
      { privacy: 'public', text: 'rename a to b' },
      AbortSignal.timeout(1000),
    );
    assert.ok(reply);
    assert.equal(reply.lane, 'local');
    assert.equal(peer.requests.length, 1);
    assert.equal(peer.requests[0].body.model, selected);
    assert.equal(router.qualification.autonomousDelegation, 'unsupported');
    await assert.rejects(
      router.classify(
        { privacy: 'private', text: 'PRIVATE-ROUTER-CANARY' },
        AbortSignal.timeout(1000),
      ),
    );
    assert.equal(peer.requests.length, 1);
  } finally {
    await peer.close();
  }
});

test('final remote-client installation preserves authority URLs, data/models and shell settings; exact undo retires only owned files', async () => {
  const f = await installFixture();
  try {
    const { plan, applied } = await planAndApply(f);
    assert.equal(applied.record.state, 'ready');
    assert.equal(applied.record.service.state, 'prepared');
    assert.equal(fs.existsSync(plan.service.target), false);
    retained(f);
    const undo = await f.cli([
      'uninstall',
      plan.id,
      '--version',
      String(applied.record.version),
      '--hash',
      plan.planHash,
      '--clients-stopped',
    ]);
    assert.equal(undo.code, 0, undo.err);
    assert.equal(JSON.parse(undo.out).record.state, 'undone');
    assert.equal(fs.existsSync(plan.targetBinary), false);
    retained(f);
  } finally {
    await f.close();
  }
});

test('final server installation prepares one owned dormant daemon and wires no host, model or obsolete service', async () => {
  const f = await installFixture('server');
  try {
    const { plan, applied } = await planAndApply(f);
    assert.equal(applied.record.service.state, 'prepared');
    assert.equal(fs.existsSync(plan.service.target), false);
    const plist = fs.readFileSync(plan.service.file, 'utf8');
    assert.ok(plist.includes(plan.targetBinary));
    assert.ok(plist.includes('daemon'));
    assert.doesNotMatch(plist, /kev|ollama|uv|ANTHROPIC|CODEX_HOME/i);
    assert.equal(fs.existsSync(path.join(f.sb.home, '.claude')), false);
    assert.equal(fs.existsSync(path.join(f.sb.home, '.codex')), false);
    retained(f);
  } finally {
    await f.close();
  }
});

test('duplicate final installation retains remote selection with no local model pull, service bootstrap or configuration rewrite; bad options are inert', async () => {
  const f = await installFixture();
  try {
    const { plan, applied } = await planAndApply(f);
    const before = f.sb.calls().length;
    const repeated = await f.cli([
      'install',
      'apply',
      f.planFile,
      '--hash',
      plan.planHash,
      '--clients-stopped',
    ]);
    assert.equal(repeated.code, 0, repeated.err);
    assert.equal(JSON.parse(repeated.out).record.id, applied.record.id);
    assert.equal(JSON.parse(repeated.out).duplicate, true);
    assert.equal(f.sb.calls().length, before);
    retained(f);
    for (const [args, code] of [
      [['--remote', 'unknown=ftp://bad'], 2],
      [['--serve', 'kev'], 2],
      [['apply', f.planFile, '--hash', 'invalid'], 3],
    ] as const) {
      const denied = await f.cli(['install', ...args]);
      assert.equal(denied.code, code, denied.err);
      retained(f);
    }
  } finally {
    await f.close();
  }
});
