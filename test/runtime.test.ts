import './bootstrap.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { test } from 'node:test';
import { BosunError } from '../src/core/errors.ts';
import { rpcRequest, rpcResponse, rpcError, RPC_LIMITS, type RpcRequest } from '../src/contracts/rpc.ts';
import { runtimePaths } from '../src/platform/paths.ts';
import { asset, roleDefinitions, skillAssets, version } from '../src/platform/assets.ts';
import { callLocalRpc } from '../src/adapters/transport/local-rpc.ts';
import { serveLocalRpc } from '../src/adapters/transport/local-rpc-server.ts';
import { project, memoryScope, normalizeOrigin } from '../src/platform/project.ts';
import { streamProcess, type ProcessEvent, type ProcessInput } from '../src/platform/process.ts';
import { parseRuntimeConfig, loadRuntimeConfig, saveRuntimeConfig, renderRuntimeConfig, configRevision } from '../src/platform/config.ts';
import { loadHookConfig, parseHookConfig } from '../src/platform/hook-config.ts';
import { publishHookConfig } from '../src/app/config.ts';

let sequence = 0;
function socket() { return path.join(process.env.BOSUN_TEST_RUN_ROOT!, `s${process.pid}_${++sequence}`); }
function request(method: string, params: Record<string, unknown> = {}): RpcRequest { return { version: 1, id: `r${++sequence}`, method, params }; }
const unknown = (error: unknown) => error instanceof BosunError && error.code === 'unavailable' && error.details?.outcome === 'unknown';

test('runtime paths are explicit and path calculation does not create files', () => {
  const home = path.join(process.env.HOME!, 'missing');
  const paths = runtimePaths({ BOSUN_HOME: home, BOSUN_SOCKET: socket() }, () => { throw new Error('ambient HOME used'); });
  assert.equal(paths.config, path.join(home, 'config.toml'));
  assert.equal(paths.state, path.join(home, 'state.db')); assert.ok(Object.isFrozen(paths));
  const explicitHome = runtimePaths({ HOME: home }, () => { throw new Error('runtime home fallback used'); });
  assert.equal(explicitHome.home, path.join(home, '.bosun'));
  assert.equal(explicitHome.legacyConfig, path.join(home, '.bosun', 'config.env'));
  assert.equal(explicitHome.memory, path.join(home, '.bosun', 'memory.db'));
  const otherHome = path.join(process.env.HOME!, 'other-missing');
  assert.equal(runtimePaths({ HOME: otherHome }).config, path.join(otherHome, '.bosun', 'config.toml'));
  assert.equal(runtimePaths({}, () => otherHome).home, path.join(otherHome, '.bosun'));
  assert.equal(fs.existsSync(home), false);
  assert.equal(fs.existsSync(otherHome), false);
  assert.throws(() => runtimePaths({ BOSUN_HOME: '../bad' }), (e: unknown) => e instanceof BosunError && e.code === 'invalid');
});

test('shipped roles and skills resolve from embedded assets in a synthetic working directory', () => {
  const roles = roleDefinitions();
  assert.deepEqual(roles.map(role => role.id), ['architect', 'debugger', 'reviewer', 'scout', 'tester', 'worker']);
  assert.equal(roles.find(role => role.id === 'reviewer')!.access, 'read');
  assert.ok(roles.every(role => role.instructions.length > 100 && role.description.length > 20));
  assert.ok(Object.hasOwn(skillAssets(), 'skills/bosun-handoff/SKILL.md'));
  assert.ok(Object.hasOwn(skillAssets(), 'skills/bosun-openai-models/references/models.md'));
  assert.match(version, /^\d+\.\d+\.\d+/);
  assert.throws(() => asset('../private'), (e: unknown) => e instanceof BosunError && e.code === 'not_found');
});

