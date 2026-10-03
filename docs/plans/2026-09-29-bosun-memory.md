# bosun memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port bosun to TypeScript ESM and add a local-first memory layer: a curated SQLite + FTS5 store, a read-only claude-mem provider, a budgeted context manager behind the prompt hook, an LLM router with reviewed consolidation proposals, a hand-rolled stdio MCP server, and an optional split setup where Kev, the LLMs and memory each live on another machine.

**Architecture:** In-process modules and no daemon (spec approach A). `MemoryService` (SQLite) and `RemoteStore` (HTTP) implement one `MemoryApi`. The context manager ranks providers (curated, docs, claude-mem) and fits a token budget. The hook, `bosun mcp` and `bosun memory …` are thin callers. `bosun serve memory|kev` exists only for the split setup.

**Tech Stack:** Node ≥ 24.21 (ESM, native type stripping, `node:sqlite` with SQLite 3.53.4 and FTS5, `node:test`, `node:util.parseArgs`, `fetch`), TypeScript 6.0.3 and @types/node 26.6.2 for type checking only, macOS launchd, Ollama, Kev, Tailscale.

**Spec:** `docs/specs/2026-09-29-bosun-memory-design.md` (approved 2026-09-29). It builds on `docs/specs/2026-09-28-bosun-design.md`.

**No git repo:** the folder is not under git, so every task ends with a checkpoint (`npm test` plus the type check) recorded in `docs/plans/2026-09-29-bosun-memory-ledger.md`, not a commit.

## Global Constraints

- Node **≥ 24**, ESM TypeScript run by native type stripping: **erasable syntax only** (no enums, namespaces, parameter properties or `import =`). Relative imports end in `.ts`. Type-only imports use `import type`.
- **Zero runtime dependencies.** devDependencies `typescript` and `@types/node`, used only by `npm run typecheck`.
- **No installs while executing:** never `npm install`, `./install.sh`, `bosun install`, `claude mcp add`, `codex mcp add`, brew or model pulls. Tests run offline in a sandboxed HOME with stub CLIs and mock HTTP.
- **Type check without installing** (the TypeScript that is already in the npx cache):
  `N=~/.npm/_npx/a485ffc09709da64/node_modules; node $N/typescript/bin/tsc -p . --typeRoots $N/@types`
  After `npm install` the same check is `npm run typecheck`.
- **Never write to `~/.claude-mem`** (open it with `readOnly: true`). Tests build fixture databases. Anything run by hand uses `BOSUN_HOME=<scratch dir>`, so the real `~/.bosun` stays untouched.
- **Files:** `~/.bosun/memory.db` (mode 0600, WAL), `~/.bosun/bosun.log`, `~/.bosun/metrics.jsonl`, `~/.bosun/llm-usage.jsonl`. launchd labels `com.bosun.memory` and `com.bosun.kev-proxy`. The MCP server is named `bosun`.
- **MCP protocol:** `2025-11-25`, and it echoes `2025-06-18` and `2025-03-26`. `server/discover` → `-32601`, batch → `-32600`, parse error → `-32700` with `id: null`, unknown tool → `-32602`.
- **Defaults (verbatim from the spec):**
  - `CONTEXT_HOOK_BUDGET=400`, `CONTEXT_HOOK_MIN_SCORE=0.35`, `CONTEXT_ITEM_CHARS=400`, `MCP_MAX_CHARS=20000`
  - `MEMORY_SESSION_TTL_DAYS=7`, `MEMORY_PURGE_AFTER_DAYS=90`, `LLM_TIMEOUT_S=60`, `LLM_RETRIES=1`, `LLM_PROVIDERS=ollama`
  - `REMOTE_HOOK_TIMEOUT_MS=300`, `REMOTE_TIMEOUT_MS=5000`, memory port `8788`, Kev port `8009`
  - `SERVE_ALLOW` default `127.0.0.1/32,100.64.0.0/10` plus the subnet of `SERVE_BIND`
- **Ranking:** source weights curated 1.0, docs 0.8, claude-mem 0.6. Recency `0.3 × 2^(−age/halfLife)` with half-lives session 1 d, other curated 60 d, docs 90 d, claude-mem 30 d. Usage `0.05 × ln(1 + access_count)`. Dedupe by hash or Jaccard ≥ 0.8. Tokens are estimated as characters ÷ 4 and labelled `~`.
- **Limits:** title 1–200 characters, body 1–4,000, tags ≤ 12 × ≤ 40 characters of `[a-z0-9-]`, search limit ≤ 50, HTTP request bodies ≤ 64 KB.
- **Privacy:** logs and metrics never contain titles, bodies, prompts, tokens or keys. Error messages never quote stored content. Private memories never reach a host (hook, `memory_search`, `context_retrieve`) or a remote LLM.
- **Nothing removed:** no CLI command, flag or config key goes away.
- **Bind:** `bosun serve` never defaults to `0.0.0.0`.

## Review Focus

