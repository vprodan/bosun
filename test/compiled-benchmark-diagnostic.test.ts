import './bootstrap.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { diagnosticProbe, failureDiagnostic, finiteCliError, RELAY } from '../scripts/qualification-diagnostics.mts';
import { cleanupAllowed, prepareIsolation } from '../scripts/qualification.mts';
import { REPO, sandbox } from './helpers.ts';

function fixture() {
  const d = (samples: number) => ({ samples, p50: 1, p95: 2 });
  return { schema: 1, corpus: { notes: 10000, seed: 42, synthetic: true }, runtime: { engine: 'bun', version: '1.4.2' },
    queries: 200, store: d(10000), search: d(200), context: d(200), corpusLoading: { epochNotes: 256, lifecycle: d(39) },
    tokens: { estimator: 'char/4', hostTokens: 'unverified', budget: 400, withinEstimate: 200, maximumEstimate: 300 },
    hook: { processStartup: 'new-process-per-attempt', processCompletion: 'original-and-group-confirmed', daemon: 'absent',
      firstRun: { wallMs: 3, outcome: 'injected' }, runs: 20, outcomes: { injected: 20, held: 0, failed: 0, unqualified: 0 },
      wall: d(20), verifiedInjectionWall: d(20), componentLatency: null }, publicView: 'ready-synthetic',
    bytes: { primary: 1024, view: 1024 }, designatedMacLatency: 'unverified', ownerStorageOpened: false, modelsCalled: false };
}
const SOURCE = `#!${process.execPath}
import fs from 'node:fs';
fs.writeFileSync(process.env.FIXTURE_PID,JSON.stringify({pid:process.pid,relay:process.ppid,args:process.argv.slice(2)}));
if(process.env.FIXTURE_MODE==='success'){
 const data=Buffer.from(process.env.FIXTURE_REPORT);process.stdout.write(data.subarray(0,31));
 setImmediate(()=>process.stdout.write(data.subarray(31)));
 process.stderr.write('public synthetic diagnostic\\n');
}else if(process.env.FIXTURE_MODE==='error'){
 process.stderr.write(JSON.stringify({benchmarkFailure:{kind:'memory-benchmark-failure',phase:'store',
 completedStores:256,completedSearches:0,completedContexts:0,completedHooks:0,completedEpochs:1}})+'\\n');
 const data=Buffer.from(JSON.stringify({error:{code:'unavailable',message:'Service unavailable'}})+'\\n');
 process.stderr.write(data.subarray(0,11));setImmediate(()=>{process.stderr.write(data.subarray(11));process.exitCode=1;});
}else if(process.env.FIXTURE_MODE==='bound')process.stderr.write(Buffer.alloc(2097152,120));
else {process.stderr.write('public synthetic pending\\n');setInterval(()=>{},1000);}
`;

test('benchmark diagnostic preserves actual child channels/exit and confirms the unchanged relay group lifecycle', async () => {
  for (const mode of ['success', 'error', 'bound', 'timeout']) {
    const sb = sandbox();
    try {
      const binary = path.join(sb.root, 'node-benchmark-fixture.mjs'), relay = path.join(sb.root, 'relay.mjs');
      const pidFile = path.join(sb.root, 'pid.json');
      fs.writeFileSync(binary, SOURCE, { mode: 0o700 }); fs.writeFileSync(relay, RELAY, { mode: 0o600 });
      const isolation = prepareIsolation(sb.root, 'isolated');
      const context = { binary, ...isolation, env: { ...sb.env(), ...isolation.env,
        FIXTURE_PID: pidFile, FIXTURE_MODE: mode, FIXTURE_REPORT: JSON.stringify(fixture()) } };
      const report = await diagnosticProbe(context, relay, mode === 'timeout' ? { timeoutMs: 500 } : {});
      assert.equal(report.relay.joined, true); assert.ok(report.framedBytes <= 1048576 && report.rawBytes <= 1048576);
      const pid = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
      assert.deepEqual(pid.args, ['memory', 'bench', '--n', '10000', '--public-view']);
      for (const target of [pid.pid, pid.relay, -pid.relay])
        assert.throws(() => process.kill(target, 0), (e: NodeJS.ErrnoException) => e.code === 'ESRCH');
      if (mode === 'success') {
        assert.equal(report.compiledChild?.pid, pid.pid); assert.equal(report.compiledChild?.code, 0);
        assert.equal(report.benchmarkVerified, true); assert.equal(report.nestedHookJoins, 21);
        assert.equal(Buffer.from(report.output.stdout.base64, 'base64').toString(), JSON.stringify(fixture()));
        assert.equal(Buffer.from(report.output.stderr.base64, 'base64').toString(), 'public synthetic diagnostic\n');
      } else {
        assert.equal(report.benchmarkVerified, false); assert.equal(report.nestedHookJoins, 'unknown');
        assert.equal(cleanupAllowed({ rootsJoined: report.relay.joined, benchmarkAttempted: true, benchmarkVerified: false }), false);
        if (mode === 'error') {
          assert.equal(report.compiledChild?.code, 1); assert.equal(report.relay.code, 1);
          assert.deepEqual(report.finiteCliError, { code: 'unavailable', message: 'Service unavailable' });
          assert.deepEqual(report.failureDiagnostic, { kind: 'memory-benchmark-failure', phase: 'store', completedStores: 256,
            completedSearches: 0, completedContexts: 0, completedHooks: 0, completedEpochs: 1 });
        } else assert.equal(report.relay.error, mode === 'bound' ? 'unavailable' : 'timeout');
      }
    } finally { sb.cleanup(); }
  }
});

test('a child close frame cannot substitute for positive relay original/group completion', async () => {
  const sb = sandbox();
  try {
    const isolation = prepareIsolation(sb.root, 'isolated');
    const report = await diagnosticProbe({ binary: '/synthetic/unused', ...isolation }, '/synthetic/relay', {
      async *execute(spec: any) {
        spec.stdout(Buffer.from(JSON.stringify({ t: 'started', pid: 123 }) + '\n'
          + JSON.stringify({ t: 'stdout', data: Buffer.from(JSON.stringify(fixture())).toString('base64') }) + '\n'
          + JSON.stringify({ t: 'closed', pid: 123, code: 0, signal: null, spawnFailed: false }) + '\n'));
        yield { t: 'exit', code: 0, signal: null };
      },
    });
    assert.equal(report.relay.joined, false); assert.equal(report.compiledChild?.code, 0);
    assert.equal(report.benchmarkVerified, false); assert.equal(report.nestedHookJoins, 'unknown');
    assert.equal(finiteCliError('{"error":{"code":"unavailable","message":"arbitrary provider detail"}}'), null);
    assert.equal(finiteCliError('{"error":{"code":"invented","message":"Service unavailable"}}'), null);
    assert.equal(failureDiagnostic(JSON.stringify({ benchmarkFailure: { ...fixture(), phase: 'store' } })
      + '\n' + JSON.stringify({ error: { code: 'unavailable', message: 'Service unavailable' } })), null);
  } finally { sb.cleanup(); }
});
