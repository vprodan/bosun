# Bosun corpus draft: source and relevance review

**HELD for independent gold correction (2026-10-11).** Do not execute or mark the pinned original draft reviewed-real under its pending approval. An independent source/scoring audit confirmed answer-bearing candidates omitted from support alternatives: for example, bosun_19_0 would score byte-identical m_bosun19b as irrelevant when only m_bosun19a is listed. All source hashes/citations still match; the gold completeness/graph duplication defects need a corrected reviewable corpus. The original draft and manifest remain unchanged. The detailed item audit is being completed in docs/research/checkpoints/2026-10-11-bosun-corpus-gold-audit.md/json. An approval reply to the old question cannot resolve these newly discovered defects; no evaluation has run.


Owner selected Bosun repository data. These 100 proposed questions use 20 hash-pinned source/product-doc files, with20 development and80 held-out cases and20 explicit negatives. Questions and relevance labels were authored from real repository text; they are not captured owner tasks. Topic groups are not native sessions. Owner source selection does not approve these labels. No model or evaluation has run.

The JSON remains deliberately outside the executable owner-reviewed evaluation schema until its scope and labels are reviewed. Exact support quotations and original file hashes/line references are included. A source/contract preflight may project the evidence field for validation without changing this pending draft or running an evaluation. Graph derivations and real vector/overview/summary quality remain separate work.

