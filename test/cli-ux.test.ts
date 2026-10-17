import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { main } from '../src/app/cli.ts';
import { renderCliResult, renderCliError } from '../src/app/cli-output.ts';
import { runtimeFixture } from './runtime-fixture.ts';
import { sandbox, fresh } from './helpers.ts';

async function invoke(args: string[], env: Record<string, string>, cwd: string, terminal: boolean) {
  let out = '', err = '';
  const code = await main(args, { env, cwd, terminal, stdout: text => { out += text; }, stderr: text => { err += text; } });
  return { code, out, err };
}

test('owner terminal summaries retain scoped memory privacy and exact JSON escape while model and pipe outputs remain structured', async () => {
  const f = await runtimeFixture();
  try {
    const stored = await f.rpc<{ memory: { id: string; version: number } }>('memory.store', {
      category: 'project', title: 'Terminal note', body: 'PUBLIC BODY\u001b[2J', private: false, shared: false,
    });
    const privateNote = await f.rpc<{ memory: { id: string } }>('memory.store', {
      category: 'project', title: 'PRIVATE NOTE CANARY', body: 'PRIVATE BODY CANARY', private: true,
    });
    const human = await invoke(['memory', 'get', stored.memory.id], f.env, f.workspace, true);
    assert.equal(human.code, 0, human.err); assert.ok(human.out.includes(stored.memory.id));
    assert.match(human.out, /public.*unshared.*version 1/); assert.match(human.out, /PUBLIC BODY\\u001b\[2J/);
    assert.equal(human.out.includes('\u001b'), false);
    const machine = await invoke(['--json', 'memory', 'get', stored.memory.id], f.env, f.workspace, true);
    const pipe = await invoke(['memory', 'get', stored.memory.id], f.env, f.workspace, false);
    assert.equal(machine.code, 0, machine.err); assert.equal(machine.out, pipe.out);
    assert.equal(JSON.parse(machine.out).memory.body, 'PUBLIC BODY\u001b[2J');
    const localJson = await invoke(['memory', 'get', stored.memory.id, '--json'], f.env, f.workspace, true);
    assert.equal(localJson.code, 0, localJson.err); assert.equal(localJson.out, machine.out);
    const model = await invoke(['memory', 'search', 'CANARY'], { ...f.env, BOSUN_CALLER: 'model' }, f.workspace, true);
    assert.equal(model.code, 0, model.err); assert.deepEqual(JSON.parse(model.out).hits, []);
    const denied = await invoke(['memory', 'get', privateNote.memory.id], { ...f.env, BOSUN_CALLER: 'model' }, f.workspace, true);
    assert.equal(denied.code, 0, denied.err); assert.deepEqual(JSON.parse(denied.out), { memory: { private: true } });
    assert.equal((model.out + denied.out + denied.err).includes('PRIVATE BODY CANARY'), false);
    const events = await invoke(['memory', 'get', stored.memory.id, '--events'], f.env, f.workspace, true);
    assert.ok(JSON.parse(events.out).memory.events.some((event: { op: string }) => event.op === 'store'));
  } finally { await f.close(); }
});

test('terminal status and jobs do not turn queued or unknown outcomes into completed work', async () => {
  const f = await runtimeFixture();
  try {
    const status = await invoke(['status'], f.env, f.workspace, true);
    assert.equal(status.code, 0, status.err); assert.match(status.out, /running/); assert.match(status.out, /Primary host: omp/);
    const raw = await invoke(['rpc', 'daemon.status', '{}'], f.env, f.workspace, true);
    assert.equal(raw.code, 0, raw.err); assert.equal(JSON.parse(raw.out).state, 'running');
    const empty = await invoke(['job', 'list'], f.env, f.workspace, true);
    assert.equal(empty.code, 0, empty.err); assert.match(empty.out, /No jobs/);
    const original = { id: 'job_original', runnerId: 'omp', state: 'unknown', version: 2, reason: 'runner_lost', requestId: 'request_original' };
    const unknown = renderCliResult('job.get', original)!;
    assert.match(unknown, /unconfirmed/); assert.match(unknown, /request_original/); assert.doesNotMatch(unknown, /completed|resubmit.*allowed/);
    const queued = renderCliResult('job.submit', { job: { ...original, state: 'queued', reason: null } })!;
    assert.match(queued, /queued/); assert.match(queued, /bosun job wait job_original --result/); assert.doesNotMatch(queued, /succeeded|completed/);
    const error = renderCliError({ code: 'unavailable', message: 'Daemon reply unavailable', details: { outcome: 'unknown' } }, { command: 'run', requestId: 'request_original' });
    assert.match(error, /Do not repeat/); assert.match(error, /request_original/); assert.doesNotMatch(error, /bosun start/);
  } finally { await f.close(); }
});

test('missing model and missing daemon give actionable owner hints without exposing provider exceptions or starting effects', async () => {
  const sb = sandbox(); fresh(sb); const env = sb.env({ BOSUN_SOCKET: `${process.env.BOSUN_TEST_RUN_ROOT!}/ux` });
  try {
    const model = await invoke(['run', 'Public task'], env, sb.root, true);
    assert.equal(model.code, 2); assert.match(model.err, /--model/); assert.match(model.err, /bosun onboard/);
    const structured = await invoke(['--json', 'run', 'Public task'], env, sb.root, true);
    assert.equal(structured.code, 2); assert.deepEqual(JSON.parse(structured.err), { error: { code: 'invalid', message: 'Invalid request' } });
    const missing = await invoke(['status'], env, sb.root, true);
    assert.equal(missing.code, 1); assert.match(missing.err, /bosun doctor/); assert.match(missing.err, /bosun daemon run/);
    for (const command of ['start', 'stop', 'restart']) {
      const refused = await invoke([command], env, sb.root, false);
      assert.equal(refused.code, 1); assert.equal(JSON.parse(refused.err).error.code, 'unsupported');
    }
    assert.deepEqual(sb.calls(), []); assert.equal(fs.existsSync(env.BOSUN_HOME), false);
  } finally { sb.cleanup(); }
});

test('router terminal explanations distinguish cold residency and deadline snapshots without implying execution or calibration', () => {
  const cold = renderCliResult('route.status', { state: 'cold', reason: 'model_unloaded', model: 'clef-flash:9b', loaded: { state: 'unloaded' }, qualification: { calibration: 'unverified' } })!;
  assert.match(cold, /installed but not in memory/); assert.match(cold, /explicit bosun route/); assert.match(cold, /automatic dispatch is disabled/);
  const expired = renderCliResult('route.classify', { route: null, reason: 'timeout', status: { state: 'cold', reason: 'model_unloaded' } })!;
  assert.match(expired, /pre-decision snapshot/); assert.match(expired, /does not prove native inference stopped/); assert.match(expired, /no task was executed or worker dispatched/);
  for (const kind of ['raw-rpc', 'profile.export', 'handoff.export', 'memory.bench']) assert.equal(renderCliResult(kind, { text: 'ARTIFACT\u001b[2J' }), null);
});
