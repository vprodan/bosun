import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SqliteDatabase } from '../src/platform/sqlite.ts';
import { sandbox } from './helpers.ts';
import { openDaemonJobs } from '../src/app/jobs.ts';
import { BosunError } from '../src/core/errors.ts';
import type { AgentRunner } from '../src/core/ports/runner.ts';
import type { JobInput } from '../src/core/domain/job.ts';
import { createCodexRunner } from '../src/adapters/hosts/codex/runner.ts';
import { createClaudeRunner } from '../src/adapters/hosts/claude/runner.ts';
import { openRuntimeLog } from '../src/platform/logging.ts';

const A = { projectId: 'p_a', audience: 'owner' as const };
const input = (requestId = 'req_a'): JobInput => ({ privacy: 'public', requestId, taskId: 'task_a', runnerId: 'selected',
  prompt: 'PRIVATE-PROMPT-CANARY synthetic approved fixture', cwd: '/synthetic/PRIVATE-FILE-CANARY', access: 'read', model: 'provider/pinned:model', effort: 'high' });
const caps: AgentRunner['caps'] = { vendor: 'PRIVATE-HARNESS-CANARY', readOnly: 'verified', sandbox: 'tool-allowlist', effort: 'verified', mcpInject: 'unsupported', localBackend: 'unverified', billing: 'api' };
const runner = (run: AgentRunner['run']): AgentRunner => ({ id: 'selected', caps, detect: async () => ({ installed: true }), run });
function layout() {
  const sb = sandbox(); const dir = path.join(sb.root, 'state'); fs.mkdirSync(dir, { mode: 0o700 });
  return { sb, stateFile: path.join(dir, 'state.db'), ownerFile: path.join(dir, 'owner.db') };
}
function fixture(options: Partial<Parameters<typeof openDaemonJobs>[0]> = {}) {
  const f = layout(); let sequence = 0; let time = 1000;
  const settings = { ...f, now: () => ++time, id: () => `job_${++sequence}`, admit: async () => ({ allowed: true as const }),
    runners: { selected: () => runner(async function* () { yield { t: 'usage', tokensIn: 50, tokensOut: 12 }; yield { t: 'done', code: 0, result: 'PRIVATE-RESULT-CANARY' }; }) }, ...options };
  const jobs = openDaemonJobs(settings); jobs.recover();
  return { ...f, settings, jobs, async close() { await jobs.close(); f.sb.cleanup(); } };
}
const unknown = (error: unknown) => error instanceof BosunError && error.details?.outcome === 'unknown' && !error.message.includes('PRIVATE');

test('actual attempt ledger is selected/scoped/owner-only, preserves native totals and null unknowns, and survives restart without source payload', async () => {
  const f = fixture(); let reopened: ReturnType<typeof openDaemonJobs> | undefined;
  try {
    const job = f.jobs.submit(input(), A).job; assert.deepEqual(f.jobs.usage.list(A), []);
    await f.jobs.runQueued(); const rows = f.jobs.usage.list(A);
    assert.equal(rows.length, 1); assert.deepEqual(rows[0], { jobId: job.id, generation: 1, runnerId: 'selected', model: 'provider/pinned:model', effort: 'high',
      kind: 'unknown', vendor: null, qualification: 'unverified', state: 'succeeded', startedAt: rows[0].startedAt, finishedAt: rows[0].finishedAt,
      tokensIn: 50, tokensOut: 12, cachedTokens: null, reasoningTokens: null, usageEvents: 1, usageQualification: 'reported' });
    assert.ok(rows[0].finishedAt! >= rows[0].startedAt); assert.doesNotMatch(JSON.stringify(rows), /PRIVATE|prompt|result|cwd|account|auth|currency|cost/i);
    assert.deepEqual(f.jobs.usage.list({ projectId: 'p_b' }), []);
    assert.throws(() => f.jobs.usage.list({ ...A, audience: 'model' }), (error) => error instanceof BosunError && error.code === 'unsupported');
    assert.equal(f.jobs.submit(input(), A).duplicate, true); await f.jobs.runQueued(); assert.deepEqual(f.jobs.usage.list(A), rows);
    const db = new SqliteDatabase(f.stateFile, { readOnly: true });
    try { assert.doesNotMatch(JSON.stringify(db.prepare('SELECT * FROM job_usage').all()), /PRIVATE/); assert.equal(db.prepare('SELECT count(*) AS n FROM managed_ownership').get()!.n, 0); assert.equal(db.prepare('SELECT count(*) AS n FROM handoff_artifacts').get()!.n, 0); } finally { db.close(); }
    await f.jobs.close(); reopened = openDaemonJobs({ ...f.settings, runners: {} });
    assert.deepEqual(reopened.usage.list(A), rows); assert.equal(reopened.recover(), 0); await reopened.runQueued(); assert.deepEqual(reopened.usage.list(A), rows);
  } finally { await reopened?.close(); await f.close(); }
});