1. **Prompt or query text that looks like FTS5 syntax** (`"`, `*`, `NEAR(`, `AND`, `-x`, `col:val`, unbalanced parentheses, CJK, emoji, SQL): search must never throw and must treat it as plain words. Test in Task 2 ("user text never becomes FTS syntax").
2. **Two bosun processes writing at once** (the hook's access update, an MCP store, a CLI edit), and several processes opening a brand-new database at the same moment: the later writer waits (busy_timeout) instead of failing, and the migration runs once. Test in Task 2 ("concurrent writers wait").
3. **JSON-RPC ids that are `0` or strings, and tool calls sent before `initialize`:** every response echoes the id exactly, and tools work in any order. Test in Task 6.
4. **A `MEMORY_URL` that answers with something that isn't bosun** (an HTML 502 from a proxy, a server that never answers): the result is `unavailable`, never a crash, and the hook stays silent within `REMOTE_HOOK_TIMEOUT_MS`. Test in Task 7.
5. **Memory bodies with newlines, Markdown and long lines, and a 50 KB prompt:** each injected item stays one line of at most `CONTEXT_ITEM_CHARS`, the hook output stays valid JSON, and a long prompt is capped to 24 query terms. Test in Task 4.

## Deviations from the spec (small, recorded here so the reviewer can check them)

- **`docs` table:** it gets `seq INTEGER PRIMARY KEY` and `path TEXT NOT NULL UNIQUE`, and `docs_fts` uses `content_rowid='seq'`. An external-content FTS table must not follow implicit rowids, because `VACUUM` may renumber them.
- **`schema_migrations`** is created with `IF NOT EXISTS` before migrations run: the version has to be readable before migration 1.
- **Memory CLI verbs** live in `lib/memory/cli.ts`, and bench/eval in `lib/memory/bench.ts`. The spec's file list had no home for them, and `lib/cli.ts` is already 228 lines.
- **Docs rows are scoped by repo top-level path**, not only project id, so two worktrees of one project don't evict each other's rows.
- **Remote context:** the client ranks curated hits from `POST /v1/memory/search` itself, merged with its local docs and claude-mem hits. `POST /v1/context/retrieve` exists on the server, as specified, for clients that want server-side ranking.
- **`Ctx.source`** (optional) records who made a change (`cli`, `mcp`, `hook`) in `memory_events.source`.
- **`Query.touch: false`** lets internal searches (CLI listing, consolidation dedupe, eval, bench) skip the access-count update, so usage scores reflect only what reached a host.
- **Tags filter:** a memory matches when it has **any** of the given tags.

---

## File structure

```
bin/bosun                  ESM entry: enables the compile cache, then imports lib/cli.ts
package.json               "type": "module", engines node >= 24, typecheck script, devDependencies
tsconfig.json              strict, noEmit, nodenext, allowImportingTsExtensions, erasableSyntaxOnly
config.default.env         + memory, context, LLM, split-setup keys
lib/{cli,config,util,roles,route,services,orca,exec,wire}.ts   ported 1:1 (cli, route, wire, services gain memory parts)
lib/log.ts                 structured JSON-lines log, redaction
lib/metrics.ts             op timings → metrics.jsonl, quantiles, the stats report
lib/memory/types.ts        Memory, Category, Status, Ctx, Query, Hit, MemoryApi, MemoryProvider, MemoryError
lib/memory/sqlite.ts       openDb (0600, WAL, pragmas), MIGRATIONS, migrate, tx, terms/ftsQuery, hashing, Jaccard
lib/memory/project.ts      normalizeOrigin, project(dir), projectDir, makeCtx
lib/memory/service.ts      MemoryService (+ FIELDS/PATCH schemas, cleanTags), openMemory
lib/memory/claudemem.ts    ClaudeMem: read-only provider + session summaries for consolidation
lib/memory/docs.ts         Docs: repo Markdown index (incremental by mtime) + provider
lib/memory/remote.ts       RemoteStore: MemoryApi over HTTP (MEMORY_URL), health()
lib/memory/cli.ts          bosun memory add|search|get|update|delete|purge|review|accept|reject|prune|consolidate|stats|bench|eval
lib/memory/bench.ts        bench (synthetic corpus, measured numbers) and eval (recall@5, MRR)
lib/context.ts             retrieve(): rank, dedupe, budget, format; curated() adapter
lib/llm.ts                 generate(): ollama → openai → (opt-in) claude-cli, retries, JSON validation, usage log
lib/consolidate.ts         claude-mem summaries → proposed memories
lib/mcp.ts                 bosun mcp: JSON-RPC over stdio, 7 tools
lib/serve.ts               bosun serve memory|kev: bind, allowlist, /v1 API, Kev forwarder, authorize() point
test/helpers.ts            sandbox, fresh(sb, env), bosun, mock(routes), gitRepo, claudeMemDb
test/*.test.ts             ported 10 files + memory, context, llm, mcp, serve
ARCHITECTURE.md            new: architecture, data flow, measurements
```

---

### Task 1: TypeScript ESM port (behaviour unchanged)

**Files:**
- Create: `tsconfig.json`
- Modify: `package.json`, `bin/bosun`, `.gitignore`-free (none exists)
- Rename + port: `lib/*.js` → `lib/*.ts`, `test/*.js` → `test/*.ts` (including `test/helpers.js` → `test/helpers.ts`)
- Test: every existing test, plus one new config test

**Interfaces:**
- Produces: `P` with getters (`HOME`, `BOSUN`, `SHARE`, `LA`, `BIN`, `CLAUDE`, `CODEX`, `ORCA_CODEX`, `OLLAMA_APP`, `AGENTS_SKILLS`, `CFG`, `STATE`, `DB`, `TAILSCALE_APP`) and constants `REPO`, `DEFAULTS`. `type Cfg = Record<string, string>`. `VERSION: string` (from package.json). `fresh(sb, env?)` in helpers sets env only. Every later task imports modules statically.

- [ ] **Step 1: package.json, tsconfig.json, bin/bosun**

```json
{
  "name": "bosun",
  "version": "0.2.0",
  "private": true,
  "type": "module",
  "description": "Pair with one agent; bosun routes the rest to cheaper, local and other-vendor models, and remembers what matters. Claude Code + Codex + Orca.",
  "bin": { "bosun": "bin/bosun" },
  "engines": { "node": ">=24" },
  "scripts": { "test": "node --test test/*.test.ts", "typecheck": "tsc -p ." },
  "devDependencies": { "@types/node": "^26.6.2", "typescript": "^6.0.3" }
}
```

```json
{
  "compilerOptions": {
    "target": "esnext", "module": "nodenext", "moduleResolution": "nodenext",
    "strict": true, "noEmit": true, "skipLibCheck": true, "types": ["node"],
    "allowImportingTsExtensions": true, "erasableSyntaxOnly": true, "verbatimModuleSyntax": true
  },
  "include": ["lib/**/*.ts", "test/**/*.ts"]
}
```

`bin/bosun`:

```js
#!/usr/bin/env node
// Compile cache first: it keeps type-stripped TypeScript startup near plain JS (measured 33 ms vs 67 ms cold).
import { enableCompileCache } from 'node:module';
enableCompileCache();
const { main } = await import('../lib/cli.ts');
process.exitCode = await main(process.argv.slice(2));
```

- [ ] **Step 2: write the failing test for the one semantic change (paths follow HOME at call time)**

Add to `test/config.test.ts`:

```ts
test('config: paths follow HOME at call time, so tests switch sandboxes without reloading modules', () => {
  const a = sandbox();
  const b = sandbox();
  try {
    fresh(a);
    assert.equal(P.BOSUN, path.join(a.home, '.bosun'));
    fresh(b);
    assert.equal(P.CFG, path.join(b.home, '.bosun', 'config.env'));
    assert.equal(P.DB, path.join(b.home, '.bosun', 'memory.db'));
    fresh(b, { BOSUN_HOME: path.join(b.root, 'elsewhere') });
    assert.equal(P.STATE, path.join(b.root, 'elsewhere', 'state.json'));
  } finally { a.cleanup(); b.cleanup(); }
});
```

- [ ] **Step 3: port `lib/config.ts` (getters)**

```ts
// Settings: environment > ~/.bosun/config.env > config.default.env. Paths are getters over $HOME, so tests can sandbox them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { has, readJson, writeJson } from './util.ts';

export type Cfg = Record<string, string>;
const REPO = path.resolve(import.meta.dirname, '..');
export const VERSION: string = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
export const P = {
  REPO,
  DEFAULTS: path.join(REPO, 'config.default.env'),
  get HOME(): string { return os.homedir(); },
  get BOSUN(): string { return process.env.BOSUN_HOME || path.join(this.HOME, '.bosun'); },
  get SHARE(): string { return path.join(this.HOME, '.local', 'share', 'bosun'); },
  get LA(): string { return path.join(this.HOME, 'Library', 'LaunchAgents'); },
  get BIN(): string { return path.join(this.HOME, '.local', 'bin'); },
  get CLAUDE(): string { return path.join(this.HOME, '.claude'); },
  // ~/.codex, not an inherited CODEX_HOME: inside Orca that points at Orca's own managed runtime home
  get CODEX(): string { return process.env.BOSUN_CODEX_HOME || path.join(this.HOME, '.codex'); },
  get ORCA_CODEX(): string { return process.env.ORCA_CODEX_HOME || path.join(this.HOME, 'Library', 'Application Support', 'orca', 'codex-runtime-home', 'home'); },
  get OLLAMA_APP(): string { return process.env.BOSUN_OLLAMA_APP || '/Applications/Ollama.app'; },
  get TAILSCALE_APP(): string { return process.env.BOSUN_TAILSCALE_APP || '/Applications/Tailscale.app/Contents/MacOS/Tailscale'; },
  get AGENTS_SKILLS(): string { return path.join(this.HOME, '.agents', 'skills'); },
  get CFG(): string { return path.join(this.BOSUN, 'config.env'); },
  get STATE(): string { return path.join(this.BOSUN, 'state.json'); },
  get DB(): string { return path.join(this.BOSUN, 'memory.db'); },
};
```

The rest of `config.js` (`parse`, `load`, `setKey`, `spec`, `role`, `hosts`, `harness`, `state`, `saveState`) moves over unchanged, with types: `parse(file: string): Cfg`, `load(): Cfg`, `spec(value?: string): { model: string; effort: string }`, `state(): any`, `saveState(st: object): void`.

- [ ] **Step 4: port every other module and test with these mechanical rules**

1. Delete `'use strict'`. `const x = require('node:x')` → `import x from 'node:x'` (fs, path, os, crypto, readline, http) or named imports (`import { spawnSync } from 'node:child_process'`).
2. `require('./m')` → `import { … } from './m.ts'`. `module.exports = { … }` → `export` on each declaration.
3. `__dirname` → `import.meta.dirname`.
4. Types: parameters get annotations (`cfg: Cfg`, `argv: string[]`). Parsed JSON is `any`. `util.ts` exports `type Sh = { code: number; out: string; err: string }`. `exec.ts`/`orca.ts` share `export type Job = { cmd: string; args: string[]; set: Record<string, string>; unset: string[]; cwd?: string; stream?: string }` (exported from `orca.ts`). `BosunError` gets a declared `exitCode: number` field (no parameter properties). `die` returns `never`.
5. `jsonl(file)` moves from `route.ts` to `util.ts` (exported; route imports it). Later tasks reuse it.
6. `COMMANDS: Record<string, (argv: string[], cfg: Cfg) => number | void | Promise<number | void>>`.
7. Tests: `import test from 'node:test'`, `import assert from 'node:assert/strict'`, top-level imports of the lib modules they use. Every `fresh(sb, 'mod', env)` becomes `fresh(sb, env)` followed by direct use of the statically imported module. Inline `require('node:fs')` calls inside test bodies become top-level imports.
8. `test/helpers.ts`: `REPO = path.resolve(import.meta.dirname, '..')`. The STUB script stays CommonJS text (it's written into the sandbox, outside the package). `fresh` becomes:

```ts
// Point this process at a sandbox: HOME, PATH and stub output. Paths are getters, so nothing needs reloading.
export function fresh(sb: Sandbox, env: Record<string, string> = {}): void {
  Object.assign(process.env, { HOME: sb.home, PATH: sb.env().PATH, STUB_OUT: sb.out });
  for (const k of ['BOSUN_HOME', 'CODEX_HOME', 'ORCA_CODEX_HOME', 'ORCA_PANE_KEY', 'CLAUDECODE', 'CODEX_THREAD_ID', 'BOSUN_DEPTH',
    'BOSUN_OLLAMA_APP', 'STUB_MAP', 'CLAUDE_PROJECT_DIR', 'MEMORY_URL', 'OLLAMA_URL', 'ROUTER_URL', 'CLAUDE_MEM', 'CLAUDE_MEM_DB',
    'LLM_REMOTE', 'LLM_PROVIDERS', 'SERVE_BIND', 'SERVE_ALLOW']) delete process.env[k];
  Object.assign(process.env, { BOSUN_TAILSCALE_APP: path.join(sb.root, 'no-tailscale') }, env);
}
```

   `sandbox()` gets a return type `Sandbox`, and `sb.env()` also sets `BOSUN_TAILSCALE_APP` to the same missing path, so no test ever finds the real Tailscale app.

- [ ] **Step 5: run the suite and the type check**

Run: `npm test` → expected: 44 pass (43 ported + 1 new), 0 fail.
Run: `N=~/.npm/_npx/a485ffc09709da64/node_modules; node $N/typescript/bin/tsc -p . --typeRoots $N/@types` → expected: no output, exit 0.
Also run: `ls lib test | grep '\.js$'` → expected: nothing.

- [ ] **Step 6: measure startup against the §2 baseline**

Run (scratch HOME, so nothing lands in ~/.bosun):
`S=$(mktemp -d); for i in 1 2 3; do BOSUN_HOME=$S node bin/bosun help >/dev/null; done; time (for i in $(seq 20); do BOSUN_HOME=$S node bin/bosun help >/dev/null; done)`
Expected: record the per-run average in the ledger (baseline 58 ms).

- [ ] **Step 7: checkpoint** — record `npm test` and type-check results in the ledger.

---

### Task 2: Memory core — log, metrics, types, SQLite, project identity, MemoryService

**Files:**
- Create: `lib/log.ts`, `lib/metrics.ts`, `lib/memory/types.ts`, `lib/memory/sqlite.ts`, `lib/memory/project.ts`, `lib/memory/service.ts`
- Modify: `lib/util.ts` (add `Schema`, `validate`), `config.default.env` (memory keys), `test/helpers.ts` (`gitRepo`)
- Test: `test/memory.test.ts`

**Interfaces:**
- Consumes: `P`, `Cfg`, `load()` (Task 1), `sh`, `jsonl` (util).
- Produces:
  - `log(level: 'info'|'warn'|'error', event: string, fields?: Record<string, unknown>): void`
  - `record(m: Metric): void`, `timed<T>(op, fn, size?): Promise<T>`, `mute(): void`, `quantile(xs: number[], q: number): number`, `report(): string[]`
  - `validate(schema: Schema, value: unknown, at?: string): string | null`
  - types from `lib/memory/types.ts` (below)
  - `openDb(file: string, migrations?: string[]): DatabaseSync`, `migrate(db, migrations?): number`, `schemaVersion(db): number`, `tx<T>(db, fn: () => T): T`, `MIGRATIONS: string[]`, `terms(text: string, max?: number): string[]`, `ftsQuery(text: string): string`, `norm(s: string): string`, `contentHash(title: string, body: string): string`, `words(s: string): Set<string>`, `jaccard(a: Set<string>, b: Set<string>): number`
  - `normalizeOrigin(url: string): string`, `project(dir: string): Project` (`{ id: string; name: string }`), `projectDir(env?): string`, `makeCtx(cfg: Cfg, p: Project, sessionId?: string | null, source?: string): Ctx`
  - `class MemoryService implements MemoryApi` with extra `purge(id, ctx): Promise<void>`, `prune(now?): { archived: number; purged: number }`, `expire(now?): number`, `counts(): Record<string, number>`, public `db: DatabaseSync`
  - `FIELDS: Record<string, Schema>`, `PATCH: Schema`, `cleanTags(tags: unknown): string[]`, `openMemory(cfg: Cfg, timeoutMs?: number): MemoryApi`

- [ ] **Step 1: config keys** — append to `config.default.env`:

```
# ── Memory ───────────────────────────────────────────────────────────────
MEMORY_URL=                      # empty = local SQLite (~/.bosun/memory.db); http://host:8788 = a `bosun serve memory`
MEMORY_TOKEN=                    # sent as a Bearer token when set (v1 servers ignore it; auth comes later)
MEMORY_LINKED_PROJECTS=          # comma-separated project ids you can also read (`bosun memory stats` shows this one's)
MEMORY_SESSION_TTL_DAYS=7
MEMORY_PURGE_AFTER_DAYS=90       # archived memories older than this are purged by `bosun memory prune`
CLAUDE_MEM=on                    # off = don't read claude-mem
CLAUDE_MEM_DB=                   # empty = ~/.claude-mem/claude-mem.db (opened read-only)
CONTEXT_HOOK_BUDGET=400          # ~tokens of memory the prompt hook may add
CONTEXT_HOOK_MIN_SCORE=0.35
CONTEXT_ITEM_CHARS=400
MCP_MAX_CHARS=20000
```

- [ ] **Step 2: write the failing tests** — `test/memory.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { sandbox, fresh, gitRepo, REPO, type Sandbox } from './helpers.ts';
import { load, P } from '../lib/config.ts';
import { log } from '../lib/log.ts';
import { MemoryService } from '../lib/memory/service.ts';
import { openDb, schemaVersion, MIGRATIONS, terms } from '../lib/memory/sqlite.ts';
import { normalizeOrigin, project } from '../lib/memory/project.ts';
import { MemoryError, type Ctx } from '../lib/memory/types.ts';

const A: Ctx = { projectId: 'p_a', sessionId: 's1', linked: [] };
const B: Ctx = { projectId: 'p_b', sessionId: 's2', linked: [] };
const DAY = 86400000;
function svc(sb: Sandbox): MemoryService { fresh(sb); return new MemoryService(openDb(P.DB), load()); }   // P.DB read after fresh()
const code = (c: string) => (e: unknown) => e instanceof MemoryError && e.code === c;

test('memory: store/get/search round trip, FTS ranking, tags filter, limit cap, access counted', async () => {
  const sb = sandbox();
  try {
    const s = svc(sb);
    const a = await s.store({ category: 'project', title: 'Cart uses pnpm', body: 'Always run pnpm install in cart-service; npm breaks the lockfile.', tags: ['tooling'] }, A);
    assert.equal(a.duplicate, false);
    assert.match(a.memory.id, /^m_[0-9a-v]{9}[0-9a-f]{8}$/);
    assert.deepEqual(await s.get(a.memory.id, A), a.memory);
    await s.store({ category: 'project', title: 'Deploys', body: 'Deploys go through ArgoCD; pnpm is not involved.', tags: ['deploy'] }, A);
    assert.deepEqual((await s.search({ text: 'pnpm lockfile' }, A)).map((h) => h.title), ['Cart uses pnpm', 'Deploys'], 'more matching terms rank first');
    assert.deepEqual((await s.search({ text: 'pnpm', tags: ['deploy'] }, A)).map((h) => h.title), ['Deploys']);
    assert.ok((await s.get(a.memory.id, A)).accessCount >= 1, 'a search counts as access');
    for (let i = 0; i < 60; i++) await s.store({ category: 'project', title: `note ${i}`, body: `pnpm note number ${i}` }, A);
    assert.equal((await s.search({ text: 'pnpm', limit: 50 }, A)).length, 50);
    await assert.rejects(s.search({ text: 'pnpm', limit: 51 }, A), code('invalid'));
    assert.equal((await s.search({}, A)).length, 10, 'no text lists the newest');
    s.close();
  } finally { sb.cleanup(); }
});

test('memory: update checks the version and recomputes the hash; duplicates conflict; delete archives; purge only archived; events audit it all', async () => {
  const sb = sandbox();
  try {
    const s = svc(sb);
    const m = (await s.store({ category: 'project', title: 'T1', body: 'first body' }, A)).memory;
    const n = (await s.store({ category: 'project', title: 'T2', body: 'second body' }, A)).memory;
    await assert.rejects(s.update(m.id, { body: 'x' }, 2, A), (e) => code('conflict')(e) && (e as MemoryError).current === 1);
    const u = await s.update(m.id, { body: 'first body, edited' }, 1, A);
    assert.equal(u.version, 2);
    assert.notEqual(u.hash, m.hash);
    await assert.rejects(s.update(n.id, { title: 'T1', body: 'first body, edited' }, 1, A), (e) => code('conflict')(e) && /duplicate of m_/.test((e as Error).message));
    await assert.rejects(s.purge(n.id, A), code('invalid'));
    const d = await s.delete(n.id, A);
    assert.equal(d.status, 'archived');
    assert.equal((await s.delete(n.id, A)).version, d.version, 'delete is idempotent');
    await s.purge(n.id, A);
    await assert.rejects(s.get(n.id, A), code('not_found'));
    assert.deepEqual((await s.get(m.id, A, { events: true })).events!.map((e) => e.op), ['store', 'update']);
    const ops = (s.db.prepare('SELECT op FROM memory_events WHERE memory_id = ? ORDER BY id').all(n.id) as { op: string }[]).map((r) => r.op);
    assert.deepEqual(ops, ['store', 'archive', 'purge'], 'the audit trail outlives the content');
    s.close();
  } finally { sb.cleanup(); }
});

test('memory: an exact duplicate returns the existing memory; the hash ignores case and whitespace; category is part of the key', async () => {
  const sb = sandbox();
  try {
    const s = svc(sb);
    const a = await s.store({ category: 'personal', title: 'Indent', body: 'I prefer  two-space\nindentation' }, A);
    const b = await s.store({ category: 'personal', title: 'indent', body: 'i prefer two-space indentation' }, B);
    assert.equal(b.duplicate, true);
    assert.equal(b.memory.id, a.memory.id, 'personal memories dedupe across projects');
    assert.equal((await s.store({ category: 'project', title: 'Indent', body: 'I prefer two-space indentation' }, A)).duplicate, false);
    s.close();
  } finally { sb.cleanup(); }
});

test('memory: isolation — own project, personal, shared and linked are readable; other ids are not found; writes stay in scope', async () => {
  const sb = sandbox();
  try {
    const s = svc(sb);
    const pa = (await s.store({ category: 'project', title: 'A plan', body: 'alpha project detail' }, A)).memory;
    const pb = (await s.store({ category: 'project', title: 'B plan', body: 'beta project detail' }, B)).memory;
    const me = (await s.store({ category: 'personal', title: 'Me', body: 'personal project detail' }, A)).memory;
    const sh = (await s.store({ category: 'project', title: 'Shared B', body: 'shared project detail', shared: true }, B)).memory;
    const ids = async (ctx: Ctx) => (await s.search({ text: 'project detail' }, ctx)).map((h) => h.id).sort();
    assert.deepEqual(await ids(A), [pa.id, me.id, sh.id].sort());
    assert.deepEqual(await ids(B), [pb.id, me.id, sh.id].sort());
    await assert.rejects(s.get(pb.id, A), (e) => code('not_found')(e) && (e as Error).message === 'memory not found');
    await assert.rejects(s.update(pb.id, { body: 'x' }, 1, A), code('not_found'));
    assert.ok((await ids({ ...A, linked: ['p_b'] })).includes(pb.id), 'linked projects are readable');
    await assert.rejects(s.update(sh.id, { body: 'x' }, 1, A), /another project/);
    await assert.rejects(s.store({ category: 'project', title: 't', body: 'b' }, { ...A, projectId: null }), code('invalid'));
    s.close();
  } finally { sb.cleanup(); }
});

test('project: ssh, https and other origin spellings are one project; worktrees share an id; fallbacks without a remote', () => {
  const sb = sandbox();
  try {
    fresh(sb);
    for (const u of ['git@github.com:Org/Repo.git', 'https://github.com/org/repo', 'https://user:tok@github.com/org/repo.git/', 'ssh://git@github.com:22/org/repo.git', 'github.com:org/repo']) {
      assert.equal(normalizeOrigin(u), 'github.com/org/repo', u);
    }
    const r1 = gitRepo(sb, 'one', 'git@github.com:org/repo.git');
    const r2 = gitRepo(sb, 'two', 'https://github.com/Org/Repo');
    assert.equal(project(r1).id, project(r2).id, 'a clone on another machine is the same project');
    assert.equal(project(r1).name, 'repo');
    fs.mkdirSync(path.join(r1, 'src'));
    assert.equal(project(path.join(r1, 'src')).id, project(r1).id, 'subdirectories too');
    const r3 = gitRepo(sb, 'three');
    const wt = path.join(sb.root, 'three-wt');
    spawnSyncGit(r3, 'worktree', 'add', '-q', wt);
    assert.equal(project(wt).id, project(r3).id, 'a worktree of a repo without a remote shares its id');
    assert.equal(project(wt).name, 'three');
    const plain = path.join(sb.root, 'plain');
    fs.mkdirSync(plain);
    assert.match(project(plain).id, /^p_[0-9a-f]{16}$/);
    assert.equal(project(plain).name, 'plain');
  } finally { sb.cleanup(); }
});

test('memory: session memories expire into archived on open; prune purges old archived ones', async () => {
  const sb = sandbox();
  try {
    const s1 = svc(sb);
    const m = (await s1.store({ category: 'session', title: 'wip', body: 'session scratch' }, A)).memory;
    assert.equal(m.expiresAt, m.createdAt + 7 * DAY);
    assert.equal(m.sessionId, 's1');
    s1.db.prepare('UPDATE memories SET expires_at = ? WHERE id = ?').run(Date.now() - 1, m.id);
    s1.close();
    const s2 = svc(sb);
    const g = await s2.get(m.id, A, { events: true });
    assert.equal(g.status, 'archived');
    assert.equal(g.events!.at(-1)!.op, 'expire');
    s2.db.prepare('UPDATE memories SET updated_at = ? WHERE id = ?').run(Date.now() - 91 * DAY, m.id);
    assert.deepEqual(s2.prune(), { archived: 0, purged: 1 });
    await assert.rejects(s2.get(m.id, A), code('not_found'));
    s2.close();
  } finally { sb.cleanup(); }
});

test('memory: validation limits, and error messages never quote content', async () => {
  const sb = sandbox();
  try {
    const s = svc(sb);
    const ok = { category: 'project', title: 't', body: 'b' };
    const bad: object[] = [
      { ...ok, category: 'nope' }, { ...ok, title: '' }, { ...ok, title: '   ' }, { ...ok, title: 'x'.repeat(201) },
      { ...ok, body: 'x'.repeat(4001) }, { ...ok, tags: Array(13).fill('a') }, { ...ok, tags: ['Bad Tag'] },
      { ...ok, tags: ['x'.repeat(41)] }, { ...ok, ttlDays: 0 }, { ...ok, projectId: 'p_b' },
    ];
    for (const input of bad) await assert.rejects(s.store(input as never, A), code('invalid'), JSON.stringify(input).slice(0, 60));
    await assert.rejects(s.store({ category: 'project', title: `${'x'.repeat(201)}SECRET`, body: 'b' }, A), (e) => !(e as Error).message.includes('SECRET'));
    assert.equal((await s.store({ ...ok, tags: ['a', 'a'] } as never, A)).memory.tags.length, 1);
    s.close();
  } finally { sb.cleanup(); }
});

test('memory: user text never becomes FTS syntax', async () => {
  const sb = sandbox();
  try {
    const s = svc(sb);
    await s.store({ category: 'project', title: 'Quotes', body: 'he said "NEAR" and AND OR NOT then (x*) -y col:val 日本語 🚀' }, A);
    for (const q of ['"', '"unbalanced', 'a AND', 'NEAR(a b)', '(x*', '-y', 'col:val', 'title:hack', '*', '日本語', '🚀', 'OR OR', "'; DROP TABLE memories; --"]) {
      await s.search({ text: q }, A);
    }
    assert.equal((await s.search({ text: 'NEAR' }, A)).length, 1, 'NEAR is a plain word');
    assert.equal((await s.search({ text: '日本語' }, A)).length, 1);
    assert.equal((await s.search({ text: 'the a of' }, A)).length, 0, 'only stop words: no search, not a listing');
    assert.deepEqual(terms('fetchCart get_cart HTTPServer the a'), ['fetchcart', 'fetch', 'cart', 'get_cart', 'get', 'httpserver', 'http', 'server']);
    assert.equal(terms('word '.repeat(10) + Array.from({ length: 40 }, (_, i) => `t${i}x`).join(' ')).length, 24, 'capped');
    s.close();
  } finally { sb.cleanup(); }
});

test('memory: concurrent writers wait instead of failing; a new database opened by three processes at once migrates once', async () => {
  const sb = sandbox();
  try {
    fresh(sb);
    const file = path.join(sb.root, 'c.db');
    const node = (code: string, ...args: string[]) => spawn(process.execPath, ['--input-type=module', '-e', code, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const exit = (p: ReturnType<typeof spawn>) => new Promise<number>((res) => p.on('close', (c) => res(c ?? 1)));
    const opener = `import { openDb } from ${JSON.stringify(path.join(REPO, 'lib', 'memory', 'sqlite.ts'))}; openDb(process.argv[1]).close();`;
    assert.deepEqual(await Promise.all([0, 1, 2].map(() => exit(node(opener, file)))), [0, 0, 0]);
    const s = new MemoryService(openDb(file), load());
    assert.equal(schemaVersion(s.db), MIGRATIONS.length);
    const holder = node(`import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(process.argv[1]); db.exec('BEGIN IMMEDIATE'); console.log('locked'); setTimeout(() => db.exec('COMMIT'), 400);`, file);
    await new Promise((res) => holder.stdout!.once('data', res));
    const t = Date.now();
    await s.store({ category: 'project', title: 'while locked', body: 'waits for the other writer' }, A);
    assert.ok(Date.now() - t >= 100, 'it waited for the lock');
    assert.equal(await exit(holder), 0);
    s.close();
  } finally { sb.cleanup(); }
});

test('migrations: fresh → latest; v1 → v2; a failing migration rolls back and leaves the database as it was; file mode 0600', () => {
  const sb = sandbox();
  try {
    fresh(sb);
    const file = path.join(sb.root, 'm.db');
    const db = openDb(file);
    assert.equal(schemaVersion(db), MIGRATIONS.length);
    db.close();
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const v2 = [...MIGRATIONS, 'CREATE TABLE extra (x INTEGER)'];
    const db2 = openDb(file, v2);
    assert.equal(schemaVersion(db2), 2);
    db2.close();
    assert.throws(() => openDb(file, [...v2, 'CREATE TABLE ok_part (x INTEGER); CREATE TABLE memories (x INTEGER);']), /already exists/);
    const db3 = openDb(file, v2);
    assert.equal(schemaVersion(db3), 2);
    assert.equal((db3.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'ok_part'").get() as { n: number }).n, 0, 'rolled back');
    db3.close();
  } finally { sb.cleanup(); }
});

test('memory: private memories stay out of search unless asked; logs and metrics never hold content', async () => {
  const sb = sandbox();
  try {
    const s = svc(sb);
    const p = (await s.store({ category: 'project', title: 'Private SECRET-TITLE', body: 'SECRET-BODY value', private: true }, A)).memory;
    assert.equal((await s.search({ text: 'value' }, A)).length, 0);
    assert.equal((await s.search({ text: 'value', includePrivate: true }, A)).length, 1);
    await s.get(p.id, A);
    await s.update(p.id, { body: 'SECRET-BODY two' }, 1, A);
    await assert.rejects(s.store({ category: 'project', title: 'SECRET-TITLE', body: 'x'.repeat(4001) }, A));
    log('warn', 'test', { title: 'SECRET-TITLE', err: new SyntaxError('Unexpected token S, "SECRET-BODY" is not valid JSON') });
    for (const f of ['bosun.log', 'metrics.jsonl']) assert.doesNotMatch(fs.readFileSync(path.join(P.BOSUN, f), 'utf8'), /SECRET/, f);
    s.close();
  } finally { sb.cleanup(); }
});
```

Helpers used above: `spawnSyncGit(cwd, ...args)` is a local one-liner in the test (`spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd })`), and `gitRepo` goes into `test/helpers.ts`:

```ts
// A git repo under the sandbox with one commit, and an origin remote when given.
export function gitRepo(sb: Sandbox, name: string, origin?: string): string {
  const dir = path.join(sb.root, name);
  fs.mkdirSync(dir, { recursive: true });
  const git = (...a: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir });
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  if (origin) git('remote', 'add', 'origin', origin);
  return dir;
}
```

- [ ] **Step 3: run to verify they fail**

Run: `node --test test/memory.test.ts` → expected: FAIL, `Cannot find module …/lib/memory/service.ts`.

- [ ] **Step 4: `lib/util.ts` — the JSON Schema subset**

```ts
// The JSON Schema subset bosun uses (MCP tool input, the memory API, LLM output). Error messages name the path, never the value.
export type Schema = {
  type?: 'object' | 'array' | 'string' | 'integer' | 'number' | 'boolean'; description?: string;
  properties?: Record<string, Schema>; required?: string[]; additionalProperties?: boolean;
  items?: Schema; maxItems?: number; enum?: readonly unknown[];
  minLength?: number; maxLength?: number; pattern?: string; minimum?: number; maximum?: number;
};
export function validate(s: Schema, v: unknown, at = '$'): string | null {
  if (s.type === 'object') {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return `${at}: expected an object`;
    const o = v as Record<string, unknown>;
    for (const k of s.required || []) if (o[k] === undefined) return `${at}.${k}: required`;
    for (const [k, x] of Object.entries(o)) {
      if (x === undefined) continue;
      const p = s.properties?.[k];
      if (!p) { if (s.additionalProperties === false) return `${at}.${k}: unknown field`; continue; }
      const e = validate(p, x, `${at}.${k}`);
      if (e) return e;
    }
  } else if (s.type === 'array') {
    if (!Array.isArray(v)) return `${at}: expected an array`;
    if (s.maxItems !== undefined && v.length > s.maxItems) return `${at}: more than ${s.maxItems} items`;
    if (s.items) for (const [i, x] of v.entries()) { const e = validate(s.items, x, `${at}[${i}]`); if (e) return e; }
  } else if (s.type === 'string') {
    if (typeof v !== 'string') return `${at}: expected a string`;
    if (s.minLength !== undefined && v.length < s.minLength) return `${at}: shorter than ${s.minLength}`;
    if (s.maxLength !== undefined && v.length > s.maxLength) return `${at}: longer than ${s.maxLength}`;
    if (s.pattern && !new RegExp(s.pattern, 'u').test(v)) return `${at}: invalid format`;
  } else if (s.type === 'integer' || s.type === 'number') {
    if (typeof v !== 'number' || !Number.isFinite(v) || (s.type === 'integer' && !Number.isInteger(v))) return `${at}: expected ${s.type === 'integer' ? 'an integer' : 'a number'}`;
    if (s.minimum !== undefined && v < s.minimum) return `${at}: below ${s.minimum}`;
    if (s.maximum !== undefined && v > s.maximum) return `${at}: above ${s.maximum}`;
  } else if (s.type === 'boolean' && typeof v !== 'boolean') return `${at}: expected true or false`;
  if (s.enum && !s.enum.includes(v)) return `${at}: must be one of ${s.enum.join(', ')}`;
  return null;
}
```

- [ ] **Step 5: `lib/log.ts` and `lib/metrics.ts`**

```ts
// Structured JSON-lines log (~/.bosun/bosun.log). Metadata only: content-bearing fields and error messages never reach it.
import fs from 'node:fs';
import path from 'node:path';
import { P } from './config.ts';

const CONTENT = /title|body|prompt|text|content|snippet|query|task|token|key|secret|password|auth/i;
const clean = (k: string, v: unknown): unknown => (v instanceof Error
  ? { name: v.name, code: (v as { code?: unknown }).code }   // a message can quote content ("… is not valid JSON")
  : CONTENT.test(k) ? '[redacted]' : v);

export function log(level: 'info' | 'warn' | 'error', event: string, fields: Record<string, unknown> = {}): void {
  try {
    fs.mkdirSync(P.BOSUN, { recursive: true });
    const safe = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, clean(k, v)]));
    fs.appendFileSync(path.join(P.BOSUN, 'bosun.log'), `${JSON.stringify({ ts: new Date().toISOString(), level, event, ...safe })}\n`);
  } catch { /* logging never breaks a caller */ }
}
```

```ts
// Operation timings and sizes (~/.bosun/metrics.jsonl) and the report behind `bosun memory stats`. Numbers only, never content.
import fs from 'node:fs';
import path from 'node:path';
import { P } from './config.ts';
import { jsonl } from './util.ts';

export type Metric = { op: string; ms: number; n?: number; chars?: number; estTokens?: number; provider?: string; ok?: boolean };
const FILE = () => path.join(P.BOSUN, 'metrics.jsonl');
let muted = false;
export const mute = (): void => { muted = true; };   // bench: a synthetic corpus must not skew your stats

export function record(m: Metric): void {
  if (muted) return;
  try {
    fs.mkdirSync(P.BOSUN, { recursive: true });
    fs.appendFileSync(FILE(), `${JSON.stringify({ ts: Date.now(), ...m, ms: Math.round(m.ms * 100) / 100 })}\n`);
  } catch { /* metrics never break a caller */ }
}

// Times fn and records it, also when it throws.
export async function timed<T>(op: string, fn: () => T | Promise<T>, size: (r: T) => Omit<Metric, 'op' | 'ms'> = () => ({})): Promise<T> {
  const t = performance.now();
  try {
    const r = await fn();
    record({ op, ms: performance.now() - t, ok: true, ...size(r) });
    return r;
  } catch (e) { record({ op, ms: performance.now() - t, ok: false }); throw e; }
}

export const quantile = (xs: number[], q: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0;
};
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const sum = (xs: number[]) => xs.reduce((a, b) => a + (b || 0), 0);

export function report(): string[] {
  const rows = jsonl(FILE()) as Metric[];
  const usage = jsonl(path.join(P.BOSUN, 'llm-usage.jsonl'));
  if (!rows.length && !usage.length) return [`no metrics yet (${FILE()})`];
  const by = new Map<string, Metric[]>();
  for (const r of rows) by.set(r.op, [...(by.get(r.op) || []), r]);
  const out = [`${'op'.padEnd(22)} ${'n'.padStart(6)} ${'p50 ms'.padStart(9)} ${'p95 ms'.padStart(9)}`];
  for (const [op, rs] of [...by].sort(([a], [b]) => a.localeCompare(b))) {
    const ms = rs.map((r) => r.ms);
    out.push(`${op.padEnd(22)} ${String(rs.length).padStart(6)} ${quantile(ms, 0.5).toFixed(1).padStart(9)} ${quantile(ms, 0.95).toFixed(1).padStart(9)}`);
  }
  const hook = by.get('hook') || [];
  const inj = hook.filter((r) => (r.n || 0) > 0);
  const ctx = by.get('context.retrieve') || [];
  out.push('',
    `hook: ${inj.length} with memory, ${hook.length - inj.length} without; ~${avg(inj.map((r) => r.estTokens || 0)).toFixed(0)} tokens and ${avg(inj.map((r) => r.n || 0)).toFixed(1)} items per injection (estimated)`,
    `context: ${ctx.length} retrievals, ~${avg(ctx.map((r) => r.estTokens || 0)).toFixed(0)} tokens and ${avg(ctx.map((r) => r.n || 0)).toFixed(1)} items on average`,
    `llm: ${usage.length} calls, ${usage.filter((u) => u.ok).length} ok, ${avg(usage.map((u) => u.ms)).toFixed(0)} ms average, tokens in/out ${sum(usage.map((u) => u.tokensIn))}/${sum(usage.map((u) => u.tokensOut))}`,
    `remote calls: ${rows.filter((r) => r.op.startsWith('remote.')).length}`);
  return out;
}
```

- [ ] **Step 6: `lib/memory/types.ts`**

```ts
// The memory model shared by the store, the remote client, the context manager and MCP.
export type Category = 'personal' | 'project' | 'session';
export type Status = 'active' | 'proposed' | 'archived';
export const CATEGORIES: Category[] = ['personal', 'project', 'session'];
export const STATUSES: Status[] = ['active', 'proposed', 'archived'];

// Who is asking. Always built from the caller's environment (cwd, CLAUDE_PROJECT_DIR), never from tool arguments.
export type Ctx = { projectId: string | null; sessionId: string | null; linked: string[]; source?: string };

export type Memory = {
  id: string; category: Category; projectId: string | null; sessionId: string | null;
  title: string; body: string; tags: string[]; status: Status; shared: boolean; private: boolean;
  source: string; sourceRef: string | null; hash: string;
  createdAt: number; updatedAt: number; expiresAt: number | null; accessedAt: number | null; accessCount: number; version: number;
};
export type MemoryEvent = { op: string; at: number; source: string; hashBefore: string | null; hashAfter: string | null };
export type StoreInput = {
  category: Category; title: string; body: string; tags?: string[]; private?: boolean; shared?: boolean; ttlDays?: number;
  status?: 'active' | 'proposed'; source?: string; sourceRef?: string;
};
export type Patch = { title?: string; body?: string; tags?: string[]; status?: 'active' | 'archived'; private?: boolean; shared?: boolean };
export type Query = { text?: string; category?: Category; status?: Status[]; tags?: string[]; limit?: number; includePrivate?: boolean; touch?: boolean };
export type Found = Memory & { rank: number };   // rank = FTS5 bm25(): lower is better; 0 when listing without text

export type ErrorCode = 'not_found' | 'conflict' | 'invalid' | 'unavailable';
// Messages never quote stored content: they reach hosts, HTTP clients and logs.
export class MemoryError extends Error {
  code: ErrorCode;
  current?: number;
  constructor(code: ErrorCode, message: string, current?: number) { super(message); this.code = code; this.current = current; }
}

// The operations that travel between a client and a memory server. MemoryService is local; RemoteStore is HTTP.
export interface MemoryApi {
  store(input: StoreInput, ctx: Ctx): Promise<{ memory: Memory; duplicate: boolean }>;
  search(q: Query, ctx: Ctx): Promise<Found[]>;
  get(id: string, ctx: Ctx, opts?: { events?: boolean }): Promise<Memory & { events?: MemoryEvent[] }>;
  update(id: string, patch: Patch, expectedVersion: number, ctx: Ctx): Promise<Memory>;
  delete(id: string, ctx: Ctx): Promise<Memory>;
  accept(id: string, ctx: Ctx): Promise<Memory>;
  reject(id: string, ctx: Ctx): Promise<Memory>;
  close(): void;
}

// What the context manager ranks: curated memory, project docs, claude-mem.
export type Source = 'curated' | 'docs' | 'claude-mem';
export type Hit = { source: Source; id: string; title: string; text: string; category: string; rank: number; at: number; accessCount: number; hash?: string };
export interface MemoryProvider { name: Source; search(text: string, ctx: Ctx, limit: number): Promise<Hit[]> }
```

- [ ] **Step 7: `lib/memory/sqlite.ts`**

```ts
// SQLite through node:sqlite: open (0600, WAL), ordered migrations in transactions, FTS5 query building, text hashing.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { log } from '../log.ts';
import { record } from '../metrics.ts';

export const MIGRATIONS: string[] = [`
CREATE TABLE memories (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL CHECK (category IN ('personal','project','session')),
  project_id TEXT,
  session_id TEXT,
  title TEXT NOT NULL, body TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','proposed','archived')),
  shared INTEGER NOT NULL DEFAULT 0, private INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL, source_ref TEXT, hash TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER,
  accessed_at INTEGER, access_count INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1,
  CHECK ((category = 'personal') = (project_id IS NULL))
);
CREATE UNIQUE INDEX memories_dedupe ON memories(COALESCE(project_id, ''), category, hash) WHERE status <> 'archived';
CREATE INDEX memories_scope ON memories(project_id, category, status);
CREATE INDEX memories_expiry ON memories(expires_at) WHERE expires_at IS NOT NULL;
CREATE VIRTUAL TABLE memories_fts USING fts5(title, body, tags, content='memories', content_rowid='seq', tokenize='porter unicode61');
CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, title, body, tags) VALUES (new.seq, new.title, new.body, new.tags);
END;
CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, body, tags) VALUES ('delete', old.seq, old.title, old.body, old.tags);
END;
CREATE TRIGGER memories_au AFTER UPDATE OF title, body, tags ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, body, tags) VALUES ('delete', old.seq, old.title, old.body, old.tags);
  INSERT INTO memories_fts(rowid, title, body, tags) VALUES (new.seq, new.title, new.body, new.tags);
END;
CREATE TABLE memory_events (id INTEGER PRIMARY KEY, memory_id TEXT NOT NULL, op TEXT NOT NULL, at INTEGER NOT NULL,
  source TEXT NOT NULL, hash_before TEXT, hash_after TEXT);
