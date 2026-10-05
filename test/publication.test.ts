import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { sandbox, fresh, gitRepo, bosun, REPO } from './helpers.ts';
import { load, P } from '../lib/config.ts';
import { MemoryService, openLocalMemory } from '../lib/memory/service.ts';
import { Docs } from '../lib/memory/docs.ts';
import { openDb, openLocalSqlite, writerPaths } from '../lib/memory/sqlite.ts';
import { MemoryError, type Ctx } from '../lib/memory/types.ts';
import { cutoverMemory, publishMemoryView, CutoverError } from '../src/adapters/memory/sqlite-cutover.ts';
import { footprint } from './read-view-prototype.ts';

const options = (paths: ReturnType<typeof writerPaths>) => ({ paths, now: Date.now, id: crypto.randomUUID });
const rows = (db: DatabaseSync, table: string) => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all();
async function fixture({ expired = true, floor = true } = {}) {
  const sb = sandbox(); fresh(sb); const cfg = load(); fs.chmodSync(P.BOSUN, 0o700);
  const paths = writerPaths(P.DB, cfg); fs.mkdirSync(path.dirname(paths.view), { mode: 0o700 }); fs.mkdirSync(paths.backups, { mode: 0o700 });
  const repo = gitRepo(sb, 'publication'); const ctx: Ctx = { projectId: 'p_a', sessionId: 's_a', linked: ['p_b'], source: 'public owner' };
  const db = openDb(paths.primary); const old = new MemoryService(db, cfg);
  const publicNote = (await old.store({ category: 'project', title: 'Admission zebra', body: 'Admission zebra public body', tags: ['zebra'], sourceRef: 'public reference' }, ctx)).memory;
  const personal = (await old.store({ category: 'personal', title: 'Personal zebra', body: 'Personal public zebra' }, ctx)).memory;
  const linked = (await old.store({ category: 'project', title: 'Linked zebra', body: 'Linked public zebra' }, { ...ctx, projectId: 'p_b' })).memory;
  const shared = (await old.store({ category: 'project', title: 'Shared zebra', body: 'Shared public zebra', shared: true }, { ...ctx, projectId: 'p_c' })).memory;
  const session = (await old.store({ category: 'session', title: 'Session zebra', body: 'Session public zebra' }, ctx)).memory;
  const secret = (await old.store({ category: 'personal', title: 'PRIVATE title canary', body: 'PRIVATE body canary', private: true, tags: ['private-canary'], source: 'PRIVATE source canary', sourceRef: 'PRIVATE ref canary' }, ctx)).memory;
  const unknown = (await old.store({ category: 'personal', title: 'UNKNOWN title canary', body: 'UNKNOWN body canary' }, ctx)).memory;
  const proposed = (await old.store({ category: 'project', title: 'PROPOSED title canary', body: 'PROPOSED body canary', status: 'proposed' }, ctx)).memory;
  if (expired) { const m = (await old.store({ category: 'session', title: 'EXPIRED title canary', body: 'EXPIRED body canary' }, ctx)).memory;
    db.prepare('UPDATE memories SET expires_at=? WHERE id=?').run(Date.now() - 1, m.id); }
  db.prepare("UPDATE memories SET private='unclassified' WHERE id=?").run(unknown.id);
  db.prepare('INSERT INTO memory_events(memory_id,op,at,source,hash_after) VALUES(?,?,?,?,?)').run(secret.id, 'test', 1, 'PRIVATE audit canary', 'PRIVATE audit hash canary');
  if (floor) await cutoverMemory(options(paths));
  return { sb, cfg, paths, repo, ctx, db, old, publicNote, personal, linked, shared, session, secret, unknown, proposed,
    close() { old.close(); sb.cleanup(); } };
}
function viewRows(file: string) {
  const view = new DatabaseSync(file, { readOnly: true });
  try { return { state: view.prepare('SELECT * FROM bosun_public_state').get()!, memories: rows(view, 'public_memories') }; } finally { view.close(); }
}

