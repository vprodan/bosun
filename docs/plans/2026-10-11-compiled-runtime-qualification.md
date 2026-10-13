# Review proposal: current compiled local runtime

**Held and superseded after deeper source review:** this candidate contains an unconditional Bun rejection in `src/adapters/memory/sqlite-cutover.ts`, so compiled setup cannot pass. Do not execute this proposal, including if its pending permission question receives approval. The source-corrected candidate has a [separate exact proposal](2026-10-11-compiled-storage-qualification.md). The shared driver now rejects this older hash and accepts only the successor's hash; it has never executed. No approval transfers between the candidates.

This has not run. The saved owner restriction in RESUME.md prohibits Bun application/runtime tests. The earlier exception covered only five entry checks on an older exact binary and is already fulfilled. This proposal requires a separate explicit exception; ordinary application tests remain guarded Node only.

Current candidate: dist/bosun-0.2.0-darwin-arm64-current/bosun, SHA256 e6752f51b88f43d3a7709620ff41eb5f35c8e34ae2bce7463d927b0c0dd61cc6, source digest7f6abf497d0c8165e58b958e99baccca27a97afc8b894f42950d1514c368401f. Node full integration passed1,083/1,083 +19; native Bun1.4.2 compilation and independent static --source verification passed7,277 inputs. Package remains0.2.0 and no release is implied.

Prepare one fresh private temporary HOME/BOSUN_HOME/cwd/XDG/cache/short UDS path, exact literal environment and a copy of the hash-verified binary. Setup that disposable runtime, disable every native host and automatic/model/remote/notification path in only its temporary config, and launch one foreground temporary bosun daemon. Exercise seven bounded actual local RPC requests: two public/private invented memory stores, owner private get, rejection of a model private-search override, ordinary model search, model lexical context and metadata status. Both admitted model reads must exclude the private marker and retain the public marker. Then shut down and join the original process. All request/output sizes, deadlines and process-group termination are bounded; no retry of mutating commands. Remove only the owned temporary tree after the daemon joins. Output records finite assertions/counts/hashes, not raw private fixture results.

Scope excludes native OpenCode/Codex/Claude, real models/Ollama, physical extensions, global services/LaunchAgents, installation, personal configuration/auth/databases, Orca/GUI/TTY, external network, Git changes, publishing and deployment. It uses one temporary local authority, not an installed service. Env clears credentials, NODE_OPTIONS/BUN_OPTIONS/BUN_BE_BUN and native PATH. Trusted-application isolation is not an OS sandbox.

The current public hook deliberately omits memory on Bun because producer-lease/stdout timing is unqualified. These checks must report that remaining gate; an empty compiled public hook must not be called full hook support. Compiled performance, delivery fencing, live native tool/UI/retention, real corpus quality and all final ship gates still require their own evidence.

The review driver is [scripts/check-compiled-runtime.mjs](../../scripts/check-compiled-runtime.mjs). Node syntax validation passes; the driver has not been executed. It checks both exact hashes before copying or executing the candidate, labels failures by finite stage, awaits the original daemon close before removing its runtime, and reports cleanup before qualification.

Exact proposed invocation, once separately approved:

```sh
node scripts/check-compiled-runtime.mjs --approved-local-runtime-only dist/bosun-0.2.0-darwin-arm64-current
```

Approval covers one run of only these specified current hash-pinned disposable local-runtime checks, never the ordinary Bun test suite or any host/model/install action. A failing mutating check is not retried automatically. Source corrections or a different binary require another review.
