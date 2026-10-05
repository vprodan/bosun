import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { sandbox, fresh, gitRepo, mock, BIN, REPO, type Sandbox } from './helpers.ts';
import { load, P } from '../lib/config.ts';
import { MemoryService } from '../lib/memory/service.ts';
import { openDb } from '../lib/memory/sqlite.ts';
import { makeCtx, project } from '../lib/memory/project.ts';

const MARKER = 'MODEL-LEASE-CANARY';
const PROMPT = 'rename getCart to fetchCart in cart service';
const DECISION = { model: 'kev-latest', latency_ms: 12, answers: {
  lane: { type: 'choice', choice: 'local', confidence: 0.9 }, risk: { type: 'choice', choice: 'low', confidence: 0.9 } } };
const tick = (ms = 20) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const POSIX = { skip: process.platform === 'win32' ? 'native stdout lease qualification is POSIX only' : false };
async function fixture(sb: Sandbox) {
  fresh(sb);
  const repo = gitRepo(sb, 'lease', 'git@github.com:org/lease.git');
  const writer = new MemoryService(openDb(P.DB), load());
  const ctx = makeCtx(load(), project(repo));
  const memory = (await writer.store({ category: 'project', title: 'Cart lease', body: `${PROMPT}; ${MARKER}` }, ctx)).memory;
  writer.db.exec('PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=0;'); // explicit rollback fixture; existing writer stays open
  return { repo, writer, ctx, memory };
}

