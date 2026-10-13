# Bosun source corpus: final label and evaluation proposal

**Owner labels and graph review are pending. No evaluation has run.** This is a separate complete candidate that adds genuine held-out source-history comparisons to the frozen corrected corpus. The original draft, corrected artifacts and coordinator review remain unchanged. Production code, package metadata and Git state were not changed by this worker. The earlier source still requires managed control; absence of the new displayed callback guard does not establish that it allowed unadmitted model inference.

## Exact artifacts

| Artifact | Bytes | SHA256 |
|---|---:|---|
| [2026-10-11-bosun-corpus-evaluation-draft.json](../research/checkpoints/2026-10-11-bosun-corpus-evaluation-draft.json) | 284753 | `faff7fb8211f281b597d4cebe95c4338529378360323df9837194e2d58ba7a6e` |
| [2026-10-11-bosun-corpus-evaluation-provenance.json](../research/checkpoints/2026-10-11-bosun-corpus-evaluation-provenance.json) | 508454 | `030410f5dcc9e7aafd6c3f58aba7343d06a859ecc373543de37c2dcc68d82197` |
| [2026-10-11-bosun-corpus-evaluation-source-manifest.json](../research/checkpoints/2026-10-11-bosun-corpus-evaluation-source-manifest.json) | 11744 | `349c983772c0a6878f93a59bbfc7288689ce86dd18022331e3e0796396224b44` |
| [2026-10-11-bosun-corpus-evaluation-checks.json](../research/checkpoints/2026-10-11-bosun-corpus-evaluation-checks.json) | 116011 | `8c455ec847583a44d0eb186b3a0246e5ea836ff9b1b976579c552c67285907af` |
| [2026-10-11-bosun-corpus-evaluation-contract-node.log](../research/checkpoints/2026-10-11-bosun-corpus-evaluation-contract-node.log) | 819 | `53393e1ed6ffad358d892a054be1d3b2a4a037c16bfda229bfc1a9cb7e41ff25` |

The candidate contains **63 distinct source notes, exactly 100 cases and 96 proposed graph records**. Cases remain 20 development / 80 held-out, including 20 in-domain no-memory questions and 40 multi-support cases. The 80 positives have 72 distinct support assignments, within 20 source/topic clusters (four development/16 held-out). There are 22 immutable source snapshot entries. All eight nominal categories occur in both splits. Facts, summaries and profiles are supported proposals; every graph reviewed flag is false and ownerReviewed remains false.

## Authentic held-out history

Both handoff generations stay in **file_6b73fbaee4bc / topic_corrected_06**, the existing held-out cluster. Earlier snapshot A has SHA256 `5460cca753969f260250032f6075853ed638c6a5ebe12db49d0bfb85e78499f4`; the later actual source snapshot B has SHA256 `09717715727904a6f56b973c1d3ed3d969d33d4e059ab4c29e2264b7186c6ebf`. The new snapshot was copied from the unchanged current source and independently hash/byte checked.

| Case | Replaced duplicate coverage | New source-history question | Required notes |
|---|---|---|---|
| bc_06_0 | Standalone fence-order lookup | Comparing the earlier and later saved handoff prefixes, what new condition can refuse bootstrap before ownership fencing, and which authority must admit model-backed bootstrap? | m_bc06g (3), m_bc06f (3), m_bc06h (2) |
| bc_06_1 | Standalone quiescence lookup | How does destination seeding differ between the earlier saved handoff source and the later source when an application bootstrap callback is present or absent? | m_bc06d (3), m_bc06e (3) |

The former fence/quiescence/ownership facts remain in bc_06_2 and the multi-support bc_06_3 summary. The old and new seed/admission excerpts differ completely under normalization, so a later callback branch cannot accidentally satisfy the earlier direct-seed quote. Every complete fact answer has its fact/overview alternatives. Source-revision entities and the supersedes link carry navigation metadata, not copied answers, and have complete original endpoint lineage.

The new controller **rejects a missing application callback only when bootstrapUsesInference(control) is true**. Separately, its dispatch code uses the callback whenever one is provided, otherwise it calls control.seed directly. These are distinct conditions; this proposal does not claim that callback dispatch is conditional solely on inference or that an earlier file plus unknown dependencies forms a runnable historical package. No host is qualified by this file comparison.

### m_bc06g: Earlier handoff snapshot A / pre-fence checks

[src/core/use-cases/handoff.ts:313–315](../research/checkpoints/bosun-corpus-2026-10-11/sources/src/core/use-cases/handoff.ts) · earlier-selected-snapshot · source SHA256 `5460cca753969f260250032f6075853ed638c6a5ebe12db49d0bfb85e78499f4`. Exact original excerpt:

```ts
// The caller cannot turn unqualified controls into automatic/manual takeover.
      const control = requireManagedControl({ control: dependencies.control(row.session.hostId) });
      if (signal.aborted) throw new BosunError('cancelled', 'Managed handoff cancelled');
```

Proposed complete fact: Earlier saved handoff snapshot A still requires managed control; the displayed prefix then checks cancellation without the later application-bootstrap guard.

### m_bc06f: Later handoff snapshot B / bootstrap admission guard

[src/core/use-cases/handoff.ts:318–320](../research/checkpoints/bosun-corpus-evaluation-2026-10-11/sources/handoff-later.ts) · later-read-only-handoff-snapshot · source SHA256 `09717715727904a6f56b973c1d3ed3d969d33d4e059ab4c29e2264b7186c6ebf`. Exact original excerpt:

```ts
const control = requireManagedControl({ control: dependencies.control(row.session.hostId) });
      if (bootstrapUsesInference(control) && !dependencies.bootstrap)
        throw new BosunError('unsupported', 'Managed bootstrap admission unavailable');
```

Proposed complete fact: Later saved handoff snapshot B first requires managed control, then rejects bootstrapUsesInference(control) with unsupported when the application bootstrap callback is missing.

### m_bc06h: Later handoff snapshot B / application bootstrap authority

