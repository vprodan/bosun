import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { SqliteDatabase } from '../src/platform/sqlite.ts';
import { bosun, mock } from './helpers.ts';
import { main } from '../src/app/cli.ts';
import { callRemoteRpc } from '../src/adapters/transport/remote-rpc.ts';
import { project } from '../src/platform/project.ts';
import { remoteNetwork, remoteEndpoint } from '../src/platform/remote-policy.ts';
import { BosunError } from '../src/core/errors.ts';
import type { RpcRequest } from '../src/contracts/rpc.ts';
import { RemoteViewReadOnly } from '../src/adapters/memory/remote-view-readonly.ts';
import { loadHookConfig } from '../src/platform/hook-config.ts';

import { remoteFixture as fixture, MODEL } from './remote-fixture.ts';
test('remote embedding jobs and vector queries use only the authority corpus and preserve source privacy revocation', async () => {
  const model = 'authority-embedding:fixture',
    digest = 'a'.repeat(64);
  const backend = await mock({
    '/api/tags': () => ({ json: { models: [{ model, digest }] } }),
    '/api/show': () => ({ json: { capabilities: ['embedding'] } }),
    '/api/embed': (body) => ({ json: { model, embeddings: body.input.map(() => [1, 0, 0]) } }),
  });
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    f = await fixture(
      false,
      undefined,
      `[graph]\nvectors=true\n[graph.embedding]\nmodel="${model}"\nurl="${backend.url}"\ndigest="${digest}"\ndimensions=3\nbackend="reference"\ntimeoutMs=1000\n`,
      '[graph]\nvectors=true\n',
    );
    const note = (
      await f.rpc('client', 'memory.store', {
        category: 'project',
        title: 'Authority rules',
        body: 'Authority uses pnpm for package installation.',
      })
    ).memory;
    const input = { privacy: 'public', requestId: 'remote_index', ids: [note.id] };
    const queued = await f.rpc('client', 'memory.embed', input);
    let job = await f.rpc('client', 'job.get', { id: queued.job.id });
    for (let n = 0; n < 200 && ['queued', 'running'].includes(job.state); n++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      job = await f.rpc('client', 'job.get', { id: queued.job.id });
    }
    assert.equal(job.state, 'succeeded');
    assert.equal((await f.rpc('client', 'memory.embed', input)).job.id, job.id);
    await assert.rejects(f.rpc('client', 'memory.embed', input, 'model'));
    const query = {
      task: 'Which package manager?',
      sources: ['vectors'],
      privacy: 'public',
      includeCandidates: true,
    };
    const reply = await f.rpc('client', 'context.retrieve', query, 'model');
    assert.deepEqual(reply.ids, [note.id]);
    assert.deepEqual(reply.candidates, [{ id: note.id, source: 'vectors' }]);
    assert.match(reply.text, /Authority uses pnpm/);
    const embeddings = backend.requests.filter((r) => r.path === '/api/embed');
    assert.equal(embeddings.length, 2);
    assert.ok(embeddings.every((r) => r.body.model === model));
    const count = backend.requests.length;
    await assert.rejects(
      f.rpc('client', 'context.retrieve', { ...query, privacy: 'unknown' }, 'model'),
    );
    await f.rpc('server', 'memory.update', {
      id: note.id,
      expectedVersion: note.version,
      patch: { private: true },
    });
    const revoked = await f.rpc('client', 'context.retrieve', query, 'model');
    assert.deepEqual(revoked.ids, []);
    assert.deepEqual(revoked.candidates, []);
    assert.equal(
      backend.requests.length,
      count,
      'empty revoked authority corpus makes no model calls',
    );
    const db = new SqliteDatabase(f.clientPaths.memory, { readOnly: true });
    try {
      assert.equal(db.prepare('SELECT COUNT(*) n FROM memories').get()!.n, 0);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM memory_embeddings').get()!.n, 0);
    } finally {
      db.close();
    }
    assert.deepEqual(f.sb.calls(), []);
  } finally {
    try {
      await f?.close();
    } finally {
      await backend.close();
    }
  }
});
test('remote automatic note suggestions execute once at the authority, preserve the pinned model and never write client L1', async () => {
  const model = 'authority-only-suggestion-model';
  const backend = await mock({
    '/api/tags': () => ({ json: { models: [{ model }] } }),
    '/api/show': () => ({ json: { capabilities: ['completion'] } }),
    '/api/chat': () => ({
      json: {
        model,
        done: true,
        done_reason: 'stop',
        message: {
          role: 'assistant',
          content: JSON.stringify({ title: 'Suggested authority title', tags: ['authority tag'] }),
        },
      },
    }),
  });
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    f = await fixture(
      false,
      undefined,
      `[providers.default]\nkind="ollama"\nmodel=${JSON.stringify(model)}\nurl=${JSON.stringify(backend.url)}\ntimeoutMs=1000\n`,
    );
    const input = {
      privacy: 'public',
      requestId: 'remote_auto_note',
      category: 'project',
      body: 'Public note saved at the authority',
      title: 'Explicit owner title',
    };
    const queued = await f.rpc('client', 'memory.autoStore', input);
    let job = await f.rpc('client', 'job.get', { id: queued.job.id });
    for (let n = 0; n < 200 && ['queued', 'running'].includes(job.state); n++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      job = await f.rpc('client', 'job.get', { id: queued.job.id });
    }
    assert.equal(job.state, 'succeeded');
    const result = JSON.parse((await f.rpc('client', 'job.result', { id: job.id })).result);
    const stored = (await f.rpc('server', 'memory.get', { id: result.memory.id })).memory;
    assert.equal(stored.title, input.title);
    assert.equal(stored.body, input.body);
    assert.deepEqual(stored.tags, ['authority-tag']);
    assert.equal(stored.private, false);
    const repeated = await f.rpc('client', 'memory.autoStore', input);
    assert.equal(repeated.duplicate, true);
    assert.equal(repeated.job.id, job.id);
    await assert.rejects(f.rpc('client', 'memory.autoStore', input, 'model'));
    const chats = backend.requests.filter((row) => row.path === '/api/chat');
    assert.equal(chats.length, 1);
    assert.equal(chats[0].body.model, model);
    const db = new SqliteDatabase(f.clientPaths.memory, { readOnly: true });
    try {
      assert.equal(db.prepare('SELECT count(*) AS n FROM memories').get()!.n, 0);
    } finally {
      db.close();
    }
    assert.deepEqual(f.sb.calls(), []);
  } finally {
    try {
      await f?.close();
    } finally {
      await backend.close();
    }
  }
});
function cachedReader(f: Awaited<ReturnType<typeof fixture>>, now = Date.now) {
  const cfg = loadHookConfig(f.clientPaths)!;
  const ctx = {
    projectId: project(f.clientWorkspace).id,
    sessionId: null,
    linked: [],
    source: 'test:view',
  };
  return {
    ctx,
    reader: new RemoteViewReadOnly(
      path.join(f.clientPaths.home, 'remote-view.db'),
      {
        authorityId: cfg.memory.remoteAuthorityId!,
        clientId: cfg.memory.remoteClientId!,
        clientSourceId: cfg.memory.sourceId!,
        configRevision: cfg.configRevision,
      },
      ctx,
      now,
    ),
  };
}
test('owner refresh enables useful offline hook context without copying private, expiring or proposed source rows', async () => {
  const f = await fixture();
  try {
    const note = await f.rpc('server', 'memory.store', {
      category: 'project',
      title: 'Offline package manager',
      body: 'Use pnpm offline package manager.',
    });
    await f.rpc('server', 'memory.store', {
      category: 'project',
      title: 'PRIVATE-CACHE-CANARY',
      body: 'PRIVATE-CACHE-BODY',
      private: true,
    });
    await f.rpc('server', 'memory.store', {
      category: 'session',
      title: 'Expiring session',
      body: 'Finite session lifetime.',
      shared: true,
    });
    await f.rpc('server', 'memory.store', {
      category: 'project',
      title: 'Proposed cache',
      body: 'Unreviewed content.',
      status: 'proposed',
    });
    await assert.rejects(f.rpc('client', 'remote.view.refresh', { privacy: 'public' }, 'model'));
    const output: string[] = [];
    assert.equal(
      await main(['remote-view', 'refresh', '--public'], {
        env: f.clientEnv,
        cwd: f.clientWorkspace,
        stdout: (value) => output.push(value),
      }),
      0,
    );
    assert.equal(JSON.parse(output.join('')).rows, 1);
    const db = new SqliteDatabase(path.join(f.clientPaths.home, 'remote-view.db'), {
      readOnly: true,
    });
    try {
      const json = String(db.prepare('SELECT snapshot FROM remote_view').get()!.snapshot);
      assert.ok(json.includes(note.memory.id));
      assert.ok(!json.includes('PRIVATE-CACHE'));
      assert.ok(!json.includes('Expiring session'));
    } finally {
      db.close();
    }
    const input = JSON.stringify({
      prompt: 'offline package manager pnpm',
      cwd: f.clientWorkspace,
      private: false,
    });
    const live = await bosun(['hook'], { env: f.clientEnv, cwd: f.clientWorkspace, input });
    assert.match(live.out, /Use pnpm/);
    const wrong = await bosun(['hook'], {
      env: f.clientEnv,
      cwd: f.otherWorkspace,
      input: JSON.stringify({ prompt: 'offline package manager pnpm', cwd: f.otherWorkspace }),
    });
    assert.equal(wrong.out, '');
    await f.client.close();
    await f.server.close();
    const offline = await bosun(['hook'], { env: f.clientEnv, cwd: f.clientWorkspace, input });
    assert.match(offline.out, /Use pnpm/);
  } finally {
    await f.close();
  }
});
test('native cache reader blocks release and source privacy changes until HOLD commits; private and deleted rows cannot reappear', async () => {
  const f = await fixture();
  try {
    const note = await f.rpc('server', 'memory.store', {
      category: 'project',
      title: 'Reader lease note',
      body: 'Reader lease useful pnpm note.',
    });
    await f.rpc('client', 'remote.view.refresh', { privacy: 'public' });
    const { reader, ctx } = cachedReader(f);
    try {
      assert.equal((await reader.get(note.memory.id, ctx)).body, note.memory.body);
      await assert.rejects(
        f.rpc('client', 'remote.view.invalidate', {}),
        (error) => error instanceof BosunError && error.code === 'conflict',
      );
      await assert.rejects(
        f.rpc('server', 'memory.update', {
          id: note.memory.id,
          expectedVersion: 1,
          patch: { private: true },
        }),
        (error) => error instanceof BosunError && error.code === 'conflict',
      );
      assert.equal((await f.rpc('server', 'memory.get', { id: note.memory.id })).memory.version, 1);
      reader.validate();
    } finally {
      reader.close();
    }
    assert.equal((await f.rpc('client', 'remote.view.invalidate', {})).state, 'empty');
    assert.throws(() => cachedReader(f));
    const changed = await f.rpc('server', 'memory.update', {
      id: note.memory.id,
      expectedVersion: 1,
      patch: { private: true },
    });
    assert.equal(changed.memory.id, note.memory.id);
    assert.equal(changed.memory.version, 2);
    assert.equal((await f.rpc('client', 'remote.view.refresh', { privacy: 'public' })).rows, 0);
    const { reader: empty, ctx: scope } = cachedReader(f);
    try {
      assert.deepEqual(await empty.search({ text: 'pnpm' }, scope), []);
    } finally {
      empty.close();
    }
    await f.rpc('client', 'remote.view.invalidate', {});
    await f.rpc('server', 'memory.delete', { id: note.memory.id });
    assert.equal((await f.rpc('client', 'remote.view.refresh', { privacy: 'public' })).rows, 0);
  } finally {
    await f.close();
  }
});
test('authority restart retains remote leases; client restart invalidates the old view without replay or lease adoption', async () => {
  const f = await fixture();
  try {
    const note = await f.rpc('server', 'memory.store', {
      category: 'project',
      title: 'Restart lease note',
      body: 'Retained server lease.',
    });
    const before = await f.rpc('client', 'remote.view.refresh', { privacy: 'public' });
    await f.restartServer();
    await assert.rejects(
      f.rpc('server', 'memory.delete', { id: note.memory.id }),
      (error) => error instanceof BosunError && error.code === 'conflict',
    );
    await f.restartClient();
    assert.equal((await f.rpc('client', 'remote.view.status', {})).state, 'held');
    assert.throws(() => cachedReader(f));
    const settings = { ...f.clientConfig.remote, authority: f.server.status().remote.endpoint };
    const status = await f.direct(
      'remote.view.get',
      {
        id: before.id,
        clientId: loadHookConfig(f.clientPaths)!.memory.remoteClientId!,
      },
      'owner',
      settings,
    );
    assert.equal(status.lease.state, 'active');
    // The fixture gets a fresh ephemeral endpoint on restart. Explicit owner release follows the proven local HOLD.
    await f.direct(
      'remote.view.release',
      { id: before.id, clientId: loadHookConfig(f.clientPaths)!.memory.remoteClientId! },
      'owner',
      settings,
    );
    await f.rpc('server', 'memory.delete', { id: note.memory.id });
  } finally {
    await f.close();
  }
});
test('definite model credential revocation invalidates a permitted view and retains the authority lease until owner release', async () => {
  const f = await fixture();
  try {
    const note = await f.rpc('server', 'memory.store', {
      category: 'project',
      title: 'Revocation cache note',
      body: 'Cached revocation pnpm note.',
    });
    await f.rpc('client', 'remote.view.refresh', { privacy: 'public' });
    await f.server.setModelToken('Revoked_model_remote_credential_'.repeat(2));
    await assert.rejects(f.rpc('client', 'memory.search', { text: 'pnpm' }, 'model'));
    assert.equal((await f.rpc('client', 'remote.view.status', {})).state, 'held');
    assert.throws(() => cachedReader(f));
    await assert.rejects(f.rpc('server', 'memory.delete', { id: note.memory.id }));
    await f.rpc('client', 'remote.view.invalidate', {});
    await f.rpc('server', 'memory.delete', { id: note.memory.id });
  } finally {
    await f.close();
  }
});
test('remote view local expiry and backward clock refuse reads without releasing the source permission lease', async () => {
  const f = await fixture();
  try {
    const note = await f.rpc('server', 'memory.store', {
      category: 'project',
      title: 'Expiry cache note',
      body: 'Expiry pnpm view.',
    });
    await f.rpc('client', 'remote.view.refresh', { privacy: 'public', ttlMs: 1000 });
    const db = new SqliteDatabase(path.join(f.clientPaths.home, 'remote-view.db'), {
      readOnly: true,
    });
    const at = Number(db.prepare('SELECT cached_at FROM remote_view').get()!.cached_at);
    db.close();
    assert.throws(() => cachedReader(f, () => at + 1000));
    assert.throws(() => cachedReader(f, () => at - 1));
    let now = at;
    const { reader } = cachedReader(f, () => now);
    try {
      now = at + 1;
      reader.validate();
      now = at;
      assert.throws(() => reader.validate());
    } finally {
      reader.close();
    }
    await assert.rejects(f.rpc('server', 'memory.delete', { id: note.memory.id }));
    await f.rpc('client', 'remote.view.invalidate', {});
    await f.rpc('server', 'memory.delete', { id: note.memory.id });
  } finally {
    await f.close();
  }
});
test('lost acquire and release replies retain original intents; reconciliation reads state without replaying either mutation', async () => {
  let forwardEndpoint = '';
  const counts: string[] = [];
  let lose: string | null = 'remote.view.acquire';
  const proxy = http.createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (bytes) => chunks.push(bytes));
    incoming.on('end', () => {
      const body = Buffer.concat(chunks),
        method = body.length ? JSON.parse(body.toString()).method : 'identity';
      counts.push(method);
      const target = http.request(
        new URL(incoming.url!, forwardEndpoint),
        { method: incoming.method, headers: incoming.headers, agent: false },
        (response) => {
          if (method === lose) {
            response.resume();
            response.on('end', () => {
              lose = null;
              outgoing.destroy();
            });
          } else {
            outgoing.writeHead(response.statusCode!, response.headers);
            response.pipe(outgoing);
          }
        },
      );
      target.on('error', () => outgoing.destroy());
      target.end(body);
    });
  });
  const f = await fixture(false, async (endpoint) => {
    forwardEndpoint = endpoint;
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    return 'http://127.0.0.1:' + (proxy.address() as { port: number }).port;
  });
  try {
    const note = await f.rpc('server', 'memory.store', {
      category: 'project',
      title: 'Unknown lease note',
      body: 'One original remote lease.',
    });
    await assert.rejects(f.rpc('client', 'remote.view.refresh', { privacy: 'public' }));
    assert.equal((await f.rpc('client', 'remote.view.status', {})).state, 'acquire-unknown');
    assert.equal(counts.filter((method) => method === 'remote.view.acquire').length, 1);
    assert.throws(() => cachedReader(f));
    await assert.rejects(f.rpc('server', 'memory.delete', { id: note.memory.id }));
    await assert.rejects(f.rpc('client', 'remote.view.refresh', { privacy: 'public' }));
    assert.equal(counts.filter((method) => method === 'remote.view.acquire').length, 1);
    assert.equal((await f.rpc('client', 'remote.view.reconcile', {})).state, 'held');
    assert.equal(counts.filter((method) => method === 'remote.view.release').length, 0);
    lose = 'remote.view.release';
    await assert.rejects(f.rpc('client', 'remote.view.invalidate', {}));
    assert.equal((await f.rpc('client', 'remote.view.status', {})).state, 'release-unknown');
    assert.throws(() => cachedReader(f));
    await f.rpc('server', 'memory.delete', { id: note.memory.id });
    await assert.rejects(f.rpc('client', 'remote.view.invalidate', {}));
    assert.equal(counts.filter((method) => method === 'remote.view.release').length, 1);
    assert.equal((await f.rpc('client', 'remote.view.reconcile', {})).state, 'empty');
    assert.equal(counts.filter((method) => method === 'remote.view.release').length, 1);
  } finally {
    proxy.closeAllConnections();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await f.close();
  }
});
test('remote consolidation runs once in the authoritative executor; reviewed graph context follows source privacy and never client L2', async () => {
  const model = 'chosen:remote-consolidation:tag';
  const provider = await mock({
    '/api/tags': () => ({ json: { models: [{ name: model, model }] } }),
    '/api/show': () => ({ json: { capabilities: ['completion'] } }),
    '/api/chat': (body) => {
      const payload = JSON.parse(body.messages[1].content);
      assert.equal(body.model, model);
      assert.equal(payload.evidence.length, 1);
      assert.ok(!JSON.stringify(body).includes('PRIVATE_REMOTE_ENRICHMENT'));
      return {
        json: {
          model,
          done: true,
          done_reason: 'stop',
          prompt_eval_count: 31,
          eval_count: 11,
          message: {
            role: 'assistant',
            content: JSON.stringify({
              items: [
                {
                  kind: 'fact',
                  title: 'Remote zebra package choice',
                  text: 'Use pnpm for the zebra project.',
                  citations: [{ evidenceId: payload.evidence[0].id, quote: 'uses pnpm' }],
                  parents: [],
                  entity: null,
                  relation: null,
                },
              ],
            }),
          },
        },
      };
    },
  });
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    f = await fixture(
      false,
      undefined,
      `[graph]\nextraction=true\n[providers.default]\nkind="ollama"\nmodel=${JSON.stringify(model)}\nurl=${JSON.stringify(provider.url)}\ntimeoutMs=1000\n`,
    );
    const note = (
      await f.rpc('client', 'memory.store', {
        category: 'project',
        title: 'Zebra package choice',
        body: 'The zebra project uses pnpm.',
      })
    ).memory;
    await f.rpc('client', 'memory.store', {
      category: 'project',
      title: 'PRIVATE_REMOTE_ENRICHMENT',
      body: 'PRIVATE_REMOTE_ENRICHMENT',
      private: true,
    });
    await assert.rejects(
      f.rpc('client', 'consolidation.run', { requestId: 'remote_extract' }, 'model'),
    );
    const requested = await f.rpc('client', 'consolidation.run', { requestId: 'remote_extract' });
    assert.equal(requested.state, 'queued');
    assert.equal(requested.job.runnerId, 'bosun-consolidation');
    assert.equal(requested.job.ownerOnly, true);
    let job = await f.rpc('client', 'job.get', { id: requested.job.id });
    for (let n = 0; n < 200 && ['queued', 'running'].includes(job.state); n++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      job = await f.rpc('client', 'job.get', { id: requested.job.id });
    }
    assert.equal(job.state, 'succeeded');
    const proposals = await f.rpc('client', 'consolidation.proposals', {});
    assert.equal(proposals.proposals.length, 1);
    const artifact = proposals.proposals[0].artifact;
    assert.deepEqual(artifact.supports, [
      { memoryId: note.id, version: note.version, hash: note.hash },
    ]);
    assert.deepEqual(
      (await f.rpc('client', 'context.retrieve', { task: 'zebra pnpm', sources: ['graph'] })).ids,
      [],
    );
    await f.rpc('client', 'graph.review', {
      id: artifact.id,
      expectedVersion: artifact.version,
      action: 'accept',
    });
    const context = await f.rpc('client', 'context.retrieve', {
      task: 'zebra pnpm',
      sources: ['graph'],
    });
    assert.ok(context.ids.includes(artifact.id));
    assert.match(context.text, /Use pnpm/);
    const summaryProposal = (
      await f.rpc('client', 'graph.create', {
        kind: 'summary',
        title: 'Zebra reviewed overview',
        text: 'Use pnpm for the zebra project.',
        supports: artifact.supports,
        parents: [{ id: artifact.id, version: 2 }],
      })
    ).artifact;
    const summary = (
      await f.rpc('client', 'graph.review', {
        id: summaryProposal.id,
        expectedVersion: summaryProposal.version,
        action: 'accept',
      })
    ).artifact;
    const overview = await f.rpc('client', 'context.retrieve', {
      task: 'zebra pnpm overview',
      sources: ['overview'],
      includeCandidates: true,
    });
    assert.ok(overview.ids.includes(summary.id));
    assert.ok(overview.candidates.some((candidate: { id: string }) => candidate.id === summary.id));
    assert.ok(
      !(
        await f.rpc('client', 'context.retrieve', {
          task: 'zebra pnpm overview',
          sources: ['graph'],
        })
      ).ids.includes(summary.id),
    );
    const duplicate = await f.rpc('client', 'consolidation.run', { requestId: 'remote_extract' });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.job.id, job.id);
    assert.equal(provider.requests.filter((request) => request.path === '/api/chat').length, 1);
    const localDb = new SqliteDatabase(f.clientPaths.memory, { readOnly: true });
    try {
      assert.equal(localDb.prepare('SELECT count(*) n FROM graph_artifacts').get()!.n, 0);
      assert.equal(localDb.prepare('SELECT count(*) n FROM memories').get()!.n, 0);
    } finally {
      localDb.close();
    }
    await f.rpc('client', 'memory.update', {
      id: note.id,
      expectedVersion: note.version,
      patch: { private: true },
    });
    assert.deepEqual(
      (await f.rpc('client', 'context.retrieve', { task: 'zebra pnpm', sources: ['graph'] })).ids,
      [],
    );
    await assert.rejects(f.rpc('client', 'graph.get', { id: artifact.id }, 'model'));
    assert.deepEqual(
      (
        await f.rpc('client', 'context.retrieve', {
          task: 'zebra pnpm overview',
          sources: ['overview'],
          includeCandidates: true,
        })
      ).candidates,
      [],
    );
    const status = await f.rpc('client', 'consolidation.status', {});
    assert.equal(status.claim, null);
    await f.server.close();
    assert.deepEqual(
      (await f.rpc('client', 'context.retrieve', { task: 'zebra pnpm', sources: ['graph'] })).ids,
      [],
    );
  } finally {
    await f?.close();
    await provider.close();
  }
});
test('remote network and endpoint policy enforce canonical CIDRs, mapped IPv4, IPv6, TLS and credential-free origins', () => {
  const allowed = remoteNetwork(['127.0.0.1/32', '::1/128', '100.64.0.0/10']);
  for (const ip of ['127.0.0.1', '::ffff:127.0.0.1', '::1', '100.99.1.2'])
    assert.equal(allowed(ip), true);
  for (const ip of ['8.8.8.8', '100.63.255.255', '999.1.1.1', undefined])
    assert.equal(allowed(ip), false);
  for (const list of [[], ['0.0.0.0/33'], ['10.0.0.0/-1'], ['10.0.0.999/24']])
    assert.throws(() => remoteNetwork(list));
  assert.equal(remoteEndpoint('https://server.example').protocol, 'https:');
  for (const url of [
    'http://192.168.1.1',
    'https://user:secret@server.example',
    'https://server.example/path',
    'https://server.example/?token=secret',
  ])
    assert.throws(() => remoteEndpoint(url));
});
test('two isolated daemons share one authenticated memory authority, preserve original IDs/flags/models and never copy into client L1', async () => {
  const f = await fixture();
  try {
    assert.equal(project(f.clientWorkspace).id, project(f.serverWorkspace).id);
    const created = await f.rpc('client', 'memory.store', {
      category: 'project',
      title: 'Remote package manager',
      body: 'Use pnpm for the remote project.',
    });
    const id = created.memory.id;
    assert.equal((await f.rpc('server', 'memory.get', { id })).memory.id, id);
    assert.equal(
      (await f.rpc('client', 'memory.get', { id }, 'model')).memory.body,
      'Use pnpm for the remote project.',
    );
    const context = await f.rpc('client', 'context.retrieve', {
      task: 'Inspect remote package manager pnpm',
    });
    assert.ok(context.ids.includes(id));
    const lexical = await f.rpc('client', 'context.retrieve', {
      task: 'remote package manager pnpm',
      sources: ['lexical'],
    });
    assert.ok(lexical.ids.includes(id));
    const secret = await f.rpc('client', 'memory.store', {
      category: 'project',
      title: 'PRIVATE-REMOTE-TITLE',
      body: 'PRIVATE-REMOTE-BODY',
      private: true,
    });
    assert.deepEqual(await f.rpc('client', 'memory.get', { id: secret.memory.id }, 'model'), {
      memory: { private: true },
    });
    const publicHits = (await f.rpc('client', 'memory.search', { text: 'PRIVATE-REMOTE' }, 'model'))
      .hits;
    assert.ok(publicHits.every((hit: any) => hit.id !== secret.memory.id));
    assert.doesNotMatch(JSON.stringify(publicHits), /PRIVATE-REMOTE-BODY|PRIVATE-REMOTE-TITLE/);
    const privateLexical = await f.rpc('client', 'context.retrieve', {
      task: 'PRIVATE-REMOTE',
      sources: ['lexical'],
    });
    assert.ok(privateLexical.ids.every((found: string) => found !== secret.memory.id));
    assert.doesNotMatch(JSON.stringify(privateLexical), /PRIVATE-REMOTE-BODY|PRIVATE-REMOTE-TITLE/);
    const db = new SqliteDatabase(f.clientPaths.memory, { readOnly: true });
    try {
      assert.equal(db.prepare('SELECT count(*) n FROM memories').get()!.n, 0);
    } finally {
      db.close();
    }
    const updated = await f.rpc('client', 'memory.update', {
      id,
      expectedVersion: 1,
      patch: { body: 'Use pnpm with the selected explicit version.' },
    });
    assert.equal(updated.memory.version, 2);
    const stats = await f.rpc('client', 'memory.stats', {});
    assert.equal(stats.total, 2);
    assert.deepEqual(stats.privacy, { public: 1, private: 1 });
    assert.doesNotMatch(JSON.stringify(stats), /PRIVATE-REMOTE|pnpm/);
    for (const method of ['memory.stats', 'memory.purge'])
      await assert.rejects(
        f.rpc('client', method, method === 'memory.purge' ? { id } : {}, 'model'),
      );
    await f.rpc('client', 'memory.delete', { id });
    assert.deepEqual(await f.rpc('client', 'memory.purge', { id }), { purged: id });
    await assert.rejects(f.rpc('server', 'memory.get', { id }));
    assert.equal((await f.rpc('client', 'memory.stats', {})).total, 1);
    const audit = new SqliteDatabase(f.serverPaths.memory, { readOnly: true });
    try {
      assert.deepEqual(
        audit
          .prepare('SELECT op FROM memory_events WHERE memory_id=? ORDER BY id')
          .all(id)
          .map((row) => row.op),
        ['store', 'update', 'archive', 'purge'],
      );
    } finally {
      audit.close();
    }
    assert.equal(
      f.clientConfig.roles.worker.codex!.model,
      f.serverConfig.roles.worker.codex!.model,
    );
    assert.equal(f.client.status().remote.outcome, 'available');
    assert.deepEqual(f.sb.calls(), []);
  } finally {
    await f.close();
  }
});
test('unauthenticated, wrong-project and model-escalation requests are denied before dispatch; owner-only methods retain shared policy', async () => {
  const f = await fixture();
  try {
    const request = f.wire('memory.store', {
      category: 'project',
      title: 'Must not exist',
      body: 'Unauthenticated body',
    });
    for (const authorization of [undefined, 'Bearer invalid', 'Bearer ' + MODEL]) {
      const response = await fetch(f.endpoint + '/v1/rpc', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-bosun-project': request.scope.projectId,
          'x-bosun-authority': f.manifest.installationId,
          ...(authorization ? { authorization } : {}),
        },
        body: JSON.stringify(request),
      });
      assert.ok(response.status >= 400);
    }
    await assert.rejects(f.direct('memory.accept', { id: 'anything' }, 'model'));
    const cross = await fetch(f.endpoint + '/v1/identity', {
      headers: {
        authorization: `Bearer ${MODEL}`,
        'x-bosun-project': project(f.otherWorkspace).id,
      },
    });
    assert.equal(cross.status, 401);
    assert.equal((await f.rpc('server', 'memory.search', {})).hits.length, 0);
    assert.deepEqual(f.sb.calls(), []);
  } finally {
    await f.close();
  }
});
test('client outages visibly refuse writes and reads without using local L1, and hooks perform no remote network request', async () => {
  const f = await fixture();
  try {
    await f.rpc('client', 'memory.store', {
      category: 'project',
      title: 'Authoritative note',
      body: 'Authoritative remote pnpm note.',
    });
    const input = JSON.stringify({
      prompt: 'Inspect authoritative remote pnpm note',
      cwd: f.clientWorkspace,
    });
    const hook = await bosun(['hook'], { env: f.clientEnv, cwd: f.clientWorkspace, input });
    assert.equal(hook.code, 0);
    assert.equal(hook.out, '');
    await f.server.close();
    await assert.rejects(
      f.rpc('client', 'memory.store', {
        category: 'project',
        title: 'Offline',
        body: 'Must not queue locally.',
      }),
    );
    await assert.rejects(f.rpc('client', 'memory.search', { text: 'pnpm' }));
    const context = await f.rpc('client', 'context.retrieve', { task: 'pnpm' });
    assert.deepEqual(context.ids, []);
    const db = new SqliteDatabase(f.clientPaths.memory, { readOnly: true });
    try {
      assert.equal(db.prepare('SELECT count(*) n FROM memories').get()!.n, 0);
    } finally {
      db.close();
    }
    const offline = await bosun(['hook'], { env: f.clientEnv, cwd: f.clientWorkspace, input });
    assert.equal(offline.out, '');
    assert.equal(f.client.status().remote.offlineWrites, false);
  } finally {
    await f.close();
  }
});
test('live token revocation and directory rebinding refuse cached clients before further authoritative effects', async () => {
  const f = await fixture();
  try {
    await f.direct('memory.search', {}, 'model');
    await f.server.setModelToken('Revoked_model_remote_credential_'.repeat(2));
    await assert.rejects(f.direct('memory.search', {}, 'model'));
    const old = path.join(f.sb.root, 'old-server-checkout');
    fs.renameSync(f.serverWorkspace, old);
    fs.mkdirSync(f.serverWorkspace);
    await assert.rejects(
      f.direct('memory.store', { category: 'project', title: 'Rebound', body: 'Must not run' }),
    );
  } finally {
    await f.close();
  }
});
test('wrong authority pin, protocol skew and clock skew prevent mutating dispatch before sending body', async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.direct(
        'memory.store',
        { category: 'project', title: 'Wrong identity', body: 'Must not run' },
        'owner',
        { ...f.clientConfig.remote, authorityId: '11111111-1111-4111-8111-111111111111' },
      ),
    );
    await assert.rejects(
      callRemoteRpc({
        settings: f.clientConfig.remote,
        env: f.clientEnv,
        projectId: project(f.clientWorkspace).id,
        request: {
          version: 2,
          id: 'bad',
          method: 'memory.store',
          params: {},
          scope: { workspace: f.clientWorkspace, sessionId: null, audience: 'owner' },
        } as unknown as RpcRequest,
        signal: AbortSignal.timeout(1000),
      }),
    );
    assert.equal((await f.rpc('server', 'memory.search', {})).hits.length, 0);
    await f.restartServer(30000);
    await assert.rejects(
      f.direct(
        'memory.store',
        { category: 'project', title: 'Skewed', body: 'Must not be stored' },
        'owner',
        { ...f.clientConfig.remote, authority: f.server.status().remote.endpoint },
      ),
      (e) => e instanceof BosunError && e.code === 'unverified',
    );
    assert.equal((await f.rpc('server', 'memory.search', {})).hits.length, 0);
  } finally {
    await f.close();
  }
});
test('lost remote mutation reply remains unknown and is not replayed by the client transport', async () => {
  const f = await fixture();
  const requests: string[] = [];
  const proxy = http.createServer((incoming, outgoing) => {
    requests.push(incoming.url!);
    const target = http.request(
      new URL(incoming.url!, f.endpoint),
      { method: incoming.method, headers: incoming.headers },
      (response) => {
        if (incoming.url === '/v1/rpc') {
          response.resume();
          response.once('end', () => outgoing.destroy());
        } else {
          outgoing.writeHead(response.statusCode!, response.headers);
          response.pipe(outgoing);
        }
      },
    );
    incoming.pipe(target);
  });
  try {
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    await assert.rejects(
      f.direct(
        'memory.store',
        { category: 'project', title: 'Once', body: 'One committed remote effect' },
        'owner',
        { ...f.clientConfig.remote, authority: url },
      ),
      (e) => e instanceof BosunError && e.details?.outcome === 'unknown',
    );
    assert.equal((await f.rpc('server', 'memory.search', { text: 'committed' })).hits.length, 1);
    assert.deepEqual(requests, ['/v1/identity', '/v1/rpc']);
  } finally {
    proxy.closeAllConnections();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await f.close();
  }
});

