import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync, backup } from 'node:sqlite';
import { sandbox, fresh } from './helpers.ts';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { REPO } from './helpers.ts';
import { MemoryService } from '../lib/memory/service.ts';
import { load } from '../lib/config.ts';
import { MIGRATIONS } from '../lib/memory/sqlite.ts';
import { fixture, openLease, footprint, publish, gate, qualified, installFloor, sourceGeneration, buildUnderAdmission, patchedVersion,
  beginAdmission, endAdmission, hold, protectSchema, FLOOR_FN } from './read-view-prototype.ts';

const native = new DatabaseSync(':memory:');
const nativeVersion = String(native.prepare('SELECT sqlite_version() AS version').get()!.version);
const capabilities = Object.fromEntries(['function', 'setAuthorizer', 'serialize', 'deserialize', 'isTransaction'].map((name) => [name, typeof Reflect.get(native, name)]));
native.close();
const patched = patchedVersion(nativeVersion);
const qualifiedNative = patched && typeof backup === 'function' && capabilities.function === 'function'
  && capabilities.setAuthorizer === 'function' && capabilities.isTransaction === 'boolean';
const probeOptions = { skip: !qualifiedNative && 'Native prerequisites unqualified: runtime HOLD, WAL prototypes deferred' };
const CTX = { projectId: 'p_a', sessionId: null, linked: ['p_b'] };

test('read-view qualification: actual native version/APIs before any multi-connection WAL probe', () => {
  console.log('Read-view native qualification:', JSON.stringify({ node: process.version, sqlite: nativeVersion, patchedWalReset: patched,
    backup: typeof backup, unsafeProbes: qualifiedNative ? 'enabled-test-prototype' : 'deferred-HOLD', ...capabilities }));
  for (const value of ['3.51.2', '3.50.6', 'malformed', '4.0.0']) assert.equal(patchedVersion(value), false);
  for (const value of ['3.51.3', '3.50.7', '3.44.6', '3.53.0']) assert.equal(patchedVersion(value), true);
});

test('read-view qualification: READY rollback lease preserves public IDs/scope and leaves primary/view footprint unchanged', probeOptions, () => {
  const sb = sandbox(); let f: ReturnType<typeof fixture> | undefined;
  try {
    fresh(sb); f = fixture(sb.root); publish(f.source, f.view);
    const before = { primary: footprint(f.primaryDir), view: footprint(f.viewDir) };
    const lease = openLease(f.viewFile);
    try {
      assert.deepEqual(lease.rows(CTX).map((row) => row.id), ['m_linked', 'm_personal', 'm_project', 'm_shared']);
      assert.deepEqual(lease.rows({ ...CTX, projectId: null, linked: [] }).map((row) => row.id), ['m_personal', 'm_shared']);
      assert.doesNotMatch(JSON.stringify(lease.rows(CTX)), /PRIVATE|EXPIRED/);
      lease.validate();
      assert.deepEqual({ primary: footprint(f.primaryDir), view: footprint(f.viewDir) }, before);
    } finally { lease.close(); }
    assert.deepEqual({ primary: footprint(f.primaryDir), view: footprint(f.viewDir) }, before);
    assert.equal(f.view.prepare('SELECT COUNT(*) AS n FROM memory_events').get()!.n, 0);
  } finally { f?.close(); sb.cleanup(); }
});

