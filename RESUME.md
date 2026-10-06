# Resume bosun (saved 2026-10-02; research completed 2026-10-04; development continued 2026-10-06)

This is the one file to read when you pick bosun up on another machine. It holds what lives outside this folder: Claude's local memory, the state of the original Mac, and the decisions made in conversation.

## Prompt to resume in Claude Code or Codex (opened in this folder)

```
Read RESUME.md, HANDOFF.md, docs/plans/2026-10-04-bosun-v1.0-implementation-ledger.md and docs/plans/2026-10-01-bosun-v1.0-roadmap.md.
Research topics 1–8 and the roadmap are complete; do not restart the archived research prompts.
Read docs/research/09-opencode-clef.md for the latest host/router revision: OpenCode primary, native Codex/Claude supported, Clef-Flash replacing Kev.
Follow the current user request. Local development is authorized with one sub-agent at a time and coordinator verification between slices. Resume the ledger's unfinished step rather than restarting completed work.
Commit each completed milestone after its checks pass and portable context is updated; the owner requested this on 2026-10-06. Preserve unrelated changes and keep the package version unchanged until the single ship gate.
The owner subsequently requested all remaining work one by one without stopping until finished. Continue directly after milestone commits, preserving all existing restrictions and required qualification gates.
Preserve the owner preferences below; repository documents are the portable memory.
Never run the tests under Bun, and install nothing.
```

## Where everything is

