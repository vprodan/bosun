# Review proposal: one instrumented compiled benchmark

Prepared and unexecuted. The approved current batch is fulfilled: its five entry checks, setup and seven SQLite/privacy RPCs passed, but its benchmark exited1 without a report. Its driver discarded stderr. [The result](../research/checkpoints/2026-10-12-compiled-current-result.json) preserves that failure and the retained tree. No retry has occurred.

This proposal is a new narrow exception to [RESUME.md](../../RESUME.md), which says **“Never run the tests under Bun.”** It requests one benchmark on a freshly built diagnostic candidate. Ordinary tests stay on guarded Node. The earlier approvals and pending Claude/corpus/storage questions do not authorize this run.

The source change adds a fixed benchmark failure phase and completed store/search/context/hook/epoch counts. The benchmark emits one finite diagnostic stderr record followed by the existing normalized CLI error; it emits no raw errors, content, IDs, paths or environment. Observer throws/rejected promises cannot change the operation's error or cleanup. Success data, privacy/admission and positive-only producer cleanup remain unchanged. A phase identifies where work stopped, rather than proving the underlying native cause.

Candidate: dist/bosun-0.2.0-darwin-arm64-benchmark-instrumented. Package stays0.2.0; it is not a release selection. One static build used the existing Bun1.4.2 compiler, with no product execution/download/install. Original build session88330 joined exit0; both compiler version/static compile calls returned0, private snapshots were removed. Production flags remain bytecode-on; the copied build tool truthfully removed only that flag. No current two-build reproducibility claim is made.

| Pin | SHA256 / source digest |
|---|---|
| [Exact new driver](../../scripts/check-compiled-benchmark-diagnostic.mjs) | 4164c1e2ecb88b73bec463a166d2f1598cb5113a82c7410ff1b77006d11e220f |
| Binary,64522098 bytes | bba7bfb39c530363de72e6462844b46b132088f4e738b7429430dee7af31a02a |
| Archive,27192499 bytes | bb776df39db6530b976708ecf92a53b8a27c552ebc742ee45f0065977163315b |
| build.json | a49eeca3447549e2227fa322dbcce26abaf22f970ccf3b9ba6d7e5d5d163a651 |
| Variant input digest,7282 inputs | 1197aa21b3ef31c052bf096e9c4099ab64188c887c9ffe35a076e74100657441 |
| Required unchanged checkout input digest | 0d053310d840abd41b722ffe662d1fdac2c2096190a7612303fe7e517161cf2e |
| Installed compiler Bun1.4.2 | 35d20dd0263e5c950194434b925454fdfa9ba6e4467da960410fa05b08a7a5b5 |
| Benchmark source | 57142230a51f02e5891d4042c903a5e3b0f088b546d131ba78ecba1e444bb83a |
| CLI source | ff66ef2f834ec26034cc3aa74148accab83e85c8f27e9197a4c57dce43a1143d |

Static artifact/check evidence: [build record](../research/checkpoints/2026-10-12-compiled-benchmark-instrumented-build-record.json), [build log](../research/checkpoints/2026-10-12-compiled-benchmark-instrumented-build.log), [independent exact-driver static review](../research/checkpoints/2026-10-12-compiled-benchmark-instrumented-static-review.json). Its archived pure verifier/dependencies retain their earlier exact pins; no verifier/binary patching or hash normalization occurs.

Only after an explicit new answer, run this command once:

~~~sh
node scripts/check-compiled-benchmark-diagnostic.mjs --approved-benchmark-diagnostic-only dist/bosun-0.2.0-darwin-arm64-benchmark-instrumented
~~~

The scope is one compiled memory bench --n 10000 --public-view root, with at most21 nested compiled hooks (one first/warm-up and20 measured), thus at most22 compiled product invocations. It loads only deterministic synthetic public notes in39 finite256-note lifecycle epochs, runs200 search/context trials at the400 char/4 estimated-token budget, then validates the delivered hook envelopes. It repeats no entry/setup/foreground-daemon/RPC checks.

One private Node relay captures bounded raw stdout AND stderr without changing the pending shared-process source. The compiled child is not detached and shares the relay-owned group. Its original close frame and the shared lifecycle's positive original relay/group join are reported separately; neither proves separately grouped nested hooks joined. A validated successful product report must confirm all21 nested producers plus exact counts/injection outcomes before cleanup. Every failed/unknown benchmark, malformed report or uncertain join retains the complete new private tree. The older retained tree is not accessed or removed.

A new canonical0700 tree holds the rehashed0700 copied binary and0600 relay. Synthetic HOME/BOSUN_HOME/XDG/cache/temp/workspace and empty native-tool PATH exclude inherited credentials/options/personal configuration. Only invented Git metadata is present. The benchmark initializes its own private runtime; external memory, vectors/extensions, enrichment/extraction/scheduling and native/model/service/notification/UI operations are not selected. No external network is included.

Bounds:180seconds for the benchmark/relay;360seconds overall; group SIGTERM then one-second SIGKILL grace; aggregate relay stdout/stderr1MiB, including base64/framing overhead, with decoded bytes separately capped1MiB. Nested producers retain their existing5second/32KiB bounds. A250ms metadata-only monitor bounds the owned tree to512MiB/16384entries/depth20; this is a sampled budget, not a filesystem quota. No prefix kill, repeated benchmark, fallback or automatic retry. Record the original exec handle through terminal completion.

Guarded Node source validation:22/22 plus19 containment,75.281876042s, original64033 joined0; actual Node10k benchmark retained20/20 deliveries. Strict typecheck18328 joined0 and boundaries234 files/1259edges/0 pass. Initial relay/source checks34/34 and36/36 plus19 are preserved. Coordinator post-pin guarded Node36/36 plus19 containment passed,81.258967792s, original5646 joined0; no product executable ran. The exact new driver independently passed static verification against the fresh artifact before this recipe check.

Captured phase/counts and bounded stderr provide diagnostics. Synthetic wall observations are not native host delivery, host-token/component latency, designated-Mac thresholds, real corpus/model/Clef/graph/vector quality or automatic-handoff qualification. The underlying failure cause and full release remain unresolved. Main4adb3b4/package0.2.0, locks, consumed old drivers/proposals and13 pending Claude source pins are unchanged. No broader permission follows; this exact proposed run is UNEXECUTED.
