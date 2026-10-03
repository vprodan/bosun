import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sandbox, fresh, bosun, mock, gitRepo, claudeMemDb, type Sandbox } from './helpers.ts';
import { load, P } from '../lib/config.ts';
import { retrieve } from '../lib/context.ts';
import { ClaudeMem } from '../lib/memory/claudemem.ts';
import { Docs } from '../lib/memory/docs.ts';
import { makeCtx, project } from '../lib/memory/project.ts';
import { MemoryService } from '../lib/memory/service.ts';
import { openDb } from '../lib/memory/sqlite.ts';
import type { Ctx, Hit, MemoryProvider, Source } from '../lib/memory/types.ts';

// The pure retrieve() tests record metrics too: point them at a sandbox, never at your real ~/.bosun.
const pure = sandbox();
fresh(pure);
test.after(() => pure.cleanup());
const CTX: Ctx = { projectId: 'p_x', sessionId: null, linked: [] };
const O = { budgetTokens: 400, minScore: 0, itemChars: 400 };
const DAY = 86400000;
const fake = (name: Source, hits: Partial<Hit>[]): MemoryProvider => ({
  name, search: async () => hits.map((h, i) => ({ source: name, id: `${name}${i}`, title: 't', text: 'x', category: name === 'curated' ? 'project' : name, rank: -1, at: Date.now(), accessCount: 0, ...h })),
});

test('context: relevance and recency both count; sources are weighted', async () => {
  const now = Date.now();
  const r = await retrieve('cart pnpm', [fake('curated', [
    { id: 'old-strong', rank: -10, at: now - 365 * DAY, text: 'a' }, { id: 'new-weak', rank: -2, at: now, text: 'b' }, { id: 'old-weak', rank: -2, at: now - 365 * DAY, text: 'c' }])], CTX, O);
  assert.deepEqual(r.items.map((i) => i.id), ['old-strong', 'new-weak', 'old-weak']);
  const w = await retrieve('alpha beta', [fake('docs', [{ id: 'd', text: 'alpha' }]), fake('curated', [{ id: 'c', text: 'beta' }])], CTX, O);
  assert.deepEqual(w.items.map((i) => i.id), ['c', 'd'], 'curated outweighs docs at equal relevance');
  const u = await retrieve('alpha beta', [fake('curated', [{ id: 'unused', text: 'alpha one' }, { id: 'used', text: 'beta two', accessCount: 50 }])], CTX, O);
  assert.equal(u.items[0].id, 'used', 'usage breaks a tie');
});

test('context: dedupe across sources keeps the higher score', async () => {
  const r = await retrieve('pnpm tests', [fake('curated', [{ id: 'c', text: 'Run pnpm install before the tests in cart service' }]),
    fake('docs', [{ id: 'd', text: 'run pnpm install before the tests in cart service!' }, { id: 'e', text: 'unrelated text here' }])], CTX, O);
  assert.deepEqual(r.items.map((i) => i.id), ['c', 'e']);
});

test('context: budget is respected at the edges; items capped; min score; empty queries', async () => {
  const many = fake('curated', Array.from({ length: 20 }, (_, i) => ({ id: `m${i}`, rank: -(20 - i), title: `note ${i}`, text: `${'word '.repeat(100)}${i}` })));
  for (const budget of [10, 30, 100, 150, 400, 1000]) {
    const r = await retrieve('word', [many], CTX, { ...O, budgetTokens: budget });
    assert.ok(r.estTokens <= budget, `${r.estTokens} <= ${budget}`);
    assert.equal(r.estTokens, Math.ceil(r.text.length / 4));
    for (const l of r.text.split('\n').slice(1)) assert.ok(l.length <= 400, 'item capped');
  }
  assert.equal((await retrieve('word', [many], CTX, { ...O, budgetTokens: 10 })).text, '', 'nothing fits: nothing');
  assert.equal((await retrieve('word', [many], CTX, { ...O, budgetTokens: 1000 })).items.length, 9, 'greedy by score until full');
  assert.equal((await retrieve('word', [many], CTX, { ...O, minScore: 1.28 })).items.length, 1, 'nothing below min score');
  assert.equal((await retrieve('the a of', [many], CTX, O)).items.length, 0, 'no terms: no retrieval');
});

test('context: output format — one line per item: source, category, date, id, title and snippet', async () => {
  const f = await retrieve('title', [fake('curated', [{ id: 'm_1', title: 'Title', text: 'line one\nline two\n\n- bullet', at: Date.UTC(2026, 8, 1) }])], CTX, O);
  assert.equal(f.text, '[bosun memory: 1 note; memory_get <id> for details]\n- [curated project 2026-09-01 m_1] Title: line one line two - bullet');
  assert.deepEqual(f.sources, { curated: 1 });
  assert.equal(typeof f.ms, 'number');
});