CREATE INDEX memory_events_memory ON memory_events(memory_id);
CREATE TABLE docs (seq INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL, mtime INTEGER NOT NULL, title TEXT, body TEXT NOT NULL);
CREATE VIRTUAL TABLE docs_fts USING fts5(title, body, content='docs', content_rowid='seq', tokenize='porter unicode61');
CREATE TRIGGER docs_ai AFTER INSERT ON docs BEGIN INSERT INTO docs_fts(rowid, title, body) VALUES (new.seq, new.title, new.body); END;
CREATE TRIGGER docs_ad AFTER DELETE ON docs BEGIN INSERT INTO docs_fts(docs_fts, rowid, title, body) VALUES ('delete', old.seq, old.title, old.body); END;
CREATE TRIGGER docs_au AFTER UPDATE ON docs BEGIN
  INSERT INTO docs_fts(docs_fts, rowid, title, body) VALUES ('delete', old.seq, old.title, old.body);
  INSERT INTO docs_fts(rowid, title, body) VALUES (new.seq, new.title, new.body);
END;
`];

export function openDb(file: string, migrations: string[] = MIGRATIONS): DatabaseSync {
  const t = performance.now();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.closeSync(fs.openSync(file, 'a', 0o600));   // exists as 0600 before SQLite opens it; -wal and -shm copy its mode
  fs.chmodSync(file, 0o600);
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout = 2000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    migrate(db, migrations);
  } catch (e) { db.close(); throw e; }
  record({ op: 'db.open', ms: performance.now() - t });
  return db;
}

export const schemaVersion = (db: DatabaseSync): number =>
  Number((db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get() as { v: number }).v);

// Each migration runs with its schema_migrations row in one BEGIN IMMEDIATE; an error rolls it back and aborts.
// The version is re-read inside the transaction, so processes opening a new database at once migrate it only once.
export function migrate(db: DatabaseSync, migrations: string[] = MIGRATIONS): number {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
  while (schemaVersion(db) < migrations.length) {
    tx(db, () => {
      const v = schemaVersion(db);
      if (v >= migrations.length) return;
      db.exec(migrations[v]);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(v + 1, Date.now());
      log('info', 'db.migrate', { version: v + 1 });
    });
  }
  return schemaVersion(db);
}

export function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// ── Text: deterministic query terms (user text never becomes FTS syntax), hashing, word-set overlap ──
const STOP = new Set(('a an and are as at be been but by can could did do does for from had has have how i if in into is it its '
  + 'just me my no not of on or our please should so some than that the their them then there these they this those to too up us '
  + 'was we were what when where which who why will with would you your').split(' '));

// fetchCart → fetchcart, fetch, cart; get_cart → get_cart, get, cart. Stop words and 1-letter tokens go. Capped at max terms.
export function terms(text: string, max = 24): string[] {
  const out = new Set<string>();
  for (const raw of text.slice(0, 20000).match(/[\p{L}\p{N}_]+/gu) || []) {
    const parts = raw.split('_').flatMap((p) => p.split(/(?<=[\p{Ll}\p{N}])(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})/u));
    for (const t of [raw, ...parts].map((x) => x.toLowerCase())) {
      if (t.length > 1 && !STOP.has(t)) out.add(t);
      if (out.size >= max) return [...out];
    }
  }
  return [...out];
}
// Every term quoted, OR-joined: '"fetchcart" OR "fetch" OR "cart"'. Empty when nothing is left.
export const ftsQuery = (text: string): string => terms(text).map((t) => `"${t}"`).join(' OR ');

export const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();
export const contentHash = (title: string, body: string): string =>
  crypto.createHash('sha256').update(norm(`${title}\n${body}`)).digest('hex').slice(0, 32);
export const words = (s: string): Set<string> => new Set(norm(s).match(/[\p{L}\p{N}]+/gu) || []);
export function jaccard(a: Set<string>, b: Set<string>): number {
  let both = 0;
  for (const w of a) if (b.has(w)) both++;
  const union = a.size + b.size - both;
  return union ? both / union : 1;
}
```

- [ ] **Step 8: `lib/memory/project.ts`**

```ts
// Project identity: a hash of the normalized git origin URL, so every clone and every worktree of a repo is one project.
// No origin: git's common dir (shared by worktrees). Not a repo: the directory itself.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Cfg } from '../config.ts';
import { sh } from '../util.ts';
import type { Ctx } from './types.ts';

export type Project = { id: string; name: string };
const hashId = (key: string) => `p_${crypto.createHash('sha256').update(key).digest('hex').slice(0, 16)}`;

// git@github.com:Org/Repo.git, https://user@github.com/org/repo, ssh://git@github.com:22/org/repo → github.com/org/repo
export function normalizeOrigin(url: string): string {
  let u = url.trim().toLowerCase().replace(/\/+$/, '').replace(/\.git$/, '');
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//;
  const scp = scheme.test(u) ? null : u.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/);
  u = scp ? `${scp[1]}/${scp[2]}` : u.replace(scheme, '').replace(/^[^@/]+@/, '').replace(/^([^/:]+):\d+\//, '$1/');
  return u.replace(/\/+/g, '/');
}

export function project(dir: string): Project {
  const origin = sh('git', ['-C', dir, 'config', '--get', 'remote.origin.url']);
  if (origin.code === 0 && origin.out) {
    const n = normalizeOrigin(origin.out);
    return { id: hashId(`origin:${n}`), name: path.basename(n) };
  }
  const common = sh('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
  let base = dir;
  try { base = fs.realpathSync(common.code === 0 && common.out ? common.out : dir); } catch { /* keep dir */ }
  const root = path.basename(base) === '.git' ? path.dirname(base) : base;
  return { id: hashId(`path:${base}`), name: path.basename(root).replace(/\.git$/, '') };
}

// The directory whose project we serve: the host's project dir when it tells us, else our cwd.
export const projectDir = (env: NodeJS.ProcessEnv = process.env): string => env.CLAUDE_PROJECT_DIR || process.cwd();

export const makeCtx = (cfg: Cfg, p: Project, sessionId: string | null = null, source?: string): Ctx => ({
  projectId: p.id, sessionId, source,
  linked: (cfg.MEMORY_LINKED_PROJECTS || '').split(',').map((s) => s.trim()).filter(Boolean),
});
```

- [ ] **Step 9: `lib/memory/service.ts`**

```ts
// MemoryService: the curated store over SQLite. Validation, dedupe, provenance (an event per change), retention, isolation.
import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { P, type Cfg } from '../config.ts';
import { timed } from '../metrics.ts';
import { validate, type Schema } from '../util.ts';
import { contentHash, ftsQuery, openDb, tx } from './sqlite.ts';
import { CATEGORIES, STATUSES, MemoryError, type Ctx, type Found, type Memory, type MemoryApi, type MemoryEvent, type Patch, type Query, type StoreInput } from './types.ts';

const text = (max: number): Schema => ({ type: 'string', minLength: 1, maxLength: max, pattern: '\\S' });
// Shared with MCP: the tool schemas are built from these, so every entry point enforces the same limits.
export const FIELDS: Record<string, Schema> = {
  category: { type: 'string', enum: CATEGORIES, description: 'personal (you, in every project), project (this repo), session (expires after a week)' },
  title: text(200),
  body: text(4000),
  tags: { type: 'array', maxItems: 12, items: { type: 'string', pattern: '^[a-z0-9-]{1,40}$' } },
  private: { type: 'boolean', description: 'never shown to the model or sent to a remote LLM' },
  shared: { type: 'boolean', description: 'readable from every project' },
  ttlDays: { type: 'integer', minimum: 1, maximum: 3650 },
};
const STORE: Schema = { type: 'object', additionalProperties: false, required: ['category', 'title', 'body'], properties: {
  ...FIELDS, status: { type: 'string', enum: ['active', 'proposed'] }, source: { type: 'string', maxLength: 200 }, sourceRef: { type: 'string', maxLength: 200 } } };
export const PATCH: Schema = { type: 'object', additionalProperties: false, properties: {
  title: FIELDS.title, body: FIELDS.body, tags: FIELDS.tags, private: FIELDS.private, shared: FIELDS.shared,
  status: { type: 'string', enum: ['active', 'archived'], description: 'active accepts a proposal or restores; archived deletes softly' } } };
const QUERY: Schema = { type: 'object', additionalProperties: false, properties: {
  text: { type: 'string', maxLength: 20000 }, category: FIELDS.category, tags: FIELDS.tags,
  status: { type: 'array', maxItems: 3, items: { type: 'string', enum: STATUSES } },
  limit: { type: 'integer', minimum: 1, maximum: 50 }, includePrivate: { type: 'boolean' }, touch: { type: 'boolean' } } };
const ID: Schema = { type: 'string', minLength: 1, maxLength: 64 };
const VERSION_NO: Schema = { type: 'integer', minimum: 1 };
const DAY = 86400000;

function check(schema: Schema, v: unknown): void {
  const e = validate(schema, v);
  if (e) throw new MemoryError('invalid', e);
}
// LLM-suggested tags → valid ones: lowercase, [a-z0-9-], deduped, at most 12.
export const cleanTags = (tags: unknown): string[] => (Array.isArray(tags)
  ? [...new Set(tags.map((t) => String(t).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)).filter(Boolean))].slice(0, 12)
  : []);

// Readable: personal, this project, shared, linked projects. Writable: personal and this project only.
const READ = '(m.project_id IS NULL OR m.project_id = :pid OR m.shared = 1 OR m.project_id IN (SELECT value FROM json_each(:linked)))';
type Row = Record<string, any>;
const scope = (ctx: Ctx) => ({ pid: ctx.projectId, linked: JSON.stringify(ctx.linked) });
const newId = () => `m_${Date.now().toString(32).padStart(9, '0')}${crypto.randomBytes(4).toString('hex')}`;
const toMemory = (r: Row): Memory => ({
  id: r.id, category: r.category, projectId: r.project_id, sessionId: r.session_id, title: r.title, body: r.body, tags: JSON.parse(r.tags),
  status: r.status, shared: !!r.shared, private: !!r.private, source: r.source, sourceRef: r.source_ref, hash: r.hash,
  createdAt: r.created_at, updatedAt: r.updated_at, expiresAt: r.expires_at, accessedAt: r.accessed_at, accessCount: r.access_count, version: r.version,
});

export class MemoryService implements MemoryApi {
  db: DatabaseSync;
  cfg: Cfg;
  constructor(db: DatabaseSync, cfg: Cfg) { this.db = db; this.cfg = cfg; this.expire(); }
  close(): void { this.db.close(); }

  // Retention, applied lazily on open: expired memories are archived, each with an event.
  expire(now = Date.now()): number {
    if (!this.db.prepare("SELECT 1 FROM memories WHERE expires_at <= ? AND status <> 'archived' LIMIT 1").get(now)) return 0;
    return tx(this.db, () => {
      this.db.prepare(`INSERT INTO memory_events (memory_id, op, at, source, hash_before, hash_after)
        SELECT id, 'expire', ?, 'retention', hash, hash FROM memories WHERE expires_at <= ? AND status <> 'archived'`).run(now, now);
      return Number(this.db.prepare("UPDATE memories SET status = 'archived', updated_at = ?, version = version + 1 WHERE expires_at <= ? AND status <> 'archived'").run(now, now).changes);
    });
  }

  private event(id: string, op: string, source: string, before: string | null, after: string | null, at = Date.now()): void {
    this.db.prepare('INSERT INTO memory_events (memory_id, op, at, source, hash_before, hash_after) VALUES (?, ?, ?, ?, ?, ?)').run(id, op, at, source, before, after);
  }
  private bySeq(seq: number): Memory { return toMemory(this.db.prepare('SELECT * FROM memories WHERE seq = ?').get(seq) as Row); }
  // Out-of-scope ids are "not found", never "forbidden": no existence leaks.
  private row(id: unknown, ctx: Ctx): Row {
    check(ID, id);
    const r = this.db.prepare(`SELECT * FROM memories m WHERE m.id = :id AND ${READ}`).get({ id: id as string, ...scope(ctx) });
    if (!r) throw new MemoryError('not_found', 'memory not found');
    return r as Row;
  }
  private writable(id: unknown, ctx: Ctx): Row {
    const r = this.row(id, ctx);
    if (r.project_id !== null && r.project_id !== ctx.projectId) throw new MemoryError('invalid', 'that memory belongs to another project (read-only here)');
    return r;
  }

  store(input: StoreInput, ctx: Ctx) {
    return timed('memory.store', () => {
      check(STORE, input);
      const title = input.title.trim();
      const body = input.body.trim();
      const cat = input.category;
      if (cat !== 'personal' && !ctx.projectId) throw new MemoryError('invalid', `${cat} memories need a project directory`);
      const projectId = cat === 'personal' ? null : ctx.projectId;
      const hash = contentHash(title, body);
      const now = Date.now();
      const ttl = input.ttlDays ?? (cat === 'session' ? Number(this.cfg.MEMORY_SESSION_TTL_DAYS) : null);
      const source = input.source || ctx.source || 'api';
      return tx(this.db, () => {
        const dup = this.db.prepare("SELECT * FROM memories WHERE COALESCE(project_id, '') = ? AND category = ? AND hash = ? AND status <> 'archived'").get(projectId ?? '', cat, hash);
        if (dup) return { memory: toMemory(dup as Row), duplicate: true };
        const id = newId();
        const r = this.db.prepare(`INSERT INTO memories (id, category, project_id, session_id, title, body, tags, status, shared, private, source, source_ref, hash, created_at, updated_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, cat, projectId, cat === 'session' ? ctx.sessionId : null, title, body,
          JSON.stringify([...new Set(input.tags || [])]), input.status || 'active', input.shared ? 1 : 0, input.private ? 1 : 0,
          source, input.sourceRef ?? null, hash, now, now, ttl ? now + ttl * DAY : null);
        this.event(id, input.status === 'proposed' ? 'propose' : 'store', source, null, hash, now);
        return { memory: this.bySeq(Number(r.lastInsertRowid)), duplicate: false };
      });
    }, (r) => ({ chars: r.memory.body.length }));
  }

  search(q: Query, ctx: Ctx): Promise<Found[]> {
    return timed('memory.search', () => {
      check(QUERY, q);
      const match = q.text ? ftsQuery(q.text) : '';
      if (q.text?.trim() && !match) return [];   // only stop words: nothing to search for
      const params = { ...scope(ctx), statuses: JSON.stringify(q.status?.length ? q.status : ['active']), category: q.category ?? null,
        private: q.includePrivate ? 1 : 0, tags: q.tags?.length ? JSON.stringify(q.tags) : null, limit: q.limit ?? 10 };
      const filter = `${READ} AND m.status IN (SELECT value FROM json_each(:statuses)) AND (:category IS NULL OR m.category = :category)
        AND (:private = 1 OR m.private = 0)
        AND (:tags IS NULL OR EXISTS (SELECT 1 FROM json_each(m.tags) t WHERE t.value IN (SELECT value FROM json_each(:tags))))`;
      const rows = (match
        ? this.db.prepare(`SELECT m.*, bm25(memories_fts) AS rank FROM memories_fts JOIN memories m ON m.seq = memories_fts.rowid
            WHERE memories_fts MATCH :match AND ${filter} ORDER BY bm25(memories_fts) LIMIT :limit`).all({ ...params, match })
        : this.db.prepare(`SELECT m.*, 0 AS rank FROM memories m WHERE ${filter} ORDER BY m.updated_at DESC, m.seq DESC LIMIT :limit`).all(params)) as Row[];
      if (match && rows.length && q.touch !== false) this.touch(rows.map((r) => r.id));
      return rows.map((r) => ({ ...toMemory(r), rank: r.rank }));
    }, (r) => ({ n: r.length }));
  }
  private touch(ids: string[]): void {
    try {
      this.db.prepare('UPDATE memories SET accessed_at = ?, access_count = access_count + 1 WHERE id IN (SELECT value FROM json_each(?))').run(Date.now(), JSON.stringify(ids));
    } catch { /* a busy database must not fail a read */ }
  }

  get(id: string, ctx: Ctx, opts: { events?: boolean } = {}) {
    return timed('memory.get', (): Memory & { events?: MemoryEvent[] } => {
      const m = toMemory(this.row(id, ctx));
      if (!opts.events) return m;
      const events = (this.db.prepare('SELECT op, at, source, hash_before, hash_after FROM memory_events WHERE memory_id = ? ORDER BY id').all(m.id) as Row[])
        .map((e) => ({ op: e.op, at: e.at, source: e.source, hashBefore: e.hash_before, hashAfter: e.hash_after }));
      return { ...m, events };
    });
  }

  update(id: string, patch: Patch, expectedVersion: number, ctx: Ctx) {
    return timed('memory.update', () => {
      check(PATCH, patch);
      check(VERSION_NO, expectedVersion);
      return tx(this.db, () => {
        const cur = this.writable(id, ctx);
        if (cur.version !== expectedVersion) throw new MemoryError('conflict', `version conflict: current version is ${cur.version}`, cur.version);
        const title = patch.title?.trim() ?? cur.title;
        const body = patch.body?.trim() ?? cur.body;
        const status = patch.status ?? cur.status;
        const hash = contentHash(title, body);
        if (status !== 'archived') {
          const dup = this.db.prepare("SELECT id FROM memories WHERE COALESCE(project_id, '') = ? AND category = ? AND hash = ? AND status <> 'archived' AND seq <> ?")
            .get(cur.project_id ?? '', cur.category, hash, cur.seq) as Row | undefined;
          if (dup) throw new MemoryError('conflict', `duplicate of ${dup.id}`, cur.version);
        }
        const now = Date.now();
        this.db.prepare('UPDATE memories SET title = ?, body = ?, tags = ?, status = ?, private = ?, shared = ?, hash = ?, updated_at = ?, version = version + 1 WHERE seq = ?')
          .run(title, body, patch.tags ? JSON.stringify([...new Set(patch.tags)]) : cur.tags, status,
            patch.private === undefined ? cur.private : Number(patch.private), patch.shared === undefined ? cur.shared : Number(patch.shared), hash, now, cur.seq);
        const op = status === cur.status ? 'update'
          : status === 'archived' ? (cur.status === 'proposed' ? 'reject' : 'archive')
            : cur.status === 'proposed' ? 'accept' : 'restore';
        this.event(cur.id, op, ctx.source || 'api', cur.hash, hash, now);
        return this.bySeq(cur.seq);
      });
    });
  }

  delete(id: string, ctx: Ctx) {
    return timed('memory.delete', () => tx(this.db, () => {
      const cur = this.writable(id, ctx);
      if (cur.status !== 'archived') {
        this.db.prepare("UPDATE memories SET status = 'archived', updated_at = ?, version = version + 1 WHERE seq = ?").run(Date.now(), cur.seq);
        this.event(cur.id, 'archive', ctx.source || 'api', cur.hash, cur.hash);
      }
      return this.bySeq(cur.seq);
    }));
  }

  accept(id: string, ctx: Ctx) { return this.decide(id, ctx, 'active'); }
  reject(id: string, ctx: Ctx) { return this.decide(id, ctx, 'archived'); }
  private async decide(id: string, ctx: Ctx, to: 'active' | 'archived'): Promise<Memory> {
    const cur = await this.get(id, ctx);
    if (cur.status !== 'proposed') throw new MemoryError('invalid', `not a proposal (status ${cur.status})`);
    return this.update(id, { status: to }, cur.version, ctx);
  }

  // Hard delete, archived memories only. Their events stay: the audit trail outlives the content.
  purge(id: string, ctx: Ctx): Promise<void> {
    return timed('memory.purge', () => tx(this.db, () => {
      const cur = this.writable(id, ctx);
      if (cur.status !== 'archived') throw new MemoryError('invalid', 'only archived memories can be purged: delete it first');
      this.db.prepare('DELETE FROM memories WHERE seq = ?').run(cur.seq);
      this.event(cur.id, 'purge', ctx.source || 'api', cur.hash, null);
    }));
  }

  // Archives expired memories; purges archived ones untouched for MEMORY_PURGE_AFTER_DAYS.
  prune(now = Date.now()): { archived: number; purged: number } {
    const archived = this.expire(now);
    const cutoff = now - Number(this.cfg.MEMORY_PURGE_AFTER_DAYS) * DAY;
    const purged = tx(this.db, () => {
      this.db.prepare("INSERT INTO memory_events (memory_id, op, at, source, hash_before, hash_after) SELECT id, 'purge', ?, 'retention', hash, NULL FROM memories WHERE status = 'archived' AND updated_at < ?").run(now, cutoff);
      return Number(this.db.prepare("DELETE FROM memories WHERE status = 'archived' AND updated_at < ?").run(cutoff).changes);
    });
    return { archived, purged };
  }

  counts(): Record<string, number> {
    return Object.fromEntries((this.db.prepare('SELECT status, COUNT(*) AS n FROM memories GROUP BY status').all() as Row[]).map((r) => [r.status, r.n]));
  }
}

// The memory store for this machine's config. Task 7 adds the MEMORY_URL (RemoteStore) branch.
export function openMemory(cfg: Cfg, timeoutMs?: number): MemoryApi {
  void timeoutMs;
  return new MemoryService(openDb(P.DB), cfg);
}
```

- [ ] **Step 10: run the tests**

Run: `node --test test/memory.test.ts` → expected: 11 pass.
Run: `npm test` and the type check → expected: all pass, no type errors.

- [ ] **Step 11: checkpoint** in the ledger.

---

### Task 3: `bosun memory` CLI (store, search, review, audit, stats)

**Files:**
- Create: `lib/memory/cli.ts`
- Modify: `lib/cli.ts` (`memory` command, usage line, `MemoryError` → exit 1)
- Test: `test/memory.test.ts` (append)

**Interfaces:**
- Consumes: `openMemory`, `MemoryService`, `project`, `projectDir`, `makeCtx`, `report` (Task 2).
- Produces: `main(argv: string[], cfg: Cfg): Promise<number>` in `lib/memory/cli.ts`. Tasks 5 and 8 add the `consolidate`, `add --auto`, `bench` and `eval` verbs to it.

- [ ] **Step 1: write the failing test**

```ts
test('memory cli: add, duplicate, search, get with events, update, delete, purge, proposals, stats, bad usage', async () => {
  const sb = sandbox();
  try {
    const repo = gitRepo(sb, 'shop', 'git@github.com:org/shop.git');
    const run = (...a: string[]) => bosun(['memory', ...a], { env: sb.env(), cwd: repo });
    let r = await run('add', '-t', 'Use pnpm', '--tags', 'tooling,cart', 'Always pnpm install; npm breaks the lockfile.');
    assert.equal(r.code, 0, r.err);
    const id = r.out.match(/m_[0-9a-v]{9}[0-9a-f]{8}/)![0];
    assert.match((await run('add', '-t', 'Use pnpm', 'Always pnpm install; npm breaks the lockfile.')).out, new RegExp(`duplicate of ${id}`));
    r = await run('search', 'lockfile', '--json');
    assert.equal(JSON.parse(r.out)[0].id, id);
    r = await run('get', id);
    assert.match(r.out, /Always pnpm install/);
    assert.match(r.out, /store\s+cli/, 'the audit trail shows who stored it');
    assert.match((await run('update', id, '-b', 'Always pnpm; never npm.')).out, /version 2/);
    assert.match((await run('delete', id)).out, /archived/);
    assert.equal((await run('purge', id)).code, 0);
    assert.equal((await run('get', id)).code, 1);
    r = await run('add', '-c', 'session', '--private', 'scratch note for today');
    assert.match(r.out, /session, private/);

    fresh(sb);
    const s = new MemoryService(openDb(P.DB), load());
    const ctx = makeCtx(load(), project(repo));
    const p1 = (await s.store({ category: 'project', title: 'Proposal one', body: 'first proposal', status: 'proposed', source: 'test' }, ctx)).memory;
    const p2 = (await s.store({ category: 'project', title: 'Proposal two', body: 'second proposal', status: 'proposed', source: 'test' }, ctx)).memory;
    const p3 = (await s.store({ category: 'project', title: 'Proposal three', body: 'third proposal', status: 'proposed', source: 'test' }, ctx)).memory;
    s.close();
    assert.match((await run('accept', p1.id)).out, /accepted/);
    assert.match((await run('reject', p2.id)).out, /rejected/);
    assert.equal((await run('accept', p1.id)).code, 1, 'only proposals can be accepted');
    r = await bosun(['memory', 'review'], { env: sb.env(), cwd: repo, input: 'a\n' });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Proposal three/);
    assert.match((await run('get', p3.id)).out, /active/);
    assert.match((await bosun(['memory', 'review'], { env: sb.env(), cwd: repo })).out, /no proposals/);

    r = await run('stats');
    assert.match(r.out, /memory\.store/);
    assert.match(r.out, new RegExp(`project ${project(repo).id} \\(shop\\)`));
    assert.equal((await run('bogus')).code, 2);
    assert.equal((await run('add')).code, 2);
    assert.equal((await run('search', '--nope')).code, 2);
  } finally { sb.cleanup(); }
});
```

- [ ] **Step 2: run it** → expected: FAIL (`bosun memory` is an unknown command, exit 2 on the first `add`).

- [ ] **Step 3: `lib/memory/cli.ts`**

```ts
// bosun memory …: store, search, review and audit curated memory from the terminal. The CLI shows everything, private included.
import fs from 'node:fs';
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { P, type Cfg } from '../config.ts';
import { report } from '../metrics.ts';
import { die } from '../util.ts';
import { makeCtx, project, projectDir } from './project.ts';
import { MemoryService, openMemory } from './service.ts';
import type { Category, Memory, MemoryApi, Status } from './types.ts';

