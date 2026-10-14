# Maintenance and recovery

Current guidance after the owner-authorized housekeeping, code cleanup and local commit amendment (2026-10-13). Read this file and [AGENTS.md](../AGENTS.md) before continuing. Follow the current user request; archived prompts and older restrictions are historical where superseded here. Transfer the committed source plus ignored native/build inputs and retained recovery artifacts separately.

## Background service defect (2026-10-15)

The owner’s other-machine1.0.4 installation was intact, but its owned launchd job had no PID and LastExitStatus512 in the correct UID/Aqua context. The generated ProgramArguments contained only `bosun daemon`, whereas the actual CLI requires `bosun daemon run`. This is a product defect: prior service fixtures bypassed CLI parsing and hardcoded the same incorrect argument. Source now generates the complete command; the synthetic launchd fixture reads every generated argument and invokes the actual CLI, retaining native readiness/ownership/privacy/CAS/unknown-receipt assertions. Typecheck and36 containment passed; CLI/wizard/installation cases passed, and all18 service cases passed with actual CLI start/stop/reconciliation. An initial full-entry readiness observer incorrectly watched process.stdout rather than the entry’s separate fd stream; it was replaced by the CLI’s explicit output seam. No live personal launchd activation or fixed release publication has occurred.

Existing1.0.4 receipts/plists must not be edited or overwritten: service text/hash is bound to the original plan. A loaded failed original job cannot reconcile as enabled. Owner-directed recovery must first stop exactly the receipt-bound launchd label, then use the original1.0.4 executable to reconcile the original operation against native absence and released authority. Read the new status/version before any undo; retain data, backup and receipts. A new generator changes expected plan text, so a new executable must not be substituted for original receipt recovery. Do not replay bootstrap or reinstall over unknown state. Fixed source does not repair already published assets.

The owner requested stable minor-family admission and publication of both fixes. Source1.0.5 admits canonical stable0.35.x/0.40.x (including0.40.4); uninspected minor/major families and suffix builds remain held. The0.40 MLX/selected-manifest branch uses the same family gate; capability/digest/residency checks and actual version/minimum-model-version reporting remain intact. Assets/typecheck/36 containment and all9 affected source files passed, including actual CLI service lifecycle and preserved unknown/nonreplay behavior. Fresh compiled static verification and eight safety paths passed. Contained compiled CLI smoke used synthetic0.40.4 metadata and reported cold/model_unloaded, while0.41.0 and0.40.4-rc1 held without inference. Generated plist arguments started the compiled foreground-admitted daemon; full service enabling was exercised through the synthetic launchd seam, not personal launchd. An attempted direct deployment smoke correctly held a prepared receipt; no receipt was forged. A verified original published1.0.4 executable installed/stored a note, performed its own reviewed undo, then1.0.5 installed into that ready home with byte-identical config and memory DB; prior receipt remained retained. Publication still requires hosted CI/CD and downloaded-byte verification.

## Guided installation (2026-10-14)

The owner requested simple installation/use after a generic setup failure. Source1.0.2 adds explicit terminal `bosun install`: approved new-home preparation, readable review and separate replacement approval, internal exact plan/hash application, and an optional separately approved owned-service start. Existing configuration/model selections and unknown receipts are retained; unsafe/legacy/incomplete layouts hold without repair or replay. Noninteractive/model callers cannot silently install. Advanced plan/apply remains available.

An actual compiled terminal smoke approved preparation/install and declined service start; the user-local executable and ready dormant receipt were created only inside disposable OS-contained HOME. Terminal cancellation left the home absent; an unsafe0755 home held unchanged; a ready repeat retained config/installation and asked only about service start; noninteractive entry refused. Optional native start is covered by the existing synthetic launchd seam, not a live personal service.

Typecheck and36 containment probes passed. Guided installer, CLI, installation, runtime, boundaries and lint suites passed; a new service privacy assertion initially used the wrong RPC result shape, then all18 service cases passed after correcting it. Source1.0.2 release still requires hosted qualification/publication. The previous onboarding push's full CI hit an existing120s10k benchmark timeout, not an onboarding assertion; do not claim that run green or weaken its benchmark checks.

