# Review proposal: one current compiled qualification batch

**Prepared and unexecuted. A new explicit owner approval is required for this exact batch.** The current source has one statically built no-bytecode candidate. No product executable from this milestone has run. The persistent [RESUME.md](../../RESUME.md) instruction says **“Never run the tests under Bun.”** This proposal requests one narrow exception for the operations below; ordinary application tests remain guarded Node.

This is separate from the older pending [storage follow-up](2026-10-11-compiled-storage-follow-up.md), whose driver and proposal remain unchanged. Older entry/storage approvals do not authorize this candidate or batch. An unsuccessful approved batch ends unqualified, with no automatic retry or adaptation.

Candidate: `dist/bosun-0.2.0-darwin-arm64-current-candidate`. Package remains 0.2.0; this is not a release selection.

| Pin | SHA256 or source digest |
|---|---|
| [New exact Node driver](../../scripts/check-compiled-current.mjs) |`09e42b5a564cf285a31be8f8696780d588731abb4e17e3744cc5180c69c014b7`|
| Binary, 64,522,098 bytes |`8466c8ffabab081687bd737d6aa610138c74abe8aa3c21a5694757df0b217176`|
| Archive, 27,192,220 bytes |`eff6591f0810b20eb2666b5a0827da344c24db5372175846ca7958ac312287ee`|
| `build.json` |`19a528774461db0e3ad0cf116589bfceff447808101faa4471fd9ebf95cf2b55`|
| Actual variant input digest, 7,282 inputs |`a06890a071197bd9fc2b6948e0bc97dac918ce8b564a59442f09a598f4c29367`|
| Required unchanged checkout input digest |`a484016981086346c94b1ba72eb11a8c884edac4d9905bc9fac34dcbd2c74bab`|
| Installed compiler, Bun 1.4.2 |`35d20dd0263e5c950194434b925454fdfa9ba6e4467da960410fa05b08a7a5b5`|

The [frozen source/dependency/check record](../research/checkpoints/2026-10-11-compiled-current-source.json) pins the driver, declarations, configuration/process helpers, current source inventory, archive and verifier dependencies. The exact static build is preserved in [its full record](../research/checkpoints/2026-10-11-compiled-current-build-record.json) and [log](../research/checkpoints/2026-10-11-compiled-current-build.log). It compiled one private copied source snapshot using the existing installed compiler; its snapshots were removed. Production flags were untouched. The earlier identical no-bytecode pair covers its earlier frozen input tree; this single current candidate supplies no new two-build reproducibility claim.

Only after explicit approval, the exact proposed one-run command is:

```sh
node scripts/check-compiled-current.mjs --approved-current-qualification-only dist/bosun-0.2.0-darwin-arm64-current-candidate
```

The complete success path has **29 compiled product invocations: eight original entry/setup/daemon/benchmark processes plus 21 nested hook producers**. Seven UDS RPC requests and benchmark search/context work execute inside those processes; they do not launch additional product entries.

| Part | Compiled invocations | Exact activity |
|---|---:|---|
| Entry checks |5|Version 0.2.0; current command help; `hook --private` and `route --hook --private` on malformed invented input with empty stdout; one MCP `initialize` request using protocol 2025-11-25, exact server/version response, then stdin EOF. No MCP tools are called.|
| Disposable storage/runtime |2|One `setup`, then one foreground `daemon run`. Seven requests: invented public/private project stores; owner private get; rejected model `includePrivate:true` search; public-only model search; lexical public model context; owner daemon status. Then controlled SIGTERM shutdown through the shared process lifecycle.|
| Synthetic benchmark |22|One `memory bench --n 10000 --public-view`. It creates 10,000 deterministic synthetic notes in finite 256-note storage epochs, publishes only that synthetic public view, runs 200 prompt trials measuring search and context packing, and launches one first/warm-up hook plus 20 measured hook producers. Each producer must complete through the newly fixed original/group lifecycle.|

The driver verifies checksums, archive framing, Mach-O structure, compiler/version and actual flags through a private Node-only copy of the **archived variant verifier**. Its exact required pure dependencies are copied without modification:

| Dependency | SHA256 |
|---|---|
| [Archived copied distribution tool](../research/checkpoints/2026-10-11-compiled-current-build-tool.txt) |`bb7bd6da321e5107a82fb728532cfff4069feb488f40e1cf8a6d697447e674ae`|
| `scripts/generate-assets.mjs` |`69ac97416f32430352f9a1b26b513c1fafcc62b81766d1a97ea69265c4ece00f`|
| `src/platform/sqlite-runtime.ts` |`12287d5e5c3eb481a00f5609a1bbc429ed248ee147bfb382a75714ed4d20a2a4`|

