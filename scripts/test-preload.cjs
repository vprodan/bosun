// Accidental-effect guard, loaded before application imports. This is not an OS security sandbox.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const net = require('node:net');
const tls = require('node:tls');
const dgram = require('node:dgram');
const dns = require('node:dns');
const sqlite = require('node:sqlite');
const { fileURLToPath } = require('node:url');
const { syncBuiltinESMExports } = require('node:module');
const { environment, ROOT_KEYS, PRELOAD, GIT_REAL } = require('./test-env.cjs');
const original = { realpath: fs.realpathSync, exists: fs.existsSync, read: fs.readFileSync,
  append: fs.appendFileSync, spawn: cp.spawn, spawnSync: cp.spawnSync };
const repo = original.realpath(path.resolve(__dirname, '..'));
const fail = (message) => { throw new Error(`bosun test containment: ${message}`); };
const inside = (root, target) => target === root || target.startsWith(root + path.sep);
function canonical(value, follow = true) {
  if (value instanceof URL) value = fileURLToPath(value);
  if (Buffer.isBuffer(value)) value = value.toString();
  if (typeof value !== 'string') fail('a filesystem path is required');
  const absolute = path.resolve(value);
  let ancestor = follow ? absolute : path.dirname(absolute);
  const tail = follow ? [] : [path.basename(absolute)];
  while (!original.exists(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) fail('cannot resolve filesystem path');
    tail.unshift(path.basename(ancestor)); ancestor = parent;
  }
  return path.join(original.realpath(ancestor), ...tail);
}
if (process.versions.bun) fail('Bun tests are prohibited');
const root = process.env.BOSUN_TEST_RUN_ROOT;
if (!root || !path.isAbsolute(root) || original.realpath(root) !== root) fail('missing or noncanonical run root');
function assertEnvironment(env) {
  if (env.BOSUN_TEST_RUN_ROOT !== root || env.BOSUN_TEST_PRELOAD !== PRELOAD) fail('child guard identity changed');
  for (const key of ROOT_KEYS) if (!env[key] || !path.isAbsolute(env[key]) || !inside(root, canonical(env[key]))) fail(`${key} is missing or escapes run root`);
  for (const key of ['BOSUN_OLLAMA_APP', 'BOSUN_TAILSCALE_APP', 'STUB_OUT', 'BOSUN_TEST_NET', 'GIT_CONFIG_GLOBAL']) {
    if (!env[key] || !inside(root, canonical(env[key]))) fail(`${key} escapes run root`);
  }
  if (env.BOSUN_TEST_NET !== path.join(root, 'mock-ports.jsonl') || env.GIT_CONFIG_NOSYSTEM !== '1' || env.GIT_ALLOW_PROTOCOL !== 'file') fail('offline configuration changed');
}
assertEnvironment(process.env);
if (!inside(root, canonical(process.cwd()))) fail('cwd escapes run root');
const processRegistry = path.join(root, 'processes');
fs.mkdirSync(processRegistry, { recursive: true });
const processMarker = path.join(processRegistry, String(process.pid));
fs.writeFileSync(processMarker, 'guarded');
const removeMarker = fs.rmSync.bind(fs);
process.once('exit', () => { try { removeMarker(processMarker, { force: true }); } catch {} });
// Node's test-file children receive separate homes before evaluating their import graph.
if (process.env.NODE_TEST_CONTEXT === 'child-v8' && process.argv[1]?.endsWith('.test.ts')) {
  const clean = environment(path.join(root, `test-${process.pid}`), root);
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, clean, { NODE_TEST_CONTEXT: 'child-v8' });
}
const netRegistry = process.env.BOSUN_TEST_NET;
const nodeOptions = `--require=${JSON.stringify(PRELOAD)}`;
function checkFile(value, write = false, follow = true) {
  if (typeof value === 'number') return; // stdin/stdout and descriptors opened through the guard
  const resolved = canonical(value, follow);
  if (!inside(root, resolved) && (write || !inside(repo, resolved))) fail(`${write ? 'write' : 'read'} outside run root${write ? '' : '/repository'}`);
}
function wrapFiles(target, name, checks) {
  if (typeof target[name] !== 'function') return;
  const fn = target[name];
  target[name] = function (...args) { for (const [i, write, follow = true] of checks) checkFile(args[i], write, follow); return fn.apply(this, args); };
}
for (const base of ['readFile', 'stat', 'lstat', 'readdir', 'readlink', 'realpath', 'access', 'opendir']) {
  for (const target of [fs, fs.promises]) wrapFiles(target, base, [[0, false]]);
  wrapFiles(fs, base + 'Sync', [[0, false]]);
}
fs.existsSync = (file) => { try { checkFile(file); return original.exists(file); } catch { return false; } };
for (const base of ['writeFile', 'appendFile', 'mkdir', 'mkdtemp', 'truncate', 'chmod', 'chown', 'utimes']) {
  for (const target of [fs, fs.promises]) wrapFiles(target, base, [[0, true]]);
  wrapFiles(fs, base + 'Sync', [[0, true]]);
}
for (const base of ['unlink', 'rm', 'rmdir']) {
  for (const target of [fs, fs.promises]) wrapFiles(target, base, [[0, true, false]]);
  wrapFiles(fs, base + 'Sync', [[0, true, false]]);
}
for (const base of ['copyFile', 'cp']) {
  for (const target of [fs, fs.promises]) wrapFiles(target, base, [[0, false], [1, true]]);
  wrapFiles(fs, base + 'Sync', [[0, false], [1, true]]);
}
for (const target of [fs, fs.promises]) wrapFiles(target, 'rename', [[0, true, false], [1, true, false]]);
wrapFiles(fs, 'renameSync', [[0, true, false], [1, true, false]]);
for (const target of [fs, fs.promises]) wrapFiles(target, 'link', [[0, true], [1, true]]);
wrapFiles(fs, 'linkSync', [[0, true], [1, true]]);
for (const target of [fs, fs.promises]) wrapFiles(target, 'symlink', [[1, true, false]]);
wrapFiles(fs, 'symlinkSync', [[1, true, false]]); // read-only asset links into the repository are intentional
for (const target of [fs, fs.promises]) {
  const open = target.open;
  target.open = function (file, flags, ...args) { checkFile(file, typeof flags === 'number' ? flags !== 0 : /[wa+]/.test(flags)); return open.call(this, file, flags, ...args); };
}
const openSync = fs.openSync;
fs.openSync = function (file, flags, ...args) { checkFile(file, typeof flags === 'number' ? flags !== 0 : /[wa+]/.test(flags)); return openSync.call(this, file, flags, ...args); };
wrapFiles(fs, 'createReadStream', [[0, false]]);
wrapFiles(fs, 'createWriteStream', [[0, true]]);
const chdir = process.chdir;
process.chdir = (dir) => { if (!inside(root, canonical(dir))) fail('cwd escapes run root'); chdir(dir); };
os.homedir = () => process.env.HOME;
// SQLite opens files in native code, so the filesystem wrappers are insufficient.
const DatabaseSync = sqlite.DatabaseSync;
sqlite.DatabaseSync = class GuardedDatabase extends DatabaseSync {
  constructor(file, options = {}) { if (options.allowExtension) fail('SQLite extensions are prohibited'); if (file !== ':memory:') checkFile(file, !options.readOnly); super(file, options); }
  exec(sql) { if (/\bATTACH\b|\bVACUUM\s+INTO\b/i.test(sql)) fail('SQLite external file operation'); return super.exec(sql); }
  prepare(sql) { if (/\bATTACH\b|\bVACUUM\s+INTO\b/i.test(sql)) fail('SQLite external file operation'); return super.prepare(sql); }
  loadExtension() { fail('SQLite extensions are prohibited'); }
};
const backup = sqlite.backup;
if (backup) sqlite.backup = (db, file, options) => { checkFile(file, true); return backup(db, file, options); };

