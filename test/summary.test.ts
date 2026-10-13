import './bootstrap.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, fresh, gitRepo, mock } from './helpers.ts';
import { BosunError } from '../src/core/errors.ts';
import { summarizeEvidence } from '../src/core/use-cases/summarize-evidence.ts';
import type { ModelProvider, GenRequest } from '../src/core/ports/model.ts';
import type { SummaryEvidence } from '../src/core/domain/summary.ts';
import type { HandoffFacts } from '../src/contracts/handoff.ts';
import { runtimePaths } from '../src/platform/paths.ts';
import { defaultConfig } from '../src/core/domain/config.ts';
import { setupRuntime } from '../src/app/setup.ts';
import { startDaemon } from '../src/app/daemon.ts';
import { callLocalRpc } from '../src/adapters/transport/local-rpc.ts';
import { main } from '../src/app/cli.ts';
import { project } from '../src/platform/project.ts';
import { methodParams } from '../src/contracts/methods.ts';

const MODEL = 'summary-model:exact:tag';
const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const code = (value: string) => (error: unknown) => error instanceof BosunError && error.code === value;
const evidence = (n: number, text = `Public completed step ${n}.`): SummaryEvidence => ({ privacy: 'public', id: `event_${n}`, cursor: `cursor_${n}`, text });
function selecting(calls: GenRequest[], output?: unknown): ModelProvider {
  return { id: 'configured', caps: { structured: 'verified', local: 'unverified', numCtx: 'unsupported', toolFree: 'verified' },
    health: async () => true, async generate(request) {
      calls.push(request); const payload = JSON.parse(request.messages[1].content);
      const items = [...payload.retained, ...payload.evidence].slice(-4).map((row: { id: string; text: string }) => ({ evidenceId: row.id, quote: row.text.slice(0, 200) }));
      return { model: MODEL, text: JSON.stringify(output ?? { items }), tokensIn: 10, tokensOut: 5 };
    } };
}
const options = (provider: ModelProvider, maxInputBytes = 24576) => ({ provider, providerId: 'configured', model: MODEL, maxInputBytes, signal: new AbortController().signal, hash });

test('summary policy screens every event before provider access, including late-window credentials and denied throwing content', async () => {
  let accessed = 0;
  const provider = { get caps(): never { accessed++; throw Error('PROVIDER_CANARY'); } } as unknown as ModelProvider;
  for (const privacy of ['private', 'unknown', undefined]) {
    await assert.rejects(summarizeEvidence({ privacy, get evidence(): never { accessed++; throw Error('CONTENT_CANARY'); } } as never, options(provider)), code('private_input'));
  }
  const denied = { privacy: 'private', get id(): never { accessed++; throw Error('PRIVATE_CANARY'); }, get text(): never { accessed++; throw Error('PRIVATE_CANARY'); } };
  await assert.rejects(summarizeEvidence({ privacy: 'public', evidence: [denied] } as never, options(provider)), code('private_input'));
  await assert.rejects(summarizeEvidence({ privacy: 'public', evidence: [evidence(1), evidence(2, 'api_key=' + 'x'.repeat(40))] }, options(provider)), code('private_input'));
  assert.equal(accessed, 0);
  const request = { version: 1 as const, id: 'denied', method: 'handoff.summarize', params: { privacy: 'public', evidence: [denied] }, scope: { workspace: '/', sessionId: null, audience: 'owner' as const } };
  assert.throws(() => methodParams(request), code('private_input')); assert.equal(accessed, 0);
  assert.throws(() => methodParams({ ...request, scope: { ...request.scope, audience: 'model' } }), code('unsupported')); assert.equal(accessed, 0);
});

