# 0001 · Compatible core extraction

**Status:** Accepted for this implementation slice; coordinator verification passed. **Date:** 2026-10-04.

## Context

The application must evolve into seven ports without changing existing data/selected models or requiring installs. Routing provides a small real caller; memory already has useful interfaces. The v1.0 roadmap remains larger than this slice.

## Decision

Keep one package. Extract pure types/text/errors/policy into `src/core`, forward compatibility exports from lib, and route through a factory-injected use case and one lazy legacy Kev factory. New inference contracts classify privacy explicitly and deny private/unknown input. Generative ModelProvider and decision Router remain separate. Capability omission/unverified status fails closed; contracts do not qualify native controls.

Use the already installed dev-only TypeScript 6 supported AST/resolver/type-checker API for the boundary gate. The checker covers new source and the existing graph, including type/dynamic edges; it does not execute fixtures or claim compiled-hook/purity verification. Retain this dev-only parser or choose a supported replacement during TS7 migration.

## Temporary boundaries and removal gates

| Exact seam | Reason | Removal gate before v1.0 ship |
|---|---|---|
| The 25 existing `lib/*.ts`/`lib/memory/*.ts` files listed in `LEGACY_FILES` | Existing internal mixed dependencies remain compatible; no new lib files allowed | Move each caller to enforced src zones, remove its whitelist entry; zero legacy zone at ship |
| `lib/context.ts` → `src/core/text.ts`, `src/core/memory-policy.ts` | Pure scoring helpers and explicit model-audience classification before curated mapping | Migrate retrieval/index separation and remove lib caller |
| `lib/log.ts`, `lib/util.ts` → `src/core/errors.ts` | Finite new error codes and class identity/legacy constructor | Migrate platform logging/CLI errors and remove callers |
| `lib/mcp.ts` → `src/core/memory-policy.ts`, `src/core/errors.ts` | Deny whole private/unclassified records before projection; finite model error text/codes without derivatives | Migrate MCP composition/transport to enforced src zones and remove caller |
| `lib/serve.ts` → `src/core/errors.ts` | Finite errors for model-facing context endpoint; owner memory transport remains compatible | Migrate remote transport to enforced src zones and remove caller |
| `lib/memory/sqlite.ts` → `src/core/text.ts`, `src/adapters/memory/sqlite-cutover.ts` | Pure text forwarding and concrete registered-writer composition before legacy chmod/migration | Migrate storage/platform composition to enforced src zones, remove forwarding module; qualify remaining cutover/publication gates |
| `lib/memory/types.ts` → core memory/context domain, errors, memory/context-source ports | Preserve MemoryApi/MemoryReader/MemoryProvider aliases and class identity | Migrate remaining imports, remove forwarding module |
| `lib/route.ts` → core route domain/policy/use-case, `src/app/registry.ts`, `src/adapters/memory/sqlite-readonly.ts` | Real routing caller and lazy qualified local reader; unsafe WAL state held per ADR 0003 | Move host/CLI roots and qualified reader composition to src, complete safe WAL fallback and Clef lifecycle migration |
| `bin/bosun` → `node:module` named `enableCompileCache` only | Existing native Node entry cache behavior | Compiled role dispatcher replaces legacy entry; no loader escape exception |
| `src/adapters/routers/legacy-kev.ts`, factory id `legacy-kev` | Compatible endpoint/model seam, not the selected final router | Qualified Clef adapter/config/service/remote lifecycle cutover; delete seam/factory |

The exact forwarding targets are enforced in `FORWARDING`; new src may not import lib. Existing cycles and production→test dependencies remain prohibited. There is no DI container/global mutable adapter instance.

`src/adapters/memory/sqlite-cutover.ts` provides explicit owner backup/floor/publication operations and synchronous registered admission. `lib/memory/sqlite.ts` composes existing-floor writers and the explicit `memory publish` operation through the exact compatibility edge above; local MemoryService, MCP docs and authoritative serve consume registered admission. `cutoverMemory` remains uninvoked by runtime roots; no initial floor installation or new port is activated. The existing route→read-only compatibility edge now selects independently bound READY views, per [ADR 0007](0007-bound-public-memory-reader.md). Three exact internal SQLite adapter edges are recorded in the checker: cutover→public-protocol, public-readonly→public-protocol, and readonly→public-readonly. The protocol module contains IO-free schema/column/bound literals; the selector/reader never imports cutover/writer code. General cross-adapter boundaries remain enforced. [ADR 0005](0005-explicit-memory-writer-floor-cutover.md) and [ADR 0006](0006-explicit-public-memory-publication.md) record format fencing, publication and remaining owner activation/capacity/finite-expiry handoff gates.

## Alternatives

A workspace split/DI container adds release/build machinery without a second product. A complete storage/router rewrite would obscure compatibility checks. A regex scanner cannot parse arbitrary TypeScript and resolve alias/type edges reliably.

## Consequences

Router and the implemented MemoryStore read subset (`search/get/close`, not mutations) have guarded acceptance coverage. MCP memory replies/search and curated context apply the core model policy before content access: only an own `private: false` record is eligible. Denied get/store/update/delete replies contain only `{memory:{private:true}}`, without duplicate/status/version derivatives. Public records use fixed projections; returned record/collection serialization hooks are not passed through. Model memory errors use finite text/codes and omit current-version details because error replies lack a verified public classification. Owner CLI/store transport remains compatible.

The local hook uses the narrow zero-write reader in [ADR 0003](0003-qualified-local-readonly-memory.md). Ordinary default WAL primary notes remain omitted; explicitly bound READY views can provide non-expiring notes per ADR 0007; safe WAL fallback remains a same-v1 ship gate. Hook config/closure, expiry/index separation in writer/MCP paths and the atomic private mutation authorization contract remain unfinished. The exposure boundary does not fix those races/writes-on-read. Native control types/selection are not live capability evidence.

## Verification

Use `node scripts/run-tests.mjs --runtime node --suite exposure,core,contracts,boundaries`, the full guarded `--suite all`, `node scripts/run-typecheck.mjs`, `node scripts/check-boundaries.mjs` and `git diff --check`. Containment probes run first; unknown groups fail closed. No installs/Bun tests/live host or model calls are permitted. The coordinator records actual outcomes in the implementation ledger.

## Supersedes

Implements the first compatible extraction from research topic 6; it does not supersede the remaining roadmap or claim architecture step 1 complete.
