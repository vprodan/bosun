# Handoff: bosun (updated 2026-10-06)

To continue in a new session: **"Read HANDOFF.md, RESUME.md, docs/research/README.md, docs/research/09-opencode-clef.md and docs/plans/2026-10-01-bosun-v1.0-roadmap.md, then follow the current request."**

## Current status and development readiness

**Foundation development started.** The owner authorized sequential sub-agent implementation on 2026-10-04. Topics 1–8 and [the integrated roadmap](docs/plans/2026-10-01-bosun-v1.0-roadmap.md) are complete, with [the OpenCode/Clef revision](docs/research/09-opencode-clef.md) incorporated. Track actual progress and checks in [the implementation ledger](docs/plans/2026-10-04-bosun-v1.0-implementation-ledger.md). Containment/typecheck launchers now exist; the other roadmap verification interfaces remain proposed until their slices implement them.

- **Release:** all selected work ships together as one v1.0; internal phases only, with no intermediate releases or pre-ship package-version bumps.
- **Commits (owner request, 2026-10-06):** completed work is split into coherent milestone commits. Commit each future verified milestone with its tests, documentation and updated portable context before starting the next. This supersedes the earlier no-commit constraint; preserve unrelated owner changes and untracked artifacts.
- **Continuous execution (owner request, 2026-10-06):** finish all remaining accepted work sequentially without pausing for another “continue” request. Milestone checkpoints must lead directly to the next task; existing restrictions and the full v1.0 ship gate still apply.
- **Hosts:** OpenCode is primary; native OpenCode, Codex and Claude Code remain first-class behind the seven shared ports. Qualify automatic handoff for bosun-managed sessions; arbitrary existing UI sessions use the manual path.
- **Router:** local Ollama Clef-Flash replaces Kev, including the training-run config, uv/Python service, readiness checks and remote naming. Summaries/extraction retain a separate generative ModelProvider.
- **Core:** evolve one package and one compiled binary, with the approved daemon, read-only hook fallback, SQLite/FTS, scoped memory and manifest-owned installation. The old no-daemon decision is superseded.
- **Implementation:** foundations through bound reader, strict owner preparation/cutover, independently bound incomplete recovery and useful bounded capacity 7b2d are verified. Public publisher/reader allow 10,000 rows, 16 MiB encoded and 64 MiB view, retaining source-plus-WAL 64 MiB and other bounds. The medium-body corpus now publishes READY with correct scoped hashes and actual useful native hook output; explicit temporary public-view bench verifies 20/20 deliveries while preserving simulated owner storage/binding. Independent WAL checks use only filesystem metadata/minimal headers. Recovery still takes fresh current-source backups and preserves old references; unreferenced ownership stays unverified with matching retention acknowledgement. **Bound READY views supply non-expiring notes; ordinary unactivated WAL stays held.** Next is 7b2c3 explicit owned restore with epoch rotation/revocation and reconciliation, then remaining memory isolation, drain/storage and full roadmap. Performance, finite-expiry handoff, daemon/native/Clef and automatic handoff remain unfinished. Version stays v0.2.0.
- **Fresh validation:** coordinator full guarded Node run passed 18/18 containment groups and 309/309 application tests (100.9 seconds); worker affected suites passed 132 distinct tests, with final overlapping benchmark 16/16. Four new test cases cover useful capacity, limits, source WAL and owner-isolated public-view bench. Strict isolated typecheck, whitespace and AST boundaries (57 production files / 204 edges / zero violations) passed. Markdown links/fences and Mermaid grammar passed without rendering. The sole worker stopped before independent coordinator checks/commit. Real-Claude remains excluded; functional capacity is qualified only for the demonstrated corpus, with no designated-Mac p95/live-host/power-loss claim.