[src/core/use-cases/handoff.ts:101–104](../research/checkpoints/bosun-corpus-evaluation-2026-10-11/sources/handoff-later.ts) · later-read-only-handoff-snapshot · source SHA256 `09717715727904a6f56b973c1d3ed3d969d33d4e059ab4c29e2264b7186c6ebf`. Exact original excerpt:

```ts
// A model-backed bootstrap must use the application's existing quota and
  // usage authority. The core never silently dispatches an unadmitted turn.
  bootstrap?(control: ManagedSessionControl, session: ManagedSession,
    seed: HandoffSeed, signal: AbortSignal): Promise<void>;
```

Proposed complete fact: Later handoff dependencies require model-backed bootstrap to use the application quota/usage authority and declare an optional bootstrap(control, session, seed, signal) callback.

### m_bc06d: Earlier handoff snapshot A / direct seeding

[src/core/use-cases/handoff.ts:372–374](../research/checkpoints/bosun-corpus-2026-10-11/sources/src/core/use-cases/handoff.ts) · earlier-selected-snapshot · source SHA256 `5460cca753969f260250032f6075853ed638c6a5ebe12db49d0bfb85e78499f4`. Exact original excerpt:

```ts
row = dependencies.storage.destinationOwnership(row, destination);
        await control.seed(destination, seed, signal);
        live();
```

Proposed complete fact: Earlier saved handoff snapshot A records destination ownership, directly awaits control.seed(destination, seed, signal), then continues.

### m_bc06e: Later handoff snapshot B / conditional seeding

[src/core/use-cases/handoff.ts:378–381](../research/checkpoints/bosun-corpus-evaluation-2026-10-11/sources/handoff-later.ts) · later-read-only-handoff-snapshot · source SHA256 `09717715727904a6f56b973c1d3ed3d969d33d4e059ab4c29e2264b7186c6ebf`. Exact original excerpt:

```ts
row = dependencies.storage.destinationOwnership(row, destination);
        if (dependencies.bootstrap) await dependencies.bootstrap(control, destination, seed, signal);
        else await control.seed(destination, seed, signal);
        live();
```

Proposed complete fact: Later saved handoff snapshot B calls dependencies.bootstrap when the callback is provided; otherwise it directly calls control.seed.

The pre-fence location is independently bound to the earlier fence call at 336–338 and later fence call at 342–344; those exact context references are retained in case provenance. The two held-out historical cases close the missing temporal-comparison preparation. The earlier/later host-contract comparison remains in development case bc_02_1; dependency chains remain in bc_03_2 and bc_05_2.

## Verification and deterministic executable encoding

All 22 source snapshots, all 63 exact byte spans/folded bodies, every gold/alternative binding, complete explicit and automatic graph-parent lineage, disjoint source/session groups and unique questions were checked. No full-answer curated duplicate or unlabelled complete graph-copy answer exists. All protected old/corrected/coordinator artifacts and current production handoff source remain hash-identical.

One guarded Node strict-schema preflight passed using an explicitly **in-memory synthetic projection only**. The saved pending dataset and wrapper both reject. Original child PID **46199** returned exit 0, signal null, empty stderr, joined through spawnSync, and its temporary HOME/tree were removed. No asynchronous tool/session handle was allocated; no process remains live. The guarded check opened no storage and ran no retrieval/provider/native/model evaluation.

The readable review wrapper is **284753 bytes**, exceeding the evaluator's 262144-byte bound and containing non-schema review metadata. **Never pass the wrapper as --fixture.** The future approved input must be only its dataset property. Its deterministic encoding is **202957 bytes**, SHA256 `bf6942ba3992248ca0c23a14eb883fc07a9263602ef3ba2f317448e09e09e6bd`, under 262144 bytes. It was serialized/hash-checked in memory only; no falsely owner-reviewed file was saved.

After explicit owner acceptance, create the future dataset using exactly this recipe: parse the pinned wrapper; structuredClone only `.dataset`; set `evidence="owner-reviewed"` and every `graph[].reviewed=true`; preserve all other values, object/array order and capturedAt; serialize `JSON.stringify(dataset)+"\n"` as UTF-8 without indentation or BOM. Recompute bytes/hash before execution. The changes to approval flags are authorized only by that future explicit acceptance, not by this proposal or the synthetic schema check.

## Concrete Node-only evaluation after separate acceptance

The root coordinator will independently review this candidate and ask the owner to accept the exact gold/graph labels and the following disposable offline measurements. The old held question cannot authorize this replacement. No command below has run. Before either measurement, save the accepted dataset at the proposed path with the exact encoding above, verify the expected hash / 202957-byte size, and retain all proposal/source pins.

```sh
node scripts/eval-memory.mjs \
  --fixture docs/research/checkpoints/2026-10-11-bosun-corpus-evaluation-approved.json \
  --baseline fts --surface hook-packing \
  > docs/research/checkpoints/2026-10-11-bosun-corpus-evaluation-hook-packing-report.json

node scripts/eval-memory.mjs \
  --fixture docs/research/checkpoints/2026-10-11-bosun-corpus-evaluation-approved.json \
  --baseline fts --surface mcp \
  > docs/research/checkpoints/2026-10-11-bosun-corpus-evaluation-mcp-report.json
```

Run these sequentially using the existing evaluator launcher, which installs the mandatory Node preload and creates a fresh temporary HOME/config/cache/workspace. Keep all frozen labels and ranking/packing policy unchanged between surfaces. Join the original processes and record exit/signal/cleanup; an uncertain receipt stays unresolved and does not authorize a blind restart.

The first run compares A curated FTS/context, B improved lexical, C reviewed one-hop graph plus B, and E supported summaries/profiles plus lexical/graph, at the fixed 400-token estimate packing budget. The second uses the actual Node SDK/stdio/daemon/MCP boundary in a disposable replica at its separate 1000-token estimate budget. Both use the identical 63-note/100-case/96-graph corpus. They may open only their own temporary SQLite/runtime and localhost/stdio endpoints. No owner memory, personal configuration, native host, model, service installation or notification call is included. The current script supplies empty runners/quota/provider/external-source registries and disables external Claude-mem.

