// Accidental-effect guard, loaded before application imports. This is not an OS security sandbox.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const net = require('node:net');
const tls = require('node:tls');
const dgram = require('node:dgram');
const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');
const workers = require('node:worker_threads');
const sqlite = require('node:sqlite');
const { fileURLToPath, pathToFileURL, urlToHttpOptions } = require('node:url');
const { syncBuiltinESMExports } = require('node:module');
const { ROOT_KEYS, PRELOAD, GIT_REAL } = require('./test-env.cjs');
const canonicalPathModule = require('../src/platform/canonical-path.cjs');
const { realpathWithoutOpen } = canonicalPathModule;
const original = { lstat: fs.lstatSync, readlink: fs.readlinkSync, exists: fs.existsSync, read: fs.readFileSync,
  append: fs.appendFileSync, spawn: cp.spawn, spawnSync: cp.spawnSync };
const canonicalOperations = { lstat: original.lstat, readlink: original.readlink };
const repo = realpathWithoutOpen(path.resolve(__dirname, '..'), canonicalOperations);
const fail = (message) => { throw new Error(`bosun test containment: ${message}`); };
const inside = (root, target) => target === root || target.startsWith(root + path.sep);
function canonical(value, follow = true) {
  if (value instanceof URL) value = fileURLToPath(value);
  if (Buffer.isBuffer(value)) value = value.toString();
  if (typeof value !== 'string') fail('a filesystem path is required');
  // Keep '..' until the metadata walker has resolved preceding symlinks.
  const absolute = path.isAbsolute(value) ? value : `${process.cwd()}${path.sep}${value}`;
  let ancestor = follow ? absolute : path.dirname(absolute);
  const tail = follow ? [] : [path.basename(absolute)];
  try {
    for (;;) {
      try { original.lstat(ancestor); break; }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const parent = path.dirname(ancestor);
        if (parent === ancestor) throw error;
        tail.unshift(path.basename(ancestor)); ancestor = parent;
      }
    }
    // lstat detects dangling links instead of treating them as a missing leaf;
    // unresolved link targets fail closed. Metadata traversal also handles sockets
    // without opening their leaf inode or releasing a retained SQLite lease.
    return path.join(realpathWithoutOpen(ancestor, canonicalOperations), ...tail);
  }
  catch { fail('cannot resolve filesystem path'); }
}
// Qualification hashes public executable inputs. Grant exact files, never their
// containing directories, credentials, configuration, writes or execution.
const publicInputFiles = new Set([canonical(process.execPath)]);
const publicInputMetadata = new Set();
const nativeReceipt = path.join(repo, '.omp/tooling/sqlite-native-13.0.3/qualification.json');
if (original.exists(nativeReceipt)) {
  const stat = original.lstat(nativeReceipt);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024 || canonical(nativeReceipt) !== nativeReceipt)
    fail('invalid native public-input receipt');
  const receipt = JSON.parse(original.read(nativeReceipt, 'utf8'));
  const provenance = JSON.parse(receipt.provenance.json);
  const appleRoot = '(?:/Library/Developer/CommandLineTools|/Applications/Xcode(?:_[0-9.]+)?\\.app/Contents/Developer)';
  const compiler = new RegExp(`^${appleRoot}/(?:Toolchains/[^/]+\\.xctoolchain/)?usr/bin/(?:clang(?:\\+\\+)?|ld)$`);
  const sdk = new RegExp(`^${appleRoot}/(?:Platforms/MacOSX\\.platform/Developer/)?SDKs/MacOSX[^/]*\\.sdk$`);
  const toolchain = new RegExp(`^${appleRoot}(?:/Toolchains/[^/]+\\.xctoolchain)?$`);
  const tools = [...provenance.toolchain, provenance.hostedToolchain.xcrun, provenance.hostedToolchain.sdkSettings];
  if (tools.length !== 5) fail('invalid native public-input inventory');
  for (const tool of tools) {
    if (typeof tool.realpath !== 'string' || canonical(tool.realpath) !== tool.realpath ||
        !(compiler.test(tool.realpath) || tool.realpath === '/usr/bin/xcrun' ||
          (path.basename(tool.realpath) === 'SDKSettings.json' && sdk.test(path.dirname(tool.realpath)))))
      fail('native public input is not an installed Apple tool/SDK file');
    publicInputFiles.add(tool.realpath);
  }
  for (const [directory, pattern] of [[provenance.sdk, sdk], [provenance.hostedToolchain.toolchainRoot, toolchain]]) {
    if (typeof directory !== 'string' || !pattern.test(directory) || canonical(directory) !== directory)
      fail('native public-input metadata escapes Apple SDK/toolchain');
    publicInputMetadata.add(directory);
  }
}
function gitMetadata(cwd) {
  for (let current = canonical(cwd); inside(root,current); current = path.dirname(current)) {
    const marker = path.join(current,'.git');
    if (original.exists(marker)) {
      if (!inside(root,canonical(marker))) fail('git metadata escapes run root');
      let gitDir = marker;
      const stat = fs.statSync(marker);
      if (stat.isFile()) {
        const text = original.read(marker,'utf8'); const match = text.match(/^gitdir: ([^\r\n\0]+)\r?\n?$/);
        if (!match) fail('invalid git metadata pointer'); gitDir = path.resolve(current,match[1]);
      }
      if (!inside(root,canonical(gitDir))) fail('git metadata escapes run root');
      const commonPointer = path.join(gitDir,'commondir');
      if (original.exists(commonPointer)) {
        const common = path.resolve(gitDir,original.read(commonPointer,'utf8').trim());
        if (!inside(root,canonical(common))) fail('git common metadata escapes run root');
      }
      return;
    }
    if (current === root) break;
  }
}
if (process.versions.bun !== '1.4.3' || process.platform !== 'darwin' || process.arch !== 'arm64') fail('unqualified Bun test runtime; no Node fallback');
const root = process.env.BOSUN_TEST_RUN_ROOT;
if (!root || !path.isAbsolute(root) || realpathWithoutOpen(root, canonicalOperations) !== root) fail('missing or noncanonical run root');
if (process.env.BOSUN_TEST_SANDBOX !== path.join(root, 'containment.sb') || !original.exists(process.env.BOSUN_TEST_SANDBOX)) fail('missing Bun OS sandbox');
function assertEnvironment(env) {
  if (env.BOSUN_TEST_RUN_ROOT !== root || env.BOSUN_TEST_PRELOAD !== PRELOAD || env.BOSUN_TEST_SANDBOX !== path.join(root, 'containment.sb')) fail('child guard identity changed');
  for (const key of ROOT_KEYS) if (!env[key] || !path.isAbsolute(env[key]) || !inside(root, canonical(env[key]))) fail(`${key} is missing or escapes run root`);
  for (const key of ['BOSUN_OLLAMA_APP', 'BOSUN_TAILSCALE_APP', 'STUB_OUT', 'BOSUN_TEST_NET', 'GIT_CONFIG_GLOBAL']) {
    if (!env[key] || !inside(root, canonical(env[key]))) fail(`${key} escapes run root`);
  }
  if (env.BOSUN_TEST_NET !== path.join(root, 'mock-ports.jsonl') || env.GIT_CONFIG_NOSYSTEM !== '1' || env.GIT_ALLOW_PROTOCOL !== 'file') fail('offline configuration changed');
  for (const key of ['BUN_OPTIONS', 'BUN_CONFIG', 'NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES'])
    if (env[key]) fail('runtime startup override is prohibited');
}
assertEnvironment(process.env);
if (!inside(root, canonical(process.cwd()))) fail('cwd escapes run root');
// Resolve a complete application metadata path once, rather than recursively
// re-running this guard for every component. Each fresh component still passes
// the same metadata/link scope policy; no identities or prefix results are cached.
const checkedCanonicalOperations = {
  lstat(file) {
    if (!inside(root, file) && !inside(repo, file) && !inside(file, root) && !inside(file, repo))
      fail('metadata outside run root/repository ancestors');
    return original.lstat(file);
  },
  readlink(file) {
    if (!inside(root, file) && !inside(repo, file)) fail('link metadata outside run root/repository');
    return original.readlink(file);
  },
};
canonicalPathModule.realpathWithoutOpen = function (file, operations) {
  if (typeof file !== 'string' || operations !== undefined) fail('custom metadata resolution is prohibited');
  const resolved = realpathWithoutOpen(file, checkedCanonicalOperations);
  checkResolvedFile(resolved, false);
  return resolved;
};
Object.freeze(canonicalPathModule);
const processRegistry = path.join(root, 'processes');
fs.mkdirSync(processRegistry, { recursive: true });
const processMarker = path.join(processRegistry, String(process.pid));
fs.writeFileSync(processMarker, 'guarded');
const removeMarker = fs.rmSync.bind(fs);
process.once('exit', () => { try { removeMarker(processMarker, { force: true }); } catch {} });
// The launcher gives each Bun test file its own HOME before process startup.
// Native Bun caches HOME; os.homedir below also follows intentional fixture switches.
const netRegistry = process.env.BOSUN_TEST_NET;
// Bun's node:child_process/http compatibility layer calls native Bun methods.
// Only an already checked Node entry point may delegate to those methods.
let nativePermit = 0;
let httpConnectPermit;
function nativeCall(fn, receiver, args) {
  nativePermit++;
  try { return fn.apply(receiver, args); } finally { nativePermit--; }
}
function checkResolvedFile(resolved, write) {
  if (!inside(root, resolved) && (write || (!inside(repo, resolved) && !publicInputFiles.has(resolved)))) fail(`${write ? 'write' : 'read'} outside run root${write ? '' : '/repository'}`);
}
function checkFile(value, write = false, follow = true) {
  if (typeof value === 'number') return; // stdin/stdout and descriptors opened through the guard
  checkResolvedFile(canonical(value, follow), write);
}
function wrapFiles(target, name, checks) {
  if (typeof target[name] !== 'function') return;
  const fn = target[name];
  target[name] = function (...args) {
    for (const [i, write, follow = true] of checks) {
      if (typeof args[i] === 'number') continue;
      const resolved = canonical(args[i], follow);
      // Executability metadata for the already allowlisted standalone Git is
      // permitted; its bytes, host config and all writes remain protected.
      if (!write && ['stat','statSync','access','accessSync'].includes(name) && GIT_REAL && resolved === GIT_REAL) continue;
      if (!write && ['stat','statSync','lstat','lstatSync','realpath','realpathSync'].includes(name) && publicInputMetadata.has(resolved)) continue;
      // The metadata-only resolver walks fixed root ancestors without opening
      // files. Permit their lstat metadata, never ancestor bytes or directory lists.
      if (!write && ['lstat','lstatSync'].includes(name)) {
        if (inside(resolved, root) || inside(resolved, repo)) continue;
      }
      checkResolvedFile(resolved, write);
    }
    return fn.apply(this, args);
  };
}
for (const base of ['readFile', 'stat', 'lstat', 'readdir', 'readlink', 'realpath', 'access', 'opendir']) {
  for (const target of [fs, fs.promises]) wrapFiles(target, base, [[0, false, !['lstat','readlink'].includes(base)]]);
  wrapFiles(fs, base + 'Sync', [[0, false, !['lstat','readlink'].includes(base)]]);
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
const writeOpenMask = fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND;
const writesFile = (flags) => typeof flags === 'number' ? (flags & writeOpenMask) !== 0 : /[wa+]/.test(flags);
for (const target of [fs, fs.promises]) {
  const open = target.open;
  target.open = function (file, flags, ...args) { checkFile(file, writesFile(flags)); return open.call(this, file, flags, ...args); };
}
const openSync = fs.openSync;
fs.openSync = function (file, flags, ...args) { checkFile(file, writesFile(flags)); return openSync.call(this, file, flags, ...args); };
wrapFiles(fs, 'createReadStream', [[0, false]]);
wrapFiles(fs, 'createWriteStream', [[0, true]]);
const chdir = process.chdir;
process.chdir = (dir) => { if (!inside(root, canonical(dir))) fail('cwd escapes run root'); chdir(dir); };
os.homedir = () => process.env.HOME;
// SQLite opens files in native code, so the filesystem wrappers are insufficient.
function checkSqliteOpen(file, readOnly, allowExtension = false) {
  if (allowExtension) fail('SQLite extensions are prohibited');
  const location = Buffer.isBuffer(file) ? file.toString('utf8') : file;
  if (typeof location === 'string' && location.startsWith('file:')) {
    if (Buffer.isBuffer(file) && !file.equals(Buffer.from(location, 'utf8'))) fail('unqualified SQLite URI');
    const uri = new URL(location), target = fileURLToPath(uri);
    if (readOnly !== true || uri.hostname || uri.hash ||
      location !== pathToFileURL(target).href + '?immutable=1&mode=ro') fail('unqualified SQLite URI');
    checkFile(target, false);
  } else if (file !== ':memory:') checkFile(file, !readOnly);
}
function checkSqliteSql(sql) {
  // Comments and a schema qualifier do not make VACUUM INTO an internal operation.
  const text = String(sql).replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|\/\*[\s\S]*?\*\/|--[^\r\n]*/g,
    (token) => token.startsWith('/*') || token.startsWith('--') ? ' ' : token);
  if (/\bATTACH\b|\bVACUUM\b[^;]*\bINTO\b|\bload_extension\b/i.test(text)) fail('SQLite external file operation');
}
function checkSqliteBackup(file) {
  if ((Buffer.isBuffer(file) ? file.toString('utf8') : String(file)).startsWith('file:')) fail('SQLite backup URI prohibited');
  checkFile(file, true);
}
// Keep the upstream runtime guard for app-free diagnostics; it is not an app fallback.
const DatabaseSync = sqlite.DatabaseSync;
sqlite.DatabaseSync = class GuardedDatabase extends DatabaseSync {
  constructor(file, options = {}) {
    checkSqliteOpen(file, options.readOnly, options.allowExtension);
    super(file, options);
  }
  exec(sql) { checkSqliteSql(sql); return super.exec(sql); }
  prepare(sql) { checkSqliteSql(sql); return super.prepare(sql); }
  loadExtension() { fail('SQLite extensions are prohibited'); }
  enableLoadExtension(allow) { if (allow) fail('SQLite extensions are prohibited'); return super.enableLoadExtension(allow); }
};
const backup = sqlite.backup;
if (backup) sqlite.backup = (db, file, options) => {
  checkSqliteBackup(file); return backup(db, file, options);
};

