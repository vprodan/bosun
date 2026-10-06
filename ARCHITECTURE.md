# bosun architecture: memory and context

This covers the memory layer added on 2026-09-29, and the TypeScript port that came with it. The design and its decisions (M1–M13) are in `docs/specs/2026-09-29-bosun-memory-design.md`; the build record, with every ruling, is in `docs/plans/2026-09-29-bosun-memory-ledger.md`. The roles, skills, executors and Orca parts are described in [README.md](README.md).

## Compatible core extraction (2026-10-04)

The first v1.0 extraction is implemented while package metadata remains 0.2.0. `src/core/` owns memory/context/task/session/route domain types, deterministic text, coded errors, inference/privacy/capability policy and seven typed ports. Only routing has a migrated use case and adapter: `lib/route.ts` calls `createRoutePrompt` through `src/app/registry.ts` and the temporary `src/adapters/routers/legacy-kev.ts`. Existing Kev endpoint/model/config/service selection and advisory risk/confidence behavior remain active. The opt-in Clef adapter and OpenCode protocol prototype below do not replace that lifecycle.

The registry contains literal lazy router factories; constructing it does no adapter import/probe/inference. New inference requests carry `public/private/unknown`; routing and its adapters require an own data-property public classification before sending text. Inherited/getter classifications fail closed. The legacy entry alone retains its documented unmarked-input compatibility. Router metadata uses a trusted configured label, never a provider response field. Managed telemetry/admission/quiescence/fresh-start/seed/readiness controls are typed contracts with fail-closed selection policy; no native host is qualified by these definitions.

`lib/memory/types.ts` forwards domain/port aliases (including the MemoryReader read subset) and MemoryError class; `lib/util.ts` forwards BosunError with its legacy constructor overload. `lib/memory/sqlite.ts` forwards pure text functions, retaining crypto/hash/open/migration/SQL work. Stored IDs/hashes and owner writer/MCP/remote scope/expiry/write semantics remain compatible. The local hook's storage branch now uses the qualified reader below. Legacy context scoring retains only its existing explicitly allowlisted source metadata and rejects mismatched hit identities. New source IDs remain open in core; adding one does not make it trusted.

The model-audience memory policy is wired into MCP memory replies/search and curated context before content access. Only a record with an own boolean `private: false` is eligible; private/missing/malformed classification fails closed, including throwing getters. Denied get/store/update/delete replies are the constant `{memory:{private:true}}`, without duplicate/status or other derivatives. Public replies project known fields into fresh objects/arrays instead of serializing adapter extras, events or `toJSON` hooks. Model-facing memory/context errors use finite text/codes, omitting unverified current-version details. Owner CLI reads and storage mutations remain compatible. Safe WAL fallback, atomic private mutation authorization/races, hook snapshot/lean closure, writer/index/expiry separation, broader error transport migration, full generation/runner screening, daemon and remaining port implementations are not finished.

`scripts/check-boundaries.mjs` checks every production `src`, existing `lib` and binary entry file using the local TypeScript 6 parser/resolver/type checker. Core imports only core; other new layers obey inward zone rules; adapters cannot import peers; source imports cannot reach tests or legacy lib. Static/type imports, reexports, import-type queries, literal dynamic imports and existing direct require calls enter the graph. Unresolved/local aliases outside the graph, computed/indirect loaders, unknown zones, source symlinks and cycles fail. Ambient core IO, Date and randomness are rejected; deterministic direct Math operations are allowed. This is a constrained source gate, not a universal purity/security verifier; isolated typechecking remains separate. TS7 needs a supported parser replacement or a retained dev-only TS6 checker.

Legacy exceptions are exact in the checker and [ADR 0001](docs/adr/0001-compatible-core-extraction.md): existing 25 lib files retain their old internal dependency zone, eight callers have recorded forwarding edges, and `bin/bosun` may import only `enableCompileCache` from `node:module`. New legacy files/edges and new-source imports of lib fail. These seams must be removed as their callers migrate before v1.0 ships. No compiled hook/bundle enforcement result is claimed.

