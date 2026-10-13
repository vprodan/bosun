import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SqliteDatabase } from '../src/platform/sqlite.ts';
import { sandbox, gitRepo } from './helpers.ts';
import {
  openSqliteVecDistance,
  type SqliteVecSelection,
  type SqliteVecOpen,
} from '../src/adapters/memory/sqlite-vec.ts';
import { normalizedVector, readVector, cosine, embeddingText } from '../src/core/embeddings.ts';
import { defaultConfig } from '../src/core/domain/config.ts';
import { runtimePaths } from '../src/platform/paths.ts';
import { setupRuntime } from '../src/app/setup.ts';
import { DaemonOwner } from '../src/platform/daemon-owner.ts';
import { openDaemonMemory } from '../src/app/memory.ts';
import { createEmbeddingService } from '../src/app/embeddings.ts';
import { contentHash } from '../src/platform/content-hash.ts';
import type { ModelProvider } from '../src/core/ports/model.ts';
import type { EmbeddingSpace } from '../src/core/domain/embedding.ts';
import type { Ctx } from '../src/core/domain/memory.ts';
import { parseRuntimeConfig, renderRuntimeConfig } from '../src/platform/config.ts';

const hash = (bytes: string | Uint8Array) =>
  crypto.createHash('sha256').update(bytes).digest('hex');
function library() {
  const sb = sandbox(),
    folder = path.join(sb.home, 'approved-fixture');
  fs.mkdirSync(folder, { mode: 0o700 });
  const file = path.join(folder, 'vec0.dylib'),
    bytes = Buffer.alloc(64);
  // Invented Mach-O metadata only. No executable code or physical library.
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(0x0100000c, 4);
  bytes.writeUInt32LE(6, 12);
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  const selection: SqliteVecSelection = { file, sha256: hash(bytes), version: '0.1.9' };
  return { sb, file, bytes, selection };
}
function native(
  options: {
    version?: string;
    fail?: boolean;
    drift?: () => void;
    score?: () => number;
    scoreAt?: number;
  } = {},
) {
  let opens = 0,
    closes = 0,
    loads = 0,
    distances = 0;
  const open: SqliteVecOpen = () => {
    opens++;
    let localDistances = 0;
    // Real guarded native SQL; extension load is a fixture-local method override.
    const db = new SqliteDatabase(':memory:', { allowExtension: false });
    db.loadExtension = () => {
      loads++;
      options.drift?.();
      if (options.fail) throw Error('NATIVE_PRIVATE_CANARY');
    };
    db.function('vec_version', () => options.version ?? 'v0.1.9');
    db.function('vec_distance_cosine', (a: unknown, b: unknown) => {
      distances++;
      localDistances++;
      if (options.score && localDistances >= (options.scoreAt ?? 1)) return options.score();
      assert.ok(a instanceof Uint8Array && b instanceof Uint8Array);
      return (
        1 -
        cosine(
          normalizedVector(readVector(a, a.byteLength / 4), a.byteLength / 4),
          normalizedVector(readVector(b, b.byteLength / 4), b.byteLength / 4),
        )
      );
    });
    const close = db.close.bind(db);
    db.close = () => {
      closes++;
      close();
    };
    return db;
  };
  return { open, stats: () => ({ opens, closes, loads, distances }) };
}

test('optional sqlite-vec uses one selected fingerprint and source-derived SQL; closes without touching an authority DB', () => {
  const f = library(),
    n = native();
  try {
    const engine = openSqliteVecDistance(f.selection, n.open);
    assert.ok(engine);
    assert.equal(engine.score([1, 0, 0], [1, 0, 0]), 1);
    assert.equal(engine.score([1, 0, 0], [0, 1, 0]), 0);
    assert.equal(engine.score([1, 0, 0], [-1, 0, 0]), -1);
    assert.throws(() => engine.score([1, 0], [1, 0, 0]));
    assert.throws(() => engine.score([NaN, 0], [1, 0]));
    engine.close();
    engine.close();
    assert.throws(() => engine.score([1], [1]));
    assert.deepEqual(n.stats(), { opens: 1, closes: 1, loads: 1, distances: 6 });
    assert.deepEqual(f.sb.calls(), []);
  } finally {
    f.sb.cleanup();
  }
});

