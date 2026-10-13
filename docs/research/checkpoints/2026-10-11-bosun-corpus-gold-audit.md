# Bosun corpus: independent gold and source audit

The source snapshots are intact. Gold labels need correction before this corpus can support a release-quality evaluation. This audit inspected every selected file mapping, all 40 notes, all 100 cases and all 100 graph proposals. It is a second-agent research review; owner gold/graph approval remains pending. No evaluation, model, native host, download or installation ran. The pinned draft and manifest were unchanged. The root coordinator held the proposal during this audit; this agent did not edit it.

Input SHA256: draft `b7077bb5a2013c21ab04b490f50c1a671ebf72ab9662423646d093a7e86afa1d`; manifest `3a1ccda37e44c4017310ad449664bc59f14390ec722875cfba99af7a8e37c8a3`; review proposal `29149557195e5e236326d0c7090659a67b6d20681d979ed2476194637ce53910`. The machine-readable [item-by-item audit](2026-10-11-bosun-corpus-gold-audit.json) contains exact citations, all candidate IDs, source hashes and proposed corrections.

## Provenance and counts

All 20 files (203049 bytes), all 40 note bodies and all 40 cited quotations match their selected snapshots. All 200 graph support references point to exact original-note/source text. Graph parent and relation endpoint bindings are valid. The draft correctly describes local uncommitted repository data at base `4adb3b4`, not committed public content. The manifest records origin returned 404; this offline audit did not recheck public hosting.

There are 100 unique query strings: 20 development/80 held-out, with 80 positive and 20 negative cases. Those 80 positives represent 40 distinct gold assignments, each repeated as a paraphrase pair. Graph has 100 proposals but only 20 distinct texts: each topic repeats its two excerpts across a file entity, concept entity, link, fact and overview. Kinds are 40 entities, 20 relations, 20 facts, 10 summaries and 10 profiles. All 100 reviewed flags remain false.

## Findings that change the next action

- **F01 — Incomplete quote alternatives can receive full-grade credit without containing the requested answer.** Original note context generally contains the answer; fact/overview alternatives retain only the narrow gold fragment. Visible evidence scoring tests that fragment by string inclusion, so it can credit an incomplete answer. See each case correction for exact snapshot replacement spans.

- **F02 — Two causal questions are labelled with ordering-only evidence.** Rephrase to ordering, or add an independently cited causal source and re-review. Do not invent a reason from the native ownership/recovery design.

- **F03 — Forty-two positive cases omit answer-equivalent original notes.** The scoring code rejects the other note ID even where it carries the complete same answer (bosun_19_0 is byte-identical). Do not add a duplicate as a separately required support group: that would demand two copies. Prefer remove/trim overlapping windows to one authoritative candidate per fact, or explicitly design same-fact curated-ID alternatives if preserving duplicates.

- **F04 — Navigation graph nodes repeat the answer but are omitted from graph alternatives.** All 80 positives omit file/topic/link IDs with the same text; for the narrow adequate-quote cases the text actually answers the question. Level 2 candidates are emitted by the C source if owner approved and seeded. Gold scoring treats those IDs as irrelevant. Prefer retain entity/relation navigation metadata and remove copied answer text, or owner-review explicit legitimate graph alternatives. For incomplete quote cases, fix content first rather than adding more insufficient alternatives.

- **F05 — Nominal 100 queries reduce to 40 positive gold assignments and 20 copied graph texts.** Each gold assignment has two paraphrases; all five graph candidates per topic have identical text. One pair of source bodies is identical (19a/b), one contains the entire other (05a/b). Paired statistics must remain source/topic clustered, not claim 80 independent positive facts. This is a corpus-design limitation, not evidence of forbidden tuning or cross-split ID leakage.

- **F06 — Category names do not supply the accepted semantic coverage.** All 9 summary cases are narrow single-fact lookups; all 15 relationship cases have one support group and no required two-hop chain; all 11 current cases have no competing old snapshot; four of seven rationale questions ask what/read/rule/condition rather than why, and the other two causal why questions need evidence. Graph contains 20 disconnected file-topic edges and no fact endpoint, so traversal is not necessary to answer these questions. Add representative reviewed cases for broad summary, temporal conflict, causal rationale, ambiguous in-domain negatives and two-hop associations without changing held-out thresholds based on observed results.

- **F07 — Twenty negatives are all external-platform absence queries.** All 20 selected-source keyword scans are empty and the manual query review finds no answer in the corpus. Empty support is consistent, but these easy out-of-domain negatives do not test in-domain ambiguity, obsolete conflicting facts or wrong scopes. Near-miss/ambiguous cases need separate owner-reviewed labels; do not claim the private/scope/retention policy gates from this public project-only corpus.

- **F08 — All five fenced-transfer graph texts reverse the two source fragments.** Graph text lists await control.fenceAdmission then fenced=true. Source has fenced=true at 337 before await at 338. It is labelled as excerpts, not an explicit execution sequence, but cannot safely provide ordering evidence. Use the contiguous 337–338 span.

