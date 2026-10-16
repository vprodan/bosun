# bosun architecture

The working tree implements the v1.0 architecture directly. Package metadata is `1.0.0`; the retained cleanup artifact is `dist/bosun-1.0.0-darwin-arm64-cleanup/`, with the original local release retained separately. It passed the coordinator's exercised contained minimum safety before the typed-tooling migration, not complete production qualification or current migration verification. Accepted scope, deferred gates, native pins, retained-stash/external-backup recovery and current permissions are consolidated in [maintenance guidance](docs/maintenance.md); superseded plans/specs are recoverable from its recorded base commit, not current implementation instructions.

One daemon owns each prepared `BOSUN_HOME`. CLI, MCP, the dashboard and authenticated remote clients share its contracts, jobs and memory authority. The hook has a separate lean entry and a bound read-only fallback. Clients never start a daemon implicitly.

## Source boundaries

| Directory | Responsibility | Dependencies |
|---|---|---|
| `src/core` | Domain types, seven ports, policies and use cases | Core only; effects are supplied as dependencies |
| `src/contracts` | Closed RPC, model-tool and artifact schemas | Contracts and core |
| `src/platform` | Paths, native processes, filesystem ownership, hashes and transport primitives | Platform and core |
| `src/adapters` | SQLite, native hosts, providers, transport and workspace implementations | Core, contracts, platform and declared adapter seams |
| `src/app` | Composition, lifecycle, service wiring and surface entry points | The layers above |

[The boundary checker](scripts/check-boundaries.mts) resolves TypeScript dependencies and rejects undeclared edges, cycles and core runtime effects. All old `lib` composition roots and their forwarding exceptions are removed. Final runtime code and executable test consumers use the final `src` APIs. Synthetic forbidden legacy-edge tests remain as regression guards.

The seven ports are HostAdapter, AgentRunner, ModelProvider, MemoryStore, ContextSource, Workspace and Router. Supporting storage contracts and workspace/card/watch facets compose those responsibilities; they do not create another public orchestration system.

## Composition and lifecycle

[bin/bosun](bin/bosun) and the compiled build share [one lazy entry](src/app/entry.ts), which selects the hook before importing CLI/schema/SDK libraries and admits private hooks before configuration. Other commands enter [the CLI](src/app/cli.ts); MCP enters [the stdio bridge](src/app/mcp.ts), and the dashboard uses [its application composition](src/app/dashboard.ts). MCP retains the event loop until input closes. All ordinary operations address the existing daemon through the same method table.

[Setup](src/app/setup.ts) prepares a new absent private layout. [Upgrade](src/app/upgrade.ts) is the explicit one-time route for the documented legacy layout. It validates before effects, retains a SQLite-aware backup, preserves original data and explicit models, and records uncertain outcomes. Ordinary reads and daemon startup never initialize, migrate, adopt permissions or repair an unknown layout.

[Kev retirement](src/app/upgrade-router.ts) is part of that supported upgrade. The selected user home, exact legacy template, native argv, inode/hash and explicit adoption bind its plan. An explicit new router endpoint replaces an old endpoint only through owner review; old credentials and confidence do not enter the final selection. Apply regenerates the review from current inputs, records original intent, saves a private exact plist backup, observes/stops only the reviewed label, confirms absence and archives only matching bytes. Original config/repository remain available. Lost native or archive returns hold the upgrade and cannot replay. This adds no installer, service recovery programme or model startup.

[The daemon](src/app/daemon.ts) validates the manifest/configuration and acquires [native ownership](src/platform/daemon-owner.ts) before opening storage. Directories and local sockets use owner-only permissions. Startup/recovery observes existing receipts; it never blindly dispatches a previously running or uncertain operation. Shutdown cancels and joins active work, then closes the shared resources.

## Durable jobs and native execution

[Jobs](src/app/jobs.ts) compose [the sequential executor](src/core/use-cases/jobs.ts) with [its owned SQLite store](src/adapters/jobs/sqlite-jobs.ts). Project/request IDs deduplicate submission, versions guard state changes, and finite metadata events are separate from owner-only task/results. Explicit model, effort, cwd and access reach the selected runner unchanged.

An uncertain native effect or COMMIT receipt is durable `unknown`. Reopen, release, late replies and duplicate requests cannot authorize another attempt. Known completion remains known even when cancellation was requested. Retention can retire settled payloads while keeping permanent links and uncertain receipts.

