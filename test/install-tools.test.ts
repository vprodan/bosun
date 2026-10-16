import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, fresh } from './helpers.ts';
import { defaultConfig } from '../src/core/domain/config.ts';
import { runtimePaths } from '../src/platform/paths.ts';
import { setupRuntime } from '../src/app/setup.ts';
import { createOptionalTools, type OptionalToolsQuestion } from '../src/app/install-tools.ts';
import type { OptionalToolsDependencies, OptionalToolCommand } from '../src/app/install-tools-native.ts';
import { beginOptionalToolEffect, optionalToolHistory } from '../src/app/install-tools-receipts.ts';

async function fixture(options: { installed?: boolean; ready?: boolean; present?: boolean; brew?: boolean; env?: Record<string, string> } = {}) {
  const sb = sandbox(); fresh(sb);
  const app = path.join(sb.home, 'Applications', 'Ollama.app');
  const cli = path.join(app, 'Contents', 'Resources', 'ollama');
  const brew = path.join(sb.root, 'brew');
  fs.writeFileSync(brew, 'synthetic brew executable\n', { mode: 0o755 });
  const env = sb.env({ BOSUN_OLLAMA_APP: app, ...options.env });
  const paths = runtimePaths(env);
  await setupRuntime(paths, defaultConfig());
  const makeApp = (root: string) => {
    fs.mkdirSync(path.join(root, 'Contents', 'Resources'), { recursive: true, mode: 0o755 });
    fs.writeFileSync(path.join(root, 'Contents', 'Resources', 'ollama'), 'synthetic ollama executable\n', { mode: 0o755 });
  };
  if (options.installed !== false) makeApp(app);
  const state = { ready: options.ready ?? true, present: options.present ?? false, pullLost: false, startLost: false, startNeverReady: false, installLost: false, trustDenied: false, foreignOnVerify: false, detachLost: false };
  const commands: OptionalToolCommand[] = [];
  const requests: string[] = [];
  const downloads: string[] = [];
  let output = '';
  const model = env.BOSUN_ROUTER_MODEL || 'clef-flash:9b';
  const deps: OptionalToolsDependencies = {
    platform: 'darwin', arch: 'arm64',
    executable(command) {
      if (command === 'brew') return options.brew ? brew : null;
      if (command === 'ollama') return fs.existsSync(cli) ? cli : null;
      return null;
    },
    async run(command) {
      commands.push(command);
      const name = path.basename(command.command);
      if (command.args[0] === '--version') return { code: 0, output: 'ollama version is 0.40.4\n' };
      if (name === 'codesign' || name === 'spctl') {
        if (state.foreignOnVerify && name === 'spctl' && !fs.existsSync(app)) {
          makeApp(app); fs.writeFileSync(path.join(app, 'owner-file'), 'foreign retained\n');
        }
        return { code: state.trustDenied ? 1 : 0, output: '' };
      }
      if (name === 'hdiutil') {
        if (command.args[0] === 'attach') makeApp(path.join(command.args[command.args.indexOf('-mountpoint') + 1]!, 'Ollama.app'));
        if (command.args[0] === 'detach' && state.detachLost) throw new Error('lost detach confirmation');
        return { code: 0, output: '' };
      }
      if (name === 'ditto') {
        // The synthetic image has one CLI; cpSync's ancestor walk would cross the run root.
        const relative = path.join('Contents', 'Resources', 'ollama');
        fs.mkdirSync(path.dirname(path.join(command.args.at(-1)!, relative)), { recursive: true, mode: 0o755 });
        fs.copyFileSync(path.join(command.args.at(-2)!, relative), path.join(command.args.at(-1)!, relative));
        if (state.installLost) throw new Error('lost copy confirmation');
        return { code: 0, output: '' };
      }
      if (name === 'brew') {
        makeApp(app);
        if (state.installLost) throw new Error('lost Homebrew confirmation');
        return { code: 0, output: '' };
      }
      if (name === 'open') {
        if (!state.startNeverReady) state.ready = true;
        if (state.startLost) throw new Error('lost launch confirmation');
        return { code: 0, output: '' };
      }
      if (command.args[0] === 'pull') {
        if (state.pullLost) throw new Error('lost pull confirmation');
        state.present = true;
        return { code: 0, output: '' };
      }
      throw new Error(`Unexpected synthetic native command: ${name}`);
    },
    async metadata(url) {
      requests.push(url);
      if (!state.ready) throw new Error('synthetic unavailable');
      if (url.endsWith('/api/version')) return { version: '0.40.4' };
      if (url.endsWith('/api/tags')) return { models: state.present ? [{ name: model, model }] : [] };
      throw new Error('Non-metadata request denied');
    },
    async download(url, destination) {
      downloads.push(url);
      fs.writeFileSync(destination, 'synthetic signed disk image fixture\n', { mode: 0o600 });
    },
    async sleep() {},
  };
  const run = (approve: (question: OptionalToolsQuestion) => boolean = () => true) => createOptionalTools(deps)({
    env, cwd: sb.root,
    confirm: async question => approve(question),
    write: text => { output += text; },
  });
  return { sb, env, paths, app, cli, state, deps, commands, requests, downloads, run, output: () => output };
}