- **F09 — Snapshot source integrity is proven; owner-authored/approved task evidence and native quality are not.** Owner selected Bosun repository data. Origin returned 404 is recorded in the manifest and was not re-requested in this offline audit. Questions are Codex-authored from local uncommitted snapshots, not captured owner tasks or native sessions; evidence and reviewed flags deliberately remain pending. Owner approval must explicitly cover revised gold and graph derivatives. Do not claim public reachability, owner label approval, model quality, compilation, latency or native qualification from this audit.

## Exact quote corrections

The following 19 cases have supported original-note context, but their current narrow quote and graph alternatives omit information the query asks for. Replace the gold/support/alternative fragments together, or drop the inadequate graph alternative. The source references below point to the immutable snapshot, not evolving production lines. Two additional causal questions need rephrasing or new causal evidence.

| Case | Snapshot source | Required correction |
|---|---|---|
| bosun_02_0 | [src/core/ports/host.ts:31](bosun-corpus-2026-10-11/sources/src/core/ports/host.ts) (through 37) | The question asks plural controls; the current gold and graph text quote only contextTelemetry, omitting promptAdmission and the rest of the list. |
| bosun_03_1 | [src/platform/paths.ts:22](bosun-corpus-2026-10-11/sources/src/platform/paths.ts) (through 22) | The identifier alone does not state the override or HOME/homedir fallback order. |
| bosun_03_2 | [src/platform/paths.ts:22](bosun-corpus-2026-10-11/sources/src/platform/paths.ts) (through 26) | env.BOSUN_SOCKET alone cannot state the run-directory fallback; the query in _2 already names BOSUN_SOCKET. |
| bosun_03_3 | [src/platform/paths.ts:22](bosun-corpus-2026-10-11/sources/src/platform/paths.ts) (through 26) | env.BOSUN_SOCKET alone cannot state the run-directory fallback; the query in _2 already names BOSUN_SOCKET. |
| bosun_04_0 | [src/app/native-runners.ts:9](bosun-corpus-2026-10-11/sources/src/app/native-runners.ts) (through 10) | The truncated quote omits auth/probe/server/directory behavior required by the question; the original note retains it. |
| bosun_04_1 | [src/app/native-runners.ts:9](bosun-corpus-2026-10-11/sources/src/app/native-runners.ts) (through 10) | The truncated quote omits auth/probe/server/directory behavior required by the question; the original note retains it. |
| bosun_04_3 | [src/app/native-runners.ts:36](bosun-corpus-2026-10-11/sources/src/app/native-runners.ts) (through 38) | The condition alone omits the nativeQuotaSources function needed to answer where registration occurs. |
| bosun_05_3 | [src/core/use-cases/quota.ts:58](bosun-corpus-2026-10-11/sources/src/core/use-cases/quota.ts) (through 60) | The flag alone omits the admitted outcome and blocked-before-unknown branch order. |
| bosun_06_2 | [src/core/use-cases/handoff.ts:337](bosun-corpus-2026-10-11/sources/src/core/use-cases/handoff.ts) (through 338) | The quote fenced=true alone does not prove order. Graph text concatenates the await-fence snippet first, reversing their source order and risking the opposite answer. |
| bosun_06_3 | [src/core/use-cases/handoff.ts:337](bosun-corpus-2026-10-11/sources/src/core/use-cases/handoff.ts) (through 338) | The quote fenced=true alone does not prove order. Graph text concatenates the await-fence snippet first, reversing their source order and risking the opposite answer. |
| bosun_11_2 | [src/core/use-cases/retrieve-context.ts:256](bosun-corpus-2026-10-11/sources/src/core/use-cases/retrieve-context.ts) (through 256) | The budget variable name omits the char/4 equation, candidate length and skip condition. |
| bosun_12_0 | [src/core/domain/graph.ts:6](bosun-corpus-2026-10-11/sources/src/core/domain/graph.ts) (through 6) | The type name omits memoryId/version/hash and optional span fields requested by the question. |
| bosun_12_1 | [src/core/domain/graph.ts:6](bosun-corpus-2026-10-11/sources/src/core/domain/graph.ts) (through 6) | The type name omits memoryId/version/hash and optional span fields requested by the question. |
| bosun_12_2 | [src/core/domain/graph.ts:9](bosun-corpus-2026-10-11/sources/src/core/domain/graph.ts) (through 9) | The type name omits relation endpoints, predicate and weight requested by the question. |
| bosun_12_3 | [src/core/domain/graph.ts:9](bosun-corpus-2026-10-11/sources/src/core/domain/graph.ts) (through 9) | The type name omits relation endpoints, predicate and weight requested by the question. |
| bosun_17_0 | [src/adapters/services/launchd.ts:19](bosun-corpus-2026-10-11/sources/src/adapters/services/launchd.ts) (through 20) | value !== 'com.bosun.router' omits the conditional rejection and allowed daemon-label pattern; alone it can read as rejecting the legacy label. |
| bosun_17_1 | [src/adapters/services/launchd.ts:19](bosun-corpus-2026-10-11/sources/src/adapters/services/launchd.ts) (through 20) | value !== 'com.bosun.router' omits the conditional rejection and allowed daemon-label pattern; alone it can read as rejecting the legacy label. |
| bosun_18_0 | [src/app/installation.ts:160](bosun-corpus-2026-10-11/sources/src/app/installation.ts) (through 162) | The conditional fragment omits the conflict/deny behavior needed to establish that replacement consent is required. |
| bosun_18_1 | [src/app/installation.ts:160](bosun-corpus-2026-10-11/sources/src/app/installation.ts) (through 162) | The conditional fragment omits the conflict/deny behavior needed to establish that replacement consent is required. |
| bosun_02_2 | [src/core/ports/host.ts:73](bosun-corpus-2026-10-11/sources/src/core/ports/host.ts) | The comment gives a required join-before-release ordering, not why the requirement exists. A causal answer would be an analyst inference. Proposed: When must managed drivers join persistent processes relative to releasing daemon ownership? |
| bosun_16_0 | [src/app/upgrade-router.ts:184](bosun-corpus-2026-10-11/sources/src/app/upgrade-router.ts) | The comment gives durable-before-backup/native ordering, not why. The code provides effects but no explicit causal justification. Proposed: When is the router retirement intent recorded relative to backup and native effects? |