test('final project scope preserves existing clone/worktree/non-repo identities and configured links', () => {
  const root = path.join(process.env.HOME!, 'identity'); fs.mkdirSync(root);
  const repo = path.join(root, 'repo'); const clone = path.join(root, 'clone'); const worktree = path.join(root, 'worktree'); const plain = path.join(root, 'plain');
  for (const dir of [repo, clone, worktree, plain]) fs.mkdirSync(dir);
  fs.mkdirSync(path.join(repo, '.git', 'worktrees', 'topic'), { recursive: true }); fs.mkdirSync(path.join(clone, '.git'));
  fs.writeFileSync(path.join(repo, '.git', 'config'), '[remote "origin"]\n url = git@github.com:Org/Repo.git\n');
  fs.writeFileSync(path.join(clone, '.git', 'config'), '[remote "origin"]\n url = https://user@github.com/org/repo\n');
  fs.writeFileSync(path.join(worktree, '.git'), 'gitdir: ../repo/.git/worktrees/topic\n');
  fs.writeFileSync(path.join(repo, '.git', 'worktrees', 'topic', 'commondir'), '../..\n');
  assert.equal(normalizeOrigin('git@github.com:Org/Repo.git'), 'github.com/org/repo');
  assert.equal(normalizeOrigin('https://user@github.com/org/repo/'), 'github.com/org/repo');
  assert.throws(() => project('relative/path'), (e: unknown) => e instanceof BosunError && e.code === 'unavailable');
  assert.throws(() => project(path.join(root, 'missing')), (e: unknown) => e instanceof BosunError && e.code === 'unavailable');
  assert.equal(project(repo).id, project(clone).id); assert.equal(project(repo).id, project(worktree).id);
  const linked = [project(plain).id, project(plain).id];
  const scope = memoryScope(project(repo), linked, 'session-1', 'owner');
  assert.deepEqual(scope.linked, [linked[0]]); assert.equal(scope.projectId, project(repo).id); assert.equal(scope.sessionId, 'session-1');
  assert.throws(() => memoryScope(project(repo), ['../other']), (e: unknown) => e instanceof BosunError && e.code === 'invalid');
});

test('shared envelopes reject skew/extra fields and normalize provider errors', () => {
  const q = request('job.get'); assert.deepEqual(rpcRequest(q), q);
  for (const v of [{ ...q, version: 2 }, { ...q, id: '' }, { ...q, params: [] }, { ...q, secret: 'canary' }]) assert.throws(() => rpcRequest(v));
  assert.deepEqual(rpcError(new Error('PROVIDER_SECRET')), { code: 'internal', message: 'Request failed' });
  assert.deepEqual(rpcError(new BosunError('conflict', 'PRIVATE_ROW', { details: { currentVersion: 7 } })), { code: 'conflict', message: 'Request conflicts with current state', details: { currentVersion: 7 } });
  const error = rpcResponse({ version: 1, id: q.id, ok: false, error: { code: 'unavailable', message: 'TRANSPORT_CANARY', details: { outcome: 'unknown', token: 'SECRET' } } }, q.id);
  assert.equal(JSON.stringify(error).includes('CANARY'), false); assert.equal(JSON.stringify(error).includes('SECRET'), false);
  assert.throws(() => rpcResponse({ version: 1, id: 'other', ok: true, result: 'ok' }, q.id));
});

test('native UDS RPC preserves concurrent request identity and uses protected socket', async () => {
  const file = socket(); let owned = true; let calls = 0;
  const server = await serveLocalRpc({ socket: file, assertOwner() { if (!owned) throw new BosunError('unavailable', 'owner lost'); },
    async dispatch(q) { calls++; if (q.method === 'test.fail') throw new Error('PROVIDER_SECRET'); return { id: q.id, value: q.params.value }; } });
  try {
    assert.equal(fs.lstatSync(file).mode & 0o777, 0o600);
    const qs = [request('test.echo', { value: 'one' }), request('test.echo', { value: 'two' })];
    const replies = await Promise.all(qs.map(q => callLocalRpc<{ id: string; value: string }>({ socket: file, request: q })));
    assert.deepEqual(replies, qs.map(q => ({ id: q.id, value: q.params.value })));
    await assert.rejects(callLocalRpc({ socket: file, request: request('test.fail') }), (e: unknown) => e instanceof BosunError && e.code === 'internal' && !e.message.includes('SECRET'));
    owned = false;
    await assert.rejects(callLocalRpc({ socket: file, request: request('test.echo') }), (e: unknown) => e instanceof BosunError && e.code === 'unavailable');
    assert.equal(calls, 3);
  } finally { await server.close(); }
  assert.equal(fs.existsSync(file), false);
});

