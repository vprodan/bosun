# bosun

Pair with OpenCode, Codex or Claude Code; use bosun for scoped memory, bounded jobs, native roles and reviewed handoffs. OpenCode is the primary host. Clef-Flash supplies routing advice through Ollama, with a separate provider for summaries, extraction and embeddings.

**Development status:** the package remains `0.2.0` while the complete v1.0 is built. The runtime passes guarded Node24 fixtures, and build tooling produces compiled candidates. Native automatic handoff, compiler reproducibility, compiled runtime, live installation and other release qualification remain unfinished. [HANDOFF.md](HANDOFF.md) tracks current evidence and remaining work. The planned release is one final v1.0 commit.

## Prepare a local runtime

The source entry requires Node24 or newer and the project dependencies in [package.json](package.json). Run from your repository:

```sh
node bin/bosun doctor
node bin/bosun setup
node bin/bosun roles --json
node bin/bosun daemon run
```

`setup` initializes a new private runtime; it installs no hosts or models. For an existing v0.2 home, use the reviewed `upgrade` flow. `doctor` inspects filesystem metadata without opening databases, calling native services or repairing files. `onboard` reports the next reviewed action.

`upgrade plan --request-id <id> --output <file>` also inspects the selected user's exact legacy `com.bosun.router.plist`, without calling launchd. If a Kev definition or explicit Kev endpoint exists, pass the intended Ollama `--router-url <url>`. An unowned supported plist is held until a new plan includes its exact `--adopt-router-hash <sha256>`; other templates and drift remain held. Reviewed apply with `--hash <plan-hash> --clients-stopped` retains the original config and repository, archives the private plist, confirms service absence and selects Clef. Lost stop/archive receipts retain the original attempt and prevent replay. This uses the same one-time upgrade; it installs or starts no model/service. Actual launchd/TCC and physical Clef calibration remain qualification gates.

The default home is `~/.bosun`; `BOSUN_HOME` selects another absolute path. `config.toml` holds explicit host/provider/model choices, and the daemon owns `state.db` and `memory.db`. CLI and MCP clients use its private local socket. No client automatically starts a daemon.

## Configuration and native hosts

OpenCode, Codex and Claude have native host adapters and role profiles. Their common roles are architect, scout, worker, tester, debugger and reviewer. Skills share one policy and role source; credentials and accounts remain with the native host.

`bosun config show` and `bosun roles --json` show resolved settings. `BOSUN_ROLE_<ROLE>_<HOST>_MODEL` and `_EFFORT` override TOML. Exact model strings are retained. Supported legacy `ROLE_*`, `WORKER_BY_*` and `REVIEW_BY_*` selections remain input aliases; canonical fields take precedence. Invalid or ambiguous bindings fail instead of selecting another model.

`host plan` produces a reviewable profile plan; `host apply` requires its hash, and `host undo` requires the current receipt. Planning starts no host and trusts no plugin or hook. Current templates cover OpenCode1.18.34, Codex0.160.0 and Claude2.1.292. Installed-version compatibility and live tool/plugin controls remain qualification gates; see `bosun host --help` and [native protocol provenance](test/fixtures/native-protocol-provenance.md).

An already installed ACP agent can be selected separately with `--runner acp-<name>` on `run`, `spin` or `workspace run`. Add a profile to `config.toml` with the exact identity and selector IDs advertised by that agent. This illustrative profile uses placeholder identity/model values; it installs or qualifies no agent:

```toml
[acp.example]
enabled = true
command = "/absolute/path/to/agent"
args = ["--acp"]
agentName = "exact-agent-name"
agentVersion = "exact-agent-version"
protocolVersion = 1
timeoutMs = 300000
modelOption = "exact-model-selector-id"
effortOption = "exact-effort-selector-id"
```

```sh
bosun run "Public task" --runner acp-example --model exact-model-value --effort exact-effort-value --allow-unknown-quota
```

The ACP runner creates one fresh session, verifies the pinned ACP v1 identity and exact model/effort acknowledgements, then sends one prompt. `effortOption` is optional when no effort is requested. Categories and defaults never replace explicit selections. ACP quota remains unknown and requires the owner opt-in shown above. Bosun denies client filesystem/terminal/permission requests, but an agent may own other tools; ACP read-only jobs and native automatic handoff remain unqualified. Lost prompt, tool or process receipts keep the original job unknown without retry. Synthetic protocol tests cover the implementation; no live ACP agent is qualified yet.

