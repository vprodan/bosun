// The real Claude Code binary against a mock Anthropic endpoint: catches CLI flag drift after Claude updates.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sandbox, bosun, mock } from './helpers.ts';

const REAL = spawnSync('/bin/sh', ['-c', 'command -v claude'], { encoding: 'utf8' }).stdout.trim();

test('e2e: local claude --bare talks only to the local endpoint, with the dummy key and 3 tools', { skip: !REAL && 'claude not installed' }, async () => {
  const sb = sandbox({ stubs: [] });
  const m = await mock();
  try {
    const repo = path.join(sb.root, 'repo');
    fs.mkdirSync(repo);
    spawnSync('git', ['init', '-q'], { cwd: repo });
    const env = sb.env({ OLLAMA_URL: m.url, ANTHROPIC_AUTH_TOKEN: 'secret', PATH: `${path.dirname(REAL)}:${path.dirname(process.execPath)}:/usr/bin:/bin` });
    const r = await bosun(['run', '--no-watch', 'say hi'], { env, cwd: repo });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /MOCK-OK/);
    const msgs = m.requests.filter((q) => q.path.startsWith('/v1/messages'));
    assert.ok(msgs.length, 'no request reached the mock');
    for (const q of msgs) {
      assert.equal(q.headers['x-api-key'], 'ollama');
      assert.equal(q.headers.authorization, undefined, 'never the subscription token');
      assert.equal(q.body.model, 'qwen3.6:35b-a3b-coding-nvfp4');
      assert.deepEqual(q.body.tools.map((t: { name: string }) => t.name).sort(), ['Bash', 'Edit', 'Read']);
      assert.ok(JSON.stringify(q.body.system).length < 4000, 'bare mode keeps the system prompt tiny');
    }
  } finally { await m.close(); sb.cleanup(); }
});
