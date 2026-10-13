# Model baseline — checked 2026-10-03

Refresh official sources before model/config changes. These are candidate choices, not a promise that a particular account or client exposes them.
Repository path map updated 2026-10-10; model availability and API settings below retain the 2026-10-03 verification date.

| Exact model ID | Starting use case | Bosun interpretation |
|---|---|---|
| `gpt-6.1-sol` | Complex coding and sustained work with cost constraints | Candidate for main work and cross-vendor reviews |
| `gpt-6-astra` | The most demanding reasoning and multi-step work | Candidate for architecture and difficult investigations |
| `gpt-6-luna` | Focused, repeatable, high-volume work | Candidate for scouting, extraction, and specified edits |
| `gpt-6-sol` | Existing previous-generation Sol configurations | Preserve when selected; evaluate migration to 6.1 separately |

The first three recommendations follow the [API catalog](https://developers.openai.com/api/docs/models). The bosun column is a local recommendation to evaluate, not an official role mapping. [Codex/Work models](https://learn.chatgpt.com/docs/models) documents exact CLI IDs and rollout constraints. GPT-6.1 Sol and Luna are available in Work/Codex subject to access, rather than in ordinary Chat; check the current picker.

## Reasoning and tools

The [GPT-6.1 Sol API page](https://developers.openai.com/api/docs/models/gpt-6.1-sol) lists `low`, `medium` (API default), `high`, `xhigh`, and `max`; neither `none` nor `minimal` is supported. It requires Responses for tool calling; Chat Completions supports requests without tools. Recheck the corresponding model page for Astra or Luna instead of copying Sol's settings.

The Codex/Work UI can expose additional labels or settings, including Ultra depending on the client and access. Never copy `ultra` from a host tool schema into an API request without API support. Likewise, a host default may differ from the API default. Use the active tool schema/client as the authority for that surface.

Compare reasoning settings on the same task before increasing all roles to maximum effort. A model's advertised API context capacity does not prove the usable context or auto-compaction limit in Codex.

## Bosun model bindings

| Setting/source | Purpose | Current repository default |
|---|---|---|
| `ROLE_ARCHITECT_CODEX` | Rendered architect subagent | `gpt-6-astra:high` |
| `ROLE_SCOUT_CODEX` | Rendered scout | `gpt-6-luna:low` |
| `ROLE_WORKER_CODEX`, `ROLE_TESTER_CODEX`, `ROLE_DEBUGGER_CODEX`, `ROLE_REVIEWER_CODEX` | Rendered role subagents | `gpt-6-luna:high` |
| `REVIEW_BY_CODEX` | Cross-vendor `bosun review` from Claude | `gpt-6-sol:high` |
| `WORKER_BY_CODEX` | `bosun run -e codex` | `gpt-6-luna:high` |
| Main session | Owned by the host's model selection | No bosun setting |

The role defaults are defined in `src/core/domain/config.ts`. `src/platform/config.ts` reads `BOSUN_HOME/config.toml` and the documented environment overrides; `src/app/native-runners.ts` selects the host runner, and each host adapter renders its own model and effort arguments. Inspect those files and the selected adapter before changing a binding. Preserve explicit TOML and environment choices. A documented upstream model ID still does not prove access in the installed client.

Example candidate for a requested review upgrade: `REVIEW_BY_CODEX=gpt-6.1-sol:high`. This reference does not apply that change. Existing Sonnet-only research instructions remain explicit choices.

## Access, cost, and refreshing

[Work/Codex pricing](https://learn.chatgpt.com/docs/pricing) distinguishes subscription usage from API billing. Work and Codex share usage; moving between them is not an independent quota fallback. Verify account access in the target client before relying on a model.

For current prices, use the exact API model page or the Work/Codex pricing page for the surface in question. Include the date and relevant tier/context conditions. Do not maintain a price constant in a routing skill.

On refresh, record the checked date and direct source URLs, verify exact IDs and effort support, then update only affected recommendations. Leave unavailable or undocumented behavior explicitly unresolved.
