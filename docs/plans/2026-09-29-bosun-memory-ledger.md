# SDD ledger — plan: docs/plans/2026-09-29-bosun-memory.md
Spec: docs/specs/2026-09-29-bosun-memory-design.md (approved by the user, 2026-09-29)
Setup: Ruling: no git repo (the user did not ask for git init) — no worktree, no commits, no sdd-workspace scripts; each task closes with `npm test` + the type check recorded here — cost if wrong: no per-task diff history (the user can git init later)
Setup: executor = native (executing-plans), chosen by the user ("run it natively")

Pre-flight (shared interfaces):
- T1 config (P getters, Cfg, VERSION, load/parse/setKey/state) -> every later task — consistent
- T1 helpers (fresh(sb, env), sandbox, bosun, BIN, REPO) -> T2–T8 tests — consistent
- T1 exec.ts exports -> T5 llm (SUBSCRIPTION_ONLY) — CONFLICT: exec.js does not export SUBSCRIPTION_ONLY. Ruling: the port exports every top-level const of exec.ts, SUBSCRIPTION_ONLY included — cost if wrong: none
- T2 MemoryApi/openMemory/MemoryService -> T3 cli, T4 hook+context, T5 consolidate, T6 mcp, T7 remote+serve, T8 bench — consistent (T7 adds the MEMORY_URL branch to openMemory)
- T2 FIELDS/PATCH -> T6 MCP input schemas — consistent
- T2 cleanTags -> T5 consolidate + add --auto — consistent
- T2 terms/ftsQuery/contentHash/words/jaccard -> T4 context/providers, T5 consolidate dedupe — consistent
- T4 ClaudeMem(cfg, projects) + summaries() -> T5 consolidate (reads cm.projects, a JSON string) — consistent
- T4 retrieve/curated -> T6 MCP, T7 serve /v1/context/retrieve, T8 bench — consistent
- T4 routerUrl -> T7 doctor — consistent
- T6 mcpSession (helpers) -> T7 serve tests — consistent
- T6 async doctor -> T7 doctor remote checks — consistent
- T3 memory cli main -> T5 (consolidate, add --auto), T8 (bench, eval) — consistent
Task 1: RED seen — new config test against the CommonJS code: P.CFG stayed on the first sandbox's HOME (expected /…kOlZ44/…, got /…Jtxeun/…)
Task 1: Ruling: `die` is a function declaration, not an arrow const — TypeScript only narrows on never-returning calls through declared functions — cost if wrong: none
Task 1: Ruling: the old JS tree was kept as a scratch backup (session scratchpad/js-backup), not in the repo — no git to recover from — cost if wrong: none
Task 1: measured (20 runs each, compile cache warm, BOSUN_HOME=scratch): `bosun help` 39 ms avg, hook with Kev down 48 ms avg, bare `node -e 0` 26 ms (spec §2 baseline: 58 ms / 50 ms, JS)
Task 1: complete (tests: npm test → 44/44 pass, 13.1 s; tsc -p . (cached TS 6.0.3) → 0 errors; no .js left in lib/ or test/)
Task 2: RED seen — test/memory.test.ts: ERR_MODULE_NOT_FOUND lib/log.ts (modules missing)
Task 2: complete (tests: node --test test/memory.test.ts → 11/11; npm test → 55/55; tsc → 0 errors)
Task 3: RED seen — memory cli test: `bosun memory add` exit 2 (unknown command)
Task 3: Ruling: found under full-suite load — two processes creating memory.db at once: `PRAGMA journal_mode = WAL` got SQLITE_BUSY at once (SQLite skips the busy handler for that lock upgrade), so a first-ever hook + MCP open could fail. Fixed in sqlite.ts wal(): retry up to 40 × 50 ms (= busy_timeout), only errcode 5. Evidence: repro loop 1 error / 45 opens before, 0 / 160 (4 concurrent) after; the Task 2 test "concurrent writers… migrates once" was the one that caught it — cost if wrong: a 2 s worst-case stall on a first open under contention
Task 3: complete (tests: npm test → 56/56, twice; tsc → 0 errors)
Task 4: RED seen — test/context.test.ts: ERR_MODULE_NOT_FOUND lib/context.ts
Task 4: Ruling: dropped the plan's `log('info', 'context.full', …)` line in retrieve() — it would log on every retrieval whose source returned 20 hits (noise, no test, no spec requirement) — cost if wrong: none
Task 4: Ruling: plan test defect — `retrieve('q x', …)` used 1-letter words that the term filter (correctly) drops; the test uses 'alpha beta' — cost if wrong: none
Task 4: Ruling: plan test defect — the seeded "Long note" matched only `fetchCart`, a term in every memory, so bm25 IDF clamps to ~0 and its score is recency alone (0.30 < 0.35 min): correctly not injected. The fixture became a genuinely relevant multi-line "Rename checklist", keeping the test's intent (a multi-line note is injected as one capped line) — cost if wrong: none
Task 4: Ruling: Review Focus #5 caught a real bug — a 50 KB prompt exceeded search's 20,000-char text limit, so the hook failed open with no memory. Fixed at the source: retrieve() hands providers the capped term list (≤ 24 terms), not the raw prompt; also keeps remote requests small — test "hook: one valid line … 50 KB prompt" RED→GREEN — cost if wrong: none (terms() already read only the first 20,000 chars)
Task 4: complete (tests: node --test test/context.test.ts test/route.test.ts → 11/11; npm test → 64/64; tsc → 0 errors)
Task 5: RED seen — test/llm.test.ts: ERR_MODULE_NOT_FOUND lib/llm.ts
Task 5: Ruling: plan test typo — the usage-log key list expected 'ms' before 'model'; sorted order is 'model', 'ms' — cost if wrong: none
Task 5: complete (tests: node --test test/llm.test.ts → 5/5; npm test → 69/69; tsc → 0 errors)
Task 6: RED seen — test/mcp.test.ts: 3/3 fail (`bosun mcp` unknown; no MCP registration calls)
Task 6: complete (tests: node --test test/mcp.test.ts test/wire.test.ts test/cli.test.ts test/lint.test.ts → 22/22; npm test → 72/72; tsc → 0 errors)
Task 7: RED seen — test/serve.test.ts: ERR_MODULE_NOT_FOUND lib/memory/remote.ts; exec run test: no "unreachable at" in the Ollama-down message
Task 7: Ruling: real bug caught by the parity test — the memory server's ctx schema rejected `sessionId: null` (the validator has no null type), so a client without a session got `invalid` where the local store says `not_found`. Fixed in serve.ts: null ctx fields count as absent before validation — cost if wrong: none
Task 7: Ruling: plan test typo — doctor's model message is `model <M> missing on <url>` (as the plan's own Step 6 specifies); the test regex now matches `model \S+ missing on` — cost if wrong: none
Task 7: Ruling: test hygiene — a failing serve test left its http server open and the run hung for minutes; servers now close in finally (cleanups list) — cost if wrong: none
Task 7: complete (tests: node --test test/serve.test.ts → 7/7 (4.6 s); npm test → 79/79 (13.6 s); tsc → 0 errors)
Task 8: RED seen — bench/eval test: `bosun memory bench` exit 2 (unknown verb)
Task 8: first bench (10k): hook memory part p50 31.7 / p95 35.7 ms — misses the spec §2 target (p95 < 30 ms). Profiled in a cold process: project() = 17–18 ms (two `git` spawns), retrieve 8–16 ms, openDb 1.5–8 ms
Task 8: Ruling: project() reads .git / commondir / config directly instead of spawning git (0.3–0.4 ms); behaviour pinned by the existing project test (ssh/https spellings, subdir, worktree without remote, not a repo) — git's discovery rules minus GIT_DIR / GIT_CEILING_DIRECTORIES / includeIf — cost if wrong: an unusual git layout (includeIf-set origin, GIT_DIR) gets a path-based id instead of the origin id
Task 8: Ruling: bin/bosun fast path for `route --hook` — imports route.ts + config.ts only (cli.ts pulls every command: 16.2 ms vs 6.2 ms import) — every hook test runs through bin/bosun — cost if wrong: none
Task 8: measured, hook wall clock (30 runs, Kev unreachable, compile cache warm): pre-memory JS-port 48 ms; now 66–68 ms with an empty store, 70–73 ms with a 10k store, 57–59 ms with memory unreachable; bare `node -e 0` 24 ms. Memory work inside a real hook (trace, 10k store, common-word corpus): open 1.6–6.3 ms + retrieve 10–16 ms
Task 8: bosun memory bench (10000 synthetic memories, seed 42, 200 queries; node 24.21.0, sqlite 3.53.4), final run:
  store    p50 0.15 ms  p95 0.32 ms   (one transaction per memory)
  search   p50 3.20 ms  p95 4.81 ms   (FTS5, limit 10)
  context  p50 3.92 ms  p95 5.71 ms   (curated, budget ~400 tokens)
  budget   200/200 within ~400 tokens (max ~398, average ~315)
  hook     p50 71.09 ms  p95 81.84 ms   (wall clock per prompt, Kev unreachable, 20 runs)
  hook mem p50 30.15 ms  p95 36.64 ms   (the memory part inside the hook)
  db       14.3 MB