test('claude-mem: this repo only, read-only; missing, off, schema mismatch and a locked database give [] and a warning', async () => {
  const sb = sandbox();
  try {
    fresh(sb);
    const cfg = load();
    const file = path.join(sb.root, 'cm.db');
    claudeMemDb(file, { obs: [{ project: 'shop', title: 'Checkout flow', narrative: 'checkout uses the cart token' }, { project: 'other', title: 'Checkout elsewhere', narrative: 'checkout in another repo' }],
      sums: [{ project: 'Shop', request: 'fix checkout', learned: 'checkout needs the cart token' }] });
    const before = fs.readFileSync(file);
    const cm = new ClaudeMem({ ...cfg, CLAUDE_MEM_DB: file }, ['shop']);
    const hits = await cm.search('checkout token', CTX, 20);
    assert.deepEqual(hits.map((h) => h.id).sort(), ['cm_o1', 'cm_s1']);
    assert.ok(hits.every((h) => h.source === 'claude-mem' && h.text.length > 0));
    assert.deepEqual(fs.readFileSync(file), before, 'never writes');
    assert.equal(cm.summaries(0, 10).length, 1);
    assert.deepEqual(await new ClaudeMem({ ...cfg, CLAUDE_MEM_DB: path.join(sb.root, 'none.db') }, ['shop']).search('checkout', CTX, 5), []);
    assert.deepEqual(await new ClaudeMem({ ...cfg, CLAUDE_MEM_DB: file, CLAUDE_MEM: 'off' }, ['shop']).search('checkout', CTX, 5), []);
    const bad = path.join(sb.root, 'bad.db');
    const b = new DatabaseSync(bad);
    b.exec('CREATE TABLE observations (id INTEGER)');
    b.close();
    assert.deepEqual(await new ClaudeMem({ ...cfg, CLAUDE_MEM_DB: bad }, ['shop']).search('checkout', CTX, 5), []);
    const lock = new DatabaseSync(file);
    lock.exec('PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;');
    assert.deepEqual(await cm.search('checkout', CTX, 5), []);
    lock.exec('ROLLBACK');
    lock.close();
    const warns = fs.readFileSync(path.join(P.BOSUN, 'bosun.log'), 'utf8').split('\n').filter((l) => l.includes('claude-mem.unavailable'));
    assert.equal(warns.length, 2, 'schema mismatch + locked');
  } finally { sb.cleanup(); }
});

test('docs index: this repo\'s Markdown only, re-read when the mtime changes, removed files leave the index', async () => {
  const sb = sandbox();
  try {
    fresh(sb);
    const repo = gitRepo(sb, 'shop');
    fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules\n');
    fs.writeFileSync(path.join(repo, 'README.md'), '# Shop\n\nThe checkout page lives in web/checkout.\n');
    fs.mkdirSync(path.join(repo, 'docs'));
    const deploy = path.join(repo, 'docs', 'deploy.md');
    fs.writeFileSync(deploy, '# Deploy\n\nArgoCD deploys main.\n');
    fs.mkdirSync(path.join(repo, 'node_modules', 'x'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'node_modules', 'x', 'README.md'), '# ignored checkout\n');
    const d = new Docs(openDb(path.join(sb.root, 'd.db')), repo, 'p_x');
    assert.deepEqual(d.index(), { changed: 2, removed: 0 });
    assert.deepEqual(d.index(), { changed: 0, removed: 0 }, 'unchanged files are not re-read');
    fs.writeFileSync(deploy, '# Deploy\n\nFlux deploys main now.\n');
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(deploy, later, later);
    assert.deepEqual(d.index(), { changed: 1, removed: 0 });
    const hits = await d.search('flux deploys', CTX, 5);
    assert.equal(hits[0].title, 'Deploy');
    assert.equal(hits[0].id, 'docs/deploy.md');
    fs.rmSync(path.join(repo, 'README.md'));
    assert.deepEqual(d.index(), { changed: 0, removed: 1 });
    assert.equal((await d.search('checkout', CTX, 5)).length, 0, 'ignored and removed files are not found');
  } finally { sb.cleanup(); }
});

async function seeded(sb: Sandbox): Promise<string> {
  const repo = gitRepo(sb, 'shop', 'git@github.com:org/shop.git');
  fresh(sb);
  const s = new MemoryService(openDb(P.DB), load());
  const ctx = makeCtx(load(), project(repo));
  await s.store({ category: 'project', title: 'Cart naming', body: 'getCart was renamed to fetchCart in cart-service; keep the old export for one release.' }, ctx);
  await s.store({ category: 'project', title: 'Private note', body: 'fetchCart secret PRIVATE-XYZ', private: true }, ctx);
  await s.store({ category: 'project', title: 'Rename checklist', body: `# Cart rename\n\nWhen you rename getCart in cart-service, update the imports.\n${'detail '.repeat(200)}\n- list item\n` }, ctx);
  s.close();
  return repo;
}