test('production publication preserves primary/backup data and fixed inode, publishing only validated current public Memory fields and FTS', async () => {
  const f = await fixture();
  try {
    const primary = Object.fromEntries(['memories', 'memory_events', 'docs'].map((t) => [t, rows(f.db, t)]));
    const backup = footprint(f.paths.backups); const ino = fs.statSync(f.paths.view, { bigint: true }).ino;
    const result = await publishMemoryView(options(f.paths)); assert.deepEqual(Object.keys(result).sort(), ['publicationId', 'state']);
    assert.equal(result.state, 'READY'); assert.doesNotMatch(JSON.stringify(result), /PRIVATE|backup|hash|generation|sourceRef/);
    assert.equal(fs.statSync(f.paths.view, { bigint: true }).ino, ino); assert.equal(fs.statSync(f.paths.view).mode & 0o777, 0o600);
    assert.deepEqual([...fs.readFileSync(f.paths.view).subarray(18, 20)], [1, 1]);
    for (const [t, before] of Object.entries(primary)) assert.deepEqual(rows(f.db, t), before);
    assert.deepEqual(footprint(f.paths.backups), backup); assert.equal(f.db.prepare('PRAGMA journal_mode').get()!.journal_mode, 'wal');
    assert.equal(f.db.prepare('SELECT generation FROM bosun_source_floor').get()!.generation, 0);
    const view = new DatabaseSync(f.paths.view, { readOnly: true });
    try {
      const allowed = [f.publicNote, f.personal, f.linked, f.shared, f.session].map((m) => m.id).sort();
      assert.deepEqual(rows(view, 'public_memories').map((r) => r.id).sort(), allowed);
      assert.doesNotMatch(JSON.stringify(rows(view, 'public_memories')) + JSON.stringify(rows(view, 'bosun_public_state')), /PRIVATE|UNKNOWN|PROPOSED|EXPIRED|backup/);
      assert.deepEqual(view.prepare('SELECT * FROM public_memories WHERE id=?').get(f.publicNote.id), f.db.prepare('SELECT * FROM memories WHERE id=?').get(f.publicNote.id));
      assert.ok(view.prepare("SELECT rowid FROM public_memories_fts WHERE public_memories_fts MATCH 'admission zebra'").all().length);
      assert.equal(view.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name IN ('memory_events','docs')").get()!.n, 0);
      const scoped = view.prepare(`SELECT id FROM public_memories WHERE project_id IS NULL OR project_id='p_a' OR shared=1 OR project_id IN ('p_b') ORDER BY id`).all();
      assert.deepEqual(scoped.map((r) => r.id), allowed, 'scope and stable IDs remain available to the later scoped reader');
    } finally { view.close(); }
    const again = await publishMemoryView(options(f.paths)); assert.notEqual(again.publicationId, result.publicationId);
    assert.deepEqual(footprint(f.paths.backups), backup); assert.equal(fs.statSync(f.paths.view, { bigint: true }).ino, ino);
  } finally { f.close(); }
});

test('v2 publication fences cached real v1 MemoryService/Docs and old prepared statements; reopened writers revoke until explicit republish', async () => {
  const f = await fixture({ expired: false }); const cached = openLocalMemory(f.cfg);
  const docs = new Docs(openLocalSqlite(f.paths.primary, f.cfg), f.repo, 'p_a');
  const prepared = f.db.prepare('UPDATE memories SET private=1 WHERE id=?');
  let local: MemoryService | undefined; let currentDocs: Docs | undefined;
  try {
    await publishMemoryView(options(f.paths));
    await assert.rejects(cached.store({ category: 'personal', title: 'Cached', body: 'cached writer' }, f.ctx), (e) => e instanceof MemoryError && e.code === 'unavailable');
    fs.writeFileSync(path.join(f.repo, 'guide.md'), '# Zebra guide\nZebra guide public docs.'); assert.throws(() => docs.index(), MemoryError);
    assert.throws(() => prepared.run(f.publicNote.id), /bosun_writer_floor_v2/);
    assert.equal(viewRows(f.paths.view).state.state, 'READY');
    local = openLocalMemory(f.cfg); currentDocs = new Docs(openLocalSqlite(f.paths.primary, f.cfg), f.repo, 'p_a');
    await local.update(f.publicNote.id, { private: true }, 1, f.ctx); assert.equal(viewRows(f.paths.view).state.state, 'HOLD');
    assert.ok(viewRows(f.paths.view).memories.some((r) => r.id === f.publicNote.id), 'HOLD revokes audience access, not old/free-page erasure');
    await publishMemoryView(options(f.paths)); assert.ok(!viewRows(f.paths.view).memories.some((r) => r.id === f.publicNote.id));
    currentDocs.index(); assert.equal(viewRows(f.paths.view).state.state, 'HOLD');
    await publishMemoryView(options(f.paths));
    await local.delete(f.personal.id, f.ctx); assert.equal(viewRows(f.paths.view).state.state, 'HOLD');
    await publishMemoryView(options(f.paths));
    assert.equal((await local.get(f.secret.id, f.ctx)).body, f.secret.body, 'owner private reads remain authoritative');
    await assert.rejects(local.update(f.session.id, { body: 'wrong version' }, 99, f.ctx), (e) => e instanceof MemoryError && e.code === 'conflict' && e.current === 1);
  } finally { local?.close(); currentDocs?.close(); cached.close(); docs.close(); f.close(); }
});

test('same-inode rollback lease has no reader footprint and blocks revocation/publication; failed admission does not invalidate a valid view', async () => {
  const f = await fixture({ expired: false }); let local: MemoryService | undefined; let lease: DatabaseSync | undefined;
  try {
    await publishMemoryView(options(f.paths)); local = openLocalMemory(f.cfg);
    const before = footprint(path.dirname(f.paths.view));
    lease = new DatabaseSync(f.paths.view, { readOnly: true }); lease.exec('BEGIN'); lease.prepare('SELECT * FROM public_memories').all();
    assert.deepEqual(footprint(path.dirname(f.paths.view)), before);
    await assert.rejects(local.update(f.publicNote.id, { private: true }, 1, f.ctx), MemoryError);
    await assert.rejects(publishMemoryView(options(f.paths)), CutoverError);
    assert.equal(f.db.prepare('SELECT private FROM memories WHERE id=?').get(f.publicNote.id)!.private, 0);
    assert.equal(viewRows(f.paths.view).state.state, 'READY');
    lease.exec('ROLLBACK'); lease.close(); lease = undefined;
    f.db.exec('BEGIN IMMEDIATE');
    try { const state = viewRows(f.paths.view); await assert.rejects(publishMemoryView(options(f.paths)), CutoverError); assert.deepEqual(viewRows(f.paths.view), state); }
    finally { f.db.exec('ROLLBACK'); }
    await local.update(f.publicNote.id, { private: true }, 1, f.ctx); assert.equal(viewRows(f.paths.view).state.state, 'HOLD');
  } finally { lease?.close(); local?.close(); f.close(); }
});

async function crash(paths: ReturnType<typeof writerPaths>, phase: string, cwd: string) {
  const script = `import ${JSON.stringify(pathToFileURL(path.join(REPO, 'test/bootstrap.ts')).href)};
    import {publishMemoryView} from ${JSON.stringify(pathToFileURL(path.join(REPO, 'src/adapters/memory/sqlite-cutover.ts')).href)};
    import {randomUUID} from 'node:crypto';
    await publishMemoryView({paths:JSON.parse(process.argv[1]),now:Date.now,id:randomUUID,async checkpoint(p){
      if(p===process.argv[2]){process.stdout.write('PUBLICATION_CHECKPOINT\\n');await new Promise(()=>{});}}});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(paths), phase], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise<void>((resolve, reject) => {
    let ready = false; let out = ''; const timer = setTimeout(() => child.kill('SIGKILL'), 4000);
    child.stdout.on('data', (b) => { out += b; if (!ready && out.includes('PUBLICATION_CHECKPOINT')) { ready = true; child.kill('SIGKILL'); } });
    child.on('error', reject); child.on('exit', (code, signal) => { clearTimeout(timer); if (ready && signal === 'SIGKILL') resolve(); else reject(Error(`synthetic publication missed ${phase}: ${code}/${signal}`)); });
  });
}
test('multi-process publication crashes recover exact format/admission without generation reset, duplicate schema or overwritten backup', async () => {
  for (const phase of ['view-upgrade', 'format', 'format-commit', 'hold', 'rows', 'ready']) {
    const f = await fixture({ expired: false });
    try {
      const backup = footprint(f.paths.backups); const primary = rows(f.db, 'memories'); const inode = fs.statSync(f.paths.view, { bigint: true }).ino;
      await crash(f.paths, phase, f.sb.root);
      assert.equal(viewRows(f.paths.view).state.state, 'HOLD');
      if (['view-upgrade', 'format'].includes(phase)) assert.throws(() => openLocalMemory(f.cfg), MemoryError, 'ordinary open never finishes partial upgrade');
      await publishMemoryView(options(f.paths)); assert.equal(viewRows(f.paths.view).state.state, 'READY');
      assert.equal(f.db.prepare('SELECT generation FROM bosun_source_floor').get()!.generation, 0);
      assert.deepEqual(rows(f.db, 'memories'), primary); assert.deepEqual(footprint(f.paths.backups), backup); assert.equal(fs.statSync(f.paths.view, { bigint: true }).ino, inode);
      const local = openLocalMemory(f.cfg); try { await local.update(f.publicNote.id, { body: 'Recovered zebra body' }, 1, f.ctx); } finally { local.close(); }
      const generation = f.db.prepare('SELECT generation FROM bosun_source_floor').get()!.generation;
      await publishMemoryView(options(f.paths)); assert.equal(viewRows(f.paths.view).state.generation, generation);
    } finally { f.close(); }
  }
});

test('actual memory publish CLI uses explicit local composition, rejects plain/missing/remote/extraneous input without source creation', async () => {
  const f = await fixture({ expired: false });
  try {
    const result = await bosun(['memory', 'publish', '--json'], { env: f.sb.env(), cwd: f.repo }); assert.equal(result.code, 0, result.err);
    assert.equal(JSON.parse(result.out).state, 'READY'); assert.doesNotMatch(result.out, /PRIVATE|hash|backup/);
    const before = footprint(path.dirname(f.paths.view));
    for (const args of [['memory', 'publish', 'extra'], ['memory', 'publish', '--private']]) {
      const r = await bosun(args, { env: f.sb.env(), cwd: f.repo }); assert.equal(r.code, 2); assert.deepEqual(footprint(path.dirname(f.paths.view)), before);
    }
    const remote = await bosun(['memory', 'publish'], { env: f.sb.env({ MEMORY_URL: 'http://127.0.0.1:1' }), cwd: f.repo }); assert.equal(remote.code, 1); assert.deepEqual(footprint(path.dirname(f.paths.view)), before);
    const receipt = await cutoverMemory(options(f.paths)); assert.equal(receipt.state, 'HOLD'); assert.equal(viewRows(f.paths.view).state.state, 'HOLD', 'explicit cutover reconciliation truthfully revokes public state');
  } finally { f.close(); }
  const sb = sandbox(); fresh(sb); load();
  try {
    const r = await bosun(['memory', 'publish'], { env: sb.env() }); assert.equal(r.code, 1); assert.equal(fs.existsSync(P.DB), false); assert.equal(fs.existsSync(path.join(P.BOSUN, 'memory-view')), false);
    const db = openDb(P.DB); db.close(); const before = footprint(P.BOSUN);
    const plain = await bosun(['memory', 'publish'], { env: sb.env() }); assert.equal(plain.code, 1);
    assert.deepEqual(footprint(P.BOSUN), before, 'existing plain schema-v1 database is neither migrated nor opened as a writer');
  }
  finally { sb.cleanup(); }
});

test('publication preserves established non-generator IDs and excludes malformed private flags before reading public content', async () => {
  const f = await fixture({ expired: false, floor: false });
  try {
    f.db.prepare('UPDATE memories SET id=? WHERE id=?').run('owner-existing-key', f.publicNote.id);
    await cutoverMemory(options(f.paths)); await publishMemoryView(options(f.paths));
    const published = viewRows(f.paths.view);
    assert.ok(published.memories.some((r) => r.id === 'owner-existing-key'));
    assert.ok(!published.memories.some((r) => r.id === f.unknown.id || r.id === f.secret.id));
  } finally { f.close(); }
});

test('completed publication survives child SIGKILL and explicit republish; concurrent real CLI writers/publishers cannot bypass admission', async () => {
  const f = await fixture({ expired: false });
  try {
    await publishMemoryView({ ...options(f.paths), async checkpoint(phase) {
      if (phase === 'hold') {
        const writer = await bosun(['memory', 'add', '-c', 'personal', '-t', 'Contender', 'contending public write'], { env: f.sb.env(), cwd: f.repo });
        assert.equal(writer.code, 1); assert.match(writer.err, /local memory unavailable/);
        const publisher = await bosun(['memory', 'publish', '--json'], { env: f.sb.env(), cwd: f.repo }); assert.equal(publisher.code, 1);
        assert.equal(f.db.prepare('SELECT generation FROM bosun_source_floor').get()!.generation, 0);
      }
    } });
    const code = `import ${JSON.stringify(pathToFileURL(path.join(REPO, 'test/bootstrap.ts')).href)};
      import {publishMemoryView} from ${JSON.stringify(pathToFileURL(path.join(REPO, 'src/adapters/memory/sqlite-cutover.ts')).href)};
      import {randomUUID} from 'node:crypto'; await publishMemoryView({paths:JSON.parse(process.argv[1]),now:Date.now,id:randomUUID});
      process.stdout.write('PUBLICATION_COMPLETED\\n'); setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, JSON.stringify(f.paths)], { cwd: f.sb.root, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise<void>((resolve, reject) => {
      let completed = false; let out = ''; const timer = setTimeout(() => child.kill('SIGKILL'), 4000);
      child.stdout.on('data', (b) => { out += b; if (!completed && out.includes('PUBLICATION_COMPLETED')) { completed = true; child.kill('SIGKILL'); } });
      child.once('error', reject); child.once('exit', (_code, signal) => { clearTimeout(timer); if (completed && signal === 'SIGKILL') resolve(); else reject(Error('synthetic completed publication missing')); });
    });
    assert.equal(viewRows(f.paths.view).state.state, 'READY'); await publishMemoryView(options(f.paths)); assert.equal(viewRows(f.paths.view).state.state, 'READY');
  } finally { f.close(); }
});

