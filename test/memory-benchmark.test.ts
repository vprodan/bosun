import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import { runMemoryBenchmark, type BenchmarkFailureDiagnostic } from '../src/app/memory-benchmark.ts';
import { main as cli } from '../src/app/cli.ts';
import { BosunError, MemoryError } from '../src/core/errors.ts';
import { benchmarkHookDiagnostic, benchmarkHookErrorReason } from '../src/core/memory-benchmark.ts';
import { streamProcess, type ProcessSpec } from '../src/platform/process.ts';
import { BIN, gitRepo, sandbox } from './helpers.ts';

test('hook omission diagnostics accept only one finite metadata record and never project error details', () => {
  const diagnostic = { phase: 'reader-search', reason: 'deadline' };
  const record = JSON.stringify({ hookDiagnostic: diagnostic }) + '\n';
  assert.deepEqual(benchmarkHookDiagnostic(record), diagnostic);
  for (const stderr of [
    '', 'PRIVATE CONTENT /owner/path', record + record,
    JSON.stringify({ hookDiagnostic: { ...diagnostic, content: 'PRIVATE CONTENT' } }),
    JSON.stringify({ hookDiagnostic: { ...diagnostic, phase: '/owner/path' } }),
    JSON.stringify({ hookDiagnostic: { ...diagnostic, reason: 'PRIVATE CONTENT' } }),
    JSON.stringify({ hookDiagnostic: diagnostic, rawError: 'PRIVATE CONTENT' }),
    ' '.repeat(1025) + record,
  ]) assert.equal(benchmarkHookDiagnostic(stderr), null);
  assert.equal(benchmarkHookErrorReason(new MemoryError('unavailable', 'local public memory unavailable (deadline)')), 'deadline');
  assert.equal(benchmarkHookErrorReason(new MemoryError('unavailable', 'local memory unavailable (storage)')), 'storage');
  for (const error of [
    Error('PRIVATE CONTENT /owner/path'),
    new MemoryError('invalid', 'local public memory unavailable (deadline)'),
    new MemoryError('unavailable', 'local public memory unavailable (deadline) PRIVATE CONTENT'),
    { get message() { throw Error('PRIVATE CONTENT'); } },
    Object.defineProperty(new MemoryError('unavailable', ''), 'message', {
      get() { throw Error('PRIVATE CONTENT'); },
    }),
  ]) assert.equal(benchmarkHookErrorReason(error), 'exception');
});

test('native stderr observers retain the combined byte bound, normalize observer failure and positively join', async () => {
  const sb = sandbox();
  try {
    for (const mode of ['record', 'bound', 'observer-throws']) {
      const record = JSON.stringify({ hookDiagnostic: { phase: 'reader-open', reason: 'deadline' } }) + '\n';
      let stderr = '', stdout = '', joined = false, failure: unknown, code: number | null = null;
      const source = mode === 'bound'
        ? "const fs=require('node:fs');fs.writeSync(1,'x'.repeat(24));fs.writeSync(2,'y'.repeat(24));"
        : `require('node:fs').writeSync(2,${JSON.stringify(record)});`;
      try {
        for await (const event of streamProcess({
          command: process.execPath, args: ['--no-env-file', '--no-install', '-e', source],
          cwd: sb.root, env: sb.env(), signal: new AbortController().signal,
          timeoutMs: 5000, maxOutputBytes: mode === 'bound' ? 32 : 1024,
          stdout(chunk) { stdout += Buffer.from(chunk).toString('utf8'); },
          stderr(chunk) {
            if (mode === 'observer-throws') throw Error('PRIVATE OBSERVER DETAIL');
            stderr += Buffer.from(chunk).toString('utf8');
          },
          onClosed() { joined = true; },
        })) if (event.t === 'exit') code = event.code;
      } catch (error) { failure = error; }
      assert.equal(joined, true, mode);
      if (mode === 'record') {
        assert.equal(failure, undefined);
        assert.equal(code, 0);
        assert.equal(stderr, record);
        assert.equal(stdout, '');
      } else {
        assert.ok(failure instanceof BosunError && failure.code === 'unavailable', mode);
        assert.doesNotMatch(failure.message, /PRIVATE OBSERVER DETAIL/);
        if (mode === 'bound') assert.ok(Buffer.byteLength(stdout + stderr) <= 32);
      }
    }
  } finally { sb.cleanup(); }
});