Default invocations select no vector provider and make no model calls. D remains unavailable; do not pass --vectors-synthetic for an owner-reviewed corpus or claim synthetic vectors as real evidence. Physical embedding/vector and generated overview/extraction quality require their separately prepared exact provider/model/digest authorization and remain outstanding.

Review per-category/held-out Recall@5, MRR@20, packed and graded evidence recall, packed precision, negative injection, support truncation, zero-overlap graph results, paired source-clustered uncertainty, CvsA/CvsB and EvsC. Record metric failures and activation disposition; do not change held-out labels or thresholds based on observed outcomes. One result cannot silently activate graph/enrichment. Source snippets up to 380 characters and the topic06 overview up to 1123 characters may truncate under fixed widths, and that loss must remain visible.

## Limits retained

These are reviewed-proposal candidates derived from real repository source, not captured owner tasks or the separate 12 sanitized/native handoff sessions. Source file history is genuine, but the Node retrieval runs cannot prove native temporal-memory handling, model generation quality, privacy/scope/expiry/revocation/purge/retention canaries, actual host-token counts, compiled hook latency, physical vector/model behavior or review burden. Those accepted release gates remain separate. Origin404 is historical source-selection evidence; no public hosting or new network check is claimed. No production feature, release requirement, model choice or approval boundary is waived.

## All 100 owner-reviewable questions

