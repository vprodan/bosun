# Resume bosun

Read [HANDOFF.md](HANDOFF.md) for current cleanup/rebuild evidence, permissions, native SQLite pins and recovery instructions. This concise guide replaces the accumulated root history without discarding it.

## Resume prompt

```text
Read RESUME.md, HANDOFF.md, AGENTS.md, ARCHITECTURE.md and CONTRIBUTING.md.
Follow the current user request. Package version is 1.0.0; OMP is primary, with
OpenCode 2, Codex and Claude Code retained. Preserve explicit models and all
privacy/audit/SQLite/unknown-nonreplay invariants. Complete housekeeping and code
cleanup, identical retained-stash reapplication, asset reconciliation and a fresh
local rebuild/requalification were authorized; the coordinator's completion
receipts are in HANDOFF.md. Do not restart older research prompts, workers or
compiled/corpus proposals. Bun 1.4.3/macOS arm64 only; no installs, live calls,
personal-state changes, history rewriting or publication. The owner explicitly
authorized one local commit of the cleaned 1.0.0 repository; do not push.
Transfer committed source, retained stash Git objects and ignored native/build
inputs plus the external artifact backup, not just HEAD or this summary.
Reconcile current state before attempting recovery or launching more work.
```

## Current checkpoint

The cleaned artifact is **`dist/bosun-1.0.0-darwin-arm64-cleanup/`**; the original release is retained. Final precommit verification passed **1,190/1,190 tests across 94 guarded files** and **35/35 containment**. Cleanup typecheck, boundaries (250 files / 1,359 edges / zero violations), static source/artifact and actual compiled storage/privacy, shutdown/reacquisition and 10,000-note/21-hook checks passed. The source installer wrapper uses Bun; its help path exited0 under OS containment without installation. Exact hashes and full test log are in HANDOFF.

The pinned `better-sqlite3@13.0.3` maintained Node-API fork owns SQLite through `src/platform/sqlite.ts`; old `node:sqlite` close holds are historical, not the selected backend. Bun remains the sole runtime. Minimum local safety is not complete live/native-host/model-quality/designated-machine/reproducibility qualification; unverified automatic controls remain held.

## Portable recovery state

- Retained stash: **`b830c5c24baa84d5b30895598cfaf94bb2d7205d`**. The external restore record says tracked/indexed changes and 917 untracked files were reapplied identically and the stash retained. **Do not reapply over the cleaned checkout or pop/drop it.** Transfer its Git objects separately; ordinary push/clone does not move stashes.
- External backup: **`/Users/edge/Developer/bosun-cleanup-backups/b830c5c24baa84d5b30895598cfaf94bb2d7205d/ignored-artifacts.tar.gz`**, verified 24,635 files, SHA256 **`4d3f491553adf6f892d7a5c8969073e707584f1a50e10390424f5993e648a584`**. Copy its sibling `RESTORE.txt` and inventories/receipts too. It includes original `dist/` and `.omp/tooling/`; retained `node_modules` is not archived.
- Recovery is a separately requested operation in an isolated worktree at the stash's first parent, not an overlay of newer edits. HANDOFF and external `RESTORE.txt` give the exact commands.
- The owner approved a local commit of reviewed source, tests, tooling configuration, locks and evidence. Ignored native inputs/candidate/receipt, release assets and project-local LSP binaries remain separate transfer inputs. Branch/HEAD and process handles in archived history are old observations; reconcile them on the destination rather than treating them as current.

## Navigation and owner preferences

| Document | Purpose |
| --- | --- |
| [HANDOFF.md](HANDOFF.md) | Current permissions, exact local-release/native anchors, cleanup evidence and safe recovery |
| [README.md](README.md) / [ARCHITECTURE.md](ARCHITECTURE.md) / [CONTRIBUTING.md](CONTRIBUTING.md) / [AGENTS.md](AGENTS.md) | Product usage, source boundaries, extension/check patterns and agent rules |
| [Research index](docs/research/README.md) | Original vision and accepted owner answers; research topics 1–8 are complete |
| [Research resume](docs/research/RESUME.md) | Completed research status and historical research prompts |
| [Roadmap](docs/plans/2026-10-01-bosun-v1.0-roadmap.md) / [implementation ledger](docs/plans/2026-10-04-bosun-v1.0-implementation-ledger.md) / [direct-delivery plan](docs/plans/2026-10-06-bosun-v1.0-direct-delivery.md) | Accepted scope and dated development evidence; current housekeeping/local-release amendments supersede stale cleanup/version restrictions |
| [Historical OpenCode/Clef reasoning](docs/research/09-opencode-clef.md) | Design rationale, not current OpenCode-primary or V1 host selection |

Keep defaults boring and explicit; no speculative abstractions or silent model substitution. “Continue” does not authorize installs, model pulls, personal configuration changes or live services. Native authentication stays with its host. Claude-mem stays external/read-only; Graphify/CodeGraph remain optional user-installed tools. Inside Orca, managed `CODEX_HOME` is host-owned; do not modify its `hooks.json`. Use the mandatory contained Bun launcher, never direct `bun test` or a Node fallback. The original Node-only/Bun-test prohibition was superseded only by this guarded Bun policy.

Original-Mac measurements in research topics 1–5 refer to the **M5 Pro**, not whichever machine resumes this work. Original-Mac 2026-10-01 personal-runtime pollution was restored/quarantined under `~/bosun-quarantine-20261001/`; its overwritten original `~/.bosun/config.env` was lost. The owner-requested Claude effort change (`xhigh` to `high`, including the `claude-opus-5-5` override) has historical backup `~/bosun-quarantine-20261001/claude/settings.json.before-effort-high`. These are historical recovery facts, not permission to inspect/change personal state or delete quarantine. Suggested model/provider changes in the history were not applied and must not be inferred as current selections.

## Exact preserved originals

- [Full pre-cleanup HANDOFF.md](docs/research/archive/2026-10-13-handoff-pre-cleanup.md)
- [Full pre-cleanup RESUME.md](docs/research/archive/2026-10-13-resume-pre-cleanup.md)

The archives are unchanged full originals. Their links were written relative to the **repository root**; resolve `docs/...`, `src/...`, `test/...` and other relative paths from that original location, not from the archive directory. Old prompts, failed logs, superseded decisions and process IDs remain evidence only; they do not grant current execution permission.