test('remote router selection preserves configuration and never installs, starts, pulls or contacts an endpoint', async () => {
  const f = await fixture({ installed: false, env: { BOSUN_ROUTER_URL: 'https://router.example.test', BOSUN_ROUTER_MODEL: 'owner/custom:exact' } });
  try {
    const config = fs.readFileSync(f.paths.config);
    await f.run();
    assert.deepEqual(f.commands, []); assert.deepEqual(f.requests, []); assert.deepEqual(f.downloads, []);
    assert.deepEqual(fs.readFileSync(f.paths.config), config);
  } finally { f.sb.cleanup(); }
});

test('declined missing Ollama install performs only metadata inspection and leaves no effect intent', async () => {
  const f = await fixture({ installed: false, ready: false });
  try {
    await f.run(q => q.kind === 'inspect');
    assert.deepEqual(f.commands, []); assert.deepEqual(f.downloads, []);
    assert.deepEqual(fs.readdirSync(f.paths.artifacts), []);
  } finally { f.sb.cleanup(); }
});

test('ordinary missing-brew machine uses approved official DMG, read-only mount and trust checks before owned copy, with separate launch and pull approvals', async () => {
  const f = await fixture({ installed: false, ready: false });
  try {
    const config = fs.readFileSync(f.paths.config);
    await f.run();
    assert.equal(f.state.present, true, f.output());
    assert.deepEqual(f.downloads, ['https://ollama.com/download/Ollama.dmg']);
    const attach = f.commands.find(c => c.command === '/usr/bin/hdiutil' && c.args[0] === 'attach')!;
    assert.ok(attach.args.includes('-readonly')); assert.ok(attach.args.includes('-nobrowse'));
    const copyIndex = f.commands.findIndex(c => c.command === '/usr/bin/ditto');
    assert.ok(f.commands.slice(0, copyIndex).some(c => c.command === '/usr/bin/codesign'));
    assert.ok(f.commands.slice(0, copyIndex).some(c => c.command === '/usr/sbin/spctl'));
    assert.deepEqual(f.commands.find(c => c.command === '/usr/bin/open')!.args, ['-a', f.app]);
    assert.deepEqual(f.commands.find(c => c.args[0] === 'pull')!.args, ['pull', 'clef-flash:9b']);
    assert.ok(f.requests.every(url => /\/api\/(version|tags)$/.test(url)));
    assert.deepEqual(fs.readFileSync(f.paths.config), config);
    assert.ok(fs.readdirSync(f.paths.artifacts).every(name => name.startsWith('optional-')));
    for (const name of fs.readdirSync(f.paths.artifacts)) {
      const directory = path.join(f.paths.artifacts, name);
      assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
      for (const file of fs.readdirSync(directory)) assert.equal(fs.statSync(path.join(directory, file)).mode & 0o777, 0o600);
    }
    assert.equal(optionalToolHistory(f.paths.artifacts, 'install', f.app).pending, null);
    assert.equal(optionalToolHistory(f.paths.artifacts, 'start', `http://127.0.0.1:11434\n${f.app}`).pending, null);
    assert.equal(optionalToolHistory(f.paths.artifacts, 'pull', 'http://127.0.0.1:11434\nclef-flash:9b').pending, null);
  } finally { f.sb.cleanup(); }
});