test('explicit owned journal recovery rejects substituted/symlinked journal and mismatched backup authority without touching them', async () => {
  for (const kind of ['journal', 'dangling', 'backup', 'inode', 'hardlink', 'mode', 'wal']) {
    const f = await fixture({ expired: false });
    try {
      await crash(f.paths, 'rows', f.sb.root);
      const journal = f.paths.view + '-journal'; assert.equal(fs.existsSync(journal), true, 'actual killed rebuild leaves its native journal');
      if (kind === 'journal') {
        fs.renameSync(journal, journal + '.owned'); const foreign = path.join(f.sb.root, 'foreign-journal'); fs.writeFileSync(foreign, 'PRIVATE unrelated canary', { mode: 0o600 }); fs.symlinkSync(foreign, journal);
      }
      const missingTarget = path.join(f.sb.root, 'never-created-journal');
      if (kind === 'dangling') { fs.renameSync(journal, journal + '.owned'); fs.symlinkSync(missingTarget, journal); }
      if (kind === 'backup') fs.appendFileSync(path.join(f.paths.backups, fs.readdirSync(f.paths.backups)[0]), 'PRIVATE backup tamper');
      if (kind === 'inode') { const bytes = fs.readFileSync(f.paths.view); fs.renameSync(f.paths.view, f.paths.view + '.owned'); fs.writeFileSync(f.paths.view, bytes, { mode: 0o600 }); }
      if (kind === 'hardlink') fs.linkSync(journal, journal + '.alias');
      if (kind === 'mode') fs.chmodSync(journal, 0o644);
      if (kind === 'wal') fs.writeFileSync(f.paths.view + '-wal', 'PRIVATE unrelated WAL', { mode: 0o600 });
      const before = kind === 'dangling' ? { view: fs.readFileSync(f.paths.view), link: fs.readlinkSync(journal) } : footprint(path.dirname(f.paths.view));
      await assert.rejects(publishMemoryView(options(f.paths)), CutoverError);
      if (kind === 'dangling') {
        assert.deepEqual({ view: fs.readFileSync(f.paths.view), link: fs.readlinkSync(journal) }, before);
        assert.equal(fs.existsSync(missingTarget), false, 'unknown journal target is never created');
      } else assert.deepEqual(footprint(path.dirname(f.paths.view)), before);
    } finally { f.close(); }
  }
});