[Native process streaming](src/platform/process.ts) joins the original close and owned POSIX group before confirming completion. Permission-denied group signalling is not an acknowledgement: it waits only within the original termination grace for native `ESRCH`. A surviving or unverifiable group remains unavailable; no second kill or business operation is authorized by that wait.

[The lazy native registry](src/app/native-runners.ts) loads only the selected OMP, OpenCode 2, Codex or Claude adapter. OMP is primary for new configuration; explicit existing choices survive. Native login/provider configuration stays with that harness. OpenCode running an OpenAI/Claude provider is still OpenCode. Unsupported read-only/tool or managed-session controls stay held; an OS sandbox alone is not evidence that configured tools, plugins or MCP cannot cause effects.

The same registry lazily loads [the ACP runner](src/adapters/hosts/acp/runner.ts) for an enabled, bounded `acp` profile, independent of the four native host IDs. Its one ACP v1 stdio process initializes a pinned agent identity, creates a fresh exact-cwd session with no injected MCP servers, acknowledges literal model/effort selector values and receives one prompt. Client permissions are denied and filesystem/terminal capabilities are absent; this does not constrain the agent's own tools, so read-only and native managed controls remain unverified. Only an original prompt receipt with terminal observed tool states and a joined successful process can complete. Uncertainty stays unknown without retry, fallback, installation or automatic handoff.

[Quota admission](src/core/use-cases/quota.ts) shares Codex short and weekly windows across model selections. Known exhausted windows stay latched until newer complete matching evidence clears them. Unknown telemetry is distinct from exhaustion. Owner opt-in bypasses only unknown evidence; it resets no upstream allowance.

## Memory, publication and hook delivery

[The memory composition](src/app/memory.ts) borrows one private registered writer session under daemon ownership. Scope/eligibility checks repeat before, within and after native operations. Lost native confirmation fences further work. Expiry, purge, docs indexing and publication are explicit owner/admin jobs, not read-side maintenance.

| Owned file | Purpose |
|---|---|
| `memory.db` | Original L1 notes, FTS, audit and scoped graph/embedding derivatives |
| `state.db` | Jobs, usage, quota, workspaces, reviews, cards, watches and managed-session receipts |
| `memory-view/public.db` | Fixed-inode rollback publication, independently bound to the source epoch and readiness |
| `run/hook-config.json` | Validated lean projection of paths, source identity and retrieval limits |
| `manifest.json` | Prepared runtime identity and owned installation/upgrade/profile receipts |

Stored IDs, versions, hashes, raw legacy flags and audit remain authoritative. Private and unknown flags are denied before model projection or content retrieval; owner reads retain original data. New mutations record the trusted RPC audience rather than accepting a caller-supplied audit identity.

Publication copies only validated current public records. Native source/view identity, generation, readiness, schema, physical/encoded capacity and retained leases fence readers and writers. Private edits, expiry, deletion and lineage changes revoke derivatives before reuse. These are trusted-application guarantees, not hostile-sameUID or universal power-loss claims.

[The owning SQLite contract](src/platform/sqlite.ts) uses the explicitly approved
pinned better-sqlite313.0.3 Node-API fork. Its native authorizer, URI/control and
owned-handle close changes preserve UDF/error identity, exact integers, online
backup and unfinished-write rollback. No node:sqlite/Node fallback, GC or private
pointer finalization is admitted. Metadata-only
[canonicalization](src/platform/canonical-path.cjs) keeps native POSIX locks
intact through filesystem identity checks; ordinary Bun realpath is unsafe there.

[The hook](src/app/hook.ts) reads bounded input and its validated snapshot, makes one bounded local metadata request, then uses [the read-only selector](src/adapters/memory/sqlite-readonly.ts). It performs no model/embedding calls, remote network dependency, indexing, expiry, touch or telemetry writes. Wrong bindings, unavailable storage or exhausted deadlines omit context.

On qualified Bun1.4.3/macOS-arm64 pipe/socket output, the native lease remains held through explicit fs.write acceptance. Failed writes, cancellation or uncertain producer state retain it until OS producer teardown; destroying a JavaScript stream is not proof of permanent cancellation. Finite-expiry notes are omitted from fallback delivery. TTY/file/unsupported-runtime behavior and compiled timing have separate qualification.

## Graph, extraction and evaluation

[The graph adapter](src/adapters/memory/sqlite-graph.ts) binds L2-L4 artifacts to current original note IDs, versions and hashes. Reviewed proposals, parent lineage and privacy/scope invalidation govern retrieval. Graph traversal/overview is explicit and its activation stays gated by measured benefit.

