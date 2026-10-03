# Handoff: bosun (2026-09-29)

To continue in a new session: **"Read HANDOFF.md, README.md and ARCHITECTURE.md in ~/Developer/bosun and continue."**

> **2026-10-01: v2 research in progress.** Topics 1–5 are done; resume from [RESUME.md](RESUME.md). **Never run the tests under Bun:** a homedir bug once installed bosun into the real `~/.claude` and `~/.codex`. That's been restored, and the removed files are in `~/bosun-quarantine-20261001/` on the original Mac.

## Status

**Built and tested offline. Not installed.**
- `npm test`: 87/87 pass in 13.8 s.
- Strict type check: clean. It ran with the TypeScript already in `~/.npm/_npx`, so there was no `npm install`.

**Nothing has been installed:**
- no Ollama, uv, Kev or model pulls
- no `claude mcp add` or `codex mcp add`
- `~/.claude`, `~/.codex`, `~/.bosun` and `~/.claude-mem` are untouched

The memory layer (spec `docs/specs/2026-09-29-bosun-memory-design.md`, approved) was planned in `docs/plans/2026-09-29-bosun-memory.md` and run natively. It then went through one fresh Opus review of the whole project. Every ruling, fix and deferred minor is in `docs/plans/2026-09-29-bosun-memory-ledger.md`.

**Needs your decision:** the hook's memory part misses the spec target.
- **Target:** p95 under 30 ms.
- **Measured at 10,000 memories:** p95 36.6–40.1 ms (see "Measurements").
- **Before you store anything:** the hook costs about what it did before the memory layer.
- **Where the rest goes:** cold SQLite work in each per-prompt process.
- **If you want the target met:** that needs a long-lived memory process, which the approved design (no daemon) rules out.

## Final report (spec §12)

**1. Existing architecture:** spec §2. A CommonJS Node CLI of 10 modules and 43 tests, with no memory and no MCP.

**2. New architecture:** [ARCHITECTURE.md](ARCHITECTURE.md), and spec §4–§8.
- **Port:** everything is now TypeScript ESM, which Node ≥ 24 runs directly.
- **Memory store:** curated SQLite + FTS5 in `~/.bosun/memory.db`.
- **claude-mem:** read-only.
- **Context manager:** ranks, dedupes and budgets context for the prompt hook (~400 tokens).
- **MCP server:** `bosun mcp`, with 7 tools.
- **LLM router:** feeds reviewed consolidation proposals.
- **Split setup:** `bosun serve`, `bosun install --serve` and `--remote`.

**3. Files changed:**
- **Ported:** all of `lib/*.js` became `lib/*.ts`, plus `test/*.ts` and `bin/bosun`.
- **New:** `lib/{log,metrics,context,llm,consolidate,mcp,serve}.ts` and `lib/memory/{types,sqlite,project,service,remote,claudemem,docs,cli,bench}.ts`.
- **New tests:** `test/{memory,context,llm,mcp,serve}.test.ts`.
- **Changed:** `package.json`, `tsconfig.json`, `config.default.env` (new keys only), `policy.md` (one memory rule), `README.md`, `ARCHITECTURE.md`.
- **Size:** about 3,000 lines of `lib` and 2,200 of tests.

**4. Dependencies:** none at runtime. `typescript` and `@types/node` were added as devDependencies, for `npm run typecheck` only.

**5. Features:**
- **Store and manage:** store, search, get, update (version-checked), archive, purge, review, accept, reject and prune, with an audit event for every change.
- **Scope:** personal, project and session categories; project isolation by git origin; `shared` memories and linked projects.
- **Retention and privacy:** a session TTL, and private memories.
- **Context:** injected by the hook, and available on demand over MCP.
- **Sources:** the repo's docs index, and claude-mem read-only.
- **LLM router:** falls back through providers, validates JSON, and keeps a usage log.
- **Consolidation:** proposals with provenance, which wait for your review.
- **Split setup:** a bind address, an allowlist, and a `/v1` API.
- **Numbers:** stats, bench and eval.

**6. Test results:**
- 87/87 pass offline.
- **Coverage:** the 43 original checks ported, plus storage, conflicts, duplicates, isolation, retention, privacy, migrations, concurrent writers, FTS-safe queries, context, the hook, providers, the LLM router, consolidation, a real MCP stdio session, MCP registration and the split setup.
- **Type check:** strict, clean.

