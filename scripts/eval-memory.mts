// Offline memory qualification interface: mandatory guard before application imports.
import type * as TestEnvironment from './test-env.cjs';
import type * as TestRuntime from './test-runtime.cjs';
import type { Mock } from '../test/helpers.ts';
import type { RuntimeConfig } from '../src/core/domain/config.ts';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const repo = path.resolve(import.meta.dirname, '..');
const { assertRuntime, createRun, launch } = createRequire(import.meta.url)('./test-runtime.cjs') as typeof TestRuntime;
assertRuntime();
const args = process.argv.slice(2),
  worker = args[0] === '--worker';
if (worker) args.shift();
const usage =
  'Usage: bun scripts/eval-memory.mts --fixture test/fixtures/memory-eval.json --baseline fts [--surface hook-packing|mcp] [--vectors-synthetic]';
if (args.length < 4 || args[0] !== '--fixture' || args[2] !== '--baseline' || args[3] !== 'fts')
  throw new Error(usage);
let surface: 'hook-packing' | 'mcp' = 'hook-packing';
let surfaceSet = false;
let vectorsSynthetic = false;
for (let i = 4; i < args.length; i++) {
  const candidate = args[i + 1];
  if (args[i] === '--surface' && !surfaceSet && (candidate === 'hook-packing' || candidate === 'mcp')) {
    surface = candidate;
    i++;
    surfaceSet = true;
  } else if (args[i] === '--vectors-synthetic' && !vectorsSynthetic) vectorsSynthetic = true;
  else throw new Error(usage);
}
if (vectorsSynthetic && surface !== 'mcp') throw new Error(usage);
const guardedGlobal = globalThis as typeof globalThis & { [key: symbol]: { assertEnvironment(env: NodeJS.ProcessEnv): void } | undefined };
if (!worker && !guardedGlobal[Symbol.for('bosun.test.guard')]) {
  const { environment, cleanupRun } = createRequire(import.meta.url)('./test-env.cjs') as typeof TestEnvironment;
  const root = createRun('bosun-memory-eval-run-');
  try {
    const env = environment(path.join(root, 'evaluation'), root, {
        TMPDIR: root,
        TMP: root,
        TEMP: root,
      }),
      cwd = path.join(root, 'work');
    fs.mkdirSync(cwd);
    const result = launch(root, [import.meta.filename, '--worker', ...args], { env, cwd });
    process.exitCode = result.status ?? 1;
  } finally {
    cleanupRun(root);
  }
} else {
  const guard = guardedGlobal[Symbol.for('bosun.test.guard')];
  if (!guard) throw new Error('Evaluation worker requires the mandatory Bun containment launcher');
  guard.assertEnvironment(process.env);
  const [{ reviewPath }, { runMemoryEvaluation }] = await Promise.all([
    import('../src/core/domain/review.ts'),
    import('../src/app/memory-evaluation.ts'),
  ]);
  const file = path.resolve(repo, args[1]),
    relative = path.relative(repo, file);
  reviewPath(relative);
  const stamp = (s: fs.BigIntStats): string =>
    [s.dev, s.ino, s.mode, s.uid, s.nlink, s.size, s.mtimeNs, s.ctimeNs].join(':');
  const before = fs.lstatSync(file, { bigint: true });
  if (
    !relative.endsWith('.json') ||
    !before.isFile() ||
    before.nlink !== 1n ||
    before.size > 262144n ||
    fs.realpathSync(file) !== file ||
    (process.getuid && before.uid !== BigInt(process.getuid()))
  )
    throw new Error('Evaluation fixture unavailable');
  const valid = () => {
    try {
      return (
        stamp(fs.lstatSync(file, { bigint: true })) === stamp(before) &&
        fs.realpathSync(file) === file
      );
    } catch {
      return false;
    }
  };
  const text = fs.readFileSync(file, {
    encoding: 'utf8',
    flag: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  });
  if (!valid()) throw new Error('Evaluation fixture changed');
  if (text.includes('\uFFFD')) throw new Error('Evaluation fixture encoding unavailable');
  const input: unknown = JSON.parse(text);
  let backend: Mock | undefined;
  try {
    let embedding: { privacy: 'public'; settings: RuntimeConfig['graph']['embedding'] } | undefined;
    if (vectorsSynthetic) {
      const { memoryEvaluationDataset } = await import('../src/contracts/memory-evaluation.ts');
      const dataset = memoryEvaluationDataset(input);
      if (dataset.evidence !== 'synthetic')
        throw new Error('Synthetic vectors require an explicitly synthetic corpus');
      const [{ mock }, { defaultConfig }] = await Promise.all([
        import('../test/helpers.ts'),
        import('../src/core/domain/config.ts'),
      ]);
      const model = 'bosun-synthetic-embedding',
        digest = 'f'.repeat(64);
      backend = await mock({
        '/api/tags': () => ({ json: { models: [{ model, digest }] } }),
        '/api/show': () => ({ json: { capabilities: ['embedding'] } }),
        '/api/embed': (body: { input: string[] }) => ({
          json: {
            model,
            embeddings: body.input.map((input: string) =>
              input.includes('unrelated nebula') ? [0, 1, 0] : [1, 0, 0],
            ),
            prompt_eval_count: 7,
          },
        }),
      });
      embedding = {
        privacy: 'public',
        settings: {
          ...defaultConfig().graph.embedding,
          model,
          digest,
          url: backend.url,
          dimensions: 3,
          backend: 'reference',
          queryCacheSize: 4,
        },
      };
    }
    const report = await runMemoryEvaluation({
      input,
      env: process.env,
      valid,
      surface,
      ...(embedding ? { embedding } : {}),
    });
    if (!valid()) throw new Error('Evaluation fixture changed');
    process.stdout.write(
      JSON.stringify({
        ...report,
        ...(vectorsSynthetic ? { embeddingEvidence: 'synthetic-http-fixture' } : {}),
        sha256: crypto.createHash('sha256').update(text).digest('hex'),
      }) + '\n',
    );
  } finally {
    await backend?.close();
  }
}