test('actual TLS transport validates configured CA and hostname before preserving private owner data', async () => {
  const f = await fixture(true);
  try {
    assert.ok(f.endpoint.startsWith('https://'));
    const created = await f.rpc('client', 'memory.store', {
      category: 'project',
      title: 'TLS private note',
      body: 'TLS-PRIVATE-FIXTURE-BODY',
      private: true,
    });
    assert.equal(
      (await f.rpc('client', 'memory.get', { id: created.memory.id })).memory.body,
      'TLS-PRIVATE-FIXTURE-BODY',
    );
    assert.deepEqual(await f.rpc('client', 'memory.get', { id: created.memory.id }, 'model'), {
      memory: { private: true },
    });
    await assert.rejects(
      f.direct('memory.search', {}, 'owner', { ...f.clientConfig.remote, caFile: undefined }),
    );
    assert.deepEqual(f.sb.calls(), []);
  } finally {
    await f.close();
  }
});

test('malformed successful mutation replies stay unknown without retry or local fallback', async () => {
  const f = await fixture();
  const requests: string[] = [];
  const proxy = http.createServer((incoming, outgoing) => {
    requests.push(incoming.url!);
    const target = http.request(
      new URL(incoming.url!, f.endpoint),
      { method: incoming.method, headers: incoming.headers },
      (response) => {
        if (incoming.url === '/v1/rpc') {
          response.resume();
          response.once('end', () => {
            outgoing.writeHead(200, {
              'content-type': 'application/json',
              'x-bosun-authority': f.manifest.installationId,
            });
            outgoing.end(JSON.stringify({ version: 1, id: 'wrong_reply', ok: true }));
          });
        } else {
          outgoing.writeHead(response.statusCode!, response.headers);
          response.pipe(outgoing);
        }
      },
    );
    incoming.pipe(target);
  });
  try {
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const authority = 'http://127.0.0.1:' + (proxy.address() as { port: number }).port;
    await assert.rejects(
      f.direct(
        'memory.store',
        { category: 'project', title: 'Malformed receipt', body: 'One original effect' },
        'owner',
        { ...f.clientConfig.remote, authority },
      ),
      (e) => e instanceof BosunError && e.details?.outcome === 'unknown',
    );
    assert.equal((await f.rpc('server', 'memory.search', { text: 'original' })).hits.length, 1);
    assert.deepEqual(requests, ['/v1/identity', '/v1/rpc']);
  } finally {
    proxy.closeAllConnections();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await f.close();
  }
});