// Drives the real route main with real stdin/stdout and native SQLite, using an independent stdout gate.
// No production module imports this fixture; it records no content in IPC, only lifecycle phases.
function hook(sb: Sandbox, repo: string, url: string, mode = 'gate', fileFd?: number, env: Record<string, string> = {}) {
  const script = path.join(sb.root, `hook-${mode}.mjs`);
  fs.writeFileSync(script, `
await import(${JSON.stringify(path.join(REPO, 'test/bootstrap.ts'))});
const mode=${JSON.stringify(mode)};
const nativeWrite=process.stdout.write.bind(process.stdout);
const send=(phase,extra={})=>process.send?.({phase,...extra});
let pending; let intercepted=false;
process.stdout.write=function(chunk,encoding,callback){
  if(typeof encoding==='function'){callback=encoding;encoding=undefined;}
  if(!intercepted && String(chunk).includes('"hookSpecificOutput"')){
    intercepted=true; pending={chunk,encoding,callback}; send('queued');
    if(mode==='stall'){const until=Date.now()+1250;while(Date.now()<until){};return nativeWrite(chunk,encoding,callback);}
    if(mode!=='backpressure') return false;
  }
  return nativeWrite(chunk,encoding,callback);
};
if(mode==='backpressure') nativeWrite(Buffer.alloc(2*1024*1024,120)); // actual OS pipe backpressure, no fixture callback gate
if(mode==='noclose') process.stdout.destroy=function(){send('cancel-requested');return this;}; // qualify conservative forced teardown
process.on('message',(command)=>{
  if(command==='quit'){process.exit(0);return;}
  if(command==='flush'){
    const p=pending; nativeWrite(p.chunk,p.encoding,(error)=>{p.callback?.(error);});
  }
  if(command==='fail') pending.callback?.(new Error('synthetic stdout failure'));
  if(command==='late'){
    const p=pending; nativeWrite(p.chunk,p.encoding,(error)=>send('late',{failed:!!error}));
  }
});
const {main}=await import(${JSON.stringify(path.join(REPO, 'lib/route.ts'))});
const {load}=await import(${JSON.stringify(path.join(REPO, 'lib/config.ts'))});
const code=await main(['--hook','--host','claude'],load());
send('returned',{code}); // process remains alive: proves release by caller, not only OS teardown
`);
  const p = spawn(process.execPath, [script], { env: sb.env({ ROUTER_URL: url, ...env }), cwd: repo, stdio: ['pipe', fileFd ?? 'pipe', 'pipe', 'ipc'] });
  const phases: any[] = [];
  const waiters: { phase: string; resolve: (m: any) => void }[] = [];
  let out = ''; let err = '';
  p.stdout?.on('data', (chunk) => { out += chunk; });
  if (mode === 'backpressure') p.stdout?.pause();
  p.stderr?.on('data', (chunk) => { err += chunk; });
  p.on('message', (m: any) => { phases.push(m); for (const w of [...waiters]) if (m.phase === w.phase) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); } });
  const exited = new Promise<number | null>((resolve) => p.once('exit', (code) => resolve(code)));
  const closed = new Promise<number | null>((resolve) => p.once('close', (code) => resolve(code)));
  p.stdin!.end(JSON.stringify({ prompt: PROMPT }));
  const phase = (name: string) => Promise.race([
    phases.find((m) => m.phase === name) ? Promise.resolve(phases.find((m) => m.phase === name)) : new Promise<any>((resolve) => waiters.push({ phase: name, resolve })),
    exited.then(() => { throw Error(`hook exited before ${name}: ${err}`); }),
  ]);
  return { p, phase, exited, closed, output: () => out, stderr: () => err,
    stop: async () => { if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL'); p.stdout?.resume(); await closed; } };
}
const hooks = () => fs.existsSync(path.join(P.BOSUN, 'metrics.jsonl')) ? fs.readFileSync(path.join(P.BOSUN, 'metrics.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line)).filter((m) => m.op === 'hook') : [];

test('actual local hook keeps the rollback connection lock through native write callback, then releases while still alive', POSIX, async () => {
  const sb = sandbox(); const router = await mock();
  let child: ReturnType<typeof hook> | undefined;
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    f = await fixture(sb);
    child = hook(sb, f.repo, router.url);
    await child.phase('queued');
    assert.equal(child.output(), '', 'fixture has not accepted output yet');
    await assert.rejects(f.writer.update(f.memory.id, { private: true }, 1, f.ctx), (e: any) => e.errcode === 5, 'native existing writer cannot commit privatization before handoff');
    assert.equal((await f.writer.get(f.memory.id, f.ctx)).private, false);
    child.p.send('flush'); await child.phase('returned');
    assert.equal(child.p.exitCode, null, 'caller cleanup is tested before process exit');
    await tick();
    const ctx = JSON.parse(child.output()).hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes(MARKER)); assert.match(ctx, /suggests: local/);
    assert.equal((await f.writer.update(f.memory.id, { private: true }, 1, f.ctx)).private, true);
    assert.equal(hooks().at(-1).n, 1);
    assert.equal(hooks().at(-1).ok, true);
  } finally { await child?.stop(); f?.writer.close(); await router.close(); sb.cleanup(); }
});

test('delayed router leaves no local lease: committed privatization is reflected before hook packing/output', POSIX, async () => {
  const sb = sandbox();
  let seen!: () => void; const observed = new Promise<void>((resolve) => { seen = resolve; });
  let resume!: () => void; const gate = new Promise<void>((resolve) => { resume = resolve; });
  const router = await mock({ '/v1/systemone': async () => { seen(); await gate; return { json: DECISION }; } });
  let child: ReturnType<typeof hook> | undefined; let f: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    f = await fixture(sb); child = hook(sb, f.repo, router.url);
    await observed;
    await tick(30); // allow the old parallel memory path to have packed/closed; router remains blocked independently
    assert.equal((await f.writer.update(f.memory.id, { private: true }, 1, f.ctx)).private, true);
    resume(); await child.phase('queued'); child.p.send('flush'); await child.phase('returned'); await tick();
    assert.doesNotMatch(child.output(), /MODEL-LEASE-CANARY|bosun memory/);
    assert.match(JSON.parse(child.output()).hookSpecificOutput.additionalContext, /suggests: local/);
    assert.equal(hooks().at(-1).n, 0);
  } finally { resume(); await child?.stop(); f?.writer.close(); await router.close(); sb.cleanup(); }
});

test('failed write and signal cancellation tear down the one-shot process before release; no cached frame can flush later', POSIX, async () => {
  for (const cause of ['fail', 'signal']) {
    const sb = sandbox(); const router = await mock();
    let child: ReturnType<typeof hook> | undefined; let f: Awaited<ReturnType<typeof fixture>> | undefined;
    try {
      f = await fixture(sb); child = hook(sb, f.repo, router.url);
      await child.phase('queued');
      await assert.rejects(f.writer.update(f.memory.id, { private: true }, 1, f.ctx), (e: any) => e.errcode === 5);
      if (cause === 'fail') child.p.send('fail'); else child.p.kill('SIGTERM');
      assert.equal(await child.exited, 0);
      assert.equal((await f.writer.update(f.memory.id, { private: true }, 1, f.ctx)).private, true);
      await child.closed; assert.equal(child.output(), ''); assert.doesNotMatch(child.stderr(), /MODEL-LEASE-CANARY|Unhandled|synthetic stdout failure/);
      assert.equal(child.p.connected, false, 'terminated producer cannot receive a late-flush command');
      assert.equal(hooks().length, 0, 'forced exit has no false delivery completion metric');
    } finally { await child?.stop(); f?.writer.close(); await router.close(); sb.cleanup(); }
  }
});

