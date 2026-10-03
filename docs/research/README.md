# bosun v2 research (2026-10-01)

> **Resuming? Read [RESUME.md](RESUME.md) first:** the status, the next steps and the agent prompts for topics 6–8.

One research note per topic. The notes were written one after another, and each one reads the notes before it. The roadmap built from them goes in `docs/plans/2026-10-01-bosun-v2-roadmap.md`.

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
- **Protocol (topic 2 result):** HTTP/1.1 + JSON on every socket link: a UDS `~/.bosun/run/bosun.sock` locally, TCP over Tailscale remotely, SSE for streams. Stdio links use JSON-RPC 2.0. No gRPC, Connect, HTTP/2 or HTTP/3. The contract is defined once in TS with a schema library that emits JSON Schema; there's one method table and three adapters (HTTP, stdio JSON-RPC, MCP). MCP moves to the stable 2026-07-28 spec. Defaults the owner can override: the Claude Code `http` hook is opt-in later, not in v2.0; the tailnet holds only the owner's devices, so a bearer token + allowlist + grant is enough.
- **Libraries (topic 3 result):**
  - **Picks:** commander 15, Ink 7 + @clack/prompts, Zod 4.6, Hono on @hono/node-server, @modelcontextprotocol/server 2.2, raw node:sqlite + the in-repo migrator, smol-toml + Zod config, LogTape, node:child_process.
  - **LLM:** fetch providers + Zod; AI SDK 7 only if topic 4 picks bosun's own loop.
  - **Tooling:** node:test API under both bun test and node --test, Biome, TypeScript 7.
  - **Hook rule:** the hook imports only node:* (+ smol-toml).
  - **Defaults:** config moves to TOML; the Ink dashboard comes in v2.1, not v2.0; releases are binaries only (no npm packages).
  - **Compile risk:** build with `--no-compile-autoload-*`, because compiled Bun binaries otherwise auto-load `.env`.
- **Abstractions (topic 4 result, owner-approved):**
  - **Path (a) for v2.0:** bosun is a layer over the host agents. Path (b), a minimal own loop for local models, is decided after a local-model eval in v2.1. A bosun-native loop can't use the Claude subscription (Consumer Terms).
  - **Seven ports:** HostAdapter, AgentRunner (claude-cli, codex-cli, generic ACP), ModelProvider, MemoryStore, ContextSource, Workspace (orca, git-worktree), Router.
  - **Extensions:** compiled-in adapters in a static table; third parties come in through ACP, MCP or OpenAI-compatible HTTP. There's no bosun plugin protocol yet.
  - **Claude Code wiring:** a single plugin folder `~/.claude/skills/bosun/` (subagents become `bosun:worker`), after a 1-day spike.
  - **Standards:** adopt MCP, Agent Skills, AGENTS.md, and ACP (except for Claude and Codex). Skip A2A.
  - **Evolve, don't rewrite:** about 90% of the memory layer survives, and 45–55% of the host-facing files.
  - **Defaults:** without Orca, a headless spin-off is fine; the ChatGPT plan isn't used for bosun's own LLM calls in v2.0.
- **Feature request (2026-10-02): auto context compact / handoff.** At a threshold of the host session's context, bosun writes a handoff summary with a configurable model (local included) and continues in a fresh context. The settings are `[compact] enabled`, `model` (any ModelProvider, local included) and `threshold` (a fraction of the context window, default 0.70). Topic 8 must design it, and it isn't optional.
- **Topology (topic 5 result):**
  - **One binary:** `bosun`, built with `bun build --compile --splitting --bytecode`. Every role is a subcommand (`hook`, `mcp`, `daemon run`, `tui`). The hook path takes 5.0–5.3 ms p50, the same as a dedicated binary.
  - **No several binaries** (5× the size, N first-exec scans, skew) and no external `bosun-<name>` plugins in v2.0.
  - **Daemon:** one always-on LaunchAgent, `com.bosun.daemon` (KeepAlive; 8.8 MB idle). Clients never auto-spawn it. Upgrades drain then exit.
  - **Concurrency:** one daemon per BOSUN_HOME, with launchd plus a link(2) lockfile. The daemon is the single long-lived writer. With the daemon down, the hook reads SQLite read-only, and the CLI and MCP use the in-process MemoryService. The daemon checks `PRAGMA data_version` for its caches.
  - **Commands:** agent-facing verbs stay top-level (`run`, `review`, `spin`, `card`, `roles`, `memory`); admin is grouped by noun (`daemon`, `host`, `service`, `router`, `model`, `job`, `config`).
  - **Install:** a Homebrew tap, with `/opt/homebrew/opt/bosun/bin/bosun` as the stable path. `~/.bosun/manifest.json` records every external write, and `bosun uninstall` reverses it exactly. No more `~/.zshrc` edits.
  - **Server Mac:** the same daemon with a `[serve]` profile. **The owner has no server Mac yet**, so the split setup is planned but not designed around a specific boot setup, and it's a lower priority than the single-Mac path.

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
