---
name: bosun-ship
description: Use when the user wants to ship, commit or open a pull request. Checks the evidence (verify commands, types, lint, tests), writes the commit message and PR text, and commits, pushes or opens the PR only when the user explicitly asks.
---

# bosun-ship

1. **Evidence gate.** Run and quote the output of each: the plan's verify commands, the typecheck (`tsc --noEmit` or the repo's script), lint, and the affected tests. Anything red goes back to **bosun-build** or **bosun-debug**. "Should pass" isn't evidence.
2. Check `git status` for stray files (plans live in ~/.bosun, not the repo), secrets and leftover debug logging.
3. Write the commit message (why, then what). For a PR, write the description: summary, risk areas, how it was verified, and the review findings addressed.
4. Run `git commit`, `git push` or `gh pr create` only when the user explicitly says so. Otherwise, hand over the message and description.
5. `bosun card in-review "<PR link, or ready to commit>"`, then `bosun card completed` once it's merged.
