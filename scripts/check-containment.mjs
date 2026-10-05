// Synthetic negative proofs only. No application imports or real host discovery in this driver.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const { environment, PRELOAD, ROOT_KEYS } = createRequire(import.meta.url)('./test-env.cjs');
const repo = path.resolve(import.meta.dirname, '..');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bosun-containment-')));
const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bosun-outside-sentinel-')));
const cwd = path.join(root, 'work'); fs.mkdirSync(cwd);
const env = environment(path.join(root, 'fixture'), root);
const entry = path.join(root, 'entry.mjs');
const sentinel = path.join(root, 'import-sentinel');
fs.writeFileSync(entry, `import ${JSON.stringify(pathToFileURL(path.join(repo, 'test/bootstrap.ts')).href)};
import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(sentinel)}, 'evaluated');
await import(${JSON.stringify(pathToFileURL(path.join(repo, 'lib/config.ts')).href)});`);
let count = 0;
function probe(name, fn) { fn(); count++; console.log(`ok ${count} - ${name}`); }
function run(source, extra = {}) {
  return spawnSync(process.execPath, ['--require', PRELOAD, '--input-type=module', '-e', source], {
    cwd, env: { ...env, ...extra }, encoding: 'utf8', timeout: 15000,
  });
}
function good(source) { const r = run(source); assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`); }
const quotedOutside = JSON.stringify(path.join(outside, 'escape'));
function blockedBeforeImport(extra, preload = true) {
  fs.rmSync(sentinel, { force: true });
  const r = spawnSync(process.execPath, [...(preload ? ['--require', PRELOAD] : []), entry], {
    cwd, env: { ...env, NODE_OPTIONS: '', ...extra }, encoding: 'utf8', timeout: 10000,
  });
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /containment|require scripts\/run-tests/);
  assert.equal(fs.existsSync(sentinel), false, 'entry/application import sentinel must remain absent');
}
try {
  probe('missing HOME fails before application evaluation', () => blockedBeforeImport({ HOME: '' }));
  probe('outside HOME fails before application evaluation', () => blockedBeforeImport({ HOME: outside }));
  fs.symlinkSync(outside, path.join(root, 'escape-link'));
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
  probe('outside SQLite opens and attached databases fail', () => good(`
    import assert from 'node:assert/strict'; import {DatabaseSync,backup} from 'node:sqlite';
    assert.throws(()=>new DatabaseSync(${quotedOutside}),/containment/);
    const db=new DatabaseSync(':memory:');
    assert.throws(()=>db.exec('ATTACH DATABASE '+JSON.stringify(${quotedOutside})+' AS escaped'),/containment/);
    assert.throws(()=>backup(db,${quotedOutside}),/containment/);
    assert.throws(()=>new DatabaseSync(':memory:',{allowExtension:true}),/containment/); db.close();`));
  probe('real credential/config reads fail', () => good(`
    import assert from 'node:assert/strict'; import fs from 'node:fs';
    assert.throws(()=>fs.readFileSync(${JSON.stringify(path.join(outside, '.claude', '.credentials.json'))}),/containment/);`));
  probe('git and plutil external/config mutations fail', () => good(`
    import assert from 'node:assert/strict'; import {spawnSync} from 'node:child_process';
    for (const args of [['--git-dir=${outside}'],['-C${outside}','status'],['-c','core.hooksPath=${outside}','status'],['clone','https://example.com/a'],['config','--file=${outside}/config','x.y','z'],['init','../../../../escape'],['init','--separate-git-dir=${outside}/git']]) assert.throws(()=>spawnSync('git',args),/containment/);
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
  probe('unknown suites/options and prohibited runtimes fail closed', () => {
    for (const args of [['--suite','not-implemented'],['--suite','unit'],['--suite','core,not-implemented'],['--runtime','bun'],['--runtime','unknown'],['--unknown']]) {
      const r=spawnSync(process.execPath,[path.join(repo,'scripts/run-tests.mjs'),...args],{cwd:repo,env:{PATH:path.dirname(process.execPath)},encoding:'utf8'});
      assert.equal(r.status,2,r.stderr);
    }
  });
  assert.deepEqual(fs.readdirSync(outside), [], 'negative probes must leave outside sentinel directory untouched');
  console.log(`Containment: ${count}/${count} probes passed; application suites not imported.`);
} finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