// No shell interpreter executes test commands. Only the exact command-discovery operation is emulated.
const safeSystem = new Set(['git', 'id', 'sleep', 'true', 'plutil']);
function resolveCommand(command, env) {
  const candidates = command.includes('/') ? [path.resolve(command)] : (env.PATH || '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, command));
  for (const candidate of candidates) {
    if (!original.exists(candidate)) continue;
    const real = canonical(candidate);
    if (real === process.execPath || real === GIT_REAL || inside(root, real)) return real;
    const name = path.basename(candidate);
    if (safeSystem.has(name) && ['/usr/bin', '/bin'].includes(path.dirname(real))) return real;
  }
  return null;
}
function child(command, args, options = {}) {
  const env = { ...(options.env || process.env) };
  // Re-establish the preload even when a caller supplies a complete custom env.
  env.BOSUN_TEST_RUN_ROOT ??= root; env.BOSUN_TEST_PRELOAD ??= PRELOAD;
  assertEnvironment(env);
  env.NODE_OPTIONS = nodeOptions; env.NODE_DISABLE_COMPILE_CACHE = '1';
  for (const key of ['NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'NODE_V8_COVERAGE', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES']) delete env[key];
  const cwd = options.cwd || process.cwd();
  if (!inside(root, canonical(cwd))) fail('child cwd escapes run root');
  if (options.shell) fail('shell execution is prohibited');
  const executable = resolveCommand(command, env);
  if (!executable) fail(`executable is not a sandbox stub or allowed helper: ${path.basename(command)}`);
  if (executable === process.execPath && args.some((arg) => /^--(?:env-file|env-file-if-exists|experimental-config-file|experimental-default-config-file)(=|$)/.test(arg))) fail('Node configuration files before preload are prohibited');
  if (path.basename(executable) === 'git' && !inside(root, executable)) {
    if (args.some((arg) => /^(clone|fetch|pull|push|submodule|credential|daemon)$|^--(exec-path|config-env|git-dir|work-tree)(=|$)/.test(arg))) fail('network/external git operation');
    for (const key of Object.keys(env)) if (key.startsWith('GIT_') && !['GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_TERMINAL_PROMPT', 'GIT_ALLOW_PROTOCOL'].includes(key)) delete env[key];
    Object.assign(env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: path.join(root, 'no-git-hooks'), GIT_CEILING_DIRECTORIES: root });
    let gitCommand;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-C') { if (!inside(root, canonical(args[++i]))) fail('git cwd escapes run root'); continue; }
      if (args[i].startsWith('-C') && !inside(root, canonical(args[i].slice(2)))) fail('git cwd escapes run root');
      if (args[i] === '-c') { if (!/^user\.(name|email)=/.test(args[++i] || '')) fail('unsafe git config override'); continue; }
      if (args[i].startsWith('-c') && !/^-cuser\.(name|email)=/.test(args[i])) fail('unsafe git config override');
      if (!args[i].startsWith('-')) { gitCommand = args[i]; break; } // later command flags (e.g. ls-files -co) are not global config options
    }
    if (gitCommand && !['init', 'add', 'commit', 'status', 'diff', 'log', 'show', 'grep', 'ls-files', 'remote', 'rev-parse', 'merge-base', 'worktree'].includes(gitCommand)) fail('git command is not an offline fixture helper');
    for (const arg of args) {
      const value = arg.startsWith('--') && arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : arg;
      if ((path.isAbsolute(value) || /(^|\/)\.\.(\/|$)/.test(value)) && !inside(root, canonical(path.resolve(cwd, value)))) fail('git path escapes run root');
    }
  }
  if (path.basename(executable) === 'plutil' && !inside(root, executable)) {
    if (!(args.length === 3 && args[0] === '-lint' && args[1] === '-s' || args.length === 4 && args[0] === '-extract' && args[2] === 'raw')) fail('only read-only plutil checks are allowed');
    checkFile(args.at(-1));
  }
  if (path.basename(executable) === 'id' && !inside(root, executable) && args.join(' ') !== '-u') fail('only id -u is allowed');
  return { executable, args, options: { ...options, env, cwd } };
}
cp.spawnSync = function (command, args = [], options = {}) {
  if (command === '/bin/sh' && args.length === 4 && args[0] === '-c' && args[1] === 'command -v "$1"' && args[2] === 'sh') {
    const env = options.env || process.env; assertEnvironment(env);
    const found = resolveCommand(args[3], env);
    return { status: found ? 0 : 1, signal: null, pid: 0, stdout: found ? `${found}\n` : '', stderr: '', output: [null, found ? `${found}\n` : '', ''] };
  }
  const c = child(command, args, options); return original.spawnSync(c.executable, c.args, c.options);
};
cp.spawn = function (command, args = [], options = {}) { const c = child(command, args, options); return original.spawn(c.executable, c.args, c.options); };
cp.exec = cp.execSync = () => fail('shell execution is prohibited');
cp.execFileSync = (command, args = [], options = {}) => {
  const r = cp.spawnSync(command, args, options);
  if (r.error || r.status) throw r.error || new Error(`child failed: ${r.status}`);
  return r.stdout;
};
cp.execFile = () => fail('use guarded spawn instead of execFile');
cp.fork = (file, args = [], options = {}) => cp.spawn(process.execPath, [file, ...args], { ...options, stdio: options.stdio || ['pipe', 'pipe', 'pipe', 'ipc'] });