Guarded `core`/`contracts` tests exercise routing/privacy/error identity, capability denial, lazy construction, Router acceptance and the implemented MemoryStore read subset. `boundaries` contains positive/negative AST and resolution fixtures. Full writable MemoryStore and other port acceptance suites await actual adapters. Every group goes through the mandatory Node containment launcher; Bun runs remain prohibited.

## Offline native protocol prototypes (2026-10-05)

`src/adapters/routers/ollama-clef.ts` implements the explicitly selected `ollama-clef` Router factory, independently of generative ModelProvider. It defaults its trusted model label to `clef-flash:9b` and accepts explicit model/URL/deadline settings. Private/unknown/unclassified input fails before config/payload/HTTP access. Lane/risk questions put main/high first for ties; typed answers, exact question/probability keys, finite distributions/confidence, usage and response-model equality are validated. Provider echoes are discarded. Input is rejected above 24,000 characters or a full serialized UTF-8 request of 64 KiB; response bodies are capped at 64 KiB, with bounded deadlines, cancellation, no redirects/retries/fallback/pulls and finite error messages. Probability-sum tolerance is a bosun policy for rounded values. The existing deterministic risk fence remains authoritative.

Clef qualification markers remain unverified/unsupported and are not a calibrated dispatcher gate. The adapter is reachable only through explicit factory/API selection; no legacy hook/CLI/default/model/service selection was changed. Confidence is concentration, not correctness. Live model wire/residency, held-out calibration, thresholds, latency and complete Kev lifecycle replacement remain unverified or unfinished.

`src/adapters/hosts/opencode/{protocol,probe}.ts` is a bounded native **v1.18.34 metadata prototype**, not a completed HostAdapter or eighth core port. Construction does no discovery/start/install/auth/model probe. An explicit public-session request can read only loopback health/session/messages via GET. Basic-auth support and managed wiring are absent; 401 holds with no credential discovery/retry. Codecs follow the actual pinned v1 route/schema sources, not their older generated SDK or separate v2 examples. They preserve explicit provider/model/variant choices, project no transcript/title/path/cost/session-total data, reject mismatched versions/identities, and decode one bounded global SSE message frame; no live SSE subscription is implemented.

Latest completed-message/step input plus cache counts form a diagnostic candidate only. ContextSample remains unknown with null used/window tokens; stale, pending, changed-model, reset, failed and absent observations do not become zero/full-window estimates. Pure fresh-root/noReply request recipes send no requests and successful decoding proves no seed acknowledgement, ownership, admission fence, tool quiescence or readiness. Every managed capability remains unverified, so existing capability selection rejects automatic control. Codex/Claude parity, native process/config wiring and the controller remain pending. [ADR 0002](docs/adr/0002-offline-native-protocol-prototypes.md) and [fixture provenance](test/fixtures/native-protocol-provenance.md) record the exact source/qualification boundaries.

## Qualified local read-only memory (2026-10-05)

**Ordinary default WAL installs remain held. Explicitly prepared READY views with independent owner `MEMORY_SOURCE_ID` binding now supply qualified non-expiring local notes. Strict owner plan/apply/reconcile is available; permission adaptation, verified process drain/restart, broader recovery, finite-expiry handoff and useful capacity remain same-v1.0 ship gates.** Guarded Node 24.16.0 probes show `readOnly:true` creates/leaves sidecars for closed WAL and changes existing sidecars for live WAL. Exclusive connection mode avoids those effects but safely fails WAL reads. No immutable primary, automatic conversion/checkpoint/copy or snapshot design is introduced here.

