---
name: bosun-handoff
description: Save or resume portable task context across machines or fresh sessions, and inspect bosun's planned automatic context handoff. Use when asked to prepare a resume file, transfer session context, or check auto-handoff status; it does not install a background trigger.
---

# Portable session handoff

Distinguish a manual resume document, native host compaction, and bosun's automatic fresh-context handoff. In v0.2, only the documents and required v1.0 design exist: there is no bosun context monitor, summary generator, or restart controller. Recheck implementation before claiming a later version supports them.

## Save task state

Read the existing resume/handoff document first. Preserve owner decisions and machine-specific history that still matters. Inspect the current branch, commit, working diff, relevant untracked files, and verification results; do not turn pre-existing user changes into your own completed work.

Write to the user's chosen destination, or the existing project `RESUME.md`. Include:

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

In this repository, follow the required feature in `docs/research/README.md` and the topic 8 prompt in `docs/research/RESUME.md`. Its proposed settings are:

```toml
[compact]
enabled = true
model = "ollama:qwen3:8b"
threshold = 0.70
```

These are planned v1.0 settings, not accepted v0.2 configuration. A design must establish per-host usage telemetry, triggering and completion support, external-summary model access, durable summary storage, and an acknowledged fresh-session start. Preserve the source work if summarization or startup fails, and avoid concurrent duplicate work.

Verify host-specific controls from current primary sources. Codex native compaction has its own token threshold and app-server protocol; neither proves arbitrary external-model summaries are supported. For Claude, verify its current hooks and compaction controls separately. Evaluate summary faithfulness and retained constraints before claiming cost savings. This skill can prepare a handoff now; automatic threshold monitoring requires implementation.