For bosun_06_2/_3 specifically, the source sets `fenced = true` at 337 before `await control.fenceAdmission(...)` at 338. Every g_bosun06* text lists these fragments in the opposite order. Use a contiguous source span to avoid implying the wrong execution sequence.

## Relevance scoring evidence

The audit checked the actual evaluation semantics. `supportChoices` in [evaluate-memory.ts](../../../src/core/use-cases/evaluate-memory.ts) contains a support note ID and its graph alternative IDs. `visibleSupportIds` additionally requires that exact candidate ID and its quote. `packedPrecision` counts only those candidate IDs as relevant. Thus returning m_bosun19b for bosun_19_0 receives no evidence credit although its body is byte-identical to the expected m_bosun19a. Forty-two positive cases have this original-note omission; every affected ID is recorded in JSON.

The [C arm](../../../src/app/memory-evaluation.ts) selects graph levels1 and2; [graph source](../../../src/adapters/memory/sqlite-graph.ts) emits entity and relation text. Each file/topic/link candidate repeats the same text as the labelled fact/overview, yet is excluded from supportChoices. All 80 positives have these copies;59 narrow-quote cases have complete answer-bearing omitted graph text. The21 other cases first need quote/rationale correction. This is a potential scoring defect after reviewed import, not a claim that pending graph candidates are live.

Do not blindly add every topical node to gold. Prefer one authoritative source candidate per fact and concise navigation-only entity/relation metadata. If preserving equivalent curated notes, the current schema cannot express a same-fact curated-ID alternative; adding a second required support group would incorrectly demand both copies. Graph alternatives can name legitimately complete graph answers, but owner review must cover each.

## Split, category and negative coverage

The corpus meets the numeric 100-query minimum, with 100 unique strings, 20 development/80 held-out cases and 20 negatives. It uses real source bytes selected by the owner. It does not yet meet owner-reviewed gold or representative semantic coverage. The 64 held-out positives contain 32 distinct gold assignments within 16 source/topic clusters. Source-clustered uncertainty is appropriate; 100 query strings cannot be treated as 100 independent facts. The accepted query count does not require 80 distinct positive facts. The separate 12-session handoff qualification is unrelated and is not fulfilled by these topic groups.

There is no sourceGroup/sessionGroup overlap between the four development and16 held-out topic groups, no duplicate normalized query, and no identical note body crossing the split. Paraphrase pairs stay together. This establishes the documented file/topic split, not independent native sessions or owner-authored task history. Three evolving source files differ from the snapshots (README, host contract and handoff); all 40 gold quote strings are still present in current source. No changed-answer stale claim was found. Preserve the snapshots and identify their historical generation.

The executable schema checks all eight category names but cannot establish their semantics. All 9 summary queries are single-fact lookups, all 15 relationship queries have one support group and no required two-hop association, and all 11 current queries lack a competing old version. Most rationale labels are conditions/read methods/rules rather than causal explanation; two actual why questions have only ordering evidence. The graph contains 20 isolated file↔topic edges; facts and overviews are not edge endpoints. It does not force graph traversal to answer these questions. Repeating a fact as a profile/summary supplies no evidence of durable preference handling or broad synthesis quality.

All 20 negative platform terms are absent from all 20 complete snapshots, and manual review finds no supporting corpus answer. Their empty labels are consistent within this frozen corpus. Every negative assumes an absent outside platform (AWS/S3, Discord, tokenizer training, RabbitMQ, Kubernetes, Stripe, Android, VMware, Google Drive, PostgreSQL, Vault, Elasticsearch, Neo4j, Azure, Redis, Cloudflare, Docker, Windows registry, Debian or Slack). Add reviewed in-domain ambiguity/near-miss/obsolete-memory cases. This project-only public corpus cannot replace separate policy/retention canaries.

