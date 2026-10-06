import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { sandbox, fresh, gitRepo, bosun, mcpSession, BIN } from './helpers.ts';
import { load, P } from '../lib/config.ts';
import { MemoryService, openMemory, openLocalMemory } from '../lib/memory/service.ts';
import { Docs } from '../lib/memory/docs.ts';
import { openDb, openLocalSqlite, writerPaths, inspectMemorySchema } from '../lib/memory/sqlite.ts';
import { MemoryError, type Ctx, type Memory } from '../lib/memory/types.ts';
import { project } from '../lib/memory/project.ts';
import { main as serveMain } from '../lib/serve.ts';
import { cutoverMemory, CutoverWriter, CutoverError } from '../src/adapters/memory/sqlite-cutover.ts';
import { footprint } from './read-view-prototype.ts';

const DAY = 86400000;
const domain = (code: string) => (e: unknown) => e instanceof MemoryError && e.code === code;
function storageTree(file: string): unknown {
  const stat = fs.lstatSync(file, { bigint: true });
  return { mode: String(stat.mode), ino: String(stat.ino), size: String(stat.size), mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs),
    ...(stat.isDirectory() ? { entries: Object.fromEntries(fs.readdirSync(file).sort().map((name) => [name, storageTree(path.join(file, name))])) }
      : { hash: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }) };
}
async function fixture({ override = false, floor = true } = {}) {
  const sb = sandbox(); fresh(sb);
  const cfg = load();
  // Explicit preparation of synthetic permissions, never a runtime chmod/adoption.
  fs.chmodSync(P.BOSUN, 0o700);
  const repo = gitRepo(sb, 'writer-repo', 'git@github.com:org/writer-repo.git');
  const ctx: Ctx = { projectId: project(repo).id, sessionId: 's_a', linked: [], source: 'test' };
  if (override) {
    cfg.MEMORY_VIEW_PATH = path.join(sb.root, 'chosen-view', 'chosen.db');
    cfg.MEMORY_BACKUP_DIR = path.join(sb.root, 'chosen-backups');
  }
  const paths = writerPaths(P.DB, cfg);
  fs.mkdirSync(path.dirname(paths.view), { mode: 0o700 }); fs.mkdirSync(paths.backups, { mode: 0o700 });
  const db = openDb(P.DB); const old = new MemoryService(db, cfg);
  const publicNote = (await old.store({ category: 'project', title: 'Admission zebra', body: 'Admission zebra public body', tags: ['zebra'] }, ctx)).memory;
  const privateNote = (await old.store({ category: 'personal', title: 'PRIVATE title canary', body: 'PRIVATE body canary', tags: ['private-tag'], private: true, source: 'PRIVATE source canary', sourceRef: 'PRIVATE ref canary' }, ctx)).memory;
  const expired = (await old.store({ category: 'session', title: 'Expired constructor', body: 'Expired body', ttlDays: 1 }, ctx)).memory;
  db.prepare('UPDATE memories SET expires_at=? WHERE id=?').run(Date.now() - 1, expired.id);
  if (floor) await cutoverMemory({ paths, now: Date.now, id: crypto.randomUUID });
  return { sb, cfg, repo, ctx, paths, db, old, publicNote, privateNote, expired,
    env(extra: Record<string, string> = {}) { return sb.env({ MEMORY_VIEW_PATH: cfg.MEMORY_VIEW_PATH, MEMORY_BACKUP_DIR: cfg.MEMORY_BACKUP_DIR, ...extra }); },
    generation() { return Number(db.prepare('SELECT generation FROM bosun_source_floor').get()!.generation); },
    close() { old.close(); sb.cleanup(); } };
}