**7. Measurements:** see below; these are the only numbers quoted anywhere.

**8. Limitations:** the "Not verified" and "Deferred minors" sections below, and ARCHITECTURE.md's "Limitations and future work".

**9. Running locally:** "Next steps" below, and README.

**10. Future work (spec §9):**
- Cognee and embeddings, but only if `bosun memory eval` shows a gap.
- MCP protocol `2026-07-28`.
- For the split setup: tokens and TLS, an offline queue and sync, multiple users, a Linux server.

## Measurements

All on this Mac (M5 Pro, 48 GB, Node 24.21.0, SQLite 3.53.4).

**`bosun memory bench`:** 10,000 synthetic memories (seed 42), 200 queries.

| What | Result |
|---|---|
| store | p50 0.15 ms · p95 0.32 ms |
| search | p50 3.83 · p95 5.53 ms |
| context (~400 tokens) | p50 5.11 · p95 7.22 ms |
| budget | 200/200 within ~400 tokens (max ~398, average ~315) |
| hook memory part | p50 30.6 · p95 40.1 ms (an earlier run: 36.6) |
| hook wall clock | p50 75 · p95 94 ms |
| database | 14.3 MB |

**Hook wall clock by store** (30 runs, Kev unreachable):

| Store | Time |
|---|---|
| no memory yet | 51 ms |
| 10,000 memories | 73 ms |
| before the memory layer | 48 ms |
| bare `node -e 0` | 24 ms |

**CLI and tests:**
- `bosun help`: 51 ms (§2 baseline 58 ms).
- `npm test`: 87 tests in 13.8 s (§2 baseline: 43 tests in 12.8 s).
- **Token numbers:** only estimates of what was injected (characters ÷ 4). No savings are claimed, because nothing was measured before and after.

## What the final review changed

- **Private memories were reachable** in two ways:
  - `bosun memory` was auto-allowed for the model, and the CLI prints private bodies and can purge. It now needs your approval each time.
  - MCP could flip a memory to public and get its body back in the reply. MCP can now only mark a memory private.
- **The hook injected unrelated notes** when a prompt shared a single word with them. A note now needs at least 2 distinct matching words (`CONTEXT_HOOK_MIN_TERMS`).
- **Session memories didn't expire** in a long-running `bosun serve memory`.
- **A plain re-install on a split-setup client** set up local Ollama and Kev against the remote URLs.
- **The hook created a memory database** for users with no memories.
- **Found during the fix pass:** a remote that drops packets, such as Tailscale being down, kept every bosun process alive for about 10 s after its work. That would have held the hook past Claude's 5 s timeout on every prompt. `bin/bosun` now flushes and exits.

## Rulings to look at

The full list is in the ledger. The ones that change behaviour you might notice:
- **Project identity** reads `.git` directly instead of spawning git, which saved 17 ms per prompt. An origin set through `includeIf` or `GIT_DIR` gets a path-based id instead.
- **`bin/bosun` has a hook fast path** that loads only the hook's modules.
- **MCP can't make a private memory public again.** Use `bosun memory update <id> --public`.
- **Consolidation skips near-duplicates** instead of proposing them, and lists each one it skipped.
- **Deviations from the spec are small** and are listed in the plan's "Deviations" section:
  - `docs` has its own rowid.
  - The memory CLI lives in `lib/memory/cli.ts`.
  - The docs index is keyed by repo path.
  - Clients rank remote hits locally.
  - Tag filters are any-of.

## Not verified (needs the install or the real services)

**Memory layer:**
- The `claude mcp add --scope user bosun -- …` and `codex mcp add bosun -- …` formats on your versions, and whether the hosts start the server correctly.
- Whether Codex starts MCP servers in the project directory. Without `CLAUDE_PROJECT_DIR`, the project id comes from the server's cwd.
- The `usage` fields in `claude -p --output-format json`, used by the opt-in remote LLM.
- Ollama's handling of JSON-schema `format` for the consolidation schema.
- A real Tailscale bind for `bosun serve`.
- Kev's own bind address next to the kev proxy on the same port.