Three especially answer-cued questions are bosun_03_2 (BOSUN_SOCKET), bosun_07_3 (startFresh/source/signal) and bosun_12_1 (GraphSupport). Their current quote mostly repeats information in the question; require the actual fallback/binding/provenance behavior. Ordinary identifier overlap is expected in a retrieval task and is not, by itself, train/test leakage.

## Executable schema and release requirements

The raw draft is intentionally rejected by the strict executable schema: the outer wrapper is not a dataset, evidence remains review-pending and graph reviewed remains false. Required counts, item privacy/scope, groups, IDs, kinds and bindings are present. Original file hashes and line citations live in the review provenance/manifest; preserve them when preparing a separately reviewed executable export. This audit did not project approved flags or run validation through project code.

The accepted [memory design §6.7](../07-graph-memory.md) requires representative rationale, two-hop relationships, current-vs-old, broad summaries and ambiguous/no-memory cases, fixed A/B/C and incremental D/E comparisons, paired uncertainty, misses and zero-overlap review. Actual400 host tokens, compiled warm latency, graph-stage budget, private/scope/expiry/revocation/purge checks, physical model/vector measurements and review burden remain separate evidence. The roadmap ship gate (`../../plans/2026-10-01-bosun-v1.0-roadmap.md`; historical citation, recover via `21d5dc6:PATH`) requires the quality/performance work to be completed with a recorded activation disposition; this audit does not satisfy it.

## Complete case inventory

Every case is listed below; JSON includes full questions, expected facts, exact support bindings and all omitted answer-bearing IDs. “Quote gap” means original note context is generally valid but the scored fragment/graph copy is insufficient. “Ordering only” identifies unsupported causal wording. “Supported” covers the narrow lookup only and does not approve its labels.