[Consolidation](src/app/consolidation.ts), [public title/tag suggestions](src/app/memory-suggestions.ts) and [summaries](src/app/summary.ts) use bounded explicitly permitted sources through the separate generative ModelProvider. Outputs propose supported excerpts/artifacts; they cannot change permissions or make unreviewed facts authoritative. Claude-mem remains an external reviewed read-only reference, with no automatic observation copying. Optional Graphify/CodeGraph sources stay disabled when absent.

[Embedding jobs](src/app/embeddings.ts) screen public source windows before provider access and pin model/digest/dimensions/transform. [Storage](src/adapters/memory/sqlite-embedding.ts) commits derivatives with source CAS and revokes them on source changes. Explicit query/cache paths repeat current scope and generation checks. The diagnostic reference backend and [optional sqlite-vec distance adapter](src/adapters/memory/sqlite-vec.ts) share existing eligible ordinary vectors. The native selection binds owner-reviewed canonical file/bytes, macOS arm64 metadata and stable0.1.9 protocol, uses one disposable in-memory connection and disables further SQL extension loading. No new authority tables/indexes or extension-enabled authority/hook connection exist. Privacy/source validation precedes every distance; cache entries commit only after successful ranking/close/revalidation. Missing/rejected/unsupported native selection returns no vector candidates before provider access. Source fixtures override only the selected distance connection's load method; no physical library is loaded, and physical/Bun/benefit/budget qualification remains open.

[Memory evaluation](src/app/memory-evaluation.ts) measures curated, stronger lexical, reviewed graph, vector and overview arms over frozen disjoint datasets. Actual MCP evaluation uses disposable authority replicas; labels are never provider inputs. Synthetic scores establish composition, not real retrieval/model quality. Weak gains remain held, with no silent configuration activation.

[Router advice/evaluation](src/app/router-evaluation.ts) is separate from generative work. Clef replaces the selected Kev/Python lifecycle; [its decision adapter](src/adapters/routers/ollama-clef.ts) preserves exact model and public-input screening. Reviewed legacy retirement is implemented through the supported upgrade. Automatic delegation still requires actual readiness/calibration/outcome evidence; live service and owner-task qualification are not implied by mock protocol tests.

## Workspaces, review and handoff

[Owned workspaces](src/app/workspaces.ts) bind canonical repository/worktree identity to durable operations. Creation uses a clean committed base, not an implicit dirty copy. Prune/reconcile acts only on known ownership and uncertain effects remain sticky.

[Revision-bound review](src/app/review.ts) captures the declared public checkout, including staged/working/untracked changes. Native read-only admission repeats that revision. Findings stay proposals for owner verification; [explicit checks](src/app/checks.ts) attach command/revision evidence without treating model claims as verified results.

[Cards](src/app/cards.ts) and [watches](src/app/watches.ts) use bounded permanent receipts. Orca preflight binds an inspected local worktree/terminal contract, and ownership/entry identity is repeated before effects. A pane only observes an existing job via metadata `job wait`; pane closure/failure never submits, releases, cancels or reruns that job. Exact job cwd is separate from the canonical pane root.

The source observer is [createBunJobObserver](src/platform/watch-command.ts), with a named `JobObserver` contract shared by composition and watch consumers. It pins Bun1.4.3/darwin-arm64, repeats executable/entry identity and emits `--no-env-file --no-install`; no Node alias remains. Explicit checks admit Bun executables/shebangs while retaining fd identity/hash/race checks, literal arguments, filtered inherited environment, private HOME and permanent unknown/nonreplay outcomes. They remain trusted owner commands (`sandbox: none`), not universal dependency/configuration isolation. Process dispatch reads the mutable builtin object because Bun does not synchronize patched named exports; this preserves the existing fixture environment envelope without changing the containment guard.

[Manual handoff](src/app/handoff.ts) stores bounded checksum/scope-bound factual artifacts. [Managed transfer](src/core/use-cases/handoff.ts) uses the existing executor to fence/quiesce/capture, summarize permitted evidence, seed a fresh idle root, require exact model/permissions acknowledgement and transfer durable ownership. Unknown tool/transfer effects stay held. Production controls, effective occupancy, retention quality and UI switching remain qualification gates; arbitrary existing UI sessions use manual transfer.