test('malformed and oversized requests never invoke dispatch; stopped admission stays closed', async () => {
  const file = socket(); let calls = 0;
  const server = await serveLocalRpc({ socket: file, assertOwner() {}, async dispatch() { calls++; return 'ok'; } });
  async function raw(body: string) {
    return await new Promise<string>((resolve, reject) => {
      const req = http.request({ socketPath: file, path: '/rpc', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
        let text = ''; res.on('data', part => text += part); res.once('end', () => resolve(text)); res.once('error', reject);
      }); req.once('error', reject); req.end(body);
    });
  }
  try {
    assert.equal(JSON.parse(await raw('{bad')).error.code, 'invalid');
    assert.equal(JSON.parse(await raw(JSON.stringify({ ...request('test.echo'), version: 9 }))).error.code, 'invalid');
    // Early refusal may close a peer still writing the oversized body.
    const refused = await raw('x'.repeat(RPC_LIMITS.requestBytes + 1)).then(text => JSON.parse(text).error.code,
      (error: NodeJS.ErrnoException) => error.code);
    assert.ok(['invalid', 'EPIPE', 'ECONNRESET'].includes(refused));
    server.stopAdmission();
    await assert.rejects(callLocalRpc({ socket: file, request: request('test.echo') }), (e: unknown) => e instanceof BosunError && e.code === 'unavailable');
    assert.equal(calls, 0);
  } finally { await server.close(); }
});

test('lost mutation reply has unknown outcome and is never automatically repeated', async () => {
  const file = socket(); let effects = 0; let aborted!: () => void; let completed!: () => void;
  const seenAbort = new Promise<void>(r => aborted = r); const completion = new Promise<void>(r => completed = r);
  const server = await serveLocalRpc({ socket: file, assertOwner() {}, async dispatch(_q, signal) {
    effects++; signal.addEventListener('abort', aborted, { once: true }); await completion; return effects;
  } });
  try {
    await assert.rejects(callLocalRpc({ socket: file, request: request('test.mutate'), mutation: true, timeoutMs: 30 }), unknown);
    await seenAbort; assert.equal(effects, 1);
    const closing = server.close(); completed(); await closing;
    assert.equal(effects, 1);
  } finally { completed(); await server.close(); }
});

test('oversized successful replies preserve uncertainty instead of claiming a failed mutation', async () => {
  const file = socket(); let effects = 0;
  const server = await serveLocalRpc({ socket: file, assertOwner() {}, async dispatch() { effects++; return 'x'.repeat(RPC_LIMITS.responseBytes); } });
  try { await assert.rejects(callLocalRpc({ socket: file, request: request('test.mutate'), mutation: true }), unknown); assert.equal(effects, 1); }
  finally { await server.close(); }
});

test('unsafe socket parents and existing ordinary files are not adopted or deleted', async () => {
  const ordinary = socket(); fs.writeFileSync(ordinary, 'preserve', { mode: 0o600 });
  await assert.rejects(serveLocalRpc({ socket: ordinary, assertOwner() {}, async dispatch() {} }));
  assert.equal(fs.readFileSync(ordinary, 'utf8'), 'preserve'); fs.unlinkSync(ordinary);
  const directory = path.join(process.env.HOME!, 'public'); fs.mkdirSync(directory, { mode: 0o755 });
  await assert.rejects(serveLocalRpc({ socket: path.join(directory, 's'), assertOwner() {}, async dispatch() {} }));
  assert.equal(fs.existsSync(path.join(directory, 's')), false);
});

test('native process streaming preserves split UTF8/stdin and reports positive process close', async () => {
  const input = 'literal $(do-not-run) — task';
  const events: ProcessEvent[] = [];
  const source = "const fs=require('node:fs'); const text=fs.readFileSync(0,'utf8'); const bytes=Buffer.from(text+'\\n'); const split=bytes.indexOf(Buffer.from('—'))+1; process.stdout.write(bytes.subarray(0,split)); setTimeout(()=>{process.stdout.write(bytes.subarray(split));process.stdout.write('last');},10);";
  for await (const event of streamProcess({ command: process.execPath, args: ['-e', source], cwd: process.env.HOME!, env: process.env, input, signal: new AbortController().signal })) events.push(event);
  assert.deepEqual(events, [{ t: 'line', text: input }, { t: 'line', text: 'last' }, { t: 'exit', code: 0, signal: null }]);
});

test('native process cancellation waits for close and kills an ordinary worker ignoring TERM', async () => {
  const controller = new AbortController(); let pid = 0; const events: ProcessEvent[] = [];
  const source = "process.on('SIGTERM',()=>{}); process.stdout.write(String(process.pid)+'\\n'); setInterval(()=>{},1000);";
  await assert.rejects(async () => {
    for await (const event of streamProcess({ command: process.execPath, args: ['-e', source], cwd: process.env.HOME!, env: process.env,
      signal: controller.signal, killGraceMs: 20 })) {
      events.push(event); if (event.t === 'line') { pid = Number(event.text); controller.abort(); }
    }
  }, (error: unknown) => error instanceof BosunError && error.code === 'cancelled');
  assert.ok(pid > 0); assert.equal(events.some(event => event.t === 'exit'), false);
  assert.throws(() => process.kill(pid, 0), (error: NodeJS.ErrnoException) => error.code === 'ESRCH');
});