test('actual hot spill journal is held by ordinary callers and recovered natively only by the explicit bound publisher', async () => {
  const f = await fixture({ expired: false, floor: false });
  try {
    const body = 'spillzebra '.repeat(60);
    for (let i = 0; i < 2400; i++) await f.old.store({ category: 'project', title: `Spill zebra ${i}`, body }, f.ctx);
    await cutoverMemory(options(f.paths));
    const primary = rows(f.db, 'memories'); const backup = footprint(f.paths.backups); const inode = fs.statSync(f.paths.view, { bigint: true }).ino;
    const code = `import ${JSON.stringify(pathToFileURL(path.join(REPO, 'test/bootstrap.ts')).href)};
      import {publishMemoryView} from ${JSON.stringify(pathToFileURL(path.join(REPO, 'src/adapters/memory/sqlite-cutover.ts')).href)};
      import {randomUUID} from 'node:crypto'; await publishMemoryView({paths:JSON.parse(process.argv[1]),now:Date.now,id:randomUUID,
      async checkpoint(p){if(p==='hold'){process.stdout.write('SPILL_HOLD\\n');await new Promise(r=>process.stdin.once('data',r));}
        if(p==='rows'){process.stdout.write('SPILL_ROWS\\n');await new Promise(()=>{});}}});`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, JSON.stringify(f.paths)], { cwd: f.sb.root, stdio: ['pipe', 'pipe', 'pipe'] });
    let before: Buffer | undefined; let spilled = false; let hot = false;
    await new Promise<void>((resolve, reject) => {
      let out = ''; let held = false; let seenRows = false; const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.stdout.on('data', (b) => {
        out += b;
        if (!held && out.includes('SPILL_HOLD')) { held = true; before = fs.readFileSync(f.paths.view); child.stdin.write('continue\n'); }
        if (!seenRows && out.includes('SPILL_ROWS')) {
          seenRows = true; const journal = fs.readFileSync(f.paths.view + '-journal'); hot = journal.subarray(0, 8).toString('hex') === 'd9d505f920a163d7';
          spilled = !fs.readFileSync(f.paths.view).equals(before!); child.kill('SIGKILL');
        }
      });
      child.once('error', reject); child.once('exit', (_c, signal) => { clearTimeout(timer); if (seenRows && signal === 'SIGKILL') resolve(); else reject(Error('synthetic spill boundary missing')); });
    });
    assert.equal(hot, true, 'native journal has a synced nonzero hot header'); assert.equal(spilled, true, 'dirty view pages reached the DB before commit');
    const damaged = footprint(path.dirname(f.paths.view)); assert.throws(() => openLocalMemory(f.cfg), MemoryError); assert.deepEqual(footprint(path.dirname(f.paths.view)), damaged);
    await publishMemoryView({ ...options(f.paths), checkpoint(phase) {
      if (phase === 'hold') { const restored = viewRows(f.paths.view); assert.equal(restored.state.state, 'HOLD'); assert.equal(restored.memories.length, 0, 'native recovery restored pre-rebuild rows'); }
    } });
    assert.equal(viewRows(f.paths.view).state.state, 'READY'); assert.equal(viewRows(f.paths.view).memories.length, 2405);
    assert.equal(fs.existsSync(f.paths.view + '-journal'), false); assert.equal(fs.statSync(f.paths.view, { bigint: true }).ino, inode);
    assert.deepEqual(rows(f.db, 'memories'), primary); assert.deepEqual(footprint(f.paths.backups), backup);
  } finally { f.close(); }
});

