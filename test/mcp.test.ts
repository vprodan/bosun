import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { gitRepo, BIN } from './helpers.ts';
import { runtimeFixture } from './runtime-fixture.ts';

async function connect(f: Awaited<ReturnType<typeof runtimeFixture>>) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN, 'mcp'],
    cwd: f.workspace,
    env: f.env,
    stderr: 'pipe',
    maxBufferSize: 1048576,
  });
  let stderr = '';
  transport.stderr?.on('data', (value) => {
    stderr += value;
  });
  const client = new Client(
    { name: 'bosun-mcp-regression', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  try {
    await client.connect(transport);
  } catch (error) {
    await client.close();
    await transport.close();
    throw error;
  }
  return {
    client,
    transport,
    stderr: () => stderr,
    async close() {
      try {
        await client.close();
      } finally {
        await transport.close();
      }
    },
    async call(name: string, args: Record<string, unknown>) {
      return client.callTool({ name, arguments: args });
    },
  };
}
const structured = (value: { structuredContent?: unknown }): any => value.structuredContent;

test('final MCP negotiates the pinned modern protocol, exposes closed model schemas and reserves owner operations', async () => {
  const f = await runtimeFixture();
  let s: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    s = await connect(f);
    assert.equal(s.client.getNegotiatedProtocolVersion(), '2026-07-28');
    assert.equal(s.client.getProtocolEra(), 'modern');
    assert.equal(s.client.getServerVersion()!.name, 'bosun');
    await assert.rejects(
      s.client.ping(),
      (error: any) => error.code === 'METHOD_NOT_SUPPORTED_BY_PROTOCOL_VERSION',
    );
    const tools = (await s.client.listTools()).tools;
    const names = tools.map((tool) => tool.name);
    for (const name of [
      'memory_store',
      'memory_search',
      'memory_get',
      'memory_update',
      'memory_delete',
      'context_retrieve',
      'graph_get',
      'graph_query',
      'graph_explain',
      'job_submit',
      'job_get',
      'job_result',
      'job_cancel',
    ])
      assert.ok(names.includes(name), name);
    for (const name of [
      'memory_accept',
      'memory_purge',
      'memory_stats',
      'docs_index',
      'graph_create',
      'consolidation_run',
      'quota_refresh',
      'handoff_import',
    ])
      assert.equal(names.includes(name), false, name);
    for (const tool of tools) {
      assert.ok(tool.description && tool.description.length < 300);
      assert.equal(tool.inputSchema.type, 'object');
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.equal(
        tool.annotations!.readOnlyHint,
        [
          'memory_search',
          'memory_get',
          'context_retrieve',
          'graph_get',
          'graph_query',
          'graph_explain',
          'job_get',
          'job_result',
        ].includes(tool.name),
      );
    }
    const query = tools.find((tool) => tool.name === 'memory_search')!.inputSchema;
    const privacy = query.properties!.includePrivate as any;
    assert.equal(privacy.const ?? privacy.enum?.[0], false);
    await assert.rejects(s.call('unknown_tool', {}));
    assert.equal(f.calls(), 0);
    assert.deepEqual(f.sb.calls(), []);
  } finally {
    await s?.close();
    await f.close();
  }
});

test('final MCP uses the actual daemon for public mutations, finite version errors, fixed project scope and indexed docs', async () => {
  const f = await runtimeFixture();
  let s: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    const other = gitRepo(f.sb, 'other');
    const foreign = (
      await f.rpc(
        'memory.store',
        { category: 'project', title: 'Foreign note', body: 'FOREIGN_CANARY elsewhere' },
        { ...f.scope, workspace: other },
      )
    ).memory;
    fs.writeFileSync(
      path.join(f.workspace, 'README.md'),
      '# Shop\nThe checkout page lives in web/checkout.\n',
    );
    const indexing = (await f.rpc('docs.index', {})).job;
    for (
      let n = 0;
      n < 100 &&
      ['queued', 'running'].includes((await f.rpc('job.get', { id: indexing.id })).state);
      n++
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal((await f.rpc('job.get', { id: indexing.id })).state, 'succeeded');
    s = await connect(f);
    const stored = await s.call('memory_store', {
      category: 'project',
      title: 'Use pnpm',
      body: 'pnpm only; npm breaks the lockfile',
      tags: ['tooling'],
    });
    assert.equal(stored.isError, undefined);
    const memory = structured(stored).memory;
    assert.deepEqual(JSON.parse((stored.content[0] as any).text), structured(stored));
    assert.equal(
      structured(await s.call('memory_search', { text: 'lockfile' })).hits[0].id,
      memory.id,
    );
    assert.match(structured(await s.call('memory_get', { id: memory.id })).memory.body, /lockfile/);
    const updated = await s.call('memory_update', {
      id: memory.id,
      expectedVersion: memory.version,
      patch: { body: 'pnpm only.' },
    });
    assert.equal(structured(updated).memory.version, memory.version + 1);
    const conflict = await s.call('memory_update', {
      id: memory.id,
      expectedVersion: memory.version,
      patch: { body: 'PRIVATE_ERROR_CANARY' },
    });
    assert.equal(conflict.isError, true);
    assert.equal(structured(conflict).error.code, 'conflict');
    assert.equal(structured(conflict).error.details, undefined);
    assert.equal(JSON.stringify(conflict).includes('CANARY'), false);
    const context = structured(await s.call('context_retrieve', { task: 'pnpm package install' }));
    assert.match(context.text, /Use pnpm/);
    const docs = structured(
      await s.call('context_retrieve', { task: 'checkout page', sources: ['docs'] }),
    );
    assert.match(docs.text, /README\.md/);
    assert.equal((await s.call('memory_get', { id: foreign.id })).isError, true);
    for (const args of [
      { text: 'FOREIGN_CANARY', projectId: foreign.projectId },
      { text: 'FOREIGN_CANARY', includePrivate: true },
    ]) {
      const denied = await s.call('memory_search', args);
      assert.equal(denied.isError, true);
      assert.equal(JSON.stringify(denied).includes('FOREIGN_CANARY'), false);
    }
    const invalid = await s.call('memory_store', {
      category: 'project',
      title: '',
      body: 'PRIVATE_ERROR_CANARY',
    });
    assert.equal(invalid.isError, true);
    assert.equal(JSON.stringify(invalid).includes('CANARY'), false);
    assert.equal(
      structured(await s.call('memory_delete', { id: memory.id })).memory.status,
      'archived',
    );
    assert.equal(
      structured(await s.call('memory_delete', { id: memory.id })).memory.status,
      'archived',
    );
    assert.equal(s.stderr().includes('CANARY'), false);
    assert.deepEqual(f.sb.calls(), []);
  } finally {
    await s?.close();
    await f.close();
  }
});