Fresh compiled1.0.2 safety passed version/help/private-hook/private-route/MCP, seven storage/privacy requests, shutdown/reacquisition and10000-note/21-hook delivery with all producers joined. Local binary SHA256 `595a250827c52dee55049ad2ec2d00d416cec65b8c5e59a385b18aa58c300e0f` is local smoke evidence, not a hosted release hash.

Guided source CI run38603440425 passed94/95 files but the same explicit10k test hit Bun's120s default watchdog on the slower hosted runner. That diagnostic asserts measured samples/privacy/20 hook deliveries, not a120s SLA. Its test-only timeout is now600s; corpus, writer protections, hook producer deadlines and all assertions remain unchanged. Typecheck and both full benchmark suites passed locally (23 cases, including actual10000-note/20-hook source delivery in51.8s). Hosted qualification remains required before release; no retry-to-green or skipped workload.

Hosted run38606367891 completed the unchanged10k corpus and20/20 verified source hook deliveries in148.3s, confirming the prior watchdog was too short; its wizard/service checks passed. Two other synthetic fixture files failed: Claude initialization used the40ms negative-read deadline, and relay closure remained unconfirmed within its500ms termination grace. The Claude cases now use their existing500ms fixture budget; the diagnostic fixture explicitly uses2000ms timeout/grace and still requires actual original/group closure and negative unknown outcomes. Production timeout/grace and join semantics are unchanged. Both affected suites passed23/23 locally with typecheck and36 containment.

Source CI38609948477 passed95/95 files,36 containment, typecheck and zero architecture violations at670beb97a043b60814ee1c1675f9c7d794ec8a8c. Immutable v1.0.2 CD38612376770 again passed all source checks, built/verified the binary, and passed compiled version/help/private-hook/private-route/MCP/seven storage-privacy requests/shutdown-reacquisition. The public-hook diagnostic had no successful exit at its120s watchdog (`code:null`; completion assertion failed); no publication step ran. Source10k workloads had already taken148–172s on hosted machines, with every assertion passing. Source1.0.3 now gives this qualification-only compiled diagnostic the same600s finite budget, retaining10000 notes/21 hook deliveries, no-model/privacy and positive group completion assertions. No tag is moved, failed run is retried, corpus is reduced or production deadline changed. New version requires fresh qualification and publication.

Corrected1.0.3 passed local assets/typecheck/36 containment and all50 CLI/wizard/installation/service cases. A fresh build from the already-installed qualified Bun passed static verification and the actual compiled eight-path safety checker, including10000-note/21-hook delivery and original/group completion. Local binary SHA256 `2493d2293ec6346e95d896238c9e942c5ba953d0784e6dfb8bba23c07ee467f1`, archive SHA256 `600bf7bcaf20f919e984d9116cb1d61760ad61075df221449c9a25ca4d1aaaad`; static qualification metadata remains unverified. These are local evidence, not publication hashes.

Published **v1.0.3** at2026-10-14T19:06:30Z from `d92d7d05d20eb9695f85710cd508bd2d20e077fc`: source CI38615878039 and CD38618206034 passed all95 source test files,36 containment, typecheck/boundaries, fresh compiled eight-path safety and least-privilege verified publication. ZIP SHA256 `3bc2189160fe515e40f0c7fa30136d1c4df51cb46739c915392baa6d45cb8374`; binary SHA256 `272921f41f73fbe61f27118f786a4081db792da5f2eb2495c15f604a3beabd0c`. The downloaded four assets passed the publication verifier and extracted checksums. Its ZIP contains `INSTALL.md`. Actual downloaded-byte terminal smoke passed approved fresh installation with exact installed bytes, optional service decline, foreground readiness plus public-note storage/search, cancellation without preparation, unchanged0755 hold, and ready-home repeat with byte-identical configuration/receipt and no reinstall. All original/groups joined; no live hosts/models or personal activation were exercised. Full qualification stays unverified.