test('read-view qualification: old already-prepared INSERT/UPDATE/DELETE/touch/expiry are fenced after floor cutover', probeOptions, () => {
  const sb = sandbox(); let f: ReturnType<typeof fixture> | undefined; let old: DatabaseSync | undefined;
  try {
    fresh(sb); f = fixture(sb.root, false); old = new DatabaseSync(f.primaryFile); old.exec('PRAGMA busy_timeout=0;');
    const sql = [
      "INSERT INTO memories(id,category,title,body,source,hash,created_at,updated_at) VALUES('m_old','personal','Old','Old body','old','old-hash',1,1)",
      "UPDATE memories SET private=1 WHERE id='m_project'", "DELETE FROM memories WHERE id='m_project'",
      "UPDATE memories SET access_count=access_count+1 WHERE id='m_project'", "UPDATE memories SET status='archived' WHERE expires_at<=100",
    ];
    const prepared = sql.map((statement) => old!.prepare(statement));
    // Warm a prepared write before the schema changes: later executions must re-prepare/fail.
    prepared[3].run();
    installFloor(f.source); publish(f.source, f.view);
    for (const statement of prepared) assert.throws(() => statement.run(), /no such function.*bosun_read_view_floor_v1/);
    const direct = new DatabaseSync(f.primaryFile);
    try { for (const statement of sql) assert.throws(() => direct.exec(statement), /no such function.*bosun_read_view_floor_v1/); }
    finally { direct.close(); }
    assert.equal(sourceGeneration(f.source), 0);
    assert.equal(gate(f.view).state, 'READY');
    assert.equal(f.source.prepare("SELECT private FROM memories WHERE id='m_project'").get()!.private, 0);
  } finally { old?.close(); f?.close(); sb.cleanup(); }
});

test('read-view qualification: retained lease blocks supported revocation through packing/delivery; release then permits commit and HOLD', probeOptions, () => {
  const sb = sandbox(); let f: ReturnType<typeof fixture> | undefined;
  try {
    fresh(sb); f = fixture(sb.root); publish(f.source, f.view);
    const lease = openLease(f.viewFile);
    try {
      const packed = JSON.stringify(lease.rows(CTX));
      lease.validate();
      assert.throws(() => f!.source.exec("UPDATE memories SET private=1 WHERE id='m_project'"));
      assert.equal(f.source.prepare("SELECT private FROM memories WHERE id='m_project'").get()!.private, 0);
      lease.validate();
      assert.match(packed, /m_project/); // delivery occurs while lease still held; no returned row cache is a new read
      assert.equal(sourceGeneration(f.source), 0);
    } finally { lease.close(); }
    f.source.exec("UPDATE memories SET private=1 WHERE id='m_project'");
    assert.equal(sourceGeneration(f.source), 1);
    assert.equal(gate(f.view).state, 'HOLD');
    assert.throws(() => openLease(f!.viewFile), /view_hold/);
    assert.throws(() => lease.rows(CTX), /lease_closed/);
    publish(f.source, f.view);
    const next = openLease(f.viewFile);
    try { assert.equal(next.generation, 1); assert.ok(!next.rows(CTX).some((row) => row.id === 'm_project')); }
    finally { next.close(); }
  } finally { f?.close(); sb.cleanup(); }
});

test('read-view qualification: primary write admission serializes publishers/mutators; aborted primary DML leaves durable HOLD', probeOptions, () => {
  const sb = sandbox(); let f: ReturnType<typeof fixture> | undefined; let other: DatabaseSync | undefined;
  try {
    fresh(sb); f = fixture(sb.root); publish(f.source, f.view);
    const calls = { calls: 0 }; other = qualified(f.primaryFile, f.view, calls);
    beginAdmission(f.source);
    assert.throws(() => other!.exec("UPDATE memories SET private=1 WHERE id='m_project'"), /locked/);
    assert.equal(calls.calls, 0, 'BEFORE trigger cannot invalidate before primary write admission');
    assert.throws(() => publish(other!, f!.view), /locked/);
    assert.equal(buildUnderAdmission(f.source, f.view), 0);
    endAdmission(f.source, true);
    other.exec('BEGIN IMMEDIATE');
    other.exec("UPDATE memories SET private=1 WHERE id='m_project'");
    assert.equal(gate(f.view).state, 'HOLD');
    other.exec('ROLLBACK');
    assert.equal(sourceGeneration(f.source), 0);
    assert.equal(f.source.prepare("SELECT private FROM memories WHERE id='m_project'").get()!.private, 0);
    assert.equal(gate(f.view).state, 'HOLD', 'primary rollback must not undo external durable invalidation');
    assert.throws(() => openLease(f!.viewFile), /view_hold/);
    publish(f.source, f.view);
    assert.equal(gate(f.view).state, 'READY');
  } finally { other?.close(); f?.close(); sb.cleanup(); }
});

