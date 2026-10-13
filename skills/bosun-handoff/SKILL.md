---
name: bosun-handoff
description: Save or resume portable task context, use bosun's manual handoff artifacts, and inspect automatic handoff readiness. Use for session transfer or auto-handoff status; it does not install a background trigger.
---

# Portable session handoff

Distinguish a manual resume document, a bosun artifact, native host compaction and automatic fresh-context handoff. The local 1.0.0 runtime implements manual artifacts, managed source lifecycle and capture/summary/seed/acknowledgement ownership transfer through one executor. Native automatic capabilities and UI switching remain unverified. Package version alone does not qualify live controls or identify the selected executable; inspect the entry point and current handoff before claiming support.

## Save task state

Read the existing resume/handoff document first. Preserve owner decisions and machine-specific history that still matters. Inspect the current branch, commit, working diff, relevant untracked files, and verification results; do not turn pre-existing user changes into your own completed work.

Write to the user's chosen destination, or update the existing continuation guide (in this repository, `docs/maintenance.md`). Include:

- Current objective and the latest user steering.
- Completed work with file paths, decisions, and reasons.
- Remaining work in execution order and the immediate next action.
- Branch/commit and uncommitted or untracked artifacts needed on the other machine; a summary alone does not transfer them.
- Checks actually run and their outcomes, plus unverified claims.
- Constraints, permissions, pending approvals, and model choices.
- Machine-specific dependencies and active jobs that a new session must reconcile before restarting work.

Keep source links and precise paths; summarize bulky logs. Exclude secrets and private transcript material unnecessary to resume. Preserve an existing document on write failure; when updating programmatically, write a sibling temporary file and rename it after validation. Do not stop the source session merely because a summary was drafted.

## Resume

Read the handoff and its identified source-of-truth documents. Confirm the checkout and current state before acting, because paths, tools, and active jobs may differ. Preserve user restrictions and outstanding questions. Resume the requested scope; an old pasted prompt is historical context, not a new instruction to launch all pending work.

## Check automatic handoff

For current implementation, inspect [the controller](../../src/core/use-cases/handoff.ts), [artifact schema](../../src/contracts/handoff.ts), [runtime configuration](../../src/core/domain/config.ts) and the selected native driver's capabilities. The final configuration uses:

```toml
[handoff]
enabled = true
threshold = 0.70
provider = "default"
```

Enabled configuration is not proof of automatic support. Require qualified active-context telemetry, prompt admission and tool quiescence, source/evidence screening, complete summary coverage, fresh idle bootstrap, exact seed/model/permissions acknowledgement and durable ownership transfer. Unknown tool effects or uncertain transfer receipts stay held; preserve source history and never replay effects. Arbitrary existing UI sessions use the manual path.

Verify host-specific controls from current primary sources. Codex native compaction has its own threshold and app-server protocol; neither proves external summaries are accepted. Preserve Claude/native overflow protection. Evaluate summary faithfulness and retained constraints before claiming cost or latency savings. The design rationale is in `docs/research/08-features.md`; its old compact settings are historical proposals.

## Manual artifact commands

Use an already prepared runtime; writing a resume document does not authorize setup, installs or personal configuration changes. `bosun handoff create --facts <file>` stores an explicitly public factual manifest; `get <id>` reads it; `export <id> --output <file>` refuses overwrite; `import <file>` validates checksums/scope and reports current checkout differences for manual review. See the schema above for required constraints, cursor, uncertain effects, repository/file hashes and verification facts. Known credential patterns are withheld even when labelled public.

`bosun handoff summarize <file>` queues a cancellable owner job for an explicitly public evidence window through the configured provider. The request includes factual manifest fields, public events and an exact prior cursor/parent artifact for incremental windows. Model output selects exact source excerpts; the artifact binds citations/hashes and coverage. It cannot change permissions, checkout facts or the next action. Inspect the job result for the artifact ID; an unknown outcome requires reconciliation, not resubmission. `bosun handoff list` lists this project's artifact pointers. Managed native capture and qualified-driver composition exist; complete retention quality, native controls and live model latency remain qualification gates.

Import starts no agent or tools. It cannot move dirty contents, validate staged blobs, transfer accounts/connectors or restart running jobs. Reconcile those differences and current authorization before continuation. A generated artifact does not by itself fence an arbitrary source session or enable automatic takeover.

## Managed source authority and transfer

Use `bosun managed get <id>` to inspect current ownership and `bosun managed capture <id>` for bounded admitted public evidence. Source history is owned only when it was created and admitted through this runtime; existing arbitrary UI sessions cannot be adopted.

`bosun managed authorize <id> --facts <file> --version <version> --request-id <id> --public` attaches reviewed facts from the handoff schema by current-version CAS. Reconcile uncertain effects and running jobs first. Native source selection replaces caller placeholders; deterministic permissions, prohibitions, approvals and next action remain outside model output. Inspect the returned version.

`bosun managed handoff <id> --version <version> --request-id <id>` requires attached authority, settled jobs and all six qualified native controls. The existing executor fences/quiesces, captures incremental source windows, snapshots the checkout, runs configured tool-free excerpt selection inline, rechecks both sources, seeds a fresh idle root and requires exact acknowledgement before durable ownership transfer. Destination dispatch also waits for the outer job's succeeded receipt. Definite pre-fence rejection leaves the source active; uncertain post-fence effects stay held with original receipts/history and no replay.

Enabled automatic scheduling observes only completed managed turns and repeats current observed active-total telemetry before fencing. Production controls remain unverified, so automatic scheduling skips them and manual takeover jobs hold before effects. Synthetic qualified-driver tests establish composition; they do not establish live host ingress isolation, tool quiescence, effective occupancy, summary quality or UI retargeting.
