// No application import is permitted here: containment is installed first.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { environment, PRELOAD, cleanupRun } = require('./test-env.cjs');
const repo = path.resolve(import.meta.dirname, '..');
let suite = 'all';
const GROUPS = { publicreader: ['public-reader.test.ts'], publication: ['publication.test.ts'], writer: ['writer-lifecycle.test.ts'], memory: ['memory.test.ts', 'mcp.test.ts', 'serve.test.ts', 'context.test.ts'], cutover: ['sqlite-cutover.test.ts'], hooklease: ['hook-delivery.test.ts'], readview: ['read-view-qualification.test.ts'], benchmark: ['memory.test.ts'], privacy: ['privacy.test.ts'], exposure: ['memory-exposure.test.ts'], readonly: ['sqlite-readonly.test.ts'], core: ['core.test.ts'],
  memoryadapter: ['memory-store.test.ts'], contracts: ['core.test.ts', 'router.test.ts', 'sqlite-readonly.test.ts', 'memory-store.test.ts'], router: ['router.test.ts'], opencode: ['opencode.test.ts'], boundaries: ['boundaries.test.ts'], owner: ['owner-cutover.test.ts', 'owner-restore.test.ts'] };
let selectedGroups;
try {
  if (process.versions.bun || Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node >=24 is required; Bun tests are prohibited');
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const [flag, inline] = args[i].split('=');
    if (!['--suite', '--runtime'].includes(flag)) throw new Error(`Unknown option: ${flag}`);
    const value = inline ?? args[++i];
    if (flag === '--runtime' && value !== 'node') throw new Error('Only --runtime node is supported; Bun tests are prohibited');
    if (flag === '--suite') suite = value;
  }
  selectedGroups = suite.split(',');
  if (selectedGroups.some((group) => !['all', 'legacy', 'containment', ...Object.keys(GROUPS)].includes(group))) throw new Error(`Unknown or unimplemented suite: ${suite}`);
} catch (error) { console.error(error.message); process.exit(2); }

// Always run the negative proofs before any existing application tests.
const probes = spawnSync(process.execPath, [path.join(repo, 'scripts/check-containment.mjs')], {
  cwd: repo, env: { PATH: path.dirname(process.execPath), LANG: 'C' }, stdio: 'inherit',
});
if (probes.status !== 0 || selectedGroups.every((group) => group === 'containment')) process.exit(probes.status ?? 1);

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bosun-test-run-')));
try {
  const env = environment(path.join(root, 'bootstrap'), root);
  const cwd = path.join(root, 'work');
  fs.mkdirSync(cwd);
  // Aliases of existing legacy tests retain their legacy coverage.
  const special = new Set(Object.entries(GROUPS).filter(([group]) => !['benchmark', 'memory'].includes(group)).flatMap(([, files]) => files));
  const tests = fs.readdirSync(path.join(repo, 'test')).filter((name) => name.endsWith('.test.ts') && name !== 'e2e.test.ts'
    && selectedGroups.some((group) => group === 'all' || group === 'legacy' && !special.has(name) || GROUPS[group]?.includes(name))).sort();
  if (!tests.length) throw new Error(`Suite ${suite} contains no implemented tests`);
  const result = spawnSync(process.execPath, ['--require', PRELOAD, '--test', '--test-concurrency=1', '--test-timeout=120000',
    ...tests.map((name) => path.join(repo, 'test', name))], { env, cwd, stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
} finally { cleanupRun(root); }
