# Native protocol fixture provenance

Checked 2026-10-05. JSON fixtures are compact **invented public test data**, not captured model runs, sessions, owner transcripts or databases. Field names/shapes follow the primary sources below. No dependency, host binary or model was installed or run.

## Native SQLite library qualification (2026-10-13)

Owner explicitly approved better-sqlite313.0.3, node-addon-api8.0.0 and Node22.16.0
headers as project-local native build inputs, not a Node runtime. Immutable
archive URLs/integrities, maintained authorizer/URI/control/owned-close patch,
binary and CLT fingerprints are in `scripts/sqlite-native-inputs.mts`.
The fork loads only `bosun_sqlite.node`; Bun1.4.3's historical filename rejection
does not justify using a stock prebuild or weakening API/lock assertions.
App-free qualification covers real close/FTS rollback, retained cursor rejection,
backup/error identity/exact filenames, UDF/authorizer reentry/reprepare and
integer/blob behavior. Source qualification passes1179/1179 across91 files plus
35/35 containment and typecheck0. Actual source hook/10k delivery joins pass;
live host/model/corpus and compiled-product gates remain unexecuted.
No GC, Bun-private pointer finalization, Node execution or personal activation.
See the newest HANDOFF for exact logs and the distinct native/product limits.

## Ollama Clef