export const USAGE = `usage: bosun memory <verb>
  add [-c project|personal|session] [-t title] [--tags a,b] [--private] [--shared] [--ttl-days N] [--auto] "text" | -f file | -f -
  search ["words"] [-c category] [--status active|proposed|archived] [--tags a,b] [--limit N] [--json]
  get <id> [--json]   update <id> [-t title] [-b text] [--tags a,b] [--private|--public] [--shared] [--version N]
  delete <id>   purge <id>   review   accept <id>   reject <id>   prune
  consolidate [--since 7d] [--limit 20]   stats   bench [--n 10000]   eval <queries.jsonl>`;

const OPTIONS = {
  category: { type: 'string', short: 'c' }, title: { type: 'string', short: 't' }, body: { type: 'string', short: 'b' },
  file: { type: 'string', short: 'f' }, tags: { type: 'string' }, private: { type: 'boolean' }, public: { type: 'boolean' },
  shared: { type: 'boolean' }, 'ttl-days': { type: 'string' }, auto: { type: 'boolean' }, status: { type: 'string' },
  limit: { type: 'string' }, json: { type: 'boolean' }, version: { type: 'string' }, since: { type: 'string' }, n: { type: 'string' },
} as const;

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const list = (s?: string) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : undefined);
const line = (m: Memory) => `${m.id}  ${day(m.updatedAt)}  ${m.status.padEnd(8)} ${m.category.padEnd(8)} ${m.private ? '(private) ' : ''}${m.title}`;

export async function main(argv: string[], cfg: Cfg): Promise<number> {
  const [verb = 'help', ...rest] = argv;
  if (verb === 'help' || verb === '-h' || verb === '--help') { console.log(USAGE); return 0; }
  let parsed;
  try { parsed = parseArgs({ args: rest, options: OPTIONS, allowPositionals: true }); } catch (e) { return die(`${(e as Error).message}\n${USAGE}`, 2); }
  const { values: v, positionals: pos } = parsed;
  const num = (s: string | undefined, name: string): number | undefined => {
    if (s === undefined) return undefined;
    if (!/^\d+$/.test(s)) die(`--${name} needs a whole number`, 2);
    return Number(s);
  };
  const need = (what: string): string => pos[0] || die(`usage: bosun memory ${verb} <${what}>`, 2);
  const read = (f: string) => fs.readFileSync(f === '-' ? 0 : f, 'utf8');
  const dir = projectDir();
  const proj = project(dir);
  const ctx = makeCtx(cfg, proj, null, 'cli');
  let api: MemoryApi | null = null;
  const mem = (): MemoryApi => (api ??= openMemory(cfg));
  const local = (): MemoryService => {
    if (cfg.MEMORY_URL) die(`bosun memory ${verb} runs on the memory server (${cfg.MEMORY_URL}): run it there`);
    return mem() as MemoryService;
  };
  try {
    switch (verb) {
      case 'add': {
        const body = (v.file ? read(v.file) : pos.join(' ')).trim();
        if (!body) return die(USAGE, 2);
        const title = v.title ?? body.split('\n')[0].slice(0, 80);
        const r = await mem().store({ category: (v.category ?? 'project') as Category, title, body, tags: list(v.tags),
          private: v.private, shared: v.shared, ttlDays: num(v['ttl-days'], 'ttl-days') }, ctx);
        console.log(r.duplicate ? `duplicate of ${r.memory.id} (nothing stored)` : `stored ${r.memory.id} (${r.memory.category}${r.memory.private ? ', private' : ''})`);
        return 0;
      }
      case 'search': {
        const hits = await mem().search({ text: pos.join(' ') || undefined, category: v.category as Category | undefined,
          status: v.status ? [v.status as Status] : undefined, tags: list(v.tags), limit: num(v.limit, 'limit'), includePrivate: true, touch: false }, ctx);
        if (v.json) console.log(JSON.stringify(hits, null, 2));
        else console.log(hits.length ? hits.map(line).join('\n') : 'no memories');
        return 0;
      }
      case 'get': {
        const m = await mem().get(need('id'), ctx, { events: true });
        if (v.json) { console.log(JSON.stringify(m, null, 2)); return 0; }
        console.log(`${m.title}\n${m.id}  ${m.category}  ${m.status}  v${m.version}${m.private ? '  private' : ''}${m.shared ? '  shared' : ''}  tags: ${m.tags.join(', ') || '-'}`);
        console.log(`source ${m.source}${m.sourceRef ? ` (${m.sourceRef})` : ''}  created ${day(m.createdAt)}  updated ${day(m.updatedAt)}${m.expiresAt ? `  expires ${day(m.expiresAt)}` : ''}  used ${m.accessCount}x\n\n${m.body}\n`);
        for (const e of m.events || []) console.log(`  ${new Date(e.at).toISOString()}  ${e.op.padEnd(8)} ${e.source}`);
        return 0;
      }
      case 'update': {
        const id = need('id');
        const patch = { title: v.title, body: v.body ?? (v.file ? read(v.file).trim() : undefined), tags: list(v.tags),
          private: v.private ? true : v.public ? false : undefined, shared: v.shared };
        if (Object.values(patch).every((x) => x === undefined)) return die('nothing to change: pass -t, -b, -f, --tags, --private, --public or --shared', 2);
        const m = await mem().update(id, patch, num(v.version, 'version') ?? (await mem().get(id, ctx)).version, ctx);
        console.log(`updated ${m.id} to version ${m.version}`);
        return 0;
      }
      case 'delete': { const m = await mem().delete(need('id'), ctx); console.log(`${m.id} archived (bosun memory purge ${m.id} deletes it for good)`); return 0; }
      case 'accept': { console.log(`${(await mem().accept(need('id'), ctx)).id} accepted`); return 0; }
      case 'reject': { console.log(`${(await mem().reject(need('id'), ctx)).id} rejected (archived)`); return 0; }
      case 'purge': { await local().purge(need('id'), ctx); console.log(`purged ${pos[0]}`); return 0; }
      case 'prune': {
        const r = local().prune();
        console.log(`archived ${r.archived} expired, purged ${r.purged} archived for over ${cfg.MEMORY_PURGE_AFTER_DAYS} days`);
        return 0;
      }
      case 'review': return await review(mem(), ctx);
      case 'stats': {
        console.log(`project ${ctx.projectId} (${proj.name})   store ${cfg.MEMORY_URL || P.DB}`);
        if (!cfg.MEMORY_URL) console.log(`memories by status: ${JSON.stringify(local().counts())}`);
        for (const l of report()) console.log(l);
        return 0;
      }
      default: console.error(USAGE); return 2;
    }
  } finally { (api as MemoryApi | null)?.close(); }
}