test('registered real store covers constructor expiry, reads/touch, mutations, scopes, versions, dedupe and retained audit', async () => {
  const f = await fixture(); let local: MemoryService | undefined;
  try {
    local = openLocalMemory(f.cfg);
    assert.throws(() => local!.db, domain('unavailable'), 'registered native handles do not escape');
    const expired = await local.get(f.expired.id, f.ctx, { events: true });
    assert.equal(expired.status, 'archived'); assert.equal(expired.version, 2); assert.deepEqual(expired.events!.map((e) => e.op), ['store', 'expire']);
    assert.equal(f.generation(), 2, 'constructor expiry event and row are both admitted');
    assert.deepEqual(await local.get(f.privateNote.id, f.ctx), f.privateNote, 'owner retains private fields/IDs');
    await assert.rejects(local.get(f.publicNote.id, { ...f.ctx, projectId: 'p_other' }), domain('not_found'));
    const prior = f.generation();
    assert.equal((await local.search({ text: 'admission zebra' }, f.ctx)).length, 1);
    assert.equal((await local.get(f.publicNote.id, f.ctx)).accessCount, 1); assert.equal(f.generation(), prior + 1);
    const duplicate = await local.store({ category: 'project', title: 'ADMISSION ZEBRA', body: 'admission zebra public body' }, f.ctx);
    assert.equal(duplicate.duplicate, true); assert.equal(duplicate.memory.id, f.publicNote.id); assert.equal(f.generation(), prior + 1);
    await assert.rejects(local.update(f.publicNote.id, { body: 'no conflict write' }, 99, f.ctx), (e: unknown) => {
      assert.ok(e instanceof MemoryError); assert.equal(e.code, 'conflict'); assert.equal(e.current, 1); return true;
    });
    await assert.rejects(local.purge(f.publicNote.id, f.ctx), domain('invalid'));
    const updated = await local.update(f.publicNote.id, { body: 'updated admission zebra', shared: true }, 1, f.ctx);
    assert.equal(updated.version, 2); assert.notEqual(updated.hash, f.publicNote.hash);
    assert.equal((await local.get(updated.id, { ...f.ctx, projectId: 'p_other' })).id, updated.id);
    await assert.rejects(local.update(updated.id, { body: 'wrong project' }, 2, { ...f.ctx, projectId: 'p_other' }), domain('invalid'));
    const proposal = (await local.store({ category: 'project', title: 'Accept me', body: 'accept proposal', status: 'proposed' }, f.ctx)).memory;
    assert.equal((await local.accept(proposal.id, f.ctx)).status, 'active');
    const rejected = (await local.store({ category: 'project', title: 'Reject me', body: 'reject proposal', status: 'proposed' }, f.ctx)).memory;
    assert.equal((await local.reject(rejected.id, f.ctx)).status, 'archived');
    await local.purge(rejected.id, f.ctx); await assert.rejects(local.get(rejected.id, f.ctx), domain('not_found'));
    assert.deepEqual(f.db.prepare('SELECT op FROM memory_events WHERE memory_id=? ORDER BY id').all(rejected.id).map((r) => r.op), ['propose', 'reject', 'purge']);
    const archived = await local.delete(updated.id, f.ctx); assert.equal(archived.status, 'archived');
    assert.equal((await local.delete(updated.id, f.ctx)).version, archived.version);
    local.close(); local = undefined;
    const reopened = openMemory(f.cfg);
    try { assert.equal((await reopened.get(f.privateNote.id, f.ctx)).body, f.privateNote.body); } finally { reopened.close(); }
    assert.throws(() => f.db.prepare("UPDATE memories SET private=1 WHERE id=?").run(f.privateNote.id), /no such function/);
    await assert.rejects(f.old.store({ category: 'personal', title: 'Old writer', body: 'must fail' }, f.ctx), /no such function/);
  } finally { local?.close(); f.close(); }
});

test('registered long-lived get/search expiry and prune use synchronous admission, preserving archive/purge events', async () => {
  const f = await fixture(); const local = openLocalMemory(f.cfg); const now = Date.now;
  try {
    const a = (await local.store({ category: 'session', title: 'Get expiry', body: 'get expiry words', ttlDays: 1 }, f.ctx)).memory;
    const b = (await local.store({ category: 'session', title: 'Search expiry', body: 'search expiry words', ttlDays: 2 }, f.ctx)).memory;
    Date.now = () => a.createdAt + DAY + 1;
    assert.equal((await local.get(a.id, f.ctx)).status, 'archived');
    Date.now = () => b.createdAt + 2 * DAY + 1;
    assert.deepEqual(await local.search({ text: 'search expiry words', touch: false }, f.ctx), []);
    Date.now = now;
    const r = local.prune(now() + 200 * DAY); assert.ok(r.purged >= 3);
    assert.deepEqual(f.db.prepare('SELECT op FROM memory_events WHERE memory_id=? ORDER BY id').all(b.id).map((r) => r.op), ['store', 'expire', 'purge']);
    assert.equal(f.db.prepare('SELECT 1 FROM memories WHERE id=?').get(b.id), undefined);
  } finally { Date.now = now; local.close(); f.close(); }
});

