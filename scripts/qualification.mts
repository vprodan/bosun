// Importable local qualification helpers; importing never executes a proposal.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { defaultConfig, type RuntimeConfig } from '../src/core/domain/config.ts';
import { streamProcess, type ProcessInput } from '../src/platform/process.ts';
import type { RpcScope } from '../src/contracts/rpc.ts';

export type CheckContext = { binary: string; cwd: string; env: Record<string, string>; home?: string; runtime?: string; socket?: string };
export type Isolation = { cwd: string; env: Record<string, string>; home: string; runtime: string; socket: string };
export type ProcessReceipt = {
  args: readonly string[]; joined: boolean; code: number | null; signal: string | null; error: string | null;
  wallMs?: number; stdoutBytes?: number; stdoutSha256?: string;
};
export type ProcessProbeResult = { receipt: ProcessReceipt; text: string };
export type ProbeDependencies = { execute?: typeof streamProcess };
export type ProcessProbeOptions = ProbeDependencies & {
  timeoutMs?: number; input?: string; stdin?: (input: ProcessInput) => void;
  stdout?: (chunk: Uint8Array) => void; controller?: AbortController; receipt?: ProcessReceipt;
};
export type EntryCase = { name: string; args: string[]; input?: string; initialize?: boolean };
export type EntryReceipt = ProcessReceipt & { check: string; passed: boolean; eofSent: boolean; initialized?: boolean };
export type DaemonReceipt = ProcessReceipt & { controlledCancellation: boolean; gracefulExitCode: 'unqualified-not-exposed-on-controlled-cancellation' };
export type ForegroundDaemon = { receipt: ProcessReceipt; ready(): Promise<void>; close(): Promise<DaemonReceipt> };
export type SqliteReceipt = {
  requests: number; originalMutations: number; privateOwnerReadable: boolean; modelPrivateOverrideRejected: boolean;
  modelPrivateSearchExcluded: boolean; modelPrivateContextExcluded: boolean; ownerStatusReceived: boolean;
};
export type QualificationRpc = (audience: RpcScope['audience'], method: string, params: Record<string, unknown>, invalid?: boolean) => Promise<unknown>;
export type LatencyDistribution = { samples: number; p50: number; p95: number };
export type BenchmarkQualification = {
  corpus: { notes: number; seed: number; synthetic: boolean }; engine: 'bun'; runtimeVersion: string; queries: number;
  store: LatencyDistribution; search: LatencyDistribution; context: LatencyDistribution;
  firstRun: { wallMs: number; outcome: 'injected' }; outcomes: { injected: number; held: number; failed: number; unqualified: number };
  wall: LatencyDistribution; verifiedInjectionWall: LatencyDistribution; nestedProducersReportedJoined: number;
  componentLatency: null; hostTokens: 'unverified'; designatedMacLatency: 'unverified';
};
export type BenchmarkProbeResult = { receipt: ProcessReceipt; passed: boolean; benchmark: BenchmarkQualification | null };
const OUTPUT = 1048576, DISK = 512 * 1024 * 1024;
const sha = (bytes: Uint8Array | string): string => crypto.createHash('sha256').update(bytes).digest('hex');
function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function finiteCode(error: unknown): string {
  const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return typeof code === 'string' && ['invalid', 'unavailable', 'timeout', 'cancelled'].includes(code) ? code : 'failed';
}

// The schema requires an enabled primary, but no selection/job is submitted.
export function isolatedConfig(home: string): RuntimeConfig {
  const config = defaultConfig();
  config.hosts.primary = 'opencode'; config.hosts.omp.enabled = false;
  config.hosts.codex.enabled = false; config.hosts.claude.enabled = false;
  config.hosts.opencode.command = path.join(home, 'empty-path', 'no-opencode');
  config.hosts.opencode.url = 'http://127.0.0.1:1';
  config.handoff.enabled = false; config.memory.claudeMem = false;
  config.graph.enabled = false; config.graph.vectors = false; config.graph.extraction = false;
  config.graph.consolidation.schedule.enabled = false; config.notifications.enabled = false; config.remote.enabled = false;
  config.router.url = 'http://127.0.0.1:1'; config.providers.default.url = 'http://127.0.0.1:1';
  return config;
}

