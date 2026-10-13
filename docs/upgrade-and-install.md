# Upgrade, installation and onboarding

Local bosun1.0.0 is available at `dist/bosun-1.0.0-darwin-arm64/`. The owner approved shipping a local artifact after compiled minimum safety checks, deferring tuning/real-quality and broader live qualification. Actual compiled startup/MCP, storage/privacy, shutdown/reacquisition and10000-note public-view hook delivery pass in disposable contained roots. OMP is primary; OpenCode2/Codex/Claude and explicit selections remain. Unverified native automatic controls remain held. No personal installation/service activation, live-model call, publication or Git change follows from this artifact or these examples.

Final source evidence:1179/1179 tests across91 files +35/35 containment, typecheck0, extended native close/backup/UDF/authorizer probes, portable preparation, identical local native builds and actual retained hook/10k source/capture smokes. Prepare the source/native dependency using the reviewed maintainer recipe. See [the latest checkpoint](../HANDOFF.md#native-sqlite-library-admission-2026-10-13). Explicit checks remain trusted owner commands; Bun startup flags are selected literally, not silently rewritten.

The standalone release executable is
`/Users/edge/Developer/bosun/dist/bosun-1.0.0-darwin-arm64/bosun` on this checkout;
use the actual absolute path after moving it. It needs no external Node runtime
or source dependencies. Archive SHA256:
`40aa844643f03fae467494dfc0583031981d866c97b50e6388eff31e58d6df0c`.
To install later, select that executable in the reviewed `install plan` flow
below; review the returned hash before apply. Existing homes use upgrade first.
This local-release continuation deliberately performs neither operation.

Examples use `bun bin/bosun` from the checkout with existing project dependencies; there is no Node fallback. Execute storage/install flows only after the Bun runtime is qualified. The intended compiled spelling is `bosun …`, or the absolute selected executable path. Replace uppercase placeholders with exact returned plan/receipt fields. Choose a qualified release executable before installing; the source script depends on its checkout and is not the standalone release asset.

Keep the same `BOSUN_HOME` for every step. It defaults to `~/.bosun`; an override such as `export BOSUN_HOME="/absolute/path/to/.bosun"` must be absolute and normalized. `HOME` identifies the user whose binary directory and LaunchAgents are selected. The owned service flow is macOS launchd.

`bun bin/bosun onboard --host omp` reads saved configuration/receipts and prints the next action; `--json` gives JSON, and `--host opencode`, `--host codex` or `--host claude` selects a retained host. It installs and launches nothing. `bun bin/bosun doctor` inspects filesystem metadata without opening databases, probing services or repairing files; an unprepared home can return a hold.

## Upgrade the supported v0.2 home

The supported source is one owner-controlled, canonical home containing `config.env`, optionally the original schema1 `memory.db`, and only these existing entries:

| Kind | Allowed entries |
| --- | --- |
| Files | `config.env`, `memory.db`, `memory.db-wal`, `memory.db-shm`, `state.json`, `metrics.jsonl`, `log.jsonl`, `bosun.log`, `route-log.jsonl`, `route-labels.jsonl`, `llm-usage.jsonl` |
| Directories | `runs`, `cache`, `logs`, `claude-local`, `specs`, `kev` |

The home/directories must have mode `0700` or `0755`, files `0600` or `0644`, with no linked/rebound source entries. Legacy `runs` filenames use `NUMBER-HEX6.json|pid|log|rc`; each run needs a settled `.rc` exit code. Unsettled runs are held and never replayed by upgrade. The importer accepts local Ollama or OpenAI-compatible selection with `LLM_REMOTE=off`, documented local/memory/context settings and Codex/Claude role bindings. Exact local, fallback, summary, role and direct-executor model/effort strings are retained. Credentials and retired fields remain in the original file. Unknown keys, remote memory, custom Kev models and existing memory-view/source/backup bindings require manual review.

1. Stop and settle all legacy writers, MCP clients, hooks, native clients and executors. Close their SQLite handles before making the final plan. Apply requires a valid closed schema1 database with no `memory.db-wal`, `memory.db-shm` or journal file; do not delete sidecars to bypass this check. Keep clients stopped through cutover and installation/profile changes.
2. Create the private plan outside `BOSUN_HOME`, in an existing canonical directory. The output file must not already exist.

```sh
bun bin/bosun upgrade plan --request-id upgrade-1 --output /absolute/review/upgrade-plan.json
```

Planning fingerprints the source and renders the proposed TOML without opening SQLite. `memory: "schema-unverified"` means database validation is deferred to apply. The CLI writes a `0600` file containing `{ "plan": …, "hash": … }`; review `plan.source`, `plan.config`, `plan.retainedConfigKeys`, `plan.home`, `plan.socket` and `plan.legacyRouter`. Do not edit the plan to force a hold through.

If an explicit legacy Kev endpoint or `~/Library/LaunchAgents/com.bosun.router.plist` exists, select the intended Ollama endpoint with `--router-url`. Bosun does not translate a Kev URL into an Ollama URL. For example, only if this is the selected endpoint:

```sh
bun bin/bosun upgrade plan --request-id upgrade-router-1 --router-url http://127.0.0.1:11434 --output /absolute/review/router-review.json
```

The plan inspects the plist without calling launchd. The supported definition is the old `com.bosun.router` template invoking `uv run --extra serve python -m kev.serve --run jaredpalmer/kev-0.8b --port <legacy-port>`, with its Kev working directory and matching log paths. A matching name is not proof of ownership: `service_unowned` remains held until the owner reviews the file, arguments and its exact `plan.legacyRouter.hash`, then creates a new plan:

```sh
bun bin/bosun upgrade plan --request-id upgrade-router-2 --router-url http://127.0.0.1:11434 --adopt-router-hash PLIST_SHA256 --output /absolute/review/upgrade-plan.json
```

`PLIST_SHA256` is the plist content hash, not the upgrade plan hash. Require `plan.legacyRouter.reason: "ready"` before applying. Unsupported templates, drift, links or another user's definition remain held. Apply privately backs up the plist, observes/stops only that router, confirms absence and archives its definition. Already stopped/absent services are not stopped. The Kev repository and original config remain. Ollama `clef-flash:9b` replaces Kev with the new default confidence threshold. This pulls no model and installs/starts no Clef/Ollama service; physical model/template checks and calibration still gate automatic routing.

Use the top-level `hash` from the saved upgrade file:

```sh
bun bin/bosun upgrade apply /absolute/review/upgrade-plan.json --hash UPGRADE_HASH --clients-stopped
bun bin/bosun upgrade status
bun bin/bosun config show
bun bin/bosun roles --json
```

`--clients-stopped` is the owner's attestation, not a verified drain. A changed source requires a fresh plan and review before an attempt begins. Apply uses a SQLite-aware backup before adding schema2 and the writer/privacy protections. It preserves memory IDs, versions, scope/private flags, source references and audit rows; it keeps the original `config.env` and historical telemetry bytes. The ready receipt in `upgrade.json` records `backup`, `sourceId`, `installationId` and the original plan hash. Keep the database backup and any `legacyRouter.backup` private. Ordinary file copying of an open SQLite database is not this backup procedure.

Continue only when receipt and manifest are `ready`. Completed duplicate apply returns its original receipt. An `applying`/`unknown` attempt, lost stop/archive receipt or failed status requires inspection with clients stopped; never overwrite or replay it. There is no `upgrade reconcile` or automatic upgrade undo. Retain the home, config, receipts and backups for manual recovery; `install undo` does not revert data cutover. Unsupported/damaged layouts require resolving the specific diagnostic manually with original files retained. Do not run `setup` over them, erase receipts or add an intermediate runtime to bypass a hold.

## Prepare a new home and choose settings

For a new home after runtime qualification, run `bun bin/bosun setup`, then inspect `bun bin/bosun config show` and `bun bin/bosun roles --json`. Setup accepts an absent home with an existing canonical parent or an empty private home. It creates private runtime directories, `config.toml`, schema2 memory, a permitted hook view and a ready manifest. It installs no binary, host, model or service. Existing data/partial setup requires inspection.

Review `config.toml` before planning installation or profiles: `[hosts]` selects the primary host; each host has enabled/command settings; `[roles.<role>.<host>]` holds exact native model/effort choices. New configuration selects OMP, but no OMP/OpenCode model is invented or copied from another host; supply an exact native binding. Existing explicit primary/model choices survive. `[router]` selects Clef, while `[providers.default]` selects the separate summaries/extraction provider, `[local]` the direct local model, and `[graph.embedding]` embeddings. These selections download no models and move no native credentials. Environment overrides affect resolved settings; an enabled daemon uses its declared service environment, so save persistent choices in TOML.

After an owner edit, with daemon/clients stopped, run `bun bin/bosun config validate`, then `bun bin/bosun config show`. Validation republishes the hook configuration and writes that runtime file. Graphify/CodeGraph are optional user-installed sources, disabled when absent/unqualified; they are not installation prerequisites.

## Install an owned executable

Start from a ready setup/upgrade and settled clients, with the daemon stopped. Select the exact standalone executable:

```sh
bun bin/bosun install plan --binary /absolute/release/bosun --request-id install-1 --output /absolute/review/install-plan.json
bun bin/bosun install apply /absolute/review/install-plan.json --hash INSTALL_PLAN_HASH --clients-stopped
bun bin/bosun install status
```

Review the generated file before apply: `binary.path`/`binary.hash`, `targetBinary`, user/runtime roots, `previous`, and the daemon definition/destinations. `INSTALL_PLAN_HASH` is its `planHash`, not `binary.hash`. Planning writes only the exclusive private output file and starts no process or service. Apply requires a plan no more than five minutes old with unchanged roots, config, manifest and binary, and executes the selected binary's `--version` probe before installation effects.

The default destination is `~/.local/bin/bosun`. An existing user-owned executable/link holds planning until a new plan includes `--replace-existing`; review `previous`. Apply retains it under `BOSUN_HOME/installation/<id>/previous-binary` and prepares a dormant daemon definition without publishing/starting it. Data, native homes, shell configuration and global Ollama settings remain retained. For an already installed Homebrew binary, add `--homebrew` and select `/opt/homebrew/opt/bosun/bin/bosun` or `/usr/local/opt/bosun/bin/bosun`; Bosun references that stable opt path and leaves binary ownership with Homebrew. It installs no Homebrew package and publishes no formula.

Status returns `record.id`, the current numeric `record.version`, the original `record.planHash`, file-match status and `record.service.state`. It does not probe live service readiness. An unknown install/undo outcome or file drift stays held; status is for inspection, not replay.

## Select an optional native profile

Use your existing native host installation. Source profile templates select these exact versions; installed compatibility, native trust/tool controls and automatic handoff remain separately unqualified:

| Host | `--native-version` |
| --- | --- |
| OMP (primary) | `18.10.3` |
| OpenCode 2 (`opencode2`) | `2.0.27` |
| Codex | `0.161.0` |
| Claude | `2.1.292` |

With clients and daemon stopped, bind the profile's MCP/hook commands to the installed `record.targetBinary` (the absolute executable path):

```sh
bun bin/bosun host plan omp --native-version 18.10.3 --request-id profile-1 --binary /absolute/path/to/installed/bosun --output /absolute/review/host-plan.json
bun bin/bosun host apply /absolute/review/host-plan.json --hash HOST_PLAN_HASH
bun bin/bosun host status
```

Review `planHash`, file changes, launch arguments/environment and exact role bindings. Planning starts no native host and trusts no hook/plugin. Apply creates an owned isolated profile under `BOSUN_HOME/host-profiles`; it does not authenticate or alter native account ownership. For Codex, also select `--workspace /absolute/repository`: review the planned `.agents/skills/bosun-*` links, which apply may create in that repository. Changed configuration, manifest, profile files or skill links hold later actions.

After the qualified daemon is running, inspect `bun bin/bosun onboard --host omp` and preview the manual native launch using the host receipt's own ID/version/hash:

```sh
bun bin/bosun host launch HOST_PROFILE_ID --version HOST_RECEIPT_VERSION --hash HOST_PLAN_HASH --preview
bun bin/bosun host launch HOST_PROFILE_ID --version HOST_RECEIPT_VERSION --hash HOST_PLAN_HASH
```

The preview performs no native call. Actual launch checks the selected native version and opens its UI; it does not establish managed-session or automatic-handoff readiness. Keep existing old client processes closed until the ready authority and reviewed profile are selected.

OMP ordinary input hooks and OpenCode2's Promise plugin require a leading per-input `#public` marker; private/unmarked/attachment inputs omit context. OMP binds native `provider/model-id` and thinking levels, and uses existing native account configuration. OpenCode2 profiles use the V2 schema and `--standalone` with a reviewed owned overlay, not an already running service or V1 compatibility config. These paths have guarded synthetic source evidence only; they do not qualify read-only tools, active-total occupancy, live MCP/hook delivery or automatic ownership transfer.


## Enable, stop, reconcile and undo

For every new installation service/undo action, read `install status` and use its current `record.id`, `record.version` and original `record.planHash`. Receipt versions advance during effects; do not reuse an earlier version. Use a distinct stable `--request-id` for each intended enable/disable operation. It identifies the operation, not its receipt ID or any hash.

```sh
bun bin/bosun install enable INSTALL_ID --version CURRENT_VERSION --hash INSTALL_PLAN_HASH --request-id enable-1 --clients-stopped
bun bin/bosun install status
```

Enable publishes the owned daemon plist and starts it through launchd. `enabled` requires the selected binary, authority identity, socket and actual PID to agree. Foreign destinations, unsafe directories, stale receipts and unconfirmed readiness hold. Alternatively, qualified source-only foreground use is `bun bin/bosun daemon run`; settle that process before choosing the owned service. Reopen clients after the runtime and selected installation/profile receipts are ready and the chosen authority is running. CLI/MCP clients never start a daemon automatically.

Stop clients and settle their effects before disabling:

```sh
bun bin/bosun install disable INSTALL_ID --version CURRENT_VERSION --hash INSTALL_PLAN_HASH --request-id disable-1 --clients-stopped
```

Disable verifies the original service, waits for absence and authority closure, and archives only the matching owned plist. A lost effect receipt retains `unknown` rather than repeating bootstrap/bootout. Inspect the current receipt and reconcile the original service operation:

```sh
bun bin/bosun install reconcile INSTALL_ID --version CURRENT_VERSION --hash INSTALL_PLAN_HASH
```

Reconcile has no `--request-id` or `--clients-stopped` option. It observes readiness or absence/closure and updates the original operation without replay; it may archive a confirmed owned definition after absence. Unconfirmed ownership/observation stays held. A completed repeated request returns its original operation; an uncertain one stays held. Read `install status` after each action. History is finite (64 service operations per receipt; 64 retained installation bundles); capacity holds require owner inspection, not evidence deletion.

To undo, first disable the daemon, stop clients and undo every profile that uses the installed executable. Host undo uses the host receipt version and has no hash or stopped-client flag:

```sh
bun bin/bosun host undo HOST_PROFILE_ID --version HOST_RECEIPT_VERSION
bun bin/bosun install status
bun bin/bosun install undo INSTALL_ID --version CURRENT_VERSION --hash INSTALL_PLAN_HASH --clients-stopped
```

Undo requires a `ready` installation with service `prepared` or `disabled`, no published service, and matching owned files/backups. It archives the managed executable, restores an explicitly retained previous binary/link, and removes only matching empty directories it created. It retains runtime data and receipts; Homebrew keeps its binary. Drift or an uncertain removal remains held.

Migration spellings `start <id>`/`stop <id>` take the same flags as `install enable`/`disable`; `uninstall <id>` takes the same flags as `install undo`. `restart <id> --version CURRENT_VERSION --hash INSTALL_PLAN_HASH --request-id restart-1 --clients-stopped` composes two durable original disable/enable operations and holds if the stop is uncertain. None of these commands adopts ownership from legacy `state.json` or manages arbitrary Kev/Ollama services.