test('existing Homebrew is used without bootstrap, app launch or model pull when their separate choices are declined', async () => {
  const f = await fixture({ installed: false, ready: false, brew: true });
  try {
    await f.run(q => q.kind === 'inspect' || q.kind === 'install');
    const install = f.commands.find(c => path.basename(c.command) === 'brew')!;
    assert.deepEqual(install.args, ['install', '--cask', 'ollama-app', '--no-binaries', `--appdir=${path.dirname(f.app)}`]);
    assert.equal(install.env.HOMEBREW_NO_AUTO_UPDATE, '1');
    assert.deepEqual(f.downloads, []);
    assert.equal(f.commands.some(c => c.command === '/usr/bin/open' || c.args[0] === 'pull'), false);
  } finally { f.sb.cleanup(); }
});

test('already-present exact selected model only inspects version and metadata after inspection approval, without mutation prompts or receipts', async () => {
  const f = await fixture({ present: true, env: { BOSUN_ROUTER_MODEL: 'owner/clef:exact', BOSUN_ROUTER_URL: 'http://localhost:11999' } });
  try {
    await f.run();
    assert.deepEqual(f.commands.map(c => c.args), [['--version']]);
    assert.deepEqual(fs.readdirSync(f.paths.artifacts), []);
    assert.ok(f.requests.every(url => url.startsWith('http://localhost:11999/')));
  } finally { f.sb.cleanup(); }
});

test('model pull targets exact configured endpoint/model and strips unrelated credentials', async () => {
  const f = await fixture({ env: { BOSUN_ROUTER_URL: 'http://127.0.0.1:11999', BOSUN_ROUTER_MODEL: 'owner/clef:exact', OPENAI_API_KEY: 'private-never-forward' } });
  try {
    await f.run();
    const pull = f.commands.find(c => c.args[0] === 'pull')!;
    assert.deepEqual(pull.args, ['pull', 'owner/clef:exact']); assert.equal(pull.env.OLLAMA_HOST, 'http://127.0.0.1:11999');
    assert.equal(pull.env.OPENAI_API_KEY, undefined);
  } finally { f.sb.cleanup(); }
});

test('custom inactive endpoint holds without replacing binding or launching default app', async () => {
  const f = await fixture({ ready: false, env: { BOSUN_ROUTER_URL: 'http://127.0.0.1:11999' } });
  try {
    await f.run();
    assert.equal(f.commands.some(c => c.command === '/usr/bin/open'), false);
  } finally { f.sb.cleanup(); }
});

test('failed trust assessment blocks copying, launch and pull, retaining durable install intent without replay', async () => {
  const f = await fixture({ installed: false, ready: false });
  try {
    f.state.trustDenied = true; await f.run();
    assert.equal(fs.existsSync(f.app), false);
    assert.equal(f.commands.some(c => c.command === '/usr/bin/ditto' || c.command === '/usr/bin/open' || c.args[0] === 'pull'), false);
    assert.ok(optionalToolHistory(f.paths.artifacts, 'install', f.app).pending);
    const downloads = f.downloads.length; await f.run();
    assert.equal(f.downloads.length, downloads);
  } finally { f.sb.cleanup(); }
});

test('a foreign application appearing after mounted trust inspection is never merged or replaced', async () => {
  const f = await fixture({ installed: false, ready: false });
  try {
    f.state.foreignOnVerify = true; await f.run();
    assert.equal(fs.readFileSync(path.join(f.app, 'owner-file'), 'utf8'), 'foreign retained\n');
    assert.equal(f.commands.some(c => c.command === '/usr/bin/ditto'), false);
    assert.ok(optionalToolHistory(f.paths.artifacts, 'install', f.app).pending);
  } finally { f.sb.cleanup(); }
});