## Jobs, routing and review

```sh
bosun run "Public read-only task" --host opencode --read-only --request-id task-1
bosun job list
bosun job get JOB_ID
bosun job wait JOB_ID
bosun job watch JOB_ID --terminal term_HANDLE
bosun job watch-reconcile JOB_ID
bosun job cancel JOB_ID
```

Run accepts one literal task, `-f public-task.txt` or `-f -` for stdin, bounded to32KiB and valid UTF-8. Nested delegated runs are refused before reading input or configuration. A job pins its runner, model, workspace, access and original request ID. Quota/admission holds precede execution. `--allow-unknown-quota` is an owner opt-in for unavailable observations; known exhaustion remains held. Codex short and weekly windows share the declared account pool; a local reset cannot reset the upstream weekly allowance. Unknown effects require inspection and cannot be released or replayed.

`--watch` on `run`, `spin`, `workspace run` and `review` opens an optional Orca observer for the job already queued. An owner caller in an Orca terminal uses its explicit terminal handle by default; `--no-watch` skips the pane. The pane shows job state metadata. `job wait --result` reads the final result, and `job wait --progress` reports state changes. Jobs keep their exact execution directory, including run submissions from a subdirectory; panes bind to the canonical worktree root. A closed pane or observation timeout leaves execution under daemon control. Missing or unqualified Orca support returns concrete `job wait`, `job get` and `job result` commands. Lost pane effects keep their original receipt held and are never repeated. A newly created Git worktree needs an existing local Orca workspace binding to open a pane. Current pane support is the source Node observer with the source-inspected Orca1.4.222 contract; installed/compiled and live UI qualification remain pending.

`route` asks the configured Clef model for explicitly public advice. Model/tag/digest and local metadata checks bound the request; automatic dispatch remains held until calibration passes. Router observations and labels store bounded metadata without prompts. `review` and `check` bind a native review and explicit verification command to the checked repository revision.

## Scoped memory and context

```sh
bosun memory add --category project --title "Package manager" --body "Use pnpm."
bosun memory search pnpm
bosun memory get MEMORY_ID --events
bosun context "Which package manager?" --sources lexical
```

Memory preserves original IDs, versions, scope, private flags and audit. Owner curation supports explicit proposal review, accept/reject, archive/purge and statistics. Private/unclassified model replies stay opaque. Expiry filters reads; indexing and maintenance belong to explicit owner jobs.

`memory add --auto` uses a cancellable tool-free provider for approved public suggestions. Private notes keep local deterministic metadata and make no model call. Reviewed consolidation produces bounded proposals; it does not silently merge source facts.

Context sources include `curated`, improved `lexical`, indexed `docs`, reviewed `claude-mem`, `graph`, `overview` and `vectors`. Curated and lexical are alternative strategies. Graph L1/L2 and overview L3/L4 remain explicit; ordinary context defaults are unchanged. Source privacy, version, scope, expiry and purge revoke descendants before further delivery. `--candidates` includes permitted pre-packing identities.

Claude-mem stays external and read-only, with reviewed references rather than copied observations. Graphify/CodeGraph are optional user-installed tools and remain disabled when absent or unqualified.

## Embeddings and evaluation

`memory embed MEMORY_ID --public --request-id index-1` queues owner indexing. It screens the entire public source window, pins the configured model/digest/dimensions/transform, preserves Unicode chunk boundaries and writes once after all batches finish. Source changes delete derived vectors in the same protected transaction.

Vectors default off. `[graph.embedding]` is separate from generative and native-host bindings. `graph.vectors=true` with `backend="reference"` enables the bounded diagnostic engine. The optional `backend="sqlite-vec"` path requires `[graph.embedding.extension]` with an absolute canonical `file` ending in `vec0.dylib`, its exact owner-reviewed `sha256`, and `version="0.1.9"`. It uses a disposable in-memory distance connection on Node/macOS arm64; the authority DB and hook remain extension-free, with no new virtual index. Missing selection, rejected bytes/version or unsupported runtime returns no vector candidates, preserving lexical retrieval without query inference. The compiled runtime currently degrades this backend; physical library/Bun compatibility, quality and budgets remain unqualified. No workflow here installs or pulls anything. `context ... --sources lexical,vectors --public` explicitly permits query inference when its selected backend is available; the hook performs no embedding calls.