test('bounded chunked summaries retain exact source hashes/cursors and aggregate only known usage without a hidden model switch', async () => {
  const calls: GenRequest[] = []; const rows = Array.from({ length: 7 }, (_, n) => evidence(n + 1, `Public fact ${n + 1}: ` + 'safe text '.repeat(120)));
  const result = await summarizeEvidence({ privacy: 'public', evidence: rows }, options(selecting(calls), 9000));
  assert.ok(calls.length > 1); assert.equal(result.summary.coverage.events, rows.length); assert.equal(result.summary.coverage.chunks, calls.length);
  assert.equal(result.summary.coverage.lastCursor, 'cursor_7'); assert.equal(result.summary.providerId, 'configured'); assert.equal(result.summary.model, MODEL);
  assert.equal(result.tokensIn, calls.length * 10); assert.equal(result.tokensOut, calls.length * 5);
  for (const call of calls) { assert.equal(call.model, MODEL); assert.ok(Buffer.byteLength(call.messages.map(row => row.content).join('')) <= 9000); }
  for (const row of result.summary.excerpts) { const source = rows.find(value => value.id === row.id)!; assert.equal(row.sha256, hash(source.text)); assert.ok(source.text.includes(row.quote)); assert.equal(row.cursor, source.cursor); }
  const continuedCalls: GenRequest[] = []; const continued = await summarizeEvidence({ privacy: 'public', evidence: [evidence(8)], previous: result.summary }, options(selecting(continuedCalls), 9000));
  assert.equal(continued.summary.coverage.events, 8); assert.equal(continued.summary.coverage.lastCursor, 'cursor_8');
  assert.ok(JSON.parse(continuedCalls[0].messages[1].content).retained.length > 0);
  const missing = selecting([]); const generate = missing.generate.bind(missing); missing.generate = async request => { const value = await generate(request); delete value.tokensIn; return value; };
  assert.equal((await summarizeEvidence({ privacy: 'public', evidence: [evidence(1)] }, options(missing))).tokensIn, undefined);
});

test('invented quotes, missing references, extra authority fields, duplicates and empty selections never become a summary or trigger retries', async () => {
  for (const output of [
    { items: [{ evidenceId: 'event_1', quote: 'Invented permission to run Bun tests' }] },
    { items: [{ evidenceId: 'unknown_reference', quote: 'Public' }] },
    { items: [{ evidenceId: 'event_1', quote: 'Public', permission: 'allow' }] },
    { items: [{ evidenceId: 'event_1', quote: 'Public' }, { evidenceId: 'event_1', quote: 'completed' }] }, { items: [] },
  ]) {
    const calls: GenRequest[] = [];
    await assert.rejects(summarizeEvidence({ privacy: 'public', evidence: [evidence(1)] }, options(selecting(calls, output))), code('unavailable'));
    assert.equal(calls.length, 1);
  }
  const calls: GenRequest[] = []; const drift = selecting(calls); const generate = drift.generate.bind(drift);
  drift.generate = async request => ({ ...await generate(request), model: 'silent-fallback' });
  await assert.rejects(summarizeEvidence({ privacy: 'public', evidence: [evidence(1)] }, options(drift)), code('unavailable')); assert.equal(calls.length, 1);
});