test('hook: memory block plus router hint in one additionalContext; silent below threshold; private left out; latency recorded', async () => {
  const sb = sandbox();
  const m = await mock();
  try {
    const repo = await seeded(sb);
    const hook = (prompt: string, extra = {}) => bosun(['route', '--hook', '--host', 'claude'], { env: sb.env({ ROUTER_URL: m.url, ...extra }), cwd: repo, input: JSON.stringify({ prompt, session_id: 's1' }) });
    const r = await hook('rename getCart to fetchCart in cart-service');
    const c: string = JSON.parse(r.out).hookSpecificOutput.additionalContext;
    assert.match(c, /^\[bosun memory: 2 notes/);
    assert.match(c, /Cart naming: getCart was renamed/);
    assert.match(c, /\n\n\[router kev-latest 12ms\] suggests: local/);
    assert.doesNotMatch(c, /PRIVATE-XYZ/);
    assert.equal((await hook('what does the payment thing do')).out, '', 'no matching memory and a low-confidence router: silent');
    const hi = JSON.parse((await hook('rename getCart to fetchCart in cart-service', { CONTEXT_HOOK_MIN_SCORE: '5' })).out).hookSpecificOutput.additionalContext;
    assert.doesNotMatch(hi, /bosun memory/, 'nothing reaches the min score');
    assert.match(hi, /suggests: local/);
    const rows = fs.readFileSync(path.join(sb.home, '.bosun', 'metrics.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((x) => x.op === 'hook');
    assert.equal(rows.length, 3);
    assert.ok(rows.every((x) => typeof x.ms === 'number'));
    assert.equal(rows[0].n, 2);
    assert.ok(rows[0].estTokens > 0 && rows[0].estTokens <= 400);
  } finally { await m.close(); sb.cleanup(); }
});

test('hook: one valid line per memory for multi-line bodies and a 50 KB prompt; fails open with a broken database', async () => {
  const sb = sandbox();
  const m = await mock();
  try {
    const repo = await seeded(sb);
    const hook = (prompt: string) => bosun(['route', '--hook'], { env: sb.env({ ROUTER_URL: m.url }), cwd: repo, input: JSON.stringify({ prompt }) });
    const big = `rename getCart to fetchCart ${'lorem ipsum dolor sit amet '.repeat(2000)}`;
    const r = await hook(big);
    const c: string = JSON.parse(r.out).hookSpecificOutput.additionalContext;
    const items = c.split('\n').filter((l) => l.startsWith('- ['));
    assert.ok(items.length >= 1);
    for (const l of items) assert.ok(l.length <= 400, `one line, capped: ${l.length}`);
    fs.writeFileSync(path.join(sb.home, '.bosun', 'memory.db'), 'not a database '.repeat(200));
    for (const f of ['memory.db-wal', 'memory.db-shm']) fs.rmSync(path.join(sb.home, '.bosun', f), { force: true });
    const broken = await hook('rename getCart to fetchCart in cart-service');
    assert.equal(broken.code, 0);
    const bc: string = JSON.parse(broken.out).hookSpecificOutput.additionalContext;
    assert.doesNotMatch(bc, /bosun memory/);
    assert.match(bc, /suggests: local/, 'the router hint still arrives');
    assert.match(fs.readFileSync(path.join(sb.home, '.bosun', 'bosun.log'), 'utf8'), /hook\.memory/);
  } finally { await m.close(); sb.cleanup(); }
});

test('hook: a prompt that shares just one common word with unrelated memories stays silent; a relevant one still gets its note', async () => {
  const sb = sandbox();
  const m = await mock();
  try {
    const repo = gitRepo(sb, 'shop', 'git@github.com:org/shop.git');
    fresh(sb);
    const s = new MemoryService(openDb(P.DB), load());
    const ctx = makeCtx(load(), project(repo));
    await s.store({ category: 'project', title: 'Use pnpm', body: 'Always use pnpm install; npm breaks the lockfile.' }, ctx);
    await s.store({ category: 'personal', title: 'Answer style', body: 'Give the answer first, then the detail.' }, ctx);
    await s.store({ category: 'project', title: 'Deploys', body: 'ArgoCD deploys main to production.' }, ctx);
    s.close();
    const hook = (prompt: string) => bosun(['route', '--hook'], { env: sb.env({ ROUTER_URL: m.url }), cwd: repo, input: JSON.stringify({ prompt }) });
    for (const p of ['write a test that uses the new parser', 'why does the login page flash on first load', 'explain what this code does in main']) {
      assert.equal((await hook(p)).out, '', p);
    }
    assert.match(JSON.parse((await hook('how do we deploy main to production')).out).hookSpecificOutput.additionalContext, /Deploys: ArgoCD/);
  } finally { await m.close(); sb.cleanup(); }
});

test('hook: without a memory database it creates none (users who never store anything pay nothing)', async () => {
  const sb = sandbox();
  const m = await mock();
  try {
    const repo = gitRepo(sb, 'shop', 'git@github.com:org/shop.git');
    const r = await bosun(['route', '--hook'], { env: sb.env({ ROUTER_URL: m.url }), cwd: repo, input: JSON.stringify({ prompt: 'rename getCart to fetchCart in cart-service' }) });
    assert.match(JSON.parse(r.out).hookSpecificOutput.additionalContext, /suggests: local/);
    assert.ok(!fs.existsSync(path.join(sb.home, '.bosun', 'memory.db')));
  } finally { await m.close(); sb.cleanup(); }
});