// Only the installed project-built addon may load, once, during this preload.
// Do not grant nativePermit: that would also admit Bun's process/network escapes.
const betterEntry = require.resolve('better-sqlite3');
const betterRoot = path.dirname(path.dirname(canonical(betterEntry)));
if (betterRoot !== path.join(repo, 'node_modules', 'better-sqlite3')) fail('unqualified SQLite package');
const betterNative = canonical(path.join(betterRoot, 'build', 'Release', 'bosun_sqlite.node'));
if (betterNative !== path.join(betterRoot, 'build', 'Release', 'bosun_sqlite.node')) fail('unqualified SQLite native binding');
const dlopen = process.dlopen;
let sqliteLoadPermit = true;
process.dlopen = function (module, filename, ...args) {
  if (!sqliteLoadPermit || canonical(filename) !== betterNative) fail('native addon loading is prohibited');
  sqliteLoadPermit = false;
  return dlopen.call(this, module, filename, ...args);
};
let addon;
try { addon = require(betterNative); } finally { sqliteLoadPermit = false; }
const NativeDatabase = addon.Database;
function guardSqliteMethods(prototype, raw = false) {
  for (const key of ['exec', 'prepare']) {
    const method = prototype[key];
    prototype[key] = function (sql, ...args) { checkSqliteSql(sql); return method.call(this, sql, ...args); };
  }
  const method = prototype.backup;
  prototype.backup = function (...args) {
    const file = args[raw ? 2 : 0];
    checkSqliteBackup(file); return method.apply(this, args);
  };
  prototype.loadExtension = () => fail('SQLite extensions are prohibited');
  const controls = prototype.setConnectionControls;
  prototype.setConnectionControls = function (allow, ...args) {
    if (allow) fail('SQLite extensions are prohibited');
    return controls.call(this, allow, ...args);
  };
}
guardSqliteMethods(NativeDatabase.prototype, true);
addon.Database = new Proxy(NativeDatabase, {
  construct(target, args, newTarget) {
    checkSqliteOpen(args[0], args[3]);
    return Reflect.construct(target, args, newTarget);
  },
});
Object.defineProperty(NativeDatabase.prototype, 'constructor', {
  ...Object.getOwnPropertyDescriptor(NativeDatabase.prototype, 'constructor'), value: addon.Database,
});
const BetterDatabase = require(betterEntry);
guardSqliteMethods(BetterDatabase.prototype);
const GuardedBetterDatabase = new Proxy(BetterDatabase, {
  apply(target, receiver, args) { return Reflect.construct(GuardedBetterDatabase, args); },
  construct(target, args, newTarget) {
    const [file, options = {}] = args;
    if ('nativeBinding' in options && options.nativeBinding !== addon &&
      !(typeof options.nativeBinding === 'string' && canonical(options.nativeBinding) === betterNative))
      fail('custom SQLite native binding is prohibited');
    if (!Buffer.isBuffer(file)) checkSqliteOpen(file, options.readonly, options.allowExtension);
    else if (options.allowExtension) fail('SQLite extensions are prohibited');
    return Reflect.construct(target, args, newTarget);
  },
});
Object.defineProperty(BetterDatabase.prototype, 'constructor', {
  ...Object.getOwnPropertyDescriptor(BetterDatabase.prototype, 'constructor'), value: GuardedBetterDatabase,
});
require.cache[betterEntry].exports = GuardedBetterDatabase;

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
  env.BOSUN_TEST_SANDBOX ??= path.join(root, 'containment.sb');
  env.BUN_INSTALL_CACHE_DIR ??= process.env.BUN_INSTALL_CACHE_DIR;
  env.BUN_RUNTIME_TRANSPILER_CACHE_PATH ??= process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH;
  assertEnvironment(env);
  env.NODE_DISABLE_COMPILE_CACHE = '1';
  for (const key of ['NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'NODE_V8_COVERAGE', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES']) delete env[key];
  const cwd = options.cwd || process.cwd();
  if (!inside(root, canonical(cwd))) fail('child cwd escapes run root');
  if (options.shell) fail('shell execution is prohibited');
  let executable = resolveCommand(command, env);
  if (!executable) fail(`executable is not a sandbox stub or allowed helper: ${path.basename(command)}`);
  // Interpret fixture shebangs ourselves: neither env/node nor arbitrary shells
  // may run and silently omit Bun's explicit guard.
  if (inside(root, executable)) {
    const fd = fs.openSync(executable, 'r');
    let prefix;
    try { const buffer = Buffer.alloc(256); prefix = buffer.subarray(0, fs.readSync(fd, buffer, 0, buffer.length, 0)).toString('utf8'); }
    finally { fs.closeSync(fd); }
    const shebang = prefix.split('\n')[0];
    if (shebang === '#!/usr/bin/env node' || shebang === '#!/usr/bin/env bun' || shebang === `#!${process.execPath}`) {
      args = [executable, ...args]; executable = process.execPath;
    } else fail('fixture executable must use the explicit guarded runtime');
  }
  if (executable === process.execPath) {
    if (args.some(arg => /^--(?:env-file|env-file-if-exists|preload|require|experimental-config-file|experimental-default-config-file)(=|$)/.test(arg)) ||
      args[0] === 'install' || args[0] === 'add' || args[0] === 'x') fail('runtime configuration/install/preload overrides are prohibited');
    args = ['--no-env-file', '--no-install', '--preload', PRELOAD, ...args];
  }
  if (path.basename(executable) === 'git' && !inside(root, executable)) {
    gitMetadata(cwd);
    if (args.some((arg) => /^(clone|fetch|pull|push|submodule|credential|daemon)$|^--(exec-path|config-env|git-dir|work-tree)(=|$)/.test(arg))) fail('network/external git operation');
    for (const key of Object.keys(env)) if (key.startsWith('GIT_') && !['GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_TERMINAL_PROMPT', 'GIT_ALLOW_PROTOCOL'].includes(key)) delete env[key];
    Object.assign(env, { GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: path.join(root, 'no-git-hooks'),
      GIT_CONFIG_KEY_1: 'core.fsmonitor', GIT_CONFIG_VALUE_1: 'false', GIT_CONFIG_KEY_2: 'submodule.recurse', GIT_CONFIG_VALUE_2: 'false', GIT_CEILING_DIRECTORIES: root });
    let gitCommand;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-C') { if (!inside(root, canonical(args[++i]))) fail('git cwd escapes run root'); gitMetadata(args[i]); continue; }
      if (args[i].startsWith('-C')) { if (!inside(root, canonical(args[i].slice(2)))) fail('git cwd escapes run root'); gitMetadata(args[i].slice(2)); }
      if (args[i] === '-c') { if (!/^user\.(name|email)=/.test(args[++i] || '')) fail('unsafe git config override'); continue; }
      if (args[i].startsWith('-c') && !/^-cuser\.(name|email)=/.test(args[i])) fail('unsafe git config override');
      if (!args[i].startsWith('-')) { gitCommand = args[i]; break; } // later command flags (e.g. ls-files -co) are not global config options
    }
    const configQuery = args.slice(args.indexOf('config')).join('\0') === ['config','--null','--local','--includes','--get-regexp','^(filter\\..*\\.(clean|smudge|process)|core\\.(worktree|bare)|extensions\\..*)$'].join('\0');
    if (gitCommand && !['init', 'add', 'commit', 'status', 'diff', 'log', 'show', 'grep', 'ls-files', 'remote', 'rev-parse', 'merge-base', 'worktree'].includes(gitCommand) && !(gitCommand === 'config' && configQuery)) fail('git command is not an offline fixture helper');
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
  const c = child(command, args, options); return nativeCall(original.spawnSync, cp, [c.executable, c.args, c.options]);
};
cp.spawn = function (command, args = [], options = {}) { const c = child(command, args, options); return nativeCall(original.spawn, cp, [c.executable, c.args, c.options]); };
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
function ownedSocket(file, registered = false) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file !== canonical(file) || !inside(root, file)) fail('socket path escapes run root');
  if (!registered) return;
  const entries = original.exists(netRegistry) ? original.read(netRegistry, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
  const active = new Map(); for (const entry of entries) if (entry.socket) active.set(`${entry.pid}:${entry.socket}`, entry);
  if (![...active.values()].some(entry => entry.active && entry.socket === file && (() => { try { process.kill(entry.pid, 0); return true; } catch { return false; } })())) fail('unregistered local socket');
}
net.Socket.prototype.connect = function (...args) {
  const values = Array.isArray(args[0]) ? args[0] : args;
  const opts = typeof values[0] === 'object' ? values[0] : typeof values[0] === 'string' && !/^\d+$/.test(values[0])
    ? { path: values[0] } : { port: values[0], host: typeof values[1] === 'string' ? values[1] : undefined };
  if (opts.path) { ownedSocket(opts.path, true); return nativeCall(connect, this, args); }
  if (typeof opts.port !== 'number' && !/^\d+$/.test(String(opts.port))) fail('socket path/external network is prohibited');
  endpoint(opts.host, opts.port); return nativeCall(connect, this, args);
};
function guardListen(prototype) {
  const listen = prototype.listen;
  prototype.listen = function (...args) {
    const opts = typeof args[0] === 'object' ? args[0] : typeof args[0] === 'string' && !/^\d+$/.test(args[0])
      ? { path: args[0] } : { port: args[0], host: args[1] };
    if (opts.path) ownedSocket(opts.path);
    else if (!['127.0.0.1', '::1', 'localhost'].includes(opts.host) || Number(opts.port) !== 0) fail('mock servers must use an ephemeral loopback port');
    this.prependOnceListener('listening', () => {
      const address = this.address();
      const endpoint = typeof address === 'string' ? { socket: address } : { port: address.port };
      original.append(netRegistry, JSON.stringify({ pid: process.pid, ...endpoint, active: true }) + '\n');
      this.once('close', () => { if (original.exists(root)) original.append(netRegistry, JSON.stringify({ pid: process.pid, ...endpoint, active: false }) + '\n'); });
    });
    return nativeCall(listen, this, args);
  };
}
guardListen(net.Server.prototype);
// Bun's HTTP server is not a subclass of net.Server.
if (http.Server.prototype.listen !== net.Server.prototype.listen) guardListen(http.Server.prototype);
const fetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  endpoint(url.hostname, url.port || (url.protocol === 'https:' ? 443 : 80));
  // Bun fetch does not use node:net. Never let its native redirect path escape
  // the independently registered endpoint (manual responses remain inspectable).
  const redirect = options?.redirect ?? (typeof input === 'object' ? input.redirect : undefined);
  return fetch(input, { ...options, redirect: redirect === 'manual' ? 'manual' : 'error' });
};
for (const module of [http, https]) {
  for (const name of ['request', 'get']) {
    const originalRequest = module[name];
    module[name] = function (input, options, callback) {
      const isUrl = typeof input === 'string' || input instanceof URL;
      if (typeof options === 'function') { callback = options; options = undefined; }
      const effective = isUrl ? { ...urlToHttpOptions(new URL(input)), ...options } : { ...input };
      const protocol = module === https ? 'https:' : 'http:';
      if (effective.protocol !== undefined && effective.protocol !== protocol) fail('HTTP protocol mismatch');
      // Snapshot overrides before granting any native delegation. Custom connection
      // hooks/agents could substitute a destination after these checks.
      if (effective.createConnection !== undefined || effective.lookup !== undefined ||
        effective._defaultAgent !== undefined || effective.agent != null && effective.agent !== false)
        fail('custom HTTP connection routing is prohibited');
      effective.agent = false;
      effective.protocol = protocol;
      if (effective.headers && !Array.isArray(effective.headers)) effective.headers = { ...effective.headers };
      delete effective.href;
      if (effective.socketPath) {
        ownedSocket(effective.socketPath, true);
      } else {
        delete effective.socketPath;
        const host = effective.hostname || effective.host || 'localhost';
        const port = effective.port === undefined || effective.port === '' ? (module === https ? 443 : 80) : effective.port;
        if (typeof host !== 'string' || typeof port !== 'number' && !/^\d+$/.test(String(port)))
          fail('invalid HTTP destination');
        endpoint(host, port);
        effective.hostname = effective.host = host === '[::1]' ? '::1' : host;
        effective.port = Number(port);
      }
      const previous = httpConnectPermit;
      httpConnectPermit = effective;
      try { return originalRequest.call(this, effective, callback); }
      finally { httpConnectPermit = previous; }
    };
  }
}
const tlsConnect = tls.connect;
tls.connect = function (...args) { const opts = typeof args[0] === 'object' ? args[0] : { port: args[0], host: args[1] }; endpoint(opts.host, opts.port); return nativeCall(tlsConnect, this, args); };
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
// Application code uses node:* APIs. Native escape surfaces are disabled rather
// than pretending those calls inherit the JavaScript filesystem/socket wrappers.
const bunFile = Bun.file, bunWrite = Bun.write;
Bun.file = (file, ...args) => { checkFile(file); return bunFile(file, ...args); };
Bun.write = (file, data, ...args) => {
  if (typeof file !== 'string' && !Buffer.isBuffer(file) && !(file instanceof URL)) fail('Bun write requires a guarded path');
  checkFile(file, true); return bunWrite(file, data, ...args);
};
for (const key of ['spawn', 'spawnSync', 'connect', 'listen', 'serve', 'udpSocket', '$', 'dlopen']) {
  const native = Bun[key];
  Bun[key] = function (...args) {
    if (!nativePermit) {
      if (key !== 'connect' || !httpConnectPermit) fail(`native Bun ${key} is prohibited; use guarded node APIs`);
      // HTTP delegation grants only this exact admitted connection, not a broad
      // permit for native processes, listeners, addons, or unrelated raw TCP.
      const options = { ...args[0] };
      args[0] = options;
      if (httpConnectPermit.socketPath) {
        if (options?.unix !== httpConnectPermit.socketPath) fail('HTTP native socket destination changed');
        ownedSocket(options.unix, true);
      } else {
        if (options.unix || Number(options.port) !== httpConnectPermit.port) fail('HTTP native destination changed');
        endpoint(options.hostname, options.port);
      }
    }
    return native.apply(this, args);
  };
}
for (const name of ['WebSocket', 'EventSource']) if (globalThis[name])
  globalThis[name] = class { constructor() { fail(`${name} is prohibited`); } };
workers.Worker = class { constructor() { fail('unpreloaded worker is prohibited'); } };
globalThis[Symbol.for('bosun.test.guard')] = Object.freeze({ root, assertEnvironment, checkFile });
syncBuiltinESMExports();