// Proposals one by one: a accepts, r rejects, enter skips, q (or end of input) stops.
async function review(mem: MemoryApi, ctx: ReturnType<typeof makeCtx>): Promise<number> {
  const todo = await mem.search({ status: ['proposed'], limit: 50, includePrivate: true }, ctx);
  if (!todo.length) { console.log('no proposals to review'); return 0; }
  console.log(`${todo.length} proposals.  a=accept  r=reject  enter=skip  q=quit\n`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let pending: ((s: string) => void) | null = null;
  let closed = false;
  rl.on('close', () => { closed = true; pending?.('q'); });
  const ask = (q: string) => new Promise<string>((res) => {
    if (closed) return res('q');
    pending = res;
    rl.question(q, (a) => { pending = null; res(a); });
  });
  try {
    for (const [i, m] of todo.entries()) {
      console.log(`[${i + 1}/${todo.length}] ${m.title}  (${m.category}, ${m.source}${m.sourceRef ? `, ${m.sourceRef}` : ''})\n${m.body}\n`);
      const k = (await ask('  > ')).trim().toLowerCase();
      if (k === 'q') break;
      if (k === 'a') console.log(`  accepted ${(await mem.accept(m.id, ctx)).id}`);
      else if (k === 'r') console.log(`  rejected ${(await mem.reject(m.id, ctx)).id}`);
    }
  } finally { rl.close(); }
  return 0;
}
```

- [ ] **Step 4: wire it into `lib/cli.ts`**
  - `COMMANDS.memory = (argv, cfg) => memoryCli.main(argv, cfg)`.
  - In `main()`'s catch: `if (e instanceof MemoryError) { console.error(`bosun: ${e.message}`); return 1; }`.
  - Usage gains: `  bosun memory add|search|get|update|delete|review|consolidate|stats …   curated memory (bosun memory help)`.

- [ ] **Step 5: run** `node --test test/memory.test.ts`, then `npm test` and the type check → all pass.

- [ ] **Step 6: checkpoint** in the ledger.

---

### Task 4: Context — claude-mem and docs providers, the context manager, the prompt hook

**Files:**
- Create: `lib/memory/claudemem.ts`, `lib/memory/docs.ts`, `lib/context.ts`
- Modify: `lib/route.ts` (the hook runs memory in parallel with Kev), `test/helpers.ts` (`mock(routes)`, `claudeMemDb`)
- Test: `test/context.test.ts`

**Interfaces:**
- Consumes: `MemoryApi`, `Hit`, `MemoryProvider`, `Ctx`, `ftsQuery`, `tx`, `openDb`, `contentHash`, `words`, `jaccard`, `openMemory`, `project`, `projectDir`, `makeCtx`, `record`, `log`.
- Produces:
  - `class ClaudeMem implements MemoryProvider` — `constructor(cfg: Cfg, projects: string[])`, `search(text, ctx, limit)`, `summaries(since: number, limit: number): Summary[]` with `Summary = { id: number; at: number; request: string; learned: string; completed: string; nextSteps: string }`
  - `class Docs implements MemoryProvider` — `constructor(db: DatabaseSync, dir: string, projectId: string)`, `index(): { changed: number; removed: number }`
  - `retrieve(task: string, providers: MemoryProvider[], ctx: Ctx, o: { budgetTokens: number; minScore: number; itemChars: number }): Promise<Result>` with `Item = Hit & { score: number }` and `Result = { items: Item[]; text: string; estTokens: number; sources: Record<string, number>; ms: number }`
  - `curated(api: MemoryApi): MemoryProvider`, `estTokens(s: string): number`
  - `routerUrl(cfg: Cfg): string` exported from `route.ts` (doctor uses it in Task 7)

- [ ] **Step 1: test helpers** — in `test/helpers.ts`:

```ts
// mock(routes): per-path handlers win over the defaults. A handler returns the reply: JSON, raw text, a delay, or a dropped connection.
export type Reply = { status?: number; json?: unknown; text?: string; delayMs?: number; destroy?: boolean };
export type Route = (body: any, req: http.IncomingMessage) => Reply | Promise<Reply>;
```

Inside `mock()`'s `end` handler, before the defaults: parse the body leniently (`try { json = body ? JSON.parse(body) : null } catch { json = body }`), then:

```ts
const route = routes[(req.url || '').split('?')[0]];
if (route) {
  const r = await route(json, req);
  if (r.destroy) { req.socket.destroy(); return; }
  if (r.delayMs) await new Promise((res) => setTimeout(res, r.delayMs));
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(r.status ?? 200, { 'content-type': r.text !== undefined ? 'text/html' : 'application/json' });
  res.end(r.text ?? JSON.stringify(r.json ?? {}));
  return;
}
```

And a claude-mem fixture builder (the columns bosun reads, plus FTS tables like claude-mem's schema v40):

```ts
export function claudeMemDb(file: string, rows: { obs?: { project: string; title: string; narrative: string; at?: number }[]; sums?: { project: string; request: string; learned: string; completed?: string; at?: number }[] }): void {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE observations (id INTEGER PRIMARY KEY AUTOINCREMENT, memory_session_id TEXT, project TEXT NOT NULL, text TEXT, type TEXT, title TEXT, subtitle TEXT, facts TEXT, narrative TEXT, concepts TEXT, created_at TEXT, created_at_epoch INTEGER NOT NULL);
    CREATE VIRTUAL TABLE observations_fts USING fts5(title, subtitle, narrative, text, facts, concepts, content='observations', content_rowid='id');
    CREATE TABLE session_summaries (id INTEGER PRIMARY KEY AUTOINCREMENT, memory_session_id TEXT, project TEXT NOT NULL, request TEXT, investigated TEXT, learned TEXT, completed TEXT, next_steps TEXT, notes TEXT, created_at TEXT, created_at_epoch INTEGER NOT NULL);
    CREATE VIRTUAL TABLE session_summaries_fts USING fts5(request, investigated, learned, completed, next_steps, notes, content='session_summaries', content_rowid='id');`);
  for (const o of rows.obs || []) {
    const r = db.prepare('INSERT INTO observations (project, type, title, narrative, created_at_epoch) VALUES (?, ?, ?, ?, ?)').run(o.project, 'discovery', o.title, o.narrative, o.at ?? Date.now());
    db.prepare('INSERT INTO observations_fts (rowid, title, narrative) VALUES (?, ?, ?)').run(r.lastInsertRowid, o.title, o.narrative);
  }
  for (const s of rows.sums || []) {
    const r = db.prepare('INSERT INTO session_summaries (project, request, learned, completed, created_at_epoch) VALUES (?, ?, ?, ?, ?)').run(s.project, s.request, s.learned, s.completed ?? '', s.at ?? Date.now());
    db.prepare('INSERT INTO session_summaries_fts (rowid, request, learned, completed) VALUES (?, ?, ?, ?)').run(r.lastInsertRowid, s.request, s.learned, s.completed ?? '');
  }
  db.close();
}
```

- [ ] **Step 2: write the failing tests** — `test/context.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sandbox, fresh, bosun, mock, gitRepo, claudeMemDb } from './helpers.ts';
import { load, P } from '../lib/config.ts';
import { retrieve } from '../lib/context.ts';
import { ClaudeMem } from '../lib/memory/claudemem.ts';
import { Docs } from '../lib/memory/docs.ts';
import { makeCtx, project } from '../lib/memory/project.ts';
import { MemoryService } from '../lib/memory/service.ts';
import { openDb } from '../lib/memory/sqlite.ts';
import type { Ctx, Hit, MemoryProvider, Source } from '../lib/memory/types.ts';

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
  const w = await retrieve('q x', [fake('docs', [{ id: 'd', text: 'alpha' }]), fake('curated', [{ id: 'c', text: 'beta' }])], CTX, O);
  assert.deepEqual(w.items.map((i) => i.id), ['c', 'd'], 'curated outweighs docs at equal relevance');
  const u = await retrieve('q x', [fake('curated', [{ id: 'unused', text: 'alpha one' }, { id: 'used', text: 'beta two', accessCount: 50 }])], CTX, O);
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

async function seeded(sb: ReturnType<typeof sandbox>) {
  const repo = gitRepo(sb, 'shop', 'git@github.com:org/shop.git');
  fresh(sb);
  const s = new MemoryService(openDb(P.DB), load());
  const ctx = makeCtx(load(), project(repo));
  await s.store({ category: 'project', title: 'Cart naming', body: 'getCart was renamed to fetchCart in cart-service; keep the old export for one release.' }, ctx);
  await s.store({ category: 'project', title: 'Private note', body: 'fetchCart secret PRIVATE-XYZ', private: true }, ctx);
  await s.store({ category: 'project', title: 'Long note', body: `# Heading\n\nfetchCart ${'detail '.repeat(200)}\n- list item\n` }, ctx);
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
```

- [ ] **Step 3: run** `node --test test/context.test.ts` → expected: FAIL, missing modules.

- [ ] **Step 4: `lib/memory/claudemem.ts`**

```ts
// Read-only provider over claude-mem's database: this repo's observations and session summaries. Never writes, never throws.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { P, type Cfg } from '../config.ts';
import { log } from '../log.ts';
import { record } from '../metrics.ts';
import { ftsQuery } from './sqlite.ts';
import type { Ctx, Hit, MemoryProvider } from './types.ts';

// The columns bosun reads. When claude-mem's schema (v40 when this was written) moves on, the provider goes quiet with a warning.
const NEED: Record<string, string[]> = {
  observations: ['id', 'project', 'title', 'subtitle', 'narrative', 'created_at_epoch'],
  observations_fts: ['title', 'subtitle', 'narrative'],
  session_summaries: ['id', 'project', 'request', 'learned', 'completed', 'next_steps', 'created_at_epoch'],
  session_summaries_fts: ['request', 'learned', 'completed'],
};
export type Summary = { id: number; at: number; request: string; learned: string; completed: string; nextSteps: string };
type Row = Record<string, any>;

export class ClaudeMem implements MemoryProvider {
  name = 'claude-mem' as const;
  file: string;
  projects: string;
  off: boolean;
  constructor(cfg: Cfg, projects: string[]) {
    this.file = cfg.CLAUDE_MEM_DB || path.join(P.HOME, '.claude-mem', 'claude-mem.db');
    this.projects = JSON.stringify([...new Set(projects.filter(Boolean))]);
    this.off = cfg.CLAUDE_MEM === 'off';
  }

  private open(): DatabaseSync | null {
    if (this.off || !fs.existsSync(this.file)) return null;
    const db = new DatabaseSync(this.file, { readOnly: true });
    try {
      for (const [table, cols] of Object.entries(NEED)) {
        const have = new Set((db.prepare('SELECT name FROM pragma_table_info(?)').all(table) as Row[]).map((r) => r.name));
        if (cols.some((c) => !have.has(c))) throw Object.assign(new Error('claude-mem schema mismatch'), { code: `schema:${table}` });
      }
      return db;
    } catch (e) { db.close(); throw e; }
  }
  private safe<T>(what: string, fallback: T, fn: (db: DatabaseSync) => T): T {
    const t = performance.now();
    let db: DatabaseSync | null = null;
    try {
      db = this.open();
      return db ? fn(db) : fallback;
    } catch (e) {
      log('warn', 'claude-mem.unavailable', { what, file: this.file, err: e });
      return fallback;
    } finally {
      db?.close();
      record({ op: `claude-mem.${what}`, ms: performance.now() - t });
    }
  }

  async search(text: string, _ctx: Ctx, limit: number): Promise<Hit[]> {
    const match = ftsQuery(text);
    if (!match) return [];
    return this.safe('search', [] as Hit[], (db) => {
      const obs = db.prepare(`SELECT o.id, COALESCE(o.title, o.subtitle, '') AS title, snippet(observations_fts, -1, '', '', '…', 32) AS text,
          o.created_at_epoch AS at, bm25(observations_fts) AS rank
        FROM observations_fts JOIN observations o ON o.id = observations_fts.rowid
        WHERE observations_fts MATCH ? AND o.project COLLATE NOCASE IN (SELECT value FROM json_each(?))
        ORDER BY bm25(observations_fts) LIMIT ?`).all(match, this.projects, limit) as Row[];
      const sums = db.prepare(`SELECT s.id, COALESCE(s.request, '') AS title, snippet(session_summaries_fts, -1, '', '', '…', 32) AS text,
          s.created_at_epoch AS at, bm25(session_summaries_fts) AS rank
        FROM session_summaries_fts JOIN session_summaries s ON s.id = session_summaries_fts.rowid
        WHERE session_summaries_fts MATCH ? AND s.project COLLATE NOCASE IN (SELECT value FROM json_each(?))
        ORDER BY bm25(session_summaries_fts) LIMIT ?`).all(match, this.projects, limit) as Row[];
      const hit = (r: Row, category: string, id: string): Hit => ({ source: 'claude-mem', id, title: String(r.title).slice(0, 200), text: r.text, category, rank: r.rank, at: r.at, accessCount: 0 });
      return [...obs.map((r) => hit(r, 'observation', `cm_o${r.id}`)), ...sums.map((r) => hit(r, 'summary', `cm_s${r.id}`))]
        .sort((a, b) => a.rank - b.rank).slice(0, limit);
    });
  }

  // For consolidation: this repo's newest session summaries since a time.
  summaries(since: number, limit: number): Summary[] {
    return this.safe('summaries', [] as Summary[], (db) => db.prepare(`SELECT id, created_at_epoch AS at, COALESCE(request, '') AS request,
        COALESCE(learned, '') AS learned, COALESCE(completed, '') AS completed, COALESCE(next_steps, '') AS nextSteps
      FROM session_summaries WHERE project COLLATE NOCASE IN (SELECT value FROM json_each(?)) AND created_at_epoch >= ?
      ORDER BY created_at_epoch DESC LIMIT ?`).all(this.projects, since, limit) as Summary[]);
  }
}
```

- [ ] **Step 5: `lib/memory/docs.ts`**

```ts
// Project docs index: this repo's Markdown files in FTS5, re-read only when a file's mtime changes.
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { record } from '../metrics.ts';
import { sh } from '../util.ts';
import { ftsQuery, tx } from './sqlite.ts';
import type { Ctx, Hit, MemoryProvider } from './types.ts';

const MAX_FILES = 2000;
const MAX_BYTES = 256 * 1024;   // ponytail: larger docs are skipped, not chunked; chunk them if big design docs matter
type Row = Record<string, any>;

export class Docs implements MemoryProvider {
  name = 'docs' as const;
  db: DatabaseSync;
  dir: string;
  projectId: string;
  top = '';
  constructor(db: DatabaseSync, dir: string, projectId: string) { this.db = db; this.dir = dir; this.projectId = projectId; }

  // Tracked, and untracked-but-not-ignored, *.md files of the repo around dir. Rows are keyed by the repo's top-level path.
  index(): { changed: number; removed: number } {
    const t = performance.now();
    const top = sh('git', ['-C', this.dir, 'rev-parse', '--show-toplevel']);
    if (top.code || !top.out) return { changed: 0, removed: 0 };
    this.top = top.out;
    const prefix = `${top.out}${path.sep}`;
    const ls = sh('git', ['-C', top.out, 'ls-files', '-z', '-co', '--exclude-standard', '--', '*.md']);
    const known = new Map((this.db.prepare('SELECT path, mtime FROM docs WHERE substr(path, 1, ?) = ?').all(prefix.length, prefix) as Row[]).map((r) => [r.path as string, r.mtime as number]));
    const put: [string, number, string, string][] = [];
    for (const rel of ls.out.split('\0').filter(Boolean).slice(0, MAX_FILES)) {
      const file = path.join(top.out, rel);
      let st: fs.Stats;
      try { st = fs.statSync(file); } catch { continue; }
      if (!st.isFile() || st.size > MAX_BYTES) continue;
      const mtime = Math.floor(st.mtimeMs);
      const seen = known.get(file);
      known.delete(file);
      if (seen === mtime) continue;
      const body = fs.readFileSync(file, 'utf8');
      put.push([file, mtime, (body.match(/^#\s+(.+)$/m)?.[1] ?? rel).trim().slice(0, 200), body]);
    }
    if (put.length || known.size) {
      tx(this.db, () => {
        const up = this.db.prepare(`INSERT INTO docs (path, project_id, mtime, title, body) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(path) DO UPDATE SET project_id = excluded.project_id, mtime = excluded.mtime, title = excluded.title, body = excluded.body`);
        for (const [file, mtime, title, body] of put) up.run(file, this.projectId, mtime, title, body);
        const rm = this.db.prepare('DELETE FROM docs WHERE path = ?');
        for (const file of known.keys()) rm.run(file);
      });
    }
    record({ op: 'docs.index', ms: performance.now() - t, n: put.length });
    return { changed: put.length, removed: known.size };
  }

  async search(text: string, _ctx: Ctx, limit: number): Promise<Hit[]> {
    const match = ftsQuery(text);
    if (!match) return [];
    this.index();
    if (!this.top) return [];
    const prefix = `${this.top}${path.sep}`;
    return (this.db.prepare(`SELECT d.path, d.title, d.mtime, snippet(docs_fts, 1, '', '', '…', 32) AS text, bm25(docs_fts) AS rank
      FROM docs_fts JOIN docs d ON d.seq = docs_fts.rowid
      WHERE docs_fts MATCH ? AND substr(d.path, 1, ?) = ? ORDER BY bm25(docs_fts) LIMIT ?`).all(match, prefix.length, prefix, limit) as Row[])
      .map((r) => ({ source: 'docs', id: path.relative(this.top, r.path), title: r.title, text: r.text, category: 'doc', rank: r.rank, at: r.mtime, accessCount: 0 }));
  }
}
```

- [ ] **Step 6: `lib/context.ts`**

```ts
// Context manager: rank curated memory, project docs and claude-mem for a task, dedupe, and fit a token budget.
import { log } from './log.ts';
import { record } from './metrics.ts';
import { contentHash, ftsQuery, jaccard, words } from './memory/sqlite.ts';
import type { Ctx, Hit, MemoryApi, MemoryProvider, Source } from './memory/types.ts';

export type Item = Hit & { score: number };
export type Result = { items: Item[]; text: string; estTokens: number; sources: Record<string, number>; ms: number };
const WEIGHT: Record<Source, number> = { curated: 1.0, docs: 0.8, 'claude-mem': 0.6 };
const HALF_LIFE_DAYS: Record<Source, number> = { curated: 60, docs: 90, 'claude-mem': 30 };   // session memories: 1
const HEADER_MAX = 60;   // chars reserved for the header line
const FETCH = 20;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const estTokens = (s: string): number => Math.ceil(s.length / 4);   // an estimate, always shown as ~

// Curated memory as a provider: active, non-private memories of the caller's scope.
export const curated = (api: MemoryApi): MemoryProvider => ({
  name: 'curated',
  async search(text, ctx, limit) {
    return (await api.search({ text, limit }, ctx)).map((m) => ({
      source: 'curated', id: m.id, title: m.title, text: m.body, category: m.category, rank: m.rank, at: m.updatedAt, accessCount: m.accessCount, hash: m.hash,
    }));
  },
});

function line(it: Item, max: number): string {
  const s = `- [${it.source} ${it.category} ${day(it.at)} ${it.id}] ${it.title}: ${it.text}`.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// Curated errors propagate (the hook fails open, MCP answers unavailable); docs and claude-mem never throw.
export async function retrieve(task: string, providers: MemoryProvider[], ctx: Ctx, o: { budgetTokens: number; minScore: number; itemChars: number }): Promise<Result> {
  const t0 = performance.now();
  const sources: Record<string, number> = {};
  if (!ftsQuery(task)) return { items: [], text: '', estTokens: 0, sources, ms: performance.now() - t0 };
  const lists = await Promise.all(providers.map((p) => p.search(task, ctx, FETCH)));
  const now = Date.now();
  const scored: Item[] = [];
  providers.forEach((p, i) => {
    const hits = lists[i];
    sources[p.name] = hits.length;
    const best = Math.max(0, ...hits.map((h) => -h.rank));   // bm25 is negative: more negative is better
    for (const h of hits) {
      const rel = best > 0 ? Math.max(0, -h.rank) / best : 1;
      const half = h.source === 'curated' && h.category === 'session' ? 1 : HALF_LIFE_DAYS[h.source];
      const age = Math.max(0, now - h.at) / 86400000;
      scored.push({ ...h, score: rel * WEIGHT[h.source] + 0.3 * 2 ** (-age / half) + 0.05 * Math.log(1 + h.accessCount) });
    }
  });
  scored.sort((a, b) => b.score - a.score);
  const kept: Item[] = [];
  const hashes = new Set<string>();
  const sets: Set<string>[] = [];
  for (const it of scored) {   // sorted, so the first of a duplicate pair has the higher score
    const h = it.hash ?? contentHash(it.title, it.text);
    const ws = words(`${it.title} ${it.text}`);
    if (hashes.has(h) || sets.some((s) => jaccard(s, ws) >= 0.8)) continue;
    hashes.add(h);
    sets.push(ws);
    kept.push(it);
  }
  const items: Item[] = [];
  const lines: string[] = [];
  let chars = HEADER_MAX;
  for (const it of kept) {
    if (it.score < o.minScore) break;
    const l = line(it, o.itemChars);
    if (Math.ceil((chars + 1 + l.length) / 4) > o.budgetTokens) continue;   // greedy: a smaller one may still fit
    chars += 1 + l.length;
    items.push(it);
    lines.push(l);
  }
  const text = items.length ? [`[bosun memory: ${items.length} note${items.length === 1 ? '' : 's'}; memory_get <id> for details]`, ...lines].join('\n') : '';
  const ms = performance.now() - t0;
  record({ op: 'context.retrieve', ms, n: items.length, chars: text.length, estTokens: estTokens(text) });
  if (lists.some((l) => l.length === FETCH)) log('info', 'context.full', { sources });
  return { items, text, estTokens: estTokens(text), sources, ms };
}
```


- [ ] **Step 7: the hook in `lib/route.ts`**

Export `routerUrl` and use it in `ask()`:

```ts
export const routerUrl = (cfg: Cfg): string => (cfg.ROUTER_URL || `http://127.0.0.1:${cfg.ROUTER_PORT}`).replace(/\/$/, '');
```

Add the memory part:

```ts
// The hook's memory part: a few relevant curated notes, or '' on any failure (fail open). Always records its latency.
async function memoryBlock(cfg: Cfg, prompt: string, sessionId: string | null): Promise<string> {
  const t = performance.now();
  let n = 0;
  let est = 0;
  let api: MemoryApi | null = null;
  try {
    api = openMemory(cfg, Number(cfg.REMOTE_HOOK_TIMEOUT_MS));
    const r = await retrieve(prompt, [curated(api)], makeCtx(cfg, project(projectDir()), sessionId, 'hook'), {
      budgetTokens: Number(cfg.CONTEXT_HOOK_BUDGET), minScore: Number(cfg.CONTEXT_HOOK_MIN_SCORE), itemChars: Number(cfg.CONTEXT_ITEM_CHARS) });
    n = r.items.length;
    est = r.estTokens;
    return r.text;
  } catch (e) {
    logEvent('warn', 'hook.memory', { err: e });
    return '';
  } finally {
    try { api?.close(); } catch { /* already closed */ }
    record({ op: 'hook', ms: performance.now() - t, n, estTokens: est });
  }
}
```

Replace the hook branch of `main()` (the manual `bosun route "…"` path stays as it is):

```ts
  if (hook) {
    if (process.env.BOSUN_DEPTH) return 0;   // inside a bosun executor: stay out of the way
    let input: any;
    try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { return 0; }
    const prompt = String(input?.prompt || '');
    const p = prompt.trimStart();
    if (!p || p.startsWith('/') || p.startsWith('!') || p.split(/\s+/).length < 3 || prompt.includes('#noroute')) return 0;
    const sid = typeof input.session_id === 'string' ? input.session_id : null;
    const [d, mem] = await Promise.all([ask(cfg, prompt).catch(() => null), memoryBlock(cfg, prompt, sid)]);
    let hint = '';
    if (d) {
      const [final, why] = decide(d, Number(cfg.ROUTER_MIN_CONF));
      log(prompt, d, final, why);
      if (final) hint = `[router ${d.router} ${d.ms}ms] suggests: ${final} (conf ${d.conf}, risk ${d.risk})${why ? ` (${why})` : ''} -> ${(HINT[host] || HINT.claude)[final]}. Advisory only: override it if the request needs otherwise.`;
    }
    const ctx = [mem, hint].filter(Boolean).join('\n\n');
    if (ctx) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: ctx } }));
    return 0;   // fail open: with nothing to add, the main model decides on its own
  }
```

- [ ] **Step 8: run** `node --test test/context.test.ts test/route.test.ts`, then `npm test` and the type check → all pass. The existing route tests must pass unchanged: an empty memory store adds nothing.

- [ ] **Step 9: checkpoint** in the ledger.

---

### Task 5: LLM router, consolidation, `memory add --auto`

**Files:**
- Create: `lib/llm.ts`, `lib/consolidate.ts`
- Modify: `lib/memory/cli.ts` (`consolidate` verb, `add --auto`), `config.default.env` (LLM keys)
- Test: `test/llm.test.ts`

**Interfaces:**
- Consumes: `validate`/`Schema` (util), `record`, `SUBSCRIPTION_ONLY` (exported from `exec.ts`), `ClaudeMem.summaries`, `MemoryApi`, `cleanTags`, `words`, `jaccard`, `state`/`saveState`.
- Produces:
  - `generate(cfg: Cfg, o: GenOpts): Promise<GenResult>` with `Msg = { role: 'system' | 'user' | 'assistant'; content: string }`, `GenOpts = { task: string; messages: Msg[]; schema?: Schema; allowRemote?: boolean; private?: boolean }`, `GenResult = { ok: boolean; text: string; json?: any; provider: string; model: string; ms: number; tokensIn?: number; tokensOut?: number; error?: string }`
  - `consolidate(cfg, api, ctx, cm, o: { since: number; limit: number }): Promise<{ summaries: number; proposed: Memory[]; skipped: { title: string; why: string }[]; error?: string }>`
  - `suggest(cfg, text, priv): Promise<{ title: string; tags: string[] } | null>` (in `lib/llm.ts`)

- [ ] **Step 1: config keys** — append to `config.default.env`:

```
# ── LLM router (consolidation, memory add --auto) ────────────────────────
LLM_PROVIDERS=ollama             # fallback chain: ollama, openai (an OpenAI-compatible server: mlx_lm.server, LM Studio)
LLM_MODEL=                       # empty = LOCAL_MODEL
LLM_OPENAI_URL=http://127.0.0.1:8080
LLM_REMOTE=off                   # claude = claude -p (haiku) as a last resort, never for private content
LLM_TIMEOUT_S=60
LLM_RETRIES=1                    # on timeouts and connection errors only
```

- [ ] **Step 2: write the failing tests** — `test/llm.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, fresh, bosun, mock, gitRepo, claudeMemDb } from './helpers.ts';
import { load, P } from '../lib/config.ts';
import { generate } from '../lib/llm.ts';
import { consolidate } from '../lib/consolidate.ts';
import { ClaudeMem } from '../lib/memory/claudemem.ts';
import { MemoryService } from '../lib/memory/service.ts';
import { openDb } from '../lib/memory/sqlite.ts';
import type { Schema } from '../lib/util.ts';

const SCHEMA: Schema = { type: 'object', required: ['title'], properties: { title: { type: 'string', maxLength: 20 } } };
const msg = [{ role: 'user' as const, content: 'SECRET-PROMPT summarize' }];
const chat = (content: string) => () => ({ json: { message: { content }, prompt_eval_count: 12, eval_count: 5 } });

test('llm: Ollama success sends the schema and context size and reads token counts', async () => {
  const sb = sandbox();
  const m = await mock({ '/api/chat': chat('{"title":"ok"}') });
  try {
    fresh(sb);
    const r = await generate({ ...load(), OLLAMA_URL: m.url }, { task: 't', messages: msg, schema: SCHEMA });
    assert.deepEqual([r.ok, r.provider, r.model, r.json, r.tokensIn, r.tokensOut], [true, 'ollama', load().LOCAL_MODEL, { title: 'ok' }, 12, 5]);
    const req = m.requests.find((q) => q.path === '/api/chat')!;
    assert.deepEqual([req.body.stream, req.body.format, req.body.options.num_ctx], [false, SCHEMA, 65536]);
  } finally { await m.close(); sb.cleanup(); }
});

test('llm: timeout, retry then success, bad JSON and schema violations fail without retrying', async () => {
  const sb = sandbox();
  let calls = 0;
  const m = await mock({
    '/slow/api/chat': () => ({ delayMs: 3000, json: {} }),
    '/api/chat': (b) => (b.messages[0].content === 'flaky' && calls++ === 0 ? { destroy: true } : { json: { message: { content: b.messages[0].content === 'bad' ? 'not json' : b.messages[0].content === 'wrong' ? '{"title": 5}' : '{"title":"ok"}' } } }),
  });
  try {
    fresh(sb);
    const cfg = { ...load(), OLLAMA_URL: m.url, LLM_TIMEOUT_S: '0.3' };
    const t = Date.now();
    const slow = await generate({ ...cfg, OLLAMA_URL: `${m.url}/slow`, LLM_RETRIES: '0' }, { task: 't', messages: msg });
    assert.deepEqual([slow.ok, slow.error], [false, 'timeout']);
    assert.ok(Date.now() - t < 2500);
    const flaky = await generate(cfg, { task: 't', messages: [{ role: 'user', content: 'flaky' }], schema: SCHEMA });
    assert.equal(flaky.ok, true, 'a dropped connection is retried');
    assert.equal(calls, 2);
    const n = m.requests.length;
    assert.equal((await generate(cfg, { task: 't', messages: [{ role: 'user', content: 'bad' }], schema: SCHEMA })).error, 'bad_json');
    assert.equal((await generate(cfg, { task: 't', messages: [{ role: 'user', content: 'wrong' }], schema: SCHEMA })).error, 'invalid');
    assert.equal(m.requests.length - n, 2, 'invalid output is not retried');
  } finally { await m.close(); sb.cleanup(); }
});

test('llm: fallback chain; the remote provider only when opted in, allowed, and not private; the usage log has no content', async () => {
  const sb = sandbox();
  const m = await mock({ '/v1/chat/completions': () => ({ json: { choices: [{ message: { content: '{"title":"oa"}' } }], usage: { prompt_tokens: 3, completion_tokens: 2 } } }) });
  try {
    fresh(sb, { STUB_MAP: JSON.stringify({ claude: { out: { result: '{"title":"cc"}', usage: { input_tokens: 1, output_tokens: 1 } } } }) });
    const down = { ...load(), OLLAMA_URL: 'http://127.0.0.1:1', LLM_RETRIES: '0' };
    const oa = await generate({ ...down, LLM_PROVIDERS: 'ollama,openai', LLM_OPENAI_URL: m.url }, { task: 't', messages: msg, schema: SCHEMA });
    assert.deepEqual([oa.ok, oa.provider, oa.json.title, oa.tokensIn], [true, 'openai', 'oa', 3]);
    assert.equal(m.requests.find((q) => q.path === '/v1/chat/completions')!.body.response_format.type, 'json_schema');
    const claudeCalls = () => sb.calls().filter((c) => c.bin === 'claude');
    assert.equal((await generate(down, { task: 't', messages: msg, allowRemote: true })).ok, false);
    assert.equal(claudeCalls().length, 0, 'remote is off by default');
    const remote = { ...down, LLM_REMOTE: 'claude' };
    assert.equal((await generate(remote, { task: 't', messages: msg })).ok, false);
    assert.equal(claudeCalls().length, 0, 'the caller must allow remote');
    assert.equal((await generate(remote, { task: 't', messages: msg, allowRemote: true, private: true })).ok, false);
    assert.equal(claudeCalls().length, 0, 'never for private content');
    const cc = await generate(remote, { task: 't', messages: msg, allowRemote: true, schema: SCHEMA });
    assert.deepEqual([cc.ok, cc.provider, cc.model, cc.json.title], [true, 'claude-cli', 'haiku', 'cc']);
    const call = claudeCalls()[0];
    assert.ok(call.argv.includes('--restricted') && call.argv.includes('--strict-mcp-config'));
    assert.equal(call.env.BOSUN_DEPTH, '1');
    const usage = fs.readFileSync(path.join(P.BOSUN, 'llm-usage.jsonl'), 'utf8');
    assert.doesNotMatch(usage, /SECRET-PROMPT/);
    for (const row of usage.trim().split('\n').map((l) => JSON.parse(l))) {
      assert.deepEqual(Object.keys(row).sort(), ['error_kind', 'ms', 'model', 'ok', 'provider', 'task', 'tokensIn', 'tokensOut', 'ts']);
    }
  } finally { await m.close(); sb.cleanup(); }
});

test('consolidate: proposals with provenance; exact and near duplicates are skipped; invalid output writes nothing; review accepts', async () => {
  const sb = sandbox();
  const reply = { current: '' };
  const m = await mock({ '/api/chat': () => ({ json: { message: { content: reply.current } } }) });
  try {
    fresh(sb);
    const cfg = { ...load(), OLLAMA_URL: m.url };
    const file = path.join(sb.root, 'cm.db');
    claudeMemDb(file, { sums: [{ project: 'shop', request: 'fix checkout', learned: 'checkout needs the cart token' }, { project: 'shop', request: 'deploy', learned: 'deploys run through ArgoCD' }] });
    const svc = new MemoryService(openDb(P.DB), cfg);
    const ctx = { projectId: 'p_shop', sessionId: null, linked: [] };
    await svc.store({ category: 'project', title: 'Deploys', body: 'Deploys run through ArgoCD from main.' }, ctx);
    const cm = new ClaudeMem({ ...cfg, CLAUDE_MEM_DB: file }, ['shop']);
    reply.current = JSON.stringify({ candidates: [
      { summary_id: '1', category: 'project', title: 'Checkout token', body: 'Checkout needs the cart token.', tags: ['Checkout', 'cart token'] },
      { summary_id: '2', category: 'project', title: 'Deploys', body: 'Deploys run through ArgoCD from main!', tags: [] }] });
    const r = await consolidate(cfg, svc, ctx, cm, { since: 0, limit: 20 });
    assert.equal(r.error, undefined);
    assert.equal(r.summaries, 2);
    assert.deepEqual(r.proposed.map((p) => [p.title, p.status, p.sourceRef, p.tags]), [['Checkout token', 'proposed', 'claude-mem:summary:1', ['checkout', 'cart-token']]]);
    assert.match(r.proposed[0].source, /^consolidate:ollama\//);
    assert.match(r.skipped[0].why, /near-duplicate of m_/);
    reply.current = '{"candidates": "nope"}';
    const before = svc.counts();
    const bad = await consolidate(cfg, svc, ctx, cm, { since: 0, limit: 20 });
    assert.match(bad.error!, /nothing written/);
    assert.deepEqual(svc.counts(), before);
    assert.equal((await svc.accept(r.proposed[0].id, ctx)).status, 'active');
    svc.close();
  } finally { await m.close(); sb.cleanup(); }
});

test('memory cli: consolidate end to end, and add --auto takes the LLM title and tags unless given', async () => {
  const sb = sandbox();
  const m = await mock({ '/api/chat': (b) => ({ json: { message: { content: b.messages[0].content.startsWith('Suggest')
    ? '{"title":"Auto title","tags":["Auto Tag"]}'
    : JSON.stringify({ candidates: [{ summary_id: '1', category: 'project', title: 'Token rule', body: 'Checkout needs the cart token.', tags: [] }] }) } } }) });
  try {
    const repo = gitRepo(sb, 'shop', 'git@github.com:org/shop.git');
    const file = path.join(sb.root, 'cm.db');
    claudeMemDb(file, { sums: [{ project: 'shop', request: 'fix checkout', learned: 'checkout needs the cart token' }] });
    const env = sb.env({ OLLAMA_URL: m.url, CLAUDE_MEM_DB: file });
    let r = await bosun(['memory', 'consolidate'], { env, cwd: repo });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /1 session summaries → 1 proposals/);
    assert.match(r.out, /bosun memory review/);
    r = await bosun(['memory', 'add', '--auto', 'the payment webhook retries 3 times with backoff'], { env, cwd: repo });
    const id = r.out.match(/m_\w+/)![0];
    assert.match((await bosun(['memory', 'get', id], { env, cwd: repo })).out, /^Auto title\n[\s\S]*tags: auto-tag/);
    r = await bosun(['memory', 'add', '--auto', '-t', 'Mine', 'another note about webhooks'], { env, cwd: repo });
    assert.match((await bosun(['memory', 'get', r.out.match(/m_\w+/)![0]], { env, cwd: repo })).out, /^Mine\n/);
  } finally { await m.close(); sb.cleanup(); }
});
```

- [ ] **Step 3: run** `node --test test/llm.test.ts` → expected: FAIL, missing modules.

- [ ] **Step 4: `lib/llm.ts`**

```ts
// LLM router: generate() over local providers (Ollama, OpenAI-compatible), with timeout, retry, fallback, JSON validation
// and a usage log. A remote provider (claude -p, haiku) is used only when opted in, allowed by the caller, and not private.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { P, type Cfg } from './config.ts';
import { SUBSCRIPTION_ONLY } from './exec.ts';
import { record } from './metrics.ts';
import { validate, type Schema } from './util.ts';

export type Msg = { role: 'system' | 'user' | 'assistant'; content: string };
export type GenOpts = { task: string; messages: Msg[]; schema?: Schema; allowRemote?: boolean; private?: boolean };
export type GenResult = { ok: boolean; text: string; json?: any; provider: string; model: string; ms: number; tokensIn?: number; tokensOut?: number; error?: string };
type Raw = { text: string; tokensIn?: number; tokensOut?: number };
class Transient extends Error {}   // timeouts and connection errors: worth a retry

async function post(url: string, body: object, cfg: Cfg): Promise<any> {
  let r: Response;
  try {
    r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(Number(cfg.LLM_TIMEOUT_S) * 1000) });
    if (!r.ok) throw new Error(`http ${r.status}`);
    return await r.json();
  } catch (e) {
    const name = (e as Error).name;
    if (name === 'TimeoutError' || name === 'AbortError') throw new Transient('timeout');
    if (e instanceof TypeError) throw new Transient('connection');   // fetch failed: refused, reset, DNS
    throw e;
  }
}

const flatten = (o: GenOpts) => [...o.messages.map((m) => `${m.role}:\n${m.content}`),
  ...(o.schema ? [`Reply with JSON only, matching this JSON Schema: ${JSON.stringify(o.schema)}`] : [])].join('\n\n');

function claudeCli(cfg: Cfg, o: GenOpts): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, BOSUN_DEPTH: '1' };
    for (const k of SUBSCRIPTION_ONLY) delete env[k];
    const p = spawn('claude', ['-p', '--restricted', '--strict-mcp-config', '--no-session-persistence', '--model', 'haiku', '--output-format', 'json'],
      { env, stdio: ['pipe', 'pipe', 'ignore'], timeout: Number(cfg.LLM_TIMEOUT_S) * 1000 });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => reject(new Transient('connection')));
    p.on('close', (code, signal) => {
      if (signal) return reject(new Transient('timeout'));
      if (code) return reject(new Error(`claude exited ${code}`));
      try {
        const j = JSON.parse(out);
        resolve({ text: String(j.result ?? ''), tokensIn: j.usage?.input_tokens, tokensOut: j.usage?.output_tokens });
      } catch { reject(new Error('claude output is not JSON')); }
    });
    p.stdin.end(flatten(o));
  });
}

const PROVIDERS: Record<string, (cfg: Cfg, o: GenOpts, model: string) => Promise<Raw>> = {
  async ollama(cfg, o, model) {
    const j = await post(`${cfg.OLLAMA_URL.replace(/\/$/, '')}/api/chat`, { model, messages: o.messages, stream: false, ...(o.schema ? { format: o.schema } : {}), options: { num_ctx: Number(cfg.CTX) } }, cfg);
    return { text: String(j.message?.content ?? ''), tokensIn: j.prompt_eval_count, tokensOut: j.eval_count };
  },
  async openai(cfg, o, model) {
    const j = await post(`${cfg.LLM_OPENAI_URL.replace(/\/$/, '')}/v1/chat/completions`, { model, messages: o.messages,
      ...(o.schema ? { response_format: { type: 'json_schema', json_schema: { name: 'out', schema: o.schema } } } : {}) }, cfg);
    return { text: String(j.choices?.[0]?.message?.content ?? ''), tokensIn: j.usage?.prompt_tokens, tokensOut: j.usage?.completion_tokens };
  },
  'claude-cli': (cfg, o) => claudeCli(cfg, o),
};

// One line per attempt, without content: {ts, task, provider, model, ms, ok, tokensIn, tokensOut, error_kind}
function usage(task: string, r: GenResult): void {
  try {
    fs.mkdirSync(P.BOSUN, { recursive: true });
    fs.appendFileSync(path.join(P.BOSUN, 'llm-usage.jsonl'), `${JSON.stringify({ ts: Date.now(), task, provider: r.provider, model: r.model, ms: Math.round(r.ms), ok: r.ok,
      tokensIn: r.tokensIn ?? null, tokensOut: r.tokensOut ?? null, error_kind: r.error ?? null })}\n`);
  } catch { /* never breaks a caller */ }
  record({ op: 'llm', ms: r.ms, provider: r.provider, ok: r.ok });
}

export async function generate(cfg: Cfg, o: GenOpts): Promise<GenResult> {
  const chain = cfg.LLM_PROVIDERS.split(',').map((s) => s.trim()).filter((p) => p && p !== 'claude-cli');
  if (cfg.LLM_REMOTE === 'claude' && o.allowRemote && !o.private) chain.push('claude-cli');
  let last: GenResult = { ok: false, text: '', provider: 'none', model: '', ms: 0, error: 'no provider' };
  for (const name of chain) {
    const fn = PROVIDERS[name];
    const model = name === 'claude-cli' ? 'haiku' : cfg.LLM_MODEL || cfg.LOCAL_MODEL;
    if (!fn) { last = { ...last, provider: name, error: 'unknown provider' }; continue; }
    for (let attempt = 0; ; attempt++) {
      const t = performance.now();
      let r: GenResult;
      try {
        const raw = await fn(cfg, o, model);
        let json: any;
        let error: string | undefined;
        if (o.schema) {
          try { json = JSON.parse(raw.text); } catch { error = 'bad_json'; }
          if (!error && validate(o.schema, json)) error = 'invalid';
        }
        r = { ok: !error, text: raw.text, ...(o.schema && !error ? { json } : {}), provider: name, model, ms: performance.now() - t, tokensIn: raw.tokensIn, tokensOut: raw.tokensOut, ...(error ? { error } : {}) };
      } catch (e) {
        r = { ok: false, text: '', provider: name, model, ms: performance.now() - t, error: e instanceof Transient ? e.message : 'error' };
      }
      usage(o.task, r);
      if (r.ok) return r;
      last = r;
      if (!(r.error === 'timeout' || r.error === 'connection') || attempt >= Number(cfg.LLM_RETRIES)) break;
      await new Promise((res) => setTimeout(res, 500 * 2 ** attempt));
    }
  }
  return last;
}

