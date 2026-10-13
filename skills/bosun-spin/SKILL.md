---
name: bosun-spin
description: "Use when the user asks to spin off a separate background task in an owned Git worktree through the existing bosun daemon. Session transfer uses bosun-handoff."
---

# bosun-spin

Write an explicitly public task file with the target, change, constraints, needed context and observable acceptance. A worker receives this task, without the source conversation or dirty source files. Choose a committed base with `--base` when needed.

Select the native host and preserve the user's model choice: OMP is primary; OpenCode 2, Codex and Claude Code are also supported. Use the configured worker binding or an explicit `--model`; do not substitute a host/model to bypass a hold. Declare `--operation <kind>` and `--files <exact-path-list>` for scoped editing work. Protected operations/paths hold editing jobs for main-thread planning and a read-only reviewer. `--no-delegation` and `--exact-model <model>` preserve explicit restrictions; `bosun job policy <id>` explains a policy hold. Missing model-origin editing scope stays held.

Use `bosun spin --name task --host omp --model <selected-model> --request-id <stable-id> -f <public-task-file>`. For inline stdin, use a quoted heredoc delimiter with `-f -`. Add `--effort` only when selected and `--read-only` for an inspection task. This queues through the existing daemon and its quota/admission checks. The command does not install tools or start an Orca terminal.

Report the returned worktree ID/path and job ID, then continue the main task. Inspect with `bosun job get <id>` and `bosun job result <id>` when useful. A held or unknown result is not completion. If creation returns no job, preserve the worktree receipt; reuse the same request ID to inspect it instead of starting another attempt after uncertainty.

To queue more work in an existing owned checkout, use `bosun workspace run <worktree-id> <public-task> --version <workspace-version> --host <native-host> --model <selected-model> --request-id <stable-id>`. Reconcile with `bosun workspace reconcile <id>` or inspect `bosun workspace prune-preview <id>`; previews leave files and branches untouched. Fresh session acknowledgement and automatic handoff require their separate qualified host workflow.