test('oversized native lines and stderr stop the process without exposing its error content', async () => {
  for (const source of ["process.stdout.write('x'.repeat(200)+'\\n');setInterval(()=>{},1000)", "process.stderr.write('PRIVATE_CANARY'.repeat(100));setInterval(()=>{},1000)"]) {
    const events: ProcessEvent[] = [];
    await assert.rejects(async () => {
      for await (const event of streamProcess({ command: process.execPath, args: ['-e', source], cwd: process.env.HOME!, env: process.env,
        signal: new AbortController().signal, maxLineBytes: 100, maxOutputBytes: source.includes('stderr') ? 200 : 1024, killGraceMs: 20 })) events.push(event);
    }, (error: unknown) => error instanceof BosunError && error.code === 'unavailable' && error.message === 'Process output unavailable');
    assert.deepEqual(events, []);
  }
});

test('native process channel permits bounded interactive stdin and positive peer acknowledgement', async () => {
  let input: ProcessInput | undefined; const observed: ProcessEvent[] = [];
  const source = "const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>process.stdout.write('ack:'+line+'\\n'));rl.on('close',()=>process.exit(0));";
  for await (const event of streamProcess({ command: process.execPath, args: ['-e', source], cwd: process.env.HOME!, env: process.env,
    signal: new AbortController().signal, stdin(channel) { input = channel; void channel.write('one — literal $(no-shell)\n'); } })) {
    observed.push(event);
    if (event.t === 'line' && observed.length === 1) await input!.write('two\n');
    else if (event.t === 'line') input!.end();
  }
  assert.deepEqual(observed, [{ t: 'line', text: 'ack:one — literal $(no-shell)' }, { t: 'line', text: 'ack:two' }, { t: 'exit', code: 0, signal: null }]);
  await assert.rejects(input!.write('late'), (error: unknown) => error instanceof BosunError && error.code === 'unavailable');
});

test('native cancellation kills an ordinary descendant even when its parent closes first', async () => {
  const controller = new AbortController(); let descendant = 0;
  const ready = path.join(process.env.HOME!, 'descendant-ready');
  const childSource = "process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(process.argv[1],'ready');setInterval(()=>{},1000);";
  const parentSource = `const fs=require('node:fs');const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childSource)},${JSON.stringify(ready)}],{env:process.env,stdio:'ignore'});process.on('SIGTERM',()=>process.exit(0));const poll=setInterval(()=>{if(fs.existsSync(${JSON.stringify(ready)})){clearInterval(poll);process.stdout.write(String(child.pid)+'\\n');}},10);`;
  await assert.rejects(async () => {
    for await (const event of streamProcess({ command: process.execPath, args: ['-e', parentSource], cwd: process.env.HOME!, env: process.env,
      signal: controller.signal, killGraceMs: 1000 })) if (event.t === 'line') { descendant = Number(event.text); controller.abort(); }
  }, (error: unknown) => error instanceof BosunError && error.code === 'cancelled');
  assert.ok(descendant > 0); assert.throws(() => process.kill(descendant, 0), (error: NodeJS.ErrnoException) => error.code === 'ESRCH');
});