test('publication rejects asynchronous inputs before effects and detects late backup/epoch drift before READY', async () => {
  for (const kind of ['clock', 'id', 'backup', 'epoch']) {
    const f = await fixture({ expired: false });
    try {
      const before = footprint(path.dirname(f.paths.view));
      const o: any = options(f.paths);
      if (kind === 'clock') o.now = async () => Date.now();
      if (kind === 'id') o.id = async () => crypto.randomUUID();
      if (kind === 'backup') o.checkpoint = (phase: string) => { if (phase === 'ready') fs.appendFileSync(path.join(f.paths.backups, fs.readdirSync(f.paths.backups)[0]), 'PRIVATE late tamper'); };
      if (kind === 'epoch') o.checkpoint = (phase: string) => {
        if (phase === 'hold') { const db = new DatabaseSync(f.paths.view); try { db.prepare('UPDATE bosun_public_state SET source_id=?').run(crypto.randomUUID()); } finally { db.close(); } }
      };
      await assert.rejects(publishMemoryView(o), CutoverError);
      if (['clock', 'id'].includes(kind)) assert.deepEqual(footprint(path.dirname(f.paths.view)), before);
      else assert.equal(viewRows(f.paths.view).state.state, 'HOLD');
    } finally { f.close(); }
  }
});

