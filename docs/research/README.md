# bosun v1.0 research (2026-10-01)

> **Resuming? Read [RESUME.md](RESUME.md) first:** the status, the next steps and the agent prompts for topics 6–8.

**Completed 2026-10-04:** all eight notes and [the v1.0 roadmap](../plans/2026-10-01-bosun-v1.0-roadmap.md). The notes were written sequentially and build on preceding decisions. This is research; v1.0 implementation has not started.

**Release policy (owner decision, 2026-10-04):** everything selected belongs to **one v1.0**, shipped when the full scope is ready. Internal phases replace staged releases. Include graph enrichment, the Ink dashboard, optimizations and remote support in this build; do not assign work to later versions or bump the package version before shipping. This supersedes earlier release-staging defaults while retaining quality, privacy and host-capability gates.

**Latest owner scope (2026-10-12):** **OpenCode 2 primary; keep Codex and Claude Code as supported hosts; omit cleanup from the plan**, confirmed by “Keep supported hosts.” This supersedes the earlier same-day OpenCode-only/removal decision. The owner additionally requests **Bun only, after verifying its previous test-safety issues first**. Preserve native host implementations/qualification gates, all non-host features, optional read-only claude-mem, data/privacy/audit, explicit models and one final verified commit. The [current direct-delivery plan](../plans/2026-10-06-bosun-v1.0-direct-delivery.md) defines the four remaining items; Bun containment comes before further application tests. Existing Node evidence is historical and does not establish Bun safety. No new ACP scope, install, uncontrolled test run, personal-state or live host/model call is implied. OpenCode runner/control now use source-pinned2.0.27; profiles/plugins and all live host controls remain unqualified.