One local throwaway terminal profile initially caused `EPERM` at hardlink publication because stage and destination had different sandbox execution policies. An app-free native file probe reproduced the policy mismatch; admitting the owned bin directory uniformly fixed the fixture while preserving external executable/network denial. The original synthetic unknown receipts were not replayed. No product fix or weakened installer assertion was needed; disposable instrumentation was removed before publication. Restore stash/external backup and prior release assets remain untouched.

Post-publication documentation-only CI38621907107 atf0990e2ad4f0f9bf5c1df9f3d35182ade466e1ea passed94/95 files; the import-only diagnostic fixture withheld relay join. Phase-specific native sampling reproduced the same early unavailable outcome and observed actual group `SIGKILL` returning `EPERM` while closure was settling, before any grace timeout. Increasing fixture grace alone had not fixed this path. Source1.0.4 now keeps denial unconfirmed and waits for positive native group absence within the existing grace; live/persistent denial still fails unavailable, and no kill or business request is replayed. LSP mapped58 shared process consumers; interfaces/callers and all production limits remain unchanged. Real-process regressions failed before/passed after for settling denial and verify persistent denial leaves a live descendant unjoined. A disposable1000-bound-output sample then joined every actual original/group; its stress loop and diagnostic instrumentation were removed. Existing1.0.3 assets/tags remain unchanged; new patch publication requires fresh qualification.

Cleaned1.0.4 passed regenerated assets, typecheck,36 containment and all17 affected source test files (native/runtime/diagnostic/host/installer/service/boundary/lint coverage). Fresh compiled static verification and all eight safety paths passed, including10000-note/21-hook delivery and positive original/group joins. Local binary SHA256 `81cdcab84d0be84cc3e7bf86d4c9c14805d5e6766fb360cf75e84f8d83059495`, archive SHA256 `ad2cf9b1d8dafe6afd556c13903ecd5a599a90528aec9a4bf16914e9ed97ed46`; these are local evidence, not published hashes. Full/live/model qualification remains unverified.

Published **v1.0.4** from `ffbc3a8ee306e7b7635822202c5044f302240cb9`: full source CI38632607878 and CD38635207073 passed, including fresh compiled safety and verified publication. Downloaded assets passed the publication verifier and extracted checksums. ZIP SHA256 `77ba8e98af5967abc8ab9560b8bd76e57c9c32036c5171986d47d2f0f7d5a9a0`; binary SHA256 `5a6c0408481684d33a7e9a3924342d146f5003b11c4bae6cb6c2b44dea1829a9`. Actual downloaded-byte contained terminal installation approved preparation/install, declined service start, installed identical bytes, then ran the foreground daemon and stored/retrieved a public note. Declined preparation left the home absent; unsafe0755 held unchanged. All original/groups joined. No personal service/configuration/database, live host or model was used; full qualification stays unverified. Prior release assets and tags remain untouched.

## Release-user onboarding (2026-10-14)

The downloaded ZIP path now has a release-first README and numbered installation guide, with no source/Bun/Node/gh/jq prerequisites. Future packages include the committed guide as `INSTALL.md` and getting-started release notes; published1.0.1 assets remain unchanged. The current guide is available online.

The exact published1.0.1 binary was downloaded and verified, then exercised under an OS barrier in disposable HOME/runtime roots: initial doctor hold, setup with default config, install plan, macOS plutil planHash extraction, install apply/status, installed version, foreground readiness, memory add/search and joined shutdown all passed. No personal installation, LaunchAgent activation, models or external network were allowed during execution. Gatekeeper UI behavior was not exercised.

Typecheck,36 containment probes and17 distribution/lint cases passed. A disposable committed source snapshot produced a fresh compiled artifact, passed compiled safety, packaged the guide verbatim and passed the publisher verifier. Temporary fixtures were removed; no published tag or release asset was rewritten.

## GitHub-hosted CI/CD (2026-10-14)

The owner selected GitHub-hosted macOS arm64 builds and explicitly approved ephemeral CI dependency preparation and fresh native qualification. CI automatically runs containment, typecheck, boundaries and every guarded suite. Version-tag CD repeats qualification, builds and smokes the compiled binary, bundles reviewed dependency/runtime notices and source/relink guidance, then hands verified same-run assets to a separate write-token publisher. No self-hosted runner, personal configuration or live host/model activation is required.