[The OMP driver](src/adapters/hosts/omp/control.ts) owns one pinned18.10.3 custom JSONL RPC process and exact trusted lifecycle extension, not JSON-RPC2 or the in-place `/handoff` command. Correlated original receipts, repeated native state/history, explicit builtin provenance, request-local public policy, no-inference seed/readiness and distinct fresh roots bind its lifecycle. Captured control/admission records must match locally admitted hashes; foreign/private/altered entries and unsolicited selection events hold. Complete original-turn evidence stays buffered through tool/async settlement and process join. All six production controls remain unverified; native occupancy is estimated/unknown, so automatic handoff stays disabled by admission.

[OMP input extensions](src/adapters/hosts/omp/hook-extension.ts) and the [OpenCode2 Promise plugin](src/adapters/hosts/opencode/hook-plugin.ts) require a leading per-turn public marker because the native input contracts have no trusted public classification. Retrieved context is consumed once by the exact original input/session; newer/private input invalidates pending context. Profiles reuse shared policy/skills, retain native account selection and never infer another host's model. OpenCode2 uses canonical V2 `agents`, ordered `permissions`, structured model/variant selection, `mcp.servers`, a local plugin directory and a standalone child with the exact owned config overlay.


[The Codex managed driver](src/adapters/hosts/codex/control.ts) owns a fresh root and persistent pinned app-server through the existing host facet. Exact configured command/home, model/effort/cwd, approval and sandbox acknowledgements bind startup. Inference-free injection uses an empty native reply plus [independent bounded rollout readback](src/adapters/hosts/codex/rollout.ts) of only its returned fresh private transcript. Linked, replaced, foreign, malformed or unsupported history stays held. Original turns require correlated terminal/tool receipts and independently idle fully hydrated history, including empty native background-terminal inventory. [Capture](src/adapters/hosts/codex/evidence.ts) binds only admitted public user text, screened assistant text and finite native references; tool payloads and reasoning stay in source history. Cancellation, lost receipts and daemon restart retain unknown ownership without replay; process close joins before daemon teardown. Six capability flags and current-step occupancy remain unverified. This fixture-tested implementation does not qualify live automatic takeover or Claude's unresolved fresh seed/readiness protocol.

## Remote authority and installation

[Authenticated remote transport](src/adapters/transport/remote-rpc-server.ts) registers canonical project roots and separate owner/model credentials, enforces CIDRs and requires TLS outside loopback. Authority/protocol/source/clock identity is verified before mutation payload dispatch. Errors are finite and raw parser/provider text is not a transport contract.

The client forwards to one authority; it never merges a local L1 or queues offline writes. [Permitted local views](src/app/remote-views.ts) are explicitly refreshed public snapshots with bounded leases/expiry and revocation. Hook reads stay local. Two isolated daemon/TLS tests establish composition; live device deployment remains separately authorized.

[Installation](src/app/installation.ts), [host profiles](src/app/host-install.ts), [foreground launch](src/app/host-launch.ts) and [owned service control](src/app/installation-service.ts) use reviewed hashes/versions, exact roots/files and durable receipts. Undo removes or restores only matching owned paths. Unknown/drifted ownership is held. Planning, copying a binary and preparing a dormant plist do not authorize native trust, login, model pulls or service activation.

[The guided lifecycle](src/app/installation-lifecycle.ts) composes those same transactions for reinstall/uninstall, invoking the verified original executable for version-bound old receipts. It never rewrites old plans or kills an inferred foreground PID. Memory, configuration, previous-executable backups and historical receipts remain authoritative.

[GitHub release download](src/app/release-download.ts) pins/rechecks repository release/tag/commit and asset identities, verifies bounded archive/manifest/checksum/safety/source/license bonds, then hands verified bytes to the new owner-terminal installer. Download is not installation authority; no downgrade or authentication change is implicit.

[Optional router tools](src/app/install-tools.ts) are explicit installer-only steps, never daemon/hook startup work. Inspection, installation, app launch and exact configured model pull require separate owner choices. Native effects use the existing bounded process primitive and private durable intents. Unconfirmed original native completion remains unknown and blocks subsequent tool mutations; observed desired state is not proof of producer closure.


## Verification and remaining work