test('registered docs indexes insert/update/delete with FTS and owns a private close lifecycle', async () => {
  const f = await fixture(); const docs = new Docs(openLocalSqlite(f.paths.primary, f.cfg), f.repo, f.ctx.projectId!);
  const file = path.join(f.repo, 'guide.md');
  try {
    assert.throws(() => docs.db, domain('unavailable'));
    fs.writeFileSync(file, '# Admission zebra\nAdmission zebra docs.');
    assert.deepEqual(docs.index(), { changed: 1, removed: 0 }); const before = f.generation();
    assert.equal((await docs.search('admission zebra', f.ctx, 10))[0].id, 'guide.md');
    fs.writeFileSync(file, '# Revised zebra\nRevised zebra docs.'); fs.utimesSync(file, new Date(), new Date(Date.now() + 1000));
    assert.deepEqual(docs.index(), { changed: 1, removed: 0 }); assert.equal(f.generation(), before + 2, 'UPSERT fires both admitted INSERT and UPDATE triggers');
    assert.equal((await docs.search('revised zebra', f.ctx, 10)).length, 1);
    fs.unlinkSync(file); assert.deepEqual(docs.index(), { changed: 0, removed: 1 }); assert.equal(f.generation(), before + 3);
    assert.deepEqual(await docs.search('zebra', f.ctx, 10), []);
  } finally { docs.close(); f.close(); }
});

test('registered owner CLI uses loaded path overrides and retains private reads, mutation and purge', async () => {
  const f = await fixture({ override: true });
  try {
    const env = f.env(); fresh(f.sb, { MEMORY_VIEW_PATH: f.paths.view, MEMORY_BACKUP_DIR: f.paths.backups });
    assert.equal(load().MEMORY_VIEW_PATH, f.paths.view); assert.equal(load().MEMORY_BACKUP_DIR, f.paths.backups);
    const got = await bosun(['memory', 'get', f.privateNote.id, '--json'], { env, cwd: f.repo }); assert.equal(got.code, 0, got.err);
    assert.equal(JSON.parse(got.out).body, f.privateNote.body);
    const add = await bosun(['memory', 'add', '-c', 'personal', '--private', '--auto', '-t', 'Owner override', 'PRIVATE CLI body'], { env, cwd: f.repo });
    assert.equal(add.code, 0, add.err); const id = add.out.match(/stored (m_\w+)/)![1];
    for (const args of [['update', id, '-b', 'PRIVATE changed body'], ['delete', id], ['purge', id]]) {
      const r = await bosun(['memory', ...args], { env, cwd: f.repo }); assert.equal(r.code, 0, r.err);
    }
    assert.equal(f.db.prepare('SELECT 1 FROM memories WHERE id=?').get(id), undefined);
    assert.equal(f.sb.calls().filter((c) => ['claude', 'codex', 'ollama'].includes(c.bin)).length, 0, 'private auto causes no model/host calls');
  } finally { f.close(); }
});