const SUGGEST: Schema = { type: 'object', required: ['title', 'tags'], properties: { title: { type: 'string', maxLength: 200 }, tags: { type: 'array', maxItems: 12, items: { type: 'string', maxLength: 40 } } } };
// memory add --auto: a suggested title and tags, which explicit flags override.
export async function suggest(cfg: Cfg, text: string, priv: boolean): Promise<{ title: string; tags: unknown[] } | null> {
  const r = await generate(cfg, { task: 'memory.add', schema: SUGGEST, allowRemote: true, private: priv, messages: [
    { role: 'user', content: `Suggest a short title (under 80 characters) and 1-4 lowercase tags (a-z, 0-9, hyphens) for this note. Reply with JSON only: {"title": "...", "tags": ["..."]}\n\n${text.slice(0, 4000)}` }] });
  return r.ok ? { title: String(r.json.title).trim().slice(0, 200), tags: r.json.tags } : null;
}
```

(`suggest`'s prompt starts with "Suggest", which is what the CLI test's mock keys on.)

- [ ] **Step 5: `lib/consolidate.ts`**

```ts
// Consolidation: a local LLM turns this repo's recent claude-mem session summaries into proposed memories that wait for review.
import type { Cfg } from './config.ts';
import { generate } from './llm.ts';
import { log } from './log.ts';
import type { ClaudeMem, Summary } from './memory/claudemem.ts';
import { cleanTags } from './memory/service.ts';
import { jaccard, words } from './memory/sqlite.ts';
import { MemoryError, type Ctx, type Memory, type MemoryApi, type StoreInput } from './memory/types.ts';
import type { Schema } from './util.ts';

const schema = (ids: string[]): Schema => ({ type: 'object', required: ['candidates'], properties: { candidates: { type: 'array', maxItems: 20, items: {
  type: 'object', required: ['summary_id', 'category', 'title', 'body', 'tags'], properties: {
    summary_id: { type: 'string', enum: ids }, category: { type: 'string', enum: ['project', 'personal'] },
    title: { type: 'string', maxLength: 200 }, body: { type: 'string', maxLength: 4000 }, tags: { type: 'array', maxItems: 12, items: { type: 'string', maxLength: 40 } } } } } } });

const SYSTEM = `You turn coding-session summaries into durable memories for a developer's assistant.
Keep only facts that stay true after the session: decisions and why, conventions, gotchas, commands, where things live.
Skip progress reports, one-off tasks and anything obvious from the code. Each memory: a short title, a self-contained body
under 600 characters, 1-4 lowercase tags. Use category "personal" only for the developer's own preferences; everything else is "project".
Set summary_id to the id of the summary it came from. Return {"candidates": []} when nothing qualifies. Reply with JSON only.`;

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const userMsg = (project: string, rows: Summary[]) => `Project: ${project}\n\n${rows.map((s) => `[${s.id}] ${new Date(s.at).toISOString().slice(0, 10)}
request: ${cut(s.request, 400)}\nlearned: ${cut(s.learned, 800)}\ncompleted: ${cut(s.completed, 400)}\nnext steps: ${cut(s.nextSteps, 300)}`).join('\n\n')}`;

// Near-duplicate: same category and a word-set overlap of at least 0.8 with an active or proposed memory.
async function nearDuplicate(api: MemoryApi, ctx: Ctx, input: StoreInput): Promise<string | undefined> {
  const ws = words(`${input.title} ${input.body}`);
  const hits = await api.search({ text: `${input.title} ${input.body}`, status: ['active', 'proposed'], limit: 10, includePrivate: true, touch: false }, ctx);
  return hits.find((h) => h.category === input.category && jaccard(words(`${h.title} ${h.body}`), ws) >= 0.8)?.id;
}

export async function consolidate(cfg: Cfg, api: MemoryApi, ctx: Ctx, cm: ClaudeMem, o: { since: number; limit: number }) {
  const rows = cm.summaries(o.since, o.limit);
  const out = { summaries: rows.length, proposed: [] as Memory[], skipped: [] as { title: string; why: string }[], error: undefined as string | undefined };
  if (!rows.length) return out;
  const r = await generate(cfg, { task: 'consolidate', allowRemote: true, schema: schema(rows.map((s) => String(s.id))), messages: [
    { role: 'system', content: SYSTEM }, { role: 'user', content: userMsg(JSON.parse(cm.projects)[0] || '', rows) }] });
  if (!r.ok) return { ...out, error: `the LLM gave no usable output (${r.provider}: ${r.error}); nothing written` };
  for (const c of r.json.candidates as any[]) {
    const input: StoreInput = { category: c.category, title: String(c.title).trim().slice(0, 200), body: String(c.body).trim().slice(0, 4000),
      tags: cleanTags(c.tags), status: 'proposed', source: `consolidate:${r.provider}/${r.model}`, sourceRef: `claude-mem:summary:${c.summary_id}` };
    try {
      const near = await nearDuplicate(api, ctx, input);
      if (near) { out.skipped.push({ title: input.title, why: `near-duplicate of ${near}` }); continue; }
      const s = await api.store(input, ctx);
      if (s.duplicate) out.skipped.push({ title: input.title, why: `duplicate of ${s.memory.id}` });
      else out.proposed.push(s.memory);
    } catch (e) {
      if (e instanceof MemoryError && e.code === 'invalid') out.skipped.push({ title: input.title, why: e.message });
      else throw e;
    }
  }
  log('info', 'consolidate', { summaries: rows.length, proposed: out.proposed.length, skipped: out.skipped.length, provider: r.provider });
  return out;
}
```

- [ ] **Step 6: CLI verbs** in `lib/memory/cli.ts`:
  - `add` (explicit `-t`/`--tags` win over suggestions):

```ts
        let title = v.title;
        let tags = list(v.tags);
        if (v.auto && (!title || !tags)) {
          const s = await suggest(cfg, body, !!v.private);
          if (s) { title ??= s.title; tags ??= cleanTags(s.tags); }
          else console.error('bosun: --auto: no usable suggestion from the LLM; using the first line');
        }
        title ??= body.split('\n')[0].slice(0, 80);
```
  - `consolidate`:

```ts
      case 'consolidate': {
        const days = Number(String(v.since ?? '7d').replace(/d$/, ''));
        if (!(days > 0)) return die('--since takes days, like 7d', 2);
        const last = state().consolidatedAt?.[ctx.projectId!] ?? 0;   // since the last run, within the --since window
        const cm = new ClaudeMem(cfg, [proj.name, path.basename(dir)]);
        const r = await consolidate(cfg, mem(), ctx, cm, { since: Math.max(Date.now() - days * 86400000, last), limit: num(v.limit, 'limit') ?? 20 });
        if (r.error) { console.error(`bosun: ${r.error}`); return 1; }
        const st = state();
        saveState({ ...st, consolidatedAt: { ...(st.consolidatedAt || {}), [ctx.projectId!]: Date.now() } });
        console.log(`${r.summaries} session summaries → ${r.proposed.length} proposals${r.skipped.length ? `, ${r.skipped.length} skipped` : ''}`);
        for (const m of r.proposed) console.log(`  + ${m.id} ${m.title}`);
        for (const s of r.skipped) console.log(`  - ${s.title}: ${s.why}`);
        if (r.proposed.length) console.log('review them: bosun memory review');
        return 0;
      }
```

- [ ] **Step 7: run** `node --test test/llm.test.ts`, then `npm test` and the type check → all pass.

- [ ] **Step 8: checkpoint** in the ledger.

---

### Task 6: MCP server, host registration, doctor checks

**Files:**
- Create: `lib/mcp.ts`
- Modify: `lib/cli.ts` (`mcp` command; doctor becomes async and checks memory + MCP registration), `lib/wire.ts` (register/unregister; `PERMS` gains `memory`), `policy.md` (one memory rule)
- Test: `test/mcp.test.ts`

**Interfaces:**
- Consumes: `FIELDS`, `PATCH`, `openMemory`, `retrieve`, `curated`, `Docs`, `ClaudeMem`, `project`, `projectDir`, `makeCtx`, `validate`, `VERSION`, `openDb`, `schemaVersion`.
- Produces: `main(cfg: Cfg): Promise<number>` (serves until stdin ends), `handle(line, tools, cfg, send)`, `VERSIONS`. `wire.mcpCmd(): string[]`.

- [ ] **Step 1: write the failing tests** — `test/mcp.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { sandbox, fresh, bosun, gitRepo, mcpSession as session, BIN } from './helpers.ts';
import { load, P } from '../lib/config.ts';
import { MemoryService } from '../lib/memory/service.ts';
import { openDb } from '../lib/memory/sqlite.ts';
import * as wire from '../lib/wire.ts';

// In test/helpers.ts: a real stdio session, one JSON line out per request, in order.
export function mcpSession(env: NodeJS.ProcessEnv, cwd: string) {
  const p = spawn(process.execPath, [BIN, 'mcp'], { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines: string[] = [];
  const waiting: ((v: any) => void)[] = [];
  let buf = '';
  p.stdout.on('data', (d) => {
    buf += d;
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const l = buf.slice(0, i);
      buf = buf.slice(i + 1);
      lines.push(l);
      waiting.shift()?.(JSON.parse(l));
    }
  });
  const send = (m: object | string) => p.stdin.write(`${typeof m === 'string' ? m : JSON.stringify(m)}\n`);
  const next = () => new Promise<any>((res) => waiting.push(res));
  let n = 100;
  return {
    send, next,
    rpc: (id: unknown, method: string, params?: object) => { send({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }); return next(); },
    call: (name: string, args: object) => { send({ jsonrpc: '2.0', id: n++, method: 'tools/call', params: { name, arguments: args } }); return next(); },
    close: () => new Promise<{ code: number | null; lines: string[] }>((res) => { p.on('close', (code) => res({ code, lines })); p.stdin.end(); }),
  };
}
const names = ['context_retrieve', 'memory_delete', 'memory_get', 'memory_search', 'memory_store', 'memory_update', 'project_knowledge_search'];

test('mcp: initialize echoes supported versions and falls back; tools/list schemas; ping; protocol errors; stdout carries only JSON', async () => {
  const sb = sandbox();
  try {
    const repo = gitRepo(sb, 'shop', 'git@github.com:org/shop.git');
    const s = session(sb.env(), repo);
    let r = await s.rpc(0, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(r.id, 0, 'id 0 is echoed');
    assert.equal(r.result.protocolVersion, '2025-06-18');
    assert.deepEqual(r.result.capabilities, { tools: {} });
    assert.equal(r.result.serverInfo.name, 'bosun');
    assert.match(r.result.instructions, /memory_search/);
    s.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    r = await s.rpc('a-1', 'initialize', { protocolVersion: '2024-01-01' });
    assert.deepEqual([r.id, r.result.protocolVersion], ['a-1', '2025-11-25']);
    assert.deepEqual((await s.rpc(2, 'ping')).result, {});
    const tools = (await s.rpc(3, 'tools/list')).result.tools;
    assert.deepEqual(tools.map((t: any) => t.name).sort(), names);
    for (const t of tools) {
      assert.ok(t.description.length < 300, t.name);
      assert.equal(t.inputSchema.type, 'object');
      assert.equal(t.inputSchema.additionalProperties, false);
      assert.equal(t.annotations.openWorldHint, false);
    }
    const ann = Object.fromEntries(tools.map((t: any) => [t.name, t.annotations]));
    for (const n of ['memory_search', 'memory_get', 'context_retrieve', 'project_knowledge_search']) assert.equal(ann[n].readOnlyHint, true, n);
    assert.deepEqual([ann.memory_store.readOnlyHint, ann.memory_store.destructiveHint], [false, false]);
    for (const n of ['memory_update', 'memory_delete']) assert.deepEqual([ann[n].destructiveHint, ann[n].idempotentHint], [true, true], n);
    assert.equal((await s.rpc(4, 'server/discover')).error.code, -32601);
    assert.equal((await s.rpc(5, 'resources/list')).error.code, -32601);
    s.send('[{"jsonrpc":"2.0","id":6,"method":"ping"}]');
    r = await s.next();
    assert.deepEqual([r.id, r.error.code], [null, -32600]);
    s.send('{not json');
    r = await s.next();
    assert.deepEqual([r.id, r.error.code], [null, -32700]);
    assert.equal((await s.rpc(7, 'tools/call', { name: 'nope', arguments: {} })).error.code, -32602);
    const done = await s.close();
    assert.equal(done.code, 0);
    for (const l of done.lines) JSON.parse(l);
  } finally { sb.cleanup(); }
});

test('mcp: every tool works, before initialize too; isError paths; private redaction; arguments cannot change the project; output cap', async () => {
  const sb = sandbox();
  try {
    const repo = gitRepo(sb, 'shop', 'git@github.com:org/shop.git');
    fs.writeFileSync(path.join(repo, 'README.md'), '# Shop\n\nThe checkout page lives in web/checkout.\n');
    fresh(sb);
    const other = new MemoryService(openDb(P.DB), load());
    const foreign = (await other.store({ category: 'project', title: 'Other repo', body: 'pnpm elsewhere' }, { projectId: 'p_other', sessionId: null, linked: [] })).memory;
    other.close();
    const s = session(sb.env(), repo);
    let r = await s.call('memory_store', { category: 'project', title: 'Use pnpm', body: 'pnpm only; npm breaks the lockfile', tags: ['tooling'] });
    const m = r.result.structuredContent.memory;
    assert.equal(r.result.isError, undefined);
    assert.deepEqual(JSON.parse(r.result.content[0].text), r.result.structuredContent);
    assert.equal((await s.call('memory_search', { query: 'lockfile' })).result.structuredContent.hits[0].id, m.id);
    assert.match((await s.call('memory_get', { id: m.id })).result.structuredContent.memory.body, /lockfile/);
    assert.equal((await s.call('memory_update', { id: m.id, expectedVersion: 1, body: 'pnpm only.' })).result.structuredContent.memory.version, 2);
    r = await s.call('memory_update', { id: m.id, expectedVersion: 1, body: 'x' });
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /current version is 2/);
    assert.match((await s.call('context_retrieve', { task: 'pnpm lockfile install' })).result.structuredContent.text, /Use pnpm/);
    assert.match(JSON.stringify((await s.call('project_knowledge_search', { query: 'checkout page' })).result.structuredContent.hits), /README\.md/);
    assert.equal((await s.call('memory_delete', { id: m.id })).result.structuredContent.status, 'archived');
    assert.equal((await s.call('memory_delete', { id: m.id })).result.structuredContent.status, 'archived', 'idempotent');
    r = await s.call('memory_store', { category: 'project', title: '', body: 'SECRET-VALUE' });
    assert.equal(r.result.isError, true);
    assert.doesNotMatch(r.result.content[0].text, /SECRET-VALUE/);
    assert.equal((await s.call('memory_get', { id: foreign.id })).result.isError, true, 'another project\'s id is not found');
    r = await s.call('memory_search', { query: 'pnpm', projectId: 'p_other' });
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /unknown field/);
    r = await s.call('memory_store', { category: 'project', title: 'Secret', body: 'PRIVATE-BODY token', private: true });
    const p = r.result.structuredContent.memory;
    assert.equal(p.body, '[private]');
    assert.equal((await s.call('memory_get', { id: p.id })).result.structuredContent.memory.body, '[private]');
    assert.equal((await s.call('memory_search', { query: 'token' })).result.structuredContent.hits.length, 0);
    assert.doesNotMatch((await s.call('context_retrieve', { task: 'private body token' })).result.structuredContent.text, /PRIVATE-BODY/);
    await s.close();
    const small = session(sb.env({ MCP_MAX_CHARS: '400' }), repo);
    for (let i = 0; i < 5; i++) await small.call('memory_store', { category: 'project', title: `cap ${i}`, body: `capped result number ${i} ${'x'.repeat(80)}` });
    r = await small.call('memory_search', { query: 'capped result' });
    assert.equal(r.result.structuredContent.truncated, true);
    assert.ok(r.result.content[0].text.length <= 400);
    await small.close();
  } finally { sb.cleanup(); }
});

test('wire: registers the MCP server with Claude and every Codex home; unwire removes it; doctor checks it', async () => {
  const sb = sandbox();
  try {
    const orcaHome = path.join(sb.home, 'Library/Application Support/orca/codex-runtime-home/home');
    fs.mkdirSync(orcaHome, { recursive: true });
    fresh(sb);
    const cfg = load();
    wire.wireClaude(cfg);
    wire.wireCodex(cfg);
    const add = sb.calls().find((c) => c.bin === 'claude' && c.argv[1] === 'add');
    assert.deepEqual(add!.argv, ['mcp', 'add', '--scope', 'user', 'bosun', '--', process.execPath, BIN, 'mcp']);
    const cx = sb.calls().filter((c) => c.bin === 'codex' && c.argv[1] === 'add');
    assert.deepEqual(cx.map((c) => c.env.CODEX_HOME), [path.join(sb.home, '.codex'), orcaHome]);
    assert.deepEqual(cx[0].argv, ['mcp', 'add', 'bosun', '--', process.execPath, BIN, 'mcp']);
    sb.reset();
    wire.unwire();
    const rm = sb.calls().map((c) => `${c.bin} ${c.argv.join(' ')}`);
    assert.ok(rm.includes('claude mcp remove --scope user bosun'));
    assert.equal(rm.filter((c) => c === 'codex mcp remove bosun').length, 2);
    assert.match((await bosun(['doctor'], { env: sb.env({ OLLAMA_URL: 'http://127.0.0.1:1', ROUTER_PORT: '1' }) })).out, /bosun MCP server in Claude Code/);
    const missing = await bosun(['doctor'], { env: sb.env({ OLLAMA_URL: 'http://127.0.0.1:1', ROUTER_PORT: '1', STUB_MAP: JSON.stringify({ 'claude mcp': { code: 1 }, 'codex mcp': { code: 1 } }) }) });
    assert.match(missing.out, /MCP server missing in Claude Code: bosun install/);
    assert.match(missing.out, /memory .*memory\.db \(schema v1\)/);
  } finally { sb.cleanup(); }
});
```

- [ ] **Step 2: run** `node --test test/mcp.test.ts` → expected: FAIL (`mcp` is an unknown command).

- [ ] **Step 3: `lib/mcp.ts`**

```ts
// MCP server (`bosun mcp`): stdio, newline-delimited JSON-RPC 2.0, protocol 2025-11-25 (it echoes older supported versions).
// stdout carries protocol messages only; console output goes to stderr.
import path from 'node:path';
import readline from 'node:readline';
import { P, VERSION, type Cfg } from './config.ts';
import { curated, retrieve } from './context.ts';
import { log } from './log.ts';
import { ClaudeMem } from './memory/claudemem.ts';
import { Docs } from './memory/docs.ts';
import { makeCtx, project, projectDir } from './memory/project.ts';
import { FIELDS, PATCH, openMemory } from './memory/service.ts';
import { openDb } from './memory/sqlite.ts';
import { MemoryError, STATUSES, type Memory, type MemoryApi, type MemoryProvider, type StoreInput } from './memory/types.ts';
import { validate, type Schema } from './util.ts';

export const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const INSTRUCTIONS = 'bosun memory: curated notes about this user and project. Before assuming how this repo works, try memory_search or '
  + 'context_retrieve; project_knowledge_search covers the repo\'s docs and past sessions. Use memory_store only for durable facts the user '
  + 'agrees to keep (decisions, conventions, gotchas), never secrets, and mark sensitive ones private. Ids work with memory_get, memory_update and memory_delete.';
type Args = Record<string, any>;
export type Tool = { name: string; description: string; inputSchema: Schema; annotations: Record<string, boolean>; run: (a: Args) => Promise<object> };
const obj = (properties: Record<string, Schema>, required: string[] = []): Schema => ({ type: 'object', additionalProperties: false, properties, required });
const hint = (readOnly: boolean, destructive: boolean, idempotent: boolean) => ({ readOnlyHint: readOnly, destructiveHint: destructive, idempotentHint: idempotent, openWorldHint: false });
const ID: Schema = { type: 'string', minLength: 1, maxLength: 64, description: 'a memory id (m_…)' };
const QUERY: Schema = { type: 'string', minLength: 1, maxLength: 2000 };
const SOURCES = ['curated', 'docs', 'claude-mem'];
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const redact = (m: Memory) => (m.private ? { ...m, body: '[private]' } : m);

export function tools(cfg: Cfg, dir: string): { list: Tool[]; close: () => void } {
  const proj = project(dir);
  const ctx = makeCtx(cfg, proj, null, 'mcp');
  let api: MemoryApi | null = null;
  let docs: Docs | null = null;
  const mem = () => (api ??= openMemory(cfg));
  const providers = (names: string[]): MemoryProvider[] => [
    ...(names.includes('curated') ? [curated(mem())] : []),
    ...(names.includes('docs') ? [(docs ??= new Docs(openDb(P.DB), dir, proj.id))] : []),
    ...(names.includes('claude-mem') ? [new ClaudeMem(cfg, [proj.name, path.basename(dir)])] : []),
  ];
  const list: Tool[] = [
    { name: 'memory_search', annotations: hint(true, false, true),
      description: 'Search curated memory (the user\'s personal notes and this project\'s) by keywords. Returns ids, titles and snippets; private memories are left out.',
      inputSchema: obj({ query: QUERY, category: FIELDS.category, status: { type: 'string', enum: STATUSES }, tags: FIELDS.tags, limit: { type: 'integer', minimum: 1, maximum: 50 } }, ['query']),
      run: async (a) => ({ hits: (await mem().search({ text: a.query, category: a.category, status: a.status ? [a.status] : undefined, tags: a.tags, limit: a.limit }, ctx))
        .map((m) => ({ id: m.id, category: m.category, status: m.status, title: m.title, snippet: m.body.slice(0, 300), tags: m.tags, updated: day(m.updatedAt) })) }) },
    { name: 'memory_get', annotations: hint(true, false, true),
      description: 'Read one memory by id: body, tags, status and version. A private memory comes back with its body hidden.',
      inputSchema: obj({ id: ID }, ['id']), run: async (a) => ({ memory: redact(await mem().get(a.id, ctx)) }) },
    { name: 'memory_store', annotations: hint(false, false, false),
      description: 'Save a durable fact worth remembering across sessions: a decision and why, a convention, a gotcha, a preference. Only with the user\'s agreement; never secrets. An existing duplicate is returned instead.',
      inputSchema: obj(FIELDS, ['category', 'title', 'body']),
      run: async (a) => { const r = await mem().store(a as StoreInput, ctx); return { memory: redact(r.memory), duplicate: r.duplicate }; } },
    { name: 'memory_update', annotations: hint(false, true, true),
      description: 'Change a memory\'s title, body, tags or flags, or set status active (accept a proposal) or archived. Pass the version you read as expectedVersion; a newer one returns a conflict.',
      inputSchema: obj({ id: ID, expectedVersion: { type: 'integer', minimum: 1 }, ...PATCH.properties }, ['id', 'expectedVersion']),
      run: async ({ id, expectedVersion, ...patch }) => ({ memory: redact(await mem().update(id, patch, expectedVersion, ctx)) }) },
    { name: 'memory_delete', annotations: hint(false, true, true),
      description: 'Archive a memory (a soft delete: the user can restore or purge it).',
      inputSchema: obj({ id: ID }, ['id']), run: async (a) => { const m = await mem().delete(a.id, ctx); return { id: m.id, status: m.status }; } },
    { name: 'context_retrieve', annotations: hint(true, false, true),
      description: 'Ranked, deduplicated context for a task from curated memory, this repo\'s docs and claude-mem history, fitted to a token budget (default ~1000).',
      inputSchema: obj({ task: { type: 'string', minLength: 1, maxLength: 8000 }, budgetTokens: { type: 'integer', minimum: 50, maximum: 4000 },
        sources: { type: 'array', maxItems: 3, items: { type: 'string', enum: SOURCES } } }, ['task']),
      run: async (a) => {
        const r = await retrieve(a.task, providers(a.sources || SOURCES), ctx, { budgetTokens: a.budgetTokens ?? 1000, minScore: 0, itemChars: Number(cfg.CONTEXT_ITEM_CHARS) });
        return { text: r.text, estTokens: r.estTokens, ids: r.items.map((i) => i.id), sources: r.sources, ms: Math.round(r.ms) };
      } },
    { name: 'project_knowledge_search', annotations: hint(true, false, true),
      description: 'Search this repo\'s Markdown docs and claude-mem\'s session history for this project.',
      inputSchema: obj({ query: QUERY, limit: { type: 'integer', minimum: 1, maximum: 20 } }, ['query']),
      run: async (a) => {
        const r = await retrieve(a.query, providers(['docs', 'claude-mem']), ctx, { budgetTokens: 4000, minScore: 0, itemChars: 600 });
        return { hits: r.items.slice(0, a.limit ?? 10).map((i) => ({ id: i.id, source: i.source, title: i.title, snippet: i.text.slice(0, 500), date: day(i.at) })) };
      } },
  ];
  return { list, close: () => { api?.close(); docs?.db.close(); } };
}

