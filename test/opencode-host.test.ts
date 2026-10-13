import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { HostBundle } from '../src/core/ports/host.ts';
import { sandbox, fresh } from './helpers.ts';
import { createOpenCodeHost } from '../src/adapters/hosts/opencode/host.ts';
import { renderOpenCodeHookPlugin } from '../src/adapters/hosts/opencode/hook-plugin.ts';
import { BosunError } from '../src/core/errors.ts';

test('OpenCode 2 refuses an old host version or an unrepresentable role variant before profile effects', async () => {
  const sb = sandbox(); fresh(sb);
  try {
    const command = path.join(sb.bin, 'bosun');
    const bundle: HostBundle = { roles: [], skills: {}, policy: 'Approved public policy.',
      mcp: { command, args: ['mcp'], env: {} }, hook: { command, args: [], timeoutS: 1, env: {} } };
    const host = createOpenCodeHost(), settings = { root: path.join(sb.home, 'profile'), nativeVersion: '1.18.34' };
    await assert.rejects(host.plan(bundle, settings), error => error instanceof BosunError && error.code === 'unsupported');
    await assert.rejects(host.plan({ ...bundle, roles: [{ id: 'worker', description: 'Public work.',
      instructions: 'Preserve exact choices.', access: 'edit', effort: 'high' }] }, { ...settings, nativeVersion: '2.0.27' }),
    error => error instanceof BosunError && error.code === 'unsupported');
    assert.equal(fs.existsSync(settings.root), false); assert.deepEqual(sb.calls(), []);
  } finally { sb.cleanup(); }
});

test('actual V2 plugin admits only per-input public text and binds context to the original native session/message', async () => {
  const sb = sandbox({ stubs: ['bosun-hook'] }); fresh(sb);
  const command = path.join(sb.bin, 'bosun-hook'), file = path.join(sb.home, 'plugin.ts');
  const bundle: HostBundle = { roles: [], skills: {}, policy: 'Approved public policy.',
    mcp: { command, args: ['mcp'], env: {} }, hook: { command, args: [], timeoutS: 1, env: {} } };
  fs.writeFileSync(command, `#!/usr/bin/env bun\nconst fs=require('node:fs'); const request=JSON.parse(fs.readFileSync(0,'utf8'));\nfs.appendFileSync(process.env.STUB_OUT,JSON.stringify({prompt:request.prompt,privacy:request.privacy})+'\\n');\nconsole.log(JSON.stringify({hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:'Approved public context.'}}));\n`, { mode: 0o755 });
  fs.writeFileSync(file, renderOpenCodeHookPlugin(bundle), { mode: 0o600 });
  const handlers = new Map<string, (event: Record<string, unknown>) => unknown | Promise<unknown>>();
  const context = (sessionID: string, id: string, text: string) => ({ sessionID, system: [],
    messages: [{ id, role: 'user', content: [{ type: 'text', text }] }] });
  const prompt = (text: string, extra: Record<string, unknown> = {}) => ({ sessionID: 'native_session',
    messageID: 'original_message', prompt: { text }, ...extra });
  try {
    // Runtime-selected emitted plugin executes the actual native hook module.
    const module: unknown = await import(pathToFileURL(file).href);
    assert.ok(module && typeof module === 'object' && 'default' in module);
    const plugin = module.default;
    assert.ok(plugin && typeof plugin === 'object' && 'setup' in plugin && typeof plugin.setup === 'function');
    const cleanup = await plugin.setup({ location: { directory: sb.home },
      session: { async hook(name: string, handler: (event: Record<string, unknown>) => unknown) { handlers.set(name, handler); } } });
    const input = handlers.get('prompt')!, prepare = handlers.get('context')!;
    for (const event of [prompt('PRIVATE_CANARY'), prompt('Quoted #public PRIVATE_CANARY'),
      prompt('#public PRIVATE_CANARY', { metadata: { privacy: 'private' } }),
      prompt('#public PRIVATE_CANARY', { metadata: { private: 'false' } }),
      prompt('#public PRIVATE_CANARY', { prompt: { text: '#public PRIVATE_CANARY', files: [{ uri: 'private:file' }] } })]) {
      await input(event); const output = context('native_session', 'original_message', '#public PRIVATE_CANARY');
      await prepare(output); assert.deepEqual(output.system, []);
    }
    assert.deepEqual(sb.calls(), []);
    const text = '#public Inspect approved public source.';
    await input(prompt(text)); const output = context('native_session', 'original_message', text);
    await prepare(output); assert.deepEqual(output.system, [{ type: 'text', text: 'Approved public context.' }]);
    await prepare(output); assert.equal(output.system.length, 1);
    await input(prompt(text)); const foreign = context('native_session', 'different_message', text);
    await prepare(foreign); assert.deepEqual(foreign.system, []);
    await prepare(context('native_session', 'original_message', text));
    await input(prompt(text)); await input(prompt('New private prompt.'));
    const stale = context('native_session', 'original_message', text); await prepare(stale);
    assert.deepEqual(stale.system, []);
    assert.equal(typeof cleanup, 'function'); cleanup();
  } finally { sb.cleanup(); }
});
