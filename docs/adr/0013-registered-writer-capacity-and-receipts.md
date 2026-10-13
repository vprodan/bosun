# 0013 · Registered writer capacity and commit receipts

**Date:** 2026-10-06. **Status:** Implemented for registered synchronous source writers; explicit owner cutover/restore/publication allocation and recovery remain separate gates.

## Decision and native bound

`CutoverWriter` repeats canonical paths, owner modes, single-link identities, source-plus-WAL size and sidecar checks before cached reads and before admitted callbacks, then around COMMIT with the existing gate/floor/epoch/backup/format checks. Unknown journals and oversized extents stay unchanged and unavailable. These checks belong to the registered writer; explicit publisher/owner recovery retain their separate journal rules.

The native source connection keeps `cache_spill=OFF`, FULL synchronous WAL and disabled automatic checkpointing. Under `BEGIN IMMEDIATE`, the driver computes a conservative native `max_page_count` before callbacks and rechecks it after DML. Exact private PRAGMA authorization clears in `finally`; callback PRAGMA/transaction/savepoint/DDL/attach restrictions remain intact, including the established read-only `data_version` exception. No schema, journal mode, epoch or backup changes occur.

For native page size `P`, current primary file length `A`, entire existing WAL file length `W` and candidate page limit `N`, reserve:

```text
max(A, N × P) + W + 32 + N × (P + 24) + 65536 + (P + 24) <= 64 MiB
```

The maximum primary term covers checkpoint growth while WAL remains. Existing WAL is charged even if reset/reuse could reclaim it. Header/frame sizes follow the [SQLite WAL format](https://www.sqlite.org/fileformat.html#wal_file_format). With no spills, the native dirty-page list emits at most one frame per page. FULL COMMIT can repeat its last frame across a sector boundary: [SQLite 3.53 WAL source](https://github.com/sqlite/sqlite/blob/version-3.53.0/src/wal.c) implements padding and [pager source](https://github.com/sqlite/sqlite/blob/version-3.53.0/src/pager.c) caps sectors at 64 KiB. One additional frame covers overshoot.

Writing `B=64 MiB-W-32-65536-(P+24)`, choose `N=min(floor((B-A)/(P+24)),floor(B/(2P+24)))`. SQLite bounds actual B-tree/FTS allocation, including virtual-table COMMIT work. This is a native page reservation, not an encoded-body estimate. [max_page_count](https://www.sqlite.org/pragma.html#pragma_max_page_count) cannot shrink below current pages: if they exceed the reservation, the floor refuses protected DML while reads and no-DML transactions, including zero-row legacy expiry, remain available.

Usable capacity is deliberately conservative: every possible page is charged as dirty, with no reclamation assumption. Row/body limits do not promise that every corpus fits. [cache_spill](https://www.sqlite.org/pragma.html#pragma_cache_spill) prevents intermediate dirty-page spilling; journal_size_limit alone governs retained cleanup/reset space. The writer never silently checkpoints, truncates, deletes, shrinks or rewrites source to regain capacity. The reservation covers admitted successful protected DML and qualified [COMMIT/checkpoint/last-close](https://www.sqlite.org/wal.html#checkpointing) file lengths; it is not a universal peak-allocation or zero-effect claim for pre-existing legacy stores/no-DML queries.

These are apparent file-length bounds for the qualified native pager, not filesystem allocated-block, process-memory, latency or power-loss bounds. Trusted callbacks retain existing constraints against replacing controls, retaining handles and arbitrary FTS/shadow/schema/file manipulation. There is no hostile same-UID isolation or arbitrary native callback proof.

## Receipt rules

COMMIT attempt and successful native return are tracked independently from admission. Authoritative MemoryError identity/current version survives only a positively successful native ROLLBACK while the operation remains uncommitted. A failed COMMIT with successful rollback is a known refusal. An attempted COMMIT without successful rollback evidence, an error raised after real native COMMIT, or failed post-commit confirmation returns finite `receipt_unknown` with `details.outcome=unknown` and discards the cached writer. It cannot return a domain conflict or successful callback value implying safe replay.

Automatic native FULL/IO rollback may leave `isTransaction=false`; that observation alone does not establish the result of an attempted COMMIT. Failed pre-COMMIT rollback also discards the handle and suppresses domain errors. Close retries are cleanup attempts, not rollback/receipt evidence. Primary rollback never undoes independent public HOLD. No automatic replay, publication, outcome ledger or daemon reconciliation is added.

An error raised after actual native BEGIN but before bookkeeping still triggers native transaction inspection and positive rollback, or handle discard on uncertain cleanup. Initial read-only docs-index admission failures return a held receipt before payload inspection, including cached format rejection; compatible Docs returns zero changes and no context. Rows/floor remain unchanged and the cached authority stays fenced. Mutation/COMMIT failures are outside that preflight catch. Docs indexing reconstructs a genuine core unknown-outcome error using fixed unavailable text and only the unknown flag; ordinary errors retain the existing finite MemoryError mapping and model projections expose unavailable only.

## Qualification and remaining gates

Guarded baselines reproduced four cached oversized admissions, an 80 MiB docs/FTS body committing 84,678,368 source-plus-WAL bytes, and real COMMIT followed by an injected error returning the wrong reason. Positive callback/native-COMMIT counters distinguish these from mapped exceptions.

Native probes cover 512/4096/65536-byte pages, exact reservation threshold and threshold-plus-one refusal, actual SQLITE_FULL, enabled spills versus OFF retaining dirty pages until COMMIT, FTS xSync allocation/FULL, checkpoint/last-close/reopen, unchanged owner/private/audit/hash/ID/floor state on refusal, sidecars/modes/symlinks before callbacks, cleared private controls, larger eligible legacy reads/no-op maintenance, and committed new rows/events/generation with unknown receipt/no replay. A 17.3 MiB higher-entropy docs body fits its registered INSERT but pending native FTS COMMIT hits FULL: automatic rollback leaves old rows/floor intact, while the writer correctly reports unknown without positive rollback evidence. The separate FTS primitive measures 277 pending pages becoming 506 after real COMMIT, or reverting to 36 with a 277-page cap, on the same native connection/transaction.

Actual MemoryService/docs/CLI/MCP/HTTP scope and finite-error fixtures, useful 10,000-medium-body publication/native-hook delivery, retained public lease/HOLD, format and restore fencing remain covered. Counts and coordinator verification live in the implementation ledger (`../plans/2026-10-04-bosun-v1.0-implementation-ledger.md`; historical citation, recover via `21d5dc6:PATH`).

Explicit owner cutover/restore/publication final allocation, broader recovery derivatives, artifact disposition, process drain, hook JSON/config closure and storage durability remain gates. Native hosts, Clef, daemon, handoff, graph, dashboard, remote and every single-v1.0 ship gate remain required. Owner installation/configuration and package version remain unchanged.
