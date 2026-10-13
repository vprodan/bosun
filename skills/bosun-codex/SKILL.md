---
name: bosun-codex
description: Inspect or change bosun's Codex integration, including CLI execution, model configuration, skills, MCP, hooks, app-server sessions, and compaction capabilities. Use for Codex setup or adapter work, not every task performed inside Codex.
---

# Codex integration

Start with `RESUME.md` and `HANDOFF.md` when present and inspect the final integration before changing configuration. Respect saved authorization limits: if native calls are prohibited, read installed package metadata or existing source/help fixtures and report version qualification as incomplete. Otherwise establish the selected CLI version and relevant help without starting an agent. Fetch current official documentation and compare it with that version. A hosted Codex tool does not establish CLI support.

## Repository map

- `src/app/native-runners.ts` and `src/platform/config.ts`: lazy native selection, configuration precedence and explicit model/effort bindings.
- `src/adapters/hosts/codex/runner.ts`, `client.ts` and `quota-source.ts`: CLI execution, app-server protocol and native account quota evidence. Ephemeral jobs are not durable managed sessions.
- `src/adapters/hosts/codex/control.ts`, `rollout.ts` and `evidence.ts`: owned fresh roots, inference-free injection, independent private seed readback, original turns and bounded public capture. `src/app/managed.ts` binds these to existing jobs and durable authority; process loss and restart stay held without replay.
- `src/adapters/hosts/codex/host.ts`: version-bound role/skill/MCP profile rendering and literal native arguments. Read-only sandbox configuration still requires tool/MCP/plugin qualification.
- `src/app/host-install.ts` and `src/platform/manifest.ts`: reviewable owner plans, manifest-owned generated profiles and exact checked undo. The old global wire installer has been removed; these version-bound plans are the final setup path.
- `src/app/host-launch.ts`: explicit foreground native launch with reviewed receipt/hash, profile/workspace rechecks and exact native-version inspection. Preview starts no process; this does not establish managed-session controls.
- `src/core/use-cases/handoff.ts` and `src/core/ports/host.ts`: durable ownership transfer and qualified managed-control requirements.
- `test/host-installation.test.ts`, `test/native-runners.test.ts` and `test/quota.test.ts`: isolated profile, native-protocol and admission checks. Use guarded Node only.

## Configuration and discovery

Inspect the selected `CODEX_HOME` without printing credentials. In Orca it may be a managed home. Generated profiles use scoped native arguments and repository skill links; keep native login and personal configuration with the selected client, and never overwrite Orca's managed `hooks.json`. Respect user, project and managed settings.

`bosun host plan codex --native-version <version> --request-id <id> --workspace <repository> --output <file>` prepares an immutable plan without writes to host settings. Review its model bindings, file/link changes, native arguments and hash before `bosun host apply <file> --hash <hash>`. Apply requires the prepared runtime's daemon authority to be free. It installs missing repository `.agents/skills` links to the canonical generated skills, reuses matching user skills without owning them, and preserves the user's enablement overrides. `bosun host status <id>` inspects the saved receipt and file hashes. `bosun host launch <id> --version <receipt-version> --hash <plan-hash> --preview` inspects the literal launch recipe without invoking Codex or reading auth. Omitting `--preview` explicitly starts the foreground native UI after an exact version check and repeated profile/workspace checks, preserving the selected native home and model precedence. Close sessions using a profile before `bosun host undo <id> --version <version>` removes matching owned links and retires it. Drift and uncertain receipts require inspection. Apply starts no host, installs no dependency and trusts no hook. Native hooks, plugin trust and automatic controls remain separately qualified; saved restrictions can prohibit actual host launch during development.

The renderer currently pins the0.161.0 config-layer profile. Tagged0.161.0 agent-role, stdio MCP, sandbox, exec-event and managed thread/seed shapes were compared with0.160.0 before updating the adapter. Read-only installed package metadata identifies0.161.0; actual role/skill/MCP and automatic-control qualification remains separate. Current [subagent guidance](https://learn.chatgpt.com/docs/agent-configuration/subagents) and the [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) describe different registration forms. Match the selected client before activation or adding another profile version.

Codex scans repository `.agents/skills` and user `~/.agents/skills`; bosun's canonical skill sources live in `skills/bosun-*`. Keep relative discovery links pointing to those sources instead of copying divergent instructions. See [Build skills](https://learn.chatgpt.com/docs/build-skills).

For models, consult `../bosun-openai-models/SKILL.md` when that skill is available; otherwise use [Models](https://learn.chatgpt.com/docs/models). Preserve explicitly requested models and verify client support for effort values. Read [Configuration Reference](https://learn.chatgpt.com/docs/config-file/config-reference) for exact keys, types, and defaults.

## Sessions and compaction

As checked on 2026-10-03, the [app-server reference](https://learn.chatgpt.com/docs/app-server) documents `thread/tokenUsage/updated` and `thread/compact/start`. The compaction call returns before completion; observe its `contextCompaction` item completion before treating it as finished. These are app-server protocol operations, not shell commands or evidence that bosun can control an arbitrary running session.

`model_auto_compact_token_limit` is a token threshold for native Codex compaction. It does not implement bosun's planned external summary model or a portable fresh-session handoff. Verify actual context usage semantics, available events, and thread ownership before designing an adapter. Do not equate cumulative billed tokens with current context occupancy.

For native resume, use an explicit session ID after checking installed help. For a summary-only fresh start, pass the handoff to a new session; resuming or forking existing history is not evidence of a context reset. Do not start duplicate executors while another session still owns active work.

Owned managed startup uses `bosun managed start --host codex --model <exact-id> --seed-file <public-file> --request-id <id> --public` against the existing daemon. The driver currently pins0.161.0; read-only startup is held before discovery. It injects one public assistant seed and checks the exact returned fresh private transcript before activation. Capture omits tool payloads and reasoning. All six production automatic-control flags and current-step occupancy remain unverified; successful fixture composition is not native qualification or control of an existing UI. Check [tagged protocol provenance](../../test/fixtures/native-protocol-provenance.md) and current authorization before native probes, seeding or execution.

Report the observed client/version, changed files, offline validation, and any feature requiring a live integration check. Installing bosun, trusting hooks, logging in, or altering global settings is a separate operation requiring the user's request.