for (const floor of [false, true]) test(`${floor ? 'registered' : 'plain'} real owner CLI unshares with owner/linked access, audit parity and early conflict rejection`, async () => {
  const f = await fixture({ override: floor, floor });
  try {
    const local = openLocalMemory(f.cfg);
    const shared = await local.update(f.publicNote.id, { shared: true }, 1, f.ctx);
    local.close();
    const other = gitRepo(f.sb, 'other-repo', 'git@github.com:org/other-repo.git');
    const env = f.env();
    const cross = await bosun(['memory', 'get', shared.id, '--json'], { env, cwd: other }); assert.equal(cross.code, 0, cross.err);
    const changed = await bosun(['memory', 'update', shared.id, '--unshared'], { env, cwd: f.repo }); assert.equal(changed.code, 0, changed.err);
    const owner = await bosun(['memory', 'get', shared.id, '--json'], { env, cwd: f.repo }); assert.equal(owner.code, 0, owner.err);
    const unshared = JSON.parse(owner.out);
    assert.equal(unshared.shared, false); assert.equal(unshared.version, 3);
    for (const key of ['id', 'hash', 'createdAt', 'expiresAt', 'source', 'sourceRef', 'body', 'title', 'tags', 'private', 'projectId', 'sessionId', 'accessCount', 'accessedAt'] as const) assert.deepEqual(unshared[key], shared[key], key);
    assert.deepEqual(unshared.events.map((e: any) => e.op), ['store', 'update', 'update']);
    assert.equal(unshared.events.at(-1).source, 'cli'); assert.equal(unshared.events.at(-1).hashBefore, shared.hash); assert.equal(unshared.events.at(-1).hashAfter, shared.hash);
    assert.equal((await bosun(['memory', 'get', shared.id, '--json'], { env, cwd: other })).code, 1);
    const linked = openLocalMemory(f.cfg);
    try {
      assert.equal((await linked.get(shared.id, { ...f.ctx, projectId: project(other).id, linked: [f.ctx.projectId!] })).id, shared.id);
      assert.deepEqual(await linked.search({ text: 'admission zebra', touch: false }, { ...f.ctx, projectId: project(other).id, linked: [] }), []);
    } finally { linked.close(); }
    const add = await bosun(['memory', 'add', '--unshared', '-t', 'Unshared creation', 'Unshared creation body'], { env, cwd: f.repo }); assert.equal(add.code, 0, add.err);
    const id = add.out.match(/stored (m_\w+)/)![1]; assert.equal(f.db.prepare('SELECT shared FROM memories WHERE id=?').get(id)!.shared, 0);
    const help = await bosun(['memory', 'help'], { env, cwd: f.repo }); assert.match(help.out, /--shared\|--unshared/);
    const state = () => ({ memories: f.db.prepare('SELECT * FROM memories ORDER BY seq').all(), events: f.db.prepare('SELECT * FROM memory_events ORDER BY id').all(), generation: floor ? f.generation() : 0 });
    const before = state(); const files = [storageTree(path.dirname(f.paths.primary)), storageTree(path.dirname(f.paths.view)), storageTree(f.paths.backups)]; f.sb.reset();
    for (const args of [['update', id, '--shared', '--unshared', '-f', path.join(f.sb.root, 'does-not-exist')], ['add', '--unshared', '--shared', '--auto', 'SHARING-CONFLICT-CANARY']]) {
      const result = await bosun(['memory', ...args], { env, cwd: f.repo }); assert.equal(result.code, 2, result.err); assert.match(result.err, /--shared.*--unshared|--unshared.*--shared/);
      assert.deepEqual(state(), before); assert.deepEqual([storageTree(path.dirname(f.paths.primary)), storageTree(path.dirname(f.paths.view)), storageTree(f.paths.backups)], files);
    }
    assert.deepEqual(f.sb.calls(), [], 'conflicting sharing flags precede project discovery, IO, model and database effects');
    const stale = await bosun(['memory', 'update', id, '--shared', '--version', '99'], { env, cwd: f.repo });
    assert.equal(stale.code, 1, stale.err); assert.match(stale.err, /version conflict/); assert.deepEqual(state(), before);
  } finally { f.close(); }
});

for (const floor of [false, true]) test(`${floor ? 'registered' : 'plain'} real owner CLI unsharing preserves a malformed private flag and owner-only content`, async () => {
  const f = await fixture({ override: floor, floor });
  try {
    const id = f.privateNote.id; const env = f.env();
    const plainFlags = openLocalSqlite(f.paths.primary, f.cfg);
    plainFlags.transaction((db) => db.prepare('UPDATE memories SET private=?,shared=? WHERE id=?').run('false', 1, id)); plainFlags.close();
    const protectedUpdate = await bosun(['memory', 'update', id, '--unshared'], { env, cwd: f.repo }); assert.equal(protectedUpdate.code, 0, protectedUpdate.err);
    assert.deepEqual({ ...f.db.prepare('SELECT private,shared FROM memories WHERE id=?').get(id) }, { private: 'false', shared: 0 });
    const privateGet = await bosun(['memory', 'get', id, '--json'], { env, cwd: f.repo }); assert.equal(JSON.parse(privateGet.out).body, f.privateNote.body);
  } finally { f.close(); }
});

