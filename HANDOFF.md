# Handoff: bosun

Current guidance after the owner-authorized housekeeping, code cleanup and local commit amendment (2026-10-13). Read this file and [RESUME.md](RESUME.md) before continuing. Follow the current user request; archived prompts and older restrictions are historical where superseded here. Transfer the committed source plus ignored native/build inputs and retained recovery artifacts separately.

## Current scope and permissions

- Package version is **1.0.0**; **OMP is primary for new configuration**, with OpenCode 2, Codex and Claude Code retained. Preserve explicit host/model/effort/cwd/access selections.
- The owner authorized complete repository housekeeping and code cleanup, preservation and identical reapplication of the retained stash, canonical asset reconciliation, and a **fresh local artifact rebuild and guarded requalification**. This supersedes the older “no cleanup/removal workstream” instructions, including those still present in dated plans.
- The owner explicitly approved staging reviewed files and one local commit of the cleaned 1.0.0 repository to leave Git clean; no push or history rewriting. Use existing **Bun 1.4.3 on macOS arm64 only**. No Node runtime/fallback, dependency/runtime/host/model installs, live host/model/service calls, personal configuration/auth/database/LaunchAgent changes or publication. Native Node-API compatibility and reviewed Node headers are build inputs, not permission to execute Node.
- The coordinator owns artifact cleanup, stash integration, source/asset integration and final verification. Workers do not run tests/builds/linters during edits. Fresh local rebuild permission does not execute old pending compiled/corpus proposals or authorize live qualification.

Final precommit verification: **1,190/1,190 tests across 94 guarded files**, zero failures, plus **35/35 containment**. [Full log](docs/research/checkpoints/2026-10-13-clean-repo-full-bun.log). Inclusion review found no credential/runtime-artifact blockers. Release review found `install.sh` still invoked Node: fixed to Bun with `--no-env-file --no-install`; its actual `--help` path exited0 under an OS barrier in a disposable home. No installation ran. This wrapper is outside the compiled artifact inventory, so the cleanup binary and existing safety receipt remain unchanged. Local commit hooks/signing are disabled per invocation to avoid unauthorized personal hooks/authentication effects; no personal Git configuration changes.

## Restore and transfer safeguards

Retain stash **`b830c5c24baa84d5b30895598cfaf94bb2d7205d`**. The external `RESTORE.txt` records that its tracked/indexed changes and **917 untracked files** were reapplied and retained, with diff/status/untracked hashes identical. Do not reapply it over the cleaned checkout, pop/drop it, replace it with a new stash or overwrite newer edits. Git stash objects are local and are not transferred by ordinary push/clone; copy the relevant Git objects as well as the working tree when moving machines.

For a **separately requested recovery**, follow the external restore instructions: create an isolated worktree at the stash's first parent and apply the exact object there with its original index state. This recipe is not permission to perform new Git effects during cleanup:

```sh
git worktree add --detach /absolute/path/to/isolated-recovery b830c5c24baa84d5b30895598cfaf94bb2d7205d^1
git -C /absolute/path/to/isolated-recovery stash apply --index b830c5c24baa84d5b30895598cfaf94bb2d7205d
```

Any conflict requires reconciliation against the retained original, not forced checkout/reset or loss of owner changes.

Ignored artifacts were backed up outside the repository to:

```text
/Users/edge/Developer/bosun-cleanup-backups/b830c5c24baa84d5b30895598cfaf94bb2d7205d/ignored-artifacts.tar.gz
```

The coordinator's pre-cleanup backup inventory verified **24,635 files**, with archive SHA256 **`4d3f491553adf6f892d7a5c8969073e707584f1a50e10390424f5993e648a584`**. Companion `RESTORE.txt` records exact recovery steps; macOS AppleDouble metadata was excluded from the content comparison. `node_modules` remains in the checkout and is **not archived**. Keep the external backup and inventories/receipts; they are not transferred by Git or by the stash. Copy them separately when moving machines. Inspect archive paths before extracting into the isolated recovery worktree prepared above:

```sh
tar -tzf /Users/edge/Developer/bosun-cleanup-backups/b830c5c24baa84d5b30895598cfaf94bb2d7205d/ignored-artifacts.tar.gz
tar -xzf /Users/edge/Developer/bosun-cleanup-backups/b830c5c24baa84d5b30895598cfaf94bb2d7205d/ignored-artifacts.tar.gz -C /absolute/path/to/isolated-recovery
```

Do not extract over the live checkout or personal runtime, or reinstate obsolete generated outputs automatically.

The coordinator removed ten old 0.2 distribution directories and four formula candidates, and backed up disposable native build/upstream trees. The original 1.0 release, selected native candidate/archives/receipt, LSP tooling and `node_modules` were retained. The proven orphan `scripts/check-bun-prerequisites.mjs` was removed; canonical handoff wording and generated assets were reconciled. No historical shared diagnostic helper was removed merely because its filename looked old.

## Fresh cleanup artifact

The coordinator built **`dist/bosun-1.0.0-darwin-arm64-cleanup/`** from the cleaned candidate:

| Fresh build output | SHA256 |
| --- | --- |
| Binary | `d64cf0b87f7e414dec97dade5ab12a05bd494e05b75a964fd565c38374a9e0f4` |
| Archive | `573d45a151c3b3ded1a6e4c6231cb0499c4b856110306ca9df4ceafe5d5a9a80` |