Checkout: branch `main`, history root `8e835a5082530a132912e6dd3afca65db903aac1`. Completed research, skills and verified foundation implementation are committed in coherent milestone groups; the [ledger commit map](docs/plans/2026-10-04-bosun-v1.0-implementation-ledger.md#commit-checkpoints-2026-10-06) and `git log` identify checkpoints. Pre-existing untracked `bun.lock` and `node_modules/` remain untouched. [RESUME.md](RESUME.md) carries portable context and owner constraints.

## First development slice

1. **Complete:** HOME-first paths and a mandatory Node test launcher/preload contain writes before application imports. XDG/host roots, child propagation, symlink/SQLite guards, stub process effects and registered ephemeral mock endpoints are covered. The real-Claude fixture is excluded and no longer discovers a client at import; a qualified live-host launcher is still unavailable.
2. **Complete:** `npm test` and `npm run typecheck` use isolated launchers. Containment failures run before application tests; a fresh baseline passed. **Never run bosun tests under Bun.** The original incident/restoration is recorded in the root resume. Read README's test section for the accidental-effect guard's limits.
3. **Complete:** prompt-content route logs and private `--auto` provider leak fixed, with nested telemetry/provider-echo canary checks. Data IDs, scope/privacy behavior and selected models are preserved. Unmarked legacy input still requires explicit privacy classification; full v1.0 screening remains later work.
4. **Complete:** seven core contracts, pure policy and compatible routing caller with lazy factories and enforced import boundaries. Only Router has an implemented adapter acceptance suite; storage still writes on reads.
5. **Complete:** MCP/curated context classify before content access. Private/unclassified get/store/update/delete replies are constant opaque placeholders; search/context filter denied records and errors use finite text/codes. Owner CLI access remains compatible. Atomic private mutation authorization/races and true read-only fallback remain unfinished.
6. **Complete:** initial OpenCode native-protocol codecs/GET-only probe and Clef Router adapter with synthetic wire/privacy/bounds/failure fixtures. Mocks do not qualify live handoff, occupancy or calibration; current Kev runtime stays active. Basic auth/managed wiring, full native adapters and complete Clef lifecycle migration remain unfinished.
7. **Complete as a narrow qualified slice:** native WAL probes, rollback-only reader, zero-write WAL hold and real local hook caller. IDs/scope/privacy remain intact; expiry filters without archive/touch. Owner audit stays in the writer API. Benchmarks label held/failed/unqualified runs instead of claiming empty-path retrieval latency.
8. **Test-only qualification complete:** public rollback view with serialized publisher, persistent UDF writer floor, generation and `HOLD`/`READY` gate; retained reader leases, exact owner backup and guarded process-kill probes. Negative cases expose schema/function/inode bypass and early-close cached delivery. See [ADR 0004](docs/adr/0004-wal-read-view-protocol-qualification.md); this does not activate a production view or prove atomic cutover/power-loss durability.
9. **Complete:** actual rollback-only local reader lifetime through native stdout callback. Local acquisition follows routing; memory delivery is Node POSIX pipe/socket only, capped at 16 KiB. Pending failure/signal/250 ms event-loop timeout terminates the one-shot producer with its lease retained; native stdout close was disproven as release evidence. File/TTY/Windows/Bun sinks omit local notes; advice remains available. No total-latency or host-acknowledgement claim.
10. **Complete as an explicit primitive:** production native-backup/floor cutover under continuous admission, owner-only recovery gate/artifacts, restart without overwrite/doubleapply and registered synchronous writer wrapper. [ADR 0005](docs/adr/0005-explicit-memory-writer-floor-cutover.md) covers exact schema/identity, finite cleanup errors, same-inode leases and trusted-application limits. Initial installation now has the separate explicit strict owner command below; no default opener or hook installs it. Unknown pre-intent files remain held.
11. **Complete:** registered admission is used by real local MemoryService/owner CLI, MCP memory/docs and authoritative serve for existing explicit floors. Constructor/lazy expiry, search touch, mutations, pruning and docs writes are synchronous inside admission. Registered native handles stay private; owner domain errors survive successful rollback and MCP projections remain intact. Canonical path overrides and pending/dangling/mismatched gates fail closed before the legacy opener. Doctor memory checks do not create/migrate; WAL is held without a schema claim. Guarded real CLI/MCP/HTTP/diagnostic fixtures passed.
12. **Complete:** explicit `memory publish [--json]` for already-applied local floors, fixed-inode public schema/FTS/READY, primary writer-format fencing and synchronous registered revocation. Publication preserves owner rows/backup/IDs/scope/version and copies only validated current public records. Ordinary open never finishes a partial format upgrade or recovers pending journals; explicit publication can recover the verified owned journal. Native process crashes, actual hot spill recovery, same-inode leases, real CLI contenders, late clock/expiry and uncertain cleanup receipts are covered. [ADR 0006](docs/adr/0006-explicit-public-memory-publication.md) records exact bounds and limits.
13. **Complete for non-expiring local notes:** independently bound public reader with exact public schema/identity/READY metadata, scoped projection and retained native lease through stdout acceptance. The reader only filesystem-checks the mutable primary; it opens the rollback view through SQLite and leaves owner recovery derivatives unread. Invalid/pending/unbound views never fall back to primary rows. Both public and rollback hook paths omit finite-expiry notes before packing; real backpressure and event-loop stalls are covered. [ADR 0007](docs/adr/0007-bound-public-memory-reader.md) records query-time versus delivery eligibility and restore limits.

14. **Complete for strict prepared layouts:** `memory cutover plan/apply/reconcile` provides filesystem-only BLOCKED/unverified planning, independently saved initial source UUID, admission freshness and explicit HOLD reconciliation. `--clients-stopped` is operator attestation; clients stay stopped through separate publication/binding and reopen afterward. [ADR 0008](docs/adr/0008-strict-owner-memory-cutover.md) records the measured sidecar exception, finite errors, receipt-loss reconciliation and incomplete/multi-artifact/restore limits.
15. **Complete:** reviewed initial prepare-plan/prepare supports explicit leaf creation and descriptor-based narrowing of known legacy modes. Existing views and unknown/pending artifacts remain held; no SQLite or binding action occurs, and partial changes are preserved for fresh inspection.
16. **Complete for independently bound incomplete attempts:** explicit recover-plan/recover and retained-inventory reconciliation use bounded metadata, view-only native planning, exact epoch/phase/floor expectations before DML and fresh backups. Old references are preserved; unrelated unreferenced files require acknowledgement and remain unread/unowned. Committed floors require reconcile, and recovered storage passes publication/bound reading. General restore, unknown journals/orphans, drain and durability remain held.
17. **Complete for demonstrated bounded capacity:** shared 16 MiB encoded/64 MiB view bounds permit useful 10k medium-body publication, scoped/native delivery and retained revocation. Independent source-WAL/header/identity/size and logical/physical negative checks stay read-only. Explicit temporary public-view bench verifies 20/20 native injections and preserves simulated owner storage/binding, with existing config initialization/content-free logging caveats.
18. **Next:** 7b2c3 explicit owned restore, source epoch rotation/revocation and interrupted-operation reconciliation; then remaining memory isolation, drain/storage and full roadmap. Continue after each verified commit without another continuation request.

The capacity worker stopped after passing checks; coordinator reviewed and independently verified the full suite before committing. Continue directly to the next sequential milestone.

Local implementation is authorized, using one sub-agent at a time with coordinator verification between slices. The owner's no-install/no-personal-config constraint remains: no model pull, dependency download, authentication change or personal configuration write. Existing local tools suffice for containment and pure contracts; missing host/model/dependency setup is a later integration prerequisite.

## Remaining engineering qualification

| Item | How it is resolved | Blocks beginning development? |
|---|---|---|
| Native context telemetry, prompt admission, tool quiescence and fresh-session acknowledgement | Early OpenCode/Codex/Claude capability fixtures, then version-qualified live checks before claiming automatic support | No; this is engineering qualification and a ship gate |
| Clef wire compatibility, thresholds, latency and local residency | Decision fixtures, held-out calibration and permitted warm/cold model evaluation | No; no speed/quality claim is assumed |
| Graph/enrichment quality, privacy and latency | Compare with the stronger lexical baseline under actual packing/token budgets | No; activation remains evaluated |
| Known unresolved v0.2 issues listed in the historical report | Carry each into the migration ledger as fixed, covered by replacement behavior, or explicitly unresolved; preserve relevant regression assertions | No; they are implementation work, not forgotten future-version assignments |
| Optional Graphify/CodeGraph integrations | Owner clarified that users install these only when needed. Validate the actual tool/export or MCP contract when configured; leave absent sources disabled and never auto-install | No; optional tool presence/identity is not a development or v1.0 release prerequisite |
| New libraries and real host/model availability | Use existing tools/stubs first; preserve the owner's installation constraint and verify actual setup before live integration | No for containment/contracts; later dependency/integration prerequisite |

Use synthetic/manually redacted fixtures by default; no owner transcript/database is required to start. No owner clarification remains before foundation work. Keep scope and qualification outcomes in the implementation ledger. Failed required support gates need resolution before the single ship decision; optional third-party tool absence does not fail that gate.

## Historical v0.2 report (2026-09-29)

The remainder records the original build and measurements. Its no-daemon, Kev, dependency and installation choices have been superseded by the current plan above. Historical commands are retained as evidence, not the current development or installation sequence.

### Historical status

**Built and tested offline on the original machine. Not installed at that checkpoint.**
- `npm test`: 87/87 pass in 13.8 s.
- Strict type check: clean. It ran with the TypeScript already in `~/.npm/_npx`, so there was no `npm install`.

**Nothing has been installed:**
- no Ollama, uv, Kev or model pulls
- no `claude mcp add` or `codex mcp add`
- `~/.claude`, `~/.codex`, `~/.bosun` and `~/.claude-mem` are untouched

The memory layer (spec `docs/specs/2026-09-29-bosun-memory-design.md`, approved) was planned in `docs/plans/2026-09-29-bosun-memory.md` and run natively. It then went through one fresh Opus review of the whole project. Every ruling, fix and deferred minor is in `docs/plans/2026-09-29-bosun-memory-ledger.md`.

**Historical issue, now resolved in the design:** the hook's memory part missed the spec target. The owner subsequently approved the daemon; this is no longer a pending owner decision.
- **Target:** p95 under 30 ms.
- **Measured at 10,000 memories:** p95 36.6–40.1 ms (see "Measurements").
- **Before you store anything:** the hook costs about what it did before the memory layer.
- **Where the rest goes:** cold SQLite work in each per-prompt process.
- **Original restriction:** the then-approved no-daemon design ruled out a long-lived memory process. The current v1.0 plan supersedes that restriction and still requires measured validation of the new path.

### Historical final report (spec §12)

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

### Historical measurements

All on the original Mac (M5 Pro, 48 GB, Node 24.21.0, SQLite 3.53.4).

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

### What the original final review changed

- **Private memories were reachable** in two ways:
  - `bosun memory` was auto-allowed for the model, and the CLI prints private bodies and can purge. It now needs your approval each time.
  - MCP could flip a memory to public and get its body back in the reply. MCP can now only mark a memory private.
- **The hook injected unrelated notes** when a prompt shared a single word with them. A note now needs at least 2 distinct matching words (`CONTEXT_HOOK_MIN_TERMS`).
- **Session memories didn't expire** in a long-running `bosun serve memory`.
- **A plain re-install on a split-setup client** set up local Ollama and Kev against the remote URLs.
- **The hook created a memory database** for users with no memories.
- **Found during the fix pass:** a remote that drops packets, such as Tailscale being down, kept every bosun process alive for about 10 s after its work. That would have held the hook past Claude's 5 s timeout on every prompt. `bin/bosun` now flushes and exits.

### Historical rulings

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

### Historical checks not verified

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

### Historical unresolved v0.2 issues

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

### Archived v0.2 next steps

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

### Historical decisions

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
