# Agent guidance for bosun

## Start here

- Follow the current user request. Read current [maintenance guidance](docs/maintenance.md) for accepted scope, permissions, qualification limits and recovery. Archived instructions and retired plans/specs are history, not permission to restart pending work; use the recorded immutable Git recovery paths for their originals.
- Use [ARCHITECTURE.md](ARCHITECTURE.md) for boundaries and [CONTRIBUTING.md](CONTRIBUTING.md) for extension and verification patterns. Resolve stale version/status prose against maintained guidance and actual package metadata.
- Preserve user changes and reconcile the actual working tree before edits. The owner approved committing the cleaned 1.0.0 implementation locally; restore stashes and ignored artifacts remain separate from Git HEAD. Never overwrite unrelated changes or assume untracked files are disposable.
- Read applicable project skills before changing their subsystem. Canonical product assets live in `roles/`, `skills/` and `policy.md`.

## Current release and permissions

- Source/package and published macOS arm64 release are **1.1.1**, from `6fd2ddbc29593472c8e1a2399d8e493b38caf7a7`, fixing false single-manifest MLX `unsupported_model` holds. CI/CD passed97 guarded files,37 containment probes and all eight compiled safety paths; exact downloaded bytes passed cold-to-ready public router advice with mismatched loaded identity and malformed manifests still held. Optional Ollama/model setup remains separately approved; live vendor installation/model quality and full production qualification remain unverified. Cross-version retirement invokes the receipt's original executable; unknown native tool effects never authorize replay from observed presence. Preserve `bun.lock`, restore stash and external backup; maintenance records exact release hashes/evidence.
- **OMP is primary for new configuration.** OpenCode 2, Codex and Claude Code remain supported. Preserve explicit host, model, effort, cwd and access selections.
- **Bun only; no Node fallback.** The currently qualified source/build environment is Bun 1.4.3 on macOS arm64. Native compatibility APIs and Node headers do not authorize execution of the Node runtime.
- Complete housekeeping/code cleanup, canonical asset reconciliation and a fresh local rebuild/requalification are authorized. Preserve owner changes and historical evidence; only reviewed disposable/obsolete outputs and proven dead code may be removed. Retained stash `b830c5c24baa84d5b30895598cfaf94bb2d7205d` was reapplied identically; never pop/drop or reapply it over newer edits. [Maintenance guidance](docs/maintenance.md#restore-and-transfer-safeguards) records the external verified 24,635-file backup, archive SHA256 and isolated-worktree recovery instructions. Keep that external backup and `RESTORE.txt` when transferring machines.
- The owner authorized commits/pushes and version-tag CI/CD publication. GitHub-hosted macOS arm64 dependency preparation, native rebuilding and fresh qualification are explicitly approved in ephemeral CI only. Do not infer permission for local installs, personal configuration/auth/database changes, service activation, live host/model calls or history rewriting. Preserve the restore stash and external backup.
- CI/CD uses SHA-verified Bun, frozen `bun.lock`, pinned native archives/patch, real hosted qualification, all guarded tests and compiled safety before separate least-privilege publication. Existing local fixed-output admission remains distinct. No self-hosted workstation activation or old proposal execution is authorized; live/model/full-production gates remain held.

## Architecture and implementation

- `src/core`: domain decisions, policies, seven ports and use cases. No runtime effects; inject dependencies through existing ports.
- `src/contracts`: closed, bounded RPC/tool/artifact schemas. Declare mutation, inference, owner-only and MCP exposure deliberately.
- `src/platform`: runtime primitives, paths, processes, ownership and transport.
- `src/adapters`: selected native hosts, providers, SQLite and workspace effects through declared seams.
- `src/app`: composition and lifecycle. CLI, MCP and dashboard are thin clients of shared daemon contracts; do not introduce another writer or implicit daemon startup.
- Use the existing method table, dispatcher, job executor, selected adapter composition and boundary checker. Do not establish parallel conventions or compatibility shims.
- Use the project-local OMP LSP in `.omp/lsp.json` for symbol navigation and references before changing shared/exported contracts. Its tooling is isolated under ignored `.omp/tooling/`; do not replace it with application dependency or personal configuration changes.
- Keep types explicit: no `any`/`as any`, inline import-type queries or concrete implementation `ReturnType` contracts. Prefer existing domain/port types.
- Edit canonical shared assets, then run `sh scripts/bun-check.sh assets`; never hand-edit generated asset literals. Do not regenerate assets for unrelated documentation changes.

## Safety invariants

- One daemon owns a prepared `BOSUN_HOME`. Ordinary reads/startup must not initialize, migrate, repair or adopt an unknown layout. Setup, upgrade and installation are explicit reviewed owner operations.
- Preserve original IDs, versions, hashes, privacy flags and audit identity. Private or unknown source flags are denied before model projection. Recheck scope, privacy, expiry, lineage and version/hash at capture, retrieval and commit/delivery; graph/vector/cache derivatives cannot bypass original eligibility.
- Lost native or commit confirmation remains durable **unknown**. Cancellation, reopen, release, late replies and duplicate requests must not authorize replay. Keep original receipts, request-ID deduplication and version CAS.
- Keep hooks lean and read-only: bounded input and local metadata/retrieval only. No models, embeddings, remote network dependency, indexing, maintenance, writes or hidden startup. Preserve deadline omissions and producer-owned leases; JavaScript stream destruction is not proof of native cancellation.
- SQLite is owned by `src/platform/sqlite.ts`, using the reviewed pinned `better-sqlite3@13.0.3` Node-API fork and patch. No silent library replacement, `node:sqlite` fallback, GC-based close, unsafe pointer finalization or weakened lock assertions.
- Preserve authorizer/UDF/error behavior, backup, writer floor, leases and poisoned-writer fencing. Use the existing metadata-only canonicalization for SQLite identities; ordinary Bun realpath can release POSIX locks.
- Keep `verified`, `unsupported` and `unverified` distinct. Installed adapters, synthetic fixture success and OS containment do not qualify live native controls or model quality.

## Verification

Use `sh scripts/bun-check.sh …` with already installed, qualified tooling. The wrapper isolates startup HOME/cache and disables environment autoload and automatic installs. Application tests additionally require its mandatory launcher/preloads and OS containment. Do not run direct `bun test` or substitute Node.

Workers do not run tests/builds/linters/formatters mid-flight; the integration coordinator verifies after all slices land. Do not rerun checks solely to confirm reported failures or existing receipts. Report only checks actually exercised, identifying historical results separately.

On the current workstation, preserve the reviewed temporary root when running checks:

```sh
export TMPDIR=/private/var/folders/p6/sngls2r11f15r_rzn1dslc8h0000gn/T/opencode
sh scripts/bun-check.sh containment
sh scripts/bun-check.sh tests --runtime bun --suite omp,opencode,managedcontrols,nativerunners,claudeclient,claudetranscript,core,boundaries,lint
sh scripts/bun-check.sh typecheck
sh scripts/bun-check.sh boundaries
```

Choose affected existing suites from `scripts/run-tests.mts`; unknown selectors fail closed. Keep meaningful behavior/privacy/selection/CAS/nonreplay assertions, not wording, source-copy or incidental-version pins. For behavioral changes, exercise the actual changed source or compiled path in disposable contained roots; tests alone do not prove surface behavior. Never use a live personal runtime as a smoke fixture.

For a release artifact, static verification does not execute the product; the separate checker exercises contained compiled safety:

```sh
sh scripts/bun-check.sh verify dist/bosun-1.0.0-darwin-arm64-cleanup --source .
sh scripts/bun-check.sh release-check dist/bosun-1.0.0-darwin-arm64-cleanup
```

Do not overwrite retained original outputs; fresh builds require an absent `--out` directory. Cleanup authorization permits reviewed removal of backed-up obsolete outputs, not loss of owner changes or evidence. SQLite acquisition/preparation/build is explicit, integrity-pinned and permission-gated; checks never acquire inputs implicitly and current cleanup adds no install/acquisition permission. Different native inputs/toolchains require review and requalification. Static `runtimeQualification: unverified` metadata must not be rewritten to claim complete qualification from a limited safety receipt.

## Delivery and handoff

- Report exactly what changed, checks actually exercised, and remaining limits. Distinguish local artifact readiness from installation, publication and full live qualification.
- Update existing documentation for permanent behavior changes. Record continuation decisions/evidence in [maintenance guidance](docs/maintenance.md) rather than adding another competing status document.
- Preserve original HANDOFF/RESUME archives and useful historical receipts. Current root guides should remain concise; dated histories stay evidence, with retired paths recovered from the recorded base commit rather than new copied ledgers. Preserve the external backup/restore record and retained stash, and distinguish reviewed disposable outputs from user changes/evidence before further deletion.