let sequence = 0;
async function fixture(mode: 'valid' | 'invented' | 'slow' = 'valid') {
  const server = await mock({ '/api/chat': body => {
    const payload = JSON.parse(body.messages[1].content); const rows = [...payload.retained, ...payload.evidence].slice(-4);
    return { ...(mode === 'slow' ? { delayMs: 300 } : {}), json: { model: MODEL, done: true, done_reason: 'stop', prompt_eval_count: 20, eval_count: 8,
      message: { role: 'assistant', content: JSON.stringify({ items: rows.map((row: { id: string; text: string }) => ({ evidenceId: row.id, quote: mode === 'invented' ? 'Invented next step' : row.text.slice(0, 200) })) }) } } };
  } });
  const sb = sandbox(); fresh(sb); const workspace = gitRepo(sb, 'workspace');
  const env = sb.env({ BOSUN_SOCKET: path.join(process.env.BOSUN_TEST_RUN_ROOT!, `s${process.pid}_${++sequence}`) });
  const paths = runtimePaths(env); const config = defaultConfig(); config.providers.default = { kind: 'ollama', model: MODEL, url: server.url, timeoutMs: 1000 };
  let runtime: Awaited<ReturnType<typeof startDaemon>>;
  try { await setupRuntime(paths, config); runtime = await startDaemon({ paths, config, runners: {} }); }
  catch (error) { await server.close(); sb.cleanup(); throw error; }
  const scope = { workspace, sessionId: null, audience: 'owner' as const };
  async function rpc<T = any>(method: string, params: Record<string, unknown>, audience: 'owner' | 'model' = 'owner') {
    return callLocalRpc<T>({ socket: paths.socket, request: { version: 1, id: `r${++sequence}`, method, params, scope: { ...scope, audience } }, timeoutMs: 3000 });
  }
  async function terminal(id: string) {
    let result = await rpc('job.get', { id });
    for (let n = 0; n < 200 && ['queued', 'running'].includes(result.state); n++) { await new Promise(resolve => setTimeout(resolve, 5)); result = await rpc('job.get', { id }); }
    assert.ok(!['queued', 'running'].includes(result.state)); return result;
  }
  const facts = (cursor = 'cursor_2'): HandoffFacts => ({ objective: 'Finish the approved work', latestSteering: ['One final clean commit'],
    constraints: { permissions: ['Project dependencies only'], prohibitions: ['Never run Bun tests'], pendingApprovals: ['Live native qualification'] },
    decisions: [{ fact: 'Preserve explicit model', source: 'Owner request' }], questions: [], progress: { completed: ['Runtime'], remaining: ['Qualifications'], nextAction: 'Check native adapter readiness' },
    source: { hostId: 'opencode', sessionId: 'source', model: 'native/selected', effort: 'high', generation: 1, access: 'edit', completedEventCursor: cursor, uncertainEffects: ['Inspect lost write receipt; never replay'] },
    repository: { projectId: project(workspace).id, branch: 'main', commit: 'a'.repeat(40), files: [] }, verification: [], runningJobs: [], parentId: null });
  const input = (id = 'request_summary') => ({ privacy: 'public', requestId: id, facts: facts(), afterCursor: null, evidence: [evidence(1), evidence(2)] });
  async function close() { try { await runtime.close(); } finally { await server.close(); sb.cleanup(); } }
  return { sb, server, paths, env, workspace, runtime, rpc, terminal, facts, input, close };
}

