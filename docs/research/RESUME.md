# Resume: bosun v1.0 research (saved 2026-10-01; completed 2026-10-04)

All eight topics and the roadmap (`../plans/2026-10-01-bosun-v1.0-roadmap.md`; historical citation, recover via `21d5dc6:PATH`) are complete. On a new machine, read this file, the root resume (`../../RESUME.md`; historical citation, recover via `21d5dc6:PATH`), [the decision register](README.md) and the roadmap, then follow the current user request. The prompts below are archived research inputs; do not restart completed topics.

**Current owner release policy (2026-10-04):** everything selected ships together as one v1.0. Use internal implementation phases and one full-scope ship gate; no feature assignments to later versions or pre-ship package-version bumps. Graph enrichment, dashboard and remote support are included. This policy supersedes the earlier staging in the archived inputs below.

**Latest host/router steering (2026-10-04):** [09-opencode-clef.md](09-opencode-clef.md) updates the plan to OpenCode primary, native OpenCode/Codex/Claude Code first-class, and local Clef-Flash decision routing replacing Kev's model/service lifecycle. It supplements the original eight topics; preserve their historical measurements. The roadmap and root resume carry these current decisions.

**Readiness clarification (2026-10-04):** Graphify/CodeGraph are optional user-installed sources. Validate them only when configured; their absence/identity is not a prerequisite for development or shipping. No owner clarification remains before foundation work.

## Status

| # | Topic | State |
|---|---|---|
| 1 | Runtime | ✅ [01-runtime.md](01-runtime.md) |
| 2 | Protocol | ✅ [02-protocol.md](02-protocol.md) |
| 3 | Libraries | ✅ [03-libraries.md](03-libraries.md) |
| 4 | Abstractions | ✅ [04-abstractions.md](04-abstractions.md) |
| 5 | CLI and topology | ✅ [05-cli-topology.md](05-cli-topology.md) |
| 6 | Architecture | ✅ [06-architecture.md](06-architecture.md), completed 2026-10-04 |
| 7 | Graph memory | ✅ [07-graph-memory.md](07-graph-memory.md), completed 2026-10-04 |
| 8 | Features | ✅ [08-features.md](08-features.md), completed 2026-10-04 |
| 9 | Host/router design revision | ✅ [09-opencode-clef.md](09-opencode-clef.md), checked 2026-10-04; current OpenCode/Clef steering |
| — | Roadmap | ✅ 2026-10-01-bosun-v1.0-roadmap.md (`../plans/2026-10-01-bosun-v1.0-roadmap.md`; historical citation, recover via `21d5dc6:PATH`), completed 2026-10-04 |

All decisions and the result of each topic are in [README.md](README.md) under "Owner answers". That section is the source of truth, and every agent reads it.