| File | What it holds |
|---|---|
| `docs/research/README.md` | The vision, **all the owner decisions** ("Owner answers"), the rules and the note format. This is the source of truth. |
| `docs/research/RESUME.md` | Completed research status, validation and **archived prompts** for topics 6–8 |
| `docs/research/01…08-*.md` | Finished research notes; only 01–05 contain original-Mac performance measurements (M5 Pro; don't compare them with other machines) |
| `docs/research/09-opencode-clef.md` | Latest host/router revision: OpenCode primary, three first-class native hosts and Clef-Flash migration/qualification |
| `docs/plans/2026-10-01-bosun-v1.0-roadmap.md` | One v1.0 release: internal phases, full-scope ship gate, migration/verification plan, feature ranking, estimates and sequence |
| `docs/plans/2026-10-04-bosun-v1.0-implementation-ledger.md` | Sequential development slices, current progress, coordinator checks and carried unresolved v0.2 issues |
| Original `prompt.md` | Historical vision input; absent in this checkout. The vision and accepted decisions are preserved in `docs/research/README.md`. |
| `HANDOFF.md` | Current development readiness/first slice, followed by the clearly labelled historical v0.2 report |
| `ARCHITECTURE.md`, `README.md` | Current implementation and remaining compatibility seams; package metadata stays v0.2.0 until the single v1.0 ship gate |

## Status

- **Done:** topics 1–8 and [the integrated roadmap](docs/plans/2026-10-01-bosun-v1.0-roadmap.md), completed 2026-10-04. Latest notes: [architecture](docs/research/06-architecture.md), [graph memory](docs/research/07-graph-memory.md), [features/auto-handoff](docs/research/08-features.md).
- **Latest plan revision:** [OpenCode/Clef](docs/research/09-opencode-clef.md), checked 2026-10-04. OpenCode is primary; native OpenCode, Codex and Claude Code remain first-class. Clef-Flash replaces Kev through Ollama's decision API; migration covers the service/config/remote lifecycle as well as the model string.
- **Implementation (2026-10-04–06):** Foundations through docs snapshot/index isolation and 7b6 owner sharing/expired-session restore are verified. CLI add/update accept --unshared, sharing conflicts fail before effects, and update forwards --status active|archived. Explicit expired archived session restores renew from one admitted timestamp using the current configured TTL (zero disables expiry); unexpired/other-category/ordinary-edit deadlines and raw flags/IDs/hash/audit/scope remain compatible. Direct memory/docs queries remain separate from maintenance/indexing; public hook delivery retains its bound non-expiring view/lease limits. Next: 7b7 context ranking/packing and caller dependency isolation, then hook snapshots, central COMMIT storage qualification, artifact disposition/drain and every remaining native/Clef/daemon/handoff/graph/dashboard/remote/ship gate. Package stays 0.2.0.
- **Fresh checks:** Independent coordinator guarded Node full **417/417 application tests plus 18/18 containment**, zero failures/cancellations/skips, 123.6 seconds. Worker affected suites passed **197/197 plus 18 containment**, 48.1 seconds; final restore lease/fence suite passed **25/25 plus 18 containment**, 0.6 seconds. Corrected pre-production baselines reproduced four native/CLI unsharing failures (28/32), then two ignored-status failures (17/19). Actual plain/registered owner CLI and stdio MCP cover restore/reopen/new expiry, post-maintenance/stale versions, sharing scope, opaque private receipts, audit parity and pre-effect conflict refusal. Strict isolated typecheck, boundaries (66 production files /235 edges /zero violations), whitespace, Markdown links/fences and nine edited-document Mermaid grammar blocks pass. No live host, general model-delivery lease, exact COMMIT allocation, power-loss, hostile-sameUID or designated-Mac performance claim.
- **Next phase:** continue authorized development in ledger order using one worker at a time and coordinator review between tasks. No research question blocks foundation work; live host/model qualification is still required before automatic support can ship. No installs/personal writes/Bun tests are authorized.
- **Readiness review (2026-10-04):** foundation development can begin without another architecture/product clarification. HANDOFF.md now separates current instructions from historical no-daemon/install steps. The owner clarified that Graphify/CodeGraph are optional, installed by users when needed; their absence/identity does not block development or release. No implementation/install was performed by this review.

The owner renewed the request to complete the research in this Codex session after Sonnet was unavailable. Topics 6–8 finished sequentially with available Codex agents; the original Sonnet selection below is historical. Scratch work under `/tmp/bosun-research-q4qYDt/` may not survive a machine switch; the notes preserve the durable findings.

Current checkout: branch `main`, history root `8e835a5082530a132912e6dd3afca65db903aac1`. Completed research, roadmap, four repository skills/discovery links and verified implementation are committed in milestone groups; see [the ledger commit map](docs/plans/2026-10-04-bosun-v1.0-implementation-ledger.md#commit-checkpoints-2026-10-06) and `git log`. Transfer the committed checkout and its history to resume elsewhere. `bun.lock` and `node_modules/` remain pre-existing untracked artifacts, untouched and excluded from commits. No worker or test job needs restarting.

Validation: all diagrams in notes 6–8 and the roadmap passed syntax checks with the existing Mermaid 11.17.2 parser (no visual-rendering claim); required note sections, fences, relative links and whitespace passed. Topic 8 also checked its 29 unique external URLs (HTTP 200). No bosun suite, model run, install or personal-config write was performed for topics 6–8/roadmap; the earlier preparation ran only isolated Node wiring checks.

**Current checkpoint (2026-10-06):** prior verified commits include `16de0a3`, `33919db`, `2cc25ff`, `353fc1a` and docs isolation `a6f3b6b`. 7b6 CLI sharing/status/expiry fixes are verified and ready for this milestone commit; its worker and test jobs are finished. Continue directly to 7b7 context-use-case/dependency isolation, then all accepted milestones. [ADR 0010](docs/adr/0010-writable-memory-adapter.md) records restore policy and limits.

## Codex preparation (2026-10-03)

- Read this file, `docs/research/RESUME.md`, and `docs/research/README.md` when switching hosts. The Sonnet research prompts below describe the original Claude workflow; do not silently substitute an OpenAI model or launch pending research from a historical prompt.
- **Auto-handoff checked:** it is a required topic 8 feature, not implemented in v0.2. `lib/wire.ts` registers the routing hook; `lib/route.ts` does not monitor context occupancy, and the current config has no `[compact]` parser or summary/restart controller.
- Added repository skills: [OpenAI models](skills/bosun-openai-models/SKILL.md), [Codex integration](skills/bosun-codex/SKILL.md), [ChatGPT surfaces](skills/bosun-chatgpt/SKILL.md), and [portable handoff](skills/bosun-handoff/SKILL.md). Their `.agents/skills` links support Codex discovery in this checkout; no global installation is needed. They may require a new session to appear in the skill list.
- [The dated model reference](skills/bosun-openai-models/references/models.md) covers `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6-luna`, and existing `gpt-6-sol` settings. Model defaults were not changed. Refresh official docs before migration; API and host reasoning settings differ.
- This machine reports Node `v24.16.0` and Codex CLI `0.160.0`. Original-machine measurements and installation state below are historical, not observations of this Mac.
- At preparation time, research topics 6–8 and the roadmap remained pending; the current status above tracks the subsequent continuation. No installation, personal configuration changes, or live model runs were performed for this preparation.

## Decisions so far

**Owner answers:**
- **Commit policy (2026-10-06):** split completed work into coherent milestone commits, then commit every future completed milestone after verification and portable-context updates. This supersedes the earlier no-commit constraint; commits are internal checkpoints within the single v1.0 release, not intermediate releases. Preserve unrelated owner changes and pre-existing untracked artifacts.
- **Release policy (2026-10-04):** everything selected belongs to **one v1.0**. Finish the full scope before shipping; use internal implementation phases, with no intermediate releases, feature assignments to later versions or pre-ship package-version bumps. This supersedes the earlier staged-release defaults.
- **Primary host (2026-10-04):** make the plan OpenCode-centric. Default interpretation of the owner's three-host question: OpenCode is the main onboarding/managed-session experience, with native Codex and Claude Code supported through the same contracts. Qualify each host's actual capabilities; a provider model inside OpenCode is not the native Codex/Claude harness.
- **Router (2026-10-04):** replace Kev with local Ollama **Clef-Flash**, proposed model `clef-flash:9b` on `/v1/systemone`. No Kev uv/Python service in the selected design. Clef is a decision model, separate from the generative handoff model. No model pull/config change has been applied.
- **External graph tools (2026-10-04):** Graphify and CodeGraph are optional user-installed integrations. Keep absent sources disabled; validate actual export/MCP contracts when configured, with no automatic installation or release dependency on these tools. Bosun's own graph memory remains in scope.
- **Audience:** me first, others later. Build for publishing (binaries, docs, stable interfaces), but there's one user today.
- **Rewrite or evolve:** the research decides. Topic 6 concludes **evolve** into one package with enforced boundaries; topic 4 found 89% of `lib/` lines vendor-neutral and estimated ~90% memory-layer retention.
- **Daemon:** yes. It runs always-on under launchd, the hook becomes a thin client, and it falls back to in-process when the daemon is down.
- **SQLite:** a vanilla dylib is allowed for extensions (sqlite-vec), with an FTS-only fallback.
- **Agent loop:** **path (a)**, now OpenCode-primary with native OpenCode, Codex, Claude Code and additional ACP runners. Keep the seven-port core independent; use the external OpenCode server/plugin instead of embedding its full harness. Evaluate local harnesses before a scoped own-loop decision.
- **Claude Code wiring:** one plugin folder, `~/.claude/skills/bosun/` (subagents become `bosun:worker`), after a 1-day spike.
- **Server Mac:** there isn't one yet. Build and test remote support after the single-Mac foundations within the same v1.0; use isolated daemon instances for validation. Real server provisioning remains a deployment choice.
- **Research cost (original workflow):** topics 6–8 were requested on Sonnet; the later Codex continuation is recorded above.
- **Feature request: auto context compact / handoff (added 2026-10-02).** When a host session's context passes a threshold, bosun writes a handoff summary with a configurable model, and the work continues in a fresh context from that summary. This replaces re-reading a huge context every turn (the `cart-service` problem), and the same handoff file also serves moving work between machines. Settings:
  ```toml
  [compact]
  enabled   = true
  model     = "ollama:qwen3:8b"   # any ModelProvider: local (ollama, openai-compatible) or claude-cli/codex-cli
  threshold = 0.70                # fraction of the host's context window
  ```
  [Topic 8](docs/research/08-features.md) designs it and [the roadmap](docs/plans/2026-10-01-bosun-v1.0-roadmap.md) schedules it. It remains unimplemented.

**Topic results:**

| # | Topic | Picks |
|---|---|---|
| 1 | Runtime | **Bun 1.4.x, written against `node:*` APIs**, with Node LTS green in CI. Use `node:sqlite`, not `bun:sqlite` (silent NULL binds), and `setCustomSQLite` to a vanilla dylib on macOS. |
| 2 | Protocol | **HTTP/1.1 + JSON** over a UDS (`~/.bosun/run/bosun.sock`, 0600), SSE for streams, JSON-RPC 2.0 on stdio. No gRPC or HTTP/2/3 (slower and buggy). One method table and three adapters (HTTP, stdio, MCP). MCP moves to the 2026-07-28 spec. Tailscale + a bearer token + allowlist. |
| 3 | Libraries | commander 15, Ink 7 + @clack/prompts, Zod 4.6, Hono on node:http, @modelcontextprotocol/server 2.2, raw node:sqlite, smol-toml config, LogTape, node:child_process, Biome, TypeScript 7. **The hook imports only `node:*`.** Pinned deps with ≤5 transitive each. Build with `--no-compile-autoload-*` (`.env` leak). |
| 4 | Abstractions | **7 ports:** HostAdapter, AgentRunner (now native OpenCode, Codex/Claude CLIs and ACP), ModelProvider, MemoryStore, ContextSource, Workspace (orca, git-worktree), Router. Topic 9 adds native managed-server controls without changing the ports. **A bosun-native loop can't use the Claude subscription** (Consumer Terms). |
| 5 | Topology | **One binary**, `bosun` (`--compile --splitting --bytecode`; hook path ~5 ms). One LaunchAgent daemon, and clients never auto-spawn it. The daemon is the single writer, and the hook reads read-only when the daemon is down. A Homebrew tap, and `~/.bosun/manifest.json` makes uninstall exact. No more `~/.zshrc` edits. |
| 6 | Architecture | Research default: evolve into one package with seven ports, feature use cases, four composition roots, a lazy adapter registry, enforced import boundaries and HOME containment. Hook config comes from a validated JSON snapshot; fallback reads do not mutate; uncertain writes are not repeated. See [the note](docs/research/06-architecture.md). |
| 7 | Graph memory | Research default: SQLite + FTS, scoped L0–L4 views, minimal L1–L2/lineage first; graph activation depends on local retrieval/privacy/latency evaluation. No inference on the hook or on private data. claude-mem stays external/read-only. See [the note](docs/research/07-graph-memory.md). |
| 8 | Features | Research default: mandatory qualified fresh-session handoff, content-free logs/screening, quota holds, portable transfer, router eval, provider-unit ledger, deterministic dispatch/review checks and diagnostics. See [the note](docs/research/08-features.md). |

The [OpenCode/Clef revision](docs/research/09-opencode-clef.md) supersedes earlier two-host/Kev selections, not their historical observations. The inspected upstream OpenCode release is v1.18.34; do not mix its v1 native contracts with v2 SDK/plugin examples. `opencode` and `ollama` are absent from this shell's PATH. Native handoff parity, Clef calibration and local performance remain unmeasured implementation gates. Native Claude keeps its own login; Claude models inside OpenCode require a supported API/cloud provider, with no subscription-token import.

**Defaults taken that you can override:**
- the Claude `http` hook is an opt-in capability to qualify after the daemon path; it has no separate release assignment
- the tailnet holds only your devices
- config moves to TOML
- the Ink dashboard is part of the same v1.0, built after daemon state/SSE exist
- binaries only, no npm packages
- headless spin-off without Orca
- no ChatGPT-plan router/consolidation calls in v1.0; the later any-ModelProvider handoff request permits optional native CLI summarizers after tool-isolation qualification

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

## Continuing development (research complete)

1. Use the completed roadmap's decisions, internal phases, full-scope ship gate, feature ranking and risks; future verify scripts are explicitly proposed, not existing or run. The complete v1.0 planning envelope is 85–135 engineer-days, including the third native host/Clef migration, enrichment, dashboard and remote support; re-estimate after probes.
2. Follow the implementation ledger using sequential workers and coordinator review; commit each verified milestone and continue directly without another user prompt. Current checkpoint: 7b6 CLI sharing/status/expired-session renewal. Next: 7b7 context ranking/packing and caller dependency isolation, then hook snapshot, storage/disposition/drain and all roadmap steps. Preserve no installs/personal writes/Bun tests and full one-v1 scope; no partial milestone proves shipping readiness.
3. Keep v0.2.0 working while it evolves; preserve user data, explicitly selected models and privacy constraints.