[Decision guide](https://docs.ollama.com/capabilities/decision), [System One API](https://docs.ollama.com/api/systemone), [Clef-Flash card](https://ollama.com/library/clef-flash).

The API specifies one JSON response, named typed answers/probabilities/confidence, response model equal to request, and a 64 KiB non-image request bound. Clef requires Ollama 0.35.1+. Option order resolves ties. Confidence is concentration, not measured accuracy. Our numeric fixture is synthetic; it is not calibration evidence. The adapter's rounding tolerance, timeout, text cap and response cap are bosun policy. Catalog/readme context sizes disagree; this slice establishes no loaded-window, residency, latency or quality claim.

## OpenCode 2.0.27 metadata contract (2026-10-12)

The owner now targets OpenCode 2 only. The selected source commit is
`bcf23b6775c79a429b1511b255d6d88ab0248d4a`, whose CLI/client/plugin manifests
declare 2.0.27; the selected executable is `opencode2`. The new
`opencode-v2.0.27.json` fixture is invented public data, not a native capture.
The read-only probe now uses this contract directly, without V1 fallback.

- [Pinned OpenAPI](https://github.com/anomalyco/opencode/blob/bcf23b6775c79a429b1511b255d6d88ab0248d4a/packages/protocol/openapi.json): `/api/info` returns ServerInfo directly;
  session get/create return `{data: Session.Info}`; messages return `{data, cursor}`.
  Model.Ref uses `id/providerID/variant`, and permissions use ordered
  `action/resource/effect` rules. The specification's own `0.0.1` version is
  not the installed host version; the probe requires ServerInfo.version 2.0.27.
- [Message schema](https://github.com/anomalyco/opencode/blob/bcf23b6775c79a429b1511b255d6d88ab0248d4a/packages/schema/src/session-message.ts): projected messages use `type`,
  assistant `content` and `model`; they have no native sessionID/WithParts
  envelope. `streamed` precedes tool settlement, while an `idle` marker ends
  the turn. Streaming/running tools, failed/interrupted idle and control/reset
  messages cannot establish a completed usable observation.
- [Message handler](https://github.com/anomalyco/opencode/blob/bcf23b6775c79a429b1511b255d6d88ab0248d4a/packages/server/src/handlers/message.ts) and
  [store](https://github.com/anomalyco/opencode/blob/bcf23b6775c79a429b1511b255d6d88ab0248d4a/packages/core/src/session/store.ts): `order=desc` preserves native projection sequence,
  not timestamp sorting. Body cursors are opaque; they must not be treated as
  URLs or combined with `order` when paging. A first bounded page is not full
  evidence coverage, even if its cursor is absent.
- [Usage normalization](https://github.com/anomalyco/opencode/blob/bcf23b6775c79a429b1511b255d6d88ab0248d4a/packages/core/src/session/usage.ts): input is noncached input,
  output is visible output, and reasoning/cache counts are separate. The latest
  completed assistant's input+cache read+cache write is only an input candidate;
  accumulated session counts and output/reasoning are not qualified active occupancy.
- [Session handlers](https://github.com/anomalyco/opencode/blob/bcf23b6775c79a429b1511b255d6d88ab0248d4a/packages/server/src/handlers/session.ts): prompt returns an admitted inbox item,
  not synchronous inference completion. `resume:false` is a parked-input
  candidate, not the V1 `noReply`/stored-message acknowledgement. The active map
  covers only foreground drains in that server process; absence is not background
  tool quiescence. The `/view` operation marks an observed idle transition viewed,
  not destination UI selection.
- [Pinned authorization](https://github.com/anomalyco/opencode/blob/bcf23b6775c79a429b1511b255d6d88ab0248d4a/packages/server/src/middleware/authorization.ts): this source's password/pairing
  transport accepts Basic credentials. Do not infer Bearer support from a generic
  current-client example or migrate credentials. This metadata probe supplies no
  authentication and holds protected endpoints; authenticated runner/control
  composition remains subsequent work.

The V2 codec validates a bounded metadata subset, not every content schema. It
omits text/reasoning/tool payloads, arbitrary metadata, paths and cumulative
billing from its projections. The probe repeats opaque session scope/model/rule
bindings and server PID/version under one deadline, follows no returned URL or
cursor, and performs GET only. Its six controls and active-context samples remain
unverified/unknown. Pure root and parked-seed recipes are never sent by the probe;
they prove neither isolation nor an exact seed/readiness acknowledgement. The old
runner/control/profile code remains to port and retire; these fixtures do not
qualify live OpenCode, plugins, model access, automatic handoff, UI retargeting,
compiled behavior or performance. See the [V2 migration guide](https://opencode.ai/v2/docs/migrate-v1),
[API](https://opencode.ai/v2/docs/api) and [client guide](https://opencode.ai/v2/docs/build/client).

### OpenCode 2 task-runner port (2026-10-12)

`runner.ts` now imports only `v2-protocol.ts`/`v2-native.ts` for native execution.
`opencode-runner-fixture.ts` supplies invented public HTTP state; the original
runner regression assertions are reanchored to V2, not removed.

- [Native creation](https://github.com/anomalyco/opencode/blob/bcf23b6775c79a429b1511b255d6d88ab0248d4a/packages/core/src/session.ts) returns an existing session for a repeated caller ID.
  The runner therefore chooses one exact root ID and association nonce, verifies
  native metadata/model/location/permissions and empty history/inbox, and never
  adopts a returned foreign root or retries an uncertain create. Native scope,
  creation identity, metadata and rules are bound separately from mutable usage
  and update/idle timestamps.
- [Location middleware](https://github.com/anomalyco/opencode/blob/bcf23b6775c79a429b1511b255d6d88ab0248d4a/packages/server/src/location.ts) reads `location[directory]`, not the V1 `directory`
  query. The runner uses that explicit model-catalog location and native session
  binding for session operations. The [model handler](https://github.com/anomalyco/opencode/blob/bcf23b6775c79a429b1511b255d6d88ab0248d4a/packages/server/src/handlers/model.ts) waits for plugin activation;
  missing, disabled, ambiguous or changed selected catalog records/variants stay
  held. No default-model endpoint or provider/auth mutation is called.
- [Model resolver](https://github.com/anomalyco/opencode/blob/bcf23b6775c79a429b1511b255d6d88ab0248d4a/packages/core/src/model-resolver.ts) treats `default` as the no-variant sentinel;
  a same-named catalog variant cannot be selected faithfully and is held. Exact
  selected provider/native model ID and explicit variant survive creation and
  every assistant acknowledgement. A provider model ID/route alias from native
  configuration is not silently rewritten by bosun; selected catalog drift holds.
- [Permission composition](https://github.com/anomalyco/opencode/blob/bcf23b6775c79a429b1511b255d6d88ab0248d4a/packages/core/src/permission.ts) appends session rules after agent rules. The
  runner sends V2 deny-all plus native `read/glob/grep`, with `edit` only for edit
  jobs. [Tool snapshots](https://github.com/anomalyco/opencode/blob/bcf23b6775c79a429b1511b255d6d88ab0248d4a/packages/core/src/tool.ts) separate direct tools from Code Mode; denied `execute`
  excludes the latter. [Patch](https://github.com/anomalyco/opencode/blob/bcf23b6775c79a429b1511b255d6d88ab0248d4a/packages/core/src/tool/plugin/patch.ts) is named `patch`, not V1 `apply_patch`, and uses
  edit permission. [MCP resource tools](https://github.com/anomalyco/opencode/blob/bcf23b6775c79a429b1511b255d6d88ab0248d4a/packages/core/src/tool/plugin/mcp-resource.ts) have their own V2 permission actions;
  they remain denied without the old `read/mcp:*` exception. The model-tool
  allowlist is not an OS sandbox or qualification of arbitrary plugins/hooks.
- [Native prompt admission](https://github.com/anomalyco/opencode/blob/bcf23b6775c79a429b1511b255d6d88ab0248d4a/packages/core/src/session/session.ts) durably enqueues an item and wakes execution
  separately. The exact original ID/session/text/delivery and empty attachments
  must match its receipt and projected user message. Completion requires full
  bounded history ending at the original successful idle, completed permitted
  tools/assistants, exact model/agent, empty inbox, repeated unchanged history and
  bound inactive native scope. A parked input, disconnected client or successful
  HTTP receipt cannot produce `done`.
- [Execution interruption](https://github.com/anomalyco/opencode/blob/bcf23b6775c79a429b1511b255d6d88ab0248d4a/packages/core/src/session/execution.ts) acknowledges acceptance before asynchronous cleanup.
  One `interrupt?resume=false` follows a fresh process/scope binding check, then
  bounded native terminal/tool/inbox/inactivity observations. Either boolean
  interruption receipt is valid; neither proves settlement or rollback. Lost
  acknowledgement, malformed evidence, timeout and model/control drift remain
  unknown; no prompt retry, wake, history deletion or foreign inbox cancellation.

History pages preserve native sequence and encode only opaque body cursors at the
original endpoint, without `order` on subsequent pages. The native handler emits
cursor anchors even on short pages; the runner reaches an empty terminal page
rather than claiming coverage from a missing cursor. Per-page/source/message,
result/event, polling and total/cleanup deadlines are bosun's conservative bounds.
V2 usage sums each assistant step exactly once: noncached input+cache read+write;
output is visible output+separate reasoning. These are observed token categories,
not active occupancy, subscription accounting or a dollar-saving measurement.

Guarded fixtures cover positive durable jobs, cancellation/drain/restart,
deduplication, lost create/admission receipts, unavailable/drifting models,
foreign roots, altered inputs/results, paging/truncation and finite unknown
receipts. Construction remains inert and public/credential screening precedes
native access. Only configured loopback HTTP and explicitly supplied Basic
credentials are used; no discovery, SDK/service startup or credential borrowing.
Managed V1 control/evidence/helpers and old profiles/app branches still need their
direct port/cleanup. No live native provider, plugin, UI, host isolation, automatic
handoff, compiled or performance qualification follows from these synthetic tests.

Runner qualification: the full guarded Node checkpoint passed1161/1162 plus19
containment; the sole failure was a V1 controller test using the newly V2 runner's
rule helper. Its import is now bound to that controller's actual V1 helper, with
the original assertion retained. Post-correction affected suites pass321/321
plus19 containment, with typecheck/boundaries/whitespace clean. Full/source and
post-correction evidence are separate under
`docs/research/checkpoints/2026-10-12-opencode2-runner-`; no new full-green or
native/compiled qualification is inferred from combining those runs.

## OpenCode native v1.18.34 (historical port input)

Pinned release sources were available. The legacy `packages/sdk/js/src/gen/types.gen.ts` omits fields present in the actual server schema; **it is not this fixture's authority**. We follow v1 route groups and their v1 schema reexports within the same release. Internal core modules named V2 do not justify using a separate v2 HTTP/SDK example.

- [Global routes](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/server/routes/instance/httpapi/groups/global.ts) and [handlers](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts): GET `/global/health`; `/global/event` SSE `event: message` with JSON envelope/payload.
- [Session routes](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/server/routes/instance/httpapi/groups/session.ts): GET `/session/:sessionID` and `/session/:sessionID/message`; POST creation and prompt payloads.
- [v1 session schema](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/schema/src/v1/session.ts), through [core v1 reexport](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/core/src/v1/session.ts): SessionInfo, WithParts, Assistant, step-finish tokens, and `message.updated` properties **`{sessionID, info}`**. The global payload also has an event ID; unknown fields are not projected.
- [Session implementation](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/session/session.ts): creation model uses `id/providerID/variant`. `getUsage` removes cached input from the separate input count. Session usage accumulates and is not active occupancy.
- [Prompt](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/session/prompt.ts): prompt model uses `modelID/providerID`, separate `variant`, and `noReply`; the noReply branch returns the user message before the generation loop.
- [Processor](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/session/processor.ts): step-finish overwrites assistant usage with the current step and records step-finish usage. The candidate uses the latest completed assistant's last step input + cache read/write once, not accumulated session/older-step totals, output or `total`.

Codecs validate a deliberately bounded **metadata subset**, not every upstream text/tool/file schema or complete native support. Prototype version mismatch is held rather than silently upgraded. Latest input usage is only a candidate: effective window, prefix/body scope and live occupancy/reset semantics remain unverified. ContextSample stays unknown, with no fabricated zero/window. Read-only HTTP fixture success, a root creation response, and noReply serialization prove no prompt fence, tool quiescence, seed acknowledgement, ownership transfer or safe automatic handoff. Every managed capability remains unverified; Codex/Claude parity is still pending.

### Native AgentRunner (checked 2026-10-07)

`opencode-runner.test.ts` exercises actual guarded synthetic HTTP, including chunked native JSON completion and durable jobs abort/drain. [Session handlers](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts) return the synchronous prompt's WithParts; abort awaits native cancellation. [Run state](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/session/run-state.ts) and [status](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/session/status.ts) establish native interruption and idle removal. Directory routing uses the [instance middleware](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/server/routes/instance/httpapi/middleware/instance-context.ts). The [provider route](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/server/routes/instance/httpapi/groups/provider.ts) supplies connected models/variants.

[Permissions](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/permission/index.ts) merge session rules after agent rules and filter denied tools in [native LLM request preparation](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/session/llm/request.ts). Native write/apply_patch use edit permission; MCP resource tools use read patterns, separately denied by `mcp:*`. [External directory](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/tool/external-directory.ts) requires its own permission. The runner never sends deprecated prompt `tools`, which would replace session rules. Rules govern native tool access, not OS isolation or arbitrary plugin side effects. Body/time/result/poll bounds, the explicit default-variant policy and fixed errors are bosun policy; synthetic success does not qualify live provider behavior, subscription bridges, managed handoff or billing/context occupancy.

### Owned native session control (checked 2026-10-07)

The same pinned [creation schema/implementation](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/session/session.ts) accepts metadata, agent, model and permission rules, retaining them in SessionInfo. The native [message routes](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/server/routes/instance/httpapi/groups/session.ts) include full history and specific-message reads. [Prompt creation](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/session/prompt.ts) accepts explicit message/part IDs and returns the stored user message for `noReply=true` before the generation loop. These support a bosun-owned empty-root barrier and independent message/part/hash acknowledgement. Native status plus the schema's pending/running/completed/error tool parts support bounded wait/abort observations. `opencode-control.test.ts` uses invented HTTP state, including changed bindings, uncertain effects and native tools that remain running after client cancellation. It proves no live host behavior, cryptographic owner metadata, durable native prompt fence, plugin/background-job shutdown or effective occupancy. Every managed capability remains unverified; context samples never substitute catalog maxima or cumulative billing for an active window.

### Clef readiness and model identity (checked 2026-10-08)

The source-inspected metadata profiles are Ollama0.35.1 and0.40.0. [Pinned0.40 API types](https://github.com/ollama/ollama/blob/v0.40.0/api/types.go) define selected child-manifest digest/runner/format, distinct from the tag digest, plus loaded context/VRAM/expiry. The [0.40 decision handler](https://github.com/ollama/ollama/blob/v0.40.0/server/routes.go) uses the selected local runner's scoring interface and a64KiB text/schema bound; the [0.35.1 handler](https://github.com/ollama/ollama/blob/v0.35.1/server/routes.go) is a separately inspected profile. Current [System One docs](https://docs.ollama.com/api/systemone) still state GGUF-only and exclude MLX/Safetensors, while the newer source exposes multiple runner choices. Do not treat that older blanket restriction as an invariant across versions; actual scoring support remains a live qualification gate.

Readiness performs GET/api/version, GET/api/tags, metadata-only POST/api/show with the exact chosen model and verbose:false, then GET/api/ps. Status never pulls/warms a model or starts a service. It keeps catalog and loaded windows separate, excludes other model/template/system/message payloads, and reports only closed selected metadata. A configured digest pins the selected child; tag/child/loaded drift is held. Unknown or prerelease versions remain unverified. Reported VRAM/expiry do not prove residency on the owner's Mac.

The owner-reported Ollama0.40.4 single-manifest Clef response has `details.format: "safetensors"` and `details.runner: "mlx"` without `manifests`. The [0.40.4 API types](https://github.com/ollama/ollama/blob/v0.40.4/api/types.go) declare `ModelDetails.Runner` on the show response and a top-level runner on loaded process entries. Readiness reads that details runner for single-manifest models; an explicit selected child remains authoritative when manifests are present. Neither missing/unsupported runners nor malformed child selections fall back to an inferred MLX identity.

The final explicit classification validates public input/known credential patterns/byte bounds before metadata, uses one total deadline, and checks metadata again after the single decision. Missing/invalid/unverified/changed state yields no advice. Exact request model is preserved, with no runner override, fallback provider, download or autonomous delegation. Synthetic readiness/decision fixtures establish parser, privacy and failure behavior; calibration, warm/cold latency, GPU/energy and live model support remain unverified. The pure Kev retirement planner consumes reviewed config/service fingerprints and does not discover, stop, archive or rewrite actual services/configuration.

### Native Git workspaces (checked 2026-10-08)

Primary contracts: [worktree](https://git-scm.com/docs/git-worktree), [status](https://git-scm.com/docs/git-status), [config](https://git-scm.com/docs/git-config), [rev-parse](https://git-scm.com/docs/git-rev-parse) and [merge-base](https://git-scm.com/docs/git-merge-base). Existing standalone Git2.56.0 was used only on guarded temporary repositories. NUL porcelain/ignored status, fixed committed base, ownership/common-dir binding, lock and ancestry checks, filter-config refusal and disabled hooks were verified with native fixtures. Binary capture shares streamProcess rather than introducing another native termination loop. No live owner worktree, Orca IPC, host/model/service or deletion/prune action was run. These fixture contracts do not qualify hostile sameUID, power loss, another Git version or Orca UI support.

### Revision-bound native review (checked 2026-10-08)

Primary contracts: [diff](https://git-scm.com/docs/git-diff), [ls-files](https://git-scm.com/docs/git-ls-files), [attributes/filter behavior](https://git-scm.com/docs/gitattributes) and the existing worktree/status/config references. Git2.56.0 was exercised only in guarded temporary repositories. Fixtures qualify exact base/head/index/worktree/untracked/mode capture, metadata-before-scope checks, stored fingerprints, drift and known-credential/filter/budget holds, literal file batches and native SQLite linkage receipts. They do not qualify another Git version, real native model/vendor identity, arbitrary sameUID behavior, OS isolation, power loss, compiled/Bun/live or review quality. Verification-command evidence and PR fetching remain unfinished.

## Orca card CLI1.4.222 (2026-10-08)

Read-only inspection of the installed app bundle; no Orca executable, IPC, daemon startup, owner state or terminal was called. The selected /usr/local/bin/orca symlink points to /Applications/Orca.app/Contents/Resources/bin/orca, which launches the bundled CLI. The local build manifest identifies version1.4.222, commit9fdd90ffa7721e145f1353ad9fb9df2f70c31f43, darwin/arm64 and daemon protocol40. The bundled guide was decoded as literal JSON strings without importing installed code.

Primary files under /Applications/Orca.app/Contents/Resources, with SHA256:

| File | SHA256 |
|---|---|
| orca-local-build.json | 2d60fcf63bd9c7210c807c142123f543cd5133030025b38be8d827f65bd76c8e |
| app.asar.unpacked/out/cli/bundled-skill-guides.js | a1878ad3b297d2ea0e36ff7d3e4399de746c90e4871068fc1421d1a9ed0b2cae |
| app.asar.unpacked/out/cli/handlers/worktree.js | f07f2063f832aa25377ae3b6ee58684226b5416856256a8e258c8db108388f84 |
| app.asar.unpacked/out/cli/selectors.js | 6b47603cdb12ffee04606cc909ae08322223ec31a717852dc53f7fbc55de895f |
| app.asar.unpacked/out/shared/worktree/host-qualified-identity.js | 8ffa6fcef1be0793f283453138c42ae3c716eb926447fd0e0b49149f598c410c |

Additional source inspection: cli/cli-version.js, cli/format.js, cli/computer-format.js, shared/workspace-status-defaults.js and the packed out/main/index.js read directly through the ASAR header/ranges. Current/show/set success responses retain an ok/result.worktree envelope. Current lookup resolves from cwd; identity:local|<repoId>::<path> binds the execution host. Missing host identity is not local identity. worktree.set returns updated worktree metadata and supports workspace-status/comment without a version CAS. Default checkpoint IDs are todo/in-progress/in-review/completed; unknown/custom status support is not claimed.

Fixture data is invented and public. Native synthetic-process/Git/SQLite/UDS checks qualify bosun's parsing, request/checkout binding, no replay, lost-COMMIT recovery, public-input filtering and shutdown. They do not qualify the running Orca app, terminal/session identity, automatic handoff, hostile sameUID behavior, Bun/compiled behavior or latency. Configured Orca worktree defaults may run commands on create; create/terminal lifecycle support remains separate required work.

## Host setup contract refresh (2026-10-08)

Before implementing HostAdapter installation, searched and opened current primary documentation without running any native host command or reading auth. No configuration, plugin or dependency was installed.

[Codex agent guide](https://learn.chatgpt.com/docs/agent-configuration/subagents) documents discovered custom-agent TOML with name/description/developer_instructions and inherited settings. Its examples preserve explicit model/effort. The [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) still documents agents.<name>.config_file/description. These pages establish available documented forms, not which form the installed CLI accepts. The existing cached0.160 runner/app-server profile does not qualify the noticed installed0.161 setup. Match the local schema/version before activation, preserve model bindings, and keep Orca-managed hooks.json untouched.

[OpenCode agents](https://opencode.ai/docs/agents/) uses agent/mode/permission, while search also exposes a separate v2 guide using agents/permissions. [Configuration](https://opencode.ai/docs/config/) documents custom directory/file overlays and precedence. Keep the already pinned native1.18.34 HTTP profile separate from a newer configuration schema until source/version qualification. Project JSON/JSONC, provider, plugin and managed-policy precedence must survive installation.

[Claude plugin manifest](https://code.claude.com/docs/en/plugins-reference) defines .claude-plugin/plugin.json and conventional components; root CLAUDE.md is not loaded as plugin context. [Subagents](https://code.claude.com/docs/en/sub-agents) says plugin agents ignore hooks/mcpServers/permissionMode frontmatter; main-session modes can also override subagent permissionMode. Do not treat that field as an enforced read-only boundary. Native restriction qualification and shared admission remain required.

Next implementation: concrete version-bound HostAdapter role/skill/MCP/hook plans with exact manifest ownership and apply/undo; OpenCode primary, native Codex/Claude equally selectable. Existing lib/wire.ts global installers are retired runtime evidence, not a final installation path. No broader capability, loaded host, plugin trust or automatic session handoff has been established by this documentation refresh.

## Native profile source contracts (2026-10-08)

OpenCode1.18.34 [configuration loader](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/config/config.ts) loads custom files separately from directory traversal. Its custom-directory path performs npm package setup. Profile metadata therefore selects a file, not a new config directory. Exact v1 [config](https://raw.githubusercontent.com/anomalyco/opencode/v1.18.34/packages/core/src/v1/config/config.ts), [agent](https://raw.githubusercontent.com/anomalyco/opencode/v1.18.34/packages/core/src/v1/config/agent.ts), [skills](https://raw.githubusercontent.com/anomalyco/opencode/v1.18.34/packages/core/src/v1/config/skills.ts) and [MCP](https://raw.githubusercontent.com/anomalyco/opencode/v1.18.34/packages/core/src/v1/config/mcp.ts) schemas establish agent/model/variant/permission, explicit skill paths and local command/environment fields. Inherited native configurations retain their own behavior; this is no blanket no-install or policy-isolation claim.

[Codex skill guidance](https://learn.chatgpt.com/docs/build-skills) documents repository .agents/skills discovery and symlink following; skills.config is per-skill enablement, not proof of an added discovery directory. Generated repository links reuse canonical skills while leaving those overrides intact. Current [config reference](https://learn.chatgpt.com/docs/config-file/config-reference) documents native role config layers and stdio MCP values. The renderer remains pinned to0.160.0; no0.161 role/hook-schema compatibility is inferred from current docs. Read-only installed package inspection of /Users/edge/.codex/packages/standalone/current/codex-package.json and its current symlink confirms metadata version0.161.0, aarch64-apple-darwin, without a native invocation or auth read.

[Claude CLI reference](https://code.claude.com/docs/en/cli-reference) supports local plugin-directory and append-system-prompt-file arguments. The generated2.1.292 plugin uses the conventional skills/agents/.mcp.json layout already cited above; its role files omit plugin-ignored permission fields. Role/MCP/skill materialization, literal arguments and configuration preservation are synthetic fixtures. Neither generated flags nor valid JSON/TOML prove live tool restrictions, authentication, plugin trust or automatic managed handoff.


## Read-only diagnostics and foreground launch fixtures (2026-10-08)

The official [Codex configuration schema](https://learn.chatgpt.com/docs/config-schema.json), fetched through developers.openai.com/codex/config-schema.json, contains AgentRoleToml config_file/description and the role config-layer structure. It is current and unversioned; it does not establish installed0.161 compatibility or qualify live native role/tool/hook behavior. The existing0.160 renderer remains the only declared Codex profile version. No native executable, auth file or current session was called or inspected by this research.

Manual host launch uses the profile's already cited native arguments and strict version formats: OpenCode1.18.34, codex-cli0.160.0 and Claude2.1.292 (Claude Code). Guarded executable fixtures supply those public outputs and perform real Node foreground-process/stdin/exit/signal checks. Version drift, malformed responses, changed profiles/workspaces/receipts/executables hold before UI start; preview calls no native process. These fixtures are invented and do not prove live TUI, login, MCP activation, plugin trust, native hook control, managed tool quiescence or automatic handoff. No actual host or service was launched.


## Owned evidence paging/capture (2026-10-09)

Pinned [session handlers](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts) return bounded message pages and X-Next-Cursor; before requires limit. The adapter uses the opaque cursor against its original selected endpoint and never follows Link. [v1 part schema](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/schema/src/v1/session.ts) distinguishes text, reasoning, files and tool-state parts. Only admitted public text and content-free native references enter evidence windows; other payloads remain in source. [Processor usage](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/session/processor.ts) records current step usage; [overflow](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/session/overflow.ts) uses a separate total/input-output-cache formula and model-specific reserves. These sources do not establish the effective active-context denominator, live admission fencing or automatic handoff. Capability flags stay unverified. HTTP bodies/IDs/cursors/model outputs are invented synthetic fixtures; no actual native session or model was run.

## Upgrade SQLite URI inspection (2026-10-09)

Read-only primary source: [Node24.16.0 DatabaseSync::Open](https://github.com/nodejs/node/blob/v24.16.0/src/node_sqlite.cc#L873-L880) combines SQLITE_OPEN_URI with read-only/open-create selection. Closed-source preflight uses only an exact immutable=1&mode=ro URI; active WAL/SHM/journals are rejected and real write admission repeats schema/source validation before backup/migration. Synthetic fixtures verify unknown-schema files/modes stay unchanged, useful upgraded hook notes and URI containment. No live owner database or Bun qualification was performed.

## Owned Orca job observers (2026-10-10, historical Node checkpoint)

Read-only inspection reused the Orca1.4.222 bundled guide, selectors and packed main runtime, without executing the CLI, contacting IPC or reading personal state. The local terminal handler SHA256 is `f49e62534822f86e4e42e1e050880dc8a03e099b4ff0c4b91e3b6887636cae0e`; terminal-format is `b4627e8206f082a0939efe3c2287d8667de4d67505e66f5c2d576d952b31f842`. Both files are under the previously identified installed app bundle's `app.asar.unpacked/out/cli` directory.

`terminal.show` returns `result.terminal`; the inspected terminal summaries identify handle, worktreeId, worktreePath, executionHostId and connected state. Missing host identity remains unknown. Explicit `terminal split --terminal <handle> --direction horizontal --command <observer>` returns `result.split.handle`. `terminal create --worktree identity:local|<id> --title <fixed-title> --command <observer>` returns `result.terminal.handle`. Both effects receive independent metadata-only worktree/terminal inspection after their response; terminal previews, titles and tool payloads are discarded. A source-inspected worktree binding does not register a new Git worktree with Orca or qualify arbitrary configured creation defaults.

The pane command observes an already queued durable job through the existing CLI/daemon authority. It contains literal quoted job/runtime/source-session identifiers and the pinned Node/source entry; it carries no task body, selected model, result, tool output or credentials. A finite4096-receipt intent is durable before the native terminal effect; ambiguous effects and recovered pending intents are held and never repeated. Ownership and current job/workspace binding are checked at effect entry. Closing a pane and timing out a client observation do not cancel, release or resubmit the job. Existing-job wait/get/result commands remain the supported observation path when a pane cannot start.

Guarded fixtures use an invented local CLI process and temporary executable/entry identities through a trusted composition factory. Separate actual source CLI calls exercise job wait, state progress, final-result selection and finite timeout behavior under containment. These checks qualify bosun's parsing, privacy, original request linkage, capacity, lost-COMMIT/restart behavior and process shutdown. They do not qualify real Orca UI/terminal behavior, installed/compiled observers, hostile sameUID races, Bun, power loss, performance or native handoff. No test containment exception, live service/host/model call or installation was introduced.

The watch receipt seals the original job execution cwd separately from the canonical Git/Orca root. Subdirectory run callers retain that exact cwd in the native specification; whole-checkout review retains its existing revision-bound root. Synthetic CLI regressions verify both while preserving cross-checkout/common-dir/project admission. Source entry identity is checked again at terminal effect entry after asynchronous preflight, so entry drift produces no pane effect.


## Codex owned managed-session fixtures (2026-10-11)

The guarded Node executable in test/codex-control.test.ts derives fresh root, full-turn hydration, background inventory and injection shapes from the tagged [0.160.0 thread schema](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server-protocol/schema/typescript/v2/Thread.ts), [thread Rust protocol](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server-protocol/src/protocol/v2/thread.rs) and [upstream injection tests](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server/tests/suite/v2/thread_inject_items.rs). Private invented JSONL uses [session metadata](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/protocol/src/protocol.rs) and [rollout serialization](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/history/src/rollout_payload.rs). Raw assistant output_text is persisted with no model turn; empty injection response alone is insufficient seed proof.

No installed native executable, personal config/auth or model is used. Six production flags remain unverified; full history is accepted only for the bounded legacy root, private exact returned transcript and locally admitted original turns. Model reroute, compaction, unknown history/tool schemas and lost receipts remain held. Current-step token usage is reported as unknown occupancy, not cumulative active context. These fixtures prove source composition and process/receipt handling only; native ingress/tool isolation, effective occupancy, retention and UI qualification remain open.

## OMP18.10.3 native source contract (2026-10-13)

The installed bundled version was inspected without invocation. Public tag18.10.3
binds commit `81e1d8927a3c16cfaff2e9456baa8c060e1e0e9b`; the adapter refuses another
version rather than translating another host's model or adopting an existing session.

- [RPC mode](https://github.com/can1357/oh-my-pi/blob/81e1d8927a3c16cfaff2e9456baa8c060e1e0e9b/packages/coding-agent/src/modes/rpc/rpc-mode.ts) uses correlated custom JSONL commands, native ready/protocol negotiation, v2 chunks and independent get_state/get_entries. It is not JSON-RPC2. A local prompt response with agentInvoked:false is its original response, not an invented prompt_result or settlement receipt.
- [Extension API](https://github.com/can1357/oh-my-pi/blob/81e1d8927a3c16cfaff2e9456baa8c060e1e0e9b/packages/coding-agent/src/extensibility/extensions/types.ts) exposes exact session manager, model/thinking, native tool provenance, idle/queue/async observations and lifecycle hooks. Bosun emits an owned nonce-bound bridge with admission/fence/seed/readiness/run commands; void sendMessage/sendUserMessage calls are not independent success receipts.
- [Native session](https://github.com/can1357/oh-my-pi/blob/81e1d8927a3c16cfaff2e9456baa8c060e1e0e9b/packages/coding-agent/src/session/agent-session.ts) independently persists a triggerTurn:false seed. Bosun reads exact seed content/hash/model/tools/policy and an idle native root before readiness. Literal user admission bypasses slash/template handling, and the before-inference hash holds model-mention/input drift.
- Ordinary native input has no trusted privacy field. A leading per-input #public token alone admits the bounded bosun hook request; private/unmarked/attachment inputs omit context. Exact input/session matching and one-time consumption prevent stale context reuse. Producer stdout completion does not establish host consumption or lease qualification.

`omp-native-fixture.ts` executes the actual generated bridge in a guarded Bun
subprocess against invented native session APIs and provider output. Regressions
cover distinct seeded roots, original literal turns/process joins, lost receipts,
private/foreign/altered history, unsolicited selection events, async work and
secret echoes without replay or success leakage. `omp-host.test.ts` executes the
ordinary emitted extension. All six production managed capabilities stay
unverified; occupancy remains estimated/unknown, not observed active-total.
No real OMP/model/auth/service call, installation or UI qualification occurred.

## OpenCode2 profile/plugin port (2026-10-13)

The retained2.0.27 pin above now also supplies the native profile/launch contract:
[config](https://github.com/anomalyco/opencode/blob/bcf23b6775c79a429b1511b255d6d88ab0248d4a/packages/schema/src/config.ts),
[agent](https://github.com/anomalyco/opencode/blob/bcf23b6775c79a429b1511b255d6d88ab0248d4a/packages/schema/src/config/agent.ts),
[model selection](https://github.com/anomalyco/opencode/blob/bcf23b6775c79a429b1511b255d6d88ab0248d4a/packages/schema/src/config/model.ts),
[MCP](https://github.com/anomalyco/opencode/blob/bcf23b6775c79a429b1511b255d6d88ab0248d4a/packages/schema/src/mcp.ts)
and [plugin source loading](https://github.com/anomalyco/opencode/blob/bcf23b6775c79a429b1511b255d6d88ab0248d4a/packages/core/src/config/plugin/source.ts).
Profiles use agents/system/ordered permissions, explicit structured model/variant,
skills arrays, mcp.servers with direct tools, and a configured local plugin directory.
V1 fields are not emitted and another native version is rejected.

The [Promise session hooks](https://github.com/anomalyco/opencode/blob/bcf23b6775c79a429b1511b255d6d88ab0248d4a/packages/plugin/src/effect/session.ts)
admit marked public prompt text, then bind one provider-context insertion to the
exact original session/message ID/text. [Native message lowering](https://github.com/anomalyco/opencode/blob/bcf23b6775c79a429b1511b255d6d88ab0248d4a/packages/core/src/session/runner/to-llm-message.ts)
retains that user ID. Private metadata, attachments, changed/later messages and
stale results omit context. The [standalone child](https://github.com/anomalyco/opencode/blob/bcf23b6775c79a429b1511b255d6d88ab0248d4a/packages/cli/src/services/standalone.ts)
inherits the exact reviewed config overlay, avoiding an unrelated existing service.

Final guarded source verification:242/242 tests across13 files,29/29 containment,
typecheck and separate OMP/OpenCode2/fenced-tool smokes. Evidence prefix
`docs/research/checkpoints/2026-10-13-omp-four-host-`. Integrated storage/profile
apply/managed/full-runtime checks remain held by Bun SQLite qualification; native
tool/ingress/active-context/MCP/UI/retention, real quality and compiled release
checks remain separate prerequisites. No live qualification is inferred.

## Bun source check/observer cutover (2026-10-13)

`src/platform/watch-command.ts` now owns pinned Bun1.4.3/darwin-arm64 source
observation and the exported named `JobObserver` contract. Repeated executable/
entry identity, literal quoted paths and metadata-only original-job polling are
unchanged; startup adds `--no-env-file --no-install`, with no Node alias/fallback.
The existing native Orca1.4.222/protocol40 inspection above is unchanged, not
a fresh live UI qualification.

Explicit checks admit Bun executable names/shebangs while preserving selected
file identity/hash/race checks, literal arguments, filtered inherited environment,
private HOME and original unknown/nonreplay receipts. `bunx` remains unsupported.
Checks are trusted owner commands, not sandboxed programs or universal transitive
configuration detection; startup flags must be chosen explicitly.
Mutable builtin-object process dispatch preserves the existing fixture envelope
under Bun without weakening the child-identity guard.

Evidence prefix `docs/research/checkpoints/2026-10-13-bun-command-`:
admission-before reproduces both old gates; final-regressions passes9/9 check and
15/15 Orca cases with five full-memory cases explicitly unexecuted; affected
passes242/242 across13 files; containment29/29 and typecheck pass. Final-smoke
runs an actual Bun verification process with literal arguments/private HOME/no
inherited credential, joins it, opens one synthetic pane for one original job
and executes actual metadata CLI polling through only `job.get`. No task/result/
tool output leaks into that observation. Native Orca and SQLite-memory
qualification remain false; live/compiled/corpus/runtime gates remain held.
