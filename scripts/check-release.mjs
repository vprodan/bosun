// Fresh local-release qualification. No historical compiled proposal is executed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifyDistribution } from './distribution.mjs';
import { prepareIsolation, isolatedConfig, processProbe, foregroundDaemon, runSqliteRequests, currentRpc } from './check-compiled-current.mjs';
import { renderRuntimeConfig } from '../src/platform/config.ts';
import { streamProcess } from '../src/platform/process.ts';
if (process.versions.bun !== '1.4.3' || process.platform !== 'darwin' || process.arch !== 'arm64') throw Error('Release qualification requires pinned Bun on macOS arm64');
const [artifact, ...extra] = process.argv.slice(2);
if (!artifact || extra.length) throw Error('Usage: sh scripts/bun-check.sh release-check <artifact-directory>');
const verified = verifyDistribution(path.resolve(artifact));
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bosun-release-')));
fs.chmodSync(root, 0o700);
const binary = path.join(root, 'bosun');
fs.copyFileSync(path.join(path.resolve(artifact), 'bosun'), binary); fs.chmodSync(binary, 0o700);
assert.equal(crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex'), verified.binarySha256);
const profile = path.join(root, 'release.sb');
fs.writeFileSync(profile, `(version 1)
(allow default)
(deny file-read-data (require-all (require-any (subpath "/Users") (subpath "/private/var/folders") (subpath "/private/tmp")) (require-not (subpath ${JSON.stringify(root)}))))
(deny file-write* (require-not (require-any (subpath ${JSON.stringify(root)}) (literal "/dev/null"))))
(deny process-exec (require-not (literal ${JSON.stringify(binary)})))
(deny network*)
(allow network-outbound (remote unix-socket (subpath ${JSON.stringify(root)})))
(allow network-bind (local unix-socket (subpath ${JSON.stringify(root)})))
`, {mode:0o600});
const checks = []; let daemon; let stage = 'entries'; let allJoined = true;
const execute = async function* (spec) {
  let joined = false;
  try { yield* streamProcess({...spec, command:'/usr/bin/sandbox-exec', args:['-f',profile,binary,...spec.args], onClosed(){joined=true;spec.onClosed?.();}}); }
  finally { allJoined &&= joined; }
};
const context = name => ({binary,...prepareIsolation(root,name)});
function passed(result) { assert.equal(result.receipt.joined,true); assert.equal(result.receipt.code,0); assert.equal(result.receipt.error,null); assert.equal(result.receipt.signal,null); }
try {
  for (const [name,args,input] of [['version',['--version'],''],['help',['--help'],''],['private-hook',['hook','--private'],'{invalid'],['private-route',['route','--hook','--private'],'{invalid']]) {
    stage=name;const r=await processProbe(context(name),args,{execute,input});passed(r);
    if(name==='version')assert.equal(r.text.trim(),verified.version);
    else if(name==='help')assert.match(r.text,/Usage: bosun/);
    else assert.equal(r.text,'');checks.push({name,passed:true});
  }
  stage='mcp';let writer,pending='',initialized=false;
  const r=await processProbe(context('mcp'),['mcp'],{execute,stdin(channel){writer=channel;void channel.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'release-check',version:'1'}}})+'\n');},stdout(chunk){pending+=chunk.toString();const end=pending.indexOf('\n');if(end<0)return;const reply=JSON.parse(pending.slice(0,end));assert.equal(reply.id,1);assert.equal(reply.result.serverInfo.version,verified.version);initialized=true;pending=pending.slice(end+1);writer.end();}});
  passed(r);assert.equal(initialized,true);assert.equal(pending.trim(),'');checks.push({name:stage,passed:true});
  const ctx=context('runtime');stage='setup';passed(await processProbe(ctx,['setup'],{execute}));
  fs.writeFileSync(path.join(ctx.runtime,'config.toml'),renderRuntimeConfig(isolatedConfig(ctx.home)),{mode:0o600});
  stage='storage-privacy';daemon=foregroundDaemon(ctx,{execute});await daemon.ready();let sequence=0;
  checks.push({name:stage,...await runSqliteRequests((audience,method,params,invalid=false)=>currentRpc(ctx.socket,ctx.cwd,audience,method,params,++sequence,invalid)),passed:true});
  stage='shutdown';const stop=await daemon.close();daemon=undefined;assert.equal(stop.joined,true);assert.equal(stop.controlledCancellation,true);assert.equal(fs.existsSync(ctx.socket),false);
  stage='reacquire';daemon=foregroundDaemon(ctx,{execute});await daemon.ready();await currentRpc(ctx.socket,ctx.cwd,'owner','daemon.status',{},++sequence);const second=await daemon.close();daemon=undefined;assert.equal(second.joined,true);assert.equal(second.controlledCancellation,true);checks.push({name:'shutdown-and-reacquire',passed:true});
  stage='public-hook';const bench=await processProbe(context('benchmark'),['memory','bench','--n','10000','--public-view'],{execute,timeoutMs:120000});passed(bench);const report=JSON.parse(bench.text);
  assert.equal(report.corpus.notes,10000);assert.equal(report.store.samples,10000);assert.equal(report.hook.firstRun.outcome,'injected');assert.equal(report.hook.outcomes.injected,20);assert.equal(report.hook.processCompletion,'original-and-group-confirmed');assert.equal(report.modelsCalled,false);checks.push({name:stage,notes:10000,injections:21,passed:true});
  assert.equal(allJoined,true);console.log(JSON.stringify({version:verified.version,binarySha256:verified.binarySha256,scope:'compiled-local-release-safety',checks,allJoined,liveHosts:false,liveModels:false,personalActivation:false},null,2));
} catch(error) { console.error(JSON.stringify({stage,failed:true,message:error instanceof Error?error.message:'Qualification failed',checks}));process.exitCode=1; }
finally { if(daemon)await daemon.close();if(allJoined)fs.rmSync(root,{recursive:true,force:true}); }
