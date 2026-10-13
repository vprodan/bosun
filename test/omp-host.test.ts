import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { HostBundle } from '../src/core/ports/host.ts';
import { sandbox, fresh } from './helpers.ts';
import { createOmpHost } from '../src/adapters/hosts/omp/host.ts';
import { parseOmpPrompt, renderOmpHookExtension } from '../src/adapters/hosts/omp/hook-extension.ts';
import { BosunError } from '../src/core/errors.ts';

function bundle(command: string): HostBundle {
  return { roles: [], skills: {}, policy: 'Approved public owner policy.',
    mcp: { command, args: ['mcp'], env: {} }, hook: { command, args: [], timeoutS: 1, env: {} } };
}

test('OMP native prompt admission rejects absent/private/malformed classification and credential-shaped content', () => {
  const base = { host: 'omp', privacy: 'public', prompt: 'Approved public task.', cwd: '/tmp', session_id: 'native_session' };
  for (const privateFlag of [true, 0, 1, 'false', '0', null])
    assert.equal(parseOmpPrompt(JSON.stringify({ ...base, private: privateFlag }), {}), null);
  assert.equal(parseOmpPrompt(JSON.stringify({ ...base, privacy: undefined }), {}), null);
  assert.equal(parseOmpPrompt(JSON.stringify({ ...base, privacy: 'private' }), {}), null);
  assert.equal(parseOmpPrompt(JSON.stringify({ ...base, prompt: 'api_key=' + 'z'.repeat(40) }), {}), null);
  assert.deepEqual(parseOmpPrompt(JSON.stringify({ ...base, private: false }), {}),
    { text: base.prompt, privacy: 'public', cwd: '/tmp', sessionId: 'native_session' });
});

test('OMP owned-profile removal cannot escape the declared native tree or adopt arbitrary links', async () => {
  const host = createOmpHost();
  for (const file of ['../private-config', '/tmp/other', '.omp/auth.json', 'shared/../other'])
    await assert.rejects(host.planUninstall([{ op: 'write', path: file, text: 'owner bytes' }]), error => error instanceof BosunError && error.code === 'invalid');
  await assert.rejects(host.planUninstall([{ op: 'link', path: 'skills/bosun-review', target: '../../outside' }]), error => error instanceof BosunError && error.code === 'invalid');
  assert.deepEqual(await host.planUninstall([{ op: 'write', path: 'index.ts', text: 'owned module' }]), [{ op: 'remove', path: 'index.ts' }]);
});

test('actual OMP extension requires a leading per-turn public marker and never attaches stale context to another prompt', async () => {
  const sb = sandbox({ stubs: ['bosun-hook'] }); fresh(sb);
  const file = path.join(sb.home, 'omp-extension.ts'), command = path.join(sb.bin, 'bosun-hook');
  fs.writeFileSync(command, `#!/usr/bin/env bun\nconst fs=require('node:fs'); const request=JSON.parse(fs.readFileSync(0,'utf8'));\nfs.appendFileSync(process.env.STUB_OUT,JSON.stringify({prompt:request.prompt,privacy:request.privacy})+'\\n');\nconsole.log(JSON.stringify({hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:'Approved public context.'}}));\n`, { mode: 0o755 });
  fs.writeFileSync(file, renderOmpHookExtension(bundle(command)), { mode: 0o600 });
  const handlers = new Map<string, (event: Record<string, unknown>, ctx: typeof context) => unknown | Promise<unknown>>();
  const context = { cwd: sb.home, agent: { kind: 'main' }, sessionManager: { getSessionId: () => 'native_session' } };
  try {
    // Runtime-selected generated extension exercises the actual emitted module.
    const module: unknown = await import(pathToFileURL(file).href);
    assert.ok(module && typeof module === 'object' && 'default' in module && typeof module.default === 'function');
    module.default({ on(name: string, handler: (event: Record<string, unknown>, ctx: typeof context) => unknown) { handlers.set(name, handler); } });
    const input = handlers.get('input')!, prepare = handlers.get('before_agent_start')!;
    for (const text of ['PRIVATE_CANARY', 'Quoted #public PRIVATE_CANARY', '"#public PRIVATE_CANARY"']) {
      await input({ source: 'interactive', text }, context);
      assert.equal(await prepare({ prompt: text, systemPrompt: ['Base.'] }, context), undefined);
    }
    assert.deepEqual(sb.calls(), []);
    const prompt = '#public Approved public task.';
    await input({ source: 'interactive', text: prompt }, context);
    assert.deepEqual(await prepare({ prompt, systemPrompt: ['Base.'] }, context), { systemPrompt: ['Base.', 'Approved public context.'] });
    assert.equal(sb.calls().length, 1);
    await input({ source: 'interactive', text: prompt }, context);
    assert.equal(await prepare({ prompt: 'Different later prompt.', systemPrompt: ['Base.'] }, context), undefined);
    assert.equal(await prepare({ prompt, systemPrompt: ['Base.'] }, context), undefined);
    const calls = sb.calls().length;
    await input({ source: 'extension', text: prompt }, context);
    await input({ source: 'interactive', text: prompt, images: [{}] }, context);
    assert.equal(sb.calls().length, calls);
  } finally { sb.cleanup(); }
});
