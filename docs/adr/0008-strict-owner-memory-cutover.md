# 0008 · Strict owner memory plan, apply and reconciliation

**Status:** Implemented for existing strict prepared local layouts; permission adaptation, process drain/restart and broader recovery remain held. **Date:** 2026-10-06.

## Decision

The owner CLI now exposes three commands through `lib/memory/sqlite.ts → src/adapters/memory/sqlite-owner.ts → sqlite-cutover.ts`:

```text
bosun memory cutover plan [--json]
bosun memory cutover apply --plan TOKEN --clients-stopped [--json]
bosun memory cutover reconcile --plan TOKEN --source-id UUID --clients-stopped [--json]
```

Only this explicit owner path can call initial `cutoverMemory`; ordinary memory, hook, MCP and server startup never install a floor. No new domain port is added, and registered native handles remain private. Explicit publication remains a separate `memory publish` READY operation, per [ADR 0006](0006-explicit-public-memory-publication.md). A successful apply/reconcile returns HOLD, source/attempt UUIDs and generation plus explicit restart/publication/binding requirements; no owner rows, audit values, backup digest or artifact paths are returned.

## Filesystem-only plan and permissions

Planning never opens SQLite, creates directories/storage, migrates, chmods, installs a floor, publishes or writes `MEMORY_SOURCE_ID`. It checks canonical paths, owner identity, exact 0700 directories/0600 single-link files, distinct source/view/backup storage, presence, bounded sizes, primary/view/backup minimal 20-byte SQLite headers and the optional 32-byte WAL header. Mutable primary/WAL bytes are never copied or fully hashed. The primary must have WAL header mode; view/completed backup must have rollback header mode. Dangling/symlink/hardlink paths, pending journals, view WAL/SHM, unexpected names, missing/unsupported layouts and ambiguous/orphan artifacts are held. Remote `MEMORY_URL` selection is rejected before inspecting local memory storage.

Known permissions and missing-layout failures return `BLOCKED`, a finite target/reason and, for mode failures, current/required octal modes. They return no usable token or source UUID and make no repairs. For example a legacy `.bosun` directory with 0755 is reported as `primary-directory: permissions (current 0755, required 0700)`. The owner must separately prepare the existing canonical directories and review permission changes; no permission adaptation is implemented here.

An absent view with an empty backup directory produces an apply candidate. A present rollback-header view with exactly one UUID-named completed rollback backup produces a reconcile candidate. **Schema, floor and clients are always labelled unverified.** Header evidence cannot establish an owned floor/gate or prove a valid backup. Native apply/reconcile validates exact schema and owner gate/floor/backup identities and digest before changing them. A candidate can therefore fail native validation without being adopted.

The narrow one-completed-backup rule deliberately holds incomplete, rolled-back, multi-attempt/multi-artifact, pre-intent orphan and arbitrary restored storage. The existing primitive can recover more states, but this CLI has not qualified their inventory/disposition and does not expose a general recovery or restore command.

Existing CLI configuration initialization remains unchanged: `config.load` may create `.bosun/config.env` before dispatch. The operation itself is read-only; **the entire CLI is not a zero-IO claim**. Footprint tests pre-seed configuration.

## Independent plan identity and admission freshness

An apply plan generates the future random source UUID **before mutation** and includes it in the result/token. Save it independently before applying. The initial primitive uses that exact UUID, so a committed floor with a lost/uncertain receipt can later reconcile against the saved initial plan identity. A reconcile plan does not learn an expected source UUID from the candidate view; `--source-id` is an independently saved owner expectation, required even when configuration already contains a binding.

The bounded base64url token contains only version, operation, source UUID/null, issued/expiry times and a metadata/header fingerprint. The fingerprint binds canonical configured paths, device/inode/owner/mode, data-file size/nanosecond modification/change times, minimal headers and backup inventory. It is **review/freshness binding, not a cryptographic authorization seal or proof of client ownership/drain**. An owner can modify it. It is not a content-derived private-record or whole-backup digest. Tokens have a five-minute admission window; malformed/extra fields, invalid clocks, future/expired tokens, unexpected CLI flags/positionals and duplicate options fail with finite errors.

