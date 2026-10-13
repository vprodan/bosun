// A fresh environment, never a copy of a developer's authentication or configuration.
const fs = require('node:fs');
const path = require('node:path');
const PRELOAD = path.join(__dirname, 'test-preload.cjs');
// Prefer an existing standalone Git over Apple's license-gated developer-tools shim. Never install it.
const GIT = ['/opt/homebrew/bin/git', '/usr/local/bin/git', '/usr/bin/git', '/bin/git'].find((file) => fs.existsSync(file));
const GIT_REAL = GIT && fs.realpathSync(GIT);
const DEFAULT_STUBS = ['launchctl', 'systemctl', 'service', 'brew', 'ollama', 'uv', 'curl', 'tailscale', 'open', 'osascript', 'pgrep', 'sysctl', 'sw_vers', 'npm', 'npx', 'pip', 'pip3'];
const ROOT_KEYS = ['HOME', 'BOSUN_HOME', 'CODEX_HOME', 'BOSUN_CODEX_HOME', 'ORCA_CODEX_HOME', 'CLAUDE_CONFIG_DIR',
  'OPENCODE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'TMPDIR', 'TMP', 'TEMP',
  'BUN_INSTALL_CACHE_DIR', 'BUN_RUNTIME_TRANSPILER_CACHE_PATH'];
function environment(root, runRoot, extra = {}) {
  const home = path.join(root, 'home');
  const env = {
    HOME: home, BOSUN_HOME: path.join(home, '.bosun'), CODEX_HOME: path.join(home, '.codex'),
    BOSUN_CODEX_HOME: path.join(home, '.codex'), ORCA_CODEX_HOME: path.join(home, 'Library', 'Application Support', 'orca', 'codex-runtime-home', 'home'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'), OPENCODE_CONFIG_DIR: path.join(home, '.config', 'opencode'),
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'), XDG_CACHE_HOME: path.join(home, '.cache'),
    TMPDIR: path.join(root, 'tmp'), TMP: path.join(root, 'tmp'), TEMP: path.join(root, 'tmp'),
    BOSUN_TEST_RUN_ROOT: runRoot, BOSUN_TEST_PRELOAD: PRELOAD,
    BOSUN_TEST_SANDBOX: path.join(runRoot, 'containment.sb'),
    BOSUN_TEST_NET: path.join(runRoot, 'mock-ports.jsonl'),
    PATH: `${path.join(root, 'stubs')}:${path.dirname(process.execPath)}:${GIT ? path.dirname(GIT) + ':' : ''}/usr/bin:/bin`,
    // NODE_OPTIONS is not a Bun preload mechanism. Children receive explicit CLI flags.
    NODE_DISABLE_COMPILE_CACHE: '1', DO_NOT_TRACK: '1',
    BUN_INSTALL_CACHE_DIR: path.join(home, '.cache', 'bun'),
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: path.join(home, '.cache', 'transpiler'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_TERMINAL_PROMPT: '0',
    GIT_ALLOW_PROTOCOL: 'file', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: path.join(root, 'no-git-hooks'),
    LANG: 'C', LC_ALL: 'C', TZ: 'UTC',
    BOSUN_OLLAMA_APP: path.join(root, 'no-ollama'), BOSUN_TAILSCALE_APP: path.join(root, 'no-tailscale'),
    STUB_OUT: path.join(root, 'stub.jsonl'),
  };
  // Leave host/config directories absent until the application creates them, preserving no-effect checks.
  for (const key of ['HOME', 'TMPDIR']) fs.mkdirSync(env[key], { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(root, 'stubs'), { recursive: true });
  return { ...env, ...extra };
}
function cleanupRun(root) {
  // Only processes which loaded this run's preload are registered. Retire detached test panes before removing files.
  const registry = path.join(root, 'processes');
  const pids = fs.existsSync(registry) ? fs.readdirSync(registry).filter((name) => /^\d+$/.test(name)).map(Number) : [];
  for (const pid of pids) { if (pid === process.pid) continue; try { process.kill(pid, 'SIGTERM'); } catch {} }
  for (let i = 0; i < 10 && pids.some((pid) => fs.existsSync(path.join(registry, String(pid)))); i++) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  for (const pid of pids) { if (pid === process.pid || !fs.existsSync(path.join(registry, String(pid)))) continue; try { process.kill(pid, 'SIGKILL'); } catch {} }
  fs.rmSync(root, { recursive: true, force: true });
}
module.exports = { PRELOAD, DEFAULT_STUBS, ROOT_KEYS, GIT_REAL, environment, cleanupRun };