test('benchmark retains only bounded parsed metadata for held samples without changing injection counts', async () => {
  const sb = sandbox();
  try {
    const workspace = gitRepo(sb, 'workspace', 'git@github.com:org/benchmark-diagnostic.git');
    let samples = 0;
    const report = await runMemoryBenchmark({ n: 1, publicView: false, workspace, env: sb.env() }, {
      async *process(spec) {
        assert.equal(spec.env.BOSUN_BENCHMARK_HOOK_DIAGNOSTIC, '1');
        const record = samples++ === 0
          ? JSON.stringify({ hookDiagnostic: { phase: 'reader-search', reason: 'deadline' } }) + '\n'
          : 'PRIVATE CONTENT /owner/path';
        spec.stderr?.(Buffer.from(record.slice(0, 17)));
        spec.stderr?.(Buffer.from(record.slice(17)));
        spec.onClosed?.();
        yield { t: 'exit', code: 0, signal: null };
      },
    });
    assert.equal(samples, 21);
    assert.equal(report.hook.firstRun?.outcome, 'held');
    assert.deepEqual(report.hook.outcomes, { injected: 0, held: 20, failed: 0, unqualified: 0 });
    assert.equal(report.hook.heldSamples.length, 21);
    assert.deepEqual(report.hook.heldSamples[0].diagnostic, { phase: 'reader-search', reason: 'deadline' });
    assert.deepEqual(report.hook.heldSamples.map(sample => sample.sample), Array.from({ length: 21 }, (_, i) => i));
    for (const sample of report.hook.heldSamples.slice(1)) assert.equal(sample.diagnostic, null);
    assert.equal(report.hook.verifiedInjectionWall.samples, 0);
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE CONTENT|owner\/path/);
  } finally { sb.cleanup(); }
});

test('benchmark selects explicit Bun source, interpreter source and compiled hook recipes without treating Bun as compiled', async () => {
  for (const recipe of ['bun-source', 'interpreter-source', 'compiled']) {
    const compiledFixture = recipe === 'compiled', bunFixture = recipe !== 'interpreter-source';
    // Sandbox scripts qualify argument selection and original/group joins only.
    // A synthetic runtime label never qualifies an actual compiled product.
    const sb = sandbox({ stubs: ['benchmark-hook'] });
    try {
      const workspace = gitRepo(sb, 'workspace', 'git@github.com:org/benchmark-fixture.git');
      const fixture = path.join(sb.bin, 'benchmark-hook');
      const commands: { command: string; args: readonly string[] }[] = [];
      const directories = new Set<string>();
      let joined = 0;
      const report = await runMemoryBenchmark({
        n: 1, publicView: false, workspace, env: sb.env(),
      }, {
        runtime: {
          execPath: compiledFixture ? fixture : process.execPath,
          entry: compiledFixture ? null : fixture,
          node: process.versions.node,
          ...(bunFixture ? { bun: 'synthetic-bun' } : { sqlite: process.versions.sqlite }),
        },
        async *process(spec) {
          commands.push({ command: spec.command, args: spec.args });
          const directory = spec.env.BOSUN_HOME!;
          directories.add(directory);
          assert.ok(fs.existsSync(directory));
          assert.equal(spec.timeoutMs, 5000);
          assert.equal(spec.maxOutputBytes, 32768);
          const input = JSON.parse(spec.input!);
          assert.equal(input.privacy, 'public');
          assert.equal(input.cwd, workspace);
          assert.equal(typeof input.prompt, 'string');
          yield* streamProcess({ ...spec, onClosed() {
            assert.ok(fs.existsSync(directory), 'temporary tree stays present until positive original/group join');
            joined++;
            spec.onClosed?.();
          } });
        },
      });
      assert.equal(commands.length, 21);
      assert.equal(joined, 21);
      assert.deepEqual(commands, Array.from({ length: 21 }, () => ({
        command: compiledFixture ? fixture : process.execPath,
        args: compiledFixture ? ['hook']
          : [...(bunFixture ? ['--no-env-file', '--no-install'] : []), fixture, 'hook'],
      })));
      const calls = sb.calls();
      assert.equal(calls.length, 21);
      for (const call of calls) {
        assert.deepEqual(call.argv, ['hook']);
        assert.throws(() => process.kill(call.pid, 0), (error: NodeJS.ErrnoException) => error.code === 'ESRCH');
        assert.throws(() => process.kill(-call.pid, 0), (error: NodeJS.ErrnoException) => error.code === 'ESRCH');
      }
      assert.deepEqual(report.hook.outcomes, { injected: 0, held: 20, failed: 0, unqualified: 0 });
      assert.equal(report.hook.processCompletion, 'original-and-group-confirmed');
      assert.equal(report.hook.wall.samples, 20);
      assert.equal(report.hook.verifiedInjectionWall.samples, 0);
      assert.equal(report.runtime.engine, bunFixture ? 'bun' : 'node');
      assert.equal(report.runtime.version, bunFixture ? 'synthetic-bun' : process.versions.node);
      assert.equal(report.runtime.node, bunFixture ? undefined : process.versions.node);
      if (bunFixture) assert.equal(Object.hasOwn(report.runtime, 'node'), false);
      for (const directory of directories) assert.equal(fs.existsSync(directory), false);
      assert.equal(report.ownerStorageOpened, false);
      assert.equal(report.modelsCalled, false);
      assert.equal(report.designatedMacLatency, 'unverified');
    } finally { sb.cleanup(); }
  }
});