const error = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });
const fail = (text: string) => ({ content: [{ type: 'text', text }], isError: true });
function result(data: any, max: number): object {
  let text = JSON.stringify(data);
  const hits: unknown[] | null = Array.isArray(data.hits) ? data.hits : null;
  while (text.length > max && hits?.length) { hits.pop(); data.truncated = true; text = JSON.stringify(data); }
  if (text.length > max) return fail(`the result is larger than MCP_MAX_CHARS (${max})`);
  return { content: [{ type: 'text', text }], structuredContent: data };
}

export async function handle(line: string, list: Tool[], cfg: Cfg, send: (m: object) => void): Promise<void> {
  if (!line.trim()) return;
  let msg: any;
  try { msg = JSON.parse(line); } catch { return send(error(null, -32700, 'Parse error')); }
  if (Array.isArray(msg)) return send(error(null, -32600, 'Batches are not supported'));
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return send(error(msg?.id ?? null, -32600, 'Invalid Request'));
  if (msg.method === undefined) return;          // a response to a request we never sent
  if (typeof msg.method !== 'string') return send(error(msg.id ?? null, -32600, 'Invalid Request'));
  if (!('id' in msg)) return;                    // notifications need no answer
  const ok = (res: object) => send({ jsonrpc: '2.0', id: msg.id, result: res });
  switch (msg.method) {
    case 'initialize': {
      const want = msg.params?.protocolVersion;
      return ok({ protocolVersion: VERSIONS.includes(want) ? want : VERSIONS[0], capabilities: { tools: {} },
        serverInfo: { name: 'bosun', title: 'bosun memory', version: VERSION }, instructions: INSTRUCTIONS });
    }
    case 'ping': return ok({});
    case 'tools/list': return ok({ tools: list.map(({ run, ...t }) => t) });
    case 'tools/call': {
      const name = msg.params?.name;
      const tool = list.find((t) => t.name === name);
      if (!tool) return send(error(msg.id, -32602, `Unknown tool: ${String(name).slice(0, 64)}`));
      const args = msg.params?.arguments ?? {};
      const bad = validate(tool.inputSchema, args);
      if (bad) return ok(fail(`invalid arguments: ${bad}`));
      try { return ok(result(await tool.run(args), Number(cfg.MCP_MAX_CHARS))); } catch (e) {
        if (e instanceof MemoryError) return ok(fail(e.message));
        log('error', 'mcp.tool', { tool: name, err: e });
        return ok(fail('internal error (details in ~/.bosun/bosun.log)'));
      }
    }
    default: return send(error(msg.id, -32601, 'Method not found'));
  }
}

export async function main(cfg: Cfg): Promise<number> {
  console.log = console.info = console.debug = console.error;   // stdout is the protocol channel
  const { list, close } = tools(cfg, projectDir());
  const send = (m: object) => { process.stdout.write(`${JSON.stringify(m)}\n`); };
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let chain = Promise.resolve();
  rl.on('line', (line) => { chain = chain.then(() => handle(line, list, cfg, send)).catch((e) => log('error', 'mcp.handle', { err: e })); });
  await new Promise((res) => rl.once('close', res));
  await chain;
  close();
  return 0;
}
```

- [ ] **Step 4: `lib/wire.ts` — registration**

```ts
export const mcpCmd = (): string[] => [process.execPath, path.join(P.REPO, 'bin', 'bosun'), 'mcp'];
// (Un)register the bosun MCP server: Claude at user scope, Codex in every Codex home. Remove first, so re-installs stay idempotent.
function mcp(op: 'add' | 'rm'): void {
  if (has('claude')) {
    sh('claude', ['mcp', 'remove', '--scope', 'user', 'bosun']);
    if (op === 'add') { const r = sh('claude', ['mcp', 'add', '--scope', 'user', 'bosun', '--', ...mcpCmd()]); if (r.code) warn(`claude mcp add failed: ${r.err}`); }
  }
  if (has('codex')) {
    for (const h of codexHomes()) {
      const env = { ...process.env, CODEX_HOME: h };
      sh('codex', ['mcp', 'remove', 'bosun'], { env });
      if (op === 'add') { const r = sh('codex', ['mcp', 'add', 'bosun', '--', ...mcpCmd()], { env }); if (r.code) warn(`codex mcp add (${h}) failed: ${r.err}`); }
    }
  }
}
```

  - `wireClaude` ends with the Claude half, `wireCodex` with the Codex half (split `mcp()` into `mcpClaude(op)` and `mcpCodex(op)`). `unwire` calls both with `'rm'` after the hook cleanup. The `ok(…)` lines mention "MCP server bosun".
  - `PERMS` becomes `['run', 'review', 'spin', 'card', 'roles', 'route', 'memory'].map(…)`.

- [ ] **Step 5: `lib/cli.ts`**
  - `COMMANDS.mcp = (argv, cfg) => mcp.main(cfg)`. Usage gains `  bosun mcp                            MCP server for Claude Code and Codex (memory + context tools)`.
  - `doctor` becomes `async` (callers `await` it). After the host checks:

```ts
  if (hs.includes('claude')) chk('bosun MCP server in Claude Code', 'MCP server missing in Claude Code: bosun install', u.sh('claude', ['mcp', 'get', 'bosun']).code === 0);
  if (hs.includes('codex')) for (const h of wire.codexHomes()) chk(`bosun MCP server in ${h === P.CODEX ? '~/.codex' : 'Orca\'s Codex home'}`, `MCP server missing in ${h}: bosun install`, u.sh('codex', ['mcp', 'get', 'bosun'], { env: { ...process.env, CODEX_HOME: h } }).code === 0);
  let schema = 0;
  try { const db = openDb(P.DB); schema = schemaVersion(db); db.close(); } catch { /* reported below */ }
  chk(`memory ${P.DB} (schema v${schema})`, `memory database unreadable: ${P.DB} (see ~/.bosun/bosun.log)`, schema > 0);
```

  (Task 7 replaces the last three lines with the local/remote split.)

- [ ] **Step 6: `policy.md`** — after the Orca rule, add one line:

```
- Memory: the prompt hook adds a few relevant notes. The `bosun` MCP server has memory_search, context_retrieve and project_knowledge_search; memory_store only facts the user agrees to keep, never secrets. Proposals wait in `bosun memory review`.
```

- [ ] **Step 7: run** `node --test test/mcp.test.ts test/wire.test.ts test/cli.test.ts test/lint.test.ts`, then `npm test` and the type check → all pass.

- [ ] **Step 8: checkpoint** in the ledger.

---

### Task 7: Split setup — RemoteStore, `bosun serve`, install `--serve`/`--remote`, doctor, uninstall

**Files:**
- Create: `lib/memory/remote.ts`, `lib/serve.ts`
- Modify: `lib/memory/service.ts` (`openMemory` remote branch), `lib/cli.ts` (install/uninstall/doctor/start/stop/status/usage; `serve` command), `config.default.env` (split keys)
- Test: `test/serve.test.ts`

**Interfaces:**
- Consumes: `MemoryApi`, `MemoryError`, `MemoryService`, `retrieve`, `curated`, `record`, `log`, `services.svcWrite/svcOn/svcRm`, `setKey`, `state`/`saveState`, `parse`, `routerUrl`.
- Produces:
  - `class RemoteStore implements MemoryApi` — `constructor(cfg: Cfg, timeoutMs?: number)`, `health(): Promise<{ version: string; schema: number; memory: boolean }>`
  - `DEFAULT_ALLOW`, `tailscaleIp(): string`, `bindAddress(cfg): string`, `allowList(cfg, bind): string[]`, `allowed(addr: string | undefined, list: string[]): boolean`, `authorize(req): boolean`, `memoryServer(cfg, svc: MemoryApi, allow): http.Server`, `kevServer(cfg, allow): http.Server`, `listen(server, port, host): Promise<number>`, `main(argv, cfg): Promise<number>`

- [ ] **Step 1: config keys** — append to `config.default.env`:

```
# ── Split setup (optional; see README "Split setup") ─────────────────────
SERVE_BIND=                      # bosun serve: empty = this Mac's Tailscale IPv4; never 0.0.0.0 unless you set it
SERVE_ALLOW=                     # source IPs allowed; empty = 127.0.0.1/32,100.64.0.0/10 + SERVE_BIND's subnet
MEMORY_PORT=8788
REMOTE_TIMEOUT_MS=5000           # CLI and MCP calls to MEMORY_URL
REMOTE_HOOK_TIMEOUT_MS=300       # the prompt hook's memory part; it fails open
```

- [ ] **Step 2: write the failing tests** — `test/serve.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { sandbox, fresh, bosun, mock, gitRepo, mcpSession, BIN } from './helpers.ts';
import { load, parse } from '../lib/config.ts';
import { RemoteStore } from '../lib/memory/remote.ts';
import { MemoryService } from '../lib/memory/service.ts';
import { openDb } from '../lib/memory/sqlite.ts';
import { MemoryError, type Ctx, type MemoryApi } from '../lib/memory/types.ts';
import { DEFAULT_ALLOW, allowed, bindAddress, kevServer, listen, memoryServer } from '../lib/serve.ts';

const A: Ctx = { projectId: 'p_a', sessionId: 's1', linked: [] };
const B: Ctx = { projectId: 'p_b', sessionId: null, linked: [] };

// The same script against any MemoryApi; ids and timestamps are left out so two stores compare equal.
async function script(api: MemoryApi) {
  const out: unknown[] = [];
  const err = async (p: Promise<unknown>) => { try { await p; return 'no error'; } catch (e) { return e instanceof MemoryError ? e.code : String(e); } };
  const a = await api.store({ category: 'project', title: 'Use pnpm', body: 'pnpm only; npm breaks the lockfile', tags: ['tooling'] }, A);
  out.push(['store', a.duplicate, a.memory.version, a.memory.status]);
  out.push(['dup', (await api.store({ category: 'project', title: 'Use pnpm', body: 'pnpm only; npm breaks the lockfile' }, A)).duplicate]);
  out.push(['search', (await api.search({ text: 'lockfile' }, A)).map((h) => h.title)]);
  out.push(['get', (await api.get(a.memory.id, A, { events: true })).events!.map((e) => e.op)]);
  out.push(['update', (await api.update(a.memory.id, { body: 'pnpm only.' }, 1, A)).version]);
  out.push(['conflict', await err(api.update(a.memory.id, { body: 'x' }, 1, A))]);
  out.push(['scope', await err(api.get(a.memory.id, B))]);
  out.push(['invalid', await err(api.store({ category: 'nope' } as never, A))]);
  const p = (await api.store({ category: 'project', title: 'Proposal', body: 'a proposal', status: 'proposed' }, A)).memory;
  out.push(['accept', (await api.accept(p.id, A)).status]);
  const q = (await api.store({ category: 'project', title: 'Other', body: 'another proposal', status: 'proposed' }, A)).memory;
  out.push(['reject', (await api.reject(q.id, A)).status]);
  out.push(['delete', (await api.delete(a.memory.id, A)).status]);
  return out;
}

test('split: bosun serve memory + RemoteStore give the same results as the local store, operation by operation', async () => {
  const sb = sandbox();
  try {
    fresh(sb);
    const cfg = load();
    const server = new MemoryService(openDb(path.join(sb.root, 'server.db')), cfg);
    const srv = memoryServer(cfg, server, ['127.0.0.1/32']);
    const port = await listen(srv, 0, '127.0.0.1');
    const remote = new RemoteStore({ ...cfg, MEMORY_URL: `http://127.0.0.1:${port}` });
    const local = new MemoryService(openDb(path.join(sb.root, 'local.db')), cfg);
    assert.deepEqual(await script(remote), await script(local));
    const h = await remote.health();
    assert.equal(h.memory, true);
    const ctxRes = await fetch(`http://127.0.0.1:${port}/v1/context/retrieve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ctx: A, task: 'another proposal' }) });
    assert.equal((await ctxRes.json()).ok, true);
    const big = await fetch(`http://127.0.0.1:${port}/v1/memory/search`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ctx: A, query: { text: 'x'.repeat(70000) } }) });
    assert.equal(big.status, 413);
    const form = await fetch(`http://127.0.0.1:${port}/v1/memory/search`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' });
    assert.equal(form.status, 415);
    srv.close(); server.close(); local.close();
  } finally { sb.cleanup(); }
});

test('split: the allowlist rejects other sources (403); bind never defaults to 0.0.0.0; CIDR matching', async () => {
  const sb = sandbox();
  try {
    fresh(sb);
    const cfg = load();
    const svc = new MemoryService(openDb(path.join(sb.root, 's.db')), cfg);
    const srv = memoryServer(cfg, svc, ['10.0.0.0/8']);
    const port = await listen(srv, 0, '127.0.0.1');
    const r = await fetch(`http://127.0.0.1:${port}/v1/health`);
    assert.equal(r.status, 403);
    assert.deepEqual((await r.json()).ok, false);
    srv.close(); svc.close();
    assert.ok(allowed('100.101.102.103', DEFAULT_ALLOW));
    assert.ok(allowed('::ffff:127.0.0.1', DEFAULT_ALLOW));
    assert.ok(allowed('::1', DEFAULT_ALLOW));
    assert.ok(!allowed('8.8.8.8', DEFAULT_ALLOW));
    assert.ok(!allowed('fe80::1', DEFAULT_ALLOW));
    assert.ok(!allowed(undefined, DEFAULT_ALLOW));
    assert.ok(allowed('192.168.1.77', ['192.168.1.5/24']) && !allowed('192.168.2.77', ['192.168.1.5/24']));
    assert.throws(() => bindAddress({ ...cfg, SERVE_BIND: '' }), /never binds 0\.0\.0\.0/);
    fresh(sb, { STUB_MAP: JSON.stringify({ 'tailscale ip': { out: '100.101.102.103\n' } }) });
    fs.writeFileSync(path.join(sb.bin, 'tailscale'), fs.readFileSync(path.join(sb.bin, 'claude')), { mode: 0o755 });
    assert.equal(bindAddress({ ...cfg, SERVE_BIND: '' }), '100.101.102.103');
    assert.equal(bindAddress({ ...cfg, SERVE_BIND: '0.0.0.0' }), '0.0.0.0', 'only when you set it');
    const cli = await bosun(['serve', 'memory'], { env: sb.env({ PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` }) });
    assert.equal(cli.code, 1);
    assert.match(cli.err, /set SERVE_BIND/);
  } finally { sb.cleanup(); }
});

test('split: an unreachable, hanging or foreign memory server — the hook fails open in time, CLI and MCP say unavailable', async () => {
  const sb = sandbox();
  const kev = await mock();
  const html = await mock({ '/v1/memory/search': () => ({ status: 502, text: '<html>bad gateway</html>' }), '/v1/memory/store': () => ({ status: 502, text: '<html>bad gateway</html>' }) });
  const hang = http.createServer(() => { /* never answers */ });
  try {
    const hangPort = await listen(hang, 0, '127.0.0.1');
    const repo = gitRepo(sb, 'shop', 'git@github.com:org/shop.git');
    const hook = (url: string) => bosun(['route', '--hook'], { env: sb.env({ ROUTER_URL: kev.url, MEMORY_URL: url }), cwd: repo, input: JSON.stringify({ prompt: 'rename getCart to fetchCart in cart-service' }) });
    for (const url of ['http://127.0.0.1:1', `http://127.0.0.1:${hangPort}`, html.url]) {
      const t = Date.now();
      const r = await hook(url);
      assert.equal(r.code, 0);
      const c = JSON.parse(r.out).hookSpecificOutput.additionalContext;
      assert.doesNotMatch(c, /bosun memory/);
      assert.match(c, /suggests: local/, url);
      assert.ok(Date.now() - t < 2500, `${url}: ${Date.now() - t} ms`);
    }
    for (const url of ['http://127.0.0.1:1', html.url]) {
      const r = await bosun(['memory', 'search', 'x'], { env: sb.env({ MEMORY_URL: url }), cwd: repo });
      assert.equal(r.code, 1);
      assert.match(r.err, /memory server (unreachable at|at .* sent no bosun reply)/);
    }
    const s = mcpSession(sb.env({ MEMORY_URL: html.url }), repo);
    const res = await s.call('memory_store', { category: 'project', title: 't', body: 'b' });
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /memory server at .* sent no bosun reply/);
    await s.close();
  } finally { hang.close(); await kev.close(); await html.close(); sb.cleanup(); }
});

test('split: doctor checks the memory server and warns on a version mismatch; the remote model is checked via /api/tags', async () => {
  const sb = sandbox();
  const m = await mock({ '/v1/health': () => ({ json: { ok: true, data: { version: '0.0.1', schema: 1, memory: true } } }) });
  try {
    const r = await bosun(['doctor'], { env: sb.env({ MEMORY_URL: m.url, OLLAMA_URL: m.url, ROUTER_URL: 'http://127.0.0.1:1' }) });
    assert.match(r.out, /memory server http:\/\/127\.0\.0\.1:\d+ \(bosun 0\.0\.1, schema v1\)/);
    assert.match(r.out, /memory server runs bosun 0\.0\.1, this is 0\.2\.0/);
    assert.match(r.out, /model missing on http:\/\/127\.0\.0\.1:\d+/);
    assert.match(r.out, /kev down/);
  } finally { await m.close(); sb.cleanup(); }
});

test('split: bosun serve kev forwards to Kev and applies the allowlist', async () => {
  const sb = sandbox();
  const kev = await mock();
  try {
    fresh(sb);
    const cfg = { ...load(), ROUTER_PORT: new URL(kev.url).port };
    const px = kevServer(cfg, ['127.0.0.1/32']);
    const port = await listen(px, 0, '127.0.0.1');
    const body = JSON.stringify({ state: { request: 'rename a to b' } });
    const r = await fetch(`http://127.0.0.1:${port}/v1/systemone`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.equal((await r.json()).answers.lane.choice, 'local');
    assert.equal(kev.requests.length, 1);
    const deny = kevServer(cfg, ['10.0.0.0/8']);
    const dport = await listen(deny, 0, '127.0.0.1');
    assert.equal((await fetch(`http://127.0.0.1:${dport}/v1/systemone`, { method: 'POST', body })).status, 403);
    assert.equal(kev.requests.length, 1, 'nothing reached Kev');
    px.close(); deny.close();
  } finally { await kev.close(); sb.cleanup(); }
});

test('install --remote writes the URLs, skips local Ollama and Kev, registers MCP; uninstall restores the config; bad options change nothing', async () => {
  const sb = sandbox({ stubs: ['claude', 'codex', 'brew', 'launchctl', 'ollama'] });
  try {
    const env = sb.env({ BOSUN_OLLAMA_APP: path.join(sb.root, 'no-app') });
    for (const bad of [['--serve', 'bogus'], ['--remote', 'kev=ftp://x'], ['--remote', 'nope=http://x'], ['--serve', 'kev', '--remote', 'llm=http://x']]) {
      const r = await bosun(['install', ...bad], { env });
      assert.equal(r.code, 2, bad.join(' '));
    }
    assert.ok(!fs.existsSync(path.join(sb.home, '.claude')), 'nothing touched');
    const url = 'http://127.0.0.1:1';
    const r = await bosun(['install', '--host', 'claude', '--remote', `kev=${url},llm=${url},memory=${url}`], { env });
    assert.equal(r.code, 0, r.err);
    const cfg = parse(path.join(sb.home, '.bosun', 'config.env'));
    assert.deepEqual([cfg.ROUTER_URL, cfg.OLLAMA_URL, cfg.MEMORY_URL], [url, url, url]);
    const calls = sb.calls();
    assert.ok(!calls.some((c) => c.bin === 'ollama' && c.argv[0] === 'pull'), 'no model pull for a remote llm');
    assert.ok(!calls.some((c) => c.bin === 'launchctl' && c.argv[0] === 'bootstrap'), 'no local services');
    assert.ok(calls.some((c) => c.bin === 'claude' && c.argv.slice(0, 2).join(' ') === 'mcp add'));
    assert.equal((await bosun(['uninstall'], { env })).code, 0);
    const after = parse(path.join(sb.home, '.bosun', 'config.env'));
    assert.deepEqual([after.ROUTER_URL, after.OLLAMA_URL, after.MEMORY_URL], ['', 'http://127.0.0.1:11434', '']);
  } finally { sb.cleanup(); }
});

test('install --serve sets up only the listed services on the bind address; uninstall removes them', async () => {
  const sb = sandbox({ stubs: ['brew', 'launchctl', 'ollama', 'uv', 'git', 'curl'] });
  try {
    fs.mkdirSync(path.join(sb.home, '.local', 'share', 'bosun', 'kev', '.git'), { recursive: true });
    const env = sb.env({ SERVE_BIND: '127.0.0.1', BOSUN_OLLAMA_APP: path.join(sb.root, 'no-app'), STUB_MAP: JSON.stringify({ 'ollama --version': { out: 'ollama version is 0.34.4' } }) });
    const r = await bosun(['install', '--serve', 'kev,llm,memory'], { env });
    assert.equal(r.code, 0, r.err);
    const cfg = parse(path.join(sb.home, '.bosun', 'config.env'));
    assert.deepEqual([cfg.SERVE_BIND, cfg.OLLAMA_URL], ['127.0.0.1', 'http://127.0.0.1:11434']);
    const la = path.join(sb.home, 'Library', 'LaunchAgents');
    for (const n of ['memory', 'kev-proxy', 'router', 'ollama']) assert.ok(fs.existsSync(path.join(la, `com.bosun.${n}.plist`)), n);
    assert.match(fs.readFileSync(path.join(la, 'com.bosun.memory.plist'), 'utf8'), new RegExp(`<string>${BIN}</string><string>serve</string><string>memory</string>`));
    assert.ok(!fs.existsSync(path.join(sb.home, '.claude')), 'a server install wires no hosts');
    assert.match(r.out, /bosun install --remote kev=http:\/\/127\.0\.0\.1:8009,llm=http:\/\/127\.0\.0\.1:11434,memory=http:\/\/127\.0\.0\.1:8788/);
    assert.equal((await bosun(['uninstall'], { env })).code, 0);
    for (const n of ['memory', 'kev-proxy']) assert.ok(!fs.existsSync(path.join(la, `com.bosun.${n}.plist`)), n);
  } finally { sb.cleanup(); }
});
```

`mcpSession` comes from `test/helpers.ts` (Task 6).

- [ ] **Step 3: run** `node --test test/serve.test.ts` → expected: FAIL, missing modules.

- [ ] **Step 4: `lib/memory/remote.ts`**

```ts
// RemoteStore: the memory API over HTTP (MEMORY_URL), the same interface as the local MemoryService.
// Unreachable or foreign servers become `unavailable`. No offline queue: a write while offline fails visibly.
import type { Cfg } from '../config.ts';
import { record } from '../metrics.ts';
import { MemoryError, type Ctx, type ErrorCode, type Found, type Memory, type MemoryApi, type MemoryEvent, type Patch, type Query, type StoreInput } from './types.ts';

const CODES: ErrorCode[] = ['not_found', 'conflict', 'invalid', 'unavailable'];

export class RemoteStore implements MemoryApi {
  url: string;
  timeoutMs: number;
  token: string;
  constructor(cfg: Cfg, timeoutMs = Number(cfg.REMOTE_TIMEOUT_MS)) {
    this.url = cfg.MEMORY_URL.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
    this.token = cfg.MEMORY_TOKEN || '';
  }
  private async call<T>(route: string, body?: object): Promise<T> {
    const t = performance.now();
    let j: any;
    try {
      const r = await fetch(`${this.url}/v1/${route}`, {
        method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(this.timeoutMs),
        headers: { 'content-type': 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      j = await r.json().catch(() => null);
    } catch {
      throw new MemoryError('unavailable', `memory server unreachable at ${this.url}`);
    } finally { record({ op: `remote.${route}`, ms: performance.now() - t }); }
    if (!j || typeof j !== 'object' || typeof j.ok !== 'boolean') throw new MemoryError('unavailable', `memory server at ${this.url} sent no bosun reply`);
    if (!j.ok) throw new MemoryError(CODES.includes(j.error?.code) ? j.error.code : 'unavailable', String(j.error?.message ?? 'error').slice(0, 300), j.error?.current);
    return j.data as T;
  }
  store(input: StoreInput, ctx: Ctx) { return this.call<{ memory: Memory; duplicate: boolean }>('memory/store', { ctx, input }); }
  search(query: Query, ctx: Ctx) { return this.call<Found[]>('memory/search', { ctx, query }); }
  get(id: string, ctx: Ctx, opts: { events?: boolean } = {}) { return this.call<Memory & { events?: MemoryEvent[] }>('memory/get', { ctx, id, events: !!opts.events }); }
  update(id: string, patch: Patch, expectedVersion: number, ctx: Ctx) { return this.call<Memory>('memory/update', { ctx, id, patch, expectedVersion }); }
  delete(id: string, ctx: Ctx) { return this.call<Memory>('memory/delete', { ctx, id }); }
  accept(id: string, ctx: Ctx) { return this.call<Memory>('memory/accept', { ctx, id }); }
  reject(id: string, ctx: Ctx) { return this.call<Memory>('memory/reject', { ctx, id }); }
  health() { return this.call<{ version: string; schema: number; memory: boolean }>('health'); }
  close(): void { /* nothing held */ }
}
```

And in `service.ts`:

```ts
export function openMemory(cfg: Cfg, timeoutMs?: number): MemoryApi {
  return cfg.MEMORY_URL ? new RemoteStore(cfg, timeoutMs) : new MemoryService(openDb(P.DB), cfg);
}
```

- [ ] **Step 5: `lib/serve.ts`**

```ts
// bosun serve memory|kev: the /v1 memory API, or an allowlisting Kev forwarder, bound to a private interface.
// No tokens in v1: safety is the bind address plus a source-IP allowlist. authorize() is the one place auth goes later.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import { P, VERSION, type Cfg } from './config.ts';
import { curated, retrieve } from './context.ts';
import { log } from './log.ts';
import { MemoryService } from './memory/service.ts';
import { MIGRATIONS, openDb } from './memory/sqlite.ts';
import { MemoryError, type Ctx, type ErrorCode, type MemoryApi } from './memory/types.ts';
import { die, sh, validate, type Schema } from './util.ts';

export const DEFAULT_ALLOW = ['127.0.0.1/32', '100.64.0.0/10'];
const MAX_BODY = 64 * 1024;
const STATUS: Record<ErrorCode, number> = { not_found: 404, conflict: 409, invalid: 400, unavailable: 503 };
const CTX: Schema = { type: 'object', required: ['projectId'], properties: {
  projectId: { type: 'string', maxLength: 64 }, sessionId: { type: 'string', maxLength: 200 },
  linked: { type: 'array', maxItems: 50, items: { type: 'string', maxLength: 64 } }, source: { type: 'string', maxLength: 64 } } };

export function tailscaleIp(): string {
  for (const bin of ['tailscale', P.TAILSCALE_APP]) {
    if (bin !== 'tailscale' && !fs.existsSync(bin)) continue;
    const ip = sh(bin, ['ip', '-4']).out.split('\n')[0].trim();
    if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip;
  }
  return '';
}
export function bindAddress(cfg: Cfg): string {
  return cfg.SERVE_BIND || tailscaleIp()
    || die('no private interface to bind: Tailscale not found, so set SERVE_BIND to this Mac\'s LAN IP (bosun never binds 0.0.0.0 unless you set it)');
}
// SERVE_ALLOW, else loopback + Tailscale + the subnet of the bind address (from the interface's own netmask)
export function allowList(cfg: Cfg, bind: string): string[] {
  if (cfg.SERVE_ALLOW) return cfg.SERVE_ALLOW.split(',').map((s) => s.trim()).filter(Boolean);
  const net = Object.values(os.networkInterfaces()).flat().find((a) => a?.address === bind)?.cidr;
  return [...DEFAULT_ALLOW, ...(net ? [net] : [])];
}
const ip4 = (s: string) => s.split('.').reduce((n, o) => n * 256 + Number(o), 0);
export function allowed(addr: string | undefined, list: string[]): boolean {
  const a = String(addr || '').replace(/^::ffff:/, '').replace(/^::1$/, '127.0.0.1');
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(a)) return false;
  return list.some((c) => {
    const [net, bits = '32'] = c.split('/');
    const size = 2 ** (32 - Number(bits));
    return Math.floor(ip4(a) / size) === Math.floor(ip4(net) / size);
  });
}
// The auth middleware point. v1 has no tokens (clients already send MEMORY_TOKEN as a Bearer header; it is not checked yet).
export function authorize(_req: http.IncomingMessage): boolean { return true; }

class HttpError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    // ponytail: an oversized body is drained, not cut off, so the 413 still reaches the client; fine on a private network
    req.on('data', (c: Buffer) => { size += c.length; if (size <= MAX_BODY) chunks.push(c); });
    req.on('end', () => {
      if (size > MAX_BODY) return reject(new HttpError(413, 'request body over 64 KB'));
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new HttpError(400, 'invalid JSON')); }
    });
    req.on('error', reject);
  });
}

const ROUTES: Record<string, (s: MemoryApi, b: any, c: Ctx) => Promise<unknown>> = {
  '/v1/memory/store': (s, b, c) => s.store(b.input, c),
  '/v1/memory/search': (s, b, c) => s.search(b.query ?? {}, c),
  '/v1/memory/get': (s, b, c) => s.get(b.id, c, { events: b.events === true }),
  '/v1/memory/update': (s, b, c) => s.update(b.id, b.patch ?? {}, b.expectedVersion, c),
  '/v1/memory/delete': (s, b, c) => s.delete(b.id, c),
  '/v1/memory/accept': (s, b, c) => s.accept(b.id, c),
  '/v1/memory/reject': (s, b, c) => s.reject(b.id, c),
  '/v1/context/retrieve': (s, b, c) => retrieve(String(b.task ?? ''), [curated(s)], c, { budgetTokens: Number(b.budgetTokens) || 400, minScore: Number(b.minScore) || 0, itemChars: 400 }),
};

export function memoryServer(cfg: Cfg, svc: MemoryApi, allow: string[]): http.Server {
  void cfg;
  return http.createServer(async (req, res) => {
    const send = (status: number, body: object) => { if (!res.headersSent) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); } };
    const fail = (status: number, code: ErrorCode, message: string, current?: number) => send(status, { ok: false, error: { code, message, ...(current ? { current } : {}) } });
    try {
      if (!allowed(req.socket.remoteAddress, allow)) { log('warn', 'serve.denied', { from: req.socket.remoteAddress }); return fail(403, 'invalid', 'forbidden'); }
      if (!authorize(req)) return fail(401, 'invalid', 'unauthorized');
      const url = (req.url || '').split('?')[0];
      if (req.method === 'GET' && url === '/v1/health') return send(200, { ok: true, data: { version: VERSION, schema: MIGRATIONS.length, memory: true } });
      const route = ROUTES[url];
      if (req.method !== 'POST' || !route) return fail(404, 'not_found', 'no such route');
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) return fail(415, 'invalid', 'JSON only');
      const body = await readBody(req);
      const bad = validate(CTX, body.ctx);
      if (bad) return fail(400, 'invalid', bad);
      const c: Ctx = { projectId: body.ctx.projectId, sessionId: body.ctx.sessionId ?? null, linked: body.ctx.linked ?? [], source: body.ctx.source ?? 'remote' };
      return send(200, { ok: true, data: await route(svc, body, c) });
    } catch (e) {
      if (e instanceof MemoryError) return fail(STATUS[e.code], e.code, e.message, e.current);
      if (e instanceof HttpError) return fail(e.status, 'invalid', e.message);
      log('error', 'serve.memory', { err: e });
      return fail(500, 'unavailable', 'internal error');
    }
  });
}