test('read-view qualification: deferred isTransaction is not publisher write admission', probeOptions, () => {
  const sb = sandbox(); let f: ReturnType<typeof fixture> | undefined;
  try {
    fresh(sb); f = fixture(sb.root); f.source.exec('BEGIN');
    assert.equal(f.source.isTransaction, true);
    assert.throws(() => buildUnderAdmission(f!.source, f!.view), /primary_admission_required/);
    assert.equal(gate(f.view).state, 'HOLD');
    f.source.exec('ROLLBACK');
  } finally { f?.close(); sb.cleanup(); }
});

test('read-view qualification: actual legacy MemoryService mutations/expiry cannot bypass floor through another connection', probeOptions, async () => {
  const sb = sandbox(); let f: ReturnType<typeof fixture> | undefined; let old: MemoryService | undefined;
  try {
    fresh(sb); f = fixture(sb.root, false);
    old = new MemoryService(new DatabaseSync(f.primaryFile), load());
    // Prepare an actual expired row before cutover, after the old constructor's initial expiry.
    f.source.exec("UPDATE memories SET status='active',expires_at=0 WHERE id='m_expired'");
    installFloor(f.source); publish(f.source, f.view);
    const events = f.source.prepare('SELECT COUNT(*) AS n FROM memory_events').get()!.n;
    await assert.rejects(old.store({ category: 'personal', title: 'Legacy insert', body: 'Synthetic legacy body' }, CTX), /no such function/);
    await assert.rejects(old.update('m_project', { private: true }, 1, CTX), /no such function/);
    assert.throws(() => old!.expire(), /no such function/);
    assert.equal(f.source.prepare('SELECT COUNT(*) AS n FROM memory_events').get()!.n, events, 'failed expiry rolls its earlier audit insert back');
    assert.equal(sourceGeneration(f.source), 0);
    assert.equal(gate(f.view).state, 'READY');
  } finally { old?.close(); f?.close(); sb.cleanup(); }
});

test('read-view qualification: shared/project/expiry mutations revoke current generation, and readers reapply expiry', probeOptions, () => {
  const sb = sandbox(); let f: ReturnType<typeof fixture> | undefined;
  try {
    fresh(sb); f = fixture(sb.root); publish(f.source, f.view);
    for (const sql of ["UPDATE memories SET shared=0 WHERE id='m_shared'", "UPDATE memories SET project_id='p_foreign' WHERE id='m_project'",
      "UPDATE memories SET expires_at=150 WHERE id='m_linked'"]) {
      f.source.exec(sql); assert.equal(gate(f.view).state, 'HOLD'); publish(f.source, f.view);
    }
    const lease = openLease(f.viewFile);
    try {
      assert.deepEqual(lease.rows(CTX, 100).map((r) => r.id), ['m_linked', 'm_personal']);
      assert.deepEqual(lease.rows(CTX, 151).map((r) => r.id), ['m_personal']);
      assert.equal(lease.generation, sourceGeneration(f.source));
    } finally { lease.close(); }
  } finally { f?.close(); sb.cleanup(); }
});

