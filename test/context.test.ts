import './bootstrap.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, bosun, gitRepo } from './helpers.ts';
import {
  createRetrieveContext,
  type ContextOptions,
} from '../src/core/use-cases/retrieve-context.ts';
import { contentHash } from '../src/platform/content-hash.ts';
import type { ContextSource } from '../src/core/ports/context-source.ts';
import { runtimeFixture } from './runtime-fixture.ts';
import type { Ctx } from '../src/core/domain/memory.ts';
import type { Hit, Source } from '../src/core/domain/context.ts';

const retrieve = (task: string, sources: ContextSource[], ctx: Ctx, options: ContextOptions) =>
  createRetrieveContext(sources, {
    now: Date.now,
    monotonic: () => performance.now(),
    hash: contentHash,
    dateLabel: (at) => new Date(at).toISOString().slice(0, 10),
    measure() {},
  })(task, ctx, options);
const CTX: Ctx = { projectId: 'p_x', sessionId: null, linked: [] };
const O = { budgetTokens: 400, minScore: 0, itemChars: 400 };
const DAY = 86400000;
const fake = (name: Source, hits: Partial<Hit>[]): ContextSource => ({
  id: name,
  trust: 'verified',
  weight: name === 'curated' ? 1 : name === 'docs' ? 0.8 : 0.6,
  halfLifeDays: name === 'curated' ? 60 : name === 'docs' ? 90 : 30,
  search: async () =>
    hits.map((h, i) => ({
      source: name,
      id: `${name}${i}`,
      title: 't',
      text: 'x',
      category: name === 'curated' ? 'project' : name,
      rank: -1,
      at: Date.now(),
      accessCount: 0,
      ...h,
    })),
});

test('context: relevance and recency both count; sources are weighted', async () => {
  const now = Date.now();
  const r = await retrieve(
    'cart pnpm',
    [
      fake('curated', [
        { id: 'old-strong', rank: -10, at: now - 365 * DAY, text: 'a' },
        { id: 'new-weak', rank: -2, at: now, text: 'b' },
        { id: 'old-weak', rank: -2, at: now - 365 * DAY, text: 'c' },
      ]),
    ],
    CTX,
    O,
  );
  assert.deepEqual(
    r.items.map((i) => i.id),
    ['old-strong', 'new-weak', 'old-weak'],
  );
  const w = await retrieve(
    'alpha beta',
    [fake('docs', [{ id: 'd', text: 'alpha' }]), fake('curated', [{ id: 'c', text: 'beta' }])],
    CTX,
    O,
  );
  assert.deepEqual(
    w.items.map((i) => i.id),
    ['c', 'd'],
    'curated outweighs docs at equal relevance',
  );
  const u = await retrieve(
    'alpha beta',
    [
      fake('curated', [
        { id: 'unused', text: 'alpha one' },
        { id: 'used', text: 'beta two', accessCount: 50 },
      ]),
    ],
    CTX,
    O,
  );
  assert.equal(u.items[0].id, 'used', 'usage breaks a tie');
});

test('context: dedupe across sources keeps the higher score', async () => {
  const r = await retrieve(
    'pnpm tests',
    [
      fake('curated', [{ id: 'c', text: 'Run pnpm install before the tests in cart service' }]),
      fake('docs', [
        { id: 'd', text: 'run pnpm install before the tests in cart service!' },
        { id: 'e', text: 'unrelated text here' },
      ]),
    ],
    CTX,
    O,
  );
  assert.deepEqual(
    r.items.map((i) => i.id),
    ['c', 'e'],
  );
});

