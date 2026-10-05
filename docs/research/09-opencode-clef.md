# 09 · OpenCode primary, three native hosts and Clef-Flash

Design revision checked **2026-10-04**, after topics 1–8. The owner requested Clef-Flash instead of Kev and an OpenCode-centric plan, asking whether Codex, Claude Code and OpenCode can all be first-class. This updates the selected v1.0 design; it does not change v0.2 application code or install anything.

## 1. Question

Can OpenCode be the main experience while all three native coding agents remain supported, and how should Clef-Flash replace the current execution router?

## 2. TL;DR

- **Yes, architecturally:** make OpenCode the primary onboarding, managed-session and integration path. Implement native OpenCode, Codex and Claude Code HostAdapters/AgentRunners behind the same seven ports, with a shared acceptance matrix. First-class support does not require identical host APIs.
- Keep the core, memory, job ledger, workspace ownership and handoff artifacts independent of OpenCode. A user selecting Codex or Claude continues in that native harness; neither becomes a model alias inside OpenCode.
- Replace Kev with local **Ollama Clef-Flash**, using the Router adapter's `/v1/systemone` decision contract. Retire the Kev Python/uv service and model-run assumptions during migration.
- Clef-Flash selects typed outcomes; it does not write code, generate explanations or summarize a session. The generative ModelProvider and `[compact] model` remain separate.
- Qualify managed handoff for **all three** selected native hosts. Unmanaged UI sessions remain manual; native compaction, abort, fork or a successful HTTP request alone do not prove a safe fresh-session transfer.
- Ship the complete selected scope together as **one v1.0**. API/model version pins are compatibility facts, not new bosun release milestones.

## 3. Constraints and evidence

The [owner decisions](README.md), [root resume](../../RESUME.md) and [roadmap](../plans/2026-10-01-bosun-v1.0-roadmap.md) still apply: no installs or personal configuration writes during this work, no Bun test suite, no inference on the hook, no model use of private data, no unknown-effect replay and no hidden model substitution. Existing explicitly selected role/host models remain selected.

Local checks: Codex CLI **0.160.0** exists; `opencode` and `ollama` are absent from this shell's PATH. No live host, Clef inference or resource benchmark ran. Existing measurements refer to the original Mac.

