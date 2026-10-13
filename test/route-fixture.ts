import './bootstrap.ts';
import fs from 'node:fs';
import path from 'node:path';
import { mock, REPO, type Reply } from './helpers.ts';
import { runtimeFixture } from './runtime-fixture.ts';

export const ROUTE_MODEL = 'clef-flash:9b',
  ROUTE_DIGEST = 'a'.repeat(64);
export const publicDecision = () =>
  JSON.parse(fs.readFileSync(path.join(REPO, 'test/fixtures/clef-systemone.json'), 'utf8'));
// Invented public native metadata; no discovery or actual Ollama service call.
export async function routeFixture(decision: () => Reply = () => ({ json: publicDecision() })) {
  const server = await mock({
    '/api/version': () => ({ json: { version: '0.35.1' } }),
    '/api/tags': () => ({
      json: { models: [{ name: ROUTE_MODEL, model: ROUTE_MODEL, digest: ROUTE_DIGEST }] },
    }),
    '/api/show': () => ({
      json: {
        capabilities: ['decision'],
        details: { format: 'gguf' },
        model_info: { 'general.architecture': 'qwen35', 'qwen35.context_length': 65536 },
      },
    }),
    '/api/ps': () => ({
      json: {
        models: [
          {
            name: ROUTE_MODEL,
            model: ROUTE_MODEL,
            digest: ROUTE_DIGEST,
            size: 100,
            size_vram: 100,
            expires_at: '2099-01-01T00:00:00Z',
            context_length: 32768,
          },
        ],
      },
    }),
    '/v1/systemone': decision,
  });
  let f: Awaited<ReturnType<typeof runtimeFixture>>;
  try {
    f = await runtimeFixture(`[router]\nurl=${JSON.stringify(server.url)}\n`);
  } catch (error) {
    await server.close();
    throw error;
  }
  return {
    ...f,
    server,
    async close() {
      try {
        await f.close();
      } finally {
        await server.close();
      }
    },
  };
}