`src/adapters/memory/sqlite-readonly.ts` implements only `search/get/close` from the existing MemoryStore port. It uses explicit canonical paths, an injected clock, compatible schema-v1 checks, readonly/defensive native open and connection-only PRAGMAs before schema/content SQL. Qualified rollback-journal fixtures have unchanged bytes/mode/mtime/ctime/directory footprint before, while open and after close, with a closed or idle open writer. Reader imports exclude writer/config/log/metrics/model/services; no retained writes, migrations, expiry/events/access/mode updates, temp files or extension loading occur. Ordinary read access-time updates are outside the comparison.

SQL binds bounded terms/limits/scope/tags, applies personal/own/shared/linked visibility plus public/active/unexpired filters before projection, validates numeric/nullable metadata and preserves IDs/hashes/BM25/matched counts. Audit requests are rejected because history can derive from earlier private versions; owner writer API history stays available. Files cap at 16 MiB and limits at 50. Missing, corrupt, stale/unknown schema, pending journal, locked, oversized or exhausted-budget reads fail with finite errors. The 250 ms injected-clock check brackets synchronous work and cannot interrupt native CPU work; no strict deadline/designated-Mac latency is claimed. Exclusive rollback reads can hold writer locks until close; concurrent commit throughput is not qualified.

`lib/route.ts` lazily calls its local selector: present/pending/explicit view or source binding requires the strict public reader, while absent default view plus blank binding retains unactivated rollback reading/WAL hold. Invalid bindings never downgrade to primary rows. Both local handoff paths omit finite-expiry records in SQL before packing; ordinary read APIs retain query-time expiry. Public-view schema/identity/READY/generation metadata stays pinned under a retained native transaction through stdout acceptance. The primary is inspected only through filesystem identity/minimal WAL-header checks, never mutable-primary SQLite; backup recovery values are never selected. [ADR 0007](docs/adr/0007-bound-public-memory-reader.md) records the exact lifetime and restore limits. Remote storage and owner CLI/MCP mutation paths remain compatible. Curated packing accepts a search subset. Positive hook fixtures explicitly prepare rollback mode, while unchanged default-WAL negatives expose the hold. Legacy inference and route/context/hook metadata writes remain outside the reader: the entire hook is not zero-IO or a completed lean closure. [ADR 0003](docs/adr/0003-qualified-local-readonly-memory.md) records exact qualification, compatibility edge and remaining gates.

The explicit `sqlite-cutover` adapter holds primary admission through native backup/floor commit and binds source/view/backup identities and epochs. Actual local MemoryService/owner CLI, MCP docs and authoritative serve select registered admission for an applied floor before legacy chmod/migration; synchronous writes, expiry/touch and docs indexing use it. `memory cutover plan/apply/reconcile` now provides a strict prepared-layout owner workflow: filesystem-only unverified plans, independent planned source UUID, bounded metadata freshness and exact absent-floor/source-epoch expectations checked under admission before DML. Reconcile explicitly revokes READY to HOLD. `--clients-stopped` is operator attestation; there is no process drain/restart or permission adaptation. The default binding remains blank, and no hook/MCP/server path installs a floor. `memory publish` separately upgrades the same rollback inode with a v2 public schema/marker, commits public rows/FTS/READY and fences cached v1 writers. Mutations commit HOLD before source DML; publication is never automatic. [ADR 0005](docs/adr/0005-explicit-memory-writer-floor-cutover.md), [ADR 0006](docs/adr/0006-explicit-public-memory-publication.md) and [ADR 0008](docs/adr/0008-strict-owner-memory-cutover.md) record authority/recovery/receipt/capacity limits; broader owner recovery/restore, capacity and finite-expiry handoff remain gates.

## Overview

Everything runs in-process. There's no daemon, except `bosun serve` on a server Mac in the optional split setup.