The official OpenCode repository's latest non-prerelease endpoint returned **v1.18.34**, published 2026-09-30. This revision uses that release's native v1 HTTP/server/plugin contracts as its inspection baseline. Separate `/v2/docs` describe different packages and hooks; do not mix those examples into a v1 adapter. Revalidate the chosen client/schema pair at implementation start. [Release](https://github.com/anomalyco/opencode/releases/tag/v1.18.34), [v1 server](https://opencode.ai/docs/server/), [v2 SDK](https://opencode.ai/v2/docs/build/sdk/).

## 4. Host choices and feasibility

| Native host | Selected integration | First-class acceptance | Remaining qualification |
|---|---|---|---|
| **OpenCode, primary** | Native HTTP server/OpenAPI and SSE; a thin local plugin for allowed context and lifecycle integration; attach its TUI to a managed backend | Roles/skills/MCP, explicit provider/model/variant, fenced jobs, review, memory, quota status, portable artifacts and managed fresh-session handoff | Exact usage semantics, completed-tool/turn boundary, prompt-admission fence during ownership transfer, idle destination seed and readiness acknowledgement, UI selection of the new session |
| **Codex** | Native CLI for bounded jobs; owned app-server for interactive session control/events | Same bosun workflow contracts, using native Codex configuration and supported login | Active occupancy, startup/tool isolation, ownership recovery and installed protocol compatibility; respect Orca's managed runtime home/hooks |
| **Claude Code** | Native CLI/streamed events and supported hooks/statusline; plugin wiring after the existing probe | Same bosun workflow contracts, using native Claude configuration and supported login | Compatible threshold/native-window behavior, quiescence, tool isolation and acknowledged fresh process/session; preserve existing statusline/config |
| Generic ACP agent | Additional AgentRunner, including an optional OpenCode ACP path | Declared common runner capabilities | ACP alone does not establish all OpenCode plugin/server/context controls; it is not the primary OpenCode integration |

OpenCode documents session creation/status/abort, messages, async prompts and SSE; its SDK supports context-only submission with `noReply`. These provide a plausible managed controller path. Codex documents app-server threads/events; Claude documents programmatic CLI streaming. This is a feasibility conclusion from documented surfaces, not a claim that bosun already provides parity. [OpenCode server](https://opencode.ai/docs/server/), [SDK](https://opencode.ai/docs/sdk/), [CLI attach](https://opencode.ai/docs/cli/#attach), [Codex app-server](https://learn.chatgpt.com/docs/app-server), [Claude programmatic CLI](https://code.claude.com/docs/en/headless).

Separate **host selection** from **model selection**. OpenCode running an OpenAI or Anthropic model uses OpenCode's harness; it is not native Codex or Claude Code. Native hosts may also act as explicitly selected workers/reviewers from an OpenCode-led workflow. Cross-host review selects a different provider when the task requires independent vendor review, not merely a different executable using the same provider. Hold unavailable selections; never substitute silently.

For model access inside OpenCode, its provider docs describe OpenAI ChatGPT login and API-key options. Availability still depends on account/model access. Claude Pro/Max credentials must not be imported into OpenCode: Anthropic's current credential rules reserve subscription OAuth for native applications and prohibit third-party credential intermediation. Use a separately configured supported Anthropic API/cloud provider in OpenCode, or delegate to the user's native Claude Code process without handling its tokens. Preserve bosun's existing local-first router/consolidation policy; this request changes the host architecture, not that inference policy. [OpenCode providers](https://opencode.ai/docs/providers/#openai), [Codex authentication](https://learn.chatgpt.com/docs/auth), [Anthropic credential rules](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use).

## 5. Clef-Flash evidence and migration

The [Ollama model card](https://ollama.com/library/clef-flash) describes a 9B decision model, requires **Ollama 0.35.1+**, and documents `/v1/systemone`. The [decision API](https://docs.ollama.com/capabilities/decision) returns typed choices/probabilities rather than a chat-completion answer. The model card says `confidence` measures distribution concentration, not probability of correctness. Its catalog and README disagree on maximum context; probe the loaded model instead of relying on either number. No vendor latency figure is a measurement on the owner's Mac.

The existing [router](../../lib/route.ts) already submits named `lane` and `risk` choice questions to `/v1/systemone`, but hardcodes `kev-latest`. [Defaults](../../config.default.env) reference a Kev training run, and [service setup](../../lib/services.ts) starts `uv ... python -m kev.serve`. Endpoint familiarity does not prove wire, calibration or lifecycle compatibility.

Proposed bosun TOML, **not accepted by v0.2**:

```toml
[hosts]
primary = "opencode"
enabled = ["opencode", "codex", "claude"]

[router]
provider = "ollama"
model = "clef-flash:9b"
base_url = "http://127.0.0.1:11434"
protocol = "systemone"

[compact]
enabled = true
model = "ollama:qwen3:8b"
threshold = 0.70
```

The enabled list describes supported profiles, not automatic installation/startup of all three clients. Host and model overrides remain explicit. Pin the actual Ollama/model digest in the implementation's dependency record after qualification; do not install or pull it during research.

Migration requirements:

1. Implement a dedicated **Router decision adapter**, separate from generative `ModelProvider.generate`. Preserve `scout/local/worker/main` and `high/low` outcomes; put the conservative main/high options first if tie ordering applies. Validate question names/types, finite probabilities/confidence and allowed outcomes; missing/malformed answers fail conservatively.
2. Keep deterministic risk/access fences authoritative. Clef scores are advisory; a score cannot authorize work or clear a known high-risk condition. Evaluate probability/concentration thresholds on held-out data; do not inherit Kev's `0.5` threshold or treat concentration as calibrated accuracy.
3. Run classification in explicit router/job/dispatch use cases outside hook/plugin callbacks. A thin hook/plugin may read a completed permitted decision or enqueue bounded work; it never waits for Clef, summarizes or adds synchronous remote dependencies. A missing/failing decision yields no new delegation hint and leaves work in the main thread.
4. Remove prompt-content route logs before new model calls. Private, secret-screened ineligible or unknown-scope inputs never reach Clef, including a local instance. Record only permitted content-free attempt metadata.
5. Replace `ROUTER_RUN`/Kev model discovery, doctor text, `/v1/models` assumptions, remote flags/proxy naming and service plans with Ollama decision capability/model readiness checks and provider-neutral `router` naming. Keep backed-up config migration/alias records; explicit legacy endpoints need a reported migration, not a guessed URL rewrite.
6. Retire the Kev/uv/Python service only through manifest-owned, reviewed migration operations. Reuse the configured Ollama service; keep one bosun daemon writer. A missing Ollama/model causes conservative routing, never an automatic download, paid fallback or model switch.

## 6. OpenCode integration design

Keep one compiled bosun binary and its daemon. The OpenCode server is an **external host process**, owned or attached through the native adapter, not a second bosun memory/job writer. Do not embed OpenCode's full SDK/harness into the core. Start or attach through an explicit managed-session action; per-prompt hooks must not auto-spawn services. OpenCode's loopback HTTP transport is an adapter-specific exception to bosun's own UDS contract; use its documented basic authentication, discover the selected endpoint and avoid public binding by default. [Server authentication](https://opencode.ai/docs/server/#authentication).

Use canonical `roles/` and `skills/` sources. Render OpenCode agents/permissions, supported commands and MCP registration into the selected project/managed profile, recording every applied write in the existing manifest. OpenCode discovers `.agents/skills`, so reuse canonical skill links rather than copying divergent instructions. Respect JSON/JSONC precedence and existing plugins/provider settings; no whole-config overwrite or global install during planning. [Agents](https://opencode.ai/docs/agents/), [skills](https://opencode.ai/docs/skills/), [config](https://opencode.ai/docs/config/), [MCP](https://opencode.ai/docs/mcp-servers/).

Extend containment to OpenCode's config/data/cache/state locations: set isolated HOME and XDG roots before child startup, constrain `OPENCODE_CONFIG`/`OPENCODE_CONFIG_DIR` and inline overrides to the test profile, and stub installers/network/process effects. A config overlay is not proof that inherited global agents/plugins/provider settings were excluded. Node-driven contract tests use stubs; no real host/model startup or dependency installation follows from a successful document check.

The inspected v1 plugin interface exposes `chat.message`, event callbacks and experimental message/system transforms. Native permissions and tool hooks help express role policy, but are not an OS sandbox. Keep hooks small; version-pin experimental surfaces and verify command/MCP and task-subagent bypass paths. Workspace/supervisor containment remains enforced independently. [Pinned plugin interface](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/plugin/src/index.ts), [permissions](https://opencode.ai/docs/permissions/).

For active occupancy, inspect the latest completed inference step/assistant message and its provider/model/cache breakdown; do not sum all session usage. The pinned native overflow code uses a request `tokens.total` or an input/output/cache sum and reserves model-specific headroom. Qualify which parts occupy the continuing context, including tool outputs and native resets; record native threshold separately from bosun's 0.70 denominator. Unknown/stale usage or an earlier native threshold makes automatic triggering unavailable for that profile. [Message schema](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/schema/src/v1/session.ts), [overflow calculation](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/session/overflow.ts).

For fresh handoff: fence source prompt admission, finish/reconcile outstanding tools, create a **new root session**, seed the validated artifact without inference (`noReply` candidate), verify idle state/content hash/model/permissions, acknowledge deterministically, transfer durable ownership, then allow task work and select/attach the destination. Treat no-reply seeding and UI switching as qualification candidates. If native admission control is insufficient, use a controller-owned ingress boundary for managed sessions; a prose instruction to wait is insufficient. Do not delete source history on transfer. Fork, resume and native compaction retain/rewrite history and are not equivalent to a fresh start.

The pinned v1 `experimental.session.compacting` hook changes native summary instructions, not the generator or a fresh-session reset. The v2 plugin API separately documents supplying a compaction result, but that still needs a version-matched adapter and does not by itself satisfy portable fresh handoff. Keep bosun's configurable summarizer/controller and native overflow recovery distinct. [Pinned v1 compaction](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/session/compaction.ts), [v2 hooks](https://opencode.ai/v2/docs/build/plugins/).

## 7. Open questions and defaults

No clarification blocks this plan revision. Default interpretation: **OpenCode primary, all three native hosts first-class in the same v1.0**, with per-host capability qualification. Preserve existing selected models; do not automatically buy API access, migrate credentials or start agents. The owner subsequently clarified that Graphify/CodeGraph are optional user-installed sources; missing installations or identities do not block development or release.

Live qualification still needs the installed OpenCode/Ollama versions and permitted fixtures. Current documentation establishes architectural feasibility, not complete handoff parity or measured Clef performance. Any failed required host gate needs a recorded resolution before the single ship decision; no silent deferral to another version.

## 8. Roadmap implications

1. Add OpenCode session/plugin/auth and Clef decision-schema probes to containment/capability work before implementation assumptions harden.
2. Implement native OpenCode first, then qualify Codex and Claude against the same host/runner contract suites. Keep ACP as an additional integration.
3. Replace the router service/config/remote lifecycle as well as the model string. Add an explicit no-Kev/Python-service acceptance check. Keep route privacy, risk and failure policy shared across hosts.
4. Extend handoff fixtures to all three managed hosts, including prompt admission, no-reply seed, native compaction races and destination UI/session selection. Keep retention/ownership recovery gates unchanged.
5. Add OpenCode manifest/config goldens, shared role/skill/MCP rendering, native-provider-aware review selection and per-host doctor results. Keep the Ink dashboard as an optional user entry within the selected build, backed by the same ledger as the primary OpenCode experience.

Allow a provisional **5–10 additional engineer-days** for the third native host, managed OpenCode ingress/UI qualification and Clef lifecycle/schema migration beyond already-funded common router/handoff evaluation. The revised integrated envelope is **85–135 days**, subject to early probes; no new performance claims. All selected work still ships in one v1.0.

## 9. Sources and validation boundary

Primary sources are linked beside their claims above, checked 2026-10-04. Local reads covered router/defaults/service/executor wiring and Codex version; remote reads covered the official OpenCode release/source and official host/model documentation. No app test, agent session, model inference, installation, authentication change or personal-config write ran. This revision supplements the eight completed research topics rather than rewriting their historical measurements.