**Preparation checked 2026-10-03:** auto-handoff is still a required design, with no v0.2 implementation. Repository skills for OpenAI models, Codex, ChatGPT, and manual handoff are listed in the root resume (`../../RESUME.md`; historical citation, recover via `21d5dc6:PATH`). For topic 8, the current [Codex app-server docs](https://learn.chatgpt.com/docs/app-server) document `thread/tokenUsage/updated` and `thread/compact/start`; verify them against the installed client and session ownership. Native compaction does not by itself provide the external-model summary and fresh-session handoff requested here. That preparation did not start topics 6–8; the status table tracks the subsequent continuation.

Validation of notes 6–8/roadmap: Mermaid syntax (existing 11.17.2 parser), required sections, fences, relative links and whitespace passed. Topic 8's 29 unique external URLs returned HTTP 200. No implementation, tests, models or installs were run for these notes. Automatic handoff remains unimplemented; live Claude/Codex/session ownership, tool isolation and summary/recovery qualification are implementation gates. Next planning starts with enforced test homes and capability probes, without host installation.

## How the research ran (historical)

The owner asked for this process:
- **Continuation (2026-10-04):** the owner asked to finish in Codex after Sonnet was unavailable and a usage-limit interruption. Available Codex agents completed topics 6–8 sequentially; the original Claude/Sonnet workflow below is retained as history.
- **One agent per topic, run one after another, never in parallel,** so the owner can follow along.
- **Each agent is a `general-purpose` agent with `model: "sonnet"`.** The owner decided this on 2026-10-01 to cut usage: topics 1–5 on Opus used ~27% of a day's tokens, about 200k of context per call. It reads README.md and all the earlier notes, then writes `NN-topic.md` in the note format from the README. Its reply is short: the picks, the key numbers, and open questions with defaults.
- **After each topic, the main thread:**
  1. skims the note (its sections and TL;DR)
  2. adds a result bullet to the README's "Owner answers"
  3. gives the owner a short summary
  4. asks only the questions that change the outcome (AskUserQuestion) and takes the defaults for the rest
  5. starts the next topic
- **If an agent dies on a usage limit,** resume it with SendMessage when you can, or start a new agent that reuses its scratchpad files. Check whether the note already got written first: topic 5's did.

## Safety: read before running anything

- **Never run bosun's test suite under Bun.** Bun's `os.homedir()` ignores a runtime `$HOME` change (oven-sh/bun#29244). On 2026-10-01 a Bun test run installed bosun into the real `~/.claude`, `~/.codex`, `~/.agents`, `~/.bosun` and `~/Library/LaunchAgents`. That's been restored on the original Mac, and the removed files are in `~/bosun-quarantine-20261001/` there; delete that folder once you're happy with the restore.
- **Install nothing.** That means no npm/bun/brew install, no npx/bunx of uncached packages, no `launchctl load`, and no changes to `~/.claude`, `~/.codex` or `~/.bosun`.
- **Use the session scratchpad for temp work.** The `/private/tmp/...` paths in notes 01–05 belonged to the original Mac's session and are gone. Put temp work under the new session's scratchpad, in `research-NN/`.
- **Don't redo or compare measurements.** The numbers in 01–05 were measured on an Apple M5 Pro (48 GB) with Bun 1.4.2 and Node 24.21.0. Another machine's numbers aren't comparable.

## Owner preferences (from Claude's local memory, which doesn't travel)

- **Tooling:** Node/TypeScript, not Python, and Mermaid diagrams in .md docs.
- **No installers:** never run installers or touch `~/.claude`, `~/.codex` or launchd unless asked.
- **Questions:** ask only the important ones, and take the defaults for the rest.
- **Design:** dislikes speculative abstraction and over-engineering.

## Common rules block (paste into every topic prompt)

```
## Rules (repeated from the README; they're strict)
- Primary sources only (official docs, specs, repos, papers, release notes). Cite a URL for every claim, with the date or version checked. Use WebSearch or WebFetch; if they're deferred, load them with ToolSearch. Use `gh api` for repos (read-only).
- INSTALL NOTHING, and no npx/bunx of uncached packages. Don't touch ~/.claude, ~/.codex or ~/.bosun. Don't run bosun's test suite, and NEVER under Bun: a homedir bug writes into the real HOME.
- Scratchpad: <this session's scratchpad>/research-NN/
- Don't edit any repo file except the one note you write. Use Mermaid for diagrams.
```

## Archived prompt: topic 6, architecture

> You are research agent 6 of 8 for bosun v1.0. The topics run one after another, and later agents build on your note, so be rigorous and concrete.
>
> **Read first:**
> - docs/research/README.md: the vision, ALL the owner answers and the topic 1–5 results, the rules and the note format.
> - docs/research/01–05. Build on them and don't redo them. Topic 4 defined the seven ports and topic 5 the single binary + daemon. Your job is the code structure that holds them.
> - The whole current codebase: lib/*.ts, test/*.ts, bin/bosun, package.json, tsconfig.json, ARCHITECTURE.md and HANDOFF.md. Measure it: lines per file, the import graph, cycles, and the god modules (cli.ts).
>
> **Topic: architecture and code structure.** The owner's words: "Code structure must be segregated/separated, be easy to extend. architecture and code must follow some best practice."
>
> Cover:
> 1. **The architecture style for a project this size** (~5k lines, one maintainer, growing): hexagonal / ports-and-adapters, clean architecture, vertical slices, or a modular monolith. Use primary sources: Cockburn's article, and the opencode, MCP TS SDK and Hono repos. Recommend one, and say what NOT to import from enterprise patterns (no DI container unless justified).
> 2. **Layout:** a bun workspaces monorepo vs a single package with strict folders. Count the real cost of each package. Recommend the smallest layout that enforces the boundaries, show the tree, and map every v0.2.0 file to its v1.0 location.
> 3. **Enforcing boundaries:** the rules (core imports no adapters; the hook imports only node:*) and how to enforce them. Options are TS project references, the package.json `exports`/`imports` fields, Biome's `noRestrictedImports`, dependency-cruiser, or a ~30-line import-graph check in CI. Prefer whatever needs no new heavy dependencies (topic 3's policy).
> 4. **Composition and DI:** a composition root per entry point (hook, cli, daemon, mcp), factory injection, the static adapter registry (topic 4), how config flows in (TOML + Zod), and lazy loading per subcommand (`--splitting`).
> 5. **Error model:** `BosunError` with codes + `cause`, one error envelope across HTTP/JSON-RPC/MCP, exit codes, and user messages vs logs.
> 6. **Domain model:** the entities (Task, Job, Lane/Role, Route decision, Memory item, Context bundle, Review, Workspace), a glossary, and the use cases (route prompt, run task, review diff, spin off, retrieve context, consolidate memory) with where each lives.
> 7. **Testing:**
>    - the pyramid
>    - contract tests per port, so every adapter passes the same suite
>    - fakes vs stub CLIs
>    - a HOME guard that's **enforced, not trusted**: for example a test preload that asserts HOME is under a tmpdir and forbids or patches `os.homedir`
>    - both runtimes in CI
>    - golden files for host configs
>    - hook-budget benchmarks as tests
> 8. **Conventions:** strict TS, naming, file size limits, comment density, async patterns, default exports, Biome rules, and docs (ARCHITECTURE.md, ADRs in docs/adr/ with a template).
> 9. **Rewrite vs evolve, the final call.** Topic 4 leans evolve: 89% of lib/ is vendor-neutral, memory survives ~90% and host files 45–55%. Turn that into strangler-fig migration steps that keep bosun green at every step, with a size for each.
>
> Diagrams: a layer/dependency diagram, and the current vs proposed import graph. Write `docs/research/06-architecture.md` in the note format, with the tree, the file map, the boundary rules and how each is enforced, the glossary and the migration steps. Reply in 250 words at most: the style, the layout, enforcement, DI, errors, the testing headline (HOME guard), the migration steps and size, and open questions with defaults.
>
> *(Append the common rules block.)*

## Archived prompt: topic 7, leveled graph memory

> You are research agent 7 of 8 for bosun v1.0. The topics run one after another, and the roadmap builds on your note.
>
> **Read first:**
> - docs/research/README.md: the owner answers, the topic results, the rules and the note format.
> - Notes 01–06. Topic 1 covers SQLite and extensions: the vanilla dylib is approved, with an FTS-only fallback. Topic 4 covers the MemoryStore and ContextSource ports, topic 5 the daemon as the single writer, and topic 6 the structure.
> - The whole current memory layer in lib/: the store, FTS5, the context manager (rank, dedupe, budget), the claude-mem reader, the docs index, consolidation proposals, and the MCP memory tools. Also ARCHITECTURE.md and HANDOFF.md.
>
> **Topic: leveled graph memory.** This is the owner's own idea: "my idea to have leveled graph memory for example".
>
> Answer: what should "leveled graph memory" mean for bosun? Is it worth it? And what's the smallest design that beats the current FTS memory on real retrieval quality inside the hook budget?
>
> Cover:
> 1. **Define the levels concretely.** For example: L0 raw events (sessions, claude-mem observations), L1 atomic facts and notes, L2 entities + typed relations (projects, files/symbols, decisions, tools, preferences), L3 summaries or communities, L4 durable user and project profiles. Say how items get promoted, decay and get forgotten.
> 2. **Prior art, from primary sources: papers and repos, each with its version and date.** Microsoft GraphRAG, LightRAG, HippoRAG 2 (personalized PageRank), Zep/Graphiti (a temporal, bi-temporal knowledge graph), Mem0 graph memory, Letta/MemGPT tiers, A-MEM, RAPTOR (a tree of summaries), Cognee, MemoryOS, and claude-mem itself. Also the graph tools the owner already uses: graphify (`~/.claude/skills/graphify`) and CodeGraph. For each, give what it does, its retrieval quality evidence (LongMemEval, LoCoMo and similar), its cost, and what bosun should steal.
> 3. **Storage:**
>    - SQLite nodes/edges tables + recursive CTEs + FTS5 + sqlite-vec (needs the vanilla dylib) vs an embedded graph DB. Check whether Kùzu is still maintained.
>    - Schema sketch.
>    - Migration from the current memory.db.
> 4. **Embeddings and extraction locally:** Ollama embedding models (nomic-embed-text, embeddinggemma, qwen3-embedding and similar), latency and size on Apple Silicon, LLM extraction cost, entity resolution, and what runs in the daemon in the background vs on the hook path. The hook must stay inside its budget, so retrieval is precomputed or indexed.
> 5. **Read path:** level selection (summaries first, then drill down), graph expansion and spreading activation, hybrid rank fusion (FTS + vector + graph), and packing into the ~400-token hook budget and the MCP tools.
> 6. **Write path:** extraction, the review queue (proposals exist today), redaction and privacy (it exists), temporal validity, contradictions, and consolidation jobs.
> 7. **Evaluation:** build a small, honest eval from bosun's own usage (queries → expected memories), and define the metrics (recall@k, MRR, tokens, latency). Set the bar the graph has to clear over the current FTS memory before it ships.
> 8. **Integration:** graphify and CodeGraph as ContextSources (topic 4), and sharing memory between the owner's Macs (topic 5's server profile; the owner has no server Mac yet).
>
> Diagrams: the levels and their promotion flow, the read path, and the schema (ER). Write `docs/research/07-graph-memory.md` in the note format. Reply in 250 words at most: the definition of the levels, the storage pick, the embedding pick, the read and write paths, the eval bar, the phased plan, and open questions with defaults.
>
> *(Append the common rules block.)*

## Archived prompt: topic 8, other features and optimizations

> You are research agent 8 of 8 for bosun v1.0. The roadmap builds on your note.
>
> **Read first:** docs/research/README.md, notes 01–07, README.md, ARCHITECTURE.md, HANDOFF.md, policy.md, roles/ and skills/.
>
> **Topic: new features and optimizations.** The owner's words: "new features, optimizations".
>
> Answer: beyond what topics 1–7 already plan, which features and optimizations are worth building in v1.0, ranked by value against effort?
>
> Gather candidates from the notes, the code and prior art, and check each against primary sources. Seed ideas, to be judged honestly:
> - **Usage-limit-aware routing** across the Claude and ChatGPT plans. This session hit Claude usage limits twice mid-research, so the "cross" lane and the hold-and-resume behaviour matter.
> - **Session and state handoff between machines**, which the owner needed today.
> - Memory sync between Macs.
> - Router (Kev) evals, and learning lanes from outcomes.
> - Cost and usage tracking per lane.
> - A hook output-cost fix (+0.9–3.6 ms from touching stdout, topic 3).
> - Prompt-cache-aware context injection.
> - Secret scanning before memory writes.
> - A policy engine for `risk high`.
> - Review automation.
> - The TUI dashboard (in the same v1.0, after daemon state exists).
> - Notifications.
> - Background consolidation in the daemon.
> - Worktree lifecycle without Orca.
> - Plugin/profile sharing ("others later").
> - Docs and onboarding for publishing.
>
> **Required, the owner requested it (2026-10-02): auto context compact / handoff.** Design it in its own section with settings `[compact] enabled`, `model` (any ModelProvider, local included, for example `ollama:qwen3:8b`) and `threshold` (a fraction of the context window, default 0.70). The problem it solves: on 2026-10-01 a `cart-service` session re-read ~675k tokens of context per turn, 52% of the day's usage. Verify each of these in primary sources, without assuming:
> - **Reading context usage:** how each host exposes it. For Claude Code: the statusline JSON's context-window fields, `transcript_path` usage in hook input, and the `PreCompact`/`PostCompact`/`SessionStart` (source=compact) hooks. For Codex: its hooks, and the `model_auto_compact_token_limit` config.
> - **Built-in compaction controls:** for example Claude Code's `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, and whether turning off or overriding the built-in compaction is supported.
> - **Triggering:** whether a hook can trigger compaction or a clear, or whether bosun has to hand off to a fresh session (a new session via the Workspace port, an Orca spin, or prompting the user to `/clear`).
> - **Resuming:** how the summary gets back in: SessionStart `additionalContext`, a handoff file under `~/.bosun/handoffs/`, and/or a memory L0 item (topic 7).
> - **Summary quality and latency:** local models vs the host's built-in compaction. Propose a quick eval.
> - **Reuse:** the same handoff file serves moving work between machines, which the owner needed on 2026-10-01.
>
> For each candidate, give the problem (with evidence), the approach, its dependencies on the topic 1–7 decisions, the effort in engineer-days, its value, and its risk. Rank them and cut hard: say what NOT to build.
>
> Write `docs/research/08-features.md` in the note format, with the ranked table and a "not building" list. Reply in 250 words at most: the top 8 with effort, the cut list, and open questions with defaults.
>
> *(Append the common rules block.)*

## Archived roadmap brief (completed)

The main thread, optionally helped by a Plan agent, writes `docs/plans/2026-10-01-bosun-v1.0-roadmap.md` from notes 01–08. It covers:
- the decision log
- internal implementation phases with exit criteria and one final v1.0 ship gate
- the strangler-fig migration steps from topic 6, each with a verify command
- the feature ranking from topic 8
- risks
- a Mermaid gantt or flow

Then offer to publish it as an artifact.
