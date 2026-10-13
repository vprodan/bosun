// Review-only, opt-in native metadata check. No application import, prompt,
// authentication, package manager, SDK, installer or service operation.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const candidate = Object.freeze({
  version: '2.1.292',
  url: 'https://registry.npmjs.org/@anthropic-ai/claude-code-darwin-arm64/-/claude-code-darwin-arm64-2.1.292.tgz',
  archiveSha512: 'SBkmDQOPbQ9bqkGrzshn92ByyqQy2P7pSs/11NdMLq2VXbcQc93z+yd8Dtx4+jeAX22G7GSvQpKDyKev70Vn8Q==',
  binarySha256: '97a01e5bc74a199e67189435d0331ea3a24eac2e07db4b76d9148c5b0386138f',
  binaryBytes: 235017328, unpackedBytes: 235017905,
});
const digest = (bytes, algorithm = 'sha256', format = 'hex') => crypto.createHash(algorithm).update(bytes).digest(format);
const sizes = new Map([['package/claude', candidate.binaryBytes], ['package/package.json', 277], ['package/LICENSE.md', 147], ['package/README.md', 153]]);
const octal = bytes => {
  const text = bytes.toString('ascii').replace(/\0.*$/s, '').trim();
  assert.match(text, /^[0-7]+$/); const value = parseInt(text, 8); assert.ok(Number.isSafeInteger(value)); return value;
};
// Exact package only: no tar command, links, PAX/global headers, path creation,
// script execution, arbitrary members or extraction outside the private tree.
export function packageBinary(archive) {
  assert.equal(digest(archive, 'sha512', 'base64'), candidate.archiveSha512);
  const tar = zlib.gunzipSync(archive, { maxOutputLength: candidate.unpackedBytes + 65536 });
  const seen = new Set(); let binary, at = 0, ended = false;
  while (at + 512 <= tar.length) {
    const header = tar.subarray(at, at + 512);
    if (header.every(byte => byte === 0)) {
      assert.ok(tar.length - at >= 1024); assert.ok(tar.subarray(at).every(byte => byte === 0)); ended = true; break;
    }
    const name = header.subarray(0, 100).toString('ascii').replace(/\0.*$/s, '');
    assert.equal(header.subarray(345, 500).toString('ascii').replace(/\0.*$/s, ''), '');
    assert.ok(header[156] === 0 || header[156] === 48);
    assert.ok(header.subarray(157, 257).every(byte => byte === 0));
    let sum = 0; for (let index = 0; index < 512; index++) sum += index >= 148 && index < 156 ? 32 : header[index];
    assert.equal(sum, octal(header.subarray(148, 156)));
    const size = octal(header.subarray(124, 136));
    assert.equal(size, sizes.get(name)); assert.ok(!seen.has(name)); seen.add(name);
    const start = at + 512, end = start + size; assert.ok(end <= tar.length);
    if (name === 'package/claude') binary = tar.subarray(start, end);
    at = start + Math.ceil(size / 512) * 512;
  }
  assert.equal(ended, true); assert.equal(seen.size, sizes.size); assert.ok(binary);
  assert.equal(digest(binary), candidate.binarySha256);
  // Little-endian 64-bit Mach-O and Apple ARM64 CPU type.
  assert.equal(binary.readUInt32LE(0), 0xfeedfacf); assert.equal(binary.readUInt32LE(4), 0x0100000c);
  return binary;
}
export async function metadataProcess(command, args, cwd, env, onReport = () => {}) {
  const child = spawn(command, args, { cwd, env, shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let bytes = 0, stdout = '', stderr = '', failed = false, closed = false, hard;
  const kill = name => { try { process.kill(-child.pid, name); } catch (error) { if (error.code !== 'ESRCH') failed = true; } };
  const stop = () => { if (closed) return; failed = true; kill('SIGTERM'); hard ??= setTimeout(() => { if (!closed) kill('SIGKILL'); }, 500); };
  for (const [stream, which] of [[child.stdout, 'out'], [child.stderr, 'err']]) stream.on('data', chunk => {
    if ((bytes += chunk.length) > 1048576) { stop(); return; }
    if (which === 'out') stdout += chunk.toString('utf8'); else stderr += chunk.toString('utf8');
  });
  child.stdin.on('error', stop); child.stdin.end();
  child.on('error', () => { failed = true; });
  const timer = setTimeout(stop, 10000);
  let result;
  try { result = await new Promise(resolve => child.once('close', (code, signal) => { closed = true; resolve({ code, signal }); })); }
  finally { clearTimeout(timer); clearTimeout(hard); }
  // An ordinary surviving descendant cannot outlive this disposable check.
  let groupAlive = false;
  if (child.pid) try { process.kill(-child.pid, 0); groupAlive = true; } catch (error) { if (error.code !== 'ESRCH') { failed = true; groupAlive = true; } }
  if (groupAlive) {
    failed = true; kill('SIGKILL');
    const end = Date.now() + 1000;
    while (Date.now() < end) {
      try { process.kill(-child.pid, 0); } catch (error) { if (error.code === 'ESRCH') { groupAlive = false; break; } }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  const report = { args, ...result, failed, groupJoined: !groupAlive,
    stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr),
    stdoutSha256: digest(stdout), stderrSha256: digest(stderr) };
  onReport(report);
  assert.equal(groupAlive, false); assert.equal(failed, false); assert.equal(result.code, 0); assert.equal(result.signal, null);
  return { report, stdout };
}
async function main() {
  let temporary, stage = 'admission', cleaned = false, childrenJoined = true; const checks = [];
  try {
    assert.equal(process.versions.bun, undefined); assert.ok(Number(process.versions.node.split('.')[0]) >= 24);
    assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
    assert.deepEqual(process.argv.slice(2), ['--approved-claude-metadata-only']);
    temporary = fs.realpathSync(fs.mkdtempSync('/tmp/bosun-claude-metadata-')); fs.chmodSync(temporary, 0o700);
    stage = 'pinned-publisher-download';
    const response = await fetch(candidate.url, { redirect: 'error', signal: AbortSignal.timeout(120000) });
    assert.equal(response.status, 200); const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; assert.ok(size <= 250000000); chunks.push(Buffer.from(chunk)); }
    stage = 'pinned-archive-binary-verification';
    const binary = packageBinary(Buffer.concat(chunks));
    const command = path.join(temporary, 'claude'); fs.writeFileSync(command, binary, { flag: 'wx', mode: 0o700 });
    assert.equal(digest(fs.readFileSync(command)), candidate.binarySha256);
    const directories = Object.fromEntries(['home', 'config', 'cache', 'data', 'state', 'tmp', 'empty-path'].map(name => [name, path.join(temporary, name)]));
    for (const value of Object.values(directories)) fs.mkdirSync(value, { mode: 0o700 });
    const env = { HOME: directories.home, CLAUDE_CONFIG_DIR: directories.config,
      XDG_CONFIG_HOME: directories.config, XDG_CACHE_HOME: directories.cache, XDG_DATA_HOME: directories.data,
      XDG_STATE_HOME: directories.state, TMPDIR: directories.tmp, PATH: directories['empty-path'], LANG: 'C', TZ: 'UTC',
      DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1' };
    stage = 'native-version';
    const report = value => { checks.push(value); childrenJoined = value.groupJoined; };
    childrenJoined = false;
    const version = await metadataProcess(command, ['--version'], directories.home, env, report);
    assert.equal(version.stdout.trim(), candidate.version + ' (Claude Code)');
    stage = 'native-help';
    childrenJoined = false;
    const help = await metadataProcess(command, ['--help'], directories.home, env, report);
    assert.match(help.stdout, /Usage:/);
    checks.push({ availableFlags: Object.fromEntries(['--session-id', '--resume', '--input-format', '--output-format', '--tools', '--model', '--effort', '--restricted', '--safe-mode', '--setting-sources'].map(flag => [flag, help.stdout.includes(flag)])) });
    // Public CLI help is evidence for the next exact protocol proposal.
    console.log(help.stdout);
    stage = 'passed';
  } catch { process.exitCode = 1; }
  finally {
    if (temporary && childrenJoined) { fs.rmSync(temporary, { recursive: true, force: true }); cleaned = !fs.existsSync(temporary); }
    console.log(JSON.stringify({ coverage: 'native-version-help-only', nativeInference: 'not-invoked',
      nativeManagedQualification: 'unverified', version: candidate.version, binarySha256: candidate.binarySha256, stage, checks, childrenJoined, cleaned,
      ...(!childrenJoined ? { heldTemporary: temporary } : {}) }, null, 2));
  }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
