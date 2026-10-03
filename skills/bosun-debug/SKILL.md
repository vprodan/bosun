---
name: bosun-debug
description: Use for a bug, failing test, crash, wrong output or regression, before proposing any fix. Reproduce, rank hypotheses, gather evidence with the debugger role, confirm the root cause, then fix it minimally in the shared place.
---

# bosun-debug

1. `bosun card in-progress "debugging: <symptom>"`.
2. Call the **debugger** role with the symptom, how the user sees it, recent changes (`git log -5 --oneline`), and the suspected area. It returns REPRO, HYPOTHESES with evidence, ROOT CAUSE, MINIMAL FIX and CONFIDENCE.
3. If there's no reproduction, get what's missing (logs, input, environment) before anything else. Don't guess-fix.
4. Confirm the root cause yourself: read the file:line it names and check that the evidence explains the symptom.
5. If the debugger reports 2 disproven hypotheses, or its confidence is low, call the **architect** role with everything learned so far.
6. Fix: turn MINIMAL FIX into a spec and run **bosun-build** on it. When the bug is testable, have the **tester** role add a regression test first. Fix the root cause where every caller goes through it, not in each caller.