test('10,000-row synthetic capacity observation holds the corpus at the encoded byte limit without claiming useful retrieval or latency', async () => {
  const f = await fixture({ expired: false, floor: false });
  try {
    for (const m of [f.secret, f.unknown, f.proposed]) f.db.prepare('DELETE FROM memories WHERE id=?').run(m.id);
    const body = 'capacitysample '.repeat(35);
    for (let i = 5; i < 10000; i++) await f.old.store({ category: 'project', title: `Capacity zebra ${i}`, body }, f.ctx);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM memories').get()!.n, 10000);
    await cutoverMemory(options(f.paths));
    await assert.rejects(publishMemoryView(options(f.paths)), (e: unknown) => e instanceof CutoverError && e.reason === 'state');
    assert.equal(viewRows(f.paths.view).state.state, 'HOLD'); assert.equal(viewRows(f.paths.view).memories.length, 0);
    console.log('Public-view capacity qualification:', JSON.stringify({ syntheticRows: 10000, encodedLimitBytes: 4194304, outcome: 'HOLD', usefulRetrieval: 'unqualified' }));
  } finally { f.close(); }
});

test('publication pre-READY failures/backward or invalid clocks and delivery-crossing expiry remain HOLD with finite errors', async () => {
  for (const kind of ['callback', 'backward', 'invalid', 'expired']) {
    const f = await fixture({ expired: false }); let now = Date.now();
    try {
      await assert.rejects(publishMemoryView({ ...options(f.paths), now: () => now, checkpoint(phase) {
        if (phase !== 'ready') return;
        if (kind === 'callback') throw new Proxy({}, { getPrototypeOf() { throw Error('PRIVATE prototype canary'); }, get() { throw Error('PRIVATE getter canary'); } });
        if (kind === 'backward') now--;
        if (kind === 'invalid') now = 'PRIVATE clock canary' as any;
        if (kind === 'expired') now = f.session.expiresAt! + 1;
      } }), (e: unknown) => { assert.ok(e instanceof CutoverError); assert.doesNotMatch(e.message + JSON.stringify(e), /PRIVATE/); return true; });
      assert.equal(viewRows(f.paths.view).state.state, 'HOLD'); assert.equal(viewRows(f.paths.view).memories.length, 0);
      await publishMemoryView(options(f.paths));
    } finally { f.close(); }
  }
});