test('benchmark failed source producers are joined before temporary cleanup and never counted as injections', async () => {
  const sb = sandbox({ stubs: ['benchmark-hook'] });
  try {
    const workspace = gitRepo(sb, 'workspace', 'git@github.com:org/benchmark-failure.git');
    const directories = new Set<string>();
    let joined = 0;
    const report = await runMemoryBenchmark({
      n: 1, publicView: false, workspace,
      env: sb.env({ STUB_MAP: JSON.stringify({ 'benchmark-hook': { code: 7 } }) }),
    }, {
      runtime: { execPath: process.execPath, entry: path.join(sb.bin, 'benchmark-hook'),
        node: process.versions.node, bun: process.versions.bun, sqlite: process.versions.sqlite },
      async *process(spec) {
        directories.add(spec.env.BOSUN_HOME!);
        yield* streamProcess({ ...spec, onClosed() { joined++; spec.onClosed?.(); } });
      },
    });
    assert.equal(joined, 21);
    assert.equal(sb.calls().length, 21);
    assert.equal(report.hook.firstRun?.outcome, 'failed');
    assert.deepEqual(report.hook.outcomes, { injected: 0, held: 0, failed: 20, unqualified: 0 });
    assert.deepEqual(report.hook.verifiedInjectionWall, { samples: 0, p50: null, p95: null });
    assert.equal(report.hook.wall.samples, 20);
    for (const call of sb.calls()) {
      assert.throws(() => process.kill(call.pid, 0), (error: NodeJS.ErrnoException) => error.code === 'ESRCH');
      assert.throws(() => process.kill(-call.pid, 0), (error: NodeJS.ErrnoException) => error.code === 'ESRCH');
    }
    for (const directory of directories) assert.equal(fs.existsSync(directory), false);
  } finally { sb.cleanup(); }
});

test('benchmark holds its temporary tree and stops after a synthetic unknown producer join', async () => {
  const sb = sandbox();
  let directory: string | undefined;
  try {
    const workspace = gitRepo(sb, 'workspace', 'git@github.com:org/benchmark-unknown.git');
    let attempts = 0;
    const failures: BenchmarkFailureDiagnostic[] = [];
    await assert.rejects(runMemoryBenchmark({
      n: 1, publicView: false, workspace, env: sb.env(),
    }, {
      async *process(spec: ProcessSpec) {
        attempts++;
        directory = spec.env.BOSUN_HOME;
        // No native producer is launched. An exit-shaped event without the
        // existing lifecycle's positive callback must not authorize removal.
        yield { t: 'exit', code: 0, signal: null };
      },
      async onFailure(diagnostic) {
        assert.equal(Object.isFrozen(diagnostic), true);
        failures.push({ ...diagnostic }); throw Error('observer detail must not replace the original error');
      },
    }), (error: unknown) => error instanceof BosunError && error.code === 'unavailable'
      && error.details?.outcome === 'unknown' && /temporary data retained/.test(error.message));
    assert.equal(attempts, 1, 'unknown completion prevents additional hook attempts');
    assert.deepEqual(failures, [{ kind: 'memory-benchmark-failure', phase: 'hook', completedStores: 1,
      completedSearches: 200, completedContexts: 200, completedHooks: 0, completedEpochs: 0 }]);
    assert.ok(directory);
    assert.ok(fs.existsSync(directory));
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    assert.ok(fs.existsSync(path.join(directory, 'memory.db')));
  } finally {
    // This explicit fixture never started a producer, so its retained synthetic
    // tree can be removed by the test after the production hold is verified.
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
    sb.cleanup();
  }
});

test('benchmark reports actual cleanup failure once without letting an observer replace it', async () => {
  const sb = sandbox(), remove = fs.rmSync;
  let directory: string | undefined;
  try {
    const workspace = gitRepo(sb, 'workspace', 'git@github.com:org/benchmark-cleanup.git');
    const failure = Object.assign(Error('synthetic removal failure detail'), { code: 'EACCES' });
    const diagnostics: BenchmarkFailureDiagnostic[] = [];
    fs.rmSync = ((file: fs.PathLike, options: fs.RmDirOptions) => {
      if (file === directory) throw failure;
      return remove(file, options);
    }) as typeof fs.rmSync;
    await assert.rejects(runMemoryBenchmark({ n: 1, publicView: false, workspace, env: sb.env() }, {
      async *process(spec) {
        directory = spec.env.BOSUN_HOME;
        spec.onClosed?.(); yield { t: 'exit', code: 0, signal: null };
      },
      onFailure(diagnostic) { diagnostics.push({ ...diagnostic }); throw Error('observer failure detail'); },
    }), error => error === failure);
    assert.deepEqual(diagnostics, [{ kind: 'memory-benchmark-failure', phase: 'cleanup-tree', completedStores: 1,
      completedSearches: 200, completedContexts: 200, completedHooks: 21, completedEpochs: 0 }]);
    assert.ok(directory && fs.existsSync(directory));
  } finally {
    fs.rmSync = remove;
    if (directory) remove(directory, { recursive: true, force: true });
    sb.cleanup();
  }
});

