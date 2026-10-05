---
name: bosun-codex
description: Inspect or change bosun's Codex integration, including CLI execution, model configuration, skills, MCP, hooks, app-server sessions, and compaction capabilities. Use for Codex setup or adapter work, not every task performed inside Codex.
---

# Codex integration

Start with `RESUME.md` when present and inspect the integration code before proposing configuration changes. Establish the installed version with `codex --version` and the relevant command's `--help`; those checks do not start an agent. Fetch current official documentation for the feature and compare it with the installed version. Do not assume a hosted Codex tool is also a CLI feature.

## Repository map

- `lib/config.ts`: bosun paths, config precedence, model/effort parsing. Inspect path getters before any command that can write; even loading bosun config can create files.
- `lib/exec.ts`: CLI execution and cross-vendor review. Keep model selection, effort, sandbox, stdin, and persistence options explicit. Existing `--ephemeral` runs are not durable sessions for later resume.
- `lib/roles.ts`: rendered custom agents; verify the client's supported agent schema before extending it.
- `lib/wire.ts`: skills, rules, hooks, and MCP registration. Read it without running installation as a diagnostic.
- `test/helpers.ts` and `test/wire.test.ts`: isolated HOME and stub executables for offline wiring checks. Use Node only.

## Configuration and discovery

Inspect the active `CODEX_HOME` without printing credentials. In Orca it may be a managed home: bosun's convention is to wire rules/agents/MCP there but never overwrite Orca's managed `hooks.json`. Respect user, project, and managed settings; change the narrowest authorized scope.

Codex scans repository `.agents/skills` and user `~/.agents/skills`; bosun's canonical skill sources live in `skills/bosun-*`. Keep relative discovery links pointing to those sources instead of copying divergent instructions. See [Build skills](https://learn.chatgpt.com/docs/build-skills).

For models, consult `../bosun-openai-models/SKILL.md` when that skill is available; otherwise use [Models](https://learn.chatgpt.com/docs/models). Preserve explicitly requested models and verify client support for effort values. Read [Configuration Reference](https://learn.chatgpt.com/docs/config-file/config-reference) for exact keys, types, and defaults.

## Sessions and compaction

As checked on 2026-10-03, the [app-server reference](https://learn.chatgpt.com/docs/app-server) documents `thread/tokenUsage/updated` and `thread/compact/start`. The compaction call returns before completion; observe its `contextCompaction` item completion before treating it as finished. These are app-server protocol operations, not shell commands or evidence that bosun can control an arbitrary running session.

`model_auto_compact_token_limit` is a token threshold for native Codex compaction. It does not implement bosun's planned external summary model or a portable fresh-session handoff. Verify actual context usage semantics, available events, and thread ownership before designing an adapter. Do not equate cumulative billed tokens with current context occupancy.

For native resume, use an explicit session ID after checking installed help. For a summary-only fresh start, pass the handoff to a new session; resuming or forking existing history is not evidence of a context reset. Do not start duplicate executors while another session still owns active work.

Report the observed client/version, changed files, offline validation, and any feature requiring a live integration check. Installing bosun, trusting hooks, logging in, or altering global settings is a separate operation requiring the user's request.