// Kev keeps its own 127.0.0.1 port; this listens on the bind address and forwards allowed requests to it.
export function kevServer(cfg: Cfg, allow: string[]): http.Server {
  return http.createServer((req, res) => {
    if (!allowed(req.socket.remoteAddress, allow)) { log('warn', 'serve.denied', { from: req.socket.remoteAddress }); res.writeHead(403).end(); return; }
    const up = http.request({ host: '127.0.0.1', port: Number(cfg.ROUTER_PORT), method: req.method, path: req.url, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(up);
  });
}

export function listen(server: http.Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve((server.address() as { port: number }).port));
  });
}

export async function main(argv: string[], cfg: Cfg): Promise<number> {
  const kind = argv[0];
  if (kind !== 'memory' && kind !== 'kev') return die('usage: bosun serve memory|kev [--port N]', 2);
  const bind = bindAddress(cfg);
  const allow = allowList(cfg, bind);
  const pi = argv.indexOf('--port');
  const port = pi >= 0 ? Number(argv[pi + 1]) : Number(kind === 'memory' ? cfg.MEMORY_PORT : cfg.ROUTER_PORT);
  const svc = kind === 'memory' ? new MemoryService(openDb(P.DB), cfg) : null;
  const server = svc ? memoryServer(cfg, svc, allow) : kevServer(cfg, allow);
  const got = await listen(server, port, bind);
  console.log(`bosun serve ${kind} on http://${bind}:${got}  (allow ${allow.join(', ')})`);
  await new Promise((res) => { process.once('SIGTERM', res); process.once('SIGINT', res); });
  server.close();
  svc?.close();
  return 0;
}
```

- [ ] **Step 6: `lib/cli.ts`**
  - `COMMANDS.serve = (argv, cfg) => serve.main(argv, cfg)`.
  - **install** options: `--serve kev,llm,memory` (each must be one of those, else exit 2) and `--remote kev=URL,llm=URL,memory=URL` (keys from `{ kev: 'ROUTER_URL', llm: 'OLLAMA_URL', memory: 'MEMORY_URL' }`, URLs must match `^https?://\S+$`, else exit 2). Both together → exit 2 (`--serve and --remote exclude each other`). All option errors come before `wire.preflight()`.
  - A helper remembers what install changes in `config.env`, so uninstall can put it back:

```ts
// Set a config.env key and remember its previous value once, so uninstall restores it.
function setRemembered(cfg: Cfg, key: string, value: string): void {
  const st = state();
  st.configPrev = st.configPrev || {};
  if (!(key in st.configPrev)) st.configPrev[key] = parse(P.CFG)[key] ?? '';
  saveState(st);
  setKey(key, value);
  cfg[key] = value;
}
```

  - `--remote`: after the host checks, `setRemembered` each given key. Skip `setupOllama` + `setModel` when `llm` is remote, and `setupRouter` when `kev` is remote. Everything else (linkBin, rewire with MCP, doctor, smoke) runs as before.
  - `--serve` (server install; no host wiring):

```ts
async function installServe(cfg: Cfg, what: string[]): Promise<number> {
  const bind = serveLib.bindAddress(cfg);
  setRemembered(cfg, 'SERVE_BIND', bind);
  if (what.includes('llm')) { setRemembered(cfg, 'OLLAMA_URL', `http://${bind}:11434`); services.setupOllama(cfg); services.setModel(cfg); }
  const self = [process.execPath, path.join(P.REPO, 'bin', 'bosun')];
  if (what.includes('kev')) {
    services.setupRouter(cfg);
    services.svcWrite('kev-proxy', P.REPO, { PATH: process.env.PATH || '' }, [...self, 'serve', 'kev']);
    services.svcOn('kev-proxy');
  }
  if (what.includes('memory')) {
    services.svcWrite('memory', P.REPO, { PATH: process.env.PATH || '' }, [...self, 'serve', 'memory']);
    services.svcOn('memory');
  }
  saveState({ ...state(), serve: what });
  u.ok(`serving ${what.join(', ')} on ${bind} (allow ${serveLib.allowList(cfg, bind).join(', ')})`);
  const url = { kev: `kev=http://${bind}:${cfg.ROUTER_PORT}`, llm: `llm=http://${bind}:11434`, memory: `memory=http://${bind}:${cfg.MEMORY_PORT}` } as Record<string, string>;
  console.log(`\nOn each client: bosun install --remote ${what.map((w) => url[w]).join(',')}`);
  if (!/^100\./.test(bind)) u.warn('not a Tailscale address: this traffic is plain HTTP on your LAN');
  return 0;
}
```

  - **uninstall**: also `svcRm('memory')` and `svcRm('kev-proxy')`; restore every `state().configPrev` key with `setKey`, then drop `configPrev` and `serve` from the state.
  - **start/stop** (`all`): also `svcOn`/`svcOff` for `memory` and `kev-proxy` (both no-ops without a plist). **status** lists them.
  - **doctor**: the kev check uses `routerUrl(cfg)`; the model check reads `GET ${OLLAMA_URL}/api/tags` (via `curl -sf -m 2`) and looks for `LOCAL_MODEL` or `LOCAL_MODEL:latest` in `models[].name` (message `model ${M} missing on ${OLLAMA_URL}: bosun model ${M}`); the Ollama.app env check runs only when `OLLAMA_URL` points at this machine. The memory check becomes:

```ts
  if (cfg.MEMORY_URL) {
    const h = await new RemoteStore(cfg).health().catch(() => null);
    chk(`memory server ${cfg.MEMORY_URL} (bosun ${h?.version}, schema v${h?.schema})`, `memory server unreachable at ${cfg.MEMORY_URL}`, !!h);
    if (h && h.version !== VERSION) u.warn(`memory server runs bosun ${h.version}, this is ${VERSION}: update both`);
  } else {
    let schema = 0;
    try { const db = openDb(P.DB); schema = schemaVersion(db); db.close(); } catch { /* reported below */ }
    chk(`memory ${P.DB} (schema v${schema})`, `memory database unreadable: ${P.DB} (see ~/.bosun/bosun.log)`, schema > 0);
  }
```

  - **usage**: `  bosun install --serve kev,llm,memory | --remote kev=URL,llm=URL,memory=URL   split setup` and `  bosun serve memory|kev               serve memory or Kev to your other machines`.
  - **executors** (`exec.ts` `run`): the Ollama check says where it looked: `die(`Ollama down: unreachable at ${cfg.OLLAMA_URL} (local: bosun start ollama)`)`. The existing `/Ollama down/` assertion still holds; add `assert.match(…, /unreachable at http:\/\/127\.0\.0\.1:1/)` to the run test.

- [ ] **Step 7: run** `node --test test/serve.test.ts test/cli.test.ts`, then `npm test` and the type check → all pass.

- [ ] **Step 8: checkpoint** in the ledger.

---

### Task 8: Validation — `bosun memory bench` and `bosun memory eval`, measured

**Files:**
- Create: `lib/memory/bench.ts`
- Modify: `lib/memory/cli.ts` (`bench`, `eval` verbs)
- Test: `test/memory.test.ts` (append)

**Interfaces:**
- Consumes: `MemoryService`, `openDb`, `retrieve`, `curated`, `mute`, `quantile`, `jsonl`, `project`.
- Produces: `bench(cfg: Cfg, n: number): Promise<number>`, `evaluate(file: string, api: MemoryApi, ctx: Ctx): Promise<number>`.

- [ ] **Step 1: write the failing test**

```ts
test('memory bench and eval: measured numbers, nothing in your own stats', async () => {
  const sb = sandbox();
  try {
    const repo = gitRepo(sb, 'shop', 'git@github.com:org/shop.git');
    const r = await bosun(['memory', 'bench', '--n', '300'], { env: sb.env(), cwd: repo });
    assert.equal(r.code, 0, r.err);
    for (const k of ['store', 'search', 'context', 'hook']) assert.match(r.out, new RegExp(`${k}\\s.*p50 [\\d.]+ ms\\s+p95 [\\d.]+ ms`), k);
    assert.match(r.out, /budget\s+200\/200 within ~400 tokens/);
    assert.ok(!fs.existsSync(path.join(sb.home, '.bosun', 'metrics.jsonl')), 'bench metrics stay out of your stats');
    fresh(sb);
    const s = new MemoryService(openDb(P.DB), load());
    const ctx = makeCtx(load(), project(repo));
    const a = (await s.store({ category: 'project', title: 'Deploys', body: 'ArgoCD deploys main to production' }, ctx)).memory;
    const b = (await s.store({ category: 'project', title: 'Tests', body: 'run pnpm test before pushing' }, ctx)).memory;
    s.close();
    const q = path.join(sb.root, 'q.jsonl');
    fs.writeFileSync(q, [{ query: 'how do deploys work', relevant: [a.id] }, { query: 'pnpm test', relevant: [b.id] }, { query: 'nothing matches', relevant: [a.id] }].map((x) => JSON.stringify(x)).join('\n'));
    const e = await bosun(['memory', 'eval', q], { env: sb.env(), cwd: repo });
    assert.match(e.out, /3 queries\s+recall@5 0\.667\s+MRR 0\.667/);
  } finally { sb.cleanup(); }
});
```

- [ ] **Step 2: run** → expected: FAIL (`bench` unknown verb, exit 2).

- [ ] **Step 3: `lib/memory/bench.ts`**

```ts
// bosun memory bench / eval: measured numbers only. bench builds a synthetic corpus in a temp database; eval scores labelled queries.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { P, type Cfg } from '../config.ts';
import { curated, retrieve } from '../context.ts';
import { mute, quantile } from '../metrics.ts';
import { die, jsonl } from '../util.ts';
import { project } from './project.ts';
import { MemoryService } from './service.ts';
import { openDb } from './sqlite.ts';
import type { Ctx, MemoryApi } from './types.ts';

// mulberry32: a seeded PRNG, so every run measures the same corpus
const prng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const SYL = ['ka', 'ro', 'mi', 'te', 'su', 'na', 'lo', 'vi', 'de', 'pa', 'shi', 'gu', 'ne', 'to', 'ba', 'ri'];
const f = (xs: number[]) => `p50 ${quantile(xs, 0.5).toFixed(2)} ms  p95 ${quantile(xs, 0.95).toFixed(2)} ms`;
const QUERIES = 200;
const HOOK_RUNS = 20;

export async function bench(cfg: Cfg, n: number): Promise<number> {
  mute();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bosun-bench-'));
  const rnd = prng(42);
  const vocab = Array.from({ length: 2000 }, () => Array.from({ length: 2 + Math.floor(rnd() * 3) }, () => SYL[Math.floor(rnd() * SYL.length)]).join(''));
  const word = () => vocab[Math.floor(vocab.length * rnd() ** 2)];   // skewed: low indexes are common words
  const text = (k: number) => Array.from({ length: k }, word).join(' ');
  try {
    const file = path.join(dir, 'memory.db');
    const svc = new MemoryService(openDb(file), cfg);
    const ctx: Ctx = { projectId: project(process.cwd()).id, sessionId: null, linked: [] };
    const store: number[] = [];
    for (let i = 0; i < n; i++) {
      const t = performance.now();
      await svc.store({ category: i % 10 ? 'project' : 'personal', title: text(5), body: text(40 + Math.floor(rnd() * 80)) }, ctx);
      store.push(performance.now() - t);
    }
    const search: number[] = [];
    const context: number[] = [];
    const sizes: number[] = [];
    const prompts: string[] = [];
    for (let i = 0; i < QUERIES; i++) {
      const q = text(6);
      prompts.push(q);
      let t = performance.now();
      await svc.search({ text: q, limit: 10, touch: false }, ctx);
      search.push(performance.now() - t);
      t = performance.now();
      sizes.push((await retrieve(q, [curated(svc)], ctx, { budgetTokens: 400, minScore: 0, itemChars: 400 })).estTokens);
      context.push(performance.now() - t);
    }
    svc.close();
    const wall: number[] = [];
    const env = { ...process.env, BOSUN_HOME: dir, ROUTER_URL: 'http://127.0.0.1:1', MEMORY_URL: '', CLAUDE_PROJECT_DIR: process.cwd() };
    for (let i = 0; i <= HOOK_RUNS; i++) {   // run 0 warms the compile cache and is not counted
      const t = performance.now();
      spawnSync(process.execPath, [path.join(P.REPO, 'bin', 'bosun'), 'route', '--hook'], { env, input: JSON.stringify({ prompt: prompts[i] }) });
      if (i) wall.push(performance.now() - t);
    }
    const mem = jsonl(path.join(dir, 'metrics.jsonl')).filter((r) => r.op === 'hook').slice(1).map((r) => r.ms);
    const mb = (p: string) => (fs.existsSync(p) ? fs.statSync(p).size / 1048576 : 0);
    console.log(`bosun memory bench: ${n} memories (synthetic, seed 42), ${QUERIES} queries; node ${process.versions.node}, sqlite ${process.versions.sqlite}`);
    console.log(`  store    ${f(store)}   (one transaction per memory)`);
    console.log(`  search   ${f(search)}   (FTS5, limit 10)`);
    console.log(`  context  ${f(context)}   (curated, budget ~400 tokens)`);
    console.log(`  budget   ${sizes.filter((s) => s <= 400).length}/${sizes.length} within ~400 tokens (max ~${Math.max(0, ...sizes)}, average ~${Math.round(sizes.reduce((a, b) => a + b, 0) / Math.max(1, sizes.length))})`);
    console.log(`  hook     ${f(wall)}   (wall clock per prompt, Kev unreachable, ${wall.length} runs)`);
    console.log(`  hook mem ${f(mem)}   (the memory part inside the hook)`);
    console.log(`  db       ${(mb(file) + mb(`${file}-wal`)).toFixed(1)} MB`);
    return 0;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

export async function evaluate(file: string, api: MemoryApi, ctx: Ctx): Promise<number> {
  const qs = jsonl(file).filter((r) => typeof r.query === 'string' && Array.isArray(r.relevant) && r.relevant.length);
  if (!qs.length) return die(`no labelled queries in ${file}: one JSON object per line, {"query": "...", "relevant": ["m_…"]}`, 2);
  let recall = 0;
  let mrr = 0;
  for (const q of qs) {
    const ids = (await api.search({ text: q.query, limit: 20, includePrivate: true, touch: false }, ctx)).map((m) => m.id);
    recall += q.relevant.filter((id: string) => ids.slice(0, 5).includes(id)).length / q.relevant.length;
    const first = ids.findIndex((id) => q.relevant.includes(id));
    mrr += first < 0 ? 0 : 1 / (first + 1);
  }
  console.log(`${qs.length} queries  recall@5 ${(recall / qs.length).toFixed(3)}  MRR ${(mrr / qs.length).toFixed(3)}  (full-text search over curated memory)`);
  return 0;
}
```

- [ ] **Step 4: CLI verbs** — in `lib/memory/cli.ts`: `case 'bench': return bench(cfg, num(v.n, 'n') ?? 10000);` (before any `mem()` call, so it opens nothing of yours) and `case 'eval': return evaluate(need('queries.jsonl'), mem(), ctx);`.

- [ ] **Step 5: run** `node --test test/memory.test.ts`, then `npm test` and the type check → all pass.

- [ ] **Step 6: measure** (scratch home, nothing lands in ~/.bosun):
  - `S=$(mktemp -d); BOSUN_HOME=$S node bin/bosun memory bench` (n = 10,000) → paste the output into the ledger.
  - `time npm test` → suite duration (baseline 12.8 s).
  - CLI startup and hook with Kev down, 20 runs each, compile cache warm:
    `BOSUN_HOME=$S` loops over `node bin/bosun help` and `echo '{"prompt":"rename getCart to fetchCart in cart"}' | ROUTER_URL=http://127.0.0.1:1 node bin/bosun route --hook` (baselines 58 ms and 50 ms).
  - Target check: the hook's memory part p95 < 30 ms at 10k memories (spec §2). If it misses, record the miss and the cause; don't tune numbers to fit.

- [ ] **Step 7: checkpoint** in the ledger, with the measured numbers.

---

### Task 9: Docs and handoff

**Files:**
- Create: `ARCHITECTURE.md`
- Modify: `README.md`, `HANDOFF.md`, `docs/specs/2026-09-29-bosun-memory-design.md` (status line), `~/.claude/projects/-Users-vadymprodan-Developer-bosun/memory/bosun-project.md`

- [ ] **Step 1: README.md** — update the intro (Node ≥ 24, TypeScript, zero runtime deps), the diagram (hook → memory + Kev; MCP), and add sections:
  - **Memory**: what is stored (curated only), categories, privacy, the `bosun memory` verbs, review flow, what the hook injects (~400 tokens, estimated), the seven MCP tools, claude-mem read-only.
  - **Split setup**: server `bosun install --serve kev,llm,memory`, client `bosun install --remote …`, bind + allowlist, plain HTTP (encrypted only over Tailscale), no tokens in v1, failure behaviour.
  - **Tests**: the new count and `npm run typecheck` (after `npm install`, dev only).
  - **Files**: the new modules.
- [ ] **Step 2: ARCHITECTURE.md** — the spec's §4 diagram (validated with the Mermaid tool), the module map, the data flow of the hook, MCP and consolidation, the storage schema summary, the ranking formula, the split-setup diagram, the measured numbers from Task 8 (and only those, plus the §2 baseline), and the limitations and future work (spec §9 and the ledger).
- [ ] **Step 3: HANDOFF.md** — "Current work" becomes the final report per spec §12: existing architecture, proposed architecture, files changed, dependencies, features, test results, measurements, limitations, how to run locally, future work, and the exact install commands for the user (nothing installed).
- [ ] **Step 4: spec status** → `**Status:** approved 2026-09-29, implemented (see docs/plans/2026-09-29-bosun-memory-ledger.md)`.
- [ ] **Step 5: memory file** — update `bosun-project.md`: status, test count, not installed, where to resume.
- [ ] **Step 6: final checks** — `npm test` and the type check, one last time.

---

## Execution and review

Native execution (the user's choice): tasks 1–9 in order, each with its checkpoint in the ledger. Then one fresh reviewer on the most capable model reads the whole project against the spec and this plan. Important findings are fixed test-first, and every ruling goes into the ledger.
