# Proposed compiled entry checks

Approved by the owner and executed once on 2026-10-11: **5/5 checks passed**, driver exit0. [Execution evidence](../research/checkpoints/2026-10-11-compiled-entry.log). The proposal below records the exact approved scope. The saved instruction in [RESUME.md](../../RESUME.md) says **“Never run the tests under Bun.”** The compiled executable contains Bun, so executing these checks requires an explicit exception. The ordinary application suite remains guarded Node only.

Candidate: `dist/bosun-0.2.0-darwin-arm64/bosun`, SHA256 `5a8600206ee8527c1410f833af612d2ce5afc510fd1f7ddf92ea7089f6cfe202`. The coordinator independently verified its checksums, archive, Mach-O structure and 7,271 current source/dependency inputs. This is a development candidate, with no runtime qualification or release claim.

The [Node driver](../../scripts/check-compiled-entry.mjs) verified the artifact again, copied the exact hash-pinned binary into a fresh private temporary directory, and ran only these entry checks. This candidate is bound to the distribution checkpoint above; subsequent ACP or host edits will require their own final build qualification.

| Arguments | Input | Expected behavior |
|---|---|---|
| `--version` | Empty | Exit 0 and report `0.2.0` |
| `--help` | Empty | Exit 0 and describe the current commands |
| `hook --private` | Malformed invented input | Exit 0 with no output or runtime initialization |
| `route --hook --private` | Malformed invented input | The same early private-input rejection |
| `mcp` | Invented initialization, then stdin EOF | Answer initialization and terminate after EOF |

Each subprocess gets a fresh temporary HOME/BOSUN_HOME/cwd, empty native-tool PATH, explicit temporary XDG/cache paths, no inherited credentials, and no `BUN_OPTIONS`, `BUN_BE_BUN` or `NODE_OPTIONS`. Each has a five-second deadline and one-MiB output limit. The driver waits for termination and removes only its own temporary tree. It records exit/output assertions and failed checks without retrying them.

The proposed scope excludes setup, migrations, daemon startup, SQLite writes, installation, services, native hosts, models, network requests, Orca and GUI/TTY actions. Temporary-home and environment isolation are trusted-application precautions, not an OS sandbox. These entry checks cannot establish database, hook-delivery, TTY, performance, native-host or full-release qualification. Those retain their existing holds.

No dependencies or tools are installed, no personal configuration/authentication/data is touched, and no Git or publishing action is included. Approval would cover only these specified compiled entry checks; it would not authorize the Bun application test suite or broader live qualification.

Exact proposed invocation (only after explicit approval):

```sh
node scripts/check-compiled-entry.mjs --approved-entry-only dist/bosun-0.2.0-darwin-arm64
```

The MCP check uses supported protocol `2025-11-25`, sends one invented `initialize` request, checks the exact bosun/version receipt, then closes stdin. It makes no tool calls. Logs contain assertion outcomes, byte counts and hashes rather than raw process output.