test('missing, changed, linked, hardlinked, unsafe and wrong-architecture selections degrade before any native opener', () => {
  for (const arm of [
    'missing',
    'digest',
    'symlink',
    'hardlink',
    'unsafe',
    'architecture',
    'version',
  ]) {
    const f = library(),
      n = native();
    try {
      let selection = { ...f.selection };
      if (arm === 'missing') fs.unlinkSync(f.file);
      else if (arm === 'digest') selection.sha256 = 'f'.repeat(64);
      else if (arm === 'symlink') {
        const target = f.file + '.target';
        fs.renameSync(f.file, target);
        fs.symlinkSync(target, f.file);
      } else if (arm === 'hardlink') fs.linkSync(f.file, f.file + '.other');
      else if (arm === 'unsafe') fs.chmodSync(f.file, 0o666);
      else if (arm === 'architecture') {
        f.bytes.writeUInt32LE(0x01000007, 4);
        fs.writeFileSync(f.file, f.bytes);
        selection.sha256 = hash(f.bytes);
      } else selection = { ...selection, version: '0.1.10-alpha.4' } as never;
      assert.equal(openSqliteVecDistance(selection, n.open), null);
      assert.equal(n.stats().opens, 0);
    } finally {
      f.sb.cleanup();
    }
  }
});

test('bad native version, loader failure, file drift or invalid numeric receipts close and never substitute a backend', () => {
  for (const arm of ['version', 'failure', 'drift', 'number']) {
    const f = library(),
      n = native({
        ...(arm === 'version' ? { version: 'v0.1.10-alpha.4' } : {}),
        ...(arm === 'failure' ? { fail: true } : {}),
        ...(arm === 'drift' ? { drift: () => fs.appendFileSync(f.file, 'changed') } : {}),
        ...(arm === 'number' ? { score: () => 3 } : {}),
      });
    try {
      assert.equal(openSqliteVecDistance(f.selection, n.open), null);
      assert.equal(n.stats().opens, 1);
      assert.equal(n.stats().closes, 1);
    } finally {
      f.sb.cleanup();
    }
  }
});

test('guarded production constructor cannot load the invented native library and returns explicit degradation', () => {
  const f = library();
  try {
    assert.equal(openSqliteVecDistance(f.selection), null);
    assert.deepEqual(f.sb.calls(), []);
  } finally {
    f.sb.cleanup();
  }
});

async function sourceFixture(nativeOptions: Parameters<typeof native>[0] = {}) {
  const f = library(),
    n = native(nativeOptions),
    workspace = gitRepo(f.sb, 'native-distance-repo');
  const config = defaultConfig(),
    paths = runtimePaths(f.sb.env());
  config.graph.vectors = true;
  config.graph.embedding = {
    ...config.graph.embedding,
    backend: 'sqlite-vec',
    extension: f.selection,
    model: 'embedding:fixture',
    digest: 'a'.repeat(64),
    dimensions: 3,
    transform: 'plain-v1',
    queryCacheSize: 2,
  };
  await setupRuntime(paths, config);
  const owner = new DaemonOwner(paths.owner);
  let count = 0;
  const now = () => 1800000000000;
  const memory = openDaemonMemory({
    paths: { primary: paths.memory, view: paths.view, backups: paths.backups },
    assertOwner: () => owner.assert(),
    memory: {
      now,
      monotonic: () => performance.now(),
      hash: contentHash,
      measure() {},
      id: () => 'm_' + String(++count).padStart(20, '0'),
      retention: { sessionTtlDays: 7, purgeAfterDays: 90 },
    },
    context: {
      now,
      monotonic: () => performance.now(),
      hash: contentHash,
      dateLabel: () => '2027-01-15',
      measure() {},
    },
    docsIndex: { monotonic: () => performance.now(), measure() {} },
    publicationId: crypto.randomUUID,
  });
  try {
    const ctx: Ctx = {
      projectId: (await import('../src/platform/project.ts')).project(workspace).id,
      linked: [],
      sessionId: null,
      audience: 'owner',
    };
    const space: EmbeddingSpace = {
      model: config.graph.embedding.model,
      digest: config.graph.embedding.digest!,
      dimensions: 3,
      transform: 'plain-v1',
    };
    const note = (
      await memory.memory.store(
        {
          category: 'project',
          title: 'Public build rules',
          body: 'Use pnpm to install dependencies.',
        },
        ctx,
      )
    ).memory;
    memory.embeddings.store(
      [
        {
          memoryId: note.id,
          version: note.version,
          hash: note.hash,
          id: 'v_fixture',
          space,
          chunk: 0,
          start: 0,
          end: note.body.length,
          inputHash: hash(embeddingText('document', 'plain-v1', note.body, note.title)),
          vector: [1, 0, 0],
        },
      ],
      ctx,
    );
    let embeds = 0;
    const provider: ModelProvider = {
      id: 'synthetic',
      caps: {
        local: 'verified',
        structured: 'unsupported',
        numCtx: 'unsupported',
        toolFree: 'verified',
        embeddings: 'verified',
      },
      health: async () => true,
      async generate() {
        throw Error('No generation');
      },
      async embed(request) {
        embeds++;
        request.verifySource?.();
        return {
          model: space.model,
          digest: space.digest,
          dimensions: 3,
          transform: 'plain-v1',
          vectors: [[1, 0, 0]],
        };
      },
    };
    const service = createEmbeddingService({
      config,
      memory,
      jobs: {
        assertOwner() {
          owner.assert();
        },
      } as never,
      schedule() {},
      provider: () => provider,
      sqliteVecOpen: n.open,
    });
    return {
      ...f,
      n,
      ctx,
      config,
      paths,
      memory,
      owner,
      workspace,
      service,
      note,
      embeds: () => embeds,
      async close() {
        await memory.close();
        owner.close();
        f.sb.cleanup();
      },
    };
  } catch (error) {
    await memory.close();
    owner.close();
    f.sb.cleanup();
    throw error;
  }
}