The query cache defaults0, caps64 entries and30seconds TTL, and stores only hashed keys plus finite vectors. Exact input/model/configuration/project/session/linked scope and current eligible native generation bind reuse. Every hit repeats current ownership, workspace and visibility checks. Uncertain results never populate it.

`memory eval public-export.json --public` evaluates an approved workspace-relative corpus in a disposable final-runtime replica. `--surface mcp` uses the actual SDK/stdio/daemon at its own budget. `--vectors` additionally requires an explicit public full-digest reference model selection from configuration. D compares against C; E compares against D when selected, otherwise C. Default and hook evaluation make no model calls.

```sh
TMPDIR=/tmp node scripts/eval-memory.mjs --fixture test/fixtures/memory-vector-eval.json --baseline fts --surface mcp --vectors-synthetic
```

The guarded synthetic mode uses a registered HTTP fixture and rejects owner-reviewed corpora. [The D report](docs/research/checkpoints/2026-10-10-memory-vector-mcp-synthetic-report.json) measured800 MCP calls, but its1/64 gain has a confidence interval including zero. Enrichment stays held. Real quality, physical weights/templates, token cost and compiled/Mac performance remain separate qualification.

## Handoffs, workspaces and interface

`handoff` creates, reads, summarizes and transfers reviewed public artifacts. Deterministic permissions, prohibitions, approvals and next action stay outside model output. Import verifies scope, checksums and checkout differences; it starts no agent and transfers no credentials or running process.

`managed` owns native sessions admitted through bosun. Automatic transfer requires qualified telemetry, fenced prompt ingress, tool quiescence, screened capture, faithful summary, fresh idle bootstrap and exact seed/model/permission acknowledgement. Production controls remain unverified, so arbitrary existing UI sessions use the manual path.

Owned OpenCode and Codex managed startup/turn/capture use the same durable jobs and authority. The Codex driver pins0.160.0, the configured command/home and exact model/effort/cwd; read-only startup stays held before discovery. It creates a fresh root, injects one public assistant seed without a model turn, and independently checks the returned private native transcript before readiness. Unknown, linked, changed, paginated or foreign transcripts stay held. Native command/MCP payloads and reasoning are omitted from captured evidence. Shutdown joins its app-server process; lost receipts and daemon restart hold ownership without adopting or replaying history. These controls have synthetic Node protocol coverage; all six production automatic-handoff capabilities and actual tool/UI/context semantics remain unqualified. Claude's bounded native jobs are implemented; its managed seed/readiness protocol remains unresolved.

`workspace`, `spin`, `review` and `check` use owned committed Git worktrees with pinned revisions and original effect receipts. Dirty contents are not copied. Cleanup is previewed and never forced. `card` updates the enclosing Orca card through an owner receipt; broader live Orca workspace/terminal qualification remains open.

`dashboard` shows scoped job, quota, usage and handoff metadata and explicit job actions. `notifications` defaults off and uses opaque local messages. Profile exports are sanitized and preserve explicit models; they contain credential placeholders rather than account material.

## Remote authority

The optional authenticated server uses registered project identities, separate owner/model roles and pinned authority/protocol/TLS settings. Clients forward authoritative writes and inference; they never merge two L1 writers or infer offline writes. Explicitly refreshed permitted local views support offline hook reads without copying private or expiring source data.

Remote view/source leases require confirmed HOLD/release acknowledgements; unknown acquisition, release or mutation outcomes do not retry. Remote embedding jobs and queries use the authority model/corpus, with checked public projections and original source IDs. Live second-machine deployment remains separately authorized.

## Reviewed installation and service lifecycle

`install plan` selects an exact binary, user/runtime roots and dormant daemon definition. `install apply` requires the reviewed hash and stopped-client attestation. It retains an explicitly reviewed prior binary and leaves data, native homes, shell settings and global Ollama environment untouched. Homebrew ownership remains with Homebrew.

`install enable`, `install disable` and `install reconcile` use current receipt versions/hashes and durable operation IDs. Readiness binds the selected binary, daemon identity and actual PID. `install undo` removes/restores only matching owned files after the daemon is disabled and clients are settled.

