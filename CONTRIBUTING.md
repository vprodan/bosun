# Extending bosun

Extend the single codebase described in [ARCHITECTURE.md](ARCHITECTURE.md).
Package metadata is `1.0.0`. The owner-approved fresh cleanup artifact is
`dist/bosun-1.0.0-darwin-arm64-cleanup/`, with the original local release retained.
It passed the coordinator's exercised contained minimum safety; real-model
tuning/quality, live-host and broader physical qualification remain deferred.
Unverified controls stay gated. [HANDOFF.md](HANDOFF.md) records candidate-bound
evidence, retained-stash/external-backup recovery and current permissions. Complete
housekeeping/code cleanup, a fresh rebuild/requalification and one local commit
of the cleaned repository were authorized; no push, installs, live calls,
personal-state changes or history rewriting.

The source entry `./install.sh <action>` invokes Bun with `--no-env-file
--no-install`; `./install.sh --help` reaches command help without installing.
Installation effects require an explicit reviewed plan and owner authorization.

## Commands and shared authority

Define a new daemon operation in the closed [method table](src/contracts/methods.ts).
Use bounded strict schemas and declare mutation, inference, owner-only and MCP
tool exposure deliberately. Model-facing schemas may restrict owner fields;
the trusted RPC scope supplies audience and project/session identity.

Implement its typed handler in [the dispatcher](src/app/dispatcher.ts), calling
the existing application service or a focused service composed by
[the daemon](src/app/daemon.ts). Reuse its owned resources and lifecycle.
[CLI](src/app/cli.ts), [MCP](src/app/mcp.ts) and [dashboard](src/app/dashboard.ts)
remain thin clients of those operations, without another writer or implicit startup.

Keep domain decisions, admission and use cases in `src/core`; supply effects
through its seven ports and injected dependencies:

| Port | Extension responsibility |
| --- | --- |
| [HostAdapter](src/core/ports/host.ts) | Native profiles, hooks and managed lifecycle facets |
| [AgentRunner](src/core/ports/runner.ts) | Selected bounded native task execution |
| [ModelProvider](src/core/ports/model.ts) | Screened generation and optional embeddings |
| [MemoryStore](src/core/ports/memory.ts) | Scoped original memory and versioned mutations |
| [ContextSource](src/core/ports/context-source.ts) | Eligible retrieval candidates |
| [Workspace](src/core/ports/workspace.ts) | Owned worktrees, card and watch facets |
| [Router](src/core/ports/router.ts) | Public-input routing advice |

Implement effects in `src/adapters` and runtime primitives in `src/platform`.
The [boundary checker](scripts/check-boundaries.mjs) enforces layer imports,
declared cross-adapter seams, literal module loading, cycles and core effect
exclusion. Preserve these boundaries when extracting or sharing helpers.

## Selected adapters and durable effects

Add runner factories to [native-runners.ts](src/app/native-runners.ts), provider
selection to [model-providers.ts](src/app/model-providers.ts), and router factories
to [registry.ts](src/app/registry.ts), which currently owns only router selection.
Host profile and managed controls use their existing selected composition in
[host-install.ts](src/app/host-install.ts) and [managed.ts](src/app/managed.ts).
Registry construction must not load/probe every host, read authentication,
start a service or create directories; load only the selected implementation.

Adapter presence and installed-version detection do not qualify a capability.
Keep `verified`, `unsupported` and `unverified` distinct and use
[capability admission](src/core/policy.ts). Preserve explicit model, effort, cwd
and access through selection, native acknowledgements and execution; retain
the native harness identity even when it uses another vendor's model.

Use [the existing job executor](src/core/use-cases/jobs.ts) and its application
[composition](src/app/jobs.ts) for queued effects. Preserve project/request-ID
deduplication, version compare-and-swap and original effect receipts. Lost
native or commit confirmation stays `unknown`; reopen, cancellation, release,
late replies and duplicate requests must not authorize replay.

## Memory, inference and shared assets

Check [public-input policy](src/core/policy.ts) before reading inference content
or selecting a provider. Repeat source privacy, scope, version/hash, expiry and
lineage eligibility at capture, retrieval and commit/delivery boundaries.
Private or unknown source flags are denied before model projection; graph/vector/cache
derivatives cannot bypass current original-source eligibility.
[Embedding indexing](src/core/use-cases/index-embeddings.ts) demonstrates whole
source-window screening and revalidation around provider access and storage.

