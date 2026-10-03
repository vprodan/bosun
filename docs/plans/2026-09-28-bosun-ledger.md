# SDD ledger — plan: docs/plans/2026-09-28-bosun.md
Spec: docs/specs/2026-09-28-bosun-design.md
Setup: Ruling: no git repo (user did not ask for git init) — no worktree, no commits, BASE n/a; each task closes with `npm test` recorded here — cost if wrong: no per-task diff history (user can git init later)

Pre-flight (shared interfaces):
- T1 util/config/cli -> all tasks: P keys, load(), has/sh/die, COMMANDS table — consistent
- T2 roles -> T6 exec (reviewerBody), T7 wire (allRoles/renderClaude/renderCodex/MARK), T8 lint, T9 doctor — consistent
- T3 route.main -> T4 status (--stats) — consistent
- T5 orca.inOrca/watch(job,cfg) -> T6 run; job {cmd,args,set,unset,cwd} — consistent
- T4 chk() -> T9 doctor — consistent (defined in T4)
- T7 wire.PERMS/plugins/enabledOverlap/unwire -> T9 install/doctor/uninstall — consistent
- T7 needs a skill folder for link tests -> stub bosun-review, replaced in T8 — consistent
Task 1: complete (tests: npm test → 3/3 pass)
Task 2: complete (tests: npm test → 5/5 pass)
Task 3: complete (tests: npm test → 7/7 pass)
Task 4: Ruling: services start/stop test passed before implementation (unknown command also exits 2) — added an assertion on the 'target must be' message so it fails for the right reason — cost if wrong: none
Task 4: complete (tests: npm test → 10/10 pass)
Task 5: complete (tests: npm test → 13/13 pass)
Task 6: complete (tests: npm test → 18/18 pass)
Task 7: complete (tests: npm test → 21/21 pass)
Task 8: complete (tests: npm test → 23/23 pass)
Task 9: complete (tests: npm test → 26/26 pass)
Task 10: complete (tests: npm test from ~/Developer/bosun → 26/26 pass; folder renamed, symlink ai-offload -> bosun left for this session)
Final review: fresh reviewer (opus), verdict "With fixes", 0 Critical, 8 Important, 20 Minor, 14 declined.
Final: re-grade — Important kept: #1 Codex home inside Orca, #2 JSON preflight, #3 parallel --spec quoting, #4 watch pane blank, #5 claude reviewer loads project settings, #6 Codex sandbox blocks bosun cmds, #7 untracked outside cwd, #8 Ollama.app env after reboot
Final: re-grade — Minor→Important: local lane can't "move" (git mv/mkdir -p not allowed) — routing sends move to local; unbalanced bosun markers → unwire deletes user text (data loss); launchd bootout→bootstrap EIO breaks the documented "safe to re-run" install
Final: Ruling: #1 — P.CODEX is ~/.codex (not the inherited CODEX_HOME); rules+agents also go to Orca's codex home (ORCA_CODEX_HOME or its default path, if present); the hook only into ~/.codex/hooks.json because Orca manages and rewrites its own hooks.json — cost if wrong: Codex-in-Orca gets no Kev hint (advisory only)
Final: Ruling: #5 — use --restricted --strict-mcp-config for the Claude reviewer (tools Read,Glob,Grep) and for -e claude (FENCE tools) instead of --setting-sources project,local; verified against real claude 2.1.283 via mock — cost if wrong: subscription login under --restricted unverified live (help says it only ignores settings files)
Final: Ruling: #6 — no Codex exec-policy allow rules (syntax/semantics unverified, security-sensitive); the Codex policy block tells the model bosun commands need localhost + ~/.bosun and must run outside the sandbox with approval — cost if wrong: one approval prompt per bosun command until the user chooses always-allow
Final: Ruling: declined "parent-session vars inherited" — treated as a finding: the local executor strips inherited CLAUDE_CODE_*, CLAUDECODE, CLAUDE_EFFORT before setting its own env (job env now built as base − unset + set) — cost if wrong: none; it runs --bare with a dummy key
Final: Ruling: declined Codex 0.158 flags/formats, GPT-6 ids, Orca JSON field names, Codex auth in Orca, heredoc permission matching, Kev accuracy, Node 20 run — stand as unverified; listed in HANDOFF — cost if wrong: first live install surfaces them
Final: Ruling: declined CLAUDE_CODE_AUTO_COMPACT_WINDOW=65536 below --autocompact's 100k minimum — stands; noted in HANDOFF — cost if wrong: long local runs may hit Ollama's 64K context and fail, then escalate
Final: Ruling: declined gh pr diff vs local checkout, diffs sent to the other vendor, router log keeps 300 chars of prompts — by design, stand — cost if wrong: none new
Final: fixed #1 Codex home inside Orca — "wire: inside Orca, Codex rules + agents also go to Orca's codex home…" RED→GREEN, suite 35/35
Final: fixed #2 JSON preflight before install/uninstall/unwire — "wire: a broken hooks.json stops unwire…" + "cli: install and uninstall check every config file…" RED→GREEN, suite 35/35
Final: fixed #3 bosun-parallel --spec quoting — "lint: no skill passes spec text to a shell inside double quotes" RED→GREEN, suite 35/35
Final: fixed #4 watch pane blank for Claude harness (stream-json → pane lines, final result to main) — "execJob: a streamed Claude run shows progress…" + watch argv assertions RED→GREEN, suite 35/35
Final: fixed #5 Claude reviewer + -e claude load project settings (now --restricted --strict-mcp-config, reviewer tools Read,Glob,Grep) — buildRun/buildReview assertions RED→GREEN, suite 35/35
Final: fixed #6 Codex sandbox note in the Codex policy block — "wire: the Codex block says bosun commands run outside the sandbox…" RED→GREEN, suite 35/35
Final: fixed #7 untracked files outside cwd (git ls-files --full-name -- :/) — review test from pkg/ RED→GREEN, suite 35/35
Final: fixed #8 doctor detects Ollama.app env lost after reboot — "cli: doctor notices Ollama.app lost bosun env" RED→GREEN, suite 35/35
Final: fixed local lane can't move files (Bash(git mv *), Bash(mkdir -p *) allowed) — buildRun assertion RED→GREEN, suite 35/35
Final: fixed unmatched bosun marker eats user text — "wire: an unmatched bosun marker stops wiring and unwiring…" RED→GREEN, suite 35/35
Final: fixed launchd bootstrap EIO after bootout (4 tries, 0.5 s apart) — "services: svcOn retries a failing launchctl bootstrap" RED→GREEN, suite 35/35
Final: fixed parent-session env leaking into the local executor (CLAUDECODE, CLAUDE_EFFORT, CLAUDE_CODE_* stripped; ours set after) — run (inline) assertions RED→GREEN, suite 35/35
Final: minor (deferred): split returns non-zero but pane opened anyway → possible double run (claim .pid before inline fallback)
Final: minor (deferred): .rc written in place; a reader could see an empty file and report success (write .rc.tmp + rename)
Final: minor (deferred): split targets the active terminal; pass --terminal $ORCA_TERMINAL_HANDLE
Final: minor (deferred): 30-min watch timeout leaves the executor running
Final: minor (deferred): plain re-install silently re-enables plugins disabled by an earlier --replace-plugins
Final: minor (deferred): restore edge cases — trailing whitespace/CRLF normalized, created CLAUDE.md/AGENTS.md left empty, missing settings/hooks left as {}, no backup of CLAUDE.md/AGENTS.md
Final: minor (deferred): uninstall removes ~/.local/bin/bosun even if not bosun's link; .zshrc PATH line never removed; appEnv unset clears user's own OLLAMA_* launchctl vars; .bak-bosun files never restored
Final: minor (deferred): also strip CLAUDE_CODE_OAUTH_TOKEN / CLAUDE_CODE_USE_FOUNDRY for -e claude? (local already strips CLAUDE_CODE_*)
Final: minor (deferred): Kev bind address not passed explicitly (relies on kev.serve default 127.0.0.1)
Final: minor (deferred): spin --agent defaults to claude on a Codex host; --name unsanitized; wt id unchecked; card status not validated
Final: minor (deferred): policy/bosun-build say "read git diff" — new files need git status --short too
Final: minor (deferred): ~/.bosun/runs never pruned; smoke test has no timeout
Final: minor (deferred): test gaps — watched run with tricky text, late split after inline claim, 130 path asserts log path
Final: minor (deferred): eval says "label at least 30" but gates on 10
Final: Ruling: no git, so the ledger is the only record — moved to docs/plans/2026-09-28-bosun-ledger.md, scratch logs deleted; finishing-a-development-branch skipped (no branch to merge) — cost if wrong: none

