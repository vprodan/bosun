// Review-only native protocol check; both consumed runs are archived.
// This instrumented source requires a new exact owner exception before execution.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { candidate, packageBinary, metadataProcess } from './check-claude-metadata.mjs';
import { connectClaudeStream } from '../src/adapters/hosts/claude/client.ts';
import { BosunError } from '../src/core/errors.ts';
import { bindClaudeTranscript, readClaudeTranscriptSeed } from '../src/adapters/hosts/claude/transcript.ts';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const sourceRoot = path.resolve(import.meta.dirname, '..');
const expectedSources = '6a9845d012baf825fcbf7514cbf4afb8de8eb51d830d8e6dfc9d1d62357a4b11';
export function sourceDigest() {
  const entries = [], seen = new Set();
  function visit(file) {
    if (seen.has(file)) return; seen.add(file);
    const stat = fs.lstatSync(file); assert.equal(stat.isSymbolicLink(), false); assert.ok(stat.isFile());
    const text = fs.readFileSync(file, 'utf8'); entries.push([path.relative(sourceRoot, file), sha(text)]);
    for (const match of text.matchAll(/from\s+['"](\.{1,2}\/[^'"]+)['"]/g))
      visit(path.resolve(path.dirname(file), match[1]));
  }
  visit(path.join(sourceRoot, 'src/adapters/hosts/claude/client.ts'));
  visit(path.join(sourceRoot, 'src/adapters/hosts/claude/transcript.ts'));
  entries.push(['scripts/check-claude-metadata.mjs', sha(fs.readFileSync(path.join(sourceRoot, 'scripts/check-claude-metadata.mjs')))]);
  entries.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  return sha(JSON.stringify(entries));
}
function shape(value, depth = 0, budget = { remaining: 2000 }) {
  if (--budget.remaining < 0 || depth > 6) return { type: 'bounded' };
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return { type: 'number', finite: Number.isFinite(value) };
  if (typeof value === 'string') return { type: 'string', bytes: Buffer.byteLength(value), sha256: sha(value) };
  if (Array.isArray(value)) return { type: 'array', length: value.length, items: value.slice(0, 8).map(item => shape(item, depth + 1, budget)) };
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => /^[A-Za-z0-9_]{1,80}$/.test(key)).slice(0, 100).map(([key, item]) => [key, shape(item, depth + 1, budget)]));
  return { type: typeof value };
}
export function sandboxProfile(root, port) {
  assert.equal(path.resolve(root), root); assert.equal(fs.realpathSync(root), root);
  assert.ok(Number.isSafeInteger(port) && port > 0 && port < 65536);
  return `(version 1)
(deny default)
; Root inode traversal required by dyld; literal only, no subtree read.
(allow file-read* (literal "/"))
; Metadata of ancestors of the permitted runtime and temporary tree only.
(allow file-read-metadata (require-all (vnode-type DIRECTORY) (require-any (literal "/Library") (literal "/private") (literal "/private/tmp"))))
(allow process-exec)
(allow process-fork)
(allow process-info* (target self))
(allow sysctl-read)
(allow file-read* (subpath "/System") (subpath "/usr") (subpath "/Library/Apple") (subpath "/private/etc") (subpath "/etc") (subpath "/dev") (subpath ${JSON.stringify(root)}))
(allow file-write* (subpath ${JSON.stringify(root)}) (literal "/dev/null"))
(allow network-outbound (remote tcp "localhost:${port}"))
`;
}
// Only the assigned fixture file, not SDK discovery or another native session.
export function retainedSeed(home, cwd, projectKey, sessionId, uuid, text) {
  assert.equal(projectKey, 'bosun-' + sessionId);
  const binding = bindClaudeTranscript({ privacy: 'public', home, cwd, id: sessionId });
  const receipt = readClaudeTranscriptSeed(binding, { privacy: 'public', uuid, text });
  return { retainedSeed: true, seedSha256: receipt.seedHash, transcriptSha256: receipt.snapshotHash,
    bytes: receipt.bytes, nativeReadiness: receipt.nativeReadiness };
}
export async function probe(options) {
  const messages = [], checks = [], diagnostics = [], sessionId = crypto.randomUUID(), uuid = crypto.randomUUID();
  const projectKey = 'bosun-' + sessionId;
  const text = 'PUBLIC_BOSUN_BOOTSTRAP_FIXTURE: retain the exact constraints; wait for ownership transfer.';
  const env = { ...options.env, CLAUDE_CODE_PROJECT_DIR_NAME: projectKey };
  let client, joined = false, started = false, diagnosticOverflow = false, operation = 'connection';
  try {
    started = true;
    client = await connectClaudeStream({ command: options.command, env, cwd: options.cwd, sessionId, model: 'sonnet', effort: 'high',
      requestTimeoutMs: 5000, timeoutMs: 45000, killGraceMs: 500,
      notification(row) { assert.ok(messages.length < 128); messages.push({ subtype: row.subtype, shape: shape(row) }); },
      diagnostic(row) { if (diagnostics.length < 16) diagnostics.push(row); else diagnosticOverflow = true; },
      closed() { joined = true; },
    }, AbortSignal.timeout(45000));
    for (const method of ['get_settings', 'get_hooks_listing', 'get_status']) {
      operation = method; checks.push({ method, shape: shape(await client.read(method)) });
    }
    operation = 'append-public-seed';
    await client.append({ privacy: 'public', text, uuid });
    checks.push({ appendReceipt: true, uuidBound: true, shouldQuery: false, seedSha256: sha(text) });
    for (const method of ['get_status', 'export_conversation', 'get_context_usage']) {
      operation = method; checks.push({ method, shape: shape(await client.read(method)) });
    }
    operation = 'independent-retained-seed';
    checks.push(retainedSeed(options.home, options.cwd, projectKey, sessionId, uuid, text));
    assert.equal(options.providerRequests(), 0);
    assert.equal(diagnosticOverflow, false);
    operation = 'passed';
  } finally {
    try { if (client) await client.close(); }
    finally { options.report({ checks, messages, diagnostics, diagnosticOverflow, operation, started, joined }); }
  }
  assert.equal(joined, true);
  return checks;
}
async function main() {
  let temporary, server, stage = 'admission', providerRequests = 0, joined = true, cleaned = false, failureKind;
  const checks = [];
  try {
    assert.equal(process.versions.bun, undefined); assert.ok(Number(process.versions.node.split('.')[0]) >= 24);
    assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
    assert.deepEqual(process.argv.slice(2), ['--approved-claude-bootstrap-diagnostics-only']);
    assert.equal(sourceDigest(), expectedSources);
    assert.equal(sha(fs.readFileSync(path.join(sourceRoot, 'scripts/check-claude-metadata.mjs'))), '2a36c41932db73c7b396b21f188f3288bab50d1d2b01df3358ae104d6453e059');
    temporary = fs.realpathSync(fs.mkdtempSync('/tmp/bosun-claude-bootstrap-')); fs.chmodSync(temporary, 0o700);
    const directories = Object.fromEntries(['home', 'claude-home', 'workspace', 'config', 'cache', 'data', 'state', 'tmp', 'empty-path'].map(name => [name, path.join(temporary, name)]));
    for (const directory of Object.values(directories)) fs.mkdirSync(directory, { mode: 0o700 });
    server = http.createServer((request, response) => {
      providerRequests++; request.resume();
      response.writeHead(403, { 'content-type': 'application/json', connection: 'close' });
      response.end('{"type":"error","error":{"type":"permission_error","message":"Fixture inference denied"}}');
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port;
    const profile = path.join(temporary, 'native.sb'); fs.writeFileSync(profile, sandboxProfile(temporary, port), { flag: 'wx', mode: 0o600 });
    const env = { HOME: directories.home, CLAUDE_CONFIG_DIR: directories['claude-home'], XDG_CONFIG_HOME: directories.config,
      XDG_CACHE_HOME: directories.cache, XDG_DATA_HOME: directories.data, XDG_STATE_HOME: directories.state, TMPDIR: directories.tmp,
      PATH: directories['empty-path'], LANG: 'C', TZ: 'UTC', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + port,
      ANTHROPIC_API_KEY: 'bosun-public-synthetic-key-no-real-credential' };
    stage = 'sandbox-syntax'; joined = false;
    await metadataProcess('/usr/bin/sandbox-exec', ['-f', profile, '/usr/bin/true'], directories.home, env,
      report => { checks.push(report); joined = report.groupJoined; });
    stage = 'pinned-download';
    const response = await fetch(candidate.url, { redirect: 'error', signal: AbortSignal.timeout(120000) });
    assert.equal(response.status, 200); const chunks = []; let bytes = 0;
    for await (const chunk of response.body) { bytes += chunk.length; assert.ok(bytes <= 250000000); chunks.push(Buffer.from(chunk)); }
    stage = 'pinned-binary'; const binary = path.join(temporary, 'claude');
    fs.writeFileSync(binary, packageBinary(Buffer.concat(chunks)), { flag: 'wx', mode: 0o700 });
    assert.equal(sha(fs.readFileSync(binary)), candidate.binarySha256);
    const wrapper = path.join(temporary, 'native-wrapper.cjs');
    fs.writeFileSync(wrapper, '#!' + process.execPath + '\nconst cp=require("node:child_process");\nconst child=cp.spawn("/usr/bin/sandbox-exec",' + JSON.stringify(['-f', profile, binary]) + '.concat(process.argv.slice(2)),{stdio:"inherit",env:process.env,shell:false});\nchild.once("error",()=>process.exit(1));child.once("close",(code)=>process.exit(code??1));\n', { mode: 0o700, flag: 'wx' });
    stage = 'owned-protocol'; joined = false;
    await probe({ command: wrapper, env, cwd: directories.workspace, home: directories['claude-home'], providerRequests: () => providerRequests,
      report(value) { checks.push(value); joined = value.joined; } });
    stage = 'passed';
  } catch (error) {
    process.exitCode = 1;
    failureKind = error instanceof BosunError ? error.code : 'check-failed';
  }
  finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    if (temporary && joined) { fs.rmSync(temporary, { recursive: true, force: true }); cleaned = !fs.existsSync(temporary); }
    console.log(JSON.stringify({ coverage: 'owned-native-bootstrap-protocol-only', sourceDigest: expectedSources,
      binarySha256: candidate.binarySha256, stage, checks, providerRequests, joined, cleaned,
      ...(failureKind ? { failureKind } : {}),
      nativeAutomaticQualification: 'unverified', ...(!joined ? { heldTemporary: temporary } : {}) }, null, 2));
  }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