for (const scenario of ['missing', 'one-count', 'multiple', 'invalid', 'lost', 'zero'] as const) test(`native usage ${scenario}: unknown components and ambiguous totals are never manufactured or added twice`, async () => {
  const f = fixture({ runners: { selected: () => runner(async function* () {
    if (scenario === 'one-count') yield { t: 'usage', tokensIn: 97 };
    if (scenario === 'multiple') { yield { t: 'usage', tokensIn: 50, tokensOut: 12 }; yield { t: 'usage', tokensIn: 50, tokensOut: 12 }; }
    if (scenario === 'invalid') yield { t: 'usage', tokensIn: -1, tokensOut: 12 };
    if (scenario === 'lost') { yield { t: 'usage', tokensIn: 50, tokensOut: 12 }; throw Error('PRIVATE provider/account failure'); }
    if (scenario === 'zero') yield { t: 'usage', tokensIn: 0, tokensOut: 0 };
    yield { t: 'done', code: 0, result: 'PRIVATE-RESULT-CANARY' };
  }) } });
  try {
    f.jobs.submit(input(), A); await f.jobs.runQueued(); const row = f.jobs.usage.list(A)[0];
    assert.equal(row.cachedTokens, null); assert.equal(row.reasoningTokens, null); assert.equal(row.kind, 'unknown'); assert.equal(row.vendor, null);
    if (scenario === 'missing' || scenario === 'invalid') { assert.equal(row.tokensIn, null); assert.equal(row.tokensOut, null); assert.equal(row.usageQualification, 'unavailable'); }
    if (scenario === 'one-count') { assert.equal(row.tokensIn, 97); assert.equal(row.tokensOut, null); assert.equal(row.usageQualification, 'partial'); }
    if (scenario === 'multiple') { assert.equal(row.tokensIn, null); assert.equal(row.tokensOut, null); assert.equal(row.usageQualification, 'ambiguous'); assert.equal(row.usageEvents, 2); }
    if (scenario === 'lost') { assert.equal(row.state, 'unknown'); assert.equal(row.tokensIn, 50); assert.equal(row.usageQualification, 'partial'); }
    if (scenario === 'zero') { assert.equal(row.tokensIn, 0); assert.equal(row.tokensOut, 0); assert.equal(row.usageQualification, 'reported'); }
  } finally { await f.close(); }
});

