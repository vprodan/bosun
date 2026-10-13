// Synthetic negative containment proofs only; SQLite facade imports do not qualify application protocols.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const { environment, ROOT_KEYS, GIT_REAL } = createRequire(import.meta.url)('./test-env.cjs');
const { assertRuntime, createRun, launch } = createRequire(import.meta.url)('./test-runtime.cjs');
assertRuntime();
const repo = path.resolve(import.meta.dirname, '..');
const root = createRun('bosun-containment-');
const outside = createRun('bosun-outside-sentinel-');
const cwd = path.join(root, 'work'); fs.mkdirSync(cwd);
const env = environment(path.join(root, 'fixture'), root);
fs.writeFileSync(path.join(outside, 'read-sentinel'), 'synthetic immutable sentinel');
const entry = path.join(root, 'entry.mjs');
const sentinel = path.join(root, 'import-sentinel');
fs.writeFileSync(entry, `import ${JSON.stringify(pathToFileURL(path.join(repo, 'test/bootstrap.ts')).href)};
import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(sentinel)}, 'evaluated');
await import(${JSON.stringify(pathToFileURL(path.join(repo, 'src/platform/config.ts')).href)});`);
let count = 0;
function probe(name, fn) { fn(); count++; console.log(`ok ${count} - ${name}`); }
function run(source, extra = {}) {
  return launch(root, ['-e', source], {
    cwd, env: { ...env, ...extra }, encoding: 'utf8', timeout: 15000,
  });
}
function good(source) { const r = run(source); assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`); }
const quotedOutside = JSON.stringify(path.join(outside, 'escape'));
function blockedBeforeImport(extra, preload = true) {
  fs.rmSync(sentinel, { force: true });
  const r = launch(root, [entry], {
    guarded: preload, cwd, env: { ...env, ...extra }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(r.error, undefined, String(r.error));
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /containment|require scripts\/run-tests/);
  assert.equal(fs.existsSync(sentinel), false, 'entry/application import sentinel must remain absent');
}
const deniedServers = [];
let deniedCalls = 0;
async function denyDestination(address) {
  const server = net.createServer(peer => { deniedCalls++; peer.destroy(); });
  deniedServers.push(server);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    if (typeof address === 'string') server.listen(address, resolve);
    else server.listen(0, '127.0.0.1', resolve);
  });
  return typeof address === 'string' ? address : server.address().port;
}
async function closeDeniedDestinations() {
  await Promise.all(deniedServers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
}
try {
  probe('OS sandbox starts the pinned Bun with a fresh startup HOME', () => {
    const r = launch(root, ['-e', `import os from 'node:os';console.log(JSON.stringify({bun:process.versions.bun,home:os.homedir()}))`], { guarded: false, cwd, env, encoding: 'utf8', timeout: 10000 });
    assert.equal(r.status, 0, JSON.stringify({ status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr, error: String(r.error) }));
    assert.deepEqual(JSON.parse(r.stdout), {bun:'1.4.3',home:env.HOME});
  });
  probe('Bun socket realpath limitation is bound to a non-symlink leaf and canonical parent', () => {
    const file=path.join(root,'s0');
    const r=launch(root,['-e', `import fs from 'node:fs';import net from 'node:net';
      const file=${JSON.stringify(file)},server=net.createServer();await new Promise(r=>server.listen(file,r));
      let code;try{fs.realpathSync(file);}catch(e){code=e.code;}
      console.log(JSON.stringify({code,socket:fs.lstatSync(file).isSocket(),link:fs.lstatSync(file).isSymbolicLink(),parent:fs.realpathSync(${JSON.stringify(root)})}));
      await new Promise(r=>server.close(r));`],{guarded:false,cwd,env,encoding:'utf8',timeout:10000});
    assert.equal(r.status,0,r.stderr); assert.deepEqual(JSON.parse(r.stdout),{code:'EOPNOTSUPP',socket:true,link:false,parent:root});
  });
  probe('missing HOME fails before application evaluation', () => blockedBeforeImport({ HOME: '' }));
  probe('outside HOME fails before application evaluation', () => blockedBeforeImport({ HOME: outside }));
  fs.symlinkSync(outside, path.join(root, 'escape-link'));
  probe('canonical metadata follows symlinks before parent traversal and contains missing tails', () => good(`
    import assert from 'node:assert/strict'; import fs from 'node:fs'; import path from 'node:path';
    const {realpathWithoutOpen}=await import(${JSON.stringify(path.join(repo,'src/platform/canonical-path.cjs'))});
    const dir=path.join(process.cwd(),'canonical-proof'),target=path.join(dir,'target'),deep=path.join(target,'deep');
    fs.mkdirSync(deep,{recursive:true});
    const link=path.join(dir,'inside-link');fs.symlinkSync(deep,link);
    fs.writeFileSync(link+'/../owned','inside');
    assert.equal(fs.readFileSync(path.join(target,'owned'),'utf8'),'inside');
    assert.equal(fs.existsSync(path.join(dir,'owned')),false);
    fs.mkdirSync(link+'/../new/deep',{recursive:true});
    fs.writeFileSync(link+'/../new/deep/file','created');
    assert.equal(fs.readFileSync(path.join(target,'new/deep/file'),'utf8'),'created');
    const escaped=${JSON.stringify(path.join(root,'escape-link'))}+'/../'+${JSON.stringify(path.basename(outside))}+'/read-sentinel';
    assert.throws(()=>fs.readFileSync(escaped),/containment/);
    assert.throws(()=>fs.statSync(escaped),/containment/);
    assert.throws(()=>fs.writeFileSync(escaped,'bad'),/containment/);
    assert.equal(fs.existsSync(escaped),false);
    assert.throws(()=>realpathWithoutOpen(escaped),/containment/);
    assert.throws(()=>realpathWithoutOpen(${JSON.stringify(path.join(outside,'read-sentinel'))}),/containment/);
    assert.throws(()=>realpathWithoutOpen(target,{lstat(){throw Error('must not enter caller metadata');},readlink(){return target;}}),/containment/);
    assert.equal(realpathWithoutOpen(link+'/../owned'),path.join(target,'owned'));
    assert.throws(()=>realpathWithoutOpen(target+'/absent'),error=>error.code==='ENOENT');
    const dangling=path.join(dir,'outside-missing-link');
    fs.symlinkSync(${JSON.stringify(path.join(outside,'missing-target'))},dangling);
    assert.throws(()=>fs.writeFileSync(dangling,'bad'),/containment/);
    assert.throws(()=>fs.mkdirSync(dangling+'/deep',{recursive:true}),/containment/);
    fs.unlinkSync(dangling);
    assert.equal(fs.lstatSync(link).isSymbolicLink(),true);fs.unlinkSync(link);
    assert.equal(fs.readFileSync(path.join(target,'owned'),'utf8'),'inside');`));
  probe('symlink HOME escape fails before application evaluation', () => blockedBeforeImport({ HOME: path.join(root, 'escape-link') }));
  probe('every host/XDG/temp root is mandatory and contained', () => {
    for (const key of ROOT_KEYS) { blockedBeforeImport({ [key]: '' }); blockedBeforeImport({ [key]: outside }); }
  });
  probe('direct test invocation fails before application evaluation', () => blockedBeforeImport({}, false));
  probe('clean environment excludes inherited credentials and user configuration', () => {
    for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDECODE', 'OPENCODE_CONFIG', 'HTTP_PROXY', 'NODE_PATH']) assert.equal(env[key], undefined);
  });
  probe('child custom environment regains mandatory preload', () => good(`
    import assert from 'node:assert/strict'; import { spawnSync } from 'node:child_process';
    const env = { ...process.env }; delete env.NODE_OPTIONS;
    const r = spawnSync(process.execPath, ['-e', ${JSON.stringify(`const assert=require('node:assert/strict'), fs=require('node:fs'); assert.ok(globalThis[Symbol.for('bosun.test.guard')]); assert.throws(()=>fs.writeFileSync(${quotedOutside},'bad'),/containment/);`)}], {env, encoding:'utf8'});
    assert.equal(r.status, 0, r.stderr);`));
  probe('escaped child environment and cwd are rejected before spawn', () => good(`
    import assert from 'node:assert/strict'; import { spawnSync } from 'node:child_process';
    assert.throws(()=>spawnSync(process.execPath,['-e',''],{env:{...process.env,HOME:${JSON.stringify(outside)}}}),/containment/);
    assert.throws(()=>spawnSync(process.execPath,['-e',''],{cwd:${JSON.stringify(outside)}}),/containment/);`));
  probe('absolute supervisor/installer/model executables cannot bypass stubs', () => good(`
    import assert from 'node:assert/strict'; import { spawnSync } from 'node:child_process';
    for (const command of ['/bin/launchctl','/usr/bin/systemctl','/opt/homebrew/bin/brew','/usr/local/bin/claude']) assert.throws(()=>spawnSync(command,['--version']),/containment/);`));
  probe('shell and PATH fallback cannot bypass process guard', () => good(`
    import assert from 'node:assert/strict'; import { spawnSync, execSync } from 'node:child_process';
    assert.throws(()=>spawnSync('/bin/sh',['-c','/bin/launchctl list']),/containment/);
    assert.throws(()=>spawnSync('launchctl',['list'],{env:{...process.env,PATH:'/bin:/usr/bin'}}),/containment/);
    assert.throws(()=>spawnSync('true',[],{shell:true}),/containment/);
    assert.throws(()=>execSync('/bin/launchctl list'),/containment/);`));
  probe('outside writes and symlink writes fail', () => good(`
    import assert from 'node:assert/strict'; import fs from 'node:fs';
    assert.throws(()=>fs.writeFileSync(${quotedOutside},'bad'),/containment/);
    assert.throws(()=>fs.writeFileSync(${JSON.stringify(path.join(root, 'escape-link', 'escape'))},'bad'),/containment/);
    await assert.rejects(async()=>fs.promises.writeFile(${quotedOutside},'bad'),/containment/);`));
  probe('upstream diagnostic SQLite opens and attached databases remain contained', () => good(`
    import assert from 'node:assert/strict'; import {DatabaseSync,backup} from 'node:sqlite';
    import {pathToFileURL} from 'node:url';
    assert.throws(()=>new DatabaseSync(${quotedOutside}),/containment/);
    const uri=pathToFileURL(${quotedOutside}).href+'?immutable=1&mode=ro';
    for (const location of [uri,Buffer.from(uri)]) {
      assert.throws(()=>new DatabaseSync(location,{readOnly:true}),/containment/);
      assert.throws(()=>new DatabaseSync(location,{readOnly:false}),/containment/);
    }
    for(const suffix of ['?mode=rw','?immutable=1&mode=ro&vfs=unix-none','?mode=ro','?immutable=1&mode=ro#fragment'])
      assert.throws(()=>new DatabaseSync(pathToFileURL(process.env.HOME+'/inside.db').href+suffix,{readOnly:true}),/containment/);
    const db=new DatabaseSync(':memory:');
    assert.throws(()=>db.exec('ATTACH DATABASE '+JSON.stringify(${quotedOutside})+' AS escaped'),/containment/);
    assert.throws(()=>backup(db,${quotedOutside}),/containment/);
    assert.throws(()=>backup(db,uri),/containment/);
    assert.throws(()=>new DatabaseSync(':memory:',{allowExtension:true}),/containment/); db.close();`));
  probe('application SQLite facade denies native path, URI, SQL, backup and extension escapes', () => good(`
    import assert from 'node:assert/strict';
    import {SqliteDatabase,sqliteBackup} from ${JSON.stringify(pathToFileURL(path.join(repo,'src/platform/sqlite.ts')).href)};
    import {pathToFileURL} from 'node:url';
    const uri=pathToFileURL(${quotedOutside}).href+'?immutable=1&mode=ro';
    for(const location of [${quotedOutside},${JSON.stringify(path.join(root,'escape-link','escape'))},uri,Buffer.from(uri)])
      for(const readOnly of [true,false]) assert.throws(()=>new SqliteDatabase(location,{readOnly}),/containment/);
    for(const suffix of ['?mode=rw','?immutable=1&mode=ro&vfs=unix-none','?mode=ro','?immutable=1&mode=ro#fragment'])
      assert.throws(()=>new SqliteDatabase(pathToFileURL(process.env.HOME+'/inside.db').href+suffix,{readOnly:true}),/containment/);
    const db=new SqliteDatabase(':memory:');
    try {
      for(const sql of ["ATTACH DATABASE '"+${quotedOutside}+"' AS escaped","VACUUM INTO '"+${quotedOutside}+"'",
        "VACUUM main/**/INTO '"+${quotedOutside}+"'","ATTACH/**/DATABASE '"+${quotedOutside}+"' AS escaped",
        "SELECT '--'; ATTACH DATABASE '"+${quotedOutside}+"' AS escaped","SELECT '/*'; VACUUM main/*;*/INTO '"+${quotedOutside}+"'",
        "SELECT load_extension('"+${quotedOutside}+"')"]) {
        assert.throws(()=>db.exec(sql),/containment/); assert.throws(()=>db.prepare(sql),/containment/);
      }
      for(const file of [${quotedOutside},${JSON.stringify(path.join(root,'escape-link','escape'))},uri])
        await assert.rejects(async()=>sqliteBackup(db,file),/containment/);
      assert.throws(()=>db.loadExtension(${quotedOutside}),/containment/);
      assert.throws(()=>db.enableLoadExtension(true),/containment/);
      assert.throws(()=>new SqliteDatabase(':memory:',{allowExtension:true}),/containment/);
    } finally { db.close(); }`));
  probe('direct better-sqlite3 and cached addon handles retain pre-native containment', () => good(`
    import assert from 'node:assert/strict'; import {createRequire} from 'node:module'; import path from 'node:path';
    import {pathToFileURL} from 'node:url';
    const require=createRequire(${JSON.stringify(path.join(repo,'package.json'))});
    const Database=require('better-sqlite3');
    const nativeFile=path.join(${JSON.stringify(repo)},'node_modules/better-sqlite3/build/Release/bosun_sqlite.node');
    const addon=require(nativeFile);
    const uri=pathToFileURL(${quotedOutside}).href+'?immutable=1&mode=ro';
    for(const file of [${quotedOutside},${quotedOutside}+'  ',${JSON.stringify(path.join(root,'escape-link','escape'))},uri])
      for(const readonly of [true,false]) assert.throws(()=>new Database(file,{readonly}),/containment/);
    assert.throws(()=>new Database(':memory:',{nativeBinding:{}}),/containment/);
    assert.throws(()=>new Database(':memory:',{nativeBinding:${quotedOutside}}),/containment/);
    assert.throws(()=>process.dlopen({exports:{}},${quotedOutside}),/containment/);
    assert.throws(()=>process.dlopen({exports:{}},nativeFile),/containment/);
    assert.throws(()=>new addon.Database(${quotedOutside},${quotedOutside},false,false,false,0,null,null),/containment/);
    const db=new Database(':memory:',{nativeBinding:addon});
    const cppdb=require(path.join(path.dirname(require.resolve('better-sqlite3')),'util')).cppdb;
    try {
      for(const target of [db,db[cppdb]]) {
        for(const sql of ["ATTACH DATABASE '"+${quotedOutside}+"' AS escaped","VACUUM main/**/INTO '"+${quotedOutside}+"'",
          "SELECT '--'; ATTACH DATABASE '"+${quotedOutside}+"' AS escaped","SELECT '/*'; VACUUM main/*;*/INTO '"+${quotedOutside}+"'",
          "SELECT load_extension('"+${quotedOutside}+"')"]) {
          assert.throws(()=>target.exec(sql),/containment/); assert.throws(()=>target.prepare(sql),/containment/);
        }
        assert.throws(()=>target.loadExtension(${quotedOutside}),/containment/);
        assert.throws(()=>target.setConnectionControls(true,true,false),/containment/);
      }
      for(const file of [${quotedOutside},${quotedOutside}+'  ',uri])
        assert.throws(()=>db.backup(file),/containment/);
      assert.throws(()=>db[cppdb].backup(db,'main',${quotedOutside},false),/containment/);
      assert.throws(()=>db[cppdb].backup(db,'main',uri,false),/containment/);
    } finally { db.close(); }`));
  const constructorFile = path.join(root, 'constructor-open.db');
  probe('prototype and instance SQLite constructors preserve guarded identities before native opens', () => good(`
    import assert from 'node:assert/strict'; import {createRequire} from 'node:module'; import path from 'node:path';
    import {pathToFileURL} from 'node:url';
    const require=createRequire(${JSON.stringify(path.join(repo,'package.json'))});
    const entry=require.resolve('better-sqlite3'),Database=require(entry);
    const nativeFile=path.join(${JSON.stringify(repo)},'node_modules/better-sqlite3/build/Release/bosun_sqlite.node');
    const addon=require(nativeFile),cppdb=require(path.join(path.dirname(entry),'util')).cppdb;
    const db=new Database(':memory:');
    try {
      assert.equal(Database.prototype.constructor,Database);
      assert.equal(db.constructor,Database);
      assert.equal(addon.Database.prototype.constructor,addon.Database);
      assert.equal(db[cppdb].constructor,addon.Database);
      assert.ok(db instanceof Database); assert.ok(db[cppdb] instanceof addon.Database);
      assert.equal(db.exec('CREATE TABLE guarded (value); INSERT INTO guarded VALUES (42)'),db);
      assert.equal(db.prepare('SELECT value FROM guarded').get().value,42);
      for(const ctor of [Database,Database.prototype.constructor,db.constructor,require.cache[entry].exports.prototype.constructor]) {
        assert.equal(ctor,Database);
        assert.throws(()=>new ctor(':memory:',{allowExtension:true}),/containment/);
        assert.throws(()=>new ctor(${quotedOutside}),/containment/);
        assert.throws(()=>new ctor(pathToFileURL(${JSON.stringify(constructorFile)}).href+'?mode=rwc&vfs=unix-none'),/containment/);
        const safe=ctor(':memory:'); assert.ok(safe instanceof Database); safe.close();
      }
      for(const ctor of [addon.Database,addon.Database.prototype.constructor,db[cppdb].constructor,
        Object.getPrototypeOf(db[cppdb]).constructor,require.cache[nativeFile].exports.Database,
        require.cache[nativeFile].exports.Database.prototype.constructor]) {
        assert.equal(ctor,addon.Database);
        for(const file of [${quotedOutside},${JSON.stringify(path.join(root,'escape-link','constructor.db'))},
          pathToFileURL(${JSON.stringify(constructorFile)}).href+'?mode=rwc&vfs=unix-none',
          pathToFileURL(${JSON.stringify(constructorFile)}).href+'?immutable=1&mode=ro&vfs=unix-none'])
          for(const readonly of [false,true])
            assert.throws(()=>new ctor(file,file,false,readonly,false,0,null,null),/containment/);
        const safe=new ctor(':memory:',':memory:',true,false,false,0,null,null);
        try {
          assert.ok(safe instanceof addon.Database);
          safe.exec('CREATE TABLE guarded (value)');
          assert.throws(()=>safe.loadExtension(${quotedOutside}),/containment/);
          assert.throws(()=>safe.setConnectionControls(true,true,false),/containment/);
        } finally {safe.close();}
      }
      class Derived extends Database {}
      const derived=new Derived(':memory:'); assert.ok(derived instanceof Derived); assert.ok(derived instanceof Database); derived.close();
    } finally {db.close();}`));
  assert.equal(fs.existsSync(constructorFile), false, 'rejected constructor URIs must not reach a native file open');
  probe('real credential/config reads fail', () => good(`
    import assert from 'node:assert/strict'; import fs from 'node:fs';
    assert.throws(()=>fs.readFileSync(${JSON.stringify(path.join(outside, '.claude', '.credentials.json'))}),/containment/);`));
  probe('git and plutil external/config mutations fail', () => good(`
    import assert from 'node:assert/strict'; import {spawnSync} from 'node:child_process';
    for (const args of [['--git-dir=${outside}'],['-C${outside}','status'],['-c','core.hooksPath=${outside}','status'],['clone','https://example.com/a'],['config','--file=${outside}/config','x.y','z'],['init','../../../../escape'],['init','--separate-git-dir=${outside}/git'],['worktree','add','${outside}/escape'],['worktree','remove','${outside}/escape'],['config','--local','core.fsmonitor','evil']]) assert.throws(()=>spawnSync('git',args),/containment/);
    import fs from 'node:fs'; import path from 'node:path';
    assert.ok(fs.statSync(${JSON.stringify(GIT_REAL)}).isFile());
    assert.throws(()=>fs.readFileSync(${JSON.stringify(GIT_REAL)}),/containment/);
    assert.throws(()=>fs.writeFileSync(${JSON.stringify(GIT_REAL)},'bad'),/containment/);
    const linked=path.join(process.cwd(),'escaped-git-pointer'); fs.mkdirSync(linked); fs.writeFileSync(path.join(linked,'.git'),'gitdir: ${outside}/git');
    assert.throws(()=>spawnSync('git',['worktree','add','owned'],{cwd:linked}),/containment/);
    assert.throws(()=>spawnSync('plutil',['-replace','Label','-string','bad',${quotedOutside}]),/containment/);`));
  probe('fetch external and unregistered loopback endpoints fail', () => good(`
    import assert from 'node:assert/strict';
    await assert.rejects(fetch('http://198.51.100.1:80'),/containment/);
    await assert.rejects(fetch('http://127.0.0.1:11434'),/containment/);`));
  probe('raw TCP, TLS, UDP and HTTP external attempts fail', () => good(`
    import assert from 'node:assert/strict'; import net from 'node:net'; import tls from 'node:tls'; import dgram from 'node:dgram'; import http from 'node:http';
    assert.throws(()=>net.connect({host:'198.51.100.1',port:80}),/containment/);
    assert.throws(()=>tls.connect({host:'198.51.100.1',port:443}),/containment/);
    assert.throws(()=>dgram.createSocket('udp4'),/containment/);
    assert.throws(()=>http.get('http://198.51.100.1'),/containment/);`));
  probe('registered ephemeral HTTP mocks remain usable', () => good(`
    import assert from 'node:assert/strict'; import http from 'node:http';
    const server=http.createServer((req,res)=>res.end('mock')); await new Promise(r=>server.listen(0,'127.0.0.1',r));
    const url='http://127.0.0.1:'+server.address().port;
    assert.equal(await (await fetch(url)).text(),'mock');
    server.closeAllConnections(); await new Promise(r=>server.close(r));
    await assert.rejects(fetch(url),/containment/);`));
  const deniedPort = await denyDestination();
  const deniedSocket = await denyDestination(path.join(root, 'u'));
  const escapedSocket = await denyDestination(path.join(outside, 'u'));
  probe('HTTP and HTTPS validate merged URL/options destinations before native delegation', () => good(`
    import assert from 'node:assert/strict'; import http from 'node:http'; import https from 'node:https'; import net from 'node:net';
    const mock=http.createServer((req,res)=>res.end('registered'));
    await new Promise(r=>mock.listen(0,'127.0.0.1',r));
    const port=mock.address().port;
    try {
      for(const module of [http,https]) for(const method of ['request','get']) {
        const url=(module===https?'https:':'http:')+'//127.0.0.1:'+port+'/fixture';
        const callback=()=>assert.fail('rejected request callback must not run');
        for(const input of [url,new URL(url)]) {
          for(const override of [
            {port:${deniedPort}},
            {hostname:'localhost',port:${deniedPort}},
            {hostname:undefined,host:'127.0.0.1',port:${deniedPort}},
            {hostname:'198.51.100.1',port:${deniedPort}},
            {hostname:undefined,host:'198.51.100.1',port:${deniedPort}},
            {socketPath:${JSON.stringify(deniedSocket)}},
            {socketPath:${JSON.stringify(escapedSocket)}},
            {socketPath:${JSON.stringify(path.join(root,'escape-link','u'))}}
          ]) {
            assert.throws(()=>module[method](input,override),/containment/);
            assert.throws(()=>module[method](input,override,callback),/containment/);
          }
        }
        assert.throws(()=>module[method]({hostname:'127.0.0.1',port:${deniedPort}},callback),/containment/);
        assert.throws(()=>module[method]({socketPath:${JSON.stringify(deniedSocket)}},callback),/containment/);
        let hooks=0;
        for(const override of [
          {createConnection(){hooks++;}},
          {lookup(){hooks++;}},
          {agent:{addRequest(){hooks++;}}},
          {_defaultAgent:{addRequest(){hooks++;}}}
        ]) assert.throws(()=>module[method](url,override,callback),/containment/);
        assert.equal(hooks,0,'custom routing hooks must fail before invocation');
      }
      assert.throws(()=>net.connect({host:'127.0.0.1',port:${deniedPort}}),/containment/);
      assert.throws(()=>Bun.connect({hostname:'127.0.0.1',port}),/containment/);
      assert.throws(()=>Bun.connect({unix:${JSON.stringify(deniedSocket)}}),/containment/);
    } finally {mock.closeAllConnections();await new Promise(r=>mock.close(r));}`));
  // The listeners are real disposable destinations, not guessed live-service ports.
  // Let any forbidden connection events surface before asserting zero contact.
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(deniedCalls, 0, 'rejected HTTP options must never call a denied destination');
  await closeDeniedDestinations();
  probe('registered HTTP and HTTPS URL/options/callback and IPC mock signatures remain usable', () => good(`
    import assert from 'node:assert/strict'; import fs from 'node:fs'; import http from 'node:http'; import https from 'node:https';
    import {tlsFixture} from ${JSON.stringify(pathToFileURL(path.join(repo,'test/tls-fixture.ts')).href)};
    const fixture=tlsFixture(process.cwd()),ca=fs.readFileSync(fixture.certFile);
    const plain=http.createServer((req,res)=>res.end('plain'));
    const secure=https.createServer({key:fs.readFileSync(fixture.keyFile),cert:ca},(req,res)=>res.end('secure'));
    const ipc=http.createServer((req,res)=>res.end('ipc')),socket=${JSON.stringify(path.join(root,'h'))};
    await new Promise(r=>plain.listen(0,'127.0.0.1',r));
    await new Promise(r=>secure.listen(0,'127.0.0.1',r));
    await new Promise(r=>ipc.listen(socket,r));
    async function response(module,method,args) {
      return await new Promise((resolve,reject)=>{
        const req=module[method](...args,res=>{
          assert.throws(()=>Bun.spawnSync({cmd:['true']}),/containment/);
          assert.throws(()=>Bun.connect({hostname:'127.0.0.1',port:plain.address().port}),/containment/);
          let text='';res.on('data',chunk=>text+=chunk);res.once('error',reject);res.once('end',()=>resolve(text));
        });
        req.once('error',reject);if(method==='request') req.end();
      });
    }
    try {
      for(const [module,server,text] of [[http,plain,'plain'],[https,secure,'secure']]) {
        const port=server.address().port,protocol=module===https?'https:':'http:',url=protocol+'//127.0.0.1:'+port+'/fixture';
        const options=module===https?{ca}:{};
        for(const method of ['request','get']) {
          if(module===http) {
            assert.equal(await response(module,method,[url]),text);
            assert.equal(await response(module,method,[new URL(url)]),text);
          }
          assert.equal(await response(module,method,[{hostname:'127.0.0.1',port,path:'/fixture',...options}]),text);
          assert.equal(await response(module,method,[url,options]),text);
          assert.equal(await response(module,method,[new URL(url),{...options,agent:false}]),text);
          assert.equal(await response(module,method,[protocol+'//198.51.100.1:1',{...options,hostname:'127.0.0.1',port}]),text);
          assert.equal(await response(module,method,[url,{...options,hostname:undefined,host:'127.0.0.1',port}]),text);
        }
      }
      for(const method of ['request','get']) {
        assert.equal(await response(http,method,[{socketPath:socket,path:'/fixture'}]),'ipc');
        assert.equal(await response(http,method,['http://198.51.100.1:1',{socketPath:socket,path:'/fixture'}]),'ipc');
      }
    } finally {
      for(const server of [plain,secure,ipc]) {server.closeAllConnections();await new Promise(r=>server.close(r));}
    }`));
  probe('only registered synthetic local sockets can be connected', () => good(`
    import assert from 'node:assert/strict'; import fs from 'node:fs'; import path from 'node:path'; import net from 'node:net';
    assert.throws(()=>net.connect(${quotedOutside}),/containment/);
    assert.throws(()=>net.connect(${JSON.stringify(path.join(root, 'escape-link', 'socket'))}),/containment/);
    assert.throws(()=>net.connect(${JSON.stringify(path.join(root, 'unregistered.sock'))}),/containment/);
    const socket=${JSON.stringify(path.join(root, 's'))};
    const server=net.createServer(peer=>peer.end('mock')); await new Promise(r=>server.listen(socket,r));
    const content=await new Promise((resolve,reject)=>{let text=''; const peer=net.connect(socket); peer.on('data',chunk=>text+=chunk); peer.on('error',reject); peer.on('end',()=>resolve(text));});
    assert.equal(content,'mock'); await new Promise(r=>server.close(r));
    assert.throws(()=>net.connect(socket),/containment/);
    assert.throws(()=>net.createServer().listen(${quotedOutside}),/containment/);`));
  probe('Bun native HOME starts isolated and the fixture homedir getter follows HOME', () => good(`
    import assert from 'node:assert/strict'; import os from 'node:os'; import path from 'node:path';
    assert.equal(os.homedir(), process.env.HOME);
    process.env.HOME=path.join(process.env.HOME,'changed'); assert.equal(os.homedir(),process.env.HOME);`));
  probe('native Bun file, process, socket and worker escape surfaces are blocked', () => good(`
    import assert from 'node:assert/strict'; import {Worker} from 'node:worker_threads';
    assert.throws(()=>Bun.file(${quotedOutside}),/containment/);
    assert.throws(()=>Bun.write(${quotedOutside},'bad'),/containment/);
    for(const name of ['spawn','spawnSync','connect','listen','serve','udpSocket','dlopen']) assert.throws(()=>Bun[name]({}),/containment/);
    assert.throws(()=>new Worker('not-imported'),/containment/);
    assert.throws(()=>new WebSocket('ws://127.0.0.1:11434'),/containment/);`));
  probe('native fetch cannot follow a registered mock redirect into a real service', () => good(`
    import assert from 'node:assert/strict'; import http from 'node:http';
    const server=http.createServer((req,res)=>{res.writeHead(302,{location:'http://127.0.0.1:11434'});res.end();});
    await new Promise(r=>server.listen(0,'127.0.0.1',r)); const url='http://127.0.0.1:'+server.address().port;
    await assert.rejects(fetch(url)); assert.equal((await fetch(url,{redirect:'manual'})).status,302);
    server.closeAllConnections(); await new Promise(r=>server.close(r));`));
  probe('OS barrier contains native files and SQLite even without the JS preload', () => {
    const r = launch(root, ['-e', `
      import assert from 'node:assert/strict'; import {DatabaseSync} from 'node:sqlite';
      await assert.rejects(Bun.write(${quotedOutside},'bad'));
      await assert.rejects(Bun.file(${JSON.stringify(path.join(outside,'read-sentinel'))}).text());
      assert.throws(()=>new DatabaseSync(${quotedOutside}));
    `], { guarded: false, cwd, env, encoding: 'utf8', timeout: 10000 });
    assert.equal(r.status, 0, r.stderr);
  });
  probe('OS process barrier refuses an external shell even without the JS preload', () => {
    const r=launch(root,['-e', `import assert from 'node:assert/strict';
      assert.throws(()=>Bun.spawnSync(['/bin/sh','-c','exit 0']),error=>error.code==='EPERM');`],{guarded:false,cwd,env,encoding:'utf8',timeout:10000});
    assert.equal(r.status,0,r.stderr);
  });
  probe('fixture shebangs execute only Bun with explicit preloads, never env/node', () => {
    const file=path.join(root,'stub');
    fs.writeFileSync(file, `#!/usr/bin/env node\nconst assert=require('node:assert/strict'); assert.equal(process.versions.bun,'1.4.3'); assert.ok(globalThis[Symbol.for('bosun.test.guard')]);`, {mode:0o700});
    good(`import assert from 'node:assert/strict'; import fs from 'node:fs'; import {spawnSync} from 'node:child_process';
      assert.ok(fs.statSync(${JSON.stringify(file)}).isFile()); fs.accessSync(${JSON.stringify(file)},fs.constants.X_OK);
      const r=spawnSync(${JSON.stringify(file)},[],{encoding:'utf8'}); assert.equal(r.status,0,r.stderr);`);
  });
  probe('preload, dotenv, install and injected runtime startup options cannot bypass child guard', () => good(`
    import assert from 'node:assert/strict'; import {spawnSync} from 'node:child_process';
    for(const args of [['--preload','foreign'],['--env-file','foreign'],['install'],['x','foreign']]) assert.throws(()=>spawnSync(process.execPath,args),/containment/);
    for(const key of ['BUN_OPTIONS','BUN_CONFIG','NODE_OPTIONS']) assert.throws(()=>spawnSync(process.execPath,['-e',''],{env:{...process.env,[key]:'foreign'}}),/containment/);`));
  probe('Bun node:test compatibility preserves serial async assertions and failing exits', () => {
    const file=path.join(root,'runner.test.mjs');
    fs.writeFileSync(file, `import test from 'node:test'; import assert from 'node:assert/strict';
      let value=0; test('awaited',async()=>{await new Promise(r=>setTimeout(r,20));value=1;assert.equal(value,1)});
      test('serial',()=>assert.equal(value,1));`);
    const good=launch(root,['test','--timeout','1000',file],{cwd,env,encoding:'utf8',timeout:10000});
    assert.equal(good.status,0,good.stderr); assert.match(good.stderr,/2 pass/);
    fs.writeFileSync(file, `import test from 'node:test'; import assert from 'node:assert/strict';test('intentional failure',()=>assert.fail('synthetic failure'));`);
    const bad=launch(root,['test','--timeout','1000',file],{cwd,env,encoding:'utf8',timeout:10000});
    assert.equal(bad.status,1,bad.stderr); assert.match(bad.stderr,/1 fail/);
    fs.writeFileSync(file, `import test from 'node:test';test('timeout',async()=>new Promise(()=>{}));`);
    const timeout=launch(root,['test','--timeout','30',file],{cwd,env,encoding:'utf8',timeout:10000});
    assert.equal(timeout.status,1,timeout.stderr); assert.match(timeout.stderr,/timed out/);
  });
  probe('unknown suites/options and prohibited runtimes fail closed', () => {
    for (const args of [['--suite','not-implemented'],['--suite','unit'],['--suite','core,not-implemented'],['--runtime','node'],['--runtime','unknown'],['--unknown']]) {
      const r=spawnSync(process.execPath,[path.join(repo,'scripts/run-tests.mjs'),...args],{cwd:repo,env:{PATH:path.dirname(process.execPath)},encoding:'utf8'});
      assert.equal(r.status,2,r.stderr);
    }
  });
  assert.deepEqual(fs.readdirSync(outside), ['read-sentinel'], 'negative probes must not add outside files');
  assert.equal(fs.readFileSync(path.join(outside, 'read-sentinel'), 'utf8'), 'synthetic immutable sentinel', 'outside bytes must remain unchanged');
  console.log(`Containment: ${count}/${count} probes passed; application suites not imported.`);
} finally {
  await closeDeniedDestinations();
  fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true });
}