## Follow-up pass: deferred minors (user said "continue")
Fixed test-first, suite 43/43:
- watched runs: split next to $ORCA_TERMINAL_HANDLE; a failed split report claims the run before the inline fallback (no double run); empty .rc = not written (atomic tmp+rename writer); timeout SIGTERMs the executor; runs older than 7 days pruned — "run (watch, hardening)…" RED→GREEN
- spin defaults to the host agent (codex inside Codex); --name sanitized; missing worktree id refused; card rejects malformed status — spin/card tests RED→GREEN
- --replace-plugins sticky across re-installs until uninstall (wire.rewire) — RED→GREEN
- files bosun created are removed on unwire; CLAUDE.md/AGENTS.md backed up before the first change; user files moved aside to .bak-bosun come back — RED→GREEN
- uninstall removes only bosun's own ~/.local/bin link, its own .zshrc line, and restores the user's launchctl values (recorded as appEnvPrev at install) — RED→GREEN
- verify rule says `git status --short` + `git diff` (policy, bosun-build) — lint RED→GREEN
- eval asks for at least 10 labels, matching its gate — RED→GREEN
- smoke test has a 10-minute timeout (no test: a spawn option)
Ruling: the Orca-home unwire test now expects AGENTS.md removed (bosun created it) — the created-file cleanup is the intended new behavior — cost if wrong: none
Ruling: appEnvPrev recording runs only inside `bosun install` with Ollama.app (not testable offline); the uninstall side is tested — cost if wrong: uninstall falls back to unsetting bosun's keys
Ruling: -e claude keeps CLAUDE_CODE_OAUTH_TOKEN / CLAUDE_CODE_USE_FOUNDRY — they may be how the user signs in; the local executor already strips all CLAUDE_CODE_* — cost if wrong: none
Ruling: Kev bind address stays on kev.serve's default (127.0.0.1, read from its source) — an unknown flag could stop the server — cost if wrong: Kev reachable on the LAN if upstream changes its default
Ruling: trailing-whitespace/CRLF normalization on restore and a second .bak-bosun overwriting an older one stay — cosmetic / very rare — cost if wrong: whitespace diffs; an old backup lost