test('final MCP keeps private records opaque and bounds oversized public replies while preserving a successful mutation receipt', async () => {
  const f = await runtimeFixture();
  let s: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    const privateNote = (
      await f.rpc('memory.store', {
        category: 'project',
        title: 'Bank',
        body: 'Private note PRIVATE_CANARY',
        private: true,
      })
    ).memory;
    const before = await f.rpc('memory.get', { id: privateNote.id, events: true });
    s = await connect(f);
    const secret = await s.call('memory_get', { id: privateNote.id });
    assert.deepEqual(structured(secret), { memory: { private: true } });
    for (const patch of [{ private: false }, { title: 'Guess PRIVATE_CANARY' }]) {
      const denied = await s.call('memory_update', {
        id: privateNote.id,
        expectedVersion: privateNote.version,
        patch,
      });
      assert.equal(denied.isError, true);
      assert.equal(JSON.stringify(denied).includes('CANARY'), false);
    }
    assert.deepEqual(await f.rpc('memory.get', { id: privateNote.id, events: true }), before);
    assert.deepEqual(
      structured(await s.call('memory_search', { text: 'PRIVATE_CANARY' })).hits,
      [],
    );
    for (const sources of [['curated'], ['lexical'], ['graph'], ['overview']]) {
      const inspected = structured(
        await s.call('context_retrieve', {
          task: 'Private note PRIVATE_CANARY',
          sources,
          includeCandidates: true,
        }),
      );
      assert.deepEqual(inspected.candidates, []);
      assert.deepEqual(inspected.items, []);
      assert.equal(JSON.stringify(inspected).includes(privateNote.id), false);
      assert.equal(JSON.stringify(inspected).includes('PRIVATE_CANARY'), false);
    }
    assert.equal(
      JSON.stringify(
        await s.call('context_retrieve', { task: 'Private note PRIVATE_CANARY' }),
      ).includes('PRIVATE_CANARY'),
      false,
    );
    const body = 'Bounded public note ' + '\u0001'.repeat(3900);
    const created = await s.call('memory_store', {
      category: 'project',
      title: 'Large public receipt',
      body,
    });
    assert.equal(created.isError, undefined);
    assert.equal(structured(created).truncated, true);
    assert.equal(structured(created).memory.version, 1);
    assert.equal(structured(created).memory.body, undefined);
    assert.ok(Buffer.byteLength((created.content[0] as any).text) <= 20000);
    assert.equal(
      (await f.rpc('memory.get', { id: structured(created).memory.id })).memory.body,
      body,
    );
    for (let n = 0; n < 10; n++)
      await f.rpc('memory.store', {
        category: 'project',
        title: 'Capped public batch ' + n,
        body: 'Bounded corpus ' + n + ' ' + 'x'.repeat(3500),
      });
    const batch = await s.call('memory_search', { text: 'Bounded corpus', limit: 20 });
    assert.equal(batch.isError, undefined);
    assert.equal(structured(batch).truncated, true);
    assert.ok(structured(batch).hits.length > 0 && structured(batch).hits.length < 10);
    assert.ok(Buffer.byteLength((batch.content[0] as any).text) <= 20000);
    assert.equal(s.stderr().includes('CANARY'), false);
  } finally {
    await s?.close();
    await f.close();
  }
});