Migration spellings `uninstall`, `start` and `stop` select the same owned installation receipt and require the same flags. `restart` composes durable disable/enable operations; an uncertain stop holds before enabling, and repeated requests reuse their original receipts. These commands do not guess ownership from old `state.json` or manage arbitrary Ollama/Kev services. The supported upgrade separately handles exact reviewed Kev retirement. Existing unowned global Ollama settings remain retained for explicit owner review; live service qualification is still open.

```sh
bosun install plan --binary ./bosun-release --request-id install-1 --output install-plan.json
bosun install apply install-plan.json --hash PLAN_HASH --clients-stopped
bosun install status
```

Use `bosun install --help` for the exact receipt flags on service/undo actions. Planning writes the chosen plan file; status reads existing receipts. The guarded Node fixture tests establish owned effects, drift holds, original data/model retention and undo; they do not qualify a compiled binary or live launchd/TCC installation.

## Development and verification

```sh
npm test
npm run typecheck
npm run boundaries
node scripts/run-tests.mjs --runtime node --suite climetadata,installation,service
```

The build driver uses Node24 and an explicitly selected, already installed Bun on macOS arm64. It snapshots the current public source, regenerates embedded roles/skills/policy inside that snapshot, and copies the installed production dependency bytes named by `package-lock.json`. Compiler HOME/cache/temp are fresh, inherited credentials/options are absent, automatic dependency installation is disabled, and compilation targets only the current native architecture. No compiler or dependency is installed by this command.

```sh
npm run build -- --bun /absolute/path/to/bun
node scripts/verify-distribution.mjs dist/bosun-0.2.0-darwin-arm64 --source .
node scripts/generate-homebrew.mjs dist/bosun-0.2.0-darwin-arm64 --out dist/bosun.rb
```

Build outputs must be absent; repeated builds require a new `--out` directory. The artifact directory contains one `bosun` executable, a deterministic one-file tar.gz, `build.json` with input/compiler hashes, and `SHA256SUMS`. Runtime .env/bunfig/tsconfig/package autoload and Ink's optional development debugger are disabled. Static verification checks bounded metadata, checksums, the arm64 Mach-O header/load commands and exact archive content; `--source` also checks the current source/assets/dependency bytes. It never executes the binary and establishes integrity, not origin or runtime qualification. Deterministic packaging is separate from Bun compiler reproducibility. The generated Homebrew formula uses the candidate's actual archive hash and the expected `github.com/vprodan/bosun` release location; it is for review and does not assert publication, install anything or activate a service. Compiled SQLite/hook/Orca behavior, performance and live installation remain separate ship gates.

The exact optional `react-devtools-core` peer is marked external because Ink resolves its development branch during bundling even when the peer is absent. The shared compiled entry sets `DEV=false` before lazy imports, keeping that debugger branch idle; its disposition is explicit in build flags/metadata. Source Node development retains `DEV`. This production policy does not make the external debugger a supported runtime feature.

The owner-approved entry-only checks passed5/5 on the hash-pinned distribution checkpoint: version/help, two private-hook rejections and MCP initialization/EOF. [Evidence](docs/research/checkpoints/2026-10-11-compiled-entry.log) binds the binary and older source digest. The newer 7,277-input current-source candidate passes static verification and awaits separate runtime qualification; this result does not qualify SQLite, hook delivery, TTY behavior or live installation.

Every application test uses the mandatory Node launcher/preload, fresh synthetic HOME, guarded paths, stub process effects and registered mock endpoints before application imports. Never run bosun tests under Bun. This contains trusted-application mistakes; it is not an OS sandbox, hostile-sameUID proof or live host/model qualification.

The [full goal and direct delivery plan](docs/plans/2026-10-06-bosun-v1.0-direct-delivery.md) retain all accepted scope. A green focused suite is not a complete release audit. No extra installation, personal configuration/authentication/database/LaunchAgent changes or live host/model/service probes are implied by development.

Extend pure policies and seven ports in `src/core`, boundary schemas in `src/contracts`, effects in `src/adapters`/`src/platform`, and composition in `src/app`. CLI, MCP, hook and dashboard share the authority and contracts. [ARCHITECTURE.md](ARCHITECTURE.md) describes the implementation; [policy.md](policy.md), [roles](roles) and [skills](skills) are shared assets.

The [historical README snapshot](docs/research/archive/2026-10-10-readme-legacy.md) retains the previous mixed documentation and development evidence. It is an exact historical copy, with links relative to the old repository-root location; its old installation/Kev commands are superseded.
