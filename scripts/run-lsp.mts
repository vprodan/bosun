// Project tooling only: isolated startup HOME, inherited OS barrier, no app imports.
import type * as TestEnvironment from './test-env.cjs';
import type * as TestRuntime from './test-runtime.cjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { assertRuntime, createRun, launch } = require('./test-runtime.cjs') as typeof TestRuntime;
const { environment, cleanupRun } = require('./test-env.cjs') as typeof TestEnvironment;
assertRuntime();
const cli = fileURLToPath(new URL('../.omp/tooling/typescript-language-server-6.0.2/lib/cli.mjs', import.meta.url));
if (!fs.existsSync(cli)) throw Error('Approved project-local TypeScript language server is missing; no install fallback');
const root = createRun('bosun-lsp-');
try {
  const env = environment(path.join(root, 'server'), root);
  // The bundled server forks tsserver with explicit execArgv. Both inherit Bun,
  // this fresh environment and a cwd without dotenv files. Native reads/writes,
  // process execution and network access remain inside the OS barrier.
  const result = launch(root, [cli, '--stdio', '--log-level', '1'], { env, guarded: false });
  process.exitCode = result.status ?? 1;
} finally { cleanupRun(root); }
