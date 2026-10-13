// No application import is permitted here: containment is installed first.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { environment, cleanupRun } = require('./test-env.cjs');
const { assertRuntime, createRun, launch } = require('./test-runtime.cjs');
const repo = path.resolve(import.meta.dirname, '..');
let suite = 'all';
const GROUPS = {
  publicreader: ['public-reader.test.ts'],
  publication: ['publication.test.ts'],
  writer: ['writer-lifecycle.test.ts', 'writer-capacity.test.ts'],
  memory: [
    'memory.test.ts',
    'memory-cli.test.ts',
    'mcp.test.ts',
    'serve.test.ts',
    'context.test.ts',
  ],
  cutover: ['sqlite-cutover.test.ts'],
  readview: ['read-view-qualification.test.ts'],
  benchmark: ['memory.test.ts', 'memory-benchmark.test.ts'],
  privacy: ['privacy.test.ts'],
  exposure: ['memory-exposure.test.ts'],
  readonly: ['sqlite-readonly.test.ts'],
  core: ['core.test.ts'],
  handoff: ['handoff.test.ts', 'handoff-artifacts.test.ts'],
  providers: ['model-providers.test.ts'],
  runtimee2e: ['runtime-end-to-end.test.ts'],
  daemonmethods: ['daemon-methods.test.ts'],
  daemonmemory: ['daemon-memory.test.ts'],
  jobs: ['jobs.test.ts'],
  quota: ['quota.test.ts'],
  runtime: ['runtime.test.ts'],
  context: ['context.test.ts'],
  contextpipeline: ['context-pipeline.test.ts'],
  docsadapter: ['docs-adapter.test.ts'],
  memoryadapter: ['memory-store.test.ts'],
  contracts: [
    'core.test.ts',
    'router.test.ts',
    'sqlite-readonly.test.ts',
    'memory-store.test.ts',
    'docs-adapter.test.ts',
    'context-pipeline.test.ts',
    'jobs.test.ts',
    'daemon-methods.test.ts',
  ],
  router: ['router.test.ts'],
  opencode: ['opencode.test.ts', 'opencode-v2.test.ts', 'opencode-host.test.ts'],
  managedcontrols: ['opencode-control.test.ts'],
  nativerunners: ['opencode-runner.test.ts', 'native-runners.test.ts'],
  boundaries: ['boundaries.test.ts'],
  owner: ['owner-cutover.test.ts', 'owner-restore.test.ts'],
};
GROUPS.claudemem = ['claude-mem-source.test.ts', 'external-sources.test.ts'];
let selectedGroups;
GROUPS.events = ['job-events.test.ts'];
GROUPS.handoff.push('handoff-checkout.test.ts');
GROUPS.usage = ['usage-ledger.test.ts'];
GROUPS.logging = ['logging.test.ts'];
GROUPS.graph = ['graph.test.ts'];
GROUPS.clef = ['clef-lifecycle.test.ts', 'clef-retirement.test.ts', 'router.test.ts'];
GROUPS.consolidation = ['consolidation.test.ts'];
GROUPS.summary = ['summary.test.ts'];
GROUPS.dashboard = ['dashboard.test.ts'];
GROUPS.profiles = ['profiles.test.ts'];
GROUPS.retention = ['job-retention.test.ts'];
GROUPS.notifications = ['notifications.test.ts'];
GROUPS.mcp = ['mcp.test.ts'];
GROUPS.hostinstall = ['host-installation.test.ts'];
GROUPS.hostlaunch = ['host-launch.test.ts'];
GROUPS.lint = ['lint.test.ts'];
GROUPS.workspace = ['workspaces.test.ts'];
GROUPS.review = ['review.test.ts'];
GROUPS.checks = ['checks.test.ts'];
GROUPS.card = ['cards.test.ts'];
GROUPS.dispatch = ['dispatch-policy.test.ts'];
GROUPS.doctor = ['doctor.test.ts'];
GROUPS.managedruntime = ['managed-runtime.test.ts'];
GROUPS.upgrade = ['upgrade.test.ts'];
GROUPS.remote = ['remote-runtime.test.ts', 'remote-view.test.ts'];
GROUPS.installation = ['installation.test.ts'];
GROUPS.service = ['installation-service.test.ts'];
GROUPS.suggestions = ['memory-suggestions.test.ts'];
GROUPS.privacy.push('memory-suggestions.test.ts');
GROUPS.observations = ['route-observations.test.ts'];
GROUPS.routereval = ['router-evaluation.test.ts'];
GROUPS.memoryeval = ['memory-evaluation.test.ts'];
GROUPS.memorycli = ['memory-cli.test.ts'];
GROUPS.lexical = ['lexical-memory.test.ts'];
GROUPS.overviewmcp = ['memory-overview-mcp.test.ts'];
GROUPS.embeddings = ['embeddings.test.ts', 'embedding-storage.test.ts', 'embedding-jobs.test.ts', 'sqlite-vec.test.ts'];
GROUPS.vectoreval = ['memory-vector-mcp.test.ts'];
GROUPS.climetadata = ['cli.test.ts', 'roles.test.ts'];
GROUPS.runcli = ['run-cli.test.ts'];
GROUPS.serve = ['serve.test.ts'];
GROUPS.orca = ['orca.test.ts'];
GROUPS.exec = ['exec.test.ts'];
GROUPS.distribution = ['distribution.test.ts'];
GROUPS.acp = ['acp-runner.test.ts'];
GROUPS.codexmanaged = ['codex-control.test.ts'];
GROUPS.claudeclient = ['claude-client.test.ts'];
GROUPS.claudetranscript = ['claude-transcript.test.ts'];
GROUPS.compiledcurrent = ['compiled-current.test.ts'];
GROUPS.omp = ['omp-native.test.ts', 'omp-host.test.ts'];
try {
  assertRuntime();
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const [flag, inline] = args[i].split('=');
    if (!['--suite', '--runtime'].includes(flag)) throw new Error(`Unknown option: ${flag}`);
    const value = inline ?? args[++i];
    if (flag === '--runtime' && value !== 'bun')
      throw new Error('Only --runtime bun is supported; no Node fallback');
    if (flag === '--suite') suite = value;
  }
  selectedGroups = suite.split(',');
  if (
    selectedGroups.some(
      (group) => !['all', 'legacy', 'containment', ...Object.keys(GROUPS)].includes(group),
    )
  )
    throw new Error(`Unknown or unimplemented suite: ${suite}`);
} catch (error) {
  console.error(error.message);
  process.exit(2);
}