```mermaid
flowchart TD
  HOOK["prompt hook<br/>bosun route --hook"] --> CTX
  MCP["bosun mcp<br/>stdio MCP server"] --> SVC
  MCP --> CTX
  CLI["bosun memory …"] --> SVC
  CLI --> CONS["consolidate"]
  CTX["context manager<br/>rank · dedupe · budget"] -->|"owner/MCP/remote"| SVC
  CTX -->|"local hook"| RO["qualified read-only reader<br/>bound READY view / rollback / WAL hold"]
  RO --> STORE
  SVC["memory service<br/>validate · dedupe · isolate · retain"] --> STORE[("SQLite ~/.bosun/memory.db<br/>memories + FTS5 + events")]
  CTX --> DOCS[("project docs index<br/>FTS5, by mtime")]
  CTX --> CM[("claude-mem.db<br/>read-only")]
  CONS --> CM
  CONS --> LLM["LLM router"]
  CONS --> SVC
  LLM --> OL["ollama (local)"]
  LLM --> OA["openai-compatible<br/>MLX / LM Studio (local)"]
  LLM -.->|opt-in| CC["claude-cli (remote)"]
  HOOK --> KEV["Kev router (existing)"]
```

## Modules

| Module | Does |
|---|---|
| `lib/memory/types.ts` | Memory, Category, Status, Ctx, Query, Hit, `MemoryApi`, `MemoryProvider`, `MemoryError` |
| `lib/memory/sqlite.ts` | `openDb` (0600, WAL, `busy_timeout=2000`), ordered migrations, `tx`, query terms, hashing, Jaccard |
| `lib/memory/service.ts` | `MemoryService`: validation, dedupe, an event per change, retention, isolation; `openMemory` picks local or remote |
| `src/adapters/memory/sqlite-readonly.ts` | qualified rollback `search/get/close` and local public-view selector; no writer imports/effects; ordinary WAL held |
| `src/adapters/memory/sqlite-public-readonly.ts` | independent expected epoch, exact public schema/identity/READY and scoped projection; same-inode native lease retained through delivery |
| `src/adapters/memory/sqlite-public-protocol.ts` | IO-free exact schema/column/bound literals shared by publisher and public reader |
| `src/adapters/memory/sqlite-cutover.ts` | explicit native cutover/reconciliation/publication; admitted owner expectation seam; registered v1/v2 admission/revocation |
| `src/adapters/memory/sqlite-owner.ts` | filesystem/header-only unverified plans; independently planned UUID; strict explicit owner apply/reconcile; no permission/drain/restart/restore automation |
| `lib/memory/project.ts` | project identity from the git `origin` URL (read from `.git/config`, no git spawn) |
| `lib/memory/remote.ts` | `RemoteStore`: the same `MemoryApi` over HTTP to `MEMORY_URL` |
| `lib/memory/claudemem.ts` | read-only provider over claude-mem: this repo's observations and session summaries |
| `lib/memory/docs.ts` | this repo's Markdown in FTS5, re-read only when a file's mtime changes |
| `lib/context.ts` | `retrieve()`: rank, dedupe, fit a token budget, format |
| `lib/llm.ts` | `generate()`: Ollama → OpenAI-compatible → (opt-in) `claude -p`, retries, JSON validation, usage log |
| `lib/consolidate.ts` | claude-mem summaries → proposed memories |
| `lib/mcp.ts` | `bosun mcp`: JSON-RPC 2.0 over stdio, 7 tools |
| `lib/serve.ts` | `bosun serve memory|kev`: bind, allowlist, the `/v1` API, a Kev forwarder, the `authorize()` point |
| `lib/memory/cli.ts`, `bench.ts` | the `bosun memory` verbs; bench and eval |
| `lib/log.ts`, `lib/metrics.ts` | a JSON-lines log with redaction; op timings and the stats report |

## A prompt, end to end

```mermaid
sequenceDiagram
  participant U as You
  participant H as bosun route --hook
  participant K as Kev
  participant C as context manager
  participant S as SQLite
  U->>H: prompt (hook JSON)
  par routing
    H->>K: lane + risk (1.5 s timeout)
    K-->>H: hint or nothing
  and memory
    H->>C: retrieve(prompt, 400 tok, curated)
    C->>S: FTS in scope (personal + project + shared)
    S-->>C: hits
    C-->>H: block or nothing (below threshold)
  end
  H-->>U: additionalContext = memory block + router hint
```

