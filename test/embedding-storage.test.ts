import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import crypto from 'node:crypto';
import { SqliteDatabase } from '../src/platform/sqlite.ts';
import { sandbox, fresh } from './helpers.ts';
import { setupRuntime } from '../src/app/setup.ts';
import { defaultConfig } from '../src/core/domain/config.ts';
import { runtimePaths } from '../src/platform/paths.ts';
import { DaemonOwner } from '../src/platform/daemon-owner.ts';
import { openDaemonMemory } from '../src/app/memory.ts';
import { contentHash } from '../src/platform/content-hash.ts';
import { embeddingText } from '../src/core/embeddings.ts';
import type { Ctx, Memory } from '../src/core/domain/memory.ts';
import type { EmbeddingRecord, EmbeddingSpace } from '../src/core/domain/embedding.ts';

const A: Ctx = { projectId: 'p_aaaaaaaaaaaaaaaa', sessionId: 's_a', linked: [], audience: 'owner' };
const B: Ctx = { projectId: 'p_bbbbbbbbbbbbbbbb', sessionId: 's_b', linked: [], audience: 'owner' };
const space: EmbeddingSpace = {
  model: 'embeddinggemma:fixture',
  digest: 'a'.repeat(64),
  dimensions: 3,
  transform: 'embeddinggemma-v1',
};
async function fixture() {
  const sb = sandbox();
  fresh(sb);
  const home = path.join(sb.root, 'embeddings'),
    paths = runtimePaths(sb.env({ BOSUN_HOME: home }));
  await setupRuntime(paths, defaultConfig());
  const owner = new DaemonOwner(paths.owner);
  let count = 0,
    at = 1800000000000;
  const clock = {
    now: () => at,
    monotonic: () => performance.now(),
    hash: contentHash,
    dateLabel: (time: number) => new Date(time).toISOString().slice(0, 10),
    measure() {},
  };
  const runtime = openDaemonMemory({
    paths: { primary: paths.memory, view: paths.view, backups: paths.backups },
    assertOwner: () => owner.assert(),
    memory: {
      ...clock,
      id: (now: number) =>
        `m_${now.toString(32).padStart(9, '0')}${(++count).toString(16).padStart(8, '0')}`,
      retention: { sessionTtlDays: 7, purgeAfterDays: 90 },
    },
    context: clock,
    docsIndex: { monotonic: clock.monotonic, measure() {} },
    publicationId: crypto.randomUUID,
  });
  const observer = new SqliteDatabase(paths.memory, { readOnly: true });
  return {
    sb,
    paths,
    runtime,
    observer,
    setTime: (time: number) => (at = time),
    async close() {
      observer.close();
      await runtime.close();
      owner.close();
      sb.cleanup();
    },
  };
}
function record(memory: Memory, vector: number[], id = 'v_fixture'): EmbeddingRecord {
  return {
    id,
    memoryId: memory.id,
    version: memory.version,
    hash: memory.hash,
    chunk: 0,
    start: 0,
    end: memory.body.length,
    space,
    inputHash: crypto
      .createHash('sha256')
      .update(embeddingText('document', space.transform, memory.body, memory.title))
      .digest('hex'),
    vector,
  };
}

test('registered vector data retains original source/audit, filters permitted scope before ranking, and never mixes spaces', async () => {
  const f = await fixture();
  try {
    const own = (
      await f.runtime.memory.store(
        { category: 'project', title: 'Own', body: 'Own source evidence' },
        A,
      )
    ).memory;
    const foreign = (
      await f.runtime.memory.store(
        { category: 'project', title: 'Foreign', body: 'Foreign source evidence' },
        B,
      )
    ).memory;
    const before = await f.runtime.memory.get(own.id, A, { events: true });
    f.runtime.embeddings.store([record(own, [0, 1, 0], 'v_own')], A);
    f.runtime.embeddings.store([record(foreign, [1, 0, 0], 'v_foreign')], B);
    const hits = f.runtime.embeddings.search([1, 0, 0], space, A, { limit: 1, minCosine: 0 });
    assert.deepEqual(
      hits.map((h) => h.memoryId),
      [own.id],
    );
    assert.equal(hits[0].cosine, 0);
    assert.equal(
      f.runtime.embeddings.search(
        [1, 0, 0],
        space,
        { ...A, linked: [B.projectId!] },
        { limit: 1, minCosine: 0 },
      )[0].memoryId,
      foreign.id,
    );
    assert.throws(() =>
      f.runtime.embeddings.capture([foreign.id], { ...A, linked: [B.projectId!] }),
    );
    assert.deepEqual(
      f.runtime.embeddings.search([1, 0, 0], { ...space, digest: 'b'.repeat(64) }, A, {
        limit: 20,
        minCosine: 0,
      }),
      [],
    );
    assert.deepEqual(await f.runtime.memory.get(own.id, A, { events: true }), before);
    assert.equal(
      f.observer.prepare('SELECT private FROM memory_embeddings WHERE id=?').get('v_own')!.private,
      0,
    );
  } finally {
    await f.close();
  }
});