Fresh hosted SQLite admission uses a receipt bound to pinned source/patch, native output and provenance, current Bun/host/toolchain/SDK, verifier source and the actual app-free OS-contained probe. It does not substitute a workstation hash for a hosted build or weaken the fixed local admission path. Build metadata remains `runtimeQualification: unverified`; hosted/native/compiled safety evidence does not qualify live controls or model quality.

Hosted run38506840133 passed fresh native qualification,35 containment probes, typecheck and boundaries, then93/94 test files passed. Distribution tests were blocked by the JavaScript file guard when hashing Bun outside the checkout, not by SQLite behavior. The guard now permits the current runtime and only exact canonical public Apple compiler/SDK files declared by the qualification receipt; SDK/toolchain directory metadata is permitted, but directory contents, private data, writes and process execution remain protected. Fresh contained compiled and release-package smoke passed locally, including ZIP/commit/overwrite denials. The hosted correction still requires a passing observed run before publication.

CI run38508423972 at `2b892b3` subsequently passed fresh native qualification,36/36 containment, typecheck, boundaries and94/94 guarded files. First CD run38509299790 for `v1.0.0` stopped before build/publication on a normal synthetic Codex creation with an unknown outcome; its100ms fixture request budget is a likely scheduling sensitivity, not a confirmed production defect. The fixture budget is now1000ms, while production deadlines and explicit cancellation/nonreplay assertions stay unchanged. Preserve the pushed `v1.0.0` tag; use package/tag1.0.1 for the corrected delivery rather than rewriting tag history.

The patch's guarded Codex suite passed14/14 and typecheck passed. A disposable OS-contained client smoke delayed the real initialization response150ms: the100ms budget produced timeout/unknown;1000ms connected with the exact native version. Both original processes joined with no retries or live models. The throwaway fixture was removed. This proves the fixture budget distinction, not the hidden cause of the earlier hosted catch.