Apply rechecks the token against filesystem state before opening mutable SQLite. After actual primary `BEGIN IMMEDIATE` and exact schema/floor/gate validation, a narrow synchronous expectation seam compares apply's absent floor/gate or reconcile's exact independently supplied source UUID against **both** floor and gate. It then rechecks filesystem freshness before any HOLD, backup reservation, gate DML or floor DML. There is no handle exposure or asynchronous validation callback. Admission remains continuous across the original native backup/floor transaction, per [ADR 0005](0005-explicit-memory-writer-floor-cutover.md).

Native open of a closed WAL primary was measured to create a zero-byte WAL and a canonical 0600/single-link 32768-byte SHM. Only paired absence at the initial plan permits that exact admitted layout. Existing WAL content/identity/timestamps remain bound; existing SHM identity/owner/mode remain bound, while SHM content/timestamps are native lock housekeeping. Source-directory identity/mode is bound, while its directory timestamps are excluded because creation of native sidecars changes them. View/backup directory and file freshness remains exact. No pre-existing sidecar replacement is waived. This is a trusted-application filesystem protocol: metadata cannot prove creator identity if a same-user adversary replaces newly created sidecars; no such hostile-ownership claim is made. The TTL checks admission, and does not interrupt or retract an admitted long native backup/cutover at expiry.

## Owner operation and uncertain receipts

The owner must stop every memory/MCP/docs/server authority and independently establish any needed process drain. `--clients-stopped` records **operator attestation**; SQLite write admission does not prove all clients stopped, cached handles drained or host acknowledgement. The command performs no service/host discovery, process stop, restart, install or personal configuration binding. A live native fixture intentionally demonstrates that an attested command can succeed while a cached writer remains present; that writer is fenced after floor installation.

Keep authorities stopped through initial apply and the separate explicit publication/owner-binding steps, then reopen them. Publication upgrades writer format and also fences cached v1 authorities. The owner sets `MEMORY_SOURCE_ID` from the independently saved/applied source UUID; the default stays blank. READY reading and non-expiring delivery still require [ADR 0007](0007-bound-public-memory-reader.md)'s exact binding/lease checks. No automatic republisher, daemon freshness scheduler or finite-expiry delivery solution is introduced.

Reconcile is a **mutating owner operation**: it reconciles an existing committed floor, preserves source epoch/generation and backup/view identity, and explicitly revokes an existing v2 READY publication to HOLD. Wrong independent source identity is rejected under native admission before that revocation. Reconcile is not a status read and cannot fabricate a new epoch from a candidate view. It never installs a missing floor or blindly repairs a rolled-back attempt.

Native post-floor/cleanup/receipt failures can leave a committed floor without a success receipt. CLI errors explicitly say the outcome may be unknown; they do not promise the primary was untouched or recommend blind retry. Save the initial plan UUID, inspect storage and obtain a fresh filesystem plan before explicit reconciliation. Valid committed-but-unrecorded floor reconciliation is qualified; incomplete/orphan/multi-artifact storage stays blocked. Unknown files are never overwritten, deleted, guessed or adopted. Arbitrary same-inode WAL restoration retaining an old floor/view/binding remains unqualified; this command is not a restore protocol or storage/power-loss guarantee.

## Verification and remaining gates

The guarded `owner` suite covers filesystem-only real CLI plan footprints for closed/live WAL, strict permission/missing reports, links/pending/orphan/unsupported storage, real apply/private/audit/docs/ID preservation and writer fencing, measured native sidecar effects, stale plans before native effects, bounded clocks/tokens/strict CLI inputs, remote refusal, under-admission contenders/freshness, independently bound READY revocation, and committed receipt-loss versus incomplete recovery. Mutated typed filesystem errors, accessor/proxy failures and wrapper getters are reconstructed with finite target/reason/mode fields. Existing cutover/writer/publication suites retain the original primitive and caller checks.

Run only the mandatory guarded Node launcher, isolated strict typecheck, AST boundary checker and whitespace checks. Root records actual counts in the ledger after independent full regression. Permission adaptation, verified external process drain/restart, broader recovery/orphan disposition, restore epoch rotation/revocation, storage/power-loss durability, useful 10,000-row capacity, finite-expiry handoff and daemon refresh remain same-v1 ship gates. No owner database, personal configuration, live host, dependency/model install or product version is activated by these synthetic fixtures.
