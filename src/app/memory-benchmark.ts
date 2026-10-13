import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Env } from '../core/domain/inference.ts';
import { defaultConfig } from '../core/domain/config.ts';
import { BosunError } from '../core/errors.ts';
import {
  benchmarkCount,
  benchmarkDistribution,
  benchmarkHookOutcome,
  type BenchmarkHookProcess,
} from '../core/memory-benchmark.ts';
import { createRetrieveContext } from '../core/use-cases/retrieve-context.ts';
import { createCuratedSource } from '../core/memory-source.ts';
import { runtimePaths } from '../platform/paths.ts';
import { DaemonOwner } from '../platform/daemon-owner.ts';
import { contentHash } from '../platform/content-hash.ts';
import { project } from '../platform/project.ts';
import { streamProcess } from '../platform/process.ts';
import { setupRuntime } from './setup.ts';
import { openDaemonMemory } from './memory.ts';

const QUERIES = 200,
  HOOK_RUNS = 20;
type BenchmarkRuntime = {
  execPath: string;
  entry: string | null;
  node: string;
  bun?: string;
  sqlite?: string;
};
export type BenchmarkFailureDiagnostic = {
  kind: 'memory-benchmark-failure';
  phase: 'prepare' | 'setup' | 'owner-acquire' | 'memory-open' | 'store'
    | 'epoch-close' | 'epoch-open' | 'search' | 'context' | 'publication'
    | 'memory-close' | 'owner-close' | 'hook' | 'report'
    | 'cleanup-memory' | 'cleanup-owner' | 'cleanup-tree';
  completedStores: number;
  completedSearches: number;
  completedContexts: number;
  completedHooks: number;
  completedEpochs: number;
};
type BenchmarkOptions = { n: number; publicView: boolean; workspace: string; env: Env };
type BenchmarkDependencies = { runtime?: BenchmarkRuntime; process?: typeof streamProcess;
  onFailure?: (diagnostic: Readonly<BenchmarkFailureDiagnostic>) => void };
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export async function runMemoryBenchmark(
  options: BenchmarkOptions,
  dependencies: BenchmarkDependencies = {},
) {
  const diagnostic: BenchmarkFailureDiagnostic = { kind: 'memory-benchmark-failure', phase: 'prepare',
    completedStores: 0, completedSearches: 0, completedContexts: 0, completedHooks: 0, completedEpochs: 0 };
  try { return await benchmark(options, dependencies, diagnostic); }
  catch (error) {
    // Owner diagnostics contain only fixed phases and completed operation counts.
    // Observer failures cannot replace the original operation/cleanup failure.
    try { void Promise.resolve(dependencies.onFailure?.(Object.freeze({ ...diagnostic }))).catch(() => {}); } catch {}
    throw error;
  }
}
async function benchmark(
  options: BenchmarkOptions, dependencies: BenchmarkDependencies, diagnostic: BenchmarkFailureDiagnostic,
) {
  const runtime = dependencies.runtime ?? {
    execPath: process.execPath,
    entry: new URL(import.meta.url).pathname.startsWith('/$bunfs/')
      ? null
      : fileURLToPath(new URL('../../bin/bosun', import.meta.url)),
    node: process.versions.node,
    bun: process.versions.bun,
    sqlite: process.versions.sqlite,
  };
  const hook = {
    command: runtime.execPath,
    args: runtime.entry === null ? ['hook']
      : [...(runtime.bun ? ['--no-env-file', '--no-install'] : []), runtime.entry, 'hook'],
  };
  const execute = dependencies.process ?? streamProcess;
  const n = benchmarkCount(options.n),
    identity = project(options.workspace),
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bosun-benchmark-')));
  fs.chmodSync(dir, 0o700);
  const env = {
    ...options.env,
    BOSUN_HOME: dir,
    BOSUN_SOCKET: path.join(dir, 's'),
    BOSUN_DEPTH: '',
    NODE_DISABLE_COMPILE_CACHE: '1',
  };
  const paths = runtimePaths(env),
    config = defaultConfig();
  config.memory.claudeMem = false;
  let owner: DaemonOwner | undefined, memory: ReturnType<typeof openDaemonMemory> | undefined;
  let producerJoined = true;
  const clock = {
    now: Date.now,
    monotonic: () => performance.now(),
    hash: contentHash,
    dateLabel: (at: number) => new Date(at).toISOString().slice(0, 10),
    measure() {},
  };
  try {
    diagnostic.phase = 'setup';
    await setupRuntime(paths, config);
    diagnostic.phase = 'owner-acquire';
    owner = new DaemonOwner(paths.owner);
    const authority = owner;
    let serial = 0;
    const open = () =>
      openDaemonMemory({
        paths: { primary: paths.memory, view: paths.view, backups: paths.backups },
        assertOwner: () => authority.assert(),
        memory: {
          now: Date.now,
          monotonic: () => performance.now(),
          hash: contentHash,
          id: (at) =>
            `m_${at.toString(32).padStart(9, '0')}${(++serial).toString(16).padStart(8, '0')}`,
          retention: { sessionTtlDays: 7, purgeAfterDays: 90 },
          measure() {},
        },
        context: clock,
        docsIndex: { monotonic: () => performance.now(), measure() {} },
        publicationId: crypto.randomUUID,
      });
    diagnostic.phase = 'memory-open'; memory = open();
    const ctx = { projectId: identity.id, sessionId: null, linked: [], audience: 'model' as const },
      rnd = random(42);
    const syllables = [
      'ka',
      'ro',
      'mi',
      'te',
      'su',
      'na',
      'lo',
      'vi',
      'de',
      'pa',
      'shi',
      'gu',
      'ne',
      'to',
      'ba',
      'ri',
    ];
    const vocab = Array.from({ length: 2000 }, () =>
      Array.from(
        { length: 2 + Math.floor(rnd() * 3) },
        () => syllables[Math.floor(rnd() * syllables.length)],
      ).join(''),
    );
    const word = () => vocab[Math.floor(vocab.length * rnd() ** 2)],
      text = (words: number) => Array.from({ length: words }, word).join(' ');
    const store: number[] = [],
      search: number[] = [],
      packing: number[] = [],
      lifecycle: number[] = [],
      tokens: number[] = [],
      prompts: string[] = [],
      ids = new Set<string>();
    for (let i = 0; i < n; i++) {
      // The registered writer deliberately bounds source+WAL growth. Prepare
      // this temporary corpus in finite epochs; never bypass native admission
      // or replay a held write. Close/checkpoint cost is reported separately.
      if (i && i % 256 === 0) {
        const started = performance.now();
        diagnostic.phase = 'epoch-close';
        await memory.close();
        memory = undefined;
        diagnostic.phase = 'epoch-open';
        memory = open();
        lifecycle.push(performance.now() - started);
        diagnostic.completedEpochs++;
      }
      const start = performance.now();
      diagnostic.phase = 'store';
      const result = await memory.memory.store(
        {
          category: i % 10 ? 'project' : 'personal',
          title: text(5),
          body: text(40 + Math.floor(rnd() * 80)),
          private: false,
        },
        ctx,
      );
      store.push(performance.now() - start);
      ids.add(result.memory.id);
      diagnostic.completedStores++;
    }
    const retrieve = createRetrieveContext([createCuratedSource(memory.memory)], clock);
    for (let i = 0; i < QUERIES; i++) {
      const prompt = text(6);
      prompts.push(prompt);
      let start = performance.now();
      diagnostic.phase = 'search';
      await memory.memory.search(
        { text: prompt, includePrivate: false, touch: false, limit: 10 },
        ctx,
      );
      search.push(performance.now() - start);
      diagnostic.completedSearches++;
      start = performance.now();
      diagnostic.phase = 'context';
      const packed = await retrieve(prompt, ctx, {
        budgetTokens: 400,
        minScore: 0,
        itemChars: 400,
        minMatched: 2,
      });
      packing.push(performance.now() - start);
      tokens.push(packed.estTokens);
      diagnostic.completedContexts++;
    }
    if (options.publicView) { diagnostic.phase = 'publication'; await memory.publish(); }
    diagnostic.phase = 'memory-close';
    await memory.close();
    memory = undefined;
    diagnostic.phase = 'owner-close';
    owner.close();
    owner = undefined;
    const wall: number[] = [],
      injected: number[] = [],
      outcomes = { injected: 0, held: 0, failed: 0, unqualified: 0 };
    let firstRun: { wallMs: number; outcome: ReturnType<typeof benchmarkHookOutcome> } | null =
      null;
    for (let i = 0; i <= HOOK_RUNS; i++) {
      diagnostic.phase = 'hook';
      const start = performance.now();
      const child: BenchmarkHookProcess = { status: null, stdout: '' };
      const chunks: Buffer[] = [];
      producerJoined = false;
      try {
        for await (const event of execute({
          ...hook,
          env,
          cwd: options.workspace,
          input: JSON.stringify({ prompt: prompts[i], privacy: 'public', cwd: options.workspace }),
          signal: new AbortController().signal,
          timeoutMs: 5000,
          maxOutputBytes: 32768,
          stdout: (chunk) => { chunks.push(Buffer.from(chunk)); },
          onClosed: () => { producerJoined = true; },
        })) {
          if (event.t === 'exit') {
            child.status = event.code;
            child.signal = event.signal;
          }
        }
      } catch (error) {
        child.error = error;
      }
      // An exit event or exception does not prove that the original producer
      // and its process group completed. Keep its owned temporary data on hold.
      if (!producerJoined)
        throw new BosunError('unavailable', 'Benchmark hook completion unconfirmed; temporary data retained',
          { details: { outcome: 'unknown' } });
      child.stdout = Buffer.concat(chunks).toString('utf8');
      const ms = performance.now() - start;
      if (!i) firstRun = { wallMs: ms, outcome: benchmarkHookOutcome(child, ids) };
      if (i) {
        const outcome = benchmarkHookOutcome(child, ids);
        outcomes[outcome]++;
        wall.push(ms);
        if (outcome === 'injected') injected.push(ms);
      }
      diagnostic.completedHooks++;
    }
    diagnostic.phase = 'report';
    const fileBytes = (file: string) => (fs.existsSync(file) ? fs.statSync(file).size : 0);
    return {
      schema: 1,
      corpus: { notes: n, seed: 42, synthetic: true },
      runtime: {
        engine: runtime.bun ? 'bun' : 'node',
        version: runtime.bun ?? runtime.node,
        ...(runtime.bun ? {} : { node: runtime.node }),
        sqlite: runtime.sqlite,
      },
      queries: QUERIES,
      store: benchmarkDistribution(store),
      corpusLoading: { epochNotes: 256, lifecycle: benchmarkDistribution(lifecycle) },
      search: benchmarkDistribution(search),
      context: benchmarkDistribution(packing),
      tokens: {
        estimator: 'char/4',
        hostTokens: 'unverified',
        budget: 400,
        withinEstimate: tokens.filter((value) => value <= 400).length,
        maximumEstimate: Math.max(0, ...tokens),
      },
      hook: {
        processStartup: 'new-process-per-attempt',
        processCompletion: 'original-and-group-confirmed',
        daemon: 'absent',
        firstRun,
        runs: HOOK_RUNS,
        outcomes,
        wall: benchmarkDistribution(wall),
        verifiedInjectionWall: benchmarkDistribution(injected),
        componentLatency: null,
      },
      publicView: options.publicView ? 'ready-synthetic' : 'held-after-write',
      bytes: {
        primary: fileBytes(paths.memory) + fileBytes(`${paths.memory}-wal`),
        view: fileBytes(paths.view),
      },
      designatedMacLatency: 'unverified',
      ownerStorageOpened: false,
      modelsCalled: false,
    };
  } finally {
    try {
      await memory?.close();
    } catch (error) {
      diagnostic.phase = 'cleanup-memory'; throw error;
    } finally {
      try {
        owner?.close();
      } catch (error) {
        diagnostic.phase = 'cleanup-owner'; throw error;
      } finally {
        try { if (producerJoined) fs.rmSync(dir, { recursive: true, force: true }); }
        catch (error) { diagnostic.phase = 'cleanup-tree'; throw error; }
      }
    }
  }
}