**From before:**
- Orca's real JSON handle fields.
- Orca split lifetime.
- Codex `sandbox_mode` in agent TOML.
- `/hooks` trust persisting.
- The GPT-6 model names on your plan.
- `--restricted` with the subscription login.
- Orca leaving `AGENTS.md` and `agents/` alone.
- `CLAUDE_CODE_AUTO_COMPACT_WINDOW=65536` below the documented 100k minimum.
- Real qwen3.6 tool calling, speed and memory at 64K.
- `kev-0.8b` accuracy.

## Deferred minors

**From this build** (details in the ledger):
- **Remote client:** a server reply `{ok:true}` without data is accepted, so the CLI shows a stack trace.
- **Docs index:**
  - It can throw on a file deleted mid-scan, and that fails all of `context_retrieve`.
  - Nested repos re-index each other.
- **Hook:** it counts access for all 20 fetched hits, not only the injected ones.
- **Error message:** "details in bosun.log", but the log keeps only the error name and code.
- **Server-side housekeeping:** there's no remote purge or prune route; run them on the server.
- **Node path:** MCP registration and the launchd plists bake in the current Node path, so a Volta cleanup breaks them.
- **Consolidation:** it considers only the newest 20 summaries since the last run.
- **CLI:**
  - `bosun help` got slower (39 → 51 ms) because of eager imports.
  - There's no way to unset `--shared`.
  - An expired session memory you restore gets re-archived.
- **Server input:** CIDR entries aren't validated, and a `null` JSON body gives 500 instead of 400.
- **Opt-in remote LLM:** `claude -p` runs with its default tools on summary text.
- **Nit:** `tee()` has two identical branches.

**From the first build, still standing:**
- `-e claude` keeps `CLAUDE_CODE_OAUTH_TOKEN` and `CLAUDE_CODE_USE_FOUNDRY`.
- Kev's bind relies on the `kev.serve` default.
- Whitespace and CRLF get normalized on restore.
- A second `.bak-bosun` overwrites the first.

## Next steps

1. **Decide on the missed hook target** (see Status). Keep the in-process design, or plan a long-lived memory process.
2. **Install:** `npm test`, then `./install.sh --host both`.
   - Add `--replace-plugins` once you're ready to retire superpowers, mattpocock-skills and code-review.
   - Optional, dev only: `npm install && npm run typecheck`.
3. **Read `bosun doctor`.** It now checks the memory database and the MCP registration in each host as well.
4. **Restart the hosts:**
   - **Claude:** `/mcp` should list `bosun`, and `/agents` the 6 `bosun-*` agents.
   - **Codex:** trust the hook with `/hooks`.
5. **Try memory:**
   - `bosun memory add -t "Use pnpm" "Always pnpm install; npm breaks the lockfile"` in a repo.
   - A prompt about installing dependencies should show a `[bosun memory: …]` block.
   - `bosun memory consolidate` then `bosun memory review` turns your claude-mem history into proposals.
6. **Split setup, if you want it:** `bosun install --serve kev,llm,memory` on the server Mac, then the `bosun install --remote …` line it prints, on the laptop.
7. **After about a week:**
   - `bosun label` and `bosun eval` for the router.
   - `bosun memory stats`.
   - `bosun memory eval <queries.jsonl>` before you tune `CONTEXT_HOOK_MIN_TERMS` or `CONTEXT_HOOK_MIN_SCORE`.

## Decisions

| # | Decision | Why |
|---|---|---|
| D1–D10 | bosun's name, roles, skills, Kev, Orca and wiring | `docs/specs/2026-09-28-bosun-design.md` |
| M1 | TypeScript ESM, Node ≥ 24, native type stripping | you chose a full port; no build step |
| M2 | zero runtime deps; `typescript` and `@types/node` as devDependencies | type checking only |
| M3 | in-process, no daemon; `bosun serve` only for the split setup | measured database costs are milliseconds |
| M4 | `node:sqlite` + FTS5, WAL, migrations | built in and fast enough |
| M5 | curated store plus claude-mem read-only | no duplication |
| M6 | hand-rolled stdio MCP, protocol `2025-11-25` | the SDK would add 94 packages |
| M7 | project = hash of the normalized git origin | clones, worktrees and machines share one project |
| M8–M10 | Cognee, embeddings and Rust deferred; an LLM only where needed | measure first |
| M11–M13 | per-service URLs; no tokens in v1 (bind + allowlist); local or remote store behind one interface | your call; auth comes later |