**Published delivery:** [CI run38511016510](https://github.com/vprodan/bosun/actions/runs/38511016510) passed the1.0.1 source qualification and every guarded file. [CD run38511928414](https://github.com/vprodan/bosun/actions/runs/38511928414) independently repeated checks, built/verified/smoked the compiled artifact, packaged70 production dependency notices plus runtime/source/relink guidance, and published [v1.0.1](https://github.com/vprodan/bosun/releases/tag/v1.0.1) at commit `60a4bdf88080fc9f3d6a19c79aa024df9bc69b1a`,2026-10-14T04:44:15Z. No draft remains for this version. Repository/release access remains private.

Downloaded GitHub assets passed the non-executing publisher verifier. ZIP SHA256: `28a5a21a03d48fe1dc8783a78165ae07b2b19e4a6f67729690e4b0c9ffe5aac8`; binary SHA256: `a843f50d14c836dd3b77c4681578d10d436662cba3bfddc11348a03fe305879e`. The exact published binary then passed local contained version/help/private-hook/private-route/MCP, seven storage/privacy requests, shutdown/reacquisition and10000-note/21-hook safety. All producers joined; no live hosts/models or personal activation. Metadata remains `runtimeQualification: unverified`; macOS arm64 is the only released target, without notarization or a complete production-qualification claim.

Publication rejects existing releases and uncertain lookup outcomes. After draft creation, failures retain the draft for review rather than replaying or overwriting. `.github/workflows/cd.yml` is tag-triggered; commands and asset format are documented in `CONTRIBUTING.md`. Hosted execution/publication evidence must be observed before claiming a release.

## Native major compatibility and CI correction (2026-10-14)

Native agent admission accepts stable OMP18.x, OpenCode2.x, Claude2.x and Codex0.x releases. Baseline constants remain tested provenance, not runtime identity. Clients, captures and receipts retain actual observed versions and reject identity drift after binding; prepared profiles require their exact reviewed version. Malformed/prerelease/cross-major versions are denied. Codex0.x minor releases can break protocols; schemas and unverified-control gates remain fail-closed. Bun/SQLite/toolchain pins are unchanged.

GitHub run38478197132 failed on three trailing blank EOF lines. Removed those lines; the existing whitespace check and reported push range pass locally. Hosted CI execution is observed; the gated native runner remains unexercised remotely.

Typecheck and35/35 containment passed. Across16 affected files,302 tests initially passed and an obsolete minor-version denial failed; corrected host-installation then passed22/22. All303 distinct affected cases pass. Actual disposable CLI smoke generated18.11.0/2.8.0/0.200.0/2.2.0 profiles retaining exact versions with no native calls. No new full-suite claim.

Current artifact: `dist/bosun-1.0.0-darwin-arm64-host-major/`. Binary SHA256 `0da12f5b90070d2d288c078a161b9206e6837ceed2d5d33ab5292723a9adb2e0`; archive SHA256 `7b62e35a48326b0ae6990d797f36a31c28e7c570ccca6b6b31a9ad4eda4f734f`. Static source checks and actual compiled startup/MCP, storage/privacy, shutdown/reacquisition and10000-note/21-hook delivery passed with all producers joined; no live host/model or personal activation.


## Current scope and permissions

- Package version is **1.0.1**; **OMP is primary for new configuration**, with OpenCode 2, Codex and Claude Code retained. Preserve explicit host/model/effort/cwd/access selections.
- The owner authorized complete repository housekeeping and code cleanup, preservation and identical reapplication of the retained stash, canonical asset reconciliation, and a **fresh local artifact rebuild and guarded requalification**. This supersedes the older “no cleanup/removal workstream” instructions, including those still present in dated plans.
- The owner subsequently authorized reviewed commits/pushes and version-tag CI/CD publication. Ephemeral GitHub-hosted dependency preparation is approved; local installs, personal configuration/auth/database/LaunchAgent changes, live host/model/service calls and history rewriting remain unauthorized. Use Bun only; native Node-API headers remain build inputs, never permission to execute Node. Preserve existing recovery artifacts.
- The coordinator owns artifact cleanup, stash integration, source/asset integration and final verification. Workers do not run tests/builds/linters during edits. Fresh local rebuild permission does not execute old pending compiled/corpus proposals or authorize live qualification.

**Historical pre-migration precommit verification:** **1,190/1,190 tests across 94 guarded files**, zero failures, plus **35/35 containment**. [Full log](research/checkpoints/2026-10-13-clean-repo-full-bun.log). Inclusion review found no credential/runtime-artifact blockers. Release review found `install.sh` still invoked Node: fixed to Bun with `--no-env-file --no-install`; its actual `--help` path exited0 under an OS barrier in a disposable home. No installation ran. This wrapper is outside the compiled artifact inventory, so the cleanup binary and existing safety receipt remain unchanged. Local commit hooks/signing are disabled per invocation to avoid unauthorized personal hooks/authentication effects; no personal Git configuration changes.

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

The coordinator removed ten old 0.2 distribution directories and four formula candidates, and backed up disposable native build/upstream trees. The original 1.0 release, selected native candidate/archives/receipt, LSP tooling and `node_modules` were retained. The historical orphan `scripts/check-bun-prerequisites.mjs` was retired; it is not an active executable. Canonical handoff wording and generated assets were reconciled. Later typed-tooling cleanup retains used diagnostic helpers in maintained modules rather than preserving obsolete entrypoints.

## Fresh cleanup artifact

The coordinator built **`dist/bosun-1.0.0-darwin-arm64-cleanup/`** from the cleaned candidate:

| Fresh build output | SHA256 |
| --- | --- |
| Binary | `d64cf0b87f7e414dec97dade5ab12a05bd494e05b75a964fd565c38374a9e0f4` |
| Archive | `573d45a151c3b3ded1a6e4c6231cb0499c4b856110306ca9df4ceafe5d5a9a80` |

**Historical pre-migration coordinator verification passed**: selected **13/13 guarded source suite files**, zero failed (not a rerun of the historical full 91-file suite); **35/35 containment**; typecheck; boundaries **250 files / 1,359 edges / zero violations**; fresh static source/artifact verification; actual compiled version/help/private hook/private route/MCP; seven storage/privacy RPCs; shutdown/owner-lock reacquisition; and **10,000 notes / 21 hook injections**, with all original/group producers joined. No live hosts/models or personal runtime were used. These qualify that candidate's exercised local minimum-safety scope, not the typed-tooling migration or complete production readiness. Static `runtimeQualification: unverified` remains appropriate.

The [cleanup qualification receipt](research/checkpoints/2026-10-13-cleanup-qualification.json) binds these exercised checks to the fresh binary, archive and source digest.

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

Two fresh sandboxed native builds previously produced identical **1,939,312-byte** binaries, SHA256 `554a3ad6a9b55b8c91af529d7832c7c52605511c32a2833f352166a136046c1d`. `scripts/sqlite-native-inputs.mts` binds reviewed archives, patch, source, toolchain and native output; changed bytes/toolchains require review and requalification. Existing build inputs are not permission for new acquisition/install.

Preserve owned-statement/backup finalization, retained-cursor invalidation, unfinished-FTS rollback, UDF/authorizer/error identity, exact integer/blob handling, URI/extension/defensive controls and online backup. Cleanup retains original errors and literal destination whitespace. No GC/private-pointer workaround, `node:sqlite`/Node fallback or weakened floor/lease/poisoned-writer assertions.

`src/platform/canonical-path.cjs` resolves metadata/components/links **without opening the database inode**. Ordinary Bun `realpathSync(database)` was observed releasing a cross-process POSIX read lock; fresh symlink/inode checks and metadata-only canonicalization are required. Do not replace them with identity caches.

Historical native/source evidence includes `2026-10-13-sqlite-library-{backup-edges-probe,backup-edges-build,reproducible-rebuild,storage-final-qualification,layered-final-source,layered-final-typecheck,installed-final-probe,portable-prepare,layered-source-capture,source-benchmark-metadata-after}.log`. It records 196/196 storage tests plus 35/35 containment, then 1,179/1,179 integrated source tests across 91 files plus containment and typecheck, and the original 10k source-hook/producer-join contract. These are previous candidate receipts, not fresh cleanup qualification.

## Deferred gates and safety boundaries

Real-model quality/Clef calibration, physical vector support and budgets, native four-host controls/tool isolation/readiness/retention/UI switching, designated-machine performance, broader compiled reproducibility, live second-machine deployment and personal installation/launchd/TCC remain deferred and separately permission-gated. Unverified automatic controls stay held; synthetic/source success never promotes them. The initial cleaned repository was committed locally as `21d5dc6`; this does not authorize pushing or live deployment.

Preserve original privacy/scope/IDs/versions/hashes/audit, public-only inference screening and derivative invalidation. One daemon owns the prepared home; reads/startup do not initialize or repair unknown layouts. Lost native/COMMIT/transfer effects remain durable **unknown** with original receipts and **no replay**. Hooks remain lean, read-only and inference-free; producer-owned leases survive uncertain writes until proven OS teardown. Preserve explicit models without fallback or credential borrowing.

### Qualification review requirements

- Bind each new measurement to its actual source, dependency/lock, native input, toolchain, flags, executable and archive hashes. Static integrity, deterministic packaging, native-library reproducibility and compiled runtime behavior are different claims. A single successful build is not a two-build reproducibility result; never normalize differing bytes or relabel a copied diagnostic build as production.
- Review native telemetry, admission fences, tool/background quiescence, fresh idle-session seed retention, exact model/access acknowledgement, ownership transfer and UI selection independently for each host/version. Version/help or inference-free bootstrap success cannot qualify all controls. Unknown/stale/model-mismatched occupancy disables automatic triggering; cumulative usage is not active occupancy. Unmanaged sessions remain manual, and native overflow protection stays enabled.
- Preserve the 10,000-note benchmark contract and separate first-run from measured delivery. Record original process and producer-group completion positively; a joined parent does not prove separately grouped nested producers joined. Uncertain joins retain the owned private tree. Report actual terminal facts without inventing exit zero from controlled cancellation. Whole-process wall latency, char/4 token estimates and sampled filesystem budgets are not component latency, actual host tokens or enforced filesystem quotas.
- Retain source bytes, hashes, excerpt boundaries and complete support/alternative lineage for reviewed evaluation corpora. Gold and graph labels require independent acceptance; source selection is not label approval. Freeze development choices before disjoint held-out capture, keep source/session clusters disjoint, and report clustered uncertainty, truncation/misses, no-memory cases and same-budget lexical comparisons. Source-authored questions and synthetic scores do not substitute for captured owner tasks, native retention, real model/vector quality, privacy/scope/expiry/revocation/purge canaries or measured review burden. Keep disabled paths held when benefit evidence fails.
- A changed candidate, driver, flag, download or sandbox profile needs current exact scope review; fulfilled one-run approvals are consumed and broad continuation does not renew them. Native probes require private disposable roots, literal filtered environments, bounded output/deadlines and explicit original/group joins. An OS sandbox is not proof of native tool isolation; environment isolation alone is not an OS sandbox. No failed diagnostic authorizes an adapted retry or personal-state access.

### Deliberate product boundaries

Keep one package/binary, one prepared-home authority, seven ports and shared thin entrypoints. Retain the four native hosts and independent ACP adapter; native account ownership stays with each host. Do not add arbitrary UI takeover, credential borrowing, automatic paid overage, unknown-effect replay, whole-history small-model calls, hook inference, online router learning, automatic fact/profile promotion, autonomous high-risk/auto-merge bots, a generic agent platform/policy DSL, offline multi-master/live-database sync, automatic authentication/MCP migration or a new marketplace/plugin protocol. Optional read-only claude-mem and user-installed Graphify/CodeGraph do not become automatic observation copying or install prerequisites. These boundaries retain accepted decisions, not the obsolete implementation sequence or its old runtime defaults.

## Preserved history

- [Exact original HANDOFF.md](research/archive/2026-10-13-handoff-pre-cleanup.md)
- [Exact original RESUME.md](research/archive/2026-10-13-resume-pre-cleanup.md)

Both archives retain the full originals without rewriting their dated history. Their relative links were authored at the repository root: interpret `docs/...`, `src/...`, `test/...` and other relative paths **from the repository root**, not from `docs/research/archive/`. Historical instructions, proposals, version freezes, host choices and old process handles are evidence, not current authorization.

### Retired plans, specs and diagnostic proposals

Superseded `docs/plans/` and `docs/specs/` contents, including the proposed package manifest, were removed after retaining current scope, permissions, safety and qualification limits in this guide, [ARCHITECTURE.md](../ARCHITECTURE.md), [CONTRIBUTING.md](../CONTRIBUTING.md) and [upgrade/install guidance](upgrade-and-install.md). Current `package.json`, `bun.lock` and active source are authoritative; the old proposed manifest, Node commands, version freezes and prospective features are not current behavior. Useful research, ADRs, checkpoints and full root-guide archives remain evidence, not executable instructions.

The complete originals remain recoverable from **`21d5dc606bf6bf8b853eeb801f45562fe801aecf`**. Read any retired file without restoring it into the checkout:

```sh
git show 21d5dc606bf6bf8b853eeb801f45562fe801aecf:docs/plans/2026-10-06-bosun-v1.0-direct-delivery.md
git show 21d5dc606bf6bf8b853eeb801f45562fe801aecf:docs/plans/2026-10-04-bosun-v1.0-implementation-ledger.md
git show 21d5dc606bf6bf8b853eeb801f45562fe801aecf:docs/plans/2026-10-06-package.proposed.json
git show 21d5dc606bf6bf8b853eeb801f45562fe801aecf:docs/specs/2026-09-29-bosun-memory-design.md
git show 21d5dc606bf6bf8b853eeb801f45562fe801aecf:scripts/check-compiled-benchmark-diagnostic.mjs
```

For any other removed plan/spec/diagnostic, use `git show 21d5dc606bf6bf8b853eeb801f45562fe801aecf:PATH`, replacing `PATH` with its exact repository-relative historical path, without a Markdown fragment. This also recovers original `HANDOFF.md`/`RESUME.md` and archived guide bytes. Retired paths cited by dated research or frozen snapshots are historical citations, not broken product dependencies or permission to execute recovered drivers. Do not duplicate the old ledgers into another repository archive or rewrite frozen source evidence/hashes to make it appear current.

## Continuation preferences

Keep defaults explicit, preserve selected models and native authentication ownership. Claude-mem stays external/read-only; Graphify/CodeGraph remain optional user-installed tools. Orca-managed `CODEX_HOME` is host-owned; do not modify its hooks. Original research measurements refer to the M5 Pro. Historical personal-state recovery facts remain in the preserved resume archive, not permission to access or alter personal state.

## Typed tooling migration

Maintained tooling is strict `.mts`, included in the existing project typecheck. Six obsolete exact-artifact/Claude diagnostic entrypoints were retired after extracting used helpers into `scripts/qualification.mts` and `scripts/qualification-diagnostics.mts`; redundant `.d.mts` sidecars were removed. Root `HANDOFF.md` and `RESUME.md` are consolidated here; `AGENTS.md` stays at the repository root. Installed third-party JavaScript is unchanged. Three historical `.mjs` driver snapshots are preserved byte-for-byte as `.mjs.txt`; original paths in machine receipts remain historical identity.

## Latest maintained artifact

`dist/bosun-1.0.0-darwin-arm64-bun-only/` is the final single-lock artifact, including the typed tooling cutover, canonical guidance and MIT metadata. Binary SHA256: `503d3b782947e3ba77c08c56d6adddc59296cda31f5706b7903a82e922e2cb04`. Archive SHA256: `3c261fb7a3b09570681d9c7fb97b72dab7a87dbcee8c64a35e9a15c0365129db`. Source digest: `b5e0b831ae5926efc4aa729c7f1142dc1490d4198a869e086019a2808cc70f1f`; 7,383 captured inputs.

Verification: strict source/tooling typecheck; 250 production files / 1,359 boundary edges / zero violations; **1,188/1,188 tests across 94 guarded files**, plus **35/35 containment**, after the typed tooling cutover. Two obsolete retired-CLI admission tests were removed; behavior/privacy/producer-join assertions remain. [Full migrated-suite log](research/checkpoints/2026-10-13-maintained-full-bun.log). After final lock/template removal, typecheck and **50/50 distribution, native-profile and upgrade tests** passed. Fresh final static source/artifact verification and actual compiled version/help/private hooks/routes/MCP, seven storage/privacy RPCs, shutdown/reacquisition and 10,000-note/21-hook delivery pass with all original/group producers joined. No live hosts/models or personal activation occurred; static full-runtime qualification remains unverified.

The [final single-lock qualification receipt](research/checkpoints/2026-10-14-bun-only-qualification.json) binds this final binary, archive, source inventory and exercised checks. Full typed-cutover results and subsequent affected-suite results are recorded separately; no final all-suite rerun is implied.

GitHub CI is configured, not remotely exercised: hosted source-hygiene push/PR/manual commands and failure rejection were smoke-tested in disposable Git roots, and actual native admission passed locally. Opt-in qualified checks require the protected branch, approved environment, dedicated provisioned macOS ARM64 runner and exact input bundle described in CONTRIBUTING. The README logo was visually checked embedded in light and dark browser previews. MIT applies to project-owned work; third-party licenses and generated-code provenance obligations remain.

### Remaining-file audit

`bun.lock` is the sole dependency authority. Removed `package-lock.json` after migrating build inventories, fixture copying and CI bundle checks; no dependency installation or lock regeneration occurred. Removed the unused root `config.default.env`; actual legacy parsing and explicit-model preservation remain in `src/core/legacy-config.ts`. The originals are recoverable from `21d5dc6`.

The final tracked-candidate inventory contains 22 maintained `.mts` modules and no first-party `.mjs` executables, redundant `.d.mts` sidecars, root handoff/resume files, or plans/specs directories. The retained CommonJS bootstrap/preload and metadata-only canonicalization files have active safety consumers. Native bindings, archives, dependencies and LSP binaries remain ignored; no credential/database/native-binary files were found among commit candidates. Historical research/ADR/checkpoints and exact snapshots remain evidence, not a competing runtime/configuration authority.