export function prepareIsolation(root: string, name: string): Isolation {
  const home = path.join(root, name), cwd = path.join(home, 'workspace');
  fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(cwd, '.git'), { mode: 0o700 });
  fs.writeFileSync(path.join(cwd, '.git/config'), '[remote "origin"]\n url = https://fixture.invalid/compiled-current.git\n', { mode: 0o600 });
  const directory = (name: string): string => path.join(home, name);
  for (const name of ['runtime', 'config', 'cache', 'data', 'state', 'tmp', 'empty-path']) fs.mkdirSync(directory(name), { mode: 0o700 });
  const runtime = directory('runtime'), socket = path.join(root, 'b.sock');
  const env = { HOME: home, BOSUN_HOME: runtime, BOSUN_SOCKET: socket,
    XDG_CONFIG_HOME: directory('config'), XDG_CACHE_HOME: directory('cache'),
    XDG_DATA_HOME: directory('data'), XDG_STATE_HOME: directory('state'),
    TMPDIR: directory('tmp'), TMP: directory('tmp'), TEMP: directory('tmp'),
    PATH: directory('empty-path'), LANG: 'C', LC_ALL: 'C', TZ: 'UTC' };
  return { cwd, env, home, runtime, socket };
}

export function cleanupAllowed({ rootsJoined, benchmarkAttempted, benchmarkVerified }: {
  rootsJoined: boolean; benchmarkAttempted: boolean; benchmarkVerified: boolean;
}): boolean {
  return rootsJoined === true && (benchmarkAttempted !== true || benchmarkVerified === true);
}
export function ownedTreeBytes(root: string): number {
  let total = 0, count = 0;
  function walk(directory: string, depth: number): void {
    assert.ok(depth <= 20);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      assert.ok(++count <= 16384 && !entry.isSymbolicLink());
      const file = path.join(directory, entry.name), stat = fs.lstatSync(file);
      if (stat.isDirectory()) walk(file, depth + 1);
      else if (stat.isFile()) { total += stat.size; assert.ok(total <= DISK); }
      else assert.ok(stat.isSocket());
    }
  }
  walk(root, 0); return total;
}

export const entryCases: readonly EntryCase[] = Object.freeze([
  { name: 'version', args: ['--version'], input: '' },
  { name: 'help', args: ['--help'], input: '' },
  { name: 'private-hook', args: ['hook', '--private'], input: '{invented-malformed' },
  { name: 'private-route-hook', args: ['route', '--hook', '--private'], input: '{invented-malformed' },
  { name: 'mcp-initialize-eof', args: ['mcp'], initialize: true },
]);
export async function processProbe(context: CheckContext, args: readonly string[], {
  execute = streamProcess, timeoutMs = 15000, input = '', stdin, stdout, controller = new AbortController(), receipt,
}: ProcessProbeOptions = {}): Promise<ProcessProbeResult> {
  const state: ProcessReceipt = receipt ?? { args, joined: false, code: null, signal: null, error: null };
  const chunks: Buffer[] = []; const started = performance.now();
  try {
    for await (const event of execute({ command: context.binary, args, cwd: context.cwd, env: context.env,
      signal: controller.signal, timeoutMs, killGraceMs: 1000, maxOutputBytes: OUTPUT,
      ...(stdin ? { stdin } : { input }),
      stdout(chunk) { chunks.push(Buffer.from(chunk)); stdout?.(chunk); },
      onClosed() { state.joined = true; },
    })) if (event.t === 'exit') { state.code = event.code; state.signal = event.signal; }
  } catch (error) { state.error = finiteCode(error); }
  state.wallMs = performance.now() - started;
  const text = Buffer.concat(chunks).toString('utf8');
  state.stdoutBytes = Buffer.byteLength(text); state.stdoutSha256 = sha(text);
  return { receipt: state, text };
}

