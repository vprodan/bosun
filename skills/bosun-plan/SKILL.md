---
name: bosun-plan
description: Use when a design is approved or a goal is already clear and needs splitting into executable tasks. Writes task specs with a lane each (local, worker, tester, main) and a verify command, saved outside the repo in ~/.bosun/plans.
---

# bosun-plan

1. File: `~/.bosun/plans/<repo>-<yyyymmdd>-<slug>.md`, where `<repo>` is the basename of the git root. Start it with the goal and the decision.
2. Split the work into tasks. Each task is one change a reviewer could accept or reject on its own:

       ## Task <n>: <title>
       lane: local | worker | tester | main
       target: <files>
       change: <exact change>
       must not change: <public APIs, files, behaviour>
       verify: <command, e.g. yarn tsc --noEmit && yarn test src/order>
       depends on: <task numbers, or none>

3. Lane rules:
   - **local** is mechanical, with an obvious answer: rename, move, add a field end to end, imports, known type or lint fixes.
   - **worker** needs reasoning but is fully specified.
   - **tester** writes the tests for another task; put it first for TDD.
   - **main** is risk high (payments, orders, invoices, auth, data, infra) or can't be fully specified.
4. Order the tasks so each verify can pass on its own. Mark the groups that are independent, for bosun-parallel.
5. `bosun card in-progress "plan ready (<n> tasks)"`. Show the tasks, one line each, and continue with **bosun-build** unless the user wants changes.
