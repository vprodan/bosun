# Resume bosun (saved 2026-10-02)

This is the one file to read when you pick bosun up on another machine. It holds what lives outside this folder: Claude's local memory, the state of the original Mac, and the decisions made in conversation.

## Prompt to paste into Claude Code (opened in this folder)

```
Read RESUME.md, then docs/research/RESUME.md and docs/research/README.md, and continue the bosun v2 research.
Restart topic 6 (architecture) with the saved prompt, then topics 7 and 8, one agent at a time (general-purpose, model: sonnet). After each, give me a short summary and ask only the questions that change the outcome.
Then write the roadmap at docs/plans/2026-10-01-bosun-v2-roadmap.md.
Also save the "Owner preferences" section of RESUME.md to your memory.
Never run the tests under Bun, and install nothing.
```

## Where everything is

| File | What it holds |
|---|---|
| `docs/research/README.md` | The vision, **all the owner decisions** ("Owner answers"), the rules and the note format. This is the source of truth. |
| `docs/research/RESUME.md` | The research status, how it runs, and **ready prompts for topics 6, 7 and 8** and the roadmap |
| `docs/research/01…05-*.md` | The finished research notes, with citations and measurements (taken on an M5 Pro; don't compare them with other machines) |
| `prompt.md` | The owner's original vision prompt |
| `HANDOFF.md`, `ARCHITECTURE.md`, `README.md` | bosun v0.2.0 as built: 87/87 tests, not installed |

## Status

- **Done:** topic 1 runtime, 2 protocol, 3 libraries, 4 abstractions, 5 CLI/topology.
- **Stopped by the owner, nothing written:** 6 architecture.
- **Pending:** 7 leveled graph memory, 8 features, then the roadmap.

## Decisions so far

**Owner answers:**
- **Audience:** me first, others later. Build for publishing (binaries, docs, stable interfaces), but there's one user today.
- **Rewrite or evolve:** let the research decide. Topic 4 leans **evolve**: 89% of `lib/` names no vendor, and memory survives about 90%.
- **Daemon:** yes. It runs always-on under launchd, the hook becomes a thin client, and it falls back to in-process when the daemon is down.
- **SQLite:** a vanilla dylib is allowed for extensions (sqlite-vec), with an FTS-only fallback.
- **Agent loop:** **path (a)** for v2.0, so bosun is a layer over Claude Code, Codex and ACP agents. Whether it gets a minimal own loop for local models is decided in v2.1, after a local-model eval.
- **Claude Code wiring:** one plugin folder, `~/.claude/skills/bosun/` (subagents become `bosun:worker`), after a 1-day spike.
- **Server Mac:** there isn't one yet. Plan the split setup, but make it a lower priority than the single-Mac path.
- **Research cost:** topics 6–8 run on Sonnet.
- **Feature request: auto context compact / handoff (added 2026-10-02).** When a host session's context passes a threshold, bosun writes a handoff summary with a configurable model, and the work continues in a fresh context from that summary. This replaces re-reading a huge context every turn (the `cart-service` problem), and the same handoff file also serves moving work between machines. Settings:
  ```toml
  [compact]
  enabled   = true
  model     = "ollama:qwen3:8b"   # any ModelProvider: local (ollama, openai-compatible) or claude-cli/codex-cli
  threshold = 0.70                # fraction of the host's context window
  ```
  Topic 8 researches how to build it and the roadmap schedules it.

**Topic results:**

| # | Topic | Picks |
|---|---|---|
| 1 | Runtime | **Bun 1.4.x, written against `node:*` APIs**, with Node LTS green in CI. Use `node:sqlite`, not `bun:sqlite` (silent NULL binds), and `setCustomSQLite` to a vanilla dylib on macOS. |
| 2 | Protocol | **HTTP/1.1 + JSON** over a UDS (`~/.bosun/run/bosun.sock`, 0600), SSE for streams, JSON-RPC 2.0 on stdio. No gRPC or HTTP/2/3 (slower and buggy). One method table and three adapters (HTTP, stdio, MCP). MCP moves to the 2026-07-28 spec. Tailscale + a bearer token + allowlist. |
| 3 | Libraries | commander 15, Ink 7 + @clack/prompts, Zod 4.6, Hono on node:http, @modelcontextprotocol/server 2.2, raw node:sqlite, smol-toml config, LogTape, node:child_process, Biome, TypeScript 7. **The hook imports only `node:*`.** Pinned deps with ≤5 transitive each. Build with `--no-compile-autoload-*` (`.env` leak). |
| 4 | Abstractions | **7 ports:** HostAdapter, AgentRunner (claude-cli, codex-cli, ACP), ModelProvider, MemoryStore, ContextSource, Workspace (orca, git-worktree), Router. Adapters are compiled in, and third parties come in through ACP, MCP or OpenAI-compatible HTTP. **A bosun-native loop can't use the Claude subscription** (Consumer Terms). |
| 5 | Topology | **One binary**, `bosun` (`--compile --splitting --bytecode`; hook path ~5 ms). One LaunchAgent daemon, and clients never auto-spawn it. The daemon is the single writer, and the hook reads read-only when the daemon is down. A Homebrew tap, and `~/.bosun/manifest.json` makes uninstall exact. No more `~/.zshrc` edits. |

**Defaults taken that you can override:**
- the Claude `http` hook is opt-in later
- the tailnet holds only your devices
- config moves to TOML
- the Ink dashboard comes in v2.1
- binaries only, no npm packages
- headless spin-off without Orca
- no ChatGPT-plan LLM calls in v2.0

## Owner preferences (Claude's local memory, copied here)

- **No installs without an explicit ask.**
  - Build and test offline only.
  - Never run `./install.sh`, `bosun install`, `brew install`, model pulls, or anything that writes to `~/.claude`, `~/.codex`, `~/.agents` or `~/Library/LaunchAgents`.
  - "Continue" is not permission to install.
  - Verify with sandboxed-HOME tests, stubs and mocks, and end with the exact install command for the owner to run.
- **Node, not Python,** for tooling (zero-dep, built-ins). The original Mac had Volta Node 24, system python3 3.9 and /bin/bash 3.2.
- **Mermaid diagrams in .md docs,** validated before saving.
- **Ask only the important questions** and take sensible defaults for the rest.
- **No speculative abstraction** and no over-engineering.
- **Never run bosun's tests under Bun.** Bun's `os.homedir()` ignores a runtime `$HOME` change (oven-sh/bun#29244), so the tests write into the real home. The fix: `P.HOME` reads `$HOME` first (docs/research/01-runtime.md). Tell every subagent.
- **Inside Orca,** `CODEX_HOME` points to Orca's managed runtime home: wire rules, agents and MCP there, never its `hooks.json`.
- **claude-mem** (7k+ observations) stays. bosun reads it read-only and never duplicates it.

## State of the original Mac (not in this folder)

**The 2026-10-01 pollution and restore:**
- A Bun test run installed bosun into the real home: the bosun hook, permissions and `CLAUDE.md` block, and 3 disabled plugins in `~/.claude`; Codex files; skill links in `~/.agents/skills`; a test LaunchAgent; and test data in `~/.bosun`.
- On owner approval, everything was restored or moved into **`~/bosun-quarantine-20261001/`**. Delete that folder once you're happy.
- The original `~/.bosun/config.env` (created 2026-09-28) was overwritten and is lost.

**Settings changed on owner request (2026-10-01):**
- **What:** `~/.claude/settings.json` `effortLevel` went from `xhigh` to `high`, both the global value and the `claude-opus-5-5` override.
- **Backup:** `~/bosun-quarantine-20261001/claude/settings.json.before-effort-high`.

**Usage on 2026-10-01, from the local transcripts (~443M tokens, 97% cached context):**

| Share | Source |
|---|---|
| 52% | `cart-service` Opus sessions: ~675k context per turn |
| 27% | bosun research agents on Opus |
| 19% | claude-mem observers on Haiku: 1,085 calls |
| 2% | the bosun main session |

**Suggested but NOT applied:**
- `"model": "opus"` instead of `opus[1m]`
- claude-mem's provider moved to Gemini
- `/compact` the long sessions

## After the research

1. Write the roadmap: the decision log, milestones v2.0/v2.1/v2.2+ with exit criteria, the strangler-fig steps with verify commands, the feature ranking and the risks, plus a Mermaid gantt.
2. Then plan v2.0 with bosun-plan.
3. Keep v0.2.0 working while it evolves.