| Case | Split / category | Source evidence | Assessment |
|---|---|---|---|
| bosun_00_0 | development / identifier | README.md:3 (m_bosun00a) | Supported narrow lookup |
| bosun_00_1 | development / paraphrase | README.md:3 (m_bosun00a) | Supported narrow lookup |
| bosun_00_2 | development / preference | README.md:92 (m_bosun00b) | Supported narrow lookup |
| bosun_00_3 | development / current | README.md:92 (m_bosun00b) | Supported narrow lookup |
| bosun_00_negative | development / negative | Full20-source absence review | Consistent bounded negative; easy outside-platform query |
| bosun_01_0 | development / current | src/core/domain/config.ts:153 (m_bosun01a) | Supported narrow lookup |
| bosun_01_1 | development / relationship | src/core/domain/config.ts:153 (m_bosun01a) | Supported narrow lookup |
| bosun_01_2 | development / summary | src/core/domain/config.ts:196 (m_bosun01b) | Supported narrow lookup |
| bosun_01_3 | development / identifier | src/core/domain/config.ts:196 (m_bosun01b) | Supported narrow lookup |
| bosun_01_negative | development / negative | Full20-source absence review | Consistent bounded negative; easy outside-platform query |
| bosun_02_0 | development / summary | src/core/ports/host.ts:32 (m_bosun02a) | Quote gap; expand exact span |
| bosun_02_1 | development / paraphrase | src/core/ports/host.ts:32 (m_bosun02a) | Supported narrow lookup |
| bosun_02_2 | development / rationale | src/core/ports/host.ts:73 (m_bosun02b) | Ordering only; revise why |
| bosun_02_3 | development / relationship | src/core/ports/host.ts:73 (m_bosun02b) | Supported narrow lookup |
| bosun_02_negative | development / negative | Full20-source absence review | Consistent bounded negative; easy outside-platform query |
| bosun_03_0 | development / identifier | src/platform/paths.ts:22 (m_bosun03a) | Supported narrow lookup |
| bosun_03_1 | development / paraphrase | src/platform/paths.ts:22 (m_bosun03a) | Quote gap; expand exact span |
| bosun_03_2 | development / relationship | src/platform/paths.ts:26 (m_bosun03b) | Quote gap; expand exact span; equivalent original note omitted |
| bosun_03_3 | development / summary | src/platform/paths.ts:26 (m_bosun03b) | Quote gap; expand exact span; equivalent original note omitted |
| bosun_03_negative | development / negative | Full20-source absence review | Consistent bounded negative; easy outside-platform query |
| bosun_04_0 | heldout / rationale | src/app/native-runners.ts:9 (m_bosun04a) | Quote gap; expand exact span |
| bosun_04_1 | heldout / paraphrase | src/app/native-runners.ts:9 (m_bosun04a) | Quote gap; expand exact span |
| bosun_04_2 | heldout / relationship | src/app/native-runners.ts:38 (m_bosun04b) | Supported narrow lookup |
| bosun_04_3 | heldout / identifier | src/app/native-runners.ts:38 (m_bosun04b) | Quote gap; expand exact span |
| bosun_04_negative | heldout / negative | Full20-source absence review | Consistent bounded negative; easy outside-platform query |
| bosun_05_0 | heldout / current | src/core/use-cases/quota.ts:58 (m_bosun05a) | Supported narrow lookup; equivalent original note omitted |
| bosun_05_1 | heldout / paraphrase | src/core/use-cases/quota.ts:58 (m_bosun05a) | Supported narrow lookup; equivalent original note omitted |
| bosun_05_2 | heldout / preference | src/core/use-cases/quota.ts:59 (m_bosun05b) | Supported narrow lookup; equivalent original note omitted |
| bosun_05_3 | heldout / relationship | src/core/use-cases/quota.ts:59 (m_bosun05b) | Quote gap; expand exact span; equivalent original note omitted |
| bosun_05_negative | heldout / negative | Full20-source absence review | Consistent bounded negative; easy outside-platform query |
| bosun_06_0 | heldout / identifier | src/core/use-cases/handoff.ts:338 (m_bosun06a) | Supported narrow lookup; equivalent original note omitted |
| bosun_06_1 | heldout / relationship | src/core/use-cases/handoff.ts:338 (m_bosun06a) | Supported narrow lookup; equivalent original note omitted |
| bosun_06_2 | heldout / current | src/core/use-cases/handoff.ts:337 (m_bosun06b) | Quote gap; expand exact span; equivalent original note omitted |
| bosun_06_3 | heldout / paraphrase | src/core/use-cases/handoff.ts:337 (m_bosun06b) | Quote gap; expand exact span; equivalent original note omitted |
| bosun_06_negative | heldout / negative | Full20-source absence review | Consistent bounded negative; easy outside-platform query |
| bosun_07_0 | heldout / identifier | src/adapters/hosts/opencode/control.ts:617 (m_bosun07a) | Supported narrow lookup |
| bosun_07_1 | heldout / paraphrase | src/adapters/hosts/opencode/control.ts:617 (m_bosun07a) | Supported narrow lookup |
| bosun_07_2 | heldout / current | src/adapters/hosts/opencode/control.ts:955 (m_bosun07b) | Supported narrow lookup |
| bosun_07_3 | heldout / relationship | src/adapters/hosts/opencode/control.ts:955 (m_bosun07b) | Supported narrow lookup |
| bosun_07_negative | heldout / negative | Full20-source absence review | Consistent bounded negative; easy outside-platform query |
| bosun_08_0 | heldout / identifier | src/adapters/hosts/codex/control.ts:506 (m_bosun08a) | Supported narrow lookup |
| bosun_08_1 | heldout / paraphrase | src/adapters/hosts/codex/control.ts:506 (m_bosun08a) | Supported narrow lookup |
| bosun_08_2 | heldout / rationale | src/adapters/hosts/codex/control.ts:547 (m_bosun08b) | Supported narrow lookup |
| bosun_08_3 | heldout / relationship | src/adapters/hosts/codex/control.ts:547 (m_bosun08b) | Supported narrow lookup |
| bosun_08_negative | heldout / negative | Full20-source absence review | Consistent bounded negative; easy outside-platform query |
| bosun_09_0 | heldout / preference | src/core/lexical-memory.ts:5 (m_bosun09a) | Supported narrow lookup; equivalent original note omitted |
| bosun_09_1 | heldout / current | src/core/lexical-memory.ts:5 (m_bosun09a) | Supported narrow lookup; equivalent original note omitted |
| bosun_09_2 | heldout / identifier | src/core/lexical-memory.ts:8 (m_bosun09b) | Supported narrow lookup; equivalent original note omitted |
| bosun_09_3 | heldout / summary | src/core/lexical-memory.ts:8 (m_bosun09b) | Supported narrow lookup; equivalent original note omitted |
| bosun_09_negative | heldout / negative | Full20-source absence review | Consistent bounded negative; easy outside-platform query |
| bosun_10_0 | heldout / identifier | src/core/secret-screen.ts:12 (m_bosun10a) | Supported narrow lookup; equivalent original note omitted |
| bosun_10_1 | heldout / paraphrase | src/core/secret-screen.ts:12 (m_bosun10a) | Supported narrow lookup; equivalent original note omitted |
| bosun_10_2 | heldout / rationale | src/core/secret-screen.ts:4 (m_bosun10b) | Supported narrow lookup |
| bosun_10_3 | heldout / current | src/core/secret-screen.ts:4 (m_bosun10b) | Supported narrow lookup |
| bosun_10_negative | heldout / negative | Full20-source absence review | Consistent bounded negative; easy outside-platform query |
| bosun_11_0 | heldout / identifier | src/core/use-cases/retrieve-context.ts:220 (m_bosun11a) | Supported narrow lookup |
| bosun_11_1 | heldout / paraphrase | src/core/use-cases/retrieve-context.ts:220 (m_bosun11a) | Supported narrow lookup |
| bosun_11_2 | heldout / relationship | src/core/use-cases/retrieve-context.ts:256 (m_bosun11b) | Quote gap; expand exact span |
| bosun_11_3 | heldout / summary | src/core/use-cases/retrieve-context.ts:256 (m_bosun11b) | Supported narrow lookup |
| bosun_11_negative | heldout / negative | Full20-source absence review | Consistent bounded negative; easy outside-platform query |
| bosun_12_0 | heldout / identifier | src/core/domain/graph.ts:6 (m_bosun12a) | Quote gap; expand exact span; equivalent original note omitted |
| bosun_12_1 | heldout / summary | src/core/domain/graph.ts:6 (m_bosun12a) | Quote gap; expand exact span; equivalent original note omitted |
| bosun_12_2 | heldout / relationship | src/core/domain/graph.ts:9 (m_bosun12b) | Quote gap; expand exact span; equivalent original note omitted |
| bosun_12_3 | heldout / paraphrase | src/core/domain/graph.ts:9 (m_bosun12b) | Quote gap; expand exact span; equivalent original note omitted |
| bosun_12_negative | heldout / negative | Full20-source absence review | Consistent bounded negative; easy outside-platform query |
| bosun_13_0 | heldout / preference | src/app/consolidation.ts:24 (m_bosun13a) | Supported narrow lookup; equivalent original note omitted |
| bosun_13_1 | heldout / current | src/app/consolidation.ts:24 (m_bosun13a) | Supported narrow lookup; equivalent original note omitted |
| bosun_13_2 | heldout / identifier | src/app/consolidation.ts:23 (m_bosun13b) | Supported narrow lookup; equivalent original note omitted |
| bosun_13_3 | heldout / summary | src/app/consolidation.ts:23 (m_bosun13b) | Supported narrow lookup; equivalent original note omitted |
| bosun_13_negative | heldout / negative | Full20-source absence review | Consistent bounded negative; easy outside-platform query |
| bosun_14_0 | heldout / preference | src/app/embeddings.ts:114 (m_bosun14a) | Supported narrow lookup |
| bosun_14_1 | heldout / paraphrase | src/app/embeddings.ts:114 (m_bosun14a) | Supported narrow lookup |
| bosun_14_2 | heldout / relationship | src/app/embeddings.ts:167 (m_bosun14b) | Supported narrow lookup |
| bosun_14_3 | heldout / identifier | src/app/embeddings.ts:167 (m_bosun14b) | Supported narrow lookup |
| bosun_14_negative | heldout / negative | Full20-source absence review | Consistent bounded negative; easy outside-platform query |
| bosun_15_0 | heldout / current | src/app/remote-views.ts:144 (m_bosun15a) | Supported narrow lookup; equivalent original note omitted |
| bosun_15_1 | heldout / identifier | src/app/remote-views.ts:144 (m_bosun15a) | Supported narrow lookup; equivalent original note omitted |
| bosun_15_2 | heldout / rationale | src/app/remote-views.ts:145 (m_bosun15b) | Supported narrow lookup; equivalent original note omitted |
| bosun_15_3 | heldout / paraphrase | src/app/remote-views.ts:145 (m_bosun15b) | Supported narrow lookup; equivalent original note omitted |
| bosun_15_negative | heldout / negative | Full20-source absence review | Consistent bounded negative; easy outside-platform query |
| bosun_16_0 | heldout / rationale | src/app/upgrade-router.ts:185 (m_bosun16a) | Ordering only; revise why; equivalent original note omitted |
| bosun_16_1 | heldout / relationship | src/app/upgrade-router.ts:185 (m_bosun16a) | Supported narrow lookup; equivalent original note omitted |
| bosun_16_2 | heldout / current | src/app/upgrade-router.ts:184 (m_bosun16b) | Supported narrow lookup; equivalent original note omitted |
| bosun_16_3 | heldout / identifier | src/app/upgrade-router.ts:184 (m_bosun16b) | Supported narrow lookup; equivalent original note omitted |
| bosun_16_negative | heldout / negative | Full20-source absence review | Consistent bounded negative; easy outside-platform query |
| bosun_17_0 | heldout / identifier | src/adapters/services/launchd.ts:19 (m_bosun17a) | Quote gap; expand exact span; equivalent original note omitted |
| bosun_17_1 | heldout / preference | src/adapters/services/launchd.ts:19 (m_bosun17a) | Quote gap; expand exact span; equivalent original note omitted |
| bosun_17_2 | heldout / relationship | src/adapters/services/launchd.ts:15 (m_bosun17b) | Supported narrow lookup |
| bosun_17_3 | heldout / summary | src/adapters/services/launchd.ts:15 (m_bosun17b) | Supported narrow lookup |
| bosun_17_negative | heldout / negative | Full20-source absence review | Consistent bounded negative; easy outside-platform query |
| bosun_18_0 | heldout / current | src/app/installation.ts:161 (m_bosun18a) | Quote gap; expand exact span; equivalent original note omitted |
| bosun_18_1 | heldout / paraphrase | src/app/installation.ts:161 (m_bosun18a) | Quote gap; expand exact span; equivalent original note omitted |
| bosun_18_2 | heldout / rationale | src/app/installation.ts:164 (m_bosun18b) | Supported narrow lookup; equivalent original note omitted |
| bosun_18_3 | heldout / relationship | src/app/installation.ts:164 (m_bosun18b) | Supported narrow lookup; equivalent original note omitted |
| bosun_18_negative | heldout / negative | Full20-source absence review | Consistent bounded negative; easy outside-platform query |
| bosun_19_0 | heldout / identifier | src/platform/watch-command.ts:57 (m_bosun19a) | Supported narrow lookup; equivalent original note omitted |
| bosun_19_1 | heldout / paraphrase | src/platform/watch-command.ts:57 (m_bosun19a) | Supported narrow lookup; equivalent original note omitted |
| bosun_19_2 | heldout / relationship | src/platform/watch-command.ts:57 (m_bosun19b) | Supported narrow lookup; equivalent original note omitted |
| bosun_19_3 | heldout / summary | src/platform/watch-command.ts:57 (m_bosun19b) | Supported narrow lookup; equivalent original note omitted |
| bosun_19_negative | heldout / negative | Full20-source absence review | Consistent bounded negative; easy outside-platform query |

