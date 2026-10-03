---
name: bosun-build
description: Use to execute a bosun plan or a single spec - dispatches each task to its lane (local model, worker, tester), verifies every task yourself, and escalates after repeated failure instead of looping.
---

# bosun-build

For each task, in order, set `bosun card in-progress "task <i>/<n>: <title>"`, then:

1. Dispatch it by lane:
   - **local**: `bosun run -f - <<'SPEC'`, then the task spec, then `SPEC`. In Claude Code, run it in the background; in Codex, give it a 30-minute timeout.
   - **worker** or **tester**: call that role with the task spec verbatim.
   - **main**: do it yourself.
2. When it returns, read `git status --short` (new files) and `git diff` for the task's files, and run the task's verify command yourself. The executor's summary is not proof.
3. If it passes, go to the next task. If it fails, fix the spec (missing context, wrong file) and retry the same lane once. On a second failure, escalate one lane: local → worker → main.
4. If a task turns out to need a design decision, stop and use **bosun-design** for it.

After the last task, run the whole verify set (tsc, lint, the tests the plan names) and continue with **bosun-review**.
