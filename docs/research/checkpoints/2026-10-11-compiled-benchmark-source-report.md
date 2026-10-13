# Compiled benchmark entry: source regression checkpoint

The `memory bench` command now selects the actual running executable with only `['hook']` under the compiled Bun runtime. Node development retains its interpreter plus source-wrapper arguments. The CLI supplies its existing `hostBinary()` entry choice. The benchmark’s former unconditional interpreter/source-wrapper spawn could invoke the compiled product with an invalid extra script argument.

Hook attempts use the existing `streamProcess` lifecycle. The benchmark captures bounded raw stdout, keeps the existing envelope and exact synthetic-ID injection classifier, and measures wall time through the lifecycle’s positive original/group completion receipt. An exit-shaped event alone does not authorize deleting the temporary tree. Unknown completion stops further attempts, reports an unknown outcome and retains that producer’s private synthetic tree. A joined failed producer contributes a failed wall observation and no verified injection timing.

Reports identify `runtime.engine` and its actual `runtime.version`. Node reports retain their existing `runtime.node`; Bun reports omit Node’s compatibility version. `hook.processCompletion` records confirmed original/group completion. Synthetic corpus, finite storage epochs, public-view publication, privacy checks, owner isolation, warm-up separation, token estimates and unqualified designated-Mac latency remain intact. No generic process abstraction or additional production helper was added.

The [frozen source/check record](2026-10-11-compiled-benchmark-source-record.json) contains all changed-file hashes, current build-input digests, log hashes and protected-source checks.

| Check | Original handle or terminal receipt | Outcome |
|---|---|---|
| `node scripts/run-tests.mjs --runtime node --suite benchmark,memory,climetadata` |Session 58860, terminal exit 0|51/51 application tests plus 19/19 containment probes; application duration 91,345.317041 ms|
| `node scripts/run-typecheck.mjs` |Session 47748, terminal exit 0|Strict check passes; exact elapsed duration was not separately instrumented|
| `node scripts/check-boundaries.mjs` |Terminal chunk `e21b37`, exit 0|234 production files, 1,259 resolved edges, zero violations; tool wall observation 0.759881417 s|
| `git diff --check` |Terminal chunk `94ced3`, exit 0|Pass; tool wall observation 0.000004875 s|

Logs: [affected Node suite](2026-10-11-compiled-benchmark-source-node.log), [strict typecheck](2026-10-11-compiled-benchmark-source-typecheck.log), [boundaries](2026-10-11-compiled-benchmark-source-boundaries.log), [whitespace](2026-10-11-compiled-benchmark-source-whitespace.log).

Three new regression tests exercise both entry branches through explicit Node script fixtures, successful and failed producer completion, and synthetic unknown completion. The 63 real fixture producers and their groups are independently absent after join; temporary trees remain present during positive close callbacks and are removed afterward. The unknown fixture launches no producer, verifies its retained tree and stops after one attempt. It removes that known synthetic tree only after verifying the production hold.

The existing 300-note benchmark passes with 20 held hook attempts and no invented injection timings. The existing 10,000-note public-view benchmark passes with 20/20 verified Node-source hook injections, preserving owner database/backup canaries, footprint and stats. Their test durations are 4,992.546792 ms and 62,138.952 ms; these include complete test work and are not hook latency measurements. Envelope/identity rejection tests remain green.

Current production build inventory contains 7,282 inputs with source digest `a484016981086346c94b1ba72eb11a8c884edac4d9905bc9fac34dcbd2c74bab`. No static build occurred during this source milestone. The earlier byte-identical no-bytecode experiment predates this change and does not cover this source tree.

All 13 files in the Claude diagnostics closure still match source digest `6a9845d012baf825fcbf7514cbf4afb8de8eb51d830d8e6dfc9d1d62357a4b11`. Its bootstrap driver remains SHA256 `e0f1bd1bcc7684f178130d4e714dd5b3d09b1eb816721ec28f26409f6ebb7a2a`; the compiled-storage check driver remains `7302ce86925f9d425742170278b7ea928b703b9d678614033b1659960ad0e109`. Distribution tooling/flags, manifests and `bun.lock` retain their earlier protected hashes. `main` remains at `4adb3b4`, package 0.2.0, with work uncommitted. Corpus artifacts and pinned proposals were untouched.

These are guarded Node source checks. The compiled entry branch is simulated with a Node executable fixture; no Bun application, generated executable, native host, model, service, install/download or personal state was used. Actual compiled runtime, SQLite ABI and designated-Mac hook latency still require separate qualification against a final frozen binary. No release-readiness claim follows from this checkpoint.