test('actual OS pipe backpressure cancels delivery without a late frame, then releases the native writer lock', POSIX, async () => {
  const sb = sandbox(); const router = await mock();
  let child: ReturnType<typeof hook> | undefined; let f: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    f = await fixture(sb); child = hook(sb, f.repo, router.url, 'backpressure');
    await child.phase('queued');
    await assert.rejects(f.writer.update(f.memory.id, { private: true }, 1, f.ctx), (e: any) => e.errcode === 5);
    assert.equal(await child.exited, 0);
    assert.equal((await f.writer.update(f.memory.id, { private: true }, 1, f.ctx)).private, true);
    child.p.stdout!.resume(); await child.closed;
    assert.equal(/MODEL-LEASE-CANARY|hookSpecificOutput/.test(child.output()), false, 'no memory bytes arrive after releasing the failed producer');
    assert.ok(hooks().length === 0 || hooks().at(-1).n === 0, 'teardown/cancellation is never recorded as injection');
  } finally { await child?.stop(); f?.writer.close(); await router.close(); sb.cleanup(); }
});

test('unconfirmed stdout cancellation retains the lease until one-shot process teardown', POSIX, async () => {
  const sb = sandbox(); const router = await mock();
  let child: ReturnType<typeof hook> | undefined; let f: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    f = await fixture(sb); child = hook(sb, f.repo, router.url, 'noclose');
    await child.phase('queued');
    await assert.rejects(f.writer.update(f.memory.id, { private: true }, 1, f.ctx), (e: any) => e.errcode === 5);
    assert.equal(await child.exited, 0);
    assert.equal((await f.writer.update(f.memory.id, { private: true }, 1, f.ctx)).private, true);
    await child.closed; assert.equal(child.output(), ''); assert.equal(hooks().length, 0, 'forced exit produces no false completion metric');
  } finally { await child?.stop(); f?.writer.close(); await router.close(); sb.cleanup(); }
});

test('regular-file stdout omits local memory before DB open; advisory output remains valid and records n0', POSIX, async () => {
  const sb = sandbox(); const router = await mock();
  let child: ReturnType<typeof hook> | undefined; let f: Awaited<ReturnType<typeof fixture>> | undefined; let fd: number | undefined;
  try {
    f = await fixture(sb);
    f.writer.db.exec('BEGIN EXCLUSIVE'); // attempted reader schema SQL would fail and produce hook.memory warning
    const output = path.join(sb.root, 'stdout.json'); fd = fs.openSync(output, 'w', 0o600);
    child = hook(sb, f.repo, router.url, 'gate', fd);
    await child.phase('queued'); f.writer.db.exec('ROLLBACK');
    assert.equal((await f.writer.update(f.memory.id, { private: true }, 1, f.ctx)).private, true);
    child.p.send('flush'); await child.phase('returned');
    const ctx = JSON.parse(fs.readFileSync(output, 'utf8')).hookSpecificOutput.additionalContext;
    assert.match(ctx, /suggests: local/); assert.doesNotMatch(ctx, /MODEL-LEASE-CANARY|bosun memory/);
    assert.equal(hooks().at(-1).n, 0);
    assert.doesNotMatch(fs.readFileSync(path.join(P.BOSUN, 'bosun.log'), 'utf8'), /hook\.memory/, 'unsupported sink opens no reader');
  } finally { await child?.stop(); if (f?.writer.db.isTransaction) f.writer.db.exec('ROLLBACK'); f?.writer.close(); if (fd !== undefined) fs.closeSync(fd); await router.close(); sb.cleanup(); }
});

