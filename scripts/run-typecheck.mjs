// Use the already installed compiler with the same clean HOME/filesystem/process guard as tests.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const { environment, cleanupRun } = createRequire(import.meta.url)('./test-env.cjs');
const { assertRuntime, createRun, launch } = createRequire(import.meta.url)('./test-runtime.cjs');
const repo = path.resolve(import.meta.dirname, '..');
const compiler = path.join(repo, 'node_modules', 'typescript', 'bin', 'tsc');
assertRuntime();
if (!fs.existsSync(compiler)) throw new Error('Local TypeScript is unavailable; this command never installs dependencies');
const probes = spawnSync(process.execPath, [path.join(repo, 'scripts/check-containment.mjs')], {
  cwd: repo, env: { PATH: path.dirname(process.execPath), LANG: 'C' }, stdio: 'inherit',
});
if (probes.status !== 0) process.exit(probes.status ?? 1);
const root = createRun('bosun-typecheck-');
try {
  const env = environment(path.join(root, 'compiler'), root);
  const cwd = path.join(root, 'work'); fs.mkdirSync(cwd);
  const result = launch(root, [compiler, '-p', repo], { env, cwd });
  process.exitCode = result.status ?? 1;
} finally { cleanupRun(root); }