- The existing skip rules still apply: `/` commands, `!` shell escapes, prompts under 3 words, `#noroute`, and `BOSUN_DEPTH` inside executors.
- Any failure in the memory part leaves it out (fail open) and logs `hook.memory`. The router hint still arrives.
- `bin/bosun` has a fast path for `route --hook`: it loads only the hook's modules (6 ms of imports against 16 ms for the full CLI). Until a first memory exists, the hook opens no database and loads no memory modules.
- `bin/bosun` flushes and exits when a command is done: an aborted request to a host that drops packets would otherwise keep the process alive for ~10 s (the OS connect timeout), past Claude's 5 s hook timeout.

## Storage

`~/.bosun/memory.db`: `memories` (+ `memories_fts`, porter unicode61, external content kept in sync by triggers), `memory_events` (the audit trail), `docs` (+ `docs_fts`), and `schema_migrations`.

- **Keys and dedupe:** `id` is `m_<time base32><random hex>`. `hash` is sha256 of the normalized title and body (lowercase, collapsed whitespace). A partial unique index on `(project, category, hash)` over non-archived rows makes exact duplicates impossible; `store` returns the existing memory instead.
- **Scope:** readable means personal, this project, `shared`, or a project in `MEMORY_LINKED_PROJECTS`. Writable means personal or this project. Ids out of scope are "not found", never "forbidden".
- **Versions:** `update` needs the version you read (optimistic concurrency). A mismatch returns `conflict` with the current version.
- **Retention:** session memories expire after `MEMORY_SESSION_TTL_DAYS` (7), applied when the database opens, each with an `expire` event. `prune` purges archived memories older than `MEMORY_PURGE_AFTER_DAYS` (90). Events outlive a purge.
- **Migrations:** each one runs with its version row inside one `BEGIN IMMEDIATE`; a failure rolls back and leaves the database as it was. The version is re-read inside the transaction, so processes opening a new database at the same time migrate it once.
- **Concurrency:** WAL plus `busy_timeout=2000`. The switch to WAL retries on `SQLITE_BUSY`, because SQLite skips the busy handler for that lock upgrade (two processes creating the database at once used to fail).

## Ranking

For each source (curated, docs, claude-mem), the context manager fetches up to 20 hits and scores each one:

```
score = bm25_norm × weight + 0.3 × 2^(−age / halfLife) + 0.05 × ln(1 + access_count)
```

- **bm25_norm:** FTS5 `bm25()` divided by the best hit of that source (0–1).
- **weight:** curated 1.0, docs 0.8, claude-mem 0.6.
- **halfLife:** session memories 1 day, other curated 60, docs 90 (by file mtime), claude-mem 30.