test('native vector source uses existing scope/CAS storage, checks privacy before opening and rechecks every cache hit', async () => {
  const f = await sourceFixture();
  const signal = new AbortController().signal;
  try {
    const source = f.service.source('public', signal, f.workspace);
    for (const privacy of ['private', 'unknown'])
      await assert.rejects(f.service.source(privacy, signal, f.workspace).search('body', f.ctx, 5));
    await assert.rejects(source.search('api_key=' + 'z'.repeat(40), f.ctx, 5));
    assert.equal(f.n.stats().opens, 0);
    assert.equal(f.embeds(), 0);
    const hits = await source.search('Which package manager?', f.ctx, 5);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].id, f.note.id);
    assert.equal(f.embeds(), 1);
    await source.search('Which package manager?', f.ctx, 5);
    assert.equal(f.embeds(), 1);
    assert.equal(f.n.stats().opens, 2);
    assert.equal(f.n.stats().closes, 2);
    fs.appendFileSync(f.file, 'changed');
    assert.deepEqual(await source.search('Which package manager?', f.ctx, 5), []);
    assert.equal(f.n.stats().opens, 2);
    assert.equal(f.embeds(), 1);
    const authority = new SqliteDatabase(f.paths.memory, { readOnly: true, allowExtension: false });
    try {
      assert.throws(() => authority.prepare('SELECT vec_version()').get());
    } finally {
      authority.close();
    }
  } finally {
    await f.close();
  }
});

test('native distance failure joins its connection and never populates an uncertain query cache', async () => {
  let scores = 0;
  const f = await sourceFixture({
    scoreAt: 4,
    score: () => {
      scores++;
      if (scores === 1) throw Error('PRIVATE_NATIVE_CANARY');
      return 0;
    },
  });
  try {
    const source = f.service.source('public', new AbortController().signal, f.workspace);
    await assert.rejects(source.search('Public question', f.ctx, 5), (error: unknown) => {
      assert.doesNotMatch(String(error), /PRIVATE_NATIVE_CANARY/);
      return true;
    });
    assert.equal(f.n.stats().closes, 1);
    await source.search('Public question', f.ctx, 5);
    assert.equal(f.embeds(), 2);
    assert.equal(f.n.stats().closes, 2);
  } finally {
    await f.close();
  }
});

test('native library configuration is explicit and exact; missing selection preserves disabled defaults', () => {
  const f = library();
  try {
    const config = defaultConfig();
    assert.equal(config.graph.embedding.extension, undefined);
    assert.equal(config.graph.vectors, false);
    config.graph.embedding.extension = f.selection;
    assert.deepEqual(
      parseRuntimeConfig(renderRuntimeConfig(config)).graph.embedding.extension,
      f.selection,
    );
    assert.throws(() =>
      parseRuntimeConfig(
        renderRuntimeConfig(config).replace('version = "0.1.9"', 'version = "0.1.10-alpha.4"'),
      ),
    );
  } finally {
    f.sb.cleanup();
  }
});
