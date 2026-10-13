# Review proposal: disposable Claude bootstrap protocol

Executed once under the explicit owner approval; failed before package download/native Claude. The earlier disposable version/help exception is fulfilled and is not reused. Claude is still not installed. [RESUME.md](../../RESUME.md) says “No installs without an explicit ask” and prohibits unapproved live native calls. This proposal requests one new disposable native protocol check, with model traffic blocked, so that the managed driver can use actual retention/settings shapes rather than guessed acknowledgements.

Exact driver: [scripts/check-claude-bootstrap.mjs](../../scripts/check-claude-bootstrap.mjs), SHA256 `a563bf51ffb2ab98b72989f47bac5f9e2548e48f586bf71926857961f323e39b`.

Exact selected-source dependency digest: `1a90d3dbcbd4d4e8e3d02f02afb175e019063c0e0dbf6e9e78d805d2ff4be946`. The driver pins the Claude client/runner/private-file/process/core dependency closure and the prior verified archive parser; unrelated source changes do not broaden its scope. Parser script SHA256 remains `2a36c41932db73c7b396b21f188f3288bab50d1d2b01df3358ae104d6453e059`.

Proposed one-run invocation:

```sh
node scripts/check-claude-bootstrap.mjs --approved-claude-bootstrap-only
```

The package is the same verified publisher2.1.292 darwin-arm64 artifact from the [fulfilled metadata proposal](2026-10-11-claude-native-metadata.md): executable235,017,328 bytes, SHA256 `97a01e5bc74a199e67189435d0331ea3a24eac2e07db4b76d9148c5b0386138f`; registry archiveSHA512 and four-member parser remain exact. The previous temporary executable was removed. A new download is necessary and is not authorized by the earlier one-run permission. Registry redirects refused,120-second/250 MB compressed download bound; no SDK/npm/install script/package manager or permanent installation.

One fresh canonical private `/tmp/bosun-claude-bootstrap-*` tree contains the executable, literal temporary HOME/Claude/XDG/cache/data/state/workspace/temp directories, empty PATH, wrapper and temporary macOS sandbox profile. The profile denies operations by default, permits system/runtime reads and this exact owned tree, limits native writes to that tree, and permits outbound network only to one assigned localhost TCP port. Personal homes/keychains and external network are outside its allowlist. First validate the profile with `/usr/bin/sandbox-exec ... /usr/bin/true`; failure ends the check before download, without adaptation or retry. No persistent security policy/TCC/LaunchAgent/service is changed.

A Node HTTP fixture on that port rejects every request with403 and records only a request count. Native settings select that fixture using an explicitly synthetic key; no real credentials, login, keychain, environment copy, account inspection request or paid provider is selected. Assert zero provider requests; an attempted request is a failed qualification, not a successful model call. The wrapper launches the pinned native executable through sandbox-exec; process groups remain owned by the existing original-process lifecycle.

Native invocations and frames, exactly once:

1. One `--version` detection through the wrapper.
2. One tools-disabled, restricted, safe-mode stream-json root with a generated session UUID and explicit fixture selector `sonnet`/effort `high`. This selects no production model/default and submits no work turn.
3. Initialize with empty hooks/MCP/agents/skills/plugins and a fixed title; read `get_settings`, `get_hooks_listing`, `get_status`.
4. Append one invented public constraint marker with assigned UUID, `shouldQuery:false` and literal-input mode; correlate the native replay receipt.
5. Read `get_status`, `export_conversation`, and summary-only `get_context_usage`. No full token-count, model/permission mutation, reinitialize, resume/fork, interrupt, background_tasks, tools or task dispatch.
6. Independently read only the assigned private fixture JSONL file in the explicitly selected native project namespace. Require one exact public user seed, source UUID/session/cwd/version/root-parent/non-sidechain metadata, unchanged inode and no assistant/progress/attachment records. Other native metadata types are reported for review, never turned into a FreshReadiness receipt.
7. Join the original owned stream and all ordinary group producers before closing the fixture/cleanup. Record bounded response shapes with strings hashed and no raw account/config/tool/stderr contents. If joining is uncertain, retain the private tree and report its held path. Otherwise remove it.

Per control request5 seconds, stream lifecycle45 seconds, native process output4 MiB/line256 KiB, transcript1 MiB/128 rows/256 KiB line and128 notifications. The shared process lifecycle has a500 ms kill backstop and original/group join requirement. No retry or automatic permission repair.

The exact exported probe and retained-file reader passed mandatory guarded Node preflight with a synthetic native stream, all8 checks, independent retained seed, wrong-root-parent rejection and original process join. Evidence: docs/research/checkpoints/2026-10-11-claude-bootstrap-driver-preflight-final-node.log. No native Claude, sandbox, package download, model or external endpoint was used in that preflight. The first fixture printed escaped newline text and correctly failed version detection before protocol; corrected fixture used actual newline bytes without product/parser weakening. Node syntax/source pin/whitespace pass. Full application source remains at the preceding1,106/1,106 +19 green checkpoint.

This is a narrow native bootstrap protocol qualification, not the complete managed driver, effective active-context semantics, global prompt fence, work-tool/background quiescence, UI selection, real model/retention quality or automatic handoff qualification. Capability flags remain unverified. Corrected compiled-storage and public corpus review approvals remain separate and pending. No ordinary application test moves to Bun; no personal state, other installed host, model, installation/upgrade, publishing or Git mutation is included.

Owner explicitly approved “Allow this one bootstrap check” on2026-10-11. Exact driver/parser/source pins rechecked immediately before the one-run invocation. No broader native/model/install or repeated-check permission is inferred. Execution result follows after original joins.


Execution2026-10-11: terminal exit1 at sandbox-syntax. The owned sandbox-exec /usr/bin/true process terminated SIGABRT with0stdout/0stderr; original group joined. ProviderRequests0; private temporary tree removed. No publisher download or native Claude version/protocol began. Evidence [bootstrap log](../research/checkpoints/2026-10-11-claude-bootstrap-native.log), SHA256 c625eb90d47d9b37063b136f8c108bfe7d2c2be1e58c5cdb0f95264039161f9f. Cause unresolved. This exact one-run exception is fulfilled; no retries, adapted profile or native qualification are authorized/inferred.

The consumed exact driver is now preserved unchanged in docs/research/checkpoints/2026-10-11-claude-bootstrap-original-driver.txt. Current scripts/check-claude-bootstrap.mjs contains only the separately proposed root-traversal correction and a new execution flag; it must not run under this old approval. See [the unexecuted follow-up proposal](2026-10-11-claude-bootstrap-follow-up.md).