for (const settles of [true, false]) {
  test(`permission-denied native group termination ${settles ? 'joins only after actual absence' : 'holds while an actual descendant survives'}`, async () => {
    const token = ++sequence;
    const ready = path.join(process.env.HOME!, `denied-ready-${token}`);
    const release = path.join(process.env.HOME!, `denied-release-${token}`);
    const worker = `const fs=require('node:fs');fs.watch(${JSON.stringify(process.env.HOME)},()=>{if(fs.existsSync(${JSON.stringify(release)}))process.exit(0);});fs.writeFileSync(${JSON.stringify(ready)},'ready');`;
    const source = `const fs=require('node:fs');let child;const watcher=fs.watch(${JSON.stringify(process.env.HOME)},()=>{if(fs.existsSync(${JSON.stringify(ready)})){watcher.close();process.stdout.write(JSON.stringify({parent:process.pid,descendant:child.pid})+'\\n');process.exit(0);}});child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(worker)}],{env:process.env,stdio:'ignore'});`;
    const nativeKill = process.kill;
    let parent = 0, descendant = 0, denied = 0, joined = false;
    const events: ProcessEvent[] = [];
    process.kill = (pid, signal) => {
      if (parent > 0 && pid === -parent && signal === 'SIGKILL') {
        nativeKill(pid, 0); // Denial is injected only while the real owned group exists.
        denied++;
        if (settles) fs.writeFileSync(release, 'release', { mode: 0o600 });
        throw Object.assign(new Error('Synthetic permission denial'), { code: 'EPERM' });
      }
      return nativeKill(pid, signal);
    };
    try {
      const consume = async () => {
        for await (const event of streamProcess({ command: process.execPath, args: ['-e', source], cwd: process.env.HOME!, env: process.env,
          signal: new AbortController().signal, killGraceMs: settles ? 2000 : 100,
          onClosed() {
            assert.throws(() => nativeKill(-parent, 0), (error: NodeJS.ErrnoException) => error.code === 'ESRCH');
            assert.throws(() => nativeKill(descendant, 0), (error: NodeJS.ErrnoException) => error.code === 'ESRCH');
            joined = true;
          },
        })) {
          events.push(event);
          if (event.t === 'line') {
            const ids: { parent: number; descendant: number } = JSON.parse(event.text);
            parent = ids.parent; descendant = ids.descendant;
          }
        }
      };
      if (settles) {
        await consume();
        assert.equal(joined, true);
        assert.deepEqual(events.at(-1), { t: 'exit', code: 0, signal: null });
      } else {
        await assert.rejects(consume(), (error: unknown) => error instanceof BosunError && error.code === 'unavailable');
        assert.equal(joined, false);
        assert.equal(events.some(event => event.t === 'exit'), false);
        assert.equal(nativeKill(-parent, 0), true);
        assert.equal(nativeKill(descendant, 0), true);
      }
      assert.equal(denied, 1); // No second kill attempt or manufactured acknowledgement.
    } finally {
      process.kill = nativeKill;
      if (parent > 0) {
        try { nativeKill(-parent, 'SIGKILL'); }
        catch (error) { if (!['ESRCH', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
        const deadline = performance.now() + 5000;
        for (;;) {
          try { nativeKill(-parent, 0); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') break;
            if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
          }
          assert.ok(performance.now() < deadline, 'owned fixture group must positively close before cleanup');
          // Real OS reaping, not a JS timer contract: fake time cannot make a native group disappear.
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      }
    }
  });
}

test('real TOML/Zod config applies typed defaults, TOML and explicit environment without changing chosen model names', () => {
  const config = parseRuntimeConfig('[roles.worker.codex]\nmodel="gpt-6.1-sol"\neffort="high"\n[router]\nmodel="custom:9b"\n',
    { BOSUN_ROUTER_MODEL: 'clef-flash:9b', BOSUN_ROLE_WORKER_OPENCODE_MODEL: 'provider/custom:exact:tag', BOSUN_HANDOFF_ENABLED: 'false', OPENAI_API_KEY: 'SECRET_CANARY' });
  assert.equal(config.roles.worker.codex!.model, 'gpt-6.1-sol');
  assert.equal(config.roles.worker.opencode!.model, 'provider/custom:exact:tag'); assert.equal(config.router.model, 'clef-flash:9b'); assert.equal(config.handoff.enabled, false);
  assert.equal(JSON.stringify(config).includes('CANARY'), false); assert.ok(Object.isFrozen(config.roles.worker.codex));
  assert.throws(() => { config.local.model = 'changed'; });
  const roundtrip = parseRuntimeConfig(renderRuntimeConfig(config)); assert.deepEqual(roundtrip, config); assert.equal(configRevision(roundtrip), configRevision(config));
  for (const text of ['broken=[', '[router]\nminConfidence=2\n', '[providers.default]\nurl="https://user:SECRET_CANARY@example.com"\n', '[daemon]\nmaxStoredJobs=1\n', 'surprise="SECRET_CANARY"\n']) {
    assert.throws(() => parseRuntimeConfig(text), (error: unknown) => error instanceof BosunError && error.code === 'invalid' && !error.message.includes('CANARY'));
  }
  assert.throws(() => parseRuntimeConfig('', { BOSUN_HANDOFF_ENABLED: 'yes' }));
  const pinned = parseRuntimeConfig('[router]\nmodel = "clef-custom:chosen"\ndigest = "sha256:' + 'a'.repeat(64) + '"\n', { BOSUN_ROUTER_DIGEST: 'b'.repeat(64) });
  assert.equal(pinned.router.model, 'clef-custom:chosen'); assert.equal(pinned.router.digest, 'b'.repeat(64));
  assert.equal(parseRuntimeConfig(renderRuntimeConfig(pinned)).router.digest, pinned.router.digest);
  assert.throws(() => parseRuntimeConfig('', { BOSUN_ROUTER_DIGEST: 'DIGEST_CANARY' }), (error: unknown) => error instanceof BosunError && !error.message.includes('CANARY'));
  const consolidation = parseRuntimeConfig('[graph]\nextraction = true\n[graph.consolidation]\nmaxOutstanding = 3\nmaxSources = 2\n', { BOSUN_GRAPH_PROVIDER: 'default' });
  assert.equal(consolidation.graph.consolidation.maxOutstanding, 3); assert.equal(consolidation.graph.consolidation.maxSources, 2);
  assert.equal(consolidation.graph.consolidation.allowRemoteApi, false); assert.equal(consolidation.graph.consolidation.schedule.enabled, false);
  assert.equal(parseRuntimeConfig(renderRuntimeConfig(consolidation)).providers.default.model, consolidation.providers.default.model);
  for (const settings of ['maxOutstanding = 21', 'maxSources = 9', 'maxProposals = 5', 'allowRemoteApi = "CANARY"']) {
    assert.throws(() => parseRuntimeConfig('[graph.consolidation]\n' + settings), (error: unknown) => error instanceof BosunError && error.code === 'invalid' && !error.message.includes('CANARY'));
  }
  assert.throws(() => parseRuntimeConfig('[graph.consolidation.schedule]\nenabled = true\nintervalMs = 1000\n'));
  const retention = parseRuntimeConfig('[daemon]\njobRetentionDays = 45\nmaxStoredReceipts = 2000\nmaxDailyUsageGroups = 3000\n', { BOSUN_DRAIN_MS: '250' });
  assert.equal(retention.daemon.jobRetentionDays, 45); assert.equal(retention.daemon.drainMs, 250);
  assert.equal(parseRuntimeConfig(renderRuntimeConfig(retention)).daemon.maxStoredReceipts, 2000);
  for (const settings of ['jobRetentionDays = 0', 'maxStoredReceipts = 16385', 'maxDailyUsageGroups = 0', 'drainMs = 0']) assert.throws(() => parseRuntimeConfig('[daemon]\n' + settings));
});

test('config reads create nothing; administrative writes publish an atomic lean snapshot with independent path binding', () => {
  const home = path.join(process.env.HOME!, 'configuration'); const paths = runtimePaths({ BOSUN_HOME: home, BOSUN_SOCKET: socket() });
  loadRuntimeConfig(paths, {}); assert.equal(loadHookConfig(paths), null); assert.equal(fs.existsSync(home), false);
  fs.mkdirSync(home, { mode: 0o700 }); fs.mkdirSync(paths.run, { mode: 0o700 });
  const config = parseRuntimeConfig('[hosts]\nprimary="codex"\n'); saveRuntimeConfig(paths, config);
  assert.deepEqual(loadRuntimeConfig(paths, {}), config); assert.equal(fs.statSync(paths.config).mode & 0o777, 0o600);
  const snapshot = publishHookConfig(config, paths, { sourceId: '00000000-0000-4000-8000-000000000001', now: 1234 });
  assert.deepEqual(loadHookConfig(paths), snapshot); assert.equal(snapshot.configRevision, configRevision(config)); assert.equal(snapshot.primaryHost, 'codex');
  assert.equal(fs.statSync(paths.hookConfig).mode & 0o777, 0o600);
  const text = fs.readFileSync(paths.hookConfig, 'utf8');
  for (const name of ['providers', 'passwordEnv', 'tokenEnv', 'roles', 'apiKey']) assert.equal(text.includes(name), false);
  const otherPaths = runtimePaths({ BOSUN_HOME: path.join(home, 'other'), BOSUN_SOCKET: paths.socket }); assert.throws(() => parseHookConfig(text, otherPaths));
  fs.writeFileSync(paths.hookConfig, '{malformed'); assert.equal(loadHookConfig(paths), null);
  assert.equal(fs.readFileSync(paths.hookConfig, 'utf8'), '{malformed');
  assert.deepEqual(fs.readdirSync(home).sort(), ['config.toml', 'run']);
  assert.deepEqual(fs.readdirSync(paths.run), ['hook-config.json']);
});