test('lost Homebrew return remains unknown despite installed command presence and never authorizes follow-on tools', async () => {
  const f = await fixture({ installed: false, ready: true, present: true, brew: true });
  try {
    f.state.installLost = true; await f.run();
    const original = optionalToolHistory(f.paths.artifacts, 'install', f.app);
    assert.ok(original.pending);
    const commands = f.commands.length; const requests = f.requests.length;
    await f.run();
    assert.deepEqual(optionalToolHistory(f.paths.artifacts, 'install', f.app), original);
    assert.equal(f.commands.length, commands); assert.equal(f.requests.length, requests);
    assert.equal(f.commands.some(c => c.command === '/usr/bin/open' || c.args[0] === 'pull'), false);
  } finally { f.sb.cleanup(); }
});

test('lost app launch acknowledgement remains unknown despite later visible readiness and model presence', async () => {
  const f = await fixture({ ready: false });
  try {
    f.state.startLost = true; await f.run();
    const target = `http://127.0.0.1:11434\n${f.app}`;
    const original = optionalToolHistory(f.paths.artifacts, 'start', target);
    assert.ok(original.pending);
    const commands = f.commands.length, requests = f.requests.length;
    f.state.ready = true; f.state.present = true; await f.run();
    assert.deepEqual(optionalToolHistory(f.paths.artifacts, 'start', target), original);
    assert.equal(f.commands.length, commands); assert.equal(f.requests.length, requests);
    assert.equal(f.commands.some(c => c.args[0] === 'pull'), false);
  } finally { f.sb.cleanup(); }
});

test('lost pull return stays permanently unknown even when exact model presence later appears', async () => {
  const f = await fixture();
  try {
    f.state.pullLost = true; await f.run();
    const target = 'http://127.0.0.1:11434\nclef-flash:9b';
    const original = optionalToolHistory(f.paths.artifacts, 'pull', target);
    assert.ok(original.pending);
    const commands = f.commands.length;
    await f.run();
    f.state.present = true; await f.run();
    assert.deepEqual(optionalToolHistory(f.paths.artifacts, 'pull', target), original);
    assert.equal(f.commands.length, commands);
    assert.equal(f.commands.filter(c => c.args[0] === 'pull').length, 1);
  } finally { f.sb.cleanup(); }
});

test('an interrupted durable intent prevents pull replay even without a recorded subprocess result', async () => {
  const f = await fixture();
  try {
    beginOptionalToolEffect(f.paths.artifacts, 'pull', 'http://127.0.0.1:11434\nclef-flash:9b');
    await f.run();
    assert.equal(f.commands.some(c => c.args[0] === 'pull'), false);
  } finally { f.sb.cleanup(); }
});

test('declined pull makes no mutation receipt and never claims model success', async () => {
  const f = await fixture();
  try {
    await f.run(q => q.kind === 'inspect');
    assert.deepEqual(fs.readdirSync(f.paths.artifacts), []);
    assert.equal(f.commands.some(c => c.args[0] === 'pull'), false);
  } finally { f.sb.cleanup(); }
});

test('lost mount-detach confirmation is not replayed and its private stage is retained for review', async () => {
  const f = await fixture({ installed: false, ready: false });
  try {
    f.state.detachLost = true; await f.run();
    assert.equal(f.commands.filter(c => c.command === '/usr/bin/hdiutil' && c.args[0] === 'detach').length, 1);
    assert.equal(f.commands.some(c => c.command === '/usr/bin/open' || c.args[0] === 'pull'), false);
    assert.ok(fs.readdirSync(f.paths.artifacts).some(name => name.startsWith('.ollama-stage-')));
    assert.ok(optionalToolHistory(f.paths.artifacts, 'install', f.app).pending);
  } finally { f.sb.cleanup(); }
});

test('changed reviewed CLI is fenced before pull dispatch and leaves a durable unknown intent', async () => {
  const f = await fixture();
  try {
    await f.run(q => {
      if (q.kind === 'pull') fs.appendFileSync(f.cli, 'changed after review\n');
      return true;
    });
    assert.equal(f.commands.some(c => c.args[0] === 'pull'), false);
    assert.ok(optionalToolHistory(f.paths.artifacts, 'pull', 'http://127.0.0.1:11434\nclef-flash:9b').pending);
  } finally { f.sb.cleanup(); }
});

test('model callers cannot inspect network, approve effects or change private receipts', async () => {
  const f = await fixture({ env: { BOSUN_CALLER: 'model' } });
  try {
    await f.run();
    assert.deepEqual(f.commands, []); assert.deepEqual(f.requests, []);
    assert.deepEqual(fs.readdirSync(f.paths.artifacts), []);
  } finally { f.sb.cleanup(); }
});