test('context: budget is respected at the edges; items capped; min score; empty queries', async () => {
  const many = fake(
    'curated',
    Array.from({ length: 20 }, (_, i) => ({
      id: `m${i}`,
      rank: -(20 - i),
      title: `note ${i}`,
      text: `${'word '.repeat(100)}${i}`,
    })),
  );
  for (const budget of [10, 30, 100, 150, 400, 1000]) {
    const r = await retrieve('word', [many], CTX, { ...O, budgetTokens: budget });
    assert.ok(r.estTokens <= budget, `${r.estTokens} <= ${budget}`);
    assert.equal(r.estTokens, Math.ceil(r.text.length / 4));
    for (const l of r.text.split('\n').slice(1)) assert.ok(l.length <= 400, 'item capped');
  }
  assert.equal(
    (await retrieve('word', [many], CTX, { ...O, budgetTokens: 10 })).text,
    '',
    'nothing fits: nothing',
  );
  assert.equal(
    (await retrieve('word', [many], CTX, { ...O, budgetTokens: 1000 })).items.length,
    9,
    'greedy by score until full',
  );
  assert.equal(
    (await retrieve('word', [many], CTX, { ...O, minScore: 1.28 })).items.length,
    1,
    'nothing below min score',
  );
  assert.equal(
    (await retrieve('the a of', [many], CTX, O)).items.length,
    0,
    'no terms: no retrieval',
  );
});

test('context: output format — one line per item: source, category, date, id, title and snippet', async () => {
  const f = await retrieve(
    'title',
    [
      fake('curated', [
        {
          id: 'm_1',
          title: 'Title',
          text: 'line one\nline two\n\n- bullet',
          at: Date.UTC(2026, 8, 1),
        },
      ]),
    ],
    CTX,
    O,
  );
  assert.equal(
    f.text,
    '[bosun memory: 1 note; memory_get <id> for details]\n- [curated project 2026-09-01 m_1] Title: line one line two - bullet',
  );
  assert.deepEqual(f.sources, { curated: 1 });
  assert.equal(typeof f.ms, 'number');
});

type Fixture = Awaited<ReturnType<typeof runtimeFixture>>;
async function settled(f: Fixture, id: string) {
  let job = await f.rpc('job.get', { id });
  for (let n = 0; n < 200 && ['queued', 'running'].includes(job.state); n++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    job = await f.rpc('job.get', { id });
  }
  assert.equal(job.state, 'succeeded');
}
async function published(f: Fixture) {
  const queued = await f.rpc('memory.publish', {});
  await settled(f, queued.job.id);
}
async function seeded(toml = '') {
  const f = await runtimeFixture(toml);
  try {
    const notes = [];
    for (const input of [
      {
        title: 'Cart naming',
        body: 'getCart was renamed to fetchCart in cart-service; keep the old export for one release.',
      },
      { title: 'Private note', body: 'fetchCart secret PRIVATE-XYZ', private: true },
      {
        title: 'Rename checklist',
        body:
          '# Cart rename\n\nWhen you rename getCart in cart-service, update the imports.\n' +
          'detail '.repeat(200) +
          '\n- list item\n',
      },
    ])
      notes.push((await f.rpc('memory.store', { category: 'project', ...input })).memory);
    await published(f);
    return { f, notes };
  } catch (error) {
    await f.close();
    throw error;
  }
}
const hook = (f: Fixture, prompt: string, extra: Record<string, unknown> = {}) =>
  bosun(['route', '--hook'], {
    env: f.env,
    cwd: f.workspace,
    input: JSON.stringify({ prompt, cwd: f.workspace, session_id: 's1', ...extra }),
  });
function files(f: Fixture) {
  return [f.paths.memory, f.paths.view, f.paths.hookConfig].map((file) => {
    const stat = fs.statSync(file, { bigint: true });
    return {
      file,
      ino: stat.ino,
      mode: stat.mode,
      mtime: stat.mtimeNs,
      ctime: stat.ctimeNs,
      bytes: fs.readFileSync(file),
    };
  });
}