## Complete note inventory

| Note | Snapshot body lines | Cite line | Integrity / overlap |
|---|---|---|---|
| m_bosun00a | README.md:1–11 | 3 | Exact |
| m_bosun00b | README.md:89–100 | 92 | Exact |
| m_bosun01a | src/core/domain/config.ts:150–161 | 153 | Exact |
| m_bosun01b | src/core/domain/config.ts:193–204 | 196 | Exact |
| m_bosun02a | src/core/ports/host.ts:29–40 | 32 | Exact |
| m_bosun02b | src/core/ports/host.ts:70–81 | 73 | Exact |
| m_bosun03a | src/platform/paths.ts:19–30 | 22 | Exact |
| m_bosun03b | src/platform/paths.ts:23–33 | 26 | Exact |
| m_bosun04a | src/app/native-runners.ts:6–17 | 9 | Exact |
| m_bosun04b | src/app/native-runners.ts:35–46 | 38 | Exact |
| m_bosun05a | src/core/use-cases/quota.ts:55–64 | 58 | Exact; contains m_bosun05b |
| m_bosun05b | src/core/use-cases/quota.ts:56–64 | 59 | Exact |
| m_bosun06a | src/core/use-cases/handoff.ts:335–346 | 338 | Exact |
| m_bosun06b | src/core/use-cases/handoff.ts:334–345 | 337 | Exact |
| m_bosun07a | src/adapters/hosts/opencode/control.ts:614–625 | 617 | Exact |
| m_bosun07b | src/adapters/hosts/opencode/control.ts:952–963 | 955 | Exact |
| m_bosun08a | src/adapters/hosts/codex/control.ts:503–514 | 506 | Exact |
| m_bosun08b | src/adapters/hosts/codex/control.ts:544–555 | 547 | Exact |
| m_bosun09a | src/core/lexical-memory.ts:2–13 | 5 | Exact |
| m_bosun09b | src/core/lexical-memory.ts:5–16 | 8 | Exact |
| m_bosun10a | src/core/secret-screen.ts:9–14 | 12 | Exact |
| m_bosun10b | src/core/secret-screen.ts:1–12 | 4 | Exact |
| m_bosun11a | src/core/use-cases/retrieve-context.ts:217–228 | 220 | Exact |
| m_bosun11b | src/core/use-cases/retrieve-context.ts:253–264 | 256 | Exact |
| m_bosun12a | src/core/domain/graph.ts:3–14 | 6 | Exact |
| m_bosun12b | src/core/domain/graph.ts:6–17 | 9 | Exact |
| m_bosun13a | src/app/consolidation.ts:21–32 | 24 | Exact |
| m_bosun13b | src/app/consolidation.ts:20–31 | 23 | Exact |
| m_bosun14a | src/app/embeddings.ts:111–122 | 114 | Exact |
| m_bosun14b | src/app/embeddings.ts:164–175 | 167 | Exact |
| m_bosun15a | src/app/remote-views.ts:141–152 | 144 | Exact |
| m_bosun15b | src/app/remote-views.ts:142–153 | 145 | Exact |
| m_bosun16a | src/app/upgrade-router.ts:182–193 | 185 | Exact |
| m_bosun16b | src/app/upgrade-router.ts:181–192 | 184 | Exact |
| m_bosun17a | src/adapters/services/launchd.ts:16–27 | 19 | Exact |
| m_bosun17b | src/adapters/services/launchd.ts:12–23 | 15 | Exact |
| m_bosun18a | src/app/installation.ts:158–169 | 161 | Exact |
| m_bosun18b | src/app/installation.ts:161–172 | 164 | Exact |
| m_bosun19a | src/platform/watch-command.ts:54–64 | 57 | Exact; identical to m_bosun19b |
| m_bosun19b | src/platform/watch-command.ts:54–64 | 57 | Exact; identical to m_bosun19a |