**Host/router update (owner request, 2026-10-04):** make the plan **OpenCode-centric** and replace **Kev with Clef-Flash**. [Topic 9's revision](09-opencode-clef.md) establishes the feasible default: OpenCode primary, native OpenCode/Codex/Claude Code first-class behind shared contracts, with per-host managed-handoff qualification. Clef runs locally through Ollama's typed decision API; remove Kev's separate Python service during migration. The running code remains v0.2.

**Bun verification checkpoint:** installed1.4.3 containment29/29 and focused186/186 application assertions pass, plus typecheck/boundaries. Startup-native HOME and explicit child preloads replace the unsafe runtime-HOME/NODE_OPTIONS assumptions. Full runtime/storage remains held: `node:sqlite` close leaves locks with reachable statements and native backup readback fails. Source1.4.3 memory admission stays denied; historical compiled1.4.2 evidence is not a fallback installation/run. Latest details and next action are in root [HANDOFF.md](../../HANDOFF.md); no live diagnostics/evaluation approvals were consumed.

**External graph tools (owner clarification, 2026-10-04):** Graphify and CodeGraph are optional; users install/configure them when needed. Their absence or unresolved identity does not block development or v1.0 shipping. Provide optional read-only ContextSource integration over verified exports/MCP, disabled when absent; no automatic tool installation. Bosun's own graph-memory scope is unchanged.

## Vision (from the owner)

- A fast, reliable language. If the Node.js ecosystem is mature enough and fits, the runtime should be **Bun**.
- A fast, reliable protocol between components, such as HTTP/2, HTTP/3 or gRPC.
- Use libraries instead of reinventing the wheel: a CLI framework, a TUI, and so on.
- **Independent first:** Claude, Codex, memory and so on sit behind abstractions and can be extended.
- Maybe several CLIs instead of one.
- A segregated code structure that's easy to extend, and follows best practice in architecture and code.
- New features and optimizations, for example a **leveled graph memory**.

## Owner answers (2026-10-01)

- **Independence:** decide after research. Topic 4 must lay out both paths with their costs: (a) bosun as an orchestration layer over host agents such as Claude Code, Codex and Orca, which become pluggable adapters, and (b) bosun also running its own agent loop against model APIs or local models.
- **Audience:** the owner first, others later. Build for publishing (installable binaries, docs, stable interfaces), but only one user runs it today (≤2 Macs over Tailscale).
- **Rewrite or evolve:** the research decides, based on how much of the v0.2.0 code survives the new architecture.
- **Daemon (after topic 1):** yes. A long-running bosun daemon is acceptable, and the per-prompt hook becomes a thin client that falls back to in-process when the daemon is down.
- **SQLite (after topic 1):** bosun may depend on a vanilla SQLite dylib (Homebrew's or a bundled one) for extensions such as sqlite-vec. Without it, bosun degrades to FTS-only.
- **Runtime (topic 1 result):** Bun 1.4.x, with the code written against `node:*` APIs, `node:sqlite` rather than `bun:sqlite`, and Node LTS kept green in CI. **Never run the test suite under Bun without isolating HOME:** `os.homedir()` ignores runtime `$HOME` on Bun (oven-sh/bun#29244).
- **Protocol (topic 2 result):** HTTP/1.1 + JSON on every socket link: a UDS `~/.bosun/run/bosun.sock` locally, TCP over Tailscale remotely, SSE for streams. Stdio links use JSON-RPC 2.0. No gRPC, Connect, HTTP/2 or HTTP/3. The contract is defined once in TS with a schema library that emits JSON Schema; there's one method table and three adapters (HTTP, stdio JSON-RPC, MCP). MCP moves to the stable 2026-07-28 spec. Defaults the owner can override: qualify the optional Claude Code `http` hook after the daemon path within this build; the tailnet holds only the owner's devices, so a bearer token + allowlist + grant is enough.
- **Libraries (topic 3 result):**
  - **Picks:** commander 15, Ink 7 + @clack/prompts, Zod 4.6, Hono on @hono/node-server, @modelcontextprotocol/server 2.2, raw node:sqlite + the in-repo migrator, smol-toml + Zod config, LogTape, node:child_process.
  - **LLM:** fetch providers + Zod; AI SDK 7 only if topic 4 picks bosun's own loop.
  - **Tooling:** node:test API under both bun test and node --test, Biome, TypeScript 7.
  - **Hook rule:** the hook imports only node:* (+ smol-toml).
  - **Defaults, with updated release scope:** config moves to TOML; the Ink dashboard belongs to v1.0 after daemon state/SSE exist; distribution uses binaries only (no npm packages).
  - **Compile risk:** build with `--no-compile-autoload-*`, because compiled Bun binaries otherwise auto-load `.env`.
- **Abstractions (topic 4 result, owner-approved):**
  - **Path (a), updated by topic 9:** bosun is a layer over host agents, with OpenCode's external native harness as the primary experience and native Codex/Claude retained. Evaluate local harnesses before a scoped own-loop decision. A bosun-native loop can't use the Claude subscription (Consumer Terms).
  - **Seven ports:** HostAdapter, AgentRunner (native OpenCode server/CLI, Codex CLI/app-server, Claude CLI, generic ACP), ModelProvider, MemoryStore, ContextSource, Workspace (orca, git-worktree), Router.
  - **Extensions:** compiled-in adapters in a static table; third parties come in through ACP, MCP or OpenAI-compatible HTTP. There's no bosun plugin protocol yet.
  - **Claude Code wiring:** a single plugin folder `~/.claude/skills/bosun/` (subagents become `bosun:worker`), after a 1-day spike.
  - **Standards:** adopt MCP, Agent Skills, AGENTS.md, and ACP (except for Claude and Codex). Skip A2A.
  - **Evolve, don't rewrite:** about 90% of the memory layer survives, and 45–55% of the host-facing files.
  - **Defaults:** without Orca, a headless spin-off is fine; the ChatGPT plan isn't used for bosun's own LLM calls in v1.0.
- **Feature request (2026-10-02): auto context compact / handoff.** At a threshold of the host session's context, bosun writes a handoff summary with a configurable model (local included) and continues in a fresh context. The settings are `[compact] enabled`, `model` (any ModelProvider, local included) and `threshold` (a fraction of the context window, default 0.70). Topic 8 must design it, and it isn't optional.
- **Topology (topic 5 result):**
  - **One binary:** `bosun`, built with `bun build --compile --splitting --bytecode`. Every role is a subcommand (`hook`, `mcp`, `daemon run`, `tui`). The hook path takes 5.0–5.3 ms p50, the same as a dedicated binary.
  - **No several binaries** (5× the size, N first-exec scans, skew) and no external `bosun-<name>` plugins in v1.0.
  - **Daemon:** one always-on LaunchAgent, `com.bosun.daemon` (KeepAlive; 8.8 MB idle). Clients never auto-spawn it. Upgrades drain then exit.
  - **Concurrency:** one daemon per BOSUN_HOME, with launchd plus a link(2) lockfile. The daemon is the single long-lived writer. With the daemon down, the hook reads SQLite read-only, and the CLI and MCP use the in-process MemoryService. The daemon checks `PRAGMA data_version` for its caches.
  - **Commands:** agent-facing verbs stay top-level (`run`, `review`, `spin`, `card`, `roles`, `memory`); admin is grouped by noun (`daemon`, `host`, `service`, `router`, `model`, `job`, `config`).
  - **Install:** a Homebrew tap, with `/opt/homebrew/opt/bosun/bin/bosun` as the stable path. `~/.bosun/manifest.json` records every external write, and `bosun uninstall` reverses it exactly. No more `~/.zshrc` edits.
  - **Server Mac:** the same daemon with a `[serve]` profile. **The owner has no server Mac yet**. Implement and validate remote support after the single-Mac foundations in the same release, using two isolated instances; real deployment is separate from software readiness.
- **Architecture (topic 6 research defaults, 2026-10-04):** evolve into one package with seven ports, feature use cases, four composition roots and a lazy static adapter registry. Enforce imports and cycles with a resolved graph check; keep the hook's transitive closure to `node:*` using an admin-generated config snapshot. Separate genuinely read-only fallback from expiry/index writes, and never retry a mutation after an ambiguous timeout. Enforce HOME containment before test imports. Architecture extraction is estimated at 10–16 engineer-days; the overlapping ports/daemon foundation is 6–8 engineer-weeks, not the complete release. These are research estimates and defaults, not new owner approvals; see [06-architecture.md](06-architecture.md).
- **Graph memory (topic 7 research defaults, 2026-10-04):** levels are L0 evidence references, L1 atomic facts, L2 scoped entities/relations, L3 summaries and L4 reviewed durable profiles. Keep SQLite, FTS and current IDs; start with L1–L2 and minimal lineage. Enable bounded graph retrieval only after it beats current and improved lexical baselines under the same hook budget. No model calls on the hook; fresh vector queries belong to MCP/background work. EmbeddingGemma QAT Q4 is the first local candidate to evaluate, not an installed model. Private data never enters any model; privacy/scope/expiry/deletion apply to every derivative. claude-mem stays external/read-only, and graphify/CodeGraph adapters wait for verified identities. See [07-graph-memory.md](07-graph-memory.md).
- **Features (topic 8 research defaults, 2026-10-04):** required auto-handoff uses qualified active-context telemetry, bounded summaries, atomic artifacts, a controller-enforced destination startup barrier, acknowledgement and durable ownership transfer. Native compaction stays enabled; unknown telemetry or a preempting native window makes that configuration unsupported for automation. Manual documents never count as automatic completion. The later any-ModelProvider request permits optional native CLI handoff summarizers, while router/consolidation retain the earlier local-first default. See [08-features.md](08-features.md).
  - **Top eight:** automatic handoff (12–18 days), prompt-log minimization/screening (1–2), quota holds (5–7), portable export/import (2–4), held-out router eval (3–5), provider-unit usage ledger (2–4), deterministic dispatch/review evidence (3–5), diagnostics/onboarding (2–3). The 30–48-day increment precedes foundation overlap. Work and Codex share usage; preserve explicitly selected models and never replay unknown effects.
  - **Complete selected scope:** also include cache-stability evaluation/rendering, bounded consolidation, local notifications, worktree lifecycle previews, the Ink dashboard, remote authority/local views and sanitized profile export. Graph memory includes scoped L3/L4, optional vector/extraction providers and verified ContextSources in the same build; activation stays gated.
  - **Cuts/defaults:** no arbitrary UI takeover, whole-history small-model calls, subscription credential borrowing, online router learning, generic agent platform/policy DSL, multi-master memory sync or marketplace. [The integrated roadmap](../plans/2026-10-01-bosun-v1.0-roadmap.md) now estimates 85–135 engineer-days including topic 9's additional native-host/router qualification, with internal phases and one final ship gate. Estimates remain provisional; unresolved selected capabilities require a recorded disposition before shipping.
- **Host/router revision (topic 9, 2026-10-04):** OpenCode primary with native OpenCode, Codex and Claude Code acceptance suites; thin version-qualified server/plugin adapters, shared roles/skills/MCP, no core harness embedding. Use local Clef-Flash for advisory lane/risk decisions, backed by deterministic fences and evaluated thresholds; keep summaries/extraction generative. No inference on hooks/plugin callbacks, no private model input or automatic downloads. OpenCode's provider/model selection is separate from native host choice; do not transfer Claude subscription credentials into it. See [09-opencode-clef.md](09-opencode-clef.md).

## Where bosun is today (v0.2.0)

Read `README.md`, `ARCHITECTURE.md` and `HANDOFF.md` for the details. In short:
- **What it is:** a TypeScript ESM CLI (~3,000 lines in `lib/`, ~2,200 of tests). Node ≥ 24 runs it through native type stripping. It has no runtime dependencies, and no build step.
- **What it does:** it wraps a host agent (Claude Code or Codex):
  - roles are rendered as subagents for both hosts
  - skills are linked into both hosts
  - a `UserPromptSubmit` hook (`bosun route --hook`) adds a Kev router hint and ~400 tokens of memory
  - executors: `bosun run` hands work to a local Ollama model, `-e codex` or `-e claude`
  - `bosun review` asks the other vendor's model to review
  - Orca integration covers watchable splits, worktree spin-offs and parallel workers
- **Memory:** `node:sqlite` + FTS5 in `~/.bosun/memory.db`, with a read-only view of claude-mem, a docs index, a context manager (rank, dedupe, budget), a hand-rolled stdio MCP server with 7 tools, an LLM router (Ollama → OpenAI-compatible → opt-in `claude -p`) and consolidation proposals.
- **Split setup:** `bosun serve memory|kev` runs HTTP/1.1 JSON `/v1` on a server Mac over Tailscale, protected by a bind address and a source-IP allowlist.
- **Known pain:**
  - The hook's memory part is p95 ~40 ms against a 30 ms target. The cause is a cold SQLite open in each per-prompt process, and the approved design has no daemon.
  - `lib/cli.ts` dispatches everything.
  - Claude and Codex specifics are spread through `wire.ts`, `exec.ts`, `route.ts` and `services.ts`.
  - The host and provider abstractions aren't formal.
- **Machine:** Apple M5 Pro, 48 GB, macOS. Node 24.21.0 and Bun 1.4.2 are installed. Go, Rust, Deno, Ollama and Codex aren't.

## Rules for every research agent

- **Primary sources:** official docs, source code, specs, release notes and issue trackers. Cite a link for every claim. Note the date or version you checked.
- **Install nothing:** no `npm/bun/brew/pip install`, no `npx`/`bunx` of packages you don't already have, and no changes to `~/.claude`, `~/.codex` or `~/.bosun`. You may run tools already on the machine (for example `bun`, `node`, `curl`, `gh`) for small measurements in the session scratchpad.
- **Fit to bosun:** judge every option against bosun's real constraints (hook latency, single user with up to two Macs, subscription logins, local models) and not in the abstract. Prefer boring, maintained and widely used, and state the trade-offs.
- **Diagrams:** use Mermaid in the notes.

## Note format

`NN-topic.md`, with these sections:
1. **Question**
2. **TL;DR:** the recommendation in 5–10 bullets
3. **bosun constraints** that matter for this topic
4. **Options:** a comparison table, then evidence per option, cited
5. **Measurements** (if any): exact commands, machine, numbers
6. **Recommendation:** rationale, risks, and what would change the call
7. **Open questions for the owner:** only the ones that change the outcome
8. **Roadmap implications:** concrete work items
9. **Sources**

## Topics (in order)

| # | Topic | Note |
|---|---|---|
| 1 | Runtime and language (Bun vs Node vs others) | [01-runtime.md](01-runtime.md) |
| 2 | Protocol between components (HTTP/2, HTTP/3, gRPC, Connect, JSON-RPC, UDS) | [02-protocol.md](02-protocol.md) |
| 3 | Libraries (CLI, TUI, config, logging, DB, MCP, LLM SDKs, tooling) | [03-libraries.md](03-libraries.md) |
| 4 | Independence: abstracting agents, models, memory and orchestrators | [04-abstractions.md](04-abstractions.md) |
| 5 | One CLI or several; the process topology (daemon and clients) | [05-cli-topology.md](05-cli-topology.md) |
| 6 | Architecture and code structure (layers, DI, errors, monorepo, testing) | [06-architecture.md](06-architecture.md) |
| 7 | Leveled graph memory | [07-graph-memory.md](07-graph-memory.md) |
| 8 | Other new features and optimizations | [08-features.md](08-features.md) |