export async function runEntryProbe(context: CheckContext, entry: EntryCase, dependencies: ProbeDependencies = {}): Promise<EntryReceipt> {
  const controller = new AbortController(), decoder = new StringDecoder('utf8');
  let writer: ProcessInput | undefined, pending = '', initialized = false, eofSent = !entry.initialize, inputFailed = false;
  const initialization = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'bosun-current-entry-check', version: '1' } } }) + '\n';
  const result = await processProbe(context, entry.args, { ...dependencies, controller, timeoutMs: 5000, input: entry.input,
    ...(entry.initialize ? {
      stdin(input: ProcessInput) { writer = input; void input.write(initialization).catch(() => { inputFailed = true; controller.abort(); }); },
      stdout(chunk: Uint8Array) {
        pending += decoder.write(chunk);
        for (;;) {
          const newline = pending.indexOf('\n'); if (newline < 0) break;
          const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
          if (!line.trim()) continue;
          const message = record(JSON.parse(line)), result = record(message.result), serverInfo = record(result.serverInfo);
          assert.equal(initialized, false); assert.equal(message.jsonrpc, '2.0'); assert.equal(message.id, 1);
          assert.equal(message.error, undefined); assert.equal(serverInfo.name, 'bosun');
          assert.equal(serverInfo.version, '0.2.0'); assert.equal(result.protocolVersion, '2025-11-25');
          assert.ok(writer); initialized = true; eofSent = true; writer.end();
        }
      },
    } : {}),
  });
  let passed = false;
  try {
    assert.equal(result.receipt.joined, true); assert.equal(result.receipt.code, 0);
    assert.equal(result.receipt.signal, null); assert.equal(result.receipt.error, null); assert.equal(inputFailed, false);
    if (entry.name === 'version') assert.equal(result.text.trim(), '0.2.0');
    else if (entry.name === 'help') {
      assert.match(result.text, /Usage: bosun/);
      for (const command of ['run', 'mcp', 'managed', 'upgrade']) assert.match(result.text, new RegExp('\\b' + command + '\\b'));
    } else if (entry.initialize) { assert.ok(initialized && eofSent); assert.equal(pending.trim(), ''); }
    else assert.equal(result.text, '');
    passed = true;
  } catch { /* finite failed receipt, no raw output */ }
  return { check: entry.name, ...result.receipt, initialized: entry.initialize ? initialized : undefined, eofSent, passed };
}

export function foregroundDaemon(context: CheckContext, dependencies: ProbeDependencies = {}): ForegroundDaemon {
  const controller = new AbortController();
  const receipt: ProcessReceipt = { args: ['daemon', 'run'], joined: false, code: null, signal: null, error: null };
  let readyResolve: (() => void) | undefined;
  const ready = new Promise<void>(resolve => { readyResolve = resolve; });
  let prefix = '', announced = false;
  const pumping = processProbe(context, receipt.args, { ...dependencies, receipt, controller, timeoutMs: 60000,
    stdout(chunk) { prefix += Buffer.from(chunk).toString('utf8'); if (!announced && prefix.includes('bosun daemon ready\n')) { announced = true; readyResolve?.(); } },
  });
  return {
    receipt,
    async ready() {
      let timer: NodeJS.Timeout | undefined;
      try { await Promise.race([ready, pumping.then(() => { if (!announced) throw Error('readiness'); }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('readiness')), 15000); })]); }
      finally { clearTimeout(timer); }
      assert.equal(announced, true); assert.equal(receipt.joined, false);
    },
    async close() {
      controller.abort(); await pumping;
      return { ...receipt, controlledCancellation: receipt.error === 'cancelled',
        gracefulExitCode: 'unqualified-not-exposed-on-controlled-cancellation' };
    },
  };
}

