// Use the already installed compiler with the same clean HOME/filesystem/process guard as tests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const { environment, PRELOAD, cleanupRun } = createRequire(import.meta.url)('./test-env.cjs');
const repo = path.resolve(import.meta.dirname, '..');
const compiler = path.join(repo, 'node_modules', 'typescript', 'bin', 'tsc');
if (process.versions.bun || Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node >=24 is required; Bun tests are prohibited');
if (!fs.existsSync(compiler)) throw new Error('Local TypeScript is unavailable; this command never installs dependencies');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bosun-typecheck-')));
try {
  const env = environment(path.join(root, 'compiler'), root);
  const cwd = path.join(root, 'work'); fs.mkdirSync(cwd);
  const result = spawnSync(process.execPath, ['--require', PRELOAD, compiler, '-p', repo], { env, cwd, stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
} finally { cleanupRun(root); }