// Servers bound to loopback register their actual ephemeral ports. Child clients share the registry.
function endpoint(host, port) {
  if (host === '[::1]') host = '::1';
  host = host || 'localhost';
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) fail('external network is prohibited');
  let entries = [];
  if (original.exists(netRegistry)) entries = original.read(netRegistry, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  const active = new Map(); for (const entry of entries) active.set(`${entry.pid}:${entry.port}`, entry);
  if (![...active.values()].some((entry) => entry.active && entry.port === Number(port) && (() => { try { process.kill(entry.pid, 0); return true; } catch { return false; } })())) fail('unregistered loopback endpoint');
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const values = Array.isArray(args[0]) ? args[0] : args;
  const opts = typeof values[0] === 'object' ? values[0] : { port: values[0], host: typeof values[1] === 'string' ? values[1] : undefined };
  if (opts.path || typeof opts.port !== 'number' && !/^\d+$/.test(String(opts.port))) fail('socket path/external network is prohibited');
  endpoint(opts.host, opts.port); return connect.apply(this, args);
};
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  const opts = typeof args[0] === 'object' ? args[0] : { port: args[0], host: args[1] };
  if (opts.path || !['127.0.0.1', '::1', 'localhost'].includes(opts.host) || Number(opts.port) !== 0) fail('mock servers must use an ephemeral loopback port');
  this.prependOnceListener('listening', () => {
    const address = this.address();
    original.append(netRegistry, JSON.stringify({ pid: process.pid, port: address.port, active: true }) + '\n');
    this.once('close', () => { if (original.exists(root)) original.append(netRegistry, JSON.stringify({ pid: process.pid, port: address.port, active: false }) + '\n'); });
  });
  return listen.apply(this, args);
};
const fetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  endpoint(url.hostname, url.port || (url.protocol === 'https:' ? 443 : 80));
  // The socket guard also checks redirects, http.request, tls and undici connections.
  return fetch(input, options);
};
const tlsConnect = tls.connect;
tls.connect = function (...args) { const opts = typeof args[0] === 'object' ? args[0] : { port: args[0], host: args[1] }; endpoint(opts.host, opts.port); return tlsConnect.apply(this, args); };
dgram.createSocket = () => fail('UDP is prohibited');
dns.lookup = (host, options, callback) => {
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) fail('DNS is prohibited');
  if (typeof options === 'function') { callback = options; options = {}; }
  const address = host === '::1' ? '::1' : '127.0.0.1'; const family = host === '::1' ? 6 : 4;
  process.nextTick(() => options?.all ? callback(null, [{ address, family }]) : callback(null, address, family));
};
dns.promises.lookup = async (host, options) => {
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) fail('DNS is prohibited');
  const result = { address: host === '::1' ? '::1' : '127.0.0.1', family: host === '::1' ? 6 : 4 };
  return options?.all ? [result] : result;
};
for (const key of ['resolve', 'resolve4', 'resolve6', 'reverse']) {
  dns[key] = () => fail('DNS is prohibited');
  if (dns.promises[key]) dns.promises[key] = async () => fail('DNS is prohibited');
}
globalThis[Symbol.for('bosun.test.guard')] = Object.freeze({ root, assertEnvironment, checkFile });
syncBuiltinESMExports();