test('held/unavailable/unsupported factories make no attempt and explicit billing qualification receives selection metadata only', async () => {
  let allow = false; const seen: unknown[] = []; const observed: unknown[] = [];
  const f = fixture({ admit: async () => ({ allowed: allow, reason: 'approval' } as const),
    billing(selection) { seen.push(selection); assert.deepEqual(Object.keys(selection).sort(), ['effort', 'model', 'runnerId']); assert.ok(Object.isFrozen(selection)); return { kind: 'subscription', vendor: 'openai', qualification: 'verified' }; },
    metadata(event) { observed.push(event); throw Error('PRIVATE post-commit logger failure'); } });
  try {
    const job = f.jobs.submit(input(), A).job; await f.jobs.runQueued(); assert.deepEqual(f.jobs.usage.list(A), []); assert.equal(seen.length, 0);
    allow = true; await f.jobs.release(A, job.id); await f.jobs.runQueued(); const row = f.jobs.usage.list(A)[0];
    assert.equal(row.kind, 'subscription'); assert.equal(row.vendor, 'openai'); assert.equal(row.qualification, 'verified'); assert.equal(row.state, 'succeeded');
    assert.doesNotMatch(JSON.stringify(observed), /PRIVATE|prompt|result|cwd|model|runnerId/);
  } finally { await f.close(); }
});

for (const phase of ['start', 'usage', 'finish'] as const) test(`native ${phase} COMMIT then lost receipt atomically preserves attempt and fences dispatch/replay`, async () => {
  const f = fixture(); const exec = SqliteDatabase.prototype.exec; let commits = 0; let reopened: ReturnType<typeof openDaemonJobs> | undefined;
  try {
    const job = f.jobs.submit(input(), A).job;
    SqliteDatabase.prototype.exec = function (sql) {
      const result = exec.call(this, sql);
      if (this.location() === f.stateFile && sql === 'COMMIT' && ++commits === ({ start: 1, usage: 2, finish: 3 }[phase])) throw Error('PRIVATE receipt/account failure');
      return result;
    };
    await assert.rejects(f.jobs.runQueued(), unknown); assert.throws(() => f.jobs.usage.list(A), unknown); SqliteDatabase.prototype.exec = exec;
    const observer = new SqliteDatabase(f.stateFile, { readOnly: true });
    try { assert.equal(observer.prepare('SELECT count(*) AS n FROM job_usage WHERE job_id=?').get(job.id)!.n, 1);
      assert.equal(observer.prepare('SELECT state FROM job_usage WHERE job_id=?').get(job.id)!.state, phase === 'finish' ? 'succeeded' : 'running'); } finally { observer.close(); }
    await f.jobs.close(); let native = 0;
    reopened = openDaemonJobs({ ...f.settings, runners: { selected() { native++; throw Error('must not replay'); } } });
    assert.equal(reopened.recover(), phase === 'finish' ? 0 : 1); await reopened.runQueued(); assert.equal(native, 0);
    const row = reopened.usage.list(A)[0]; assert.equal(row.generation, 1); assert.equal(row.state, phase === 'finish' ? 'succeeded' : 'unknown');
    assert.equal(row.tokensIn, phase === 'start' ? null : 50); assert.equal(reopened.submit(input(), A).duplicate, true);
  } finally { SqliteDatabase.prototype.exec = exec; await reopened?.close(); await f.close(); }
});

test('actual guarded native Codex usage reaches the ledger unchanged while native billing/account and cached data stay unknown', async () => {
  const f = layout(); const model = 'gpt-6-sol';
  const frames = [{ type: 'thread.started', thread_id: 'thread_fixture' }, { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'item_fixture', type: 'agent_message', text: 'PRIVATE native result' } },
    { type: 'turn.completed', usage: { input_tokens: 50, cached_input_tokens: 30, output_tokens: 12 } }];
  const env = f.sb.env({ STUB_MAP: JSON.stringify({ 'codex --version': { out: 'codex-cli 0.161.0\n' }, 'codex exec': { out: frames.map(row => JSON.stringify(row)).join('\n') + '\n' } }) });
  const jobs = openDaemonJobs({ ...f, now: () => 1000, id: () => 'native_job', admit: async () => ({ allowed: true }), runners: { codex: () => createCodexRunner({ env }) } });
  try {
    jobs.recover(); jobs.submit({ ...input(), runnerId: 'codex', cwd: f.sb.root, access: 'edit', model }, A); await jobs.runQueued();
    const row = jobs.usage.list(A)[0]; assert.equal(row.state, 'succeeded'); assert.equal(row.tokensIn, 50); assert.equal(row.tokensOut, 12);
    assert.equal(row.cachedTokens, null); assert.equal(row.reasoningTokens, null); assert.equal(row.vendor, null); assert.equal(row.kind, 'unknown');
  } finally { await jobs.close(); f.sb.cleanup(); }
});

