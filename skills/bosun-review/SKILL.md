---
name: bosun-review
description: Use before shipping any change, or when asked to review a diff or a pull request. Runs the cross-vendor reviewer (the other vendor's model, read-only), checks every finding against the code, and fixes the real ones through the lanes.
---

# bosun-review

1. `bosun card in-review "review: <topic>"`.
2. Run the reviewer. `bosun review` reviews the working change against the default branch; use `bosun review --pr <n>` for a pull request, or `bosun review --base <ref>` for another base. In Claude Code, run it in the background.
3. For each finding, open the file:line and decide whether it's **real** (you can see the bug or the risk) or **wrong** (say why in one line). Never apply a finding you haven't confirmed, and never argue with one you have.
4. For real P0 and P1 findings, write a spec per fix and run **bosun-build**. List P2 findings for the user and fix them only if trivial.
5. Re-run the verify commands after the fixes. Re-run `bosun review` only if the fixes were non-trivial.
6. Report the findings (real and wrong), what was fixed, and what's left. Continue with **bosun-ship** when the user wants to ship.