for (const floor of [false, true]) test(`${floor ? 'registered' : 'plain'} real owner CLI status-only restores use post-maintenance versions and survive fresh get/reopen`, async () => {
  const f = await fixture({ override: floor, floor });
  try {
    const env = f.env(); const id = f.expired.id;
    const restore = await bosun(['memory', 'update', id, '--status', 'active'], { env, cwd: f.repo }); assert.equal(restore.code, 0, restore.err);
    const stored = f.db.prepare('SELECT * FROM memories WHERE id=?').get(id)!;
    assert.equal(stored.status, 'active'); assert.equal(stored.version, 3, 'constructor archives expired v1; default get obtains v2 before restore');
    assert.equal(stored.expires_at, Number(stored.updated_at) + Number(f.cfg.MEMORY_SESSION_TTL_DAYS) * DAY);
    assert.equal(stored.id, id); assert.equal(stored.hash, f.expired.hash); assert.equal(stored.created_at, f.expired.createdAt); assert.equal(stored.source, f.expired.source);
    const got = await bosun(['memory', 'get', id, '--json'], { env, cwd: f.repo }); assert.equal(got.code, 0, got.err);
    const inspected = JSON.parse(got.out); assert.equal(inspected.status, 'active'); assert.equal(inspected.version, 3); assert.equal(inspected.expiresAt, stored.expires_at);
    assert.deepEqual(inspected.events.map((e: any) => e.op), ['store', 'expire', 'restore']); assert.equal(inspected.events.at(-1).source, 'cli'); assert.equal(inspected.events.at(-1).at, stored.updated_at);
    const stale = await bosun(['memory', 'update', id, '--status', 'archived', '--version', '2'], { env, cwd: f.repo }); assert.equal(stale.code, 1, stale.err);
    for (const status of ['proposed', 'unknown']) {
      const bad = await bosun(['memory', 'update', id, '--status', status], { env, cwd: f.repo }); assert.equal(bad.code, 1, bad.err); assert.match(bad.err, /status.*must be one of/);
      assert.deepEqual(f.db.prepare('SELECT * FROM memories WHERE id=?').get(id), stored); assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM memory_events WHERE memory_id=?').get(id)!.n, 3);
    }
    const reopened = openLocalMemory(f.cfg);
    try {
      assert.equal((await reopened.get(id, f.ctx)).status, 'active');
      assert.equal(reopened.expire(Number(stored.expires_at) - 1), 0); assert.equal(reopened.expire(Number(stored.expires_at)), 1);
      const after = await reopened.get(id, f.ctx, { events: true }); assert.equal(after.status, 'archived'); assert.equal(after.version, 4);
      assert.deepEqual(after.events!.map((e) => e.op), ['store', 'expire', 'restore', 'expire']); assert.equal(after.events!.at(-1)!.at, stored.expires_at);
    } finally { reopened.close(); }
  } finally { f.close(); }
});

for (const floor of [false, true]) test(`${floor ? 'registered' : 'plain'} real stdio MCP restores expired public/private/malformed session notes and unshares without payload leaks`, async () => {
  const f = await fixture({ override: floor, floor }); let session: ReturnType<typeof mcpSession> | undefined;
  try {
    const local = openLocalMemory(f.cfg);
    const notes: { note: Memory; flag: number | string; archived: Memory }[] = [];
    for (const [i, flag] of [0, 1, 'false'].entries()) {
      const note = (await local.store({ category: 'session', title: `Restore session ${i}`, body: `RESTORE-PRIVATE-CANARY-${i}`, source: 'restore-source', sourceRef: 'restore-ref', shared: true }, f.ctx)).memory;
      notes.push({ note, flag, archived: await local.delete(note.id, f.ctx) });
    }
    local.close();
    const injected = openLocalSqlite(f.paths.primary, f.cfg);
    injected.transaction((db) => {
      for (const { note, flag } of notes) db.prepare('UPDATE memories SET private=?,expires_at=? WHERE id=?').run(flag, Date.now() - 1, note.id);
    }); injected.close();
    session = mcpSession(f.env(), f.repo); let rpc = 0;
    for (const { note, flag, archived } of notes) {
      const before = floor ? f.generation() : 0;
      const reply = await session.call('memory_update', { id: note.id, expectedVersion: archived.version, status: 'active', shared: false });
      assert.equal(reply.result.isError, undefined);
      if (flag !== 0) { assert.deepEqual(reply.result.structuredContent, { memory: { private: true } }); assert.doesNotMatch(JSON.stringify(reply), /RESTORE-PRIVATE-CANARY|restore-source|restore-ref|expiresAt|version|m_/); }
      else { assert.equal(reply.result.structuredContent.memory.id, note.id); assert.equal(reply.result.structuredContent.memory.status, 'active'); }
      const row = f.db.prepare('SELECT * FROM memories WHERE id=?').get(note.id)!;
      assert.equal(row.version, 3); assert.equal(row.status, 'active'); assert.equal(row.private, flag); assert.equal(row.shared, 0);
      assert.equal(row.expires_at, Number(row.updated_at) + Number(f.cfg.MEMORY_SESSION_TTL_DAYS) * DAY);
      assert.equal(row.hash, note.hash); assert.equal(row.id, note.id); assert.equal(row.created_at, note.createdAt); assert.equal(row.source_ref, note.sourceRef);
      assert.equal(floor ? f.generation() : 0, before + (floor ? 2 : 0));
      const events = f.db.prepare('SELECT op,at,source,hash_before,hash_after FROM memory_events WHERE memory_id=? ORDER BY id').all(note.id);
      assert.deepEqual(events.map((e) => e.op), ['store', 'archive', 'restore']); assert.equal(events.at(-1)!.at, row.updated_at); assert.equal(events.at(-1)!.source, 'mcp'); assert.equal(events.at(-1)!.hash_after, note.hash);
      const stale = await session.call('memory_update', { id: note.id, expectedVersion: 2, status: 'active' }); assert.deepEqual(stale.result.structuredContent, { error: { code: 'conflict' } });
      assert.deepEqual(f.db.prepare('SELECT * FROM memories WHERE id=?').get(note.id), row);
      const foreign = mcpSession(f.env(), gitRepo(f.sb, `foreign-${++rpc}`, `git@github.com:org/foreign-${rpc}.git`));
      try { assert.deepEqual((await foreign.call('memory_get', { id: note.id })).result.structuredContent, { error: { code: 'not_found' } }); } finally { await foreign.close(); }
    }
    await session.close(); session = undefined;
    const reopened = openLocalMemory(f.cfg);
    try {
      for (const { note } of notes) { const got = await reopened.get(note.id, f.ctx, { events: true }); assert.equal(got.status, 'active'); assert.equal(got.version, 3); assert.equal(got.events!.at(-1)!.op, 'restore'); }
    } finally { reopened.close(); }
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM memory_events WHERE op='expire' AND memory_id IN (SELECT id FROM memories WHERE title LIKE 'Restore session%')").get()!.n, 0);
  } finally { if (session) await session.close(); f.close(); }
});