test('real CLI native EPIPE is fail-open without late unhandled output errors and releases the rollback reader', POSIX, async () => {
  const sb = sandbox();
  let unblock!: () => void; const gate = new Promise<void>((resolve) => { unblock = resolve; });
  let seen!: () => void; const observed = new Promise<void>((resolve) => { seen = resolve; });
  const router = await mock({ '/v1/systemone': async () => { seen(); await gate; return { json: DECISION }; } });
  let f: Awaited<ReturnType<typeof fixture>> | undefined; let p: ReturnType<typeof spawn> | undefined;
  try {
    f = await fixture(sb);
    p = spawn(process.execPath, [BIN, 'route', '--hook'], { env: sb.env({ ROUTER_URL: router.url }), cwd: f.repo, stdio: ['pipe', 'pipe', 'pipe'] });
    let err = ''; p.stderr!.on('data', (chunk) => { err += chunk; });
    const closed = new Promise<number | null>((resolve) => p!.once('close', (code) => resolve(code)));
    p.stdin!.end(JSON.stringify({ prompt: PROMPT })); await observed;
    p.stdout!.destroy(); unblock();
    assert.equal(await closed, 0);
    assert.doesNotMatch(err, /EPIPE|Unhandled|MODEL-LEASE-CANARY/);
    assert.equal((await f.writer.update(f.memory.id, { private: true }, 1, f.ctx)).private, true);
    assert.ok(hooks().length === 0 || hooks().at(-1).n === 0);
  } finally { unblock(); if (p?.exitCode === null && p.signalCode === null) p.kill('SIGKILL'); f?.writer.close(); await router.close(); sb.cleanup(); }
});

test('oversized UTF-8 memory is discarded and its lock released before advisory handoff, with truthful n0', POSIX, async () => {
  const sb = sandbox(); const router = await mock();
  let child: ReturnType<typeof hook> | undefined; let f: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    f = await fixture(sb);
    for (const [i, character] of ['漢', '語', '文'].entries()) await f.writer.store({ category: 'project', title: `Large cart ${i}`,
      body: `${PROMPT} large${i} alpha${i} beta${i} gamma${i} ${character.repeat(3000)}` }, f.ctx);
    child = hook(sb, f.repo, router.url, 'gate', undefined, { CONTEXT_HOOK_BUDGET: '4000', CONTEXT_ITEM_CHARS: '4000', CONTEXT_HOOK_MIN_SCORE: '0' });
    await child.phase('queued');
    assert.equal((await f.writer.update(f.memory.id, { private: true }, 1, f.ctx)).private, true, 'oversize drop already released the lease before hint delivery');
    child.p.send('flush'); await child.phase('returned'); await tick();
    const ctx = JSON.parse(child.output()).hookSpecificOutput.additionalContext;
    assert.match(ctx, /suggests: local/); assert.doesNotMatch(ctx, /bosun memory|MODEL-LEASE-CANARY|Large cart|漢|語|文/);
    assert.equal(hooks().at(-1).n, 0); assert.equal(hooks().at(-1).ok, false);
  } finally { await child?.stop(); f?.writer.close(); await router.close(); sb.cleanup(); }
});

test('actual rollback hook omits finite-expiry notes before packing through backpressure and event-loop stalls', POSIX, async () => {
  for (const mode of ['gate', 'backpressure', 'stall']) {
    const sb = sandbox(); const router = await mock();
    let child: ReturnType<typeof hook> | undefined; let f: Awaited<ReturnType<typeof fixture>> | undefined;
    try {
      f = await fixture(sb);
      const finite = (await f.writer.store({ category: 'session', title: 'Finite cart', body: `${PROMPT} FINITE-ROLLBACK-OMITTED-CANARY` }, f.ctx)).memory;
      f.writer.db.prepare('UPDATE memories SET expires_at=? WHERE id=?').run(Date.now()+1000, finite.id);
      child = hook(sb, f.repo, router.url, mode); await child.phase('queued');
      if (mode === 'gate') { child.p.send('flush'); await child.phase('returned'); }
      if (mode === 'stall') await child.phase('returned');
      if (mode === 'backpressure') { await child.exited; child.p.stdout!.resume(); await child.closed; }
      await tick(); assert.doesNotMatch(child.output(), /FINITE-ROLLBACK-OMITTED-CANARY/);
      if (mode !== 'backpressure') assert.match(child.output(), /MODEL-LEASE-CANARY/, 'non-expiring rollback notes retain useful delivery');
    } finally { await child?.stop(); f?.writer.close(); await router.close(); sb.cleanup(); }
  }
});
