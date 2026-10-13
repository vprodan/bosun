// Review-only driver. Executing it requires the owner's explicit exception to
// RESUME.md's Bun-test prohibition; it is not part of the application suite.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { verifyDistribution } from './distribution.mjs';

const expectedHash = '5a8600206ee8527c1410f833af612d2ce5afc510fd1f7ddf92ea7089f6cfe202';
const expectedSource = 'b0d4f9d16034d15b96ac70aada8ec47a3200847870362c14c2ab9b02ca555223';
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const outputLimit = 1024 * 1024;

async function check(binary, root, args, input, initialize = false) {
  const home = fs.mkdtempSync(path.join(root, 'check-'));
  const directories = Object.fromEntries(['bosun', 'config', 'cache', 'data', 'state', 'tmp', 'empty-path']
    .map(name => [name, path.join(home, name)]));
  for (const directory of Object.values(directories)) fs.mkdirSync(directory, { mode: 0o700 });
  const env = { HOME: home, BOSUN_HOME: directories.bosun,
    XDG_CONFIG_HOME: directories.config, XDG_CACHE_HOME: directories.cache,
    XDG_DATA_HOME: directories.data, XDG_STATE_HOME: directories.state,
    TMPDIR: directories.tmp, PATH: directories['empty-path'], LANG: 'C', TZ: 'UTC' };
  const child = spawn(binary, args, { cwd: home, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  const stdout = []; const stderr = []; let bytes = 0; let failure = null;
  let initialized = false; let eofSent = false; let pending = ''; let killTimer;
  const decoder = new StringDecoder('utf8');
  const kill = signal => { try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') failure ??= 'termination-error'; } };
  const stop = reason => {
    if (failure) return;
    failure = reason; kill('SIGTERM');
    killTimer = setTimeout(() => kill('SIGKILL'), 500);
  };
  const timer = setTimeout(() => stop('deadline'), 5000);
  const record = (chunks, chunk) => {
    bytes += chunk.length;
    if (bytes > outputLimit) { stop('output-limit'); return; }
    chunks.push(chunk);
    if (chunks !== stdout || !initialize || failure) return;
    pending += decoder.write(chunk);
    let newline;
    while ((newline = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line);
        assert.equal(initialized, false);
        assert.equal(message.jsonrpc, '2.0'); assert.equal(message.id, 1);
        assert.equal(message.error, undefined);
        assert.equal(message.result?.serverInfo?.name, 'bosun');
        assert.equal(message.result?.serverInfo?.version, '0.2.0');
        assert.equal(message.result?.protocolVersion, '2025-11-25');
        initialized = true; eofSent = true; child.stdin.end();
      } catch { stop('initialization-receipt'); }
    }
  };
  child.stdout.on('data', chunk => record(stdout, chunk));
  child.stderr.on('data', chunk => record(stderr, chunk));
  child.stdin.on('error', () => stop('stdin-error'));
  const terminal = new Promise(resolve => {
    child.once('error', () => { failure ??= 'spawn-error'; });
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  if (initialize) child.stdin.write(input);
  else { eofSent = true; child.stdin.end(input); }
  const result = await terminal;
  clearTimeout(timer); clearTimeout(killTimer);
  const out = Buffer.concat(stdout).toString('utf8');
  const err = Buffer.concat(stderr).toString('utf8');
  try {
    assert.equal(failure, null); assert.equal(result.code, 0); assert.equal(result.signal, null);
    assert.equal(err, '');
    if (args[0] === '--version') assert.equal(out.trim(), '0.2.0');
    else if (args[0] === '--help') {
      assert.match(out, /Usage: bosun/);
      for (const command of ['run', 'mcp', 'managed', 'upgrade']) assert.match(out, new RegExp('\\b' + command + '\\b'));
    } else if (initialize) { assert.equal(initialized, true); assert.equal(eofSent, true); assert.equal(pending.trim(), ''); }
    else assert.equal(out, '');
  } catch { failure ??= 'assertion'; }
  return { args, passed: failure === null, failure, ...result, eofSent,
    initialized: initialize ? initialized : undefined,
    stdoutBytes: Buffer.byteLength(out), stderrBytes: Buffer.byteLength(err), stdoutSha256: sha256(out) };
}

let temporary;
try {
  assert.equal(process.versions.bun, undefined);
  assert.ok(Number(process.versions.node.split('.')[0]) >= 24);
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
  const [approvalScope, artifact, ...extra] = process.argv.slice(2);
  assert.equal(approvalScope, '--approved-entry-only');
  assert.equal(extra.length, 0); assert.ok(artifact);
  const directory = path.resolve(artifact);
  const verified = verifyDistribution(directory);
  assert.equal(verified.version, '0.2.0'); assert.equal(verified.binarySha256, expectedHash);
  assert.equal(verified.sourceDigest, expectedSource);
  const bytes = fs.readFileSync(path.join(directory, 'bosun'));
  assert.equal(sha256(bytes), expectedHash);
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'bosun-compiled-entry-'));
  fs.chmodSync(temporary, 0o700);
  const binary = path.join(temporary, 'bosun');
  fs.writeFileSync(binary, bytes, { flag: 'wx', mode: 0o700 });
  assert.equal(sha256(fs.readFileSync(binary)), expectedHash);
  const initialization = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'bosun-entry-check', version: '1' } } }) + '\n';
  const checks = [];
  for (const [args, input, initialize] of [
    [['--version'], ''], [['--help'], ''], [['hook', '--private'], '{invented-malformed'],
    [['route', '--hook', '--private'], '{invented-malformed'], [['mcp'], initialization, true],
  ]) checks.push(await check(binary, temporary, args, input, initialize));
  console.log(JSON.stringify({ coverage: 'compiled-entry-only', binarySha256: expectedHash,
    sourceDigest: expectedSource, applicationSuiteRuntime: 'node', checks,
    qualified: checks.every(check => check.passed) }, null, 2));
  if (checks.some(check => !check.passed)) process.exitCode = 1;
} catch {
  console.error('Compiled entry preparation or verification failed; no retry.');
  process.exitCode = 1;
} finally {
  if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
}
