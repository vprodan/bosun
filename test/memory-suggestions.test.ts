import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SqliteDatabase } from '../src/platform/sqlite.ts';
import { mock } from './helpers.ts';
import { runtimeFixture } from './runtime-fixture.ts';
import { mcpFixture } from './mcp-fixture.ts';
import { suggestMemory, privateMemoryTitle } from '../src/core/use-cases/suggest-memory.ts';
import { methodParams } from '../src/contracts/methods.ts';
import { BosunError } from '../src/core/errors.ts';
import type { ModelProvider, GenRequest } from '../src/core/ports/model.ts';

const MODEL = 'owner-selected-public-model',
  ECHO = 'provider-echo-canary-214b95';
const code = (expected: string) => (error: unknown) =>
  error instanceof BosunError && error.code === expected;
async function fixture(
  mode: 'valid' | 'invalid' | 'slow' = 'valid',
  kind = 'ollama',
  options: Parameters<typeof runtimeFixture>[1] = {},
  beforeReply?: () => void,
) {
  const server = await mock({
    '/api/tags': () => ({ json: { models: [{ model: MODEL }] } }),
    '/api/show': () => ({ json: { capabilities: ['completion'] } }),
    '/api/chat': () => {
      beforeReply?.();
      return {
        ...(mode === 'slow' ? { delayMs: 300 } : {}),
        json: {
          model: MODEL,
          done: true,
          done_reason: 'stop',
          message: {
            role: 'assistant',
            content:
              mode === 'invalid'
                ? ECHO
                : JSON.stringify({ title: 'Public suggestion', tags: ['public tag'] }),
          },
          prompt_eval_count: 17,
          eval_count: 9,
        },
      };
    },
    '/v1/chat/completions': () => ({
      json: {
        object: 'chat.completion',
        model: MODEL,
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: JSON.stringify({ title: 'Public suggestion', tags: ['public tag'] }),
            },
          },
        ],
        usage: { prompt_tokens: 17, completion_tokens: 9 },
      },
    }),
  });
  let f: Awaited<ReturnType<typeof runtimeFixture>>;
  try {
    f = await runtimeFixture(
      `[providers.default]\nkind=${JSON.stringify(kind)}\nmodel=${JSON.stringify(MODEL)}\nurl=${JSON.stringify(server.url)}\ntimeoutMs=1000\n`,
      options,
    );
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
async function terminal(f: Awaited<ReturnType<typeof runtimeFixture>>, id: string) {
  let job = await f.rpc('job.get', { id });
  for (let n = 0; n < 200 && ['queued', 'running'].includes(job.state); n++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    job = await f.rpc('job.get', { id });
  }
  assert.ok(!['queued', 'running'].includes(job.state), 'bounded job completion');
  return job;
}
const request = (requestId: string) => ({
  privacy: 'public',
  requestId,
  category: 'project',
  body: 'Public note about coding conventions',
});
function noLogContent(f: Awaited<ReturnType<typeof runtimeFixture>>, ...values: string[]) {
  const log = fs.readFileSync(path.join(f.paths.home, 'daemon.log'), 'utf8');
  for (const value of values) assert.ok(!log.includes(value), 'content-free daemon metadata');
}

test('final suggestions deny private/unclassified inputs before payload or provider getters', async () => {
  let touched = 0;
  for (const privacy of ['private', 'unknown', null, true, undefined]) {
    const input = {
      privacy,
      get body(): never {
        touched++;
        throw Error(ECHO);
      },
    };
    const options = {
      get provider(): never {
        touched++;
        throw Error(ECHO);
      },
      model: MODEL,
      signal: new AbortController().signal,
    };
    await assert.rejects(suggestMemory(input as never, options), code('private_input'));
    assert.throws(
      () =>
        methodParams({
          version: 1,
          id: 'denied',
          method: 'memory.autoStore',
          params: input,
          scope: { workspace: '/', sessionId: null, audience: 'owner' },
        }),
      code('private_input'),
    );
    assert.throws(
      () =>
        methodParams({
          version: 1,
          id: 'denied',
          method: 'memory.autoStore',
          params: input,
          scope: { workspace: '/', sessionId: null, audience: 'model' },
        }),
      code('unsupported'),
    );
  }
  assert.equal(touched, 0);
  assert.equal(privateMemoryTitle('  private title\nprivate body and tags'), 'private title');
  assert.equal(privateMemoryTitle('\nprivate body'), 'Untitled');
});
test('final public suggestion preserves exact model, bounded structured fields and known usage without retries', async () => {
  const calls: GenRequest[] = [];
  let output = JSON.stringify({
    title: 'Useful public title',
    tags: ['Public tag', 'public-tag', 'Code Style'],
  });
  let model = MODEL;
  const provider: ModelProvider = {
    id: 'selected',
    caps: {
      structured: 'verified',
      toolFree: 'verified',
      local: 'unverified',
      numCtx: 'unsupported',
    },
    health: async () => true,
    async generate(value) {
      calls.push(value);
      return { text: output, model, tokensIn: 17 };
    },
  };
  const result = await suggestMemory(
    { privacy: 'public', body: 'Public coding conventions' },
    { provider, model: MODEL, signal: new AbortController().signal },
  );
  assert.deepEqual(result, {
    title: 'Useful public title',
    tags: ['public-tag', 'code-style'],
    tokensIn: 17,
  });
  assert.equal(calls[0].model, MODEL);
  assert.equal(calls[0].messages[1].content, 'Public coding conventions');
  for (const value of [
    ECHO,
    JSON.stringify({ title: 'Public', tags: [], body: ECHO }),
    JSON.stringify({ title: 'Public', tags: [1] }),
    JSON.stringify({ title: 'api_key=' + 'x'.repeat(40), tags: [] }),
  ]) {
    output = value;
    const before = calls.length;
    await assert.rejects(
      suggestMemory(
        { privacy: 'public', body: 'Public note' },
        { provider, model: MODEL, signal: new AbortController().signal },
      ),
      code('unavailable'),
    );
    assert.equal(calls.length, before + 1);
  }
  output = JSON.stringify({ title: 'Public', tags: [] });
  model = 'silent-fallback';
  await assert.rejects(
    suggestMemory(
      { privacy: 'public', body: 'Public note' },
      { provider, model: MODEL, signal: new AbortController().signal },
    ),
    code('unavailable'),
  );
});
test('final private memory --auto preserves deterministic/explicit title, tags, ID, body and audit with zero inference', async () => {
  const f = await fixture();
  try {
    for (const explicit of [false, true]) {
      const body = 'private-title-canary-8f614c\nprivate-body-canary-9d271b ' + explicit;
      const added = await f.cli([
        'memory',
        'add',
        '--category',
        'project',
        '--private',
        '--auto',
        '--body',
        body,
        ...(explicit
          ? ['--title', 'private-title-override', '--tags', 'private-tag-canary-561cea']
          : []),
      ]);
      assert.equal(added.code, 0, added.err);
      assert.equal(added.err, '');
      const note = JSON.parse(added.out).memory;
      const stored = (await f.rpc('memory.get', { id: note.id, events: true })).memory;
      assert.equal(stored.id, note.id);
      assert.equal(stored.body, body);
      assert.equal(stored.private, true);
      assert.equal(
        stored.title,
        explicit ? 'private-title-override' : 'private-title-canary-8f614c',
      );
      assert.deepEqual(stored.tags, explicit ? ['private-tag-canary-561cea'] : []);
      assert.deepEqual(
        stored.events.map((event: any) => event.op),
        ['store'],
      );
      assert.deepEqual(
        await f.rpc('memory.get', { id: note.id }, { ...f.scope, audience: 'model' }),
        { memory: { private: true } },
      );
      noLogContent(f, body, stored.title, 'private-tag-canary-561cea');
    }
    assert.deepEqual(f.server.requests, []);
    assert.equal(f.calls(), 0);
    assert.deepEqual(f.sb.calls(), []);
  } finally {
    await f.close();
  }
});
test('final public --auto queues one exact-model owner job, keeps explicit overrides and skips inference when fully explicit', async () => {
  const f = await fixture();
  try {
    for (const [i, explicit] of ['title', 'tags'].entries()) {
      const body = 'Public note for the CLI ' + i;
      const added = await f.cli([
        'memory',
        'add',
        '--category',
        'project',
        '--auto',
        '--body',
        body,
        '--request-id',
        'public_auto_' + i,
        ...(explicit === 'title' ? ['--title', 'Explicit public title'] : ['--tags', 'keep']),
      ]);
      assert.equal(added.code, 0, added.err);
      const queued = JSON.parse(added.out).job;
      assert.equal(queued.ownerOnly, true);
      assert.equal((await terminal(f, queued.id)).state, 'succeeded');
      const result = JSON.parse((await f.rpc('job.result', { id: queued.id })).result);
      const note = (await f.rpc('memory.get', { id: result.memory.id })).memory;
      assert.equal(note.body, body);
      assert.equal(note.private, false);
      assert.equal(
        note.title,
        explicit === 'title' ? 'Explicit public title' : 'Public suggestion',
      );
      assert.deepEqual(note.tags, explicit === 'tags' ? ['keep'] : ['public-tag']);
      await assert.rejects(
        f.rpc('job.result', { id: queued.id }, { ...f.scope, audience: 'model' }),
        code('not_found'),
      );
      noLogContent(f, body, note.title);
    }
    const chats = f.server.requests.filter((row) => row.path === '/api/chat');
    assert.equal(chats.length, 2);
    assert.ok(
      chats.every(
        (row) => row.body.model === MODEL && row.body.think === false && row.body.stream === false,
      ),
    );
    const before = f.server.requests.length;
    const explicit = await f.cli([
      'memory',
      'add',
      '--category',
      'project',
      '--auto',
      '--title',
      'Explicit all',
      '--tags',
      'keep',
      '--body',
      'Another public note',
    ]);
    assert.equal(explicit.code, 0, explicit.err);
    assert.equal(JSON.parse(explicit.out).memory.title, 'Explicit all');
    assert.equal(f.server.requests.length, before);
    const usage = await f.rpc('usage.list', {});
    assert.ok(JSON.stringify(usage).includes(MODEL));
  } finally {
    await f.close();
  }
});
test('screened credentials and unqualified native suggestion transports hold before model/metadata calls or queued effects', async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.rpc('memory.autoStore', { ...request('secret'), body: 'api_key=' + 'x'.repeat(40) }),
      code('private_input'),
    );
    assert.deepEqual((await f.rpc('job.list', {})).jobs, []);
    assert.deepEqual(f.server.requests, []);
    assert.equal(f.calls(), 0);
  } finally {
    await f.close();
  }
  const native = await fixture('valid', 'claude-cli');
  try {
    await assert.rejects(native.rpc('memory.autoStore', request('native')), code('unverified'));
    assert.deepEqual(native.server.requests, []);
    assert.deepEqual(native.sb.calls(), []);
  } finally {
    await native.close();
  }
});
test('malformed provider output remains unknown, preserves stable request dedupe and cannot be released or replayed', async () => {
  const f = await fixture('invalid');
  try {
    const input = request('lost_suggestion'),
      first = await f.rpc('memory.autoStore', input);
    assert.equal((await terminal(f, first.job.id)).state, 'unknown');
    assert.equal((await f.rpc('memory.search', { text: 'Public' })).hits.length, 0);
    const again = await f.rpc('memory.autoStore', input);
    assert.equal(again.duplicate, true);
    assert.equal(again.job.id, first.job.id);
    await assert.rejects(f.rpc('job.release', { id: first.job.id }), code('conflict'));
    assert.equal(f.server.requests.filter((row) => row.path === '/api/chat').length, 1);
    noLogContent(f, ECHO, input.body);
  } finally {
    await f.close();
  }
});
test('workspace rebinding during generation preserves the unknown original job and creates no memory in either project', async () => {
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  let original = '';
  try {
    f = await fixture('valid', 'ollama', {}, () => {
      fs.appendFileSync(
        path.join(f!.workspace, '.git/config'),
        '\n[remote "origin"]\n\turl = git@example.com:team/rebound.git\n',
      );
    });
    const configFile = path.join(f.workspace, '.git/config');
    original = fs.readFileSync(configFile, 'utf8');
    const input = request('rebound'),
      queued = await f.rpc('memory.autoStore', input);
    const state = new SqliteDatabase(f.paths.state, { readOnly: true });
    try {
      let current = state.prepare('SELECT state FROM jobs WHERE id=?').get(queued.job.id)!.state;
      for (let n = 0; n < 200 && ['queued', 'running'].includes(String(current)); n++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        current = state.prepare('SELECT state FROM jobs WHERE id=?').get(queued.job.id)!.state;
      }
      assert.equal(current, 'unknown');
    } finally {
      state.close();
    }
    const memory = new SqliteDatabase(f.paths.memory, { readOnly: true });
    try {
      assert.equal(memory.prepare('SELECT count(*) AS n FROM memories').get()!.n, 0);
    } finally {
      memory.close();
    }
    fs.writeFileSync(configFile, original);
    const repeated = await f.rpc('memory.autoStore', input);
    assert.equal(repeated.duplicate, true);
    assert.equal(repeated.job.id, queued.job.id);
    assert.equal(f.server.requests.filter((row) => row.path === '/api/chat').length, 1);
    noLogContent(f, input.body);
  } finally {
    await f?.close();
  }
});
test('remote API suggestion needs explicit opt-in and matching admission; quota holds precede requests', async () => {
  const held = await fixture('valid', 'openai-compatible');
  try {
    await assert.rejects(held.rpc('memory.autoStore', request('no_optin')), code('unsupported'));
    assert.deepEqual(
      await held.rpc('memory.autoStore', { ...request('no_admission'), allowRemoteApi: true }),
      { state: 'held', reason: 'admission_unavailable' },
    );
    assert.deepEqual(held.server.requests, []);
  } finally {
    await held.close();
  }
  const observations: string[][] = [];
  let allow = false;
  const f = await fixture('valid', 'openai-compatible', {
    suggestionAdmit: async (providerId, model) => {
      observations.push([providerId, model]);
      return allow ? { allowed: true } : { allowed: false, reason: 'quota' };
    },
  });
  try {
    const input = { ...request('api'), allowRemoteApi: true };
    assert.deepEqual(await f.rpc('memory.autoStore', input), { state: 'held', reason: 'quota' });
    assert.equal(f.server.requests.length, 0);
    allow = true;
    const queued = await f.rpc('memory.autoStore', input);
    assert.equal((await terminal(f, queued.job.id)).state, 'succeeded');
    assert.ok(observations.every((row) => row.join() === ['default', MODEL].join()));
    assert.equal(f.server.requests.length, 1);
    assert.equal(f.server.requests[0].body.model, MODEL);
  } finally {
    await f.close();
  }
});
test('cancelling an in-flight title/tag job cannot create a memory or permit model access to owner-only tooling', async () => {
  const f = await fixture('slow');
  let mcp: Awaited<ReturnType<typeof mcpFixture>> | undefined;
  try {
    mcp = await mcpFixture(f.env, f.workspace);
    assert.ok(
      !(await mcp.client.listTools()).tools.some((tool) => tool.name.includes('autoStore')),
    );
    const queued = await f.rpc('memory.autoStore', request('cancelled'));
    for (let n = 0; n < 100 && !f.server.requests.some((row) => row.path === '/api/chat'); n++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(f.server.requests.filter((row) => row.path === '/api/chat').length, 1);
    await f.rpc('job.cancel', { id: queued.job.id });
    assert.equal((await terminal(f, queued.job.id)).state, 'unknown');
    assert.equal((await f.rpc('memory.search', { text: 'Public' })).hits.length, 0);
    const repeated = await f.rpc('memory.autoStore', request('cancelled'));
    assert.equal(repeated.job.id, queued.job.id);
    assert.equal(repeated.duplicate, true);
    assert.equal(f.server.requests.filter((row) => row.path === '/api/chat').length, 1);
  } finally {
    await mcp?.close();
    await f.close();
  }
});
