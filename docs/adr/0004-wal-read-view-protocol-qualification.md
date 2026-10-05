# 0004 · WAL public read-view protocol qualification

**Status:** Synthetic native protocol qualified; production activation held. **Date:** 2026-10-05.

## Context

[ADR 0003](0003-qualified-local-readonly-memory.md) holds mutable WAL primaries because native read-only access changes their sidecar footprint. A primary-file header or a time limit cannot establish freshness: committed changes may exist only in WAL. Restoring useful fallback also requires revocation when records become private, change scope, expire or are deleted.

## Qualified protocol

Keep the authoritative primary in WAL. A supported writer builds a separate public-only rollback database with a `HOLD`/`READY` gate, source identity, generation and writer floor. Rebuild its permitted rows and mark `READY` in one view transaction; omit private/unclassified rows and audit history. Readers still apply scope and expiry at query time. An owner backup contains the complete source and is a separate artifact from this model-facing view.

A publisher owns `BEGIN IMMEDIATE` admission on the primary throughout generation selection, permitted-row selection and the view's `READY` commit. The prototype records that admission explicitly: `isTransaction` alone also accepts a deferred transaction and is insufficient. Publication updates the fixed view in place.

Persistent `BEFORE INSERT/UPDATE/DELETE` memory triggers require a versioned connection-local function. Before allowing the primary mutation, that function commits `HOLD` to the view with `synchronous=FULL`; generation advances inside the primary transaction. Ordinary old/direct writers without the function fail, including statements prepared before cutover. A failed or rolled-back primary mutation can leave the view held; only a serialized publisher may make it ready again.

The reader opens only the rollback view with native read-only/query-only, memory temporary storage, zero busy wait and exclusive connection mode. It retains a read transaction through query, packing and output handoff. A writer that cannot commit revocation while this lease exists must fail its primary mutation. After release it can revoke and commit. Returned JavaScript rows are not usable for a later delivery after release.

## Evidence and boundaries

The executable model lives in [the test-only helper](../../test/read-view-prototype.ts) and [qualification suite](../../test/read-view-qualification.test.ts). No production module imports either. The `readview` suite uses the mandatory Node guard and synthetic databases. Observed Node 24.16.0 embeds SQLite 3.53.0; actual backup, function, authorizer and transaction APIs were checked before multi-connection WAL probes. Unsupported native prerequisites defer those probes; they do not activate a runtime feature.

The twelve tests cover reader bytes/mode/mtime/ctime/directory footprint before, during and after its lease; public IDs and personal/project/shared/linked scope; private/audit canaries; old prepared/direct and actual legacy MemoryService mutations; contention; primary rollback leaving `HOLD`; deferred-transaction rejection; expiry; an exact native pre-floor backup; and four guarded child `SIGKILL` boundaries. Ordinary read access-time updates are excluded from footprint comparisons.

The backup probe holds primary write admission while SQLite's backup API reads through a separate source connection, preserving committed rows/events and an owner-only 0600 artifact. It releases admission before installing the floor: this proves the backup mechanism, **not** an atomic backup-to-cutover sequence. `SIGKILL` probes qualify process-crash behavior at hold, primary commit, view build and ready boundaries; they do not prove power-loss durability or other platform behavior. A reader holds pending journals without recovering them; recovery belongs to an explicit writer.

Negative probes demonstrate that uncontrolled schema removal or replacement of the required function can bypass the floor. A connection authorizer protects only the connection on which it is installed. This is a trusted-application protocol, not protection against a same-user connection or filesystem owner deliberately altering it. Source generations and a ready flag alone do not prove writer ownership. Replacing the view inode also lets an old lease retain stale rows while a new file is revoked.

## Production activation gates