Task 8: Ruling: the spec §2 target (memory part p95 < 30 ms) is missed at 10k synthetic memories (p95 36.6 ms); the remaining cost is cold-process SQLite open + bm25 over thousands of matching rows (the synthetic vocabulary has no stop words, so every query matches widely). Not tuned further: the approved design has no daemon — cost if wrong: ~20–25 ms added per prompt vs the pre-memory hook; upgrade path: a long-lived memory process, or capping FTS matches
Task 8: other measurements: `bosun help` 51 ms avg (Task 1: 39 ms; cli.ts now imports memory/MCP/serve modules); `npm test` 80 tests 14.1 s (spec §2 baseline: 43 tests 12.8 s)
Task 8: complete (tests: npm test → 80/80; tsc → 0 errors)
Task 9: Ruling: HANDOFF.md (the final report) is written after the final review, not before, so it reflects the fix pass — cost if wrong: none
Task 9: README (intro, diagram, Memory, Split setup, install, daily use, safety, tests, files) and ARCHITECTURE.md written; 6 new or changed Mermaid diagrams validated with the Mermaid Chart tool (all valid); spec status → approved + implemented
Final review: fresh reviewer (opus; first dispatch cut off by a usage limit and resumed), verdict "With fixes": 1 Critical, 5 Important, 13 Minor, 13 declined. npm test 80/80 and tsc clean confirmed by the reviewer.
Final: re-grade — kept: Critical #1 (bosun memory auto-allowed → private bodies + purge without asking); Important #2 (MCP private→public flip returns the body), #3 (hook injects on one shared common word), #4 (session TTL never applies in a long-running server), #5 (plain re-install on a split client sets up local Ollama/Kev against remote URLs), #6 (hook creates/opens memory.db for users with no memories — cheap part of the missed target). No minor re-graded upward.
Final: fixed Critical #1 `Bash(bosun memory *)` auto-allowed (private bodies + purge without asking) — dropped from PERMS — "wire: bosun memory is never auto-allowed…" RED→GREEN, suite 86/86
Final: fixed #2 MCP private→public flip returned the body — memory_update's `private` accepts only true (unmarking is CLI-only) — "mcp: memory_update cannot make a private memory public…" RED→GREEN, suite 86/86
Final: fixed #3 one shared common word injected unrelated notes — search reports distinct matched words (FTS5 highlight(), second query over ≤ limit rows); retrieve takes minMatched (capped at the task's term count); the hook uses CONTEXT_HOOK_MIN_TERMS=2 (new key) — "hook: a prompt that shares just one common word… stays silent; a relevant one still gets its note" RED→GREEN, suite 86/86
Final: fixed #4 session TTL never applied in a long-running server — search and get run the (indexed, cheap) expiry check first — "memory: an expired session memory leaves search in a long-running process…" RED→GREEN, suite 86/86
Final: fixed #5 plain re-install on a split client set up local Ollama/Kev against remote URLs — a URL already pointing at another machine stays remote; an explicit --remote still wins (a tunnel on 127.0.0.1 is remote) — "install: re-running a plain install on a split-setup client…" RED→GREEN, suite 86/86 (the first version broke the --remote-on-127.0.0.1 test; fixed in the same pass)
Final: fixed #6 (cheap part) hook created/opened memory.db with no memories — skips memory (and loads no memory modules) until the database exists — "hook: without a memory database it creates none" RED→GREEN, suite 86/86
Final: fixed (found during the fix pass) an aborted fetch to a host that drops packets kept the process alive ~10 s after its work (TCP connect pending), so a hook with Tailscale down would hit Claude's 5 s hook timeout on every prompt, and doctor took 10 s — bin/bosun flushes stdout/stderr and exits when main() returns — "split: a memory or Kev host that drops packets… exits within its budget" RED (10.9 s) →GREEN (0.66 s), suite 87/87 (13.8 s)
Final: measured after fixes: hook with no memory db 51 ms avg (pre-memory 48 ms), 10k store 73 ms avg; bench search p50 3.83 / p95 5.53 ms (was 3.20 / 4.81: the matched-words query), context p50 5.11 / p95 7.22 ms, hook memory part p50 30.6 / p95 40.1 ms (target p95 < 30 ms still missed at 10k synthetic memories — ruling in Task 8 stands, needs the user's sign-off)
Final: Ruling: declined "server trusts client ctx", "100.64/10 admits every tailnet peer", "remote OLLAMA_URL gets private --auto text", "memory_get returns a private title", "session memories readable across sessions", "Kev's own bind address", "claude-mem merged_into_project", "insteadOf/includeIf/GIT_DIR", "Orca rewriting config.toml", "setKey `$&`", "JSON-RPC id:null / tools/call as notification", "claude -p --restricted flag" — each is spec-accepted (M12, §5 metadata rule, project scope), pre-existing code, or unverifiable offline, as the reviewer said; they stand — cost if wrong: the listed behaviour, as described in the review
Final: Ruling: the missed hook target (Important #6 beyond the cheap part) is not tuned further — needs the user's sign-off (HANDOFF) — cost if wrong: ~20–25 ms per prompt once memories exist
Final: minor (deferred): remote.ts accepts {ok:true} without data (CLI then stack-traces)
Final: minor (deferred): docs.ts index() can throw (file gone between stat and read, busy db) and fail all of context_retrieve
Final: minor (deferred): docs path-prefix scope matches nested repos (outer/inner re-index each other)
Final: minor (deferred): the hook touches access counts of all 20 fetched hits, not only the injected ones
Final: minor (deferred): "details in ~/.bosun/bosun.log" but the log keeps only {name, code}
Final: minor (deferred): purge/prune refuse with MEMORY_URL set and /v1 has no purge/prune route
Final: minor (deferred): MCP registration and plists bake in process.execPath (a Volta/Node cleanup breaks them)
Final: minor (deferred): consolidation reads newest-first LIMIT 20 then stamps now: older summaries beyond 20 are skipped
Final: minor (deferred): cli.ts loads memory/MCP/serve modules eagerly (`bosun help` 39 → 51 ms)
Final: minor (deferred): no way to unset --shared from the CLI; restoring an expired session memory gets re-archived
Final: minor (deferred): CIDR entries not validated (`x/-1` matches all); a null JSON body gives 500, not 400
Final: minor (deferred): opt-in `claude -p` runs with default tools on untrusted summary text (consider --tools "" / --max-turns 1)
Final: minor (deferred): orca.ts tee() has two identical branches
Final: complete — npm test 87/87 (13.8 s), tsc 0 errors; HANDOFF.md written with the final report; no git, so finishing-a-development-branch does not apply (nothing to merge) and there is no sdd workspace to delete
Final: fixed (found in the last check) the pure retrieve() tests in test/context.test.ts ran without a sandbox and appended timing metrics (numbers only) to the real ~/.bosun/metrics.jsonl — they now run in a sandbox; the stray file (237 lines, all from this session's test runs) was removed; a full npm test run afterwards leaves ~/.bosun as it was (config.env from 01:04, not written by this session) — suite 87/87