export async function runSqliteRequests(call: QualificationRpc): Promise<SqliteReceipt> {
  const publicText = 'COMPILED_PUBLIC_FIXTURE_431 build rules use pnpm install packages';
  const privateText = 'COMPILED_PRIVATE_FIXTURE_927 build rules use a secret package registry';
  const publicNote = record(await call('owner', 'memory.store', { category: 'project', title: 'Build rules public', body: publicText, source: 'cli' }));
  const privateNote = record(await call('owner', 'memory.store', { category: 'project', title: 'Build rules private', body: privateText, private: true, source: 'cli' }));
  const publicId = record(publicNote.memory).id, privateId = record(privateNote.memory).id;
  assert.ok(typeof publicId === 'string' && typeof privateId === 'string');
  assert.match(publicId, /^m_[a-z0-9]+$/); assert.match(privateId, /^m_[a-z0-9]+$/); assert.notEqual(publicId, privateId);
  const owner = await call('owner', 'memory.get', { id: privateId });
  assert.ok(JSON.stringify(owner).includes(privateText));
  const rejected = record(await call('model', 'memory.search', { text: 'build rules', includePrivate: true }, true));
  assert.equal(rejected.code, 'invalid');
  const model = await call('model', 'memory.search', { text: 'build rules' });
  assert.ok(JSON.stringify(model).includes(publicText)); assert.ok(!JSON.stringify(model).includes(privateText));
  const context = await call('model', 'context.retrieve', { task: 'build rules pnpm install packages', sources: ['lexical'], privacy: 'public', includeCandidates: true });
  assert.ok(JSON.stringify(context).includes('COMPILED_PUBLIC_FIXTURE_431')); assert.ok(!JSON.stringify(context).includes('COMPILED_PRIVATE_FIXTURE_927'));
  const status = await call('owner', 'daemon.status', {}); assert.ok(status);
  return { requests: 7, originalMutations: 2, privateOwnerReadable: true, modelPrivateOverrideRejected: true,
    modelPrivateSearchExcluded: true, modelPrivateContextExcluded: true, ownerStatusReceived: true };
}

