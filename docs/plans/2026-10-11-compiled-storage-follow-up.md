# Review proposal: corrected local-runtime driver

Prepared; this corrected driver has not executed a compiled binary. The owner approved the [previous driver](2026-10-11-compiled-storage-qualification.md) for one run, which is fulfilled: compiled setup passed, then invalid temporary config prevented daemon startup. That run is not retried automatically. RESUME.md's “Never run the tests under Bun” restriction requires a separate narrow exception for this follow-up.

Same statically verified7,278-input candidate, no product/schema change:

- BinarySHA256:39fa79df688a7d3f52bf26213745d24d76f3d41382ec0a3a9f6bc032ea6f7f19.
- SourceDigest:d62e28cdb141adcbaa19c11ad4ddd6165cad7f313bc15e1fc1041b41650ab725.
- Corrected driverSHA256:7302ce86925f9d425742170278b7ea928b703b9d678614033b1659960ad0e109.

[Review driver](../../scripts/check-compiled-runtime.mjs), exact proposed one-run invocation:

```sh
node scripts/check-compiled-runtime.mjs --approved-local-runtime-only dist/bosun-0.2.0-darwin-arm64-storage
```

The correction keeps the required OpenCode primary enabled **in configuration only**, selects an absent command inside the owned empty PATH tree and inert127.0.0.1:1 endpoint, and disables Codex/Claude, Claude-mem, managed handoff, graph/enrichment, consolidation scheduling, notifications and remote. Router/provider endpoints are also inert127.0.0.1:1. No job/runner, host detection, model or native endpoint is selected. Registry construction is lazy; the actual source registry has exactly one inert primary factory and no quota source. The seven proposed requests contain only memory/context/status operations.

The exact exported temporary-config helper passed guarded Node preflight with real temporary setup/daemon/UDS and all seven requests, private override rejection/exclusion and shutdown. Any native factory selection was made fatal; selected0, native stubs0. Evidence: docs/research/checkpoints/2026-10-11-compiled-storage-driver-preflight-final-node.log. The first Node preflight was correctly refused before application imports because its cwd escaped the test run; corrected cwd used the existing guard unchanged. This preflight qualifies the driver recipe, not compiled daemon behavior.

Scope/deadlines/output/cleanup are otherwise the previous concrete proposal: copy/recheck exact binary into one canonical private temporary HOME/runtime/workspace/XDG/cache/temp tree; compiled setup then one foreground temporary daemon; two invented public/private stores, owner private get, rejected model private override, public-only model search and lexical context, owner metadata status; original process-group SIGTERM/join,10-second kill backstop; cleanup only after original close. Readiness/setup15 seconds, RPC5 seconds and total output1 MiB per process/response. Record finite stages/counts/hashes/terminal/cleanup without raw private text. A failure remains unqualified and is not retried.

No native hosts/ACP/models/Ollama/physical extensions/installed services/LaunchAgents/install/upgrade/undo, personal config/auth/databases, Orca/UI/TTY, external network, Git mutations or publishing/deployment. Trusted-application isolation is not an OS sandbox. Ordinary tests remain guarded Node. Public compiled hook/public reader, native automatic controls/Claude availability, real quality/vector/Clef/retention/performance, compiler reproducibility and final ship gates remain open.
