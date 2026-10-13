import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mock } from './helpers.ts';
import { createOllamaEmbeddingProvider } from '../src/adapters/models/ollama-embedding.ts';
import {
  normalizedVector,
  vectorBytes,
  readVector,
  cosine,
  embeddingInputs,
} from '../src/core/embeddings.ts';
import type { EmbedRequest } from '../src/core/ports/model.ts';

const model = 'embeddinggemma:fixture',
  digest = 'a'.repeat(64);
const settings = (url: string) => ({
  url,
  model,
  dimensions: 3,
  transform: 'embeddinggemma-v1' as const,
  digest,
  timeoutMs: 1000,
  keepAlive: '1m',
});
const request = (overrides: Partial<EmbedRequest> = {}): EmbedRequest => ({
  privacy: 'public',
  purpose: 'query',
  inputs: [{ privacy: 'public', text: 'Which package builds the project?' }],
  model,
  digest,
  dimensions: 3,
  transform: 'embeddinggemma-v1',
  signal: new AbortController().signal,
  ...overrides,
});
const unavailable = (e: unknown) => (e as { code?: string }).code === 'unavailable';
async function backend(
  options: {
    cloud?: boolean;
    capability?: string;
    reply?: () => unknown;
    tags?: () => unknown;
  } = {},
) {
  return mock({
    '/api/tags': () => ({
      json: options.tags?.() ?? {
        models: [
          { model, digest, ...(options.cloud ? { remote_host: 'https://remote.invalid' } : {}) },
        ],
      },
    }),
    '/api/show': () => ({ json: { capabilities: [options.capability ?? 'embedding'] } }),
    '/api/embed': () => ({
      json: options.reply?.() ?? {
        model,
        embeddings: [[3, 4, 0]],
        prompt_eval_count: 7,
        total_duration: 19,
        load_duration: 2,
      },
    }),
  });
}

test('entire embedding batch is classified before any payload and before model metadata/generation', async () => {
  const server = await backend();
  try {
    const provider = createOllamaEmbeddingProvider(settings(server.url));
    const first = {
      privacy: 'public' as const,
      get text(): string {
        throw Error('payload too early');
      },
    };
    const input = request({
      purpose: 'document',
      inputs: [first, { privacy: 'private', text: 'PRIVATE BODY' }],
    });
    await assert.rejects(
      provider.embed!(input),
      (e: unknown) => (e as { code?: string }).code === 'private_input',
    );
    assert.deepEqual(server.requests, []);
    await assert.rejects(
      provider.embed!(request({ privacy: 'unknown' })),
      (e: unknown) => (e as { code?: string }).code === 'private_input',
    );
    assert.deepEqual(server.requests, []);
  } finally {
    await server.close();
  }
});

test('native embedding uses exact model/digest, versioned query prefix, truncatefalse, finite shape and measured units', async () => {
  const server = await backend();
  try {
    const result = await createOllamaEmbeddingProvider(settings(server.url)).embed!(request());
    assert.deepEqual(result.vectors, [[Math.fround(0.6), Math.fround(0.8), 0]]);
    assert.equal(result.digest, digest);
    assert.equal(result.model, model);
    assert.equal(result.transform, 'embeddinggemma-v1');
    assert.equal(result.tokensIn, 7);
    assert.equal(result.totalNs, 19);
    assert.equal(result.loadNs, 2);
    assert.equal(server.requests.filter((r) => r.path === '/api/embed').length, 1);
    assert.deepEqual(server.requests.find((r) => r.path === '/api/embed')!.body, {
      model,
      input: ['task: search result | query: Which package builds the project?'],
      truncate: false,
      dimensions: 3,
      keep_alive: '1m',
    });
    assert.equal(server.requests.filter((r) => r.path === '/api/tags').length, 2);
    assert.equal(
      server.requests.some((r) => /pull|generate|chat|create/.test(r.path)),
      false,
    );
  } finally {
    await server.close();
  }
});