// Always run the negative proofs before any existing application tests.
const probes = spawnSync(process.execPath, [path.join(repo, 'scripts/check-containment.mjs')], {
  cwd: repo,
  env: { PATH: path.dirname(process.execPath), LANG: 'C' },
  stdio: 'inherit',
});
if (probes.status !== 0 || selectedGroups.every((group) => group === 'containment'))
  process.exit(probes.status ?? 1);

const root = createRun('bosun-test-run-');
try {
  const cwd = path.join(root, 'work');
  fs.mkdirSync(cwd);
  // Aliases of existing legacy tests retain their legacy coverage.
  const special = new Set(
    Object.entries(GROUPS)
      .filter(([group]) => !['benchmark', 'memory', 'context'].includes(group))
      .flatMap(([, files]) => files),
  );
  const tests = fs
    .readdirSync(path.join(repo, 'test'))
    .filter(
      (name) =>
        name.endsWith('.test.ts') &&
        name !== 'e2e.test.ts' &&
        selectedGroups.some(
          (group) =>
            group === 'all' ||
            (group === 'legacy' && !special.has(name)) ||
            GROUPS[group]?.includes(name),
        ),
    )
    .sort();
  if (!tests.length) throw new Error(`Suite ${suite} contains no implemented tests`);
  let failed = 0;
  // Each file is a separate process: native Bun HOME/config caches never see
  // another file's bootstrap environment. No shared Bun test import graph.
  for (const [index, name] of tests.entries()) {
    const env = environment(path.join(root, `file-${index}`), root);
    console.log(`Guarded Bun file ${index + 1}/${tests.length}: ${name}`);
    const result = launch(root, ['test', '--timeout', '120000', path.join(repo, 'test', name)], { env, cwd });
    if (result.status !== 0) failed++;
  }
  console.log(`Guarded Bun files: ${tests.length - failed}/${tests.length} passed; ${failed} failed.`);
  process.exitCode = failed ? 1 : 0;
} finally {
  cleanupRun(root);
}