## Complete graph inventory

Every graph proposal has two exact support quotations, valid same-topic bindings and reviewed=false. All five nodes in each row share identical text; JSON audits each of the100 IDs separately. The “needs wider evidence” groups identify questions that those fragments cannot answer fully, not fabricated source quotations.

| Topic | All five proposal IDs | Immutable sources | Needs wider evidence |
|---|---|---|---|
| 00 | g_bosun00file, g_bosun00topic, g_bosun00link, g_bosun00fact, g_bosun00overview | README.md:3,92 | Narrow lookups supported; duplicate navigation text |
| 01 | g_bosun01file, g_bosun01topic, g_bosun01link, g_bosun01fact, g_bosun01overview | src/core/domain/config.ts:153,196 | Narrow lookups supported; duplicate navigation text |
| 02 | g_bosun02file, g_bosun02topic, g_bosun02link, g_bosun02fact, g_bosun02overview | src/core/ports/host.ts:32,73 | bosun_02_0, bosun_02_2 |
| 03 | g_bosun03file, g_bosun03topic, g_bosun03link, g_bosun03fact, g_bosun03overview | src/platform/paths.ts:22,26 | bosun_03_1, bosun_03_2, bosun_03_3 |
| 04 | g_bosun04file, g_bosun04topic, g_bosun04link, g_bosun04fact, g_bosun04overview | src/app/native-runners.ts:9,38 | bosun_04_0, bosun_04_1, bosun_04_3 |
| 05 | g_bosun05file, g_bosun05topic, g_bosun05link, g_bosun05fact, g_bosun05overview | src/core/use-cases/quota.ts:58,59 | bosun_05_3 |
| 06 | g_bosun06file, g_bosun06topic, g_bosun06link, g_bosun06fact, g_bosun06overview | src/core/use-cases/handoff.ts:338,337 | bosun_06_2, bosun_06_3 |
| 07 | g_bosun07file, g_bosun07topic, g_bosun07link, g_bosun07fact, g_bosun07overview | src/adapters/hosts/opencode/control.ts:617,955 | Narrow lookups supported; duplicate navigation text |
| 08 | g_bosun08file, g_bosun08topic, g_bosun08link, g_bosun08fact, g_bosun08overview | src/adapters/hosts/codex/control.ts:506,547 | Narrow lookups supported; duplicate navigation text |
| 09 | g_bosun09file, g_bosun09topic, g_bosun09link, g_bosun09fact, g_bosun09overview | src/core/lexical-memory.ts:5,8 | Narrow lookups supported; duplicate navigation text |
| 10 | g_bosun10file, g_bosun10topic, g_bosun10link, g_bosun10fact, g_bosun10overview | src/core/secret-screen.ts:12,4 | Narrow lookups supported; duplicate navigation text |
| 11 | g_bosun11file, g_bosun11topic, g_bosun11link, g_bosun11fact, g_bosun11overview | src/core/use-cases/retrieve-context.ts:220,256 | bosun_11_2 |
| 12 | g_bosun12file, g_bosun12topic, g_bosun12link, g_bosun12fact, g_bosun12overview | src/core/domain/graph.ts:6,9 | bosun_12_0, bosun_12_1, bosun_12_2, bosun_12_3 |
| 13 | g_bosun13file, g_bosun13topic, g_bosun13link, g_bosun13fact, g_bosun13overview | src/app/consolidation.ts:24,23 | Narrow lookups supported; duplicate navigation text |
| 14 | g_bosun14file, g_bosun14topic, g_bosun14link, g_bosun14fact, g_bosun14overview | src/app/embeddings.ts:114,167 | Narrow lookups supported; duplicate navigation text |
| 15 | g_bosun15file, g_bosun15topic, g_bosun15link, g_bosun15fact, g_bosun15overview | src/app/remote-views.ts:144,145 | Narrow lookups supported; duplicate navigation text |
| 16 | g_bosun16file, g_bosun16topic, g_bosun16link, g_bosun16fact, g_bosun16overview | src/app/upgrade-router.ts:185,184 | bosun_16_0 |
| 17 | g_bosun17file, g_bosun17topic, g_bosun17link, g_bosun17fact, g_bosun17overview | src/adapters/services/launchd.ts:19,15 | bosun_17_0, bosun_17_1 |
| 18 | g_bosun18file, g_bosun18topic, g_bosun18link, g_bosun18fact, g_bosun18overview | src/app/installation.ts:161,164 | bosun_18_0, bosun_18_1 |
| 19 | g_bosun19file, g_bosun19topic, g_bosun19link, g_bosun19fact, g_bosun19overview | src/platform/watch-command.ts:57,57 | Narrow lookups supported; duplicate navigation text |

## Frozen outcome

Snapshot integrity passes. Gold approval and quality evaluation remain pending. Correct 19 quote/context cases, resolve two unsupported causal phrasings, repair answer-equivalent candidate scoring, and add representative accepted semantic coverage before asking the owner to approve revised labels. Keep the existing source selection and frozen held-out policy; do not tune thresholds on eventual held-out failures. No production files or pinned input artifact was changed by this audit.


At freeze, the root coordinator had held the evaluation proposal because of the confirmed scoring defect. The proposal hash above was captured after that root edit; its initial read hash (`0cbfcd07f78d0570407a7bf24eff20e7922fc679bdce76c6e155fc04def9fe5f`) is retained separately in JSON. The draft and source manifest remain unchanged.