test('post-READY native close failures re-HOLD if possible or report unknown receipt while a real lease blocks re-HOLD', async () => {
  for (const obstruct of [false, true]) {
    const f = await fixture({ expired: false }); const close = DatabaseSync.prototype.close;
    let fail = true; let lease: DatabaseSync | undefined;
    try {
      DatabaseSync.prototype.close = function () {
        if (fail && this.prepare("SELECT 1 FROM sqlite_master WHERE name='bosun_public_state'").get()) {
          fail = false;
          if (obstruct) { lease = new DatabaseSync(f.paths.view, { readOnly: true }); lease.exec('BEGIN'); lease.prepare('SELECT * FROM public_memories').all(); }
          throw Error('PRIVATE close canary');
        }
        return close.call(this);
      };
      await assert.rejects(publishMemoryView(options(f.paths)), (e: unknown) => {
        assert.ok(e instanceof CutoverError); assert.equal(e.reason, obstruct ? 'receipt_unknown' : 'storage');
        if (obstruct) assert.deepEqual(e.details, { currentVersion: undefined, outcome: 'unknown' }); assert.doesNotMatch(e.message, /PRIVATE/); return true;
      });
      DatabaseSync.prototype.close = close;
      assert.equal(viewRows(f.paths.view).state.state, obstruct ? 'READY' : 'HOLD');
      if (lease) { lease.exec('ROLLBACK'); lease.close(); lease = undefined; }
      await publishMemoryView(options(f.paths)); assert.equal(viewRows(f.paths.view).state.state, 'READY');
    } finally { DatabaseSync.prototype.close = close; lease?.close(); f.close(); }
  }
});