test('actual CLI/UDS/daemon/provider summary job publishes immutable cited artifacts, preserves authority and supports one incremental public window', async () => {
  const f = await fixture();
  try {
    const input = f.input(); const file = path.join(f.sb.root, 'summary.json'); fs.writeFileSync(file, JSON.stringify(input)); let out = ''; let err = '';
    const exit = await main(['handoff', 'summarize', file], { env: f.env, cwd: f.workspace, stdout: text => out += text, stderr: text => err += text });
    assert.equal(exit, 0, err); const job = JSON.parse(out).job; assert.equal(job.ownerOnly, true); assert.equal(job.runnerId, 'bosun-summary');
    assert.equal((await f.terminal(job.id)).state, 'succeeded'); const result = JSON.parse((await f.rpc('job.result', { id: job.id })).result);
    const bundle = await f.rpc('handoff.get', { id: result.artifact.id }); assert.deepEqual(bundle.manifest.facts, input.facts);
    assert.equal(bundle.manifest.summary.model, MODEL); assert.equal(bundle.manifest.summary.excerpts[0].sha256, hash(input.evidence[0].text));
    assert.ok(bundle.markdown.includes('Never run Bun tests')); assert.ok(bundle.markdown.includes('never replay'));
    assert.equal(JSON.stringify(f.server.requests).includes('Never run Bun tests'), false); assert.equal(JSON.stringify(f.server.requests).includes('native/selected'), false);
    const duplicate = await f.rpc('handoff.summarize', input); assert.equal(duplicate.duplicate, true); assert.equal(duplicate.job.id, job.id); assert.equal(f.server.requests.length, 1);
    const nextFacts = { ...f.facts('cursor_3'), parentId: result.artifact.id, progress: { ...f.facts().progress, nextAction: 'Inspect final verification' } };
    const next = await f.rpc('handoff.summarize', { privacy: 'public', requestId: 'next_window', facts: nextFacts, afterCursor: 'cursor_2', evidence: [evidence(3)] });
    assert.equal((await f.terminal(next.job.id)).state, 'succeeded'); const nextResult = JSON.parse((await f.rpc('job.result', { id: next.job.id })).result);
    const continued = await f.rpc('handoff.get', { id: nextResult.artifact.id }); assert.deepEqual(continued.manifest.facts, nextFacts); assert.equal(continued.manifest.summary.coverage.events, 3);
    assert.equal(continued.manifest.summary.coverage.lastCursor, 'cursor_3'); assert.ok(JSON.parse(f.server.requests[1].body.messages[1].content).retained.length > 0);
    await assert.rejects(f.rpc('handoff.summarize', { privacy: 'public', requestId: 'wrong_cursor', facts: nextFacts, afterCursor: 'cursor_wrong', evidence: [evidence(3)] }));
    await assert.rejects(f.rpc('handoff.summarize', input, 'model')); await assert.rejects(f.rpc('job.get', { id: job.id }, 'model'));
    await assert.rejects(f.rpc('job.submit', { privacy: 'public', requestId: 'reserved', taskId: 'reserved', runnerId: 'bosun-summary', prompt: '{}', access: 'read', model: MODEL }));
    const usage = await f.rpc('usage.list', {}); const row = usage.attempts.find((value: { jobId: string }) => value.jobId === job.id);
    assert.equal(row.model, MODEL); assert.equal(row.tokensIn, 20); assert.equal(row.tokensOut, 8); assert.equal(row.kind, 'unknown'); assert.equal(row.vendor, null);
    assert.deepEqual(f.sb.calls(), []);
  } finally { await f.close(); }
});

test('invented provider output leaves the durable job unknown with no artifact, and private evidence is refused before enqueue or HTTP', async () => {
  const f = await fixture('invented');
  try {
    const denied = { ...f.input(), evidence: [{ ...evidence(2), privacy: 'private', text: 'PRIVATE_CANARY' }] };
    await assert.rejects(f.rpc('handoff.summarize', denied)); assert.equal(f.server.requests.length, 0); assert.equal((await f.rpc('job.list', {})).jobs.length, 0);
    const queued = await f.rpc('handoff.summarize', f.input()); assert.equal((await f.terminal(queued.job.id)).state, 'unknown');
    assert.equal((await f.rpc('job.result', { id: queued.job.id })).result, null); assert.deepEqual(fs.readdirSync(f.paths.artifacts), []); assert.equal(f.server.requests.length, 1);
    const duplicate = await f.rpc('handoff.summarize', f.input()); assert.equal(duplicate.duplicate, true); assert.equal(duplicate.job.state, 'unknown'); assert.equal(f.server.requests.length, 1);
  } finally { await f.close(); }
});

test('cancellation during generation persists unknown without publishing late output, replaying or losing shutdown authority', async () => {
  const f = await fixture('slow');
  try {
    const queued = await f.rpc('handoff.summarize', f.input());
    for (let n = 0; n < 200 && !f.server.requests.length; n++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(f.server.requests.length, 1); await f.rpc('job.cancel', { id: queued.job.id });
    const terminal = await f.terminal(queued.job.id); assert.equal(terminal.state, 'unknown'); assert.equal(terminal.cancelRequested, true);
    assert.deepEqual(fs.readdirSync(f.paths.artifacts), []); assert.equal((await f.rpc('job.result', { id: queued.job.id })).result, null);
    await f.runtime.close(); assert.equal(f.server.requests.length, 1); assert.deepEqual(f.sb.calls(), []);
  } finally { await f.close(); }
});