test('registered stdio MCP keeps private replies opaque, conflict codes finite and docs on the real admission root', async () => {
  const f = await fixture(); const session = mcpSession(f.env(), f.repo);
  try {
    const call = (id: number, name: string, args: object) => session.rpc(id, 'tools/call', { name, arguments: args });
    const privateGet = await call(1, 'memory_get', { id: f.privateNote.id });
    assert.deepEqual(privateGet.result.structuredContent, { memory: { private: true } }); assert.doesNotMatch(JSON.stringify(privateGet), /PRIVATE|sourceRef|hash|events/);
    const updated = await call(2, 'memory_update', { id: f.publicNote.id, expectedVersion: 1, private: true });
    assert.deepEqual(updated.result.structuredContent, { memory: { private: true } });
    const conflict = await call(3, 'memory_update', { id: f.publicNote.id, expectedVersion: 1, body: 'attempted body' });
    assert.deepEqual(conflict.result.structuredContent, { error: { code: 'conflict' } }); assert.doesNotMatch(JSON.stringify(conflict), /currentVersion|attempted body|PRIVATE/);
    fs.writeFileSync(path.join(f.repo, 'mcp.md'), '# Admission zebra\nAdmission zebra MCP docs.');
    const docs = await call(4, 'context_retrieve', { task: 'admission zebra', sources: ['docs'] });
    assert.match(docs.result.structuredContent.text, /MCP docs/); assert.doesNotMatch(JSON.stringify(docs), /PRIVATE|backup_hash/);
    const search = await call(5, 'memory_search', { query: 'admission zebra' }); assert.deepEqual(search.result.structuredContent.hits, []);
  } finally { await session.close(); f.close(); }
});