export async function currentRpc(socket: string, workspace: string, audience: RpcScope['audience'], method: string,
  params: Record<string, unknown>, sequence: number, invalid = false): Promise<unknown> {
  const id = 'current_' + sequence;
  const body = JSON.stringify({ version: 1, id, method, params, scope: { workspace, sessionId: null, audience } });
  const reply = record(await new Promise<unknown>((resolve, reject) => {
    let size = 0; const chunks: Buffer[] = [];
    const request = http.request({ socketPath: socket, path: '/rpc', method: 'POST', agent: false,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, response => {
      response.on('data', (chunk: Buffer) => { if ((size += chunk.length) > OUTPUT) request.destroy(Error('bound')); else chunks.push(chunk); });
      response.once('error', reject);
      response.once('end', () => { try { assert.equal(response.statusCode, 200); resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(Error('receipt')); } });
    });
    const timer = setTimeout(() => request.destroy(Error('deadline')), 5000);
    request.once('close', () => clearTimeout(timer)); request.once('error', reject); request.end(body);
  }));
  assert.equal(reply.version, 1); assert.equal(reply.id, id);
  if (invalid) { assert.equal(reply.ok, false); const error = record(reply.error); assert.equal(error.code, 'invalid'); return error; }
  assert.equal(reply.ok, true); return reply.result;
}

export function classifyBenchmark(input: unknown): BenchmarkQualification {
  const report = record(input);
  const distribution = (input: unknown, samples: number): LatencyDistribution => {
    const value = record(input);
    assert.equal(value.samples, samples);
    assert.ok(typeof value.p50 === 'number' && typeof value.p95 === 'number');
    assert.ok(Number.isFinite(value.p50) && Number.isFinite(value.p95) && value.p50 >= 0 && value.p95 >= value.p50 && value.p95 <= 180000);
    return { samples, p50: value.p50, p95: value.p95 };
  };
  assert.equal(report.schema, 1); assert.deepEqual(report.corpus, { notes: 10000, seed: 42, synthetic: true });
  const runtime = record(report.runtime);
  assert.equal(runtime.engine, 'bun'); assert.equal(runtime.version, '1.4.2'); assert.equal(Object.hasOwn(runtime, 'node'), false);
  assert.equal(report.queries, 200);
  const store = distribution(report.store, 10000), search = distribution(report.search, 200), context = distribution(report.context, 200);
  const corpusLoading = record(report.corpusLoading); assert.equal(corpusLoading.epochNotes, 256); distribution(corpusLoading.lifecycle, 39);
  const tokens = record(report.tokens);
  assert.equal(tokens.estimator, 'char/4'); assert.equal(tokens.hostTokens, 'unverified'); assert.equal(tokens.budget, 400);
  assert.equal(tokens.withinEstimate, 200); assert.ok(typeof tokens.maximumEstimate === 'number' && Number.isFinite(tokens.maximumEstimate) && tokens.maximumEstimate >= 0 && tokens.maximumEstimate <= 400);
  const hook = record(report.hook), firstRun = record(hook.firstRun);
  assert.equal(hook.processStartup, 'new-process-per-attempt'); assert.equal(hook.processCompletion, 'original-and-group-confirmed');
  assert.equal(hook.daemon, 'absent'); assert.equal(hook.runs, 20);
  assert.deepEqual(hook.outcomes, { injected: 20, held: 0, failed: 0, unqualified: 0 });
  assert.equal(firstRun.outcome, 'injected'); assert.ok(typeof firstRun.wallMs === 'number' && Number.isFinite(firstRun.wallMs) && firstRun.wallMs >= 0 && firstRun.wallMs <= 180000);
  const wall = distribution(hook.wall, 20), injectedWall = distribution(hook.verifiedInjectionWall, 20);
  assert.deepEqual(wall, injectedWall); assert.equal(hook.componentLatency, null);
  assert.equal(report.publicView, 'ready-synthetic'); assert.equal(report.designatedMacLatency, 'unverified');
  assert.equal(report.ownerStorageOpened, false); assert.equal(report.modelsCalled, false);
  const bytes = record(report.bytes);
  for (const key of ['primary', 'view']) { const value = bytes[key]; assert.ok(typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= DISK); }
  return { corpus: { notes: 10000, seed: 42, synthetic: true }, engine: 'bun', runtimeVersion: '1.4.2', queries: 200, store, search, context,
    firstRun: { wallMs: firstRun.wallMs, outcome: 'injected' }, outcomes: { injected: 20, held: 0, failed: 0, unqualified: 0 }, wall, verifiedInjectionWall: injectedWall,
    nestedProducersReportedJoined: 21, componentLatency: null, hostTokens: 'unverified', designatedMacLatency: 'unverified' };
}

export async function runBenchmarkProbe(context: CheckContext, dependencies: ProbeDependencies = {}): Promise<BenchmarkProbeResult> {
  const result = await processProbe(context, ['memory', 'bench', '--n', '10000', '--public-view'], { ...dependencies, timeoutMs: 180000 });
  let benchmark: BenchmarkQualification | null = null;
  try {
    assert.equal(result.receipt.joined, true); assert.equal(result.receipt.code, 0); assert.equal(result.receipt.signal, null); assert.equal(result.receipt.error, null);
    benchmark = classifyBenchmark(JSON.parse(result.text));
  } catch { /* failed report cannot authorize nested-producer cleanup */ }
  return { receipt: result.receipt, benchmark, passed: benchmark !== null };
}