Coordinator verification **passed**: selected **13/13 guarded source suite files**, zero failed (not a rerun of the historical full 91-file suite); **35/35 containment**; typecheck; boundaries **250 files / 1,359 edges / zero violations**; fresh static source/artifact verification; actual compiled version/help/private hook/private route/MCP; seven storage/privacy RPCs; shutdown/owner-lock reacquisition; and **10,000 notes / 21 hook injections**, with all original/group producers joined. No live hosts/models or personal runtime were used. These qualify the fresh candidate's exercised local minimum-safety scope, not complete production readiness. Static `runtimeQualification: unverified` remains appropriate.

The [cleanup qualification receipt](docs/research/checkpoints/2026-10-13-cleanup-qualification.json) binds these exercised checks to the fresh binary, archive and source digest.

Reported disk usage fell from **1.1G to 236M** for `dist/` and **733M to 53M** for `.omp/tooling/`; both original and cleaned 1.0 artifacts remain.

## Local 1.0.0 release shipped (2026-10-13)

The retained original macOS arm64 local release is `dist/bosun-1.0.0-darwin-arm64/`, containing `bosun`, `bosun-1.0.0-darwin-arm64.tar.gz`, `build.json` and `SHA256SUMS`.

| Historical input | SHA256 |
| --- | --- |
| Local release binary | `96f3e05a1c677888bac2b928f258baacce2a56571b1c01f38f69768f1b6801a9` |
| Local release archive | `40aa844643f03fae467494dfc0583031981d866c97b50e6388eff31e58d6df0c` |

The previous contained release checker exercised actual compiled startup/help/private hooks/MCP, setup, seven storage/privacy RPCs, shutdown and owner-lock reacquisition, and 10,000-note public-view delivery with 21 verified hook injections and original/group joins. Hosts/models stayed inert; only owned local RPC sockets were admitted. Historical evidence under `docs/research/checkpoints/`:

- `2026-10-13-v1-release-build.log`
- `2026-10-13-v1-release-qualified-runtime.log`
- `2026-10-13-v1-release-static.log`
- `2026-10-13-v1-release-final-typecheck.log`
- `2026-10-13-v1-release-qualified-source.log`

The hashes and receipts in this historical section identify **the pre-cleanup artifact**, not the fresh rebuild above. Use each selected candidate's own `SHA256SUMS`, `build.json` and matching verification receipts. Minimum-safety evidence must not be promoted to full qualification.

## Native SQLite library admission (2026-10-13)

All application callers use `src/platform/sqlite.ts`, owning the reviewed **`better-sqlite3@13.0.3`** Node-API fork. The maintained patch is `patches/better-sqlite3@13.0.3.patch`, historical SHA256 `e1020d35775b701e8c186e0b5073a74b06232ec05f2f90fc99e2d79752007fbf`. Its admitted native filename is **`bosun_sqlite.node`**: Bun 1.4.3 rejects the upstream historical filename before dlopen. Node 22.16.0 headers were build inputs only.

Two fresh sandboxed native builds previously produced identical **1,939,312-byte** binaries, SHA256 `554a3ad6a9b55b8c91af529d7832c7c52605511c32a2833f352166a136046c1d`. `scripts/sqlite-native-inputs.mjs` binds reviewed archives, patch, source, toolchain and native output; changed bytes/toolchains require review and requalification. Existing build inputs are not permission for new acquisition/install.

Preserve owned-statement/backup finalization, retained-cursor invalidation, unfinished-FTS rollback, UDF/authorizer/error identity, exact integer/blob handling, URI/extension/defensive controls and online backup. Cleanup retains original errors and literal destination whitespace. No GC/private-pointer workaround, `node:sqlite`/Node fallback or weakened floor/lease/poisoned-writer assertions.

`src/platform/canonical-path.cjs` resolves metadata/components/links **without opening the database inode**. Ordinary Bun `realpathSync(database)` was observed releasing a cross-process POSIX read lock; fresh symlink/inode checks and metadata-only canonicalization are required. Do not replace them with identity caches.

Historical native/source evidence includes `2026-10-13-sqlite-library-{backup-edges-probe,backup-edges-build,reproducible-rebuild,storage-final-qualification,layered-final-source,layered-final-typecheck,installed-final-probe,portable-prepare,layered-source-capture,source-benchmark-metadata-after}.log`. It records 196/196 storage tests plus 35/35 containment, then 1,179/1,179 integrated source tests across 91 files plus containment and typecheck, and the original 10k source-hook/producer-join contract. These are previous candidate receipts, not fresh cleanup qualification.

## Deferred gates and safety boundaries

Real-model quality/Clef calibration, physical vector support and budgets, native four-host controls/tool isolation/readiness/retention/UI switching, designated-machine performance, broader compiled reproducibility, live second-machine deployment and personal installation/launchd/TCC remain deferred and separately permission-gated. Unverified automatic controls stay held; synthetic/source success never promotes them. The future one-clean-final-commit goal is not permission to commit now.

Preserve original privacy/scope/IDs/versions/hashes/audit, public-only inference screening and derivative invalidation. One daemon owns the prepared home; reads/startup do not initialize or repair unknown layouts. Lost native/COMMIT/transfer effects remain durable **unknown** with original receipts and **no replay**. Hooks remain lean, read-only and inference-free; producer-owned leases survive uncertain writes until proven OS teardown. Preserve explicit models without fallback or credential borrowing.

## Preserved history

- [Exact original HANDOFF.md](docs/research/archive/2026-10-13-handoff-pre-cleanup.md)
- [Exact original RESUME.md](docs/research/archive/2026-10-13-resume-pre-cleanup.md)

Both archives retain the full originals without rewriting their dated history. Their relative links were authored at the repository root: interpret `docs/...`, `src/...`, `test/...` and other relative paths **from the repository root**, not from `docs/research/archive/`. Historical instructions, proposals, version freezes, host choices and old process handles are evidence, not current authorization.