That verifier records ESM/splitting/minify with `--bytecode` absent. It is the same truthful one-line copied-tool variant used for the build. The production verifier remains unchanged and continues to expect its production flags. No binary, archive or hash normalization/patching is proposed.

The binary is copied and rehashed into one canonical mode 0700 outer private tree. Each entry gets a separate invented HOME/BOSUN_HOME/workspace and empty native-tool PATH, with private XDG/cache/temporary directories and no inherited credentials, host configuration, `NODE_OPTIONS` or Bun environment options. The storage/benchmark workspace has only invented local Git metadata. The storage config retains the schema-required OpenCode primary in configuration, selects an absent command under its empty PATH and inert 127.0.0.1:1 endpoints, and disables Codex/Claude, Claude-mem, managed handoff, graph/vector/enrichment, consolidation scheduling, notifications and remote. No host factory, job, router or provider is selected. Benchmark code uses owned memory directly; its default vector backend/extraction/schedule are disabled and it loads no physical vector extension.

Bounds: five seconds per entry; 15 seconds for setup and daemon readiness; 60 seconds for the foreground daemon; five seconds per RPC; 180 seconds for the one benchmark; 360 seconds for the whole batch. Shared lifecycle termination uses owned process-group SIGTERM with a one-second SIGKILL grace. Output/response budgets are 1 MiB each; nested hooks already enforce 32 KiB. A 250 ms metadata-only monitor checks the owned tree against a 512 MiB logical-file budget, 16,384 entries and bounded depth; an observed excess aborts current root processes. This is a sampled budget, not a filesystem quota; separately grouped nested producers retain their uncertainty rules. The shared lifecycle bounds aggregate stdout/stderr bytes; these probes inspect stdout and terminal/join receipts, without a separate empty-stderr assertion. No process-prefix audit, blanket kill, repeated benchmark, host/model fallback or blind retry is allowed.

Cleanup requires positive original/group completion for every attempted root. **Once the benchmark is attempted, cleanup additionally requires its validated successful report**, including all 21 nested producers’ reported joins, valid first-run and 20 verified injection outcomes, exact note/query counts and finite truthful distributions. A failed benchmark parent’s joined group cannot prove its separately grouped nested producers completed. Any failed/unknown benchmark launch, outcome, parse or join therefore retains the complete outer private tree and reports the finite failing stage and retained path. An uncertain root join also retains the tree.

Controlled daemon cancellation is reported as `cancelled` with a positive original/group join. The shared generator does not expose an exit code after controlled cancellation; the driver does not invent exit 0. It inspects only the owned socket and owner-file metadata: socket absence supports listener cleanup; a private regular owner file and absent journal describe retained artifact state. The persistent owner file is expected. No independent owner-lock reacquisition is performed, and a stronger graceful-exit claim remains unqualified.

The benchmark preserves actual delivered-envelope/synthetic-ID classification and first-run separation. Reported hook p50/p95 are whole-process wall observations through producer completion. Component latency stays null; tokens use the char/4 estimate with host-token usage unverified; designated-Mac threshold qualification stays unverified. Twenty injected envelopes do not qualify native host delivery, tool permission/privacy behavior, native automatic handoff, real-session/model quality, vector/Clef/graph quality or the full release.

The exact probe recipe passed [guarded Node preflight](../research/checkpoints/2026-10-11-compiled-current-preflight-freeze-node.log): 6/6 tests plus 19/19 containment probes. It statically verifies a private copy of this candidate, uses explicit Node script fixtures for entry/foreground/report behavior, runs the seven requests against actual owned Node SQLite/UDS with zero native selections, and checks positive and uncertain completion/cleanup gates. It does not execute the compiled artifact. Strict typecheck and boundaries pass. Initial containment refusals are retained; fixture setup was corrected without weakening guards.

No native hosts, models, Ollama, physical extensions, installed services, LaunchAgents, installation, upgrade/undo, notifications, Orca/UI/TTY, personal config/auth/databases, external network, dependency downloads, Git mutations or publishing/deployment are included. Private environment isolation is a trusted-application precaution, not an OS sandbox. `main`/`4adb3b4`, package 0.2.0, all production code/build flags, old pinned proposals/drivers, Claude 13-file closure, corpus artifacts and `bun.lock` remain unchanged. This batch stays **UNEXECUTED pending the new explicit answer**.