test('read-view qualification: SQLite-aware pre-floor backup under admission is exact, owner-only and separate from public view', probeOptions, async () => {
  const sb = sandbox(); let f: ReturnType<typeof fixture> | undefined; let snapshotSource: DatabaseSync | undefined;
  let contender: DatabaseSync | undefined; let copy: DatabaseSync | undefined;
  try {
    fresh(sb); f = fixture(sb.root, false);
    const backupDir = path.join(sb.root, 'owner-backup'); fs.mkdirSync(backupDir, { mode: 0o700 });
    const artifact = path.join(backupDir, 'before-floor.db'); fs.closeSync(fs.openSync(artifact, 'wx', 0o600));
    beginAdmission(f.source);
    contender = new DatabaseSync(f.primaryFile); contender.exec('PRAGMA busy_timeout=0;');
    assert.throws(() => contender!.exec("UPDATE memories SET body='unadmitted' WHERE id='m_project'"), /locked/);
    snapshotSource = new DatabaseSync(f.primaryFile, { readOnly: true });
    const pages = await backup(snapshotSource, artifact, {}); // Explicit options also survive the mandatory guard wrapper.
    assert.ok(pages > 0);
    endAdmission(f.source, true);
    snapshotSource.close(); snapshotSource = undefined;
    copy = new DatabaseSync(artifact);
    assert.deepEqual(copy.prepare('SELECT * FROM memories ORDER BY seq').all(), f.source.prepare('SELECT * FROM memories ORDER BY seq').all());
    assert.deepEqual(copy.prepare('SELECT * FROM memory_events ORDER BY id').all(), f.source.prepare('SELECT * FROM memory_events ORDER BY id').all());
    assert.equal(copy.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='source_gate'").get()!.n, 0);
    assert.equal(copy.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
    assert.equal(fs.statSync(artifact).mode & 0o777, 0o600);
    assert.match(String(copy.prepare("SELECT body FROM memories WHERE id='m_private'").get()!.body), /PRIVATE/);
    installFloor(f.source); publish(f.source, f.view);
    assert.equal(f.view.prepare('SELECT COUNT(*) AS n FROM memories WHERE private<>0').get()!.n, 0);
    assert.doesNotMatch(fs.readFileSync(f.viewFile).toString('utf8'), /PRIVATE body canary|PRIVATE CANARY|PRIVATE-hash|PRIVATE audit/);
    assert.equal(f.view.prepare("SELECT COUNT(*) AS n FROM memories_fts WHERE memories_fts MATCH 'private'").get()!.n, 0);
  } finally { copy?.close(); snapshotSource?.close(); contender?.close(); f?.close(); sb.cleanup(); }
});

async function killAtPhase(primaryFile: string, viewFile: string, phase: string, cwd: string): Promise<void> {
  const code = `import ${JSON.stringify(pathToFileURL(path.join(REPO, 'test/bootstrap.ts')).href)};
    import {crashPhase} from ${JSON.stringify(pathToFileURL(path.join(REPO, 'test/read-view-prototype.ts')).href)};
    crashPhase(process.argv[1],process.argv[2],process.argv[3]);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, primaryFile, viewFile, phase], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise<void>((resolve, reject) => {
    let ready = false; let output = ''; let error = '';
    const timeout = setTimeout(() => { child.kill('SIGKILL'); }, 3000);
    child.stdout.on('data', (chunk) => { output = (output + chunk).slice(-1024); if (output.includes('QUALIFICATION_READY') && !ready) { ready = true; child.kill('SIGKILL'); } });
    child.stderr.on('data', (chunk) => { error = (error + chunk).slice(-1024); });
    child.on('error', reject);
    child.on('close', (_code, signal) => { clearTimeout(timeout); if (ready && signal === 'SIGKILL') resolve(); else reject(Error(`bounded_crash_probe_failed:${phase}:${error}`)); });
  });
}
test('read-view qualification: SIGKILL at HOLD/primary commit/view build/READY preserves conservative recoverability', probeOptions, async () => {
  const sb = sandbox();
  try {
    fresh(sb);
    for (const phase of ['after-hold', 'after-primary-commit', 'during-view-build', 'after-ready']) {
      const root = path.join(sb.root, phase); fs.mkdirSync(root);
      const f = fixture(root);
      try {
        publish(f.source, f.view);
        await killAtPhase(f.primaryFile, f.viewFile, phase, sb.root);
        const before = footprint(f.viewDir);
        if (phase === 'after-ready') { const reader = openLease(f.viewFile); try { assert.ok(reader.rows(CTX).length > 0); reader.validate(); } finally { reader.close(); } }
        else assert.throws(() => openLease(f.viewFile), /view_hold/);
        assert.deepEqual(footprint(f.viewDir), before, 'readers cannot clean up/recover pending journals');
        // Explicit writer-owned recovery can read the gate; no reader performs recovery writes.
        assert.equal(gate(f.view).state, phase === 'after-ready' ? 'READY' : 'HOLD');
        assert.equal(f.source.prepare("SELECT private FROM memories WHERE id='m_project'").get()!.private, phase === 'after-primary-commit' ? 1 : 0);
        assert.equal(sourceGeneration(f.source), phase === 'after-primary-commit' ? 1 : 0);
      } finally { f.close(); }
    }
  } finally { sb.cleanup(); }
});

test('read-view qualification: trusted-application floor does not protect uncontrolled schema removal or UDF spoofing', probeOptions, () => {
  const sb = sandbox();
  try {
    fresh(sb);
    for (const arm of ['drop', 'spoof']) {
      const root = path.join(sb.root, arm); fs.mkdirSync(root); const f = fixture(root);
      const uncontrolled = new DatabaseSync(f.primaryFile);
      try {
        publish(f.source, f.view);
        if (arm === 'drop') uncontrolled.exec('DROP TRIGGER bosun_floor_update');
        else uncontrolled.function(FLOOR_FN, () => 1);
        uncontrolled.exec("UPDATE memories SET private=1 WHERE id='m_project'");
        assert.equal(gate(f.view).state, 'READY', 'known bypass proves floor/generation is not ownership/cutover proof');
        const lease = openLease(f.viewFile);
        try { assert.ok(lease.rows(CTX).some((row) => row.id === 'm_project'), 'synthetic stale row demonstrates explicit trust boundary'); }
        finally { lease.close(); }
      } finally { uncontrolled.close(); f.close(); }
    }
    const root = path.join(sb.root, 'authorized'); fs.mkdirSync(root); const f = fixture(root);
    try { protectSchema(f.source); assert.throws(() => f.source.exec('DROP TRIGGER bosun_floor_update'), /authorized/); }
    finally { f.close(); }
  } finally { sb.cleanup(); }
});

test('read-view qualification: early-close cached delivery and view-inode replacement remain explicit activation blockers', probeOptions, () => {
  const sb = sandbox(); let f: ReturnType<typeof fixture> | undefined;
  try {
    fresh(sb); f = fixture(sb.root); publish(f.source, f.view);
    const early = openLease(f.viewFile); const cached = early.rows(CTX); early.close();
    f.source.exec("UPDATE memories SET private=1 WHERE id='m_project'");
    assert.equal(gate(f.view).state, 'HOLD');
    assert.ok(cached.some((row) => row.id === 'm_project'), 'returned JS arrays cannot be revoked after early close');
    publish(f.source, f.view);
    const retained = openLease(f.viewFile);
    let replacement: DatabaseSync | undefined; let other: DatabaseSync | undefined;
    try {
      fs.renameSync(f.viewFile, f.viewFile + '.retired');
      replacement = new DatabaseSync(f.viewFile); replacement.exec(MIGRATIONS[0]);
      replacement.exec("CREATE TABLE view_gate(id INTEGER PRIMARY KEY,state TEXT,source_id TEXT,generation INTEGER,floor INTEGER);");
      replacement.exec("INSERT INTO view_gate VALUES(1,'HOLD','synthetic-source',0,1)");
      publish(f.source, replacement);
      other = qualified(f.primaryFile, replacement);
      other.exec("UPDATE memories SET private=1 WHERE id='m_personal'");
      assert.equal(gate(replacement).state, 'HOLD');
      retained.validate();
      assert.ok(retained.rows(CTX).some((row) => row.id === 'm_personal'), 'old inode lease does not lock the replacement');
    } finally { retained.close(); other?.close(); replacement?.close(); }
  } finally { f?.close(); sb.cleanup(); }
});