test('final hook delivers scoped original notes, withholds private data, stays below threshold and calls no router/provider', async () => {
  const { f, notes } = await seeded();
  try {
    const before = await f.rpc('memory.get', { id: notes[0].id, events: true });
    const result = await hook(f, 'rename getCart to fetchCart in cart-service');
    assert.equal(result.code, 0, result.err);
    const text: string = JSON.parse(result.out).hookSpecificOutput.additionalContext;
    assert.match(text, /^\[bosun memory: 2 notes/);
    assert.match(text, /Cart naming: getCart was renamed/);
    assert.ok(text.includes(notes[0].id));
    assert.ok(text.includes(notes[2].id));
    assert.doesNotMatch(text, /PRIVATE-XYZ|\[router /);
    assert.equal((await hook(f, 'what does the payment thing do')).out, '');
    assert.equal((await hook(f, 'rename getCart to fetchCart', { privacy: 'private' })).out, '');
    assert.deepEqual(await f.rpc('memory.get', { id: notes[0].id, events: true }), before);
    await f.runtime.close();
    const storage = files(f);
    assert.ok(
      (await hook(f, 'rename getCart to fetchCart in cart-service')).out,
      'qualified local fallback works with no daemon',
    );
    assert.deepEqual(
      files(f),
      storage,
      'hook fallback preserves source/view/config bytes and metadata',
    );
    assert.deepEqual(f.sb.calls(), [], 'no native/model/service process');
    assert.equal(
      fs.existsSync(path.join(f.paths.home, 'metrics.jsonl')),
      false,
      'hook does not append storage telemetry',
    );
  } finally {
    await f.close();
  }
  const high = await seeded('[context]\nhookMinScore=5\n');
  try {
    assert.equal((await hook(high.f, 'rename getCart to fetchCart in cart-service')).out, '');
    assert.deepEqual(high.f.sb.calls(), []);
  } finally {
    await high.f.close();
  }
});

test('final hook packs one capped line per multi-line note, bounds oversized input and stays silent on damaged source storage', async () => {
  const { f } = await seeded();
  try {
    const result = await hook(f, 'rename getCart to fetchCart in cart-service');
    assert.equal(result.code, 0, result.err);
    const text: string = JSON.parse(result.out).hookSpecificOutput.additionalContext;
    const lines = text.split('\n').filter((line) => line.startsWith('- ['));
    assert.equal(lines.length, 2);
    assert.ok(lines.every((line) => line.length <= 400));
    assert.ok(Math.ceil(text.length / 4) <= 400);
    await f.runtime.close();
    const before = files(f);
    assert.equal(
      (await hook(f, 'rename getCart to fetchCart ' + 'lorem ipsum '.repeat(5000))).out,
      '',
      'oversized hook is omitted before lookup',
    );
    assert.deepEqual(files(f), before);
    fs.writeFileSync(f.paths.memory, 'not a database '.repeat(200));
    const damaged = fs.readFileSync(f.paths.memory);
    const broken = await hook(f, 'rename getCart to fetchCart in cart-service');
    assert.equal(broken.code, 0);
    assert.equal(broken.out, '', 'uncertain source cannot authorize an old public snapshot');
    assert.deepEqual(fs.readFileSync(f.paths.memory), damaged, 'no automatic repair');
    assert.deepEqual(f.sb.calls(), []);
  } finally {
    await f.close();
  }
});

test('final hook rejects one-common-word memory and preserves relevant scoped context without inference', async () => {
  const f = await runtimeFixture();
  try {
    for (const input of [
      {
        category: 'project',
        title: 'Use pnpm',
        body: 'Always use pnpm install; npm breaks the lockfile.',
      },
      {
        category: 'personal',
        title: 'Answer style',
        body: 'Give the answer first, then the detail.',
      },
      { category: 'project', title: 'Deploys', body: 'ArgoCD deploys main to production.' },
    ])
      await f.rpc('memory.store', input);
    await published(f);
    for (const prompt of [
      'write a test that uses the new parser',
      'why does the login page flash on first load',
      'explain what this code does in main',
    ])
      assert.equal((await hook(f, prompt)).out, '', prompt);
    assert.match(
      JSON.parse((await hook(f, 'how do we deploy main to production')).out).hookSpecificOutput
        .additionalContext,
      /Deploys: ArgoCD/,
    );
    assert.deepEqual(f.sb.calls(), []);
  } finally {
    await f.close();
  }
});

test('final hook with missing memory creates nothing and runs no model/service', async () => {
  const sb = sandbox();
  try {
    const repo = gitRepo(sb, 'shop', 'git@github.com:org/shop.git');
    const result = await bosun(['route', '--hook'], {
      env: sb.env(),
      cwd: repo,
      input: JSON.stringify({ prompt: 'rename getCart to fetchCart in cart-service', cwd: repo }),
    });
    assert.equal(result.code, 0);
    assert.equal(result.out, '');
    assert.equal(fs.existsSync(path.join(sb.home, '.bosun')), false);
    assert.deepEqual(sb.calls(), []);
  } finally {
    sb.cleanup();
  }
});