1. Implement a SQLite-aware backup, drain/restart and writer-floor cutover that keeps admission across its critical sequence, with an interruption/recovery ledger. Inventory all database opens: owner API/CLI, MCP, serve, docs, diagnostics and benchmark callers. Retire or restart incompatible writers before enabling views.
2. Encapsulate supported writer registration, schema ownership, source identity and generations. Validate source/view schema, paths, sizes, metadata and data bounds; use finite errors. The test helper's fixed synthetic identity and simplified SQL are not a production adapter.
3. Keep the view inode fixed while readers can hold it. Cover unlink/replace, restore/source-epoch changes, abandoned journals and writer-owned recovery. Never repair or copy a live primary/WAL pair on the read path.
4. The legacy **rollback-only local caller lifetime** now retains its actual EXCLUSIVE-mode connection through packing and native stdout acceptance, after router work finishes. This is not the prototype's explicit read transaction or a ready-view integration. A production view must still implement its own validated lease/identity/generation contract through this boundary.
5. Qualify real concurrent-process writer/publication behavior, expiry validity at delivery, bounded lease/write contention, storage failure and durable recovery on supported platforms. A database lease does not stop the clock: these fixtures apply expiry at query time and do not qualify buffered delivery across an expiry boundary. Measure latency separately; this slice makes no hook p95 or useful WAL retrieval performance claim.

**Default-WAL local hook notes remain omitted.** Existing production schema, reader, defaults and databases are unchanged by this qualification. This protocol is a candidate for the same v1.0 cutover, not restored WAL support or a completed daemon/remote materialized view.

## Local caller handoff (slice 7b1)

`lib/route.ts` now finishes existing router work before acquiring local memory, avoiding a read lock across the configured network/model timeout. A nonempty local block owns the reader through packing and the actual stdout write callback. Successful handoff means native stdout acceptance, not host processing or acknowledgement. Real guarded child tests show the existing rollback writer cannot commit privatization before that callback and can afterward while the producer is still alive. Remote retrieval keeps its existing parallel path.

Local memory delivery is qualified only for Node on POSIX pipe/socket stdout. File/TTY, Windows and Bun-compatible stdout omit local memory before DB open; advisory output remains compatible and may itself be synchronous/unbounded. Compiled Bun hook delivery is a separate ship qualification gate. Node's pinned [process I/O documentation](https://nodejs.org/download/release/v24.16.0/docs/api/process.html#a-note-on-process-io) distinguishes those synchronous sinks from POSIX pipes.

Serialized local memory envelopes cap at 16 KiB. Oversized memory is discarded, its reader released, and advisory-only output records zero injection. The pending delivery phase has a 250 ms event-loop timer, not a hard total hook or native SQL latency guarantee. Empty/error reads and pre-write cancellation release without queuing memory.

**The first close-confirm cancellation proposal was rejected by native evidence:** `process.stdout.destroy()`/`closed` allowed a cached late write and a backpressure frame to flush after lease release. A 50 ms wait for that event therefore cannot establish permanent cancellation. Pending write error, signal or timer now terminates only the one-shot hook with the reader retained until process teardown. No private Node handles or synchronous completion-metric writes are used on that path. It has no hook completion metric, which benchmark reporting treats as unqualified rather than injection. Successful/oversized/empty returns record truthful delivery counts.

The `hooklease` suite exercises actual child stdin/stdout/SQLite: callback retention, delayed router mutation, failed write/signal, real OS backpressure, ineffective destroy/forced teardown, redirected regular-file sink, actual CLI EPIPE and oversized UTF-8 fallback. This fixes the local cached-delivery lifetime gap only; no WAL view is publicly activated, no primary schema/writer floor changes, and no native-host, power-loss or full revocation/expiry protocol claim follows.

## Explicit production primitive (slice 7b2a)

The explicit production backup/floor primitive in [ADR 0005](0005-explicit-memory-writer-floor-cutover.md) holds actual admission through native backup and transactional floor commit, with conservative interruption reconciliation. Runtime callers recognize an already-applied floor and use registered admission; `cutoverMemory` remains uncalled by runtime roots. [ADR 0006](0006-explicit-public-memory-publication.md) adds explicit publication/format fencing on the fixed inode, while the owner recovery gate stays HOLD. Owner activation/draining, public reader/handoff/expiry, capacity and useful default-WAL hook fallback remain gates; the test-only prototype stays independent.

## Primary references

SQLite documents WAL commit/sidecar behavior and the WAL-reset fixes in [WAL](https://www.sqlite.org/wal.html). The [backup API](https://www.sqlite.org/c3ref/backup_finish.html) describes source/destination locking and copying through SQLite. [Node 24.16.0 SQLite](https://nodejs.org/download/release/v24.16.0/docs/api/sqlite.html) pins the host API. [SQLite schema version](https://www.sqlite.org/pragma.html#pragma_schema_version) documents statement schema checks. Sources were checked 2026-10-05; local behavior above is measured in guarded fixtures rather than inferred solely from documentation.
