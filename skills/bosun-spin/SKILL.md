---
name: bosun-spin
description: Use when the user says spin this off, side quest, do that in the background or in another worktree, or when a separate task turns up mid-work that should not block the current one. Hands it to a new Orca worktree with its own agent.
---

# bosun-spin

1. Write a self-contained spec, because the new agent sees nothing of this conversation. Include: target (repo and files), change, constraints, must-not-change, observable acceptance (a verify command), and any context it needs.
2. Pick the agent: `claude` or `codex` for anything that needs judgment (default: the host you're in), or `local` for a purely mechanical change.
3. Run `bosun spin --agent <claude|codex|local> -f - <<'SPEC'`, then the spec, then `SPEC`. Add `--stacked` only if the work must build on the current branch.
4. Tell the user the worktree id and terminal handle in one line, then carry on with the current task. Don't wait for it.

This needs Orca. Outside Orca, tell the user and offer to do it in this session instead.