Keep [the hook](src/app/hook.ts) lean: bounded input, validated snapshot, bounded
local metadata request and the bound read-only selector. Models, embeddings,
indexing, expiry maintenance, writes and remote network dependencies belong
outside this path. Preserve deadline omissions and producer-owned read leases.

Edit canonical [roles](roles), [skills](skills) and [policy.md](policy.md).
[generate-assets.mjs](scripts/generate-assets.mjs) embeds these and the package
version into [generated-assets.ts](src/platform/generated-assets.ts); regenerate
with `sh scripts/bun-check.sh assets` after changing canonical inputs rather
than editing generated literals. Host bundles consume the same shared assets.

## Meaningful verification

All ordinary application tests use pinned Bun1.4.3/darwin-arm64 through the mandatory
[launcher](scripts/run-tests.mjs), invoked by `sh scripts/bun-check.sh tests`.
Containment runs before imports, with per-file startup-isolated homes, explicit
child preloads, guarded paths/SQLite, stub effects, registered mock endpoints
and an OS barrier. Keep meaningful privacy, exact-selection, stale-CAS and unknown
nonreplay assertions. Direct `bun test` and Node fallback are prohibited.
The previous integrated Bun candidate passed 1,179/1,179 across 91 files plus
35/35 containment, typecheck, native probes and source-hook/10k/capture smokes.
Cleanup verification passed selected **13/13 guarded source suite files**,
**35/35 containment**, typecheck, boundaries and fresh static/compiled minimum
safety. Final precommit verification passed **1,190/1,190 tests across94 files**
plus **35/35 containment**. See HANDOFF for
candidate hashes and limits. Keep the original 10,000-note contract, positive
producer joins and fresh metadata checks, without cached identities. Historical
Node/older compiled receipts are not qualification of the selected product.
Checks remain trusted owner commands, not universal sandbox/config detection.

The owner-approved native fork is pinned in `package.json`, Bun lock and
`patches/better-sqlite3@13.0.3.patch`. It requires existing macOS arm64 CLT tools.
Explicit `sqlite-native-acquire` downloads only integrity-pinned build inputs;
`sqlite-native-prepare` and `sqlite-native-build` apply/build them without package
lifecycle scripts or Node execution. `sqlite-library-probe` qualifies disposable
native behavior. Builds/checks never acquire inputs implicitly. Source/header,
patch, native binary and toolchain admission are bound by
`scripts/sqlite-native-inputs.mjs`; different bytes/toolchains require review and
requalification. A successful native rebuild is not compiled-product proof.
Use metadata-only `realpathWithoutOpen` for SQLite identity checks: Bun's
ordinary realpath can release POSIX locks while transactions remain reachable.

```sh
sh scripts/bun-check.sh tests --runtime bun --suite omp,opencode,managedcontrols,nativerunners,claudeclient,claudetranscript,core,boundaries,lint
sh scripts/bun-check.sh typecheck
sh scripts/bun-check.sh boundaries
```

Select existing suite names from the launcher; unknown or unimplemented selectors
fail before tests. Add coverage to the relevant existing suite. Fixture success does
not establish live host/tool isolation, model quality or compiled runtime support;
keep those qualifications tied to their actual evidence.

Project-local OMP LSP uses `.omp/lsp.json` and the approved isolated tooling bundle
under ignored `.omp/tooling/`. Its guarded Bun launcher uses the existing TypeScript
tsserver with automatic typing acquisition disabled; no app dependency/lockfile
or personal configuration changes are needed. Use symbol-aware navigation and
references before changing shared contracts. See the provenance in
`.omp/tooling/install.json` and the current README for verification limits.

During delegated edits, workers skip tests/builds/linters/formatters; the integration
coordinator verifies once after all changes land. Keep the exact full HANDOFF/RESUME
histories in `docs/research/archive/`; their original root-relative links are
historical, not archive-relative. Never delete evidence or owner changes merely
to make the tree look clean, and never reapply the retained stash over newer edits.