test('private/unclassified/proposed/expired source capture and forged input hashes produce no vector data', async () => {
  const f = await fixture();
  try {
    const m = (
      await f.runtime.memory.store(
        { category: 'project', title: 'Public', body: 'Public source evidence' },
        A,
      )
    ).memory;
    const p = (
      await f.runtime.memory.store(
        { category: 'project', title: 'Private', body: 'PRIVATE SOURCE', private: true },
        A,
      )
    ).memory;
    const proposal = (
      await f.runtime.memory.store(
        { category: 'project', title: 'Proposal', body: 'proposal source', status: 'proposed' },
        A,
      )
    ).memory;
    for (const id of [p.id, proposal.id])
      assert.throws(() => f.runtime.embeddings.capture([id], A));
    assert.throws(() =>
      f.runtime.embeddings.store([{ ...record(m, [1, 0, 0]), inputHash: 'b'.repeat(64) }], A),
    );
    assert.throws(() => f.runtime.embeddings.capture([m.id], { ...A, audience: 'model' }));
    f.setTime(1800000000000 - 2 * 86400000);
    const expired = (
      await f.runtime.memory.store(
        { category: 'session', title: 'Expired', body: 'expired evidence', ttlDays: 1 },
        A,
      )
    ).memory;
    f.setTime(1800000000000);
    assert.throws(() => f.runtime.embeddings.capture([expired.id], A));
    assert.equal(f.observer.prepare('SELECT COUNT(*) n FROM memory_embeddings').get()!.n, 0);
  } finally {
    await f.close();
  }
});

test('source privacy, version, archive and purge delete derived bytes inside the original admitted transaction', async () => {
  const f = await fixture();
  try {
    for (const kind of ['private', 'version', 'archive', 'purge']) {
      const m = (
        await f.runtime.memory.store(
          { category: 'project', title: kind, body: `${kind} source evidence` },
          A,
        )
      ).memory;
      f.runtime.embeddings.store([record(m, [1, 0, 0], `v_${kind}`)], A);
      if (kind === 'private') await f.runtime.memory.update(m.id, { private: true }, 1, A);
      else if (kind === 'version')
        await f.runtime.memory.update(m.id, { body: 'changed source' }, 1, A);
      else await f.runtime.memory.delete(m.id, A);
      if (kind === 'purge') await f.runtime.memory.purge(m.id, A);
      assert.equal(
        f.observer.prepare('SELECT COUNT(*) n FROM memory_embeddings WHERE memory_id=?').get(m.id)!
          .n,
        0,
      );
    }
  } finally {
    await f.close();
  }
});

test('actual privacy COMMIT followed by lost return still deletes vectors, retains originals/audit and fences replay', async () => {
  const f = await fixture();
  const original = SqliteDatabase.prototype.exec;
  try {
    const m = (
      await f.runtime.memory.store(
        { category: 'project', title: 'Original', body: 'original public evidence' },
        A,
      )
    ).memory;
    f.runtime.embeddings.store([record(m, [1, 0, 0])], A);
    let lost = false;
    SqliteDatabase.prototype.exec = function (sql: string) {
      let target = false;
      if (!lost && sql === 'COMMIT')
        try {
          target = !!this.prepare(
            "SELECT name FROM sqlite_master WHERE name='memory_embeddings'",
          ).get();
        } catch {}
      const result = original.call(this, sql);
      if (target) {
        lost = true;
        throw Error('synthetic lost actual commit');
      }
      return result;
    };
    await assert.rejects(
      f.runtime.memory.update(m.id, { private: true }, 1, A),
      (e: unknown) => (e as { details?: { outcome?: string } }).details?.outcome === 'unknown',
    );
    SqliteDatabase.prototype.exec = original;
    assert.equal(lost, true);
    assert.equal(
      f.observer.prepare('SELECT private FROM memories WHERE id=?').get(m.id)!.private,
      1,
    );
    assert.equal(f.observer.prepare('SELECT COUNT(*) n FROM memory_embeddings').get()!.n, 0);
    assert.deepEqual(
      f.observer
        .prepare('SELECT op FROM memory_events WHERE memory_id=? ORDER BY id')
        .all(m.id)
        .map((r) => r.op),
      ['store', 'update'],
    );
    await assert.rejects(f.runtime.memory.update(m.id, { private: false }, 2, A));
  } finally {
    SqliteDatabase.prototype.exec = original;
    await f.close();
  }
});
