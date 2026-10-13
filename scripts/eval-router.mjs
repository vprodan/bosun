// Offline qualification interface; Bun guard installed before application imports.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const repo = path.resolve(import.meta.dirname, '..');
const { assertRuntime, createRun, launch } = createRequire(import.meta.url)('./test-runtime.cjs');
assertRuntime();
const args = process.argv.slice(2), worker = args[0] === '--worker';
if (worker) args.shift();
if (args.length !== 2 || args[0] !== '--fixture') throw new Error('Usage: bun scripts/eval-router.mjs --fixture test/fixtures/router-eval.json');
if (!worker && !globalThis[Symbol.for('bosun.test.guard')]) {
  const { environment, cleanupRun } = createRequire(import.meta.url)('./test-env.cjs');
  const root = createRun('bosun-router-eval-');
  try {
    const env = environment(path.join(root, 'evaluation'), root), cwd = path.join(root, 'work'); fs.mkdirSync(cwd);
    const result = launch(root, [import.meta.filename, '--worker', ...args], { env, cwd });
    process.exitCode = result.status ?? 1;
  } finally { cleanupRun(root); }
} else {
  const guard = globalThis[Symbol.for('bosun.test.guard')];
  if (!guard) throw new Error('Evaluation worker requires the mandatory Bun containment launcher');
  guard.assertEnvironment(process.env);
  const [{ reviewPath }, { routerEvaluationDataset }, { freezeRouterThreshold, routerEvaluationReport }] = await Promise.all([
    import('../src/core/domain/review.ts'), import('../src/contracts/router-evaluation.ts'), import('../src/core/use-cases/evaluate-router.ts'),
  ]);
  const file = path.resolve(repo, args[1]), relative = path.relative(repo, file); reviewPath(relative);
  const before = fs.lstatSync(file, { bigint: true });
  if (!relative.endsWith('.json') || !before.isFile() || before.nlink !== 1n || before.size > 262144n || fs.realpathSync(file) !== file) throw new Error('Evaluation fixture unavailable');
  // Guarded readFileSync is a repository-read operation; numeric openSync is
  // conservatively treated as mutation by the containment preload.
  const text = fs.readFileSync(file, { encoding: 'utf8', flag: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW });
  const sha256 = crypto.createHash('sha256').update(text).digest('hex'), dataset = routerEvaluationDataset(JSON.parse(text));
  const samples = dataset.cases.map(task => {
    if (!task.observed) throw new Error('Offline fixture requires captured observations');
    return { task, observed: task.observed, outcomeVerified: false };
  });
  const frozen = freezeRouterThreshold(samples.filter(sample => sample.task.split === 'development'));
  const report = routerEvaluationReport(dataset, samples, frozen, 'imported', sha256);
  const after = fs.lstatSync(file, { bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error('Evaluation fixture changed');
  process.stdout.write(JSON.stringify(report) + '\n');
}