test('registered authoritative serve ignores client MEMORY_URL and preserves owner API/private data and safe context', async () => {
  const f = await fixture();
  const child = spawn(process.execPath, [BIN, 'serve', 'memory', '--port', '0'], { env: f.env({ SERVE_BIND: '127.0.0.1', SERVE_ALLOW: '127.0.0.1/32', MEMORY_URL: 'http://127.0.0.1:1' }), cwd: f.repo, stdio: ['ignore', 'pipe', 'pipe'] });
  const ended = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  try {
    const port = await new Promise<number>((resolve, reject) => {
      let out = ''; const timer = setTimeout(() => reject(Error('synthetic serve startup timeout')), 3000);
      child.stdout.on('data', (b) => { out += b; const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)/); if (m) { clearTimeout(timer); resolve(Number(m[1])); } });
      child.once('exit', () => { clearTimeout(timer); reject(Error('synthetic serve exited before readiness')); });
    });
    const post = async (route: string, body: object) => {
      const response = await fetch(`http://127.0.0.1:${port}/v1/${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ctx: f.ctx, ...body }) });
      return { status: response.status, json: await response.json() as any };
    };
    const got = await post('memory/get', { id: f.privateNote.id }); assert.equal(got.status, 200); assert.equal(got.json.data.body, f.privateNote.body);
    const stored = await post('memory/store', { input: { category: 'personal', title: 'Server zebra', body: 'Server zebra body' } }); assert.equal(stored.status, 200);
    const bad = await post('memory/update', { id: stored.json.data.memory.id, patch: { body: 'bad version' }, expectedVersion: 99 });
    assert.equal(bad.status, 409); assert.equal(bad.json.error.current, 1);
    const context = await post('context/retrieve', { task: 'admission zebra' }); assert.equal(context.status, 200); assert.doesNotMatch(JSON.stringify(context.json), /PRIVATE/);
    assert.ok(f.generation() >= 5);
  } finally { child.kill('SIGTERM'); await ended; f.close(); }
});

test('registered gate lease blocks mutations, search touch stays best-effort, and failed constructor/startup releases lifecycle', async () => {
  const f = await fixture(); let local: MemoryService | undefined; const lease = new DatabaseSync(f.paths.view, { readOnly: true });
  try {
    lease.exec('BEGIN'); lease.prepare('SELECT * FROM bosun_cutover_gate').get();
    const prior = f.generation(); assert.throws(() => openLocalMemory(f.cfg), domain('unavailable'), 'constructor expiry cannot bypass gate lease');
    assert.equal(f.generation(), prior); assert.equal(f.db.prepare('SELECT status FROM memories WHERE id=?').get(f.expired.id)!.status, 'active');
    lease.exec('ROLLBACK'); local = openLocalMemory(f.cfg);
    lease.exec('BEGIN'); lease.prepare('SELECT * FROM bosun_cutover_gate').get();
    const beforeTouch = f.generation(); assert.equal((await local.search({ text: 'admission zebra' }, f.ctx)).length, 1);
    assert.equal(f.generation(), beforeTouch); assert.equal((await local.get(f.publicNote.id, f.ctx)).accessCount, 0);
    await assert.rejects(local.store({ category: 'personal', title: 'Held', body: 'held mutation' }, f.ctx), domain('unavailable'));
    lease.exec('ROLLBACK');
    await local.update(f.publicNote.id, { private: true }, 1, f.ctx);
    const listen = http.Server.prototype.listen; let closed = 0; const close = CutoverWriter.prototype.close;
    http.Server.prototype.listen = function () { throw Error('synthetic listen failure'); };
    CutoverWriter.prototype.close = function () { closed++; return close.call(this); };
    try { await assert.rejects(serveMain(['memory', '--port', '0'], { ...f.cfg, SERVE_BIND: '127.0.0.1' }), /synthetic listen failure/); assert.equal(closed, 1); }
    finally { http.Server.prototype.listen = listen; CutoverWriter.prototype.close = close; }
    f.db.exec('BEGIN IMMEDIATE'); f.db.exec('ROLLBACK');
  } finally { if (lease.isTransaction) lease.exec('ROLLBACK'); lease.close(); local?.close(); f.close(); }
});

test('registered discovery holds pending/unknown/mismatched roots before legacy chmod/migration', async () => {
  for (const kind of ['pending', 'override', 'mode', 'unknown', 'dangling', 'directory', 'ancestor']) {
    const f = await fixture({ floor: !['pending', 'dangling', 'directory', 'ancestor'].includes(kind) });
    try {
      if (kind === 'pending') await assert.rejects(cutoverMemory({ paths: f.paths, now: Date.now, id: crypto.randomUUID, checkpoint(phase) { if (phase === 'backup') throw Error('stop explicit operation'); } }));
      const cfg = kind === 'override' ? { ...f.cfg, MEMORY_VIEW_PATH: path.join(f.sb.root, 'missing-view.db') } : f.cfg;
      if (kind === 'mode') fs.chmodSync(f.paths.primary, 0o644);
      if (kind === 'unknown') f.db.exec('DROP TRIGGER bosun_floor_memories_update');
      if (kind === 'dangling') fs.symlinkSync(path.join(f.sb.root, 'never-created.db'), f.paths.view);
      if (kind === 'directory') fs.mkdirSync(f.paths.view);
      if (kind === 'ancestor') { fs.rmdirSync(path.dirname(f.paths.view)); fs.symlinkSync(path.join(f.sb.root, 'never-created-dir'), path.dirname(f.paths.view)); }
      const before = f.db.prepare('SELECT * FROM schema_migrations').all();
      assert.throws(() => openLocalMemory(cfg), (e: unknown) => { assert.ok(e instanceof MemoryError); assert.equal(e.code, 'unavailable'); assert.doesNotMatch(e.message, /missing-view|backup|PRIVATE/); return true; });
      assert.deepEqual(f.db.prepare('SELECT * FROM schema_migrations').all(), before);
      if (kind === 'mode') assert.equal(fs.statSync(f.paths.primary).mode & 0o777, 0o644, 'legacy chmod never ran');
    } finally { f.close(); }
  }
});

test('registered domain errors retain class/currentVersion after rollback while hostile proxy errors stay finite', async () => {
  const f = await fixture(); const session = openLocalSqlite(f.paths.primary, f.cfg); const writer = new CutoverWriter(f.paths);
  try {
    for (const error of [new MemoryError('not_found', 'memory not found'), new MemoryError('invalid', 'invalid owner request'), new MemoryError('conflict', 'owner conflict', 7)]) {
      assert.throws(() => session.transaction(() => { throw error; }), (e: unknown) => e === error && e instanceof MemoryError);
    }
    const proxy = () => new Proxy({}, { getPrototypeOf() { throw Error('PRIVATE prototype canary'); }, get() { throw Error('PRIVATE getter canary'); } });
    for (const invoke of [() => session.transaction(() => { throw proxy(); }), () => session.read(() => { throw proxy(); })]) {
      assert.throws(invoke, (e: unknown) => { assert.ok(e instanceof MemoryError); assert.equal(e.code, 'unavailable'); assert.doesNotMatch(e.message, /PRIVATE/); return true; });
    }
    assert.throws(() => writer.read((db) => db), CutoverError); assert.throws(() => writer.read((db) => db.prepare('SELECT id FROM memories')), CutoverError);
    assert.throws(() => session.transaction((db) => db), domain('unavailable')); assert.throws(() => writer.read(async () => []), CutoverError);
    const epoch = crypto.randomUUID(); f.db.prepare('UPDATE bosun_source_floor SET source_id=?').run(epoch);
    const gate = new DatabaseSync(f.paths.view); try { gate.prepare('UPDATE bosun_cutover_gate SET source_id=?').run(epoch); } finally { gate.close(); }
    assert.throws(() => session.read((db) => db.prepare('SELECT title FROM memories').all()), domain('unavailable'));
  } finally { writer.close(); session.close(); f.close(); }
});

test('read-only doctor memory inspection creates no files, holds WAL before native open and verifies rollback without writes', async () => {
  const sb = sandbox(); fresh(sb);
  const dir = path.join(sb.root, 'inspect'); fs.mkdirSync(dir); const file = path.join(dir, 'memory.db');
  try {
    const empty = footprint(dir); assert.deepEqual(inspectMemorySchema(file), { state: 'missing' }); assert.deepEqual(footprint(dir), empty);
    const db = openDb(file); db.close(); const wal = footprint(dir);
    assert.deepEqual(inspectMemorySchema(file), { state: 'wal-held' }); assert.deepEqual(footprint(dir), wal);
    const prepared = new DatabaseSync(file); prepared.exec('PRAGMA journal_mode=DELETE'); prepared.close(); const rollback = footprint(dir);
    assert.deepEqual(inspectMemorySchema(file), { state: 'verified', version: 1 }); assert.deepEqual(footprint(dir), rollback);
  } finally { sb.cleanup(); }
});

test('actual doctor leaves absent memory absent and the existing WAL database/sidecars unchanged', async () => {
  const sb = sandbox(); fresh(sb); load();
  try {
    const env = sb.env({ OLLAMA_URL: 'http://127.0.0.1:1', ROUTER_PORT: '1', HOSTS: 'claude,codex' });
    const missing = await bosun(['doctor'], { env }); assert.match(missing.out, /memory database absent/); assert.equal(fs.existsSync(P.DB), false);
    const db = openDb(P.DB); db.close();
    const files = [P.DB, P.DB + '-wal', P.DB + '-shm'];
    const state = () => files.map((file) => fs.existsSync(file) ? { bytes: fs.readFileSync(file), mode: fs.statSync(file).mode,
      mtime: fs.statSync(file, { bigint: true }).mtimeNs, ctime: fs.statSync(file, { bigint: true }).ctimeNs } : null);
    const before = state(); const held = await bosun(['doctor'], { env });
    assert.match(held.out, /WAL held; schema not verified by read-only doctor/); assert.deepEqual(state(), before);
  } finally { sb.cleanup(); }
});