test('actual guarded native Claude usage preserves reported components without adding cache or inventing effective vendor billing', async () => {
  const f = layout(); const model = 'claude-sonnet-5'; const session = '00000000-0000-4000-8000-000000000001';
  const frames = [{ type: 'system', subtype: 'init', session_id: session, cwd: f.sb.home, model, permissionMode: 'dontAsk', tools: ['Read', 'Glob', 'Grep', 'EndConversation'], mcp_servers: [] },
    { type: 'assistant', session_id: session, parent_tool_use_id: null, message: { model, content: [{ type: 'thinking', thinking: 'PRIVATE thinking' }, { type: 'text', text: 'PRIVATE native result' }] } },
    { type: 'result', subtype: 'success', is_error: false, session_id: session, result: 'PRIVATE native result',
      usage: { input_tokens: 8, output_tokens: 17, cache_read_input_tokens: 20 }, modelUsage: { [model]: { inputTokens: 8, outputTokens: 17 } } }];
  const env = f.sb.env({ STUB_MAP: JSON.stringify({ 'claude --version': { out: '2.1.292 (Claude Code)\n' }, 'claude -p': { out: frames.map(row => JSON.stringify(row)).join('\n') + '\n' } }) });
  const jobs = openDaemonJobs({ ...f, now: () => 1000, id: () => 'native_claude', admit: async () => ({ allowed: true }), runners: { claude: () => createClaudeRunner({ env }) } });
  try {
    jobs.recover(); jobs.submit({ ...input(), runnerId: 'claude', cwd: f.sb.home, model }, A); await jobs.runQueued();
    const row = jobs.usage.list(A)[0]; assert.equal(row.state, 'succeeded'); assert.equal(row.tokensIn, 8); assert.equal(row.tokensOut, 17);
    assert.equal(row.cachedTokens, null); assert.equal(row.reasoningTokens, null); assert.equal(row.vendor, null); assert.equal(row.kind, 'unknown');
  } finally { await jobs.close(); f.sb.cleanup(); }
});

test('actual LogTape IO hold after commit cannot erase native outcome or its durable usage row', async () => {
  const f = layout(); const logFile = path.join(path.dirname(f.stateFile), 'runtime.log'); const logging = openRuntimeLog({ file: logFile }); let signals = 0;
  const jobs = openDaemonJobs({ ...f, now: () => 1000, id: () => 'logged_job', admit: async () => ({ allowed: true }),
    runners: { selected: () => runner(async function* () { yield { t: 'usage', tokensIn: 2, tokensOut: 3 }; yield { t: 'done', code: 0, result: 'PRIVATE finished result' }; }) },
    metadata(event) {
      if (++signals === 2) { fs.renameSync(logFile, logFile + '.saved'); fs.writeFileSync(logFile, 'PRIVATE unrelated replacement', { mode: 0o600 }); }
      logging.record(event);
    } });
  try {
    jobs.recover(); const job = jobs.submit(input(), A).job; await jobs.runQueued();
    assert.equal(jobs.get(A, job.id).state, 'succeeded'); assert.equal(jobs.usage.list(A)[0].tokensIn, 2);
    assert.equal(logging.state(), 'held'); assert.equal(fs.readFileSync(logFile, 'utf8'), 'PRIVATE unrelated replacement');
    assert.doesNotMatch(fs.readFileSync(logFile + '.saved', 'utf8'), /PRIVATE|prompt|result|account|auth|file|path/i);
  } finally { await jobs.close(); logging.close(); f.sb.cleanup(); }
});
