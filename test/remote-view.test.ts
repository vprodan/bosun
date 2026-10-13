import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SqliteDatabase } from '../src/platform/sqlite.ts';
import { sandbox, fresh } from './helpers.ts';
import { RemoteLeaseStore } from '../src/adapters/memory/remote-leases.ts';
import { RemoteViewCache } from '../src/adapters/memory/remote-view-cache.ts';
import { RemoteViewReadOnly } from '../src/adapters/memory/remote-view-readonly.ts';
import { contentHash } from '../src/platform/content-hash.ts';
import { BosunError } from '../src/core/errors.ts';

function fixture() {
  const sb = sandbox();
  fresh(sb);
  const home = path.join(sb.root, 'view-home');
  fs.mkdirSync(home, { mode: 0o700 });
  const binding = {
    authorityId: crypto.randomUUID(),
    clientId: crypto.randomUUID(),
    clientSourceId: crypto.randomUUID(),
    configRevision: 'a'.repeat(64),
  };
  const intent = {
    ...binding,
    id: crypto.randomUUID(),
    projectId: 'p_123456789abcdef0',
    sessionId: null,
  };
  const at = Date.now();
  const row = {
    private: false,
    shared: false,
    id: 'm_lease_fixture',
    category: 'project' as const,
    projectId: intent.projectId,
    sessionId: null,
    title: 'Package manager',
    body: 'Use pnpm package manager.',
    tags: ['pnpm'],
    status: 'active' as const,
    source: 'test',
    sourceRef: null,
    hash: contentHash('Package manager', 'Use pnpm package manager.'),
    createdAt: at,
    updatedAt: at,
    expiresAt: null,
    accessedAt: null,
    accessCount: 0,
    version: 7,
  };
  const snapshot = {
    schemaVersion: 1 as const,
    id: intent.id,
    clientId: binding.clientId,
    authorityId: binding.authorityId,
    sourceId: crypto.randomUUID(),
    projectId: intent.projectId,
    sessionId: null,
    grantHash: 'b'.repeat(64),
    createdAt: at,
    rows: [row],
  };
  return {
    sb,
    home,
    binding,
    intent,
    at,
    snapshot,
    ctx: { projectId: intent.projectId, sessionId: null, linked: [], source: 'test' },
  };
}
test('lost actual lease COMMIT is unknown; restart retains the original lease and never repeats its acquisition', () => {
  const f = fixture();
  const file = path.join(f.home, 'leases.db');
  let store = new RemoteLeaseStore(file, () => {});
  const original = SqliteDatabase.prototype.exec;
  let lose = true;
  try {
    SqliteDatabase.prototype.exec = function (sql) {
      const result = original.call(this, sql);
      if (sql === 'COMMIT' && lose) {
        lose = false;
        throw Error('lost actual commit return');
      }
      return result;
    };
    assert.throws(
      () =>
        store.acquire({
          id: f.intent.id,
          projectId: f.intent.projectId,
          clientId: f.binding.clientId,
          sourceId: f.snapshot.sourceId,
          grantHash: f.snapshot.grantHash,
          createdAt: f.at,
        }),
      (error) => error instanceof BosunError && error.details?.outcome === 'unknown',
    );
  } finally {
    SqliteDatabase.prototype.exec = original;
    store.close();
  }
  try {
    store = new RemoteLeaseStore(file, () => {});
    assert.deepEqual(store.status(), { active: 1, retired: 0 });
    assert.throws(() => store.assertWritable());
    store.release(f.intent.id, f.intent.projectId, f.intent.clientId, f.at);
    assert.deepEqual(store.status(), { active: 0, retired: 1 });
    store.assertWritable();
    assert.throws(() =>
      store.acquire({
        id: f.intent.id,
        projectId: f.intent.projectId,
        clientId: f.binding.clientId,
        sourceId: f.snapshot.sourceId,
        grantHash: f.snapshot.grantHash,
        createdAt: f.at,
      }),
    );
  } finally {
    store.close();
    f.sb.cleanup();
  }
});
test('lost actual cache HOLD COMMIT remains unknown without a release; restart confirms HOLD and clears no intent', () => {
  const f = fixture();
  const file = path.join(f.home, 'cache.db');
  let cache = new RemoteViewCache(file, () => {});
  cache.reserve(f.intent);
  cache.ready(f.snapshot, f.at, 60000);
  const original = SqliteDatabase.prototype.exec;
  let lose = true;
  try {
    SqliteDatabase.prototype.exec = function (sql) {
      const result = original.call(this, sql);
      if (sql === 'COMMIT' && lose) {
        lose = false;
        throw Error('lost HOLD return');
      }
      return result;
    };
    assert.throws(
      () => cache.hold(),
      (error) => error instanceof BosunError && error.details?.outcome === 'unknown',
    );
  } finally {
    SqliteDatabase.prototype.exec = original;
    cache.close();
  }
  try {
    cache = new RemoteViewCache(file, () => {});
    assert.equal(cache.current()!.state, 'held');
    assert.equal(cache.current()!.intent.id, f.intent.id);
    assert.throws(() => new RemoteViewReadOnly(file, f.binding, f.ctx, () => f.at));
  } finally {
    cache.close();
    f.sb.cleanup();
  }
});
test('tampered cache snapshots, authority/source/config bindings and pending journals refuse local projection without modifying the file', async () => {
  const f = fixture();
  const file = path.join(f.home, 'cache.db');
  const cache = new RemoteViewCache(file, () => {});
  cache.reserve(f.intent);
  cache.ready(f.snapshot, f.at, 60000);
  try {
    for (const key of ['authorityId', 'clientSourceId', 'clientId', 'configRevision'] as const)
      assert.throws(
        () =>
          new RemoteViewReadOnly(
            file,
            {
              ...f.binding,
              [key]: key === 'configRevision' ? 'c'.repeat(64) : crypto.randomUUID(),
            },
            f.ctx,
            () => f.at,
          ),
      );
    const db = new SqliteDatabase(file);
    try {
      for (const change of [
        { private: true },
        { expiresAt: f.at + 1000 },
        { hash: '0'.repeat(32) },
        { body: 'x'.repeat(4001) },
        { projectId: 'p_ffffffffffffffff' },
        { unknown: 'untrusted' },
      ]) {
        const snapshot = { ...f.snapshot, rows: [{ ...f.snapshot.rows[0], ...change }] };
        db.prepare('UPDATE remote_view SET snapshot=?').run(JSON.stringify(snapshot));
        const before = fs.readFileSync(file);
        assert.throws(() => new RemoteViewReadOnly(file, f.binding, f.ctx, () => f.at));
        assert.deepEqual(fs.readFileSync(file), before);
      }
    } finally {
      db.close();
    }
    fs.writeFileSync(file + '-journal', 'unverified journal', { mode: 0o600 });
    const before = fs.readFileSync(file);
    assert.throws(() => new RemoteViewReadOnly(file, f.binding, f.ctx, () => f.at));
    assert.deepEqual(fs.readFileSync(file), before);
  } finally {
    cache.close();
    f.sb.cleanup();
  }
});
