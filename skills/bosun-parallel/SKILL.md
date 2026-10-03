---
name: bosun-parallel
description: Use only when the user explicitly asks to parallelize, fan out, or run tasks at the same time. Turns independent plan tasks into supervised Orca workers, each in its own worktree with its role's model and effort, then reviews and gathers the results.
---

# bosun-parallel

1. This needs Orca and a plan (**bosun-plan**). Load Orca's own `orchestration` skill and follow its supervised loop exactly; this skill only adds bosun's mapping.
2. Pick the independent tasks: no shared files and no dependency between them. Everything else stays sequential, with **bosun-build**.
3. `bosun roles --json` gives each role's model and effort for this host. Save each task's spec and acceptance to a file (e.g. `~/.bosun/plans/<slug>-task-<n>.md`), then run:
   `orca orchestration worker-start --spec "$(cat <spec file>)" --worktree new-child --agent <host> --model <role model> --effort <role effort> --json`
   Never paste spec text between double quotes: the shell would run anything in backticks or `$(…)`.
   Leave out `--effort` when the role has none. The role comes from the task's lane: a **worker** or **tester** lane uses that role's model; a local-lane task goes to a worker whose spec says "use `bosun run` for the edit".
4. End every worker spec with: "Do not commit or push. Do not spin off or parallelize further."
5. Wait with `orca orchestration check --wait`, as the orchestration skill describes. For each `worker_done`, read its diff in its worktree, run its verify, then use **bosun-review** on it.
6. Report each task's outcome, the evidence, and any blockers. Merging the branches back is the user's call.
