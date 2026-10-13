// Bun-only launch primitives. No application imports, downloads or host discovery.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { environment, PRELOAD, GIT_REAL } = require('./test-env.cjs');
const BUN_TEST_VERSION = '1.4.3';
const SANDBOX = '/usr/bin/sandbox-exec';
const repo = fs.realpathSync(path.resolve(__dirname, '..'));
function assertRuntime() {
  if (process.versions.bun !== BUN_TEST_VERSION || process.platform !== 'darwin' || process.arch !== 'arm64')
    throw new Error(`Guarded checks require Bun ${BUN_TEST_VERSION} on darwin/arm64; no Node fallback`);
  if (!globalThis[Symbol.for('bosun.test.guard')] && !fs.existsSync(SANDBOX))
    throw new Error('Bun checks require the OS sandbox; no unguarded fallback');
}
function createRun(prefix) {
  assertRuntime();
  // macOS Unix sockets have a 104-byte native bound; keep the run root short.
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix.split('-')[1]?.[0] ?? 'r')));
}
function writeSandbox(root) {
  const profile = path.join(root, 'containment.sb');
  const runtime = fs.realpathSync(process.execPath);
  const helpers = [runtime, GIT_REAL, '/usr/bin/id', '/bin/sleep', '/usr/bin/true', '/bin/true', '/usr/bin/plutil'].filter(Boolean);
  const literal = file => `(literal ${JSON.stringify(file)})`;
  const subpath = file => `(subpath ${JSON.stringify(file)})`;
  fs.writeFileSync(profile, `(version 1)
(allow default)
(deny file-read-data (require-all (require-any (subpath "/Users") (subpath "/private/var/folders") (subpath "/private/tmp")) (require-not (require-any ${subpath(root)} ${subpath(repo)} ${literal(runtime)}))))
(deny file-write* (require-not (require-any ${subpath(root)} (literal "/dev/null"))))
(deny process-exec (require-not (require-any ${helpers.map(literal).join(' ')} ${subpath(root)})))
(deny network-outbound (require-not (require-any (remote ip "localhost:*") (remote unix-socket ${subpath(root)}))))
(deny network-bind (require-not (require-any (local ip "localhost:*") (local unix-socket ${subpath(root)}))))
`, { mode: 0o600 });
  return profile;
}
function runtimeArgs(args, guarded = true) {
  const flags = ['--no-env-file', '--no-install', ...(guarded ? ['--preload', PRELOAD] : [])];
  return args[0] === 'test' ? ['test', ...flags, ...args.slice(1)] : [...flags, ...args];
}
function launch(root, args, options = {}) {
  assertRuntime();
  const profile = writeSandbox(root);
  const env = options.env ?? environment(path.join(root, 'bootstrap'), root);
  return cp.spawnSync(SANDBOX, ['-f', profile, process.execPath, ...runtimeArgs(args, options.guarded !== false)], {
    cwd: root, stdio: options.encoding ? 'pipe' : 'inherit', ...options,
    env: { ...env, BOSUN_TEST_SANDBOX: profile },
  });
}
module.exports = { BUN_TEST_VERSION, assertRuntime, createRun, writeSandbox, runtimeArgs, launch };