**Historical pre-migration cleanup/release evidence (2026-10-13):** the owner authorized complete
housekeeping/code cleanup, asset reconciliation and a fresh local rebuild and
guarded requalification. The owner subsequently approved one local commit of
the cleaned repository, without push, installs, live calls, personal-state
changes or history rewriting. The fresh artifact is
`dist/bosun-1.0.0-darwin-arm64-cleanup/`; its binary/archive hashes are in [maintenance guidance](docs/maintenance.md#fresh-cleanup-artifact).
Prior coordinator verification passed selected **13/13 guarded source suite files**,
**35/35 containment**, typecheck, boundaries **250 files / 1,359 edges / zero
violations**, static source/artifact verification and the actual compiled
version/help/private hook/private route/MCP, seven storage/privacy RPCs,
shutdown/owner-lock reacquisition and **10,000-note/21-hook** delivery with all
original/group joins. No live hosts/models or personal runtime were used.
Final precommit verification passed **1,190/1,190 tests across 94 guarded files**
plus **35/35 containment**; the full log is linked from [maintenance guidance](docs/maintenance.md). These receipts precede the typed-tooling migration; its verification is pending. Static
`runtimeQualification: unverified` remains appropriate: minimum local safety
does not qualify live native controls, quality, physical vectors, designated
performance, TTY behavior, broader reproducibility or personal installation.
No automatic capability was promoted.

[The Bun build driver](scripts/build.mts) targets macOS arm64 with already installed Bun 1.4.3 and no runtime download. Its source snapshot includes the authoritative Bun lock, exact installed production dependency bytes, reviewed native archives/patch/source and the fixed admitted native binary/toolchain receipt. Compiler HOME/cache/temp are isolated, automatic installs and runtime config autoload disabled. [Static verification](scripts/verify-distribution.mts) checks checksums, Mach-O commands and archive framing without executing the product. [Homebrew generation](scripts/generate-homebrew.mts) remains an uninstalled review candidate. The cleaned local 1.0.0 product passed its exercised minimum safety; native binding reproducibility is established only for the pinned historical local toolchain. Broader product reproducibility, designated-machine performance and live installation remain unqualified.

Ink's exact optional `react-devtools-core` peer is declared external in the compiled flags. The shared entry sets `DEV=false` under Bun before lazy product imports for source and compiled candidates, so Ink's imported `node:process` binding observes the disabled debugger gate. The compiler define alone does not fold that imported binding. Build metadata records this disposition; the debugger is not a supported runtime feature and Node development is no longer the selected runtime.

The original Bun1.4.2 bytecode builds had equal sizes and Mach-O UUIDs but262 differing bytes; [their comparison](docs/research/checkpoints/2026-10-11-distribution-build-comparison.log) remains a failed reproducibility result. A later [private no-bytecode pair](docs/research/checkpoints/2026-10-11-distribution-no-bytecode-report.md) produced byte-identical binaries, archives and metadata for its frozen inputs. Production flags remain unchanged, and that pair does not prove every future build reproducible. The [JavaScript witness](docs/research/checkpoints/2026-10-11-distribution-production-js-policy-witness.log) records the debugger gate before lazy imports.

All application tests use [the mandatory Bun launcher](scripts/run-tests.mts), explicit preloads and per-file startup-isolated HOME/cache, with contained SQLite/path/stub effects, registered mocks and an inherited OS barrier. The previous integrated candidate passed **1,179/1,179 across 91 files + 35/35 containment**, typecheck, installed native edges and source-hook/10k/capture smokes; these are historical candidate receipts. The prior cleanup selected-suite, full precommit and compiled evidence summarized above also precede the typed-tooling migration. Checked metadata resolution preserves fresh component permissions and inode identity without opening leased files or caching identities. Physical vector support, live/corpus quality, broader performance/reproducibility and installation qualification remain separate; the four native hosts remain supported.

Historical [Node source evidence](docs/research/checkpoints/2026-10-12-current-full-node.log) and [an earlier partially passing compiled batch](docs/research/checkpoints/2026-10-12-compiled-current-result.json) remain preserved. The retired, unexecuted `docs/plans/2026-10-12-compiled-benchmark-diagnostic.md` is recoverable through [the history instructions](docs/maintenance.md#retired-plans-specs-and-diagnostic-proposals), not an active diagnostic or permission to execute an old proposal. The original 1.0 release and cleaned candidate subsequently passed their own 10k public-hook/producer-join minimum-safety checks; these do not retroactively qualify old binaries or remove native-control/quality/designated-performance/reproducibility gates. Full pre-cleanup root histories remain archived and linked from [maintenance guidance](docs/maintenance.md#preserved-history); their historical relative paths originate at the repository root.

The [exact previous architecture document](docs/research/archive/2026-10-10-architecture-legacy.md) retains historical foundation descriptions. Its relative links refer to the old repository-root location; its retired runtime/interface claims are historical.