| ID | Split | Category | Question | Source / exact support |
|---|---|---|---|---|
| bosun_00_0 | development | identifier | Which host is the primary Bosun experience? | README.md: OpenCode is the primary host. |
| bosun_00_1 | development | paraphrase | Which native harness does the default Bosun workflow favor? | README.md: OpenCode is the primary host. |
| bosun_00_2 | development | preference | Does Bosun enable vector retrieval by default? | README.md: Vectors default off. |
| bosun_00_3 | development | current | What is the documented default state of optional vectors? | README.md: Vectors default off. |
| bosun_00_negative | development | negative | What AWS region stores the automatic S3 backups? | No supporting repository note expected |
| bosun_01_0 | development | current | What primary host does defaultConfig select? | src/core/domain/config.ts: primary: 'opencode' |
| bosun_01_1 | development | relationship | Which host is selected by the primary field of defaultConfig? | src/core/domain/config.ts: primary: 'opencode' |
| bosun_01_2 | development | summary | What threshold is used for the configured automatic handoff? | src/core/domain/config.ts: threshold: 0.7 |
| bosun_01_3 | development | identifier | What is the default numeric handoff threshold? | src/core/domain/config.ts: threshold: 0.7 |
| bosun_01_negative | development | negative | Which Discord webhook is provisioned during Bosun setup? | No supporting repository note expected |
| bosun_02_0 | development | summary | Which managed host controls start with telemetry and prompt admission? | src/core/ports/host.ts: \| 'contextTelemetry' |
| bosun_02_1 | development | paraphrase | What telemetry capability belongs to ManagedCapability? | src/core/ports/host.ts: \| 'contextTelemetry' |
| bosun_02_2 | development | rationale | Why must managed drivers join persistent processes during close? | src/core/ports/host.ts: Persistent native processes must join before daemon ownership is released. |
| bosun_02_3 | development | relationship | How is managed process cleanup related to release of daemon ownership? | src/core/ports/host.ts: Persistent native processes must join before daemon ownership is released. |
| bosun_02_negative | development | negative | How does the core train a custom tokenizer? | No supporting repository note expected |
| bosun_03_0 | development | identifier | Which environment setting chooses the Bosun runtime home? | src/platform/paths.ts: env.BOSUN_HOME |
| bosun_03_1 | development | paraphrase | How can the runtime home override the ordinary HOME fallback? | src/platform/paths.ts: env.BOSUN_HOME |
| bosun_03_2 | development | relationship | How does BOSUN_SOCKET override the socket under the run directory? | src/platform/paths.ts: env.BOSUN_SOCKET |
| bosun_03_3 | development | summary | Where is the default local socket derived when no socket override is supplied? | src/platform/paths.ts: env.BOSUN_SOCKET |
| bosun_03_negative | development | negative | What RabbitMQ exchange carries daemon jobs? | No supporting repository note expected |
| bosun_04_0 | heldout | rationale | Why can native runner registry construction happen before any host is selected? | src/app/native-runners.ts: Building the registry does not import an adapter |
| bosun_04_1 | heldout | paraphrase | Does constructing the runner registry start a server or inspect native auth? | src/app/native-runners.ts: Building the registry does not import an adapter |
| bosun_04_2 | heldout | relationship | Which enabled host provides a native quota source in this registry? | src/app/native-runners.ts: if (config.hosts.codex.enabled) sources.codex |
| bosun_04_3 | heldout | identifier | Where is the Codex quota source registered conditionally? | src/app/native-runners.ts: if (config.hosts.codex.enabled) sources.codex |
| bosun_04_negative | heldout | negative | Which Kubernetes operator scales Bosun workers? | No supporting repository note expected |
| bosun_05_0 | heldout | current | What admission result is returned for a blocked quota state? | src/core/use-cases/quota.ts: if (status.state === 'blocked') return { allowed: false, reason: 'quota' } |
| bosun_05_1 | heldout | paraphrase | Can a known blocked quota observation admit an agent job? | src/core/use-cases/quota.ts: if (status.state === 'blocked') return { allowed: false, reason: 'quota' } |
| bosun_05_2 | heldout | preference | Which explicit metadata option permits admission when quota evidence is unknown? | src/core/use-cases/quota.ts: metadata.allowUnknownQuota === true |
| bosun_05_3 | heldout | relationship | How does allowUnknownQuota interact with admission after the blocked-state check? | src/core/use-cases/quota.ts: metadata.allowUnknownQuota === true |
| bosun_05_negative | heldout | negative | What Stripe endpoint buys agent credits automatically? | No supporting repository note expected |
| bosun_06_0 | heldout | identifier | Which host control fences prompt admission during managed handoff? | src/core/use-cases/handoff.ts: await control.fenceAdmission |
| bosun_06_1 | heldout | relationship | Where does the handoff controller obtain its AdmissionFence? | src/core/use-cases/handoff.ts: await control.fenceAdmission |
| bosun_06_2 | heldout | current | When is the controller marked fenced relative to the native fence request? | src/core/use-cases/handoff.ts: fenced = true; |
| bosun_06_3 | heldout | paraphrase | Does the controller mark a fence attempt before awaiting the host acknowledgement? | src/core/use-cases/handoff.ts: fenced = true; |
| bosun_06_negative | heldout | negative | Which Android package receives background handoff push messages? | No supporting repository note expected |
| bosun_07_0 | heldout | identifier | Which OpenCode request field suppresses a reply during seeding? | src/adapters/hosts/opencode/control.ts: noReply: true |
| bosun_07_1 | heldout | paraphrase | How does the owned OpenCode seed request request no assistant reply? | src/adapters/hosts/opencode/control.ts: noReply: true |
| bosun_07_2 | heldout | current | Which managed method creates a fresh OpenCode destination from its source? | src/adapters/hosts/opencode/control.ts: async startFresh(source, signal) |
| bosun_07_3 | heldout | relationship | How is startFresh bound to a source and abort signal? | src/adapters/hosts/opencode/control.ts: async startFresh(source, signal) |
| bosun_07_negative | heldout | negative | What VMware image provides the managed OpenCode VM? | No supporting repository note expected |
| bosun_08_0 | heldout | identifier | Which native app-server method injects the owned Codex seed? | src/adapters/hosts/codex/control.ts: 'thread/inject_items' |
| bosun_08_1 | heldout | paraphrase | How is public bootstrap text inserted into a fresh owned Codex thread? | src/adapters/hosts/codex/control.ts: 'thread/inject_items' |
| bosun_08_2 | heldout | rationale | What independent read is used before seeded Codex readiness is acknowledged? | src/adapters/hosts/codex/control.ts: readRolloutSeed(owned.rollout, owned.seed.text) |
| bosun_08_3 | heldout | relationship | How is rollout seed readback bound to the owned transcript and exact seed text? | src/adapters/hosts/codex/control.ts: readRolloutSeed(owned.rollout, owned.seed.text) |
| bosun_08_negative | heldout | negative | Which Google Drive folder receives Codex transcript exports? | No supporting repository note expected |
| bosun_09_0 | heldout | preference | How strongly does the fixed lexical policy weight note titles? | src/core/lexical-memory.ts: titleWeight: 5 |
| bosun_09_1 | heldout | current | What numeric title weight is used by LEXICAL_MEMORY_POLICY? | src/core/lexical-memory.ts: titleWeight: 5 |
| bosun_09_2 | heldout | identifier | What excerpt width does the lexical memory policy select? | src/core/lexical-memory.ts: excerptChars: 240 |
| bosun_09_3 | heldout | summary | How many characters are used for lexical memory excerpts? | src/core/lexical-memory.ts: excerptChars: 240 |
| bosun_09_negative | heldout | negative | What PostgreSQL extension powers the lexical ranker? | No supporting repository note expected |
| bosun_10_0 | heldout | identifier | What predicate rejects public text that matches a credential shape? | src/core/secret-screen.ts: CREDENTIALS.some(pattern => pattern.test(text)) |
| bosun_10_1 | heldout | paraphrase | How does screenPublicText check its input against credential patterns? | src/core/secret-screen.ts: CREDENTIALS.some(pattern => pattern.test(text)) |
| bosun_10_2 | heldout | rationale | What rule prevents the credential screen from exposing a matched value? | src/core/secret-screen.ts: Never return, log or quarantine the matched value. Privacy classification is separate. |
| bosun_10_3 | heldout | current | Which rule keeps matched credential values out of logs? | src/core/secret-screen.ts: Never return, log or quarantine the matched value. Privacy classification is separate. |
| bosun_10_negative | heldout | negative | Which Vault namespace contains production signing keys? | No supporting repository note expected |
| bosun_11_0 | heldout | identifier | What order is used to sort scored context candidates? | src/core/use-cases/retrieve-context.ts: scored.sort((a, b) => b.score - a.score) |
| bosun_11_1 | heldout | paraphrase | Does context packing visit higher-scored candidates first? | src/core/use-cases/retrieve-context.ts: scored.sort((a, b) => b.score - a.score) |
| bosun_11_2 | heldout | relationship | How does the context packer test a line against its token budget? | src/core/use-cases/retrieve-context.ts: settings.budgetTokens |
| bosun_11_3 | heldout | summary | What configured budget limits packed context? | src/core/use-cases/retrieve-context.ts: settings.budgetTokens |
| bosun_11_negative | heldout | negative | What Elasticsearch cluster accepts context candidates? | No supporting repository note expected |
| bosun_12_0 | heldout | identifier | Which fields bind graph support to an original memory version and hash? | src/core/domain/graph.ts: export type GraphSupport |
| bosun_12_1 | heldout | summary | How does GraphSupport represent source provenance? | src/core/domain/graph.ts: export type GraphSupport |
| bosun_12_2 | heldout | relationship | Which fields describe a typed relation between two graph entities? | src/core/domain/graph.ts: export type GraphRelation |
| bosun_12_3 | heldout | paraphrase | How are relation endpoints, predicate and weight represented in the graph domain? | src/core/domain/graph.ts: export type GraphRelation |
| bosun_12_negative | heldout | negative | What Neo4j cluster holds the graph authority? | No supporting repository note expected |
| bosun_13_0 | heldout | preference | Does consolidation permit a remote API by default? | src/app/consolidation.ts: allowRemoteApi: false, ...options.policy |
| bosun_13_1 | heldout | current | What is the default allowRemoteApi value in the consolidation policy? | src/app/consolidation.ts: allowRemoteApi: false, ...options.policy |
| bosun_13_2 | heldout | identifier | Which policy value bounds outstanding consolidation work? | src/app/consolidation.ts: maxOutstanding: CONSOLIDATION_LIMITS.outstanding |
| bosun_13_3 | heldout | summary | Which consolidation limit is applied to maximum outstanding proposals? | src/app/consolidation.ts: maxOutstanding: CONSOLIDATION_LIMITS.outstanding |
| bosun_13_negative | heldout | negative | Which Azure function executes consolidation proposals? | No supporting repository note expected |
| bosun_14_0 | heldout | preference | When is the query cache consulted for an embedding query? | src/app/embeddings.ts: settings.queryCacheSize ? queries.get(key) : undefined |
| bosun_14_1 | heldout | paraphrase | Does a zero queryCacheSize consult an existing cached query? | src/app/embeddings.ts: settings.queryCacheSize ? queries.get(key) : undefined |
| bosun_14_2 | heldout | relationship | Which timestamp and vector fields are stored for a successful cached query? | src/app/embeddings.ts: queries.set(key, { at: performance.now(), vector }) |
| bosun_14_3 | heldout | identifier | Where is a completed query vector inserted into the cache? | src/app/embeddings.ts: queries.set(key, { at: performance.now(), vector }) |
| bosun_14_negative | heldout | negative | What Redis server owns the embedding query cache? | No supporting repository note expected |
| bosun_15_0 | heldout | current | Which unresolved lease phases prevent normal remote-view release? | src/app/remote-views.ts: ['pending', 'acquire-unknown', 'release-unknown'] |
| bosun_15_1 | heldout | identifier | What three remote lease states require reconciliation? | src/app/remote-views.ts: ['pending', 'acquire-unknown', 'release-unknown'] |
| bosun_15_2 | heldout | rationale | What instruction is returned when the original remote lease is unresolved? | src/app/remote-views.ts: Reconcile the original remote lease first |
| bosun_15_3 | heldout | paraphrase | Does an uncertain remote lease require reconciliation of the original receipt? | src/app/remote-views.ts: Reconcile the original remote lease first |
| bosun_15_negative | heldout | negative | What Cloudflare Worker replaces the remote authority? | No supporting repository note expected |
| bosun_16_0 | heldout | rationale | Why is the original router retirement intent recorded before backup and native effects? | src/app/upgrade-router.ts: Durable original retirement intent precedes backup/native effects. |
| bosun_16_1 | heldout | relationship | How is durable retirement intent ordered relative to service effects? | src/app/upgrade-router.ts: Durable original retirement intent precedes backup/native effects. |
| bosun_16_2 | heldout | current | Which adoption flag is preserved in the reviewed router retirement record? | src/app/upgrade-router.ts: adopted: true as const |
| bosun_16_3 | heldout | identifier | What literal adoption value is recorded for an accepted legacy router? | src/app/upgrade-router.ts: adopted: true as const |
| bosun_16_negative | heldout | negative | Which Docker registry contains the retired Kev image? | No supporting repository note expected |
| bosun_17_0 | heldout | identifier | Which exact legacy router launchd label may pass the service-label guard? | src/adapters/services/launchd.ts: value !== 'com.bosun.router' |
| bosun_17_1 | heldout | preference | Does the service-label guard permit arbitrary router labels? | src/adapters/services/launchd.ts: value !== 'com.bosun.router' |
| bosun_17_2 | heldout | relationship | What arguments identify an explicit launchd bootout operation? | src/adapters/services/launchd.ts: bootout(label: string, signal: AbortSignal) |
| bosun_17_3 | heldout | summary | How is a native service stop represented in LaunchdControl? | src/adapters/services/launchd.ts: bootout(label: string, signal: AbortSignal) |
| bosun_17_negative | heldout | negative | What Windows registry key manages the macOS launchd service? | No supporting repository note expected |
| bosun_18_0 | heldout | current | What explicit flag is required before replacing an existing binary? | src/app/installation.ts: if (previous && !input.replaceExisting) |
| bosun_18_1 | heldout | paraphrase | Can an existing binary be replaced without replaceExisting? | src/app/installation.ts: if (previous && !input.replaceExisting) |
| bosun_18_2 | heldout | rationale | What filesystem condition is required for an existing binary backup? | src/app/installation.ts: Existing binary backup requires the same filesystem |
| bosun_18_3 | heldout | relationship | How is supported backup of a replaced binary constrained by its filesystem? | src/app/installation.ts: Existing binary backup requires the same filesystem |
| bosun_18_negative | heldout | negative | What Debian package is installed by Bosun installation? | No supporting repository note expected |
| bosun_19_0 | heldout | identifier | Which command does an Orca pane run to observe its original queued job? | src/platform/watch-command.ts: job wait ${quote(jobId(id))} --timeout 300000 --progress |
| bosun_19_1 | heldout | paraphrase | Does the observer wait on a job rather than submit another agent task? | src/platform/watch-command.ts: job wait ${quote(jobId(id))} --timeout 300000 --progress |
| bosun_19_2 | heldout | relationship | Which inherited caller controls are removed in the observer command? | src/platform/watch-command.ts: -u BOSUN_CALLER -u BOSUN_DEPTH |
| bosun_19_3 | heldout | summary | How does the metadata pane launch clear caller and recursion controls? | src/platform/watch-command.ts: -u BOSUN_CALLER -u BOSUN_DEPTH |
| bosun_19_negative | heldout | negative | Which Slack bot starts a new observer job automatically? | No supporting repository note expected |


The pending JSON now contains **40 source notes and100 unreviewed graph candidates**:40 file/concept entities,20 file/topic related_to links,20 exact-source facts,10 supported summaries and10 supported profiles. Every candidate cites both original source-note IDs and exact excerpts. Overviews repeat those excerpts and bind their parents; no generated factual additions. Positive cases include fact/overview alternatives, each tied to its original support. The reviewed flags stay false and evidence stays review-pending. These are review candidates, not activated graph memory or quality results.