| ID | Split / category | Question | Gold note IDs (grade) |
|---|---|---|---|
| bc_00_0 | development / identifier | Which harness is described as the primary Bosun host? | m_bc00a (3) |
| bc_00_1 | development / paraphrase | Does the memory hook generate query embeddings while serving a request? | m_bc00c (3) |
| bc_00_2 | development / preference | Are optional vector candidates enabled by default? | m_bc00b (3) |
| bc_00_3 | development / summary | Summarize the documented host preference and the default vector/hook-inference policy. | m_bc00a (3), m_bc00b (3), m_bc00c (2) |
| bc_00_negative | development / negative | What recall score was measured for enabled vectors in the most recent real Bosun corpus evaluation? | None: actual requested receipt/measurement absent |
| bc_01_0 | development / identifier | What automatic handoff threshold does the saved default configuration use? | m_bc01a (3) |
| bc_01_1 | development / paraphrase | How many input tokens may the summarizer consume and how large may its output be? | m_bc01b (3) |
| bc_01_2 | development / relationship | How does the default handoff trigger relate to the configured input/output summary limits? | m_bc01a (3), m_bc01b (2) |
| bc_01_3 | development / summary | Outline the default handoff trigger/budgets and the graph traversal bounds. | m_bc01a (3), m_bc01b (3), m_bc01c (2) |
| bc_01_negative | development / negative | What handoff threshold did the owner actually select in the most recent live runtime configuration? | None: actual requested receipt/measurement absent |
| bc_02_0 | development / identifier | Which six managed capability names appear in the earlier saved host contract? | m_bc02a (3) |
| bc_02_1 | development / current | Comparing earlier snapshot A with later snapshot B, what bootstrap alternative was added and what restrictions are stated? | m_bc02a (3), m_bc02d (2) |
| bc_02_2 | development / rationale | Why do the interface declarations alone fail to qualify a current native host? | m_bc02b (3) |
| bc_02_3 | development / summary | Summarize the earlier contract capability list, its qualification limitation and its persistent-process cleanup requirement. | m_bc02a (3), m_bc02b (3), m_bc02c (2) |
| bc_02_negative | development / negative | Which native process PID was joined by the last managed-driver close operation? | None: actual requested receipt/measurement absent |
| bc_03_0 | development / paraphrase | How does an explicit runtime-home environment override the ordinary HOME fallback? | m_bc03a (3) |
| bc_03_1 | development / identifier | Which socket override and default filename does the path resolver select? | m_bc03c (3) |
| bc_03_2 | development / relationship | With no socket override, how is the socket path derived from the home override or HOME fallback, including the intermediate directory and socket filename? | m_bc03c (3), m_bc03b (3), m_bc03a (2) |
| bc_03_3 | development / summary | Summarize runtime-home, run-directory and local-socket resolution including their overrides. | m_bc03a (3), m_bc03b (3), m_bc03c (2) |
| bc_03_negative | development / negative | What absolute socket path was actually selected in the most recent owner session? | None: actual requested receipt/measurement absent |
| bc_04_0 | heldout / rationale | Why is building the runner registry safe before selecting a native harness? | m_bc04a (3) |
| bc_04_1 | heldout / identifier | Which enabled host does nativeQuotaSources conditionally register? | m_bc04b (3) |
| bc_04_2 | heldout / relationship | How does the Codex quota callback reach its factory/read operation, and which request/process deadlines does it pin? | m_bc04b (3), m_bc04c (3), m_bc04d (2) |
| bc_04_3 | heldout / summary | Contrast runner-registry construction with the condition and bounded callback used for Codex quota reads. | m_bc04a (3), m_bc04b (3), m_bc04c (3), m_bc04d (2) |
| bc_04_negative | heldout / negative | Which concrete Codex account authenticated the most recent native quota callback? | None: actual requested receipt/measurement absent |
| bc_05_0 | heldout / identifier | What admission outcome and reason do known blocked quota observations produce? | m_bc05a (3) |
| bc_05_1 | heldout / current | How are absent observations and a missing selected observation treated when cached evidence looked healthy? | m_bc05d (3), m_bc05e (2) |
| bc_05_2 | heldout / relationship | For a quota-gated job, which two calls take runner/model selection to the observation collector, and what denial survives the owner unknown-quota override? | m_bc05b (3), m_bc05c (3), m_bc05a (2) |
| bc_05_3 | heldout / summary | Summarize quota admission, observation collection and the two ways missing evidence stays unknown. | m_bc05a (3), m_bc05c (3), m_bc05d (3), m_bc05e (2) |
| bc_05_negative | heldout / negative | At what timestamp does the current account weekly quota allowance reset? | None: actual requested receipt/measurement absent |
| bc_06_0 | heldout / current | Comparing the earlier and later saved handoff prefixes, what new condition can refuse bootstrap before ownership fencing, and which authority must admit model-backed bootstrap? | m_bc06g (3), m_bc06f (3), m_bc06h (2) |
| bc_06_1 | heldout / current | How does destination seeding differ between the earlier saved handoff source and the later source when an application bootstrap callback is present or absent? | m_bc06d (3), m_bc06e (3) |
| bc_06_2 | heldout / rationale | Why cannot the staged bootstrap destination execute ordinary work before transfer, and what operation transfers dispatch ownership? | m_bc06c (3) |
| bc_06_3 | heldout / summary | Describe the fence acknowledgement order, quiescence gate and final source/destination ownership change. | m_bc06a (3), m_bc06b (3), m_bc06c (2) |
| bc_06_negative | heldout / negative | Which exact destination session ID won the most recent ownership transfer CAS? | None: actual requested receipt/measurement absent |
| bc_07_0 | heldout / identifier | How does the OpenCode seed request bind its agent/model/text while suppressing an assistant reply? | m_bc07a (3) |
| bc_07_1 | heldout / relationship | Which exact independent message read and idle/row checks precede marking an OpenCode destination seeded? | m_bc07b (3), m_bc07c (2) |
| bc_07_2 | heldout / paraphrase | What prerequisites does startFresh require of the owned source and fresh-owner claim? | m_bc07d (3) |
| bc_07_3 | heldout / summary | Summarize the candidate OpenCode seeding/readback/idle checks and the fresh-source prerequisites. | m_bc07a (3), m_bc07b (3), m_bc07c (3), m_bc07d (2) |
| bc_07_negative | heldout / negative | Which destination TUI session did the last live OpenCode handoff actually select? | None: actual requested receipt/measurement absent |
| bc_08_0 | heldout / identifier | Which app-server operation injects the seed and what message role/content type does it use? | m_bc08a (3) |
| bc_08_1 | heldout / paraphrase | What independent evidence and owner check precede the candidate Codex readiness receipt? | m_bc08b (3) |
| bc_08_2 | heldout / relationship | How are injected seed text and the final readiness receipt tied to the owned thread, exact rollout and selected model/access? | m_bc08a (3), m_bc08b (2) |
| bc_08_3 | heldout / summary | Outline the candidate Codex bootstrap write and the independent readiness evidence returned afterward. | m_bc08a (3), m_bc08b (2) |
| bc_08_negative | heldout / negative | What SHA256 was observed for the retained rollout in the last live Codex readiness check? | None: actual requested receipt/measurement absent |
| bc_09_0 | heldout / identifier | What fixed weights are assigned to title, body and tags in lexical scoring? | m_bc09a (3) |
| bc_09_1 | heldout / paraphrase | How wide are lexical excerpts and rendered titles? | m_bc09b (3) |
| bc_09_2 | heldout / relationship | What stated relationship does the fixed lexical policy have to evaluation labels and split membership? | m_bc09c (3) |
| bc_09_3 | heldout / summary | Summarize lexical weights, display widths and independence from evaluation split membership. | m_bc09a (3), m_bc09b (3), m_bc09c (2) |
| bc_09_negative | heldout / negative | Which lexical weight setting achieved the best measured held-out score on the real owner-reviewed corpus? | None: actual requested receipt/measurement absent |
| bc_10_0 | heldout / identifier | Which predicate and error outcome implement credential-shaped public-input rejection? | m_bc10a (3) |
| bc_10_1 | heldout / rationale | Why does a no-match ingress screen fail to establish detection of every possible secret or replace privacy classification? | m_bc10b (3) |
| bc_10_2 | heldout / relationship | How does credential detection relate to the rule for matched values and separate privacy classification? | m_bc10a (3), m_bc10b (2) |
| bc_10_3 | heldout / summary | Summarize public credential rejection, what the detector cannot claim and how matched values must be handled. | m_bc10a (3), m_bc10b (2) |
| bc_10_negative | heldout / negative | Which credential rule produced the latest actual public-input false positive? | None: actual requested receipt/measurement absent |
| bc_11_0 | heldout / identifier | In which score order does the context packer visit candidates? | m_bc11a (3) |
| bc_11_1 | heldout / paraphrase | How does line truncation precede the approximate token-budget check? | m_bc11b (3) |
| bc_11_2 | heldout / relationship | How do descending candidate order and the line-length budget check together determine packing? | m_bc11a (3), m_bc11b (2) |
| bc_11_3 | heldout / summary | Describe the candidate ranking and bounded line/token packing rules. | m_bc11a (3), m_bc11b (2) |
| bc_11_negative | heldout / negative | How many supports were lost to truncation in the most recent400-token hook pack? | None: actual requested receipt/measurement absent |
| bc_12_0 | heldout / identifier | Which GraphSupport fields bind an original memory and optional source span? | m_bc12a (3) |
| bc_12_1 | heldout / relationship | Which fields represent relation endpoints/predicate/weight, and which source fields establish supporting provenance? | m_bc12b (3), m_bc12a (2) |
| bc_12_2 | heldout / current | What graph lifecycle statuses and semantic levels/kinds does this selected contract declare? | m_bc12c (3) |
| bc_12_3 | heldout / summary | Outline graph provenance, typed relations and the declared levels/kinds/statuses. | m_bc12a (3), m_bc12b (3), m_bc12c (2) |
| bc_12_negative | heldout / negative | Which graph entity ID was most recently accepted by the owner? | None: actual requested receipt/measurement absent |
| bc_13_0 | heldout / preference | Does consolidation allow a remote API by default and can an explicit policy override that choice? | m_bc13a (3) |
| bc_13_1 | heldout / identifier | Which constants supply the three outstanding/source/proposal bounds? | m_bc13b (3) |
| bc_13_2 | heldout / relationship | How do consolidation defaults and explicit overrides remain constrained by policy validation? | m_bc13a (3), m_bc13c (2) |
| bc_13_3 | heldout / summary | Summarize the default remote-API choice, constant-backed work limits and validated policy ranges. | m_bc13a (3), m_bc13b (3), m_bc13c (2) |
| bc_13_negative | heldout / negative | How many proposals did the most recent live consolidation review accept? | None: actual requested receipt/measurement absent |
| bc_14_0 | heldout / identifier | When is query-cache lookup allowed and when does a stored entry remain fresh? | m_bc14a (3) |
| bc_14_1 | heldout / paraphrase | How does an uncached successful vector enter the bounded cache and evict old entries? | m_bc14b (3) |
| bc_14_2 | heldout / relationship | How do lookup size/TTL conditions differ from the verification/write/eviction rules? | m_bc14a (3), m_bc14b (2) |
| bc_14_3 | heldout / summary | Outline the embedding query-cache read freshness and successful-write capacity policy. | m_bc14a (3), m_bc14b (2) |
| bc_14_negative | heldout / negative | What cache-hit rate was measured in the most recent warm embedding-query run? | None: actual requested receipt/measurement absent |
| bc_15_0 | heldout / identifier | Which unresolved lease phases refuse ordinary remote-view release and what diagnostic do they return? | m_bc15a (3) |
| bc_15_1 | heldout / paraphrase | Which original identity and signal fields are bound into remote.view.release? | m_bc15b (3) |
| bc_15_2 | heldout / relationship | How does reconciling an uncertain lease relate to preserving the original release intent? | m_bc15a (3), m_bc15b (2) |
| bc_15_3 | heldout / summary | Summarize uncertain-lease release refusal and the original-receipt binding of an ordinary release. | m_bc15a (3), m_bc15b (2) |
| bc_15_negative | heldout / negative | What remote lease receipt ID is currently active on the owner installation? | None: actual requested receipt/measurement absent |
| bc_16_0 | heldout / current | When is the adopted stopping intent recorded relative to router backup/native effects? | m_bc16a (3) |
| bc_16_1 | heldout / identifier | Which service observations and filesystem steps precede recording the original router attempt retired? | m_bc16b (3), m_bc16c (2) |
| bc_16_2 | heldout / relationship | How is durable stopping intent related to service absence, plist removal and the final retirement receipt? | m_bc16a (3), m_bc16b (3), m_bc16c (2) |
| bc_16_3 | heldout / summary | Outline the recorded adoption/backup intent and the subsequent service/file retirement steps. | m_bc16a (3), m_bc16b (3), m_bc16c (2) |
| bc_16_negative | heldout / negative | What exact hash of the owner actual retired router plist was adopted? | None: actual requested receipt/measurement absent |
| bc_17_0 | heldout / identifier | Which exact legacy router or owned daemon-label forms pass the native service guard? | m_bc17a (3) |
| bc_17_1 | heldout / paraphrase | How are observe/bootstrap/bootout arguments represented by LaunchdControl? | m_bc17b (3) |
| bc_17_2 | heldout / current | How does the legacy launchd list parser react to format drift, and which header/line-count guard must pass? | m_bc17c (3) |
| bc_17_3 | heldout / summary | Summarize service-label restrictions, control arguments and bounded launchd-list parsing. | m_bc17a (3), m_bc17b (3), m_bc17c (2) |
| bc_17_negative | heldout / negative | What PID does launchd currently report for the owner daemon service? | None: actual requested receipt/measurement absent |
| bc_18_0 | heldout / preference | Which consent and filesystem-device checks gate replacing an existing managed binary? | m_bc18a (3) |
| bc_18_1 | heldout / identifier | Which owned daemon-label/plist targets are constructed and what existing target causes refusal? | m_bc18b (3) |
| bc_18_2 | heldout / relationship | How do binary-replacement consent/device checks and an existing LaunchAgents target constrain an installation plan? | m_bc18a (3), m_bc18b (2) |
| bc_18_3 | heldout / summary | Outline existing-binary replacement safeguards and owned service-target creation/refusal. | m_bc18a (3), m_bc18b (2) |
| bc_18_negative | heldout / negative | What inode identified the existing installed binary in the owner latest backup? | None: actual requested receipt/measurement absent |
| bc_19_0 | heldout / identifier | Which original-job observer command, timeout and progress option are emitted? | m_bc19a (3) |
| bc_19_1 | heldout / paraphrase | Which inherited delegation/recursion environment controls are removed from the observer? | m_bc19b (3) |
| bc_19_2 | heldout / relationship | How do the original-job wait command and stripped caller/depth controls keep an observer bound to existing work? | m_bc19a (3), m_bc19b (2) |
| bc_19_3 | heldout / summary | Summarize the emitted observer wait and its inherited-environment removal. | m_bc19a (3), m_bc19b (2) |
| bc_19_negative | heldout / negative | Which Orca terminal handle did the most recent job observer actually create? | None: actual requested receipt/measurement absent |