test('document transform preserves title; credentials and unsupported batch/space hold before metadata', async () => {
  const server = await backend();
  try {
    const p = createOllamaEmbeddingProvider(settings(server.url));
    assert.deepEqual(
      embeddingInputs(
        request({
          purpose: 'document',
          inputs: [{ privacy: 'public', title: 'Build rules', text: 'Use pnpm.' }],
        }),
      ),
      ['title: Build rules | text: Use pnpm.'],
    );
    for (const r of [
      request({ model: 'substitute' }),
      request({ dimensions: 2 }),
      request({ transform: 'plain-v1' }),
      request({ inputs: [{ privacy: 'public', text: 'api_key=' + 'x'.repeat(40) }] }),
      request({ inputs: [] }),
      request({ inputs: Array(9).fill({ privacy: 'public', text: 'public text' }) }),
    ])
      await assert.rejects(p.embed!(r));
    assert.deepEqual(server.requests, []);
  } finally {
    await server.close();
  }
});

test('cloud metadata, missing/duplicate tag, wrong digest and completion-only models stop before embedding', async () => {
  for (const opts of [
    { cloud: true },
    { capability: 'completion' },
    { tags: () => ({ models: [{ model, digest: 'b'.repeat(64) }] }) },
    { tags: () => ({ models: [] }) },
    {
      tags: () => ({
        models: [
          { model, digest },
          { model, digest },
        ],
      }),
    },
  ]) {
    const server = await backend(opts);
    try {
      await assert.rejects(
        createOllamaEmbeddingProvider(settings(server.url)).embed!(request()),
        unavailable,
      );
      assert.equal(
        server.requests.some((r) => r.path === '/api/embed'),
        false,
      );
    } finally {
      await server.close();
    }
  }
});

test('mismatched model/count/dimensions/finite vectors and malformed metrics are unknown, single-attempt outcomes', async () => {
  const replies = [
    { model: 'wrong', embeddings: [[1, 0, 0]] },
    { model, embeddings: [] },
    { model, embeddings: [[1, 0]] },
    { model, embeddings: [[0, 0, 0]] },
    { model, embeddings: [[1e300, 0, 0]] },
    { model, embeddings: [[1, 0, 0]], load_duration: -1 },
  ];
  for (const value of replies) {
    const server = await backend({ reply: () => value });
    try {
      await assert.rejects(
        createOllamaEmbeddingProvider(settings(server.url)).embed!(request()),
        (e: unknown) =>
          unavailable(e) &&
          (e as { details?: { outcome?: string } }).details?.outcome === 'unknown',
      );
      assert.equal(server.requests.filter((r) => r.path === '/api/embed').length, 1);
    } finally {
      await server.close();
    }
  }
});

test('model digest drift after actual embedding retains unknown with no retry or substitution', async () => {
  let calls = 0;
  const server = await backend({
    tags: () => ({ models: [{ model, digest: ++calls === 1 ? digest : 'b'.repeat(64) }] }),
  });
  try {
    await assert.rejects(
      createOllamaEmbeddingProvider(settings(server.url)).embed!(request()),
      (e: unknown) => (e as { details?: { outcome?: string } }).details?.outcome === 'unknown',
    );
    assert.equal(server.requests.filter((r) => r.path === '/api/embed').length, 1);
  } finally {
    await server.close();
  }
});

test('vector encoding is finite normalized little-endian float32 and dimensions never mix', () => {
  const v = normalizedVector([3, 4, 0], 3),
    bytes = vectorBytes(v),
    round = readVector(bytes, 3);
  assert.equal(bytes.length, 12);
  assert.ok(Math.abs(cosine(v, round) - 1) < 1e-6);
  assert.equal(cosine([1, 0, 0], [0, 1, 0]), 0);
  for (const bad of [
    [0, 0, 0],
    [NaN, 1, 0],
    [Infinity, 1, 0],
  ])
    assert.throws(() => normalizedVector(bad, 3));
  assert.throws(() => readVector(new Uint8Array(11), 3));
  assert.throws(() => normalizedVector([1, 2], 3));
  assert.throws(() => cosine([1], [1, 0]));
});
