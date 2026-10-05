# 0003 · Qualified local read-only memory

**Status:** Narrow implementation complete; coordinator verification passed. Safe WAL fallback remains a same-v1 ship gate. **Date:** 2026-10-05.

## Context

The local hook called the writable `MemoryService/openDb` path: migration, mode/WAL changes, lazy expiry and access touches could occur during retrieval. Native `node:sqlite` read-only behavior needed qualification before replacing it.

Guarded synthetic probes on the available Node 24.16.0 show that default `DatabaseSync({readOnly:true})` creates and leaves `-wal/-shm` on a writer-closed current WAL database and changes the existing sidecar footprint with an open WAL writer. Connection query-only/temp-store/busy-timeout settings alone do not stop this. Exclusive connection mode safely fails both WAL cases without filesystem changes. Compatible rollback-journal fixtures read with unchanged bytes, mode, mtime/ctime and directory footprint, with a closed or idle open writer. Access-time updates from ordinary reads are excluded from the comparison.

## Decision

Implement `src/adapters/memory/sqlite-readonly.ts` as the `search/get/close` subset of the existing MemoryStore port. It takes an explicit canonical ordinary file path and injected clock, imports only Node IO and pure core DTOs/text/errors, and preserves stored IDs/hashes/class identity. It exposes no mutation methods and performs no mkdir/chmod/create/migration/journal conversion/checkpoint, retention/access update, extension loading, logging or metrics.

Preflight checks regular-file/header state, a 16 MiB limit, rollback header and absence of journal/WAL/SHM sidecars. WAL produces the finite `wal_requires_writes` hold before native open. URI/immutable and symlink/noncanonical paths are rejected. Immediately after native read-only open, before any schema/content query, set connection-only `query_only=ON`, `temp_store=MEMORY`, `busy_timeout=0`, `locking_mode=EXCLUSIVE`; native defenses stay enabled. Exclusive mode is the measured fail-closed backstop for a raced WAL state. Only compatible schema version 1 and required table/FTS shapes are accepted; no migration is attempted.

Bound and bind queries, limits (1–50), caller scope/linked IDs and tags. SQL permits only public integer-zero flags, active/unexpired records with consistent category/project scope. Validate returned numeric/nullable metadata before projecting Memory DTOs. Expiry is filtered without archive/events; access/version counters stay unchanged. Preserve FTS terms, BM25, matched-word counts and the real hook two-term gate. `get(events:true)` is rejected: historical audit hashes/source can describe earlier private versions, and only the owner writer API exposes that history. Missing/corrupt/schema-skew/locked/pending-journal/oversized/deadline cases yield finite errors, never paths or content. Read transactions keep queries consistent.

`lib/route.ts` lazily selects this adapter for local memory, while the existing remote MemoryStore path stays compatible. `curated()` accepts a narrow search shape and still applies model exposure policy. Exact new `lib/route.ts → src/adapters/memory/sqlite-readonly.ts` compatibility edge is registered in the AST checker and ADR 0001; new src never imports lib.

## Alternatives

`readOnly:true` alone violates the observed sidecar requirement. `immutable=1` on a live mutable primary would hide locking/WAL state and is rejected. Automatic conversion, checkpoint, filesystem copying or a broad snapshot/writer-floor redesign is outside this slice. Positive tests explicitly prepare rollback fixtures; separate unchanged default-WAL negatives prevent those fixtures from hiding the hold.

## Consequences and limits

**Default writer-created WAL databases currently yield no local hook notes. Safe useful WAL fallback is unresolved and blocks v1.0 shipment.** No user data is automatically converted, checkpointed, copied, deleted or rewritten. Owner CLI/private reads, writer/MCP mutations and remote compatibility remain available through existing paths. The exclusive rollback reader is qualified with an idle open writer, not concurrent commit throughput; locks can delay a writer until close.

The reader has no persisted writes. The whole legacy hook is not zero-IO or lean: route inference/advisory metadata, context/hook metrics and fixed error logs remain outside the reader. Validated hook snapshots/daemon/remote materialized views and writer/index/expiry separation are unfinished. The 250 ms injected-clock budget is checked around synchronous reads; native CPU work cannot be interrupted by this API. Zero busy wait, bounded file/query/result sizes and memory-only temporary storage constrain it; no strict latency or designated-Mac p95 claim is made.

An unused synthetic foreign virtual-table definition is tested with no extension installed or loaded; this proves unused-schema handling only, not a real sqlite-vec format/ABI qualification. Administrative fixture construction alone disables SQLite defensive mode to insert that definition; the reader keeps it enabled and all containment guards remain active.

## Verification

Use `node scripts/run-tests.mjs --runtime node --suite readonly,privacy,exposure,contracts`, isolated strict typecheck and AST boundary checks, then full guarded `--suite all` and whitespace checks. Filesystem observations include file bytes, mode, mtime/ctime, directory metadata, before/while-open/after state, and sidecar cleanup. Tests compare logical events/expiry/access/version state and exercise the actual local hook with public/private/default-WAL/corrupt fixtures. Containment runs first; no Bun, installs, live models/hosts or private databases are used. Coordinator records final counts in the implementation ledger.

## Supersedes

Replaces the local hook's writable storage open with a qualified read subset and explicit hold. It does not complete the full safe-WAL fallback, writable MemoryStore acceptance or hook closure roadmap.
