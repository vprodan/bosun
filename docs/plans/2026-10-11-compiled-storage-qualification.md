# Review proposal: corrected compiled storage candidate

**One approved run completed; partial result, not qualified.** This replaces the held [earlier proposal](2026-10-11-compiled-runtime-qualification.md). An answer approving that earlier exact binary does not authorize this candidate. RESUME.md says “Never run the tests under Bun”; the older five-entry exception is already fulfilled. Ordinary application tests remain guarded Node only.

Candidate: dist/bosun-0.2.0-darwin-arm64-storage/bosun, **74,379,762 bytes**.

- BinarySHA256:39fa79df688a7d3f52bf26213745d24d76f3d41382ec0a3a9f6bc032ea6f7f19.
- SourceDigest:d62e28cdb141adcbaa19c11ad4ddd6165cad7f313bc15e1fc1041b41650ab725.
- ArchiveSHA256:d6acaa6db76f84ba0c783298e89890a61740f938ed2d132fbacfc90e7124fdfc.
- Review driverSHA256:76820c71d9462ac8865b351a23f555e0688bbca74689a90de3b373594eec3c6f.

Source prerequisites now admit only Bun1.4.2/macOS arm64 as a candidate while preserving actual loaded SQLite patched-WAL versions and native backup/UDF/authorizer requirements. Compiler drift is rejected before compilation. The last full guarded Node baseline passed1,083/1,083 +19 before this small source change; affected storage/owner/writer/upgrade/runtime/distribution checks259/259 +19 and compiler-drift/build/boundary/lint88/88 +19 pass. Typecheck and unused-import lint pass; boundaries230 production files/1,235 edges/zero. Compilation and independent static --source verification pass7,278 inputs. These checks are preparation, not compiled SQLite qualification. No physical library is selected or installed.

Review [scripts/check-compiled-runtime.mjs](../../scripts/check-compiled-runtime.mjs). It has been syntax checked without execution. Exact proposed **one-run** invocation:

```sh
node scripts/check-compiled-runtime.mjs --approved-local-runtime-only dist/bosun-0.2.0-darwin-arm64-storage
```

The Node driver verifies both exact candidate hashes, copies/rechecks the executable into a canonical private temporary /tmp tree and supplies an explicit literal environment. Its HOME/BOSUN_HOME/cwd/XDG/cache/temp and short UDS path all belong to that disposable tree. Native PATH is empty, no credentials/options are inherited and the repository contains only an invented .git/config identity. It runs compiled setup, disables all native hosts/handoff/enrichment scheduling/notifications/remote in only that temporary config, and starts one temporary foreground daemon. It never installs or registers a service. Trusted-application isolation is not an OS sandbox.

Seven bounded actual local RPC requests:

1. Owner public memory.store with invented ASCII text.
2. Owner private memory.store with a distinct invented marker.
3. Owner memory.get must retrieve that private note.
4. A model memory.search override includePrivate:true must be rejected as invalid.
5. Ordinary model memory.search must include the public marker and exclude the private marker.
6. Model lexical context.retrieve must include the public marker and exclude the private marker.
7. Owner daemon.status returns metadata.

Then send SIGTERM to the original temporary process group and await its actual close, requiring exit0/no signal. Readiness/setup/output have15-second/1-MiB bounds, RPC5-second/1-MiB bounds, shutdown10 seconds before SIGKILL. Always join the original daemon before removing its temporary tree; a forced kill/failing receipt is unqualified. Log finite stages/assertions/counts/hashes and terminal/cleanup facts, never raw private fixture content. Run no mutation retries; a failed check needs source/evidence review, not automatic rerun.

Excludes native OpenCode/Codex/Claude/ACP, models/Ollama, physical extensions, personal config/auth/databases, installed services/LaunchAgents, install/upgrade/undo, Orca/UI/TTY, external network, Git mutations, publishing and deployment. The current compiled public hook/public reader remain held: this proposal must report that gap and does not qualify delivery fencing or hook performance. Compiler reproducibility, native automatic controls/retention/tool/UI behavior, real corpus quality, physical vector/Clef budgets and final ship gates remain open.


## Approved-run outcome

The owner explicitly approved this exact replacement candidate. Its driver hash76820c71d9462ac8865b351a23f555e0688bbca74689a90de3b373594eec3c6f ran once. Compiled setup exited0, no signal/stderr. The Node driver then attempted to render an invalid all-hosts-disabled configuration: the schema requires an enabled primary host. It stopped before starting the daemon or sending any RPC. The temporary tree was removed and the original setup process joined. Overall driver exit1; no retry, host/model/service/install/personal-state effect. Evidence: docs/research/checkpoints/2026-10-11-compiled-storage-runtime.log.

The shared driver has since been corrected and Node-preflighted; it no longer has this approved historical driver hash. A follow-up invocation requires a separate exact one-run review/approval. The application schema was preserved.