test('declining the default-No optional tools gate never executes a version command, contacts metadata, or writes receipts', async () => {
  const f = await fixture({ present: true });
  try {
    const config = fs.readFileSync(f.paths.config);
    const app = fs.readFileSync(f.cli);
    await f.run(() => false);
    assert.deepEqual(f.commands, []); assert.deepEqual(f.requests, []); assert.deepEqual(f.downloads, []);
    assert.deepEqual(fs.readdirSync(f.paths.artifacts), []);
    assert.deepEqual(fs.readFileSync(f.paths.config), config);
    assert.deepEqual(fs.readFileSync(f.cli), app);
  } finally { f.sb.cleanup(); }
});

test('an unresolved pull from another selection holds all new optional mutations without changing its original intent', async () => {
  const f = await fixture({ installed: false, ready: false });
  try {
    const target = 'http://127.0.0.1:11999\nowner/previous:exact';
    const original = beginOptionalToolEffect(f.paths.artifacts, 'pull', target);
    await f.run();
    assert.deepEqual(optionalToolHistory(f.paths.artifacts, 'pull', target), original);
    assert.deepEqual(f.commands, []); assert.deepEqual(f.requests, []); assert.deepEqual(f.downloads, []);
    assert.equal(optionalToolHistory(f.paths.artifacts, 'install', f.app).count, 0);
  } finally { f.sb.cleanup(); }
});

test('acknowledged app launch stays completed while first-run endpoint readiness is unavailable', async () => {
  const f = await fixture({ ready: false });
  try {
    f.state.startNeverReady = true; await f.run();
    const target = `http://127.0.0.1:11434\n${f.app}`;
    const original = optionalToolHistory(f.paths.artifacts, 'start', target);
    assert.equal(original.count, 1); assert.equal(original.pending, null);
    assert.equal(f.commands.some(c => c.args[0] === 'pull'), false);
    f.state.ready = true; f.state.present = true; await f.run();
    assert.deepEqual(optionalToolHistory(f.paths.artifacts, 'start', target), original);
    assert.equal(f.commands.filter(c => c.command === '/usr/bin/open').length, 1);
    assert.equal(f.commands.some(c => c.args[0] === 'pull'), false);
  } finally { f.sb.cleanup(); }
});

test('a lost copy acknowledgement retains its mounted stage without detaching an unconfirmed producer', async () => {
  const f = await fixture({ installed: false, ready: false });
  try {
    f.state.installLost = true; await f.run();
    assert.equal(f.commands.some(c => c.command === '/usr/bin/hdiutil' && c.args[0] === 'detach'), false);
    assert.ok(fs.readdirSync(f.paths.artifacts).some(name => name.startsWith('.ollama-stage-')));
    const original = optionalToolHistory(f.paths.artifacts, 'install', f.app);
    assert.ok(original.pending);
    const commands = f.commands.length; await f.run();
    assert.equal(f.commands.length, commands);
    assert.deepEqual(optionalToolHistory(f.paths.artifacts, 'install', f.app), original);
  } finally { f.sb.cleanup(); }
});

test('metadata failure after acknowledged pull cannot erase native completion or cause a duplicate pull', async () => {
  const f = await fixture();
  try {
    const metadata = f.deps.metadata;
    f.deps.metadata = async url => {
      if (url.endsWith('/api/tags') && f.commands.some(c => c.args[0] === 'pull')) throw new Error('synthetic metadata unavailable after native acknowledgement');
      return metadata(url);
    };
    await f.run();
    const target = 'http://127.0.0.1:11434\nclef-flash:9b';
    const original = optionalToolHistory(f.paths.artifacts, 'pull', target);
    assert.equal(original.count, 1); assert.equal(original.pending, null);
    f.deps.metadata = metadata; await f.run();
    assert.deepEqual(optionalToolHistory(f.paths.artifacts, 'pull', target), original);
    assert.equal(f.commands.filter(c => c.args[0] === 'pull').length, 1);
  } finally { f.sb.cleanup(); }
});