test('publication rejects malformed public hashes/content and unknown/private flags; owned failure holds while wrong/tampered artifacts are never repaired', async () => {
  for (const kind of ['hash', 'tags', 'version', 'view', 'schema', 'backup']) {
    const f = await fixture({ expired: false, floor: false });
    try {
      if (kind === 'hash') f.db.prepare("UPDATE memories SET hash='PRIVATE derivative canary' WHERE id=?").run(f.publicNote.id);
      if (kind === 'tags') f.db.prepare("UPDATE memories SET tags='[\"PRIVATE malformed tag\"]' WHERE id=?").run(f.publicNote.id);
      if (kind === 'version') f.db.prepare("UPDATE memories SET version='PRIVATE version canary' WHERE id=?").run(f.publicNote.id);
      await cutoverMemory(options(f.paths));
      if (kind === 'view') { const bytes = fs.readFileSync(f.paths.view); fs.renameSync(f.paths.view, f.paths.view + '.old'); fs.writeFileSync(f.paths.view, bytes, { mode: 0o600 }); }
      if (kind === 'schema') { const view = new DatabaseSync(f.paths.view); try { view.exec('CREATE TABLE unrelated(value TEXT)'); } finally { view.close(); } }
      if (kind === 'backup') fs.appendFileSync(path.join(f.paths.backups, fs.readdirSync(f.paths.backups)[0]), 'PRIVATE tamper');
      const before = footprint(path.dirname(f.paths.view));
      await assert.rejects(publishMemoryView(options(f.paths)), (e: unknown) => { assert.ok(e instanceof CutoverError); assert.doesNotMatch(e.message, /PRIVATE/); return true; });
      if (['view', 'schema', 'backup'].includes(kind)) assert.deepEqual(footprint(path.dirname(f.paths.view)), before);
      else assert.equal(viewRows(f.paths.view).state.state, 'HOLD');
    } finally { f.close(); }
  }
});