Then:
- **Dedupe:** same hash, or a word-set Jaccard ≥ 0.8. The higher score wins.
- **Gate:** a hit must contain at least `minMatched` distinct words of the task (counted by FTS5's own `highlight()`, so stemming counts; the hook uses `CONTEXT_HOOK_MIN_TERMS`, 2). Normalizing by a source's best hit gives that hit a relevance of 1.0 however weak the match, so without this gate one shared common word ("first", "uses") would inject a note.
- **Budget:** greedy by score. Each line is at most `CONTEXT_ITEM_CHARS` (400) characters; the whole block fits `budgetTokens`, estimated as characters ÷ 4 and always shown as `~`. Nothing below `minScore` (the hook uses 0.35).
- **Query:** stop words go; identifiers are kept and split (`fetchCart` → `fetchcart fetch cart`); at most 24 terms, each quoted, OR-joined. User text never becomes FTS syntax, and a 50 KB prompt is still a small query.

**Known limit:** `minScore` still mostly prunes the tail; the word gate does the real filtering. Use `bosun memory eval` with your own labelled queries before tuning either.

## MCP

`bosun mcp` speaks newline-delimited JSON-RPC 2.0 on stdio, with protocol `2025-11-25`; it echoes `2025-06-18` and `2025-03-26` when asked for them. stdout carries protocol messages only.

| Tool | Hints | Notes |
|---|---|---|
| `memory_search` | read-only | private memories left out |
| `memory_get` | read-only | private/unclassified records return only an opaque private placeholder |
| `memory_store` | not destructive | public duplicate returned instead of a second copy; private receipt hides duplicate state |
| `memory_update` | destructive, idempotent | `expectedVersion` required; `status: active` accepts a proposal |
| `memory_delete` | destructive, idempotent | archives (soft); private receipt hides ID/status |
| `context_retrieve` | read-only | curated + docs + claude-mem, default budget ~1000 tokens |
| `project_knowledge_search` | read-only | docs + claude-mem |

- **Inputs:** every schema has `additionalProperties: false`, so a tool argument can't set the project.
- **Errors:** validation and business errors come back as `isError` results. Memory errors expose only fixed text and a closed `structuredContent.error.code`, never provider messages, private duplicate IDs or current-version details. The HTTP context endpoint applies the same finite mapping; owner memory API transport is unchanged. Output is capped at `MCP_MAX_CHARS` (20,000).
- **Protocol errors:** unknown method (including `server/discover`) → `-32601`, batch → `-32600`, parse error → `-32700`, unknown tool → `-32602`.
- **Registration:** `bosun install` registers the server with `claude mcp add --scope user`, and with `codex mcp add` in each Codex home (Orca's too). Uninstall removes them, and `bosun doctor` checks them.

## LLM router and consolidation

- **Chain:** `LLM_PROVIDERS` (default `ollama`; `openai` means an OpenAI-compatible server such as `mlx_lm.server` or LM Studio).
- **Timeouts and retries:** each attempt times out after `LLM_TIMEOUT_S` (60). Timeouts and connection errors are retried `LLM_RETRIES` (1) times, with backoff. Bad or schema-invalid JSON counts as a failure, is not retried, and moves on to the next provider.
- **Remote:** `claude -p --restricted` (haiku) is added only when `LLM_REMOTE=claude`, the caller allows remote, and the content isn't private.
- **Usage log:** each attempt writes one line to `~/.bosun/llm-usage.jsonl`, with no content.

```mermaid
flowchart LR
  A["claude-mem session_summaries<br/>(this project, since last run)"] --> B["local LLM<br/>JSON schema: candidates"]
  B --> C{"valid?"}
  C -->|no| X["report, write nothing"]
  C -->|yes| D["dedupe: hash + Jaccard<br/>vs active + proposed"]
  D --> E[("status = proposed<br/>source = consolidate:ollama/model<br/>source_ref = summary id")]
  E --> F["bosun memory review<br/>or MCP memory_update"]
  F -->|accept| G[("active")]
  F -->|reject| H[("archived")]
```

## Split setup

```mermaid
flowchart LR
  subgraph LAPTOP["laptop (client)"]
    HOST["Claude Code / Codex"] --> B["bosun hook · MCP · CLI"]
    B --> LOC[("local: claude-mem.db<br/>docs index")]
  end
  subgraph STUDIO["server Mac (bosun install --serve …)"]
    OLL["Ollama :11434<br/>bound to SERVE_BIND"]
    KF["bosun serve kev :8009<br/>allowlist → Kev on 127.0.0.1"]
    MS["bosun serve memory :8788<br/>/v1 API · allowlist"]
    MS --> DB[("memory.db")]
  end
  B -->|"OLLAMA_URL"| OLL
  B -->|"ROUTER_URL"| KF
  B -->|"MEMORY_URL"| MS
```

- **API:** `GET /v1/health`; `POST /v1/memory/{store,search,get,update,delete,accept,reject}`; `POST /v1/context/retrieve`.
- **Requests and replies:** every request carries `ctx`, and every reply is `{ ok, data | error: { code, message } }` with `not_found`, `conflict`, `invalid` or `unavailable`.
- **Limits:** JSON only, bodies ≤ 64 KB.
- **Client ranking:** the client ranks curated hits from `/v1/memory/search` together with its own local docs and claude-mem hits.
- **Safety:** the bind address (Tailscale by default, never `0.0.0.0` unless you set it) plus a source-IP allowlist. There are no tokens in v1; clients already send `MEMORY_TOKEN` as a Bearer header, and `authorize()` is where checking it goes.

## Measured numbers

All on this machine: Apple M5 Pro, 48 GB, Node 24.21.0, SQLite 3.53.4. Only these measurements, and the spec's §2 baseline, are quoted anywhere.

| What | Number | How |
|---|---|---|
| store | p50 0.15 ms, p95 0.32 ms | `bosun memory bench`, 10,000 synthetic memories (seed 42), one transaction each |
| search (FTS5, limit 10, with matched-word counts) | p50 3.83 ms, p95 5.53 ms | same, 200 queries |
| context retrieve (curated, ~400 tokens) | p50 5.11 ms, p95 7.22 ms | same |
| budget adherence | 200/200 within ~400 tokens (max ~398, average ~315) | same |
| hook, memory part | p50 30.6 ms, p95 40.1 ms | same corpus, 20 hook runs, Kev unreachable |
| hook, wall clock | p50 75 ms, p95 94 ms | same |
| hook wall clock by store | no memory yet 51 ms, 10k store 73 ms; pre-memory JS 48 ms; bare `node -e 0` 24 ms | 30 runs each, compile cache warm |
| `bosun help` | 51 ms (TS port before memory: 39 ms; JS baseline §2: 58 ms) | 20 runs |
| test suite | 87 tests, 13.8 s (baseline: 43 tests, 12.8 s) | `npm test` |
| type stripping cost | cold 67 ms vs plain JS 32 ms for ~3,000 lines; with the compile cache 33 ms | synthetic module graph |

**The spec target is missed at 10,000 memories.** The memory part of the hook was to stay under a p95 of 30 ms; it measured 36.6–40.1 ms across runs (this machine's run-to-run noise is several ms).
- **What was fixed:** project identity no longer spawns `git` (that was 17 ms), the hook no longer loads every CLI module (10 ms), and with no memories yet it costs about 3 ms over the pre-memory hook.
- **What's left:** a cold-process SQLite open, plus bm25 over the thousands of rows each synthetic query matches (the generated vocabulary has no stop words).
- **Next steps if it matters:** a long-lived memory process, or capping FTS matches.

No token savings are claimed: the stats report shows estimated tokens injected per prompt, and nothing has been measured before and after.

## Limitations and future work

- **Deferred by design (spec §9):**
  - Cognee: re-evaluate if `bosun memory eval` shows a gap on multi-hop questions.
  - Embeddings and vectors: add them only if eval shows a full-text gap.
  - Rust.
  - MCP protocol `2026-07-28`.
  - For the split setup: tokens and TLS, an offline queue and sync, multiple users, a Linux server.
- **Not verified here (needs the real install):** `claude mcp add`/`codex mcp add` argument formats on your versions; whether Codex starts MCP servers in the project directory (the project id comes from the server's cwd when `CLAUDE_PROJECT_DIR` is absent); `claude -p --output-format json` usage fields; Ollama's handling of `format` with every schema keyword we send; a real Tailscale bind.
- **Git edge cases:** project identity reads `.git` directly, so an origin set through `includeIf` or a `GIT_DIR` override falls back to a path-based id.
- **Docs index:** Markdown only, files over 256 KB are skipped, and repos without git aren't indexed.
- **Consolidation:** it skips near-duplicates rather than proposing them. The report lists each one, with the memory it resembles.