test('owner benchmark validation emits a finite failure record and preserves normalized CLI rejection before effects', async () => {
  const sb = sandbox();
  try {
    const workspace = gitRepo(sb, 'workspace', 'git@github.com:org/benchmark-invalid.git');
    let output = '', error = '';
    const code = await cli(['memory', 'bench', '--n', '0'], { env: sb.env(), cwd: workspace,
      stdout(text) { output += text; }, stderr(text) { error += text; } });
    assert.equal(code, 2); assert.equal(output, '');
    assert.deepEqual(error.trim().split('\n').map(line => JSON.parse(line)), [
      { benchmarkFailure: { kind: 'memory-benchmark-failure', phase: 'prepare', completedStores: 0,
        completedSearches: 0, completedContexts: 0, completedHooks: 0, completedEpochs: 0 } },
      { error: { code: 'invalid', message: 'Invalid request' } },
    ]);
    assert.equal(fs.existsSync(sb.env().BOSUN_HOME!), false); assert.deepEqual(sb.calls(), []);
  } finally { sb.cleanup(); }
});

test('actual source CLI finishes complete fd stdout and stderr with delayed consumers before its producer joins', async () => {
  const sb = sandbox();
  try {
    const workspace = gitRepo(sb, 'workspace', 'git@github.com:org/entry-output.git');
    for (const args of [
      ['memory', 'bench', '--n', '1'],
      ['memory', 'bench', '--n', '0'],
      ['--version'],
    ]) {
      const child = childProcess.spawn(process.execPath, [
        ...(process.versions.bun ? ['--no-env-file', '--no-install'] : []),
        BIN, ...args,
      ], { env: sb.env(), cwd: workspace, stdio: ['pipe', 'pipe', 'pipe'],
        // This deadline bounds an actual OS producer; fake time cannot stop/join it.
        signal: AbortSignal.timeout(10000), killSignal: 'SIGKILL' });
      let stdout = '', stderr = '', producerError: Error | undefined;
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.stdout.pause();
      child.stderr.pause();
      // Pipe payloads fit the native pipe. Wait for actual producer exit before
      // consuming either stream, rather than guessing a sufficient drain delay.
      child.once('exit', () => { child.stdout.resume(); child.stderr.resume(); });
      const result = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
        child.once('error', error => {
          producerError = error;
          child.stdout.resume(); child.stderr.resume();
        });
        child.once('close', (code, signal) => resolve({ code, signal }));
        child.stdin.end();
      });
      assert.equal(producerError, undefined, 'fd output must finish and the original producer must close');
      assert.equal(result.signal, null, stderr);
      assert.throws(() => process.kill(child.pid!, 0),
        (error: NodeJS.ErrnoException) => error.code === 'ESRCH');
      if (args.at(-1) === '0') {
        assert.equal(result.code, 2);
        assert.equal(stdout, '');
        assert.deepEqual(stderr.trim().split('\n').map(line => JSON.parse(line)), [
          { benchmarkFailure: { kind: 'memory-benchmark-failure', phase: 'prepare', completedStores: 0,
            completedSearches: 0, completedContexts: 0, completedHooks: 0, completedEpochs: 0 } },
          { error: { code: 'invalid', message: 'Invalid request' } },
        ]);
      } else {
        assert.equal(result.code, 0, stderr);
        assert.equal(stderr, '');
        if (args[0] === '--version') assert.match(stdout, /^\d+\.\d+\.\d+\n$/);
        else {
          const report = JSON.parse(stdout);
          assert.deepEqual(report.corpus, { notes: 1, seed: 42, synthetic: true });
          assert.equal(report.store.samples, 1);
          assert.equal(report.hook.processCompletion, 'original-and-group-confirmed');
          assert.deepEqual(report.hook.outcomes, { injected: 0, held: 20, failed: 0, unqualified: 0 });
        }
      }
    }
    assert.deepEqual(sb.calls(), []);
    assert.equal(fs.existsSync(sb.env().BOSUN_HOME!), false);
  } finally { sb.cleanup(); }
});