## All 63 source notes

The provenance JSON contains the original quotation and byte boundaries for every row, plus all complete fact/overview alternatives. Source-note bodies fold whitespace only; facts/overviews are explicitly proposed paraphrases with owner review pending.

| Note | Exact source location / generation | Complete proposed fact |
|---|---|---|
| m_bc00a | [README.md:3–3](../research/checkpoints/bosun-corpus-2026-10-11/sources/README.md) · earlier-selected-snapshot | OpenCode is the primary Bosun host. |
| m_bc00b | [README.md:92–92](../research/checkpoints/bosun-corpus-2026-10-11/sources/README.md) · earlier-selected-snapshot | Optional vector retrieval defaults off. |
| m_bc00c | [README.md:92–92](../research/checkpoints/bosun-corpus-2026-10-11/sources/README.md) · earlier-selected-snapshot | The hook performs no embedding calls. |
| m_bc01a | [src/core/domain/config.ts:196–196](../research/checkpoints/bosun-corpus-2026-10-11/sources/src/core/domain/config.ts) · earlier-selected-snapshot | The configured automatic handoff threshold is 0.7. |
| m_bc01b | [src/core/domain/config.ts:198–199](../research/checkpoints/bosun-corpus-2026-10-11/sources/src/core/domain/config.ts) · earlier-selected-snapshot | Handoff allows 4096 summary tokens and 32000 input tokens. |
| m_bc01c | [src/core/domain/config.ts:203–204](../research/checkpoints/bosun-corpus-2026-10-11/sources/src/core/domain/config.ts) · earlier-selected-snapshot | Graph traversal defaults to at most 2 hops and 100 candidates. |
| m_bc02a | [src/core/ports/host.ts:31–37](../research/checkpoints/bosun-corpus-2026-10-11/sources/src/core/ports/host.ts) · earlier-selected-snapshot | Earlier snapshot A lists contextTelemetry, promptAdmission, toolQuiescence, freshSession, seedWithoutInference and freshReadiness.  |
| m_bc02b | [src/core/ports/host.ts:38–38](../research/checkpoints/bosun-corpus-2026-10-11/sources/src/core/ports/host.ts) · earlier-selected-snapshot | Native controls are contracts only; these definitions qualify no current host. |
| m_bc02c | [src/core/ports/host.ts:73–74](../research/checkpoints/bosun-corpus-2026-10-11/sources/src/core/ports/host.ts) · earlier-selected-snapshot | Persistent native processes must join before daemon ownership is released; close is an optional Promise<void> operation. |
| m_bc02d | [src/core/ports/host.ts:37–39](../research/checkpoints/bosun-corpus-corrected-2026-10-11/sources/host-later.ts) · later-read-only-contract-snapshot | Later snapshot B adds isolatedBootstrapTurn: one bounded tools-disabled readiness turn inside the admitted job, with independent seed/model/permission acknowledgement. |
| m_bc03a | [src/platform/paths.ts:22–22](../research/checkpoints/bosun-corpus-2026-10-11/sources/src/platform/paths.ts) · earlier-selected-snapshot | BOSUN_HOME overrides the HOME/homedir-based .bosun runtime home. |
| m_bc03b | [src/platform/paths.ts:23–23](../research/checkpoints/bosun-corpus-2026-10-11/sources/src/platform/paths.ts) · earlier-selected-snapshot | The run directory is the run child of the selected runtime home. |
| m_bc03c | [src/platform/paths.ts:26–26](../research/checkpoints/bosun-corpus-2026-10-11/sources/src/platform/paths.ts) · earlier-selected-snapshot | BOSUN_SOCKET overrides the default run/bosun.sock socket path. |
| m_bc04a | [src/app/native-runners.ts:9–10](../research/checkpoints/bosun-corpus-2026-10-11/sources/src/app/native-runners.ts) · earlier-selected-snapshot | Registry construction imports no adapter, inspects no auth, probes no host, and starts no server or directory; only queued selection loads an adapter. |
| m_bc04b | [src/app/native-runners.ts:36–38](../research/checkpoints/bosun-corpus-2026-10-11/sources/src/app/native-runners.ts) · earlier-selected-snapshot | nativeQuotaSources registers the Codex source only when config.hosts.codex.enabled. |
| m_bc04c | [src/app/native-runners.ts:41–42](../research/checkpoints/bosun-corpus-2026-10-11/sources/src/app/native-runners.ts) · earlier-selected-snapshot | The quota callback imports and calls createCodexQuotaSource with the selected cwd and Codex command. |
| m_bc05a | [src/core/use-cases/quota.ts:58–60](../research/checkpoints/bosun-corpus-2026-10-11/sources/src/core/use-cases/quota.ts) · earlier-selected-snapshot | Blocked quota denies admission with reason quota. Available evidence or allowUnknownQuota:true admits; other unknown evidence denies with admission_unavailable. |
| m_bc05b | [src/core/use-cases/quota.ts:55–55](../research/checkpoints/bosun-corpus-2026-10-11/sources/src/core/use-cases/quota.ts) · earlier-selected-snapshot | Job admission calls refresh with the job runner ID and the metadata model, forwarding the same signal. |
| m_bc05c | [src/core/use-cases/quota.ts:28–28](../research/checkpoints/bosun-corpus-2026-10-11/sources/src/core/use-cases/quota.ts) · earlier-selected-snapshot | refresh obtains its selected observations from deps.observe(chosen, signal), treating a thrown read as null. |
| m_bc05d | [src/core/use-cases/quota.ts:31–34](../research/checkpoints/bosun-corpus-2026-10-11/sources/src/core/use-cases/quota.ts) · earlier-selected-snapshot | Empty or absent observations preserve cached blocked status; otherwise refresh returns unknown. |
| m_bc05e | [src/core/use-cases/quota.ts:45–46](../research/checkpoints/bosun-corpus-2026-10-11/sources/src/core/use-cases/quota.ts) · earlier-selected-snapshot | A missing selected observation cannot make a cached healthy snapshot freshly successful; non-blocked evidence returns unknown. |
| m_bc06a | [src/core/use-cases/handoff.ts:337–338](../research/checkpoints/bosun-corpus-2026-10-11/sources/src/core/use-cases/handoff.ts) · earlier-selected-snapshot | The controller sets fenced=true before awaiting control.fenceAdmission(row.session, signal). |
| m_bc06b | [src/core/use-cases/handoff.ts:346–354](../research/checkpoints/bosun-corpus-2026-10-11/sources/src/core/use-cases/handoff.ts) · earlier-selected-snapshot | Quiescence must acknowledge the same session/generation, idle:true and pendingTools:0 before preparation. |
| m_bc06c | [src/core/use-cases/handoff.ts:391–393](../research/checkpoints/bosun-corpus-2026-10-11/sources/src/core/use-cases/handoff.ts) · earlier-selected-snapshot | Bootstrap has no dispatch ownership. One durable transferOwnership CAS retires the source and selects the acknowledged destination together. |
| m_bc07a | [src/adapters/hosts/opencode/control.ts:614–618](../research/checkpoints/bosun-corpus-2026-10-11/sources/src/adapters/hosts/opencode/control.ts) · earlier-selected-snapshot | OpenCode seed submission pins agent/provider/model/variant and uses noReply:true with its exact text part. |
| m_bc07b | [src/adapters/hosts/opencode/control.ts:622–634](../research/checkpoints/bosun-corpus-2026-10-11/sources/src/adapters/hosts/opencode/control.ts) · earlier-selected-snapshot | Seeding checks the returned message, then independently GETs the exact session/message ID and runs seedReadback again. |
| m_bc07c | [src/adapters/hosts/opencode/control.ts:635–637](../research/checkpoints/bosun-corpus-2026-10-11/sources/src/adapters/hosts/opencode/control.ts) · earlier-selected-snapshot | The seeded snapshot must be idle, have no pending work and contain exactly one row before phase becomes seeded. |
| m_bc07d | [src/adapters/hosts/opencode/control.ts:957–963](../research/checkpoints/bosun-corpus-2026-10-11/sources/src/adapters/hosts/opencode/control.ts) · earlier-selected-snapshot | startFresh validates its signal and owned source, requires an existing fence and no earlier fresh attempt, and obtains a freshClaim plus dispatch-owner gate. |
| m_bc08a | [src/adapters/hosts/codex/control.ts:505–516](../research/checkpoints/bosun-corpus-2026-10-11/sources/src/adapters/hosts/codex/control.ts) · earlier-selected-snapshot | thread/inject_items appends an assistant message with output_text body into the selected owned threadId. |
| m_bc08b | [src/adapters/hosts/codex/control.ts:546–559](../research/checkpoints/bosun-corpus-2026-10-11/sources/src/adapters/hosts/codex/control.ts) · earlier-selected-snapshot | Codex readiness independently reads exact owned rollout seed text, reasserts ownership, then returns ready root/idle with session/generation/seed hash/model/access. |
| m_bc09a | [src/core/lexical-memory.ts:5–7](../research/checkpoints/bosun-corpus-2026-10-11/sources/src/core/lexical-memory.ts) · earlier-selected-snapshot | Fixed lexical weights are title 5, body 1 and tags 2. |
| m_bc09b | [src/core/lexical-memory.ts:8–9](../research/checkpoints/bosun-corpus-2026-10-11/sources/src/core/lexical-memory.ts) · earlier-selected-snapshot | Lexical excerpt width is 240 characters and title width is 70 characters. |
| m_bc09c | [src/core/lexical-memory.ts:3–3](../research/checkpoints/bosun-corpus-2026-10-11/sources/src/core/lexical-memory.ts) · earlier-selected-snapshot | The lexical policy is fixed independently of evaluation labels or split membership. |
| m_bc10a | [src/core/secret-screen.ts:11–13](../research/checkpoints/bosun-corpus-2026-10-11/sources/src/core/secret-screen.ts) · earlier-selected-snapshot | screenPublicText rejects credential-shaped input using CREDENTIALS.some(pattern => pattern.test(text)) and throws private_input. |
| m_bc10b | [src/core/secret-screen.ts:3–4](../research/checkpoints/bosun-corpus-2026-10-11/sources/src/core/secret-screen.ts) · earlier-selected-snapshot | Credential screening is deterministic and cannot claim detection of arbitrary secrets; it never returns/logs/quarantines matched values, and privacy classification is separate. |
| m_bc11a | [src/core/use-cases/retrieve-context.ts:220–224](../research/checkpoints/bosun-corpus-2026-10-11/sources/src/core/use-cases/retrieve-context.ts) · earlier-selected-snapshot | Context candidates sort by descending score before the packer visits them. |
| m_bc11b | [src/core/use-cases/retrieve-context.ts:254–259](../research/checkpoints/bosun-corpus-2026-10-11/sources/src/core/use-cases/retrieve-context.ts) · earlier-selected-snapshot | Packing first caps a line to itemChars, then skips it if ceil((chars+1+line.length)/4) exceeds budgetTokens; accepted lines increase the character count. |
| m_bc12a | [src/core/domain/graph.ts:6–6](../research/checkpoints/bosun-corpus-2026-10-11/sources/src/core/domain/graph.ts) · earlier-selected-snapshot | GraphSupport contains memoryId, version and hash, with optional start/end spans. |
| m_bc12b | [src/core/domain/graph.ts:9–9](../research/checkpoints/bosun-corpus-2026-10-11/sources/src/core/domain/graph.ts) · earlier-selected-snapshot | GraphRelation contains from/to endpoints, a typed predicate (including related_to/uses/depends_on) and numeric weight. |
| m_bc12c | [src/core/domain/graph.ts:3–5](../research/checkpoints/bosun-corpus-2026-10-11/sources/src/core/domain/graph.ts) · earlier-selected-snapshot | Graph levels are 0–4; kinds are source/fact/entity/relation/summary/profile; statuses are proposed/active/dirty/archived. |
| m_bc13a | [src/app/consolidation.ts:24–24](../research/checkpoints/bosun-corpus-2026-10-11/sources/src/app/consolidation.ts) · earlier-selected-snapshot | Consolidation defaults allowRemoteApi:false but permits explicit options.policy overrides. |
| m_bc13b | [src/app/consolidation.ts:23–23](../research/checkpoints/bosun-corpus-2026-10-11/sources/src/app/consolidation.ts) · earlier-selected-snapshot | Consolidation maxOutstanding, maxSources and maxProposals use the corresponding CONSOLIDATION_LIMITS values. |
| m_bc13c | [src/app/consolidation.ts:26–27](../research/checkpoints/bosun-corpus-2026-10-11/sources/src/app/consolidation.ts) · earlier-selected-snapshot | Consolidation validates maxOutstanding 1–20, maxSources 1–8, maxProposals 1–4, maxInputBytes 4096–24576, timeout 1–300000ms and boolean allowRemoteApi. |
| m_bc14a | [src/app/embeddings.ts:114–118](../research/checkpoints/bosun-corpus-2026-10-11/sources/src/app/embeddings.ts) · earlier-selected-snapshot | Query-cache lookup requires a nonzero queryCacheSize; an entry is reusable only while its age is at most queryCacheTtlMs. |
| m_bc14b | [src/app/embeddings.ts:165–173](../research/checkpoints/bosun-corpus-2026-10-11/sources/src/app/embeddings.ts) · earlier-selected-snapshot | After verification, an uncached vector is stored with performance.now and vector; oldest entries are removed until queries.size fits queryCacheSize. |
| m_bc15a | [src/app/remote-views.ts:144–145](../research/checkpoints/bosun-corpus-2026-10-11/sources/src/app/remote-views.ts) · earlier-selected-snapshot | pending, acquire-unknown and release-unknown leases throw unverified with Reconcile the original remote lease first. |
| m_bc15b | [src/app/remote-views.ts:147–152](../research/checkpoints/bosun-corpus-2026-10-11/sources/src/app/remote-views.ts) · earlier-selected-snapshot | remote.view.release is bound to the previous intent ID and clientId, original intent and AbortSignal. |
| m_bc16a | [src/app/upgrade-router.ts:184–185](../research/checkpoints/bosun-corpus-2026-10-11/sources/src/app/upgrade-router.ts) · earlier-selected-snapshot | The router retirement record preserves file/hash/backup/adopted:true; durable stopping intent is recorded before backup/native effects. |
| m_bc16b | [src/app/upgrade-router.ts:205–210](../research/checkpoints/bosun-corpus-2026-10-11/sources/src/app/upgrade-router.ts) · earlier-selected-snapshot | Router retirement observes com.bosun.router, conditionally bootouts, reobserves absence and refuses remaining service presence or an aborted signal. |
| m_bc17a | [src/adapters/services/launchd.ts:19–20](../research/checkpoints/bosun-corpus-2026-10-11/sources/src/adapters/services/launchd.ts) · earlier-selected-snapshot | The service-label guard accepts com.bosun.router or com.bosun.daemon.<32 lowercase hex>; other labels throw invalid. |
| m_bc17b | [src/adapters/services/launchd.ts:13–15](../research/checkpoints/bosun-corpus-2026-10-11/sources/src/adapters/services/launchd.ts) · earlier-selected-snapshot | LaunchdControl observes by label/signal, bootstraps by file/signal, and bootouts by label/signal. |
| m_bc17c | [src/adapters/services/launchd.ts:22–27](../research/checkpoints/bosun-corpus-2026-10-11/sources/src/adapters/services/launchd.ts) · earlier-selected-snapshot | launchdList validates the selected label, accepts only PID/Status/Label headers, caps the list at 4097 lines and holds format drift as unverified. |
| m_bc18a | [src/app/installation.ts:160–164](../research/checkpoints/bosun-corpus-2026-10-11/sources/src/app/installation.ts) · earlier-selected-snapshot | An existing managed binary requires replaceExisting consent; its device must match the Bosun-home device for the supported backup. |
| m_bc18b | [src/app/installation.ts:165–168](../research/checkpoints/bosun-corpus-2026-10-11/sources/src/app/installation.ts) · earlier-selected-snapshot | An installation uses com.bosun.daemon.<id suffix>, creates a daemon.plist, and refuses an existing user LaunchAgents target. |
| m_bc19a | [src/platform/watch-command.ts:57–57](../research/checkpoints/bosun-corpus-2026-10-11/sources/src/platform/watch-command.ts) · earlier-selected-snapshot | An observer runs job wait on the original job ID with --timeout 300000 and --progress. |
| m_bc19b | [src/platform/watch-command.ts:57–57](../research/checkpoints/bosun-corpus-2026-10-11/sources/src/platform/watch-command.ts) · earlier-selected-snapshot | The observer command removes inherited BOSUN_CALLER and BOSUN_DEPTH. |
| m_bc04d | [src/app/native-runners.ts:43–44](../research/checkpoints/bosun-corpus-2026-10-11/sources/src/app/native-runners.ts) · earlier-selected-snapshot | The quota constructor preserves an explicit CODEX_HOME override and pins 3000ms request/15000ms process deadlines before read(selection, signal). |
| m_bc16c | [src/app/upgrade-router.ts:213–220](../research/checkpoints/bosun-corpus-2026-10-11/sources/src/app/upgrade-router.ts) · earlier-selected-snapshot | After service absence, retirement unlinks the original plist, fsyncs its directory and records the original attempt retired. |
| m_bc06d | [src/core/use-cases/handoff.ts:372–374](../research/checkpoints/bosun-corpus-2026-10-11/sources/src/core/use-cases/handoff.ts) · earlier-selected-snapshot | Earlier saved handoff snapshot A records destination ownership, directly awaits control.seed(destination, seed, signal), then continues. |
| m_bc06e | [src/core/use-cases/handoff.ts:378–381](../research/checkpoints/bosun-corpus-evaluation-2026-10-11/sources/handoff-later.ts) · later-read-only-handoff-snapshot | Later saved handoff snapshot B calls dependencies.bootstrap when the callback is provided; otherwise it directly calls control.seed. |
| m_bc06f | [src/core/use-cases/handoff.ts:318–320](../research/checkpoints/bosun-corpus-evaluation-2026-10-11/sources/handoff-later.ts) · later-read-only-handoff-snapshot | Later saved handoff snapshot B first requires managed control, then rejects bootstrapUsesInference(control) with unsupported when the application bootstrap callback is missing. |
| m_bc06g | [src/core/use-cases/handoff.ts:313–315](../research/checkpoints/bosun-corpus-2026-10-11/sources/src/core/use-cases/handoff.ts) · earlier-selected-snapshot | Earlier saved handoff snapshot A still requires managed control; the displayed prefix then checks cancellation without the later application-bootstrap guard. |
| m_bc06h | [src/core/use-cases/handoff.ts:101–104](../research/checkpoints/bosun-corpus-evaluation-2026-10-11/sources/handoff-later.ts) · later-read-only-handoff-snapshot | Later handoff dependencies require model-backed bootstrap to use the application quota/usage authority and declare an optional bootstrap(control, session, seed, signal) callback. |
