---
name: bosun-review
description: "Use when asked to review a checked-out change or at an explicit build or ship checkpoint. Queue a revision-bound read-only native review and verify its proposed findings against the current code."
---

# bosun-review

Review a checked-out change with an explicitly public source classification. Preserve the selected reviewer model and host; use the configured reviewer binding or `--model`. A declared `--source-host claude` selects Codex by default, and `--source-host codex` selects Claude. OMP is otherwise primary; OpenCode 2 remains selectable. Different native harnesses do not prove different effective model vendors.

Run `bosun review --public --base <committed-base> --host <native-host> --model <selected-model> --request-id <stable-id>`. The default base is `main`; select another base explicitly when needed. The daemon queues the review with read access through its existing quota/runner gates. It includes committed, staged, working and untracked changes within the input budget. Use `--paths <comma-separated-exact-files>` for related batches; pathspecs are literal, and status reports selected-file coverage. The whole checkout revision still binds each batch. Do not truncate a diff and call it complete. PR fetching is not currently integrated: review its already prepared checkout and base.

Keep the returned review ID and job ID. Inspect `bosun review get <review-id>` and `bosun job get <job-id>`; read findings with `bosun job result <job-id>` after completion. An unchanged checkout returns no job. A held or unknown request requires inspection; preserve its stable request ID rather than replaying it with another identifier.

For each proposed finding, open the referenced code and decide whether the issue is real. Explain rejected findings briefly. Fix confirmed P0/P1 issues through the approved task workflow, and report lower-priority findings to the user. The model never approves, applies or merges a change.

Record explicit verification with `bosun check run <review-id> --command <executable> --args <JSON-argument-array> --request-id <stable-id>`. Use `[]` when there are no arguments and select a bounded `--timeout` when needed. This executes the selected command with a filtered environment and a new private HOME, without a shell or inherited authentication. Preserve the original request after uncertainty; unknown effects block another unsettled request for the same invocation.

Inspect `bosun check get <check-id>` and current `bosun review get <review-id>`. Command exit, executable/argument/environment identity and checkout revision determine whether recorded evidence is usable. File contents, permissions, staged state, branch, base or command changes invalidate prior evidence. Later explicit checks retain earlier receipts; status identifies the latest invocation and keeps unknown effects visible. Recorded-command coverage does not imply that every necessary check was selected, and passing checks never approve or merge code. Batch related fixes, run the checks appropriate to the change and request another review at a meaningful checkpoint. Report confirmed findings, fixes, actual checks and remaining work, then follow the user's shipping instructions.
