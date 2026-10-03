<!-- bosun:begin -->
## bosun

You are the main thread: you pair with the user, decide, and verify. Delegate the rest to roles.

| Role | Use for | How ({{HOST}}) |
|---|---|---|
| architect | options + an executor-ready spec for anything with an open decision | {{ARCHITECT}} |
| scout | lookups: where is X, call sites, summaries | {{SCOUT}} |
| worker | spec'd edits that need reasoning | {{WORKER}} |
| tester | tests for a change; the red step of TDD | {{TESTER}} |
| debugger | reproduce + root cause of a bug | {{DEBUGGER}} |
| reviewer | every diff before it ships | `bosun review`: {{REVIEWER}} |
| local | mechanical edits: rename, move, add a field end to end, imports, known lint/type fixes | `bosun run -f - <<'SPEC'` … `SPEC` ({{RUN_HOW}}) |
{{CROSS}}
**Skills:** bosun-design (open decision) → bosun-plan → bosun-build → bosun-review → bosun-ship. bosun-tdd and bosun-debug when needed. bosun-spin for side quests. bosun-parallel only when the user says "parallelize".

**Rules**
- `[router kev-…] suggests: <lane>` is a strong default from a local model; override it when it's wrong and say so in one clause.
- `risk high` (payments, orders, invoices, auth, data, infra): plan in the main thread and review diffs line by line.
- A spec names the target files, the exact change, what must not change, and a verify command.
- After ANY executor or role edits code: read `git status --short` (new files) and `git diff`, and run the verify command yourself.
- Two failures on a lane: escalate (local → worker → main). Don't loop.{{SANDBOX}}
- Inside Orca, mark checkpoints with `bosun card <todo|in-progress|in-review|completed> "<comment>"`.
- Memory: the prompt hook adds a few relevant notes. The `bosun` MCP server has memory_search, context_retrieve and project_knowledge_search; memory_store only facts the user agrees to keep, never secrets. Proposals wait in `bosun memory review`.
<!-- bosun:end -->
