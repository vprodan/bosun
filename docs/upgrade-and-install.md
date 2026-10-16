# Upgrade, installation and onboarding

## Guided installation

Use **v1.1.0 or later** for the complete guided install/reinstall/update/uninstall
flow. Earlier guided installers support fewer steps; download the new ZIP once
rather than expecting an old executable to expose new commands.

Download `bosun-1.1.0-darwin-arm64.zip` from
[GitHub Releases](https://github.com/vprodan/bosun/releases), verify its
`SHA256SUMS`, and open the extracted folder containing `bosun` in Terminal.
The bundled runtime needs no separate Bun, Node, npm, `gh` or `jq`. This remains
an unnotarized terminal application, not a GUI installer. The narrow
[Gatekeeper guidance below](#1-unzip-and-open-the-extracted-folder-in-terminal)
applies; installation cannot bypass macOS security policy.

Run one command in an interactive terminal:

```sh
shasum -a 256 -c SHA256SUMS && ./bosun --version && ./bosun install
```

Keep your intended `BOSUN_HOME` consistent across terminals (default `~/.bosun`).
The installer first inspects paths and retained receipts without initializing
existing data. Expect these explicit choices:

1. **Inspect paths and permissions.** An absent home is safe to prepare. An
   empty, canonical directory owned by you can be restricted to0700 after a
   separate approval. Nonempty loose-permission, symlink, legacy and incomplete
   homes hold; the installer never resets them.
2. **Prepare local data?** Offered only for a new or empty private home.
   Existing ready configuration and exact host/model/effort selections remain
   unchanged; OMP is the default only for new homes.
3. **Reinstall an existing owned installation?** The selected new binary is
   checked before removing the old one. The original installed executable
   validates and retires its own version-bound receipt, including across
   releases. A separately approved stop affects only the receipt-owned service.
   Close native clients and separately launched foreground/nohup daemons first.
4. **Review and install.** Source, destination, previous-binary backup and data
   home are shown before approval. Replacing an unmanaged executable needs
   another approval. Plans, versions and hashes are handled internally.
5. **Start the background service?** Optional, default **No**. Otherwise the
   executable is installed but no background process is started.
6. **Set up optional Ollama/router tools?** Optional, default **No**; declining
   makes no executable-version or endpoint requests. If approved, inspection
   uses metadata only. Missing Ollama installation, app launch and exact model
   pull are three separately approved effects. See [optional tools](#optional-ollama-and-router-model).

Cancelling a step never approves the next effect. Already approved preparation
or installation can remain. Unknown native operations, changed executable
identities and receipt drift hold without resetting or replaying them. Inspect
the original `install status` and recovery instructions; never delete receipts,
SQLite sidecars or uncertain tool intents to bypass a hold.

Version1.0.5 fixed generated LaunchAgent arguments to `daemon run`;1.1.0 can
retire a ready old receipt using its original executable automatically. An
older unknown service operation must still be explicitly reconciled using its
original executable before reinstall. Hash-bound old plists are never edited.

Reinstall retires the old owned installation before the final new-install
approval. If you cancel after retirement, the old executable stays removed (or
its reviewed previous executable is restored); memory/settings remain. You can
run the downloaded new binary's installer again to finish from that known state.

Router admission accepts stable Ollama **0.35.x and0.40.x**, including0.40.4.
Other minor families and suffix builds remain unverified. Tool/model presence
does not qualify SystemOne decision capability, selected-child/model digests,
runner requirements, loaded residency, live model quality or automatic dispatch.

Use the absolute executable path printed on completion. For the default layout,
if background start was declined, leave this running in the first terminal:

```sh
"$HOME/.local/bin/bosun" daemon run
```

In a second terminal, with the same home selection:

```sh
"$HOME/.local/bin/bosun" memory add --category project --title "First note" --body "Bosun is installed and running."
"$HOME/.local/bin/bosun" memory search installed
```

These are local lexical-memory operations, not model calls. Use a non-sensitive
example note and inspect `memory add --help` before storing private information.
For this shell session only, optionally run
`export PATH="$HOME/.local/bin:$PATH"`. Bosun does not edit shell startup files.
After memory works, `bosun onboard --host omp` describes optional reviewed host
setup; authentication and explicit provider/model selection remain yours.

Source-checkout users must select a qualified absolute release executable:
`bun bin/bosun install --binary /absolute/release/bosun`. There is no `--yes`
bypass; noninteractive callers should use the secondary
[advanced plan/apply interface](#install-an-owned-executable).

## Reinstall, update and uninstall

These commands require1.1.0 or later and an interactive owner terminal:

```sh
bosun install
bosun update
bosun uninstall
```

`bosun install` offers reinstall from the currently selected release. Approving
it retains exact configuration, memory and all original recovery evidence. If
you decline reinstall on a matching current installation, you can still review
its optional background start and tool steps.

`bosun update` finds the latest stable macOS arm64 GitHub release and asks before
downloading. It pins the release/tag/commit and asset identities, verifies GitHub
SHA256 digests, both checksum inventories, bounded archive contents, executable
identity and compiled safety/source/license bonds, then opens that release's
installer in the same terminal. It never downgrades or executes unverified bytes.
Downloads remain in private runtime artifacts for inspection.
If this executable is already current (or newer), only release metadata is
checked: no download approval, archive transfer or reinstall is performed.

The repository is private: automatic updates use your **existing** authenticated
GitHub CLI when available. Bosun does not install `gh`, read or print tokens, or
change authentication. Without authorized access, download the new ZIP through
GitHub and run its `./bosun install`; no separate runtime is needed.

`bosun uninstall` reviews the current receipt and separately asks before stopping
its owned background service. It removes only owned installation files, retaining
memory, configuration, receipts, backups, native host settings, Ollama and models.
A reviewed previous executable is restored, not deleted. Active reviewed host
profiles may need their own reviewed undo before the binary can be removed.
Foreground/nohup daemons must be stopped by their owner; Bosun never kills a
guessed PID. This command does not purge user data.

## Optional Ollama and router model

The installer can use an existing Ollama CLI/app without replacing it. If
missing, it offers existing Homebrew's canonical `ollama-app` cask in your user
Applications folder without privileged links. It does **not** install Homebrew.
Without Homebrew, it downloads the official HTTPS DMG, mounts it read-only,
requires codesign/Gatekeeper verification, and copies into an absent owned app
destination. No sudo, shell-piped installer or trust bypass is used.

Launching the inspected app is a separate approval. A custom local port/protocol
must already be configured correctly; Bosun does not rewrite Ollama bindings.
For a remote router endpoint, local installation/start/pull is skipped—perform
those steps on that machine with its owner's approval.

An acknowledged app-launch command is recorded separately from server readiness.
If first-run setup takes longer, finish it in Ollama and rerun the guided tool
step; the app is not silently relaunched. A missing native acknowledgement, in
contrast, leaves its original intent unknown and blocks later tool mutations.
Failed native image/copy/detach stages are retained for review, never force-
detached or recursively removed beneath an unconfirmed producer.

The model prompt names the **exact configured model**, `clef-flash:9b` only when
that is your selection. Pulls may be many gigabytes. Existing models are not
re-pulled, configurations are not changed, and no inference is submitted.
An unconfirmed tool effect remains durably unknown and blocks later tool
mutations, even when desired state becomes visible. Retain its artifacts and
inspect the original outcome; reinstall is not permission to replay it.

After setup, run `bosun router status`. A `held` or unknown loaded state still
requires the reported compatibility/capability/residency condition to be
resolved; successful download is not readiness or quality qualification.


## Current v1.0.1 manual fallback

The following numbered procedure remains available for the older v1.0.1
binary and for users deliberately choosing explicit plan/apply. It is not the
guided v1.0.3 quickstart.

This guide is for the **macOS Apple Silicon (`arm64`)** release. You do not need a
source checkout, Bun, Node, npm, `gh` or `jq`: the executable bundles its Bun
runtime. The release is **not notarized**. Memory-only use needs no model,
provider credentials or native agent installation.

There are three separate steps: `setup` prepares your data home; `install`
places the executable in your user binary directory; `daemon run` starts the
process that serves memory requests. None installs or configures a native host
or model automatically.

### 1. Unzip and open the extracted folder in Terminal

Download `bosun-1.0.1-darwin-arm64.zip` from the project's
[GitHub release](https://github.com/vprodan/bosun/releases/tag/v1.0.1), then
double-click it in Finder. Open Terminal, type `cd` followed by a space, drag
the extracted folder from Finder into Terminal, and press Return. Choose the
folder that contains `bosun`, `build.json` and `SHA256SUMS`, not the ZIP itself.
Keep the license files with your downloaded bundle.

```sh
uname -m
shasum -a 256 -c SHA256SUMS
BOSUN="$PWD/bosun"
./bosun --version
```

`uname -m` must report `arm64` (use a native Terminal session, not Rosetta).
Every checksum entry must report `OK`; stop if any fails. The version should
report `1.0.1` for this release. Checksums detect changed bundle contents; they
do not establish that an untrusted download is safe. Use the trusted release
and its matching release metadata/checksums, not a historical local candidate.

If macOS blocks this **trusted, checksum-verified** executable because it is
unnotarized, you may remove quarantine from this one file and retry:

```sh
xattr -d com.apple.quarantine "$BOSUN"
"$BOSUN" --version
```

Do not run this recursively, use `sudo`, disable Gatekeeper, or remove
quarantine from an unverified download. If the attribute is absent or execution
still fails, inspect the actual error rather than broadening the workaround.

### 2. Inspect your data home; choose new setup or existing-home review

Keep the same `BOSUN_HOME` for every command and Terminal session. By default it
is `~/.bosun`; if you deliberately use another home, export its absolute,
normalized path in **both** terminals before continuing. `HOME` identifies the
user whose binary directory and LaunchAgents are selected.

```sh
"$BOSUN" doctor
```

Doctor inspects filesystem metadata without opening databases, probing services
or repairing files. On a new, absent home it reports `prepared: false` and exits
with status 1; that is normal before setup, not an instruction to install
another runtime.

- **New home:** only if `~/.bosun` is absent, or is an empty private directory,
  continue to step 3.
- **Existing data:** do **not** run `setup`, reset/delete the home, remove SQLite
  sidecars or erase receipts. A supported legacy home follows
  [the advanced upgrade procedure](#upgrade-the-supported-v02-home) first.
  An already prepared home needs inspection of `config show`, `install status`
  and its retained receipts rather than another setup. Stop existing clients
  and daemon before a reviewed installation/profile change.
- **Held, incomplete or unknown state:** retain the files and receipts and
  resolve the specific diagnostic before applying anything. Do not overwrite
  or replay an unknown upgrade, installation or service attempt.

The advanced commands below use installed `bosun`. Before installation, invoke
the downloaded `"$BOSUN"` in its place; do not run commands from an old binary
merely because it is already on `PATH`.

### 3. Prepare a new home and understand configuration

For the **new-home branch only**:

```sh
"$BOSUN" setup
"$BOSUN" config show
```

Setup returns a manifest with `state: "ready"` and creates private directories,
`config.toml` and the memory database in `~/.bosun`. It does not install the
binary or start the daemon, a background service, a host or a model.
`config show` displays resolved settings, including environment overrides;
it is not a host/model readiness test.

The saved TOML separates host selection and native role/model bindings from
routing, summaries/extraction, direct local models and embeddings. OMP is the
default primary host selection, not an installed or authenticated agent.
Leave optional model features unused for the memory example below. For exact
configuration fields and safe edits, see
[settings](#prepare-a-new-home-and-choose-settings).

### 4. Review and apply the executable installation

Keep daemon and clients stopped. From the extracted folder:

```sh
"$BOSUN" install plan --binary "$BOSUN" --request-id install-1 --output "$PWD/install-plan.json"
plutil -p install-plan.json
```

Read the plan before continuing: verify `binary.path` selects this downloaded
executable, `binary.hash` matches it, `targetBinary` is your
`~/.local/bin/bosun`, the user/runtime roots are yours, and `previous` and all
daemon destinations are expected. Planning writes an exclusive private file
and starts nothing. If the output file already exists, inspect it; do not
overwrite it or treat an old plan as fresh.

After review, extract **this plan's `planHash`**, not its binary checksum:

```sh
INSTALL_HASH="$(plutil -extract planHash raw -o - install-plan.json)"
"$BOSUN" install apply "$PWD/install-plan.json" --hash "$INSTALL_HASH" --clients-stopped
"$HOME/.local/bin/bosun" install status
```

Apply requires a plan less than five minutes old with unchanged inputs.
If it expires before any apply attempt, make and review a fresh plan with a
new request ID and a new output filename; do not reuse the expired hash.
`--clients-stopped` is your attestation that clients are stopped, not an
automatic drain. Status should show top-level `state: "ready"` and a prepared,
not enabled, service. Installation does not start it. Holds, replacements,
Homebrew ownership and uncertain outcomes are covered in
[advanced installation](#install-an-owned-executable).

Use the explicit installed path immediately, or add it to this shell session:

```sh
export PATH="$HOME/.local/bin:$PATH"
bosun --version
```

This `export` affects only the current Terminal session. Repeat it in each new
terminal, or deliberately add it to your shell's startup configuration
(normally `~/.zshrc` for macOS zsh). Bosun does not edit your shell files.
`BOSUN` still names the downloaded executable, not the installed one.

### 5. Start the daemon in the foreground

In the first Terminal:

```sh
"$HOME/.local/bin/bosun" daemon run
```

Wait for `bosun daemon ready` and leave that terminal open. This is the running
memory authority; CLI and MCP clients do not start it automatically. Stop it
with Control-C when finished, and let it exit before switching to a background
service.

### 6. Add and find a real note in a second Terminal

Open another Terminal with the same `BOSUN_HOME` selection. No `BOSUN` variable
or `PATH` change is needed when using the explicit installed path:

```sh
"$HOME/.local/bin/bosun" memory add --category project --title "First note" --body "Bosun is installed and running."
"$HOME/.local/bin/bosun" memory search installed
```

The add command returns the stored note, and search should return the
`First note` entry with that body. This is local lexical memory: these
commands use no model and make no native-host setup automatic. The example
note is not private, but it is not automatically shared with other projects;
do not substitute sensitive information. Use `memory add --help` and
`memory search --help` to review privacy options before storing private notes.

### 7. Choose optional next steps only after memory works

- **OMP or another native host:** use
  [optional native profiles](#select-an-optional-native-profile). Install and
  authenticate the host yourself, select an explicit native provider/model
  binding and review the profile plan. Host-major compatibility is not live
  host qualification or automatic handoff support.
- **Background operation:** stop the foreground daemon, close clients and use
  [enable/disable/reconcile/undo](#enable-stop-reconcile-and-undo), carrying the
  current receipt ID, version and original plan hash.
- **Existing legacy data:** use
  [upgrade](#upgrade-the-supported-v02-home); installation alone does not
  migrate it.

`bosun onboard --host omp` reads saved configuration/receipts and prints the
next action; `--json` gives JSON. Other selections are `--host opencode`,
`--host codex` and `--host claude`. It installs and launches nothing.
Historical local artifacts and qualification evidence belong in
[maintenance guidance](https://github.com/vprodan/bosun/blob/main/docs/maintenance.md), not in this release-user procedure.

The advanced examples use uppercase receipt/version placeholders; replace
them with the exact returned fields, not example or remembered values.

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
bosun upgrade plan --request-id upgrade-1 --output /absolute/review/upgrade-plan.json
```

Planning fingerprints the source and renders the proposed TOML without opening SQLite. `memory: "schema-unverified"` means database validation is deferred to apply. The CLI writes a `0600` file containing `{ "plan": …, "hash": … }`; review `plan.source`, `plan.config`, `plan.retainedConfigKeys`, `plan.home`, `plan.socket` and `plan.legacyRouter`. Do not edit the plan to force a hold through.

If an explicit legacy Kev endpoint or `~/Library/LaunchAgents/com.bosun.router.plist` exists, select the intended Ollama endpoint with `--router-url`. Bosun does not translate a Kev URL into an Ollama URL. For example, only if this is the selected endpoint:

```sh
bosun upgrade plan --request-id upgrade-router-1 --router-url http://127.0.0.1:11434 --output /absolute/review/router-review.json
```

The plan inspects the plist without calling launchd. The supported definition is the old `com.bosun.router` template invoking `uv run --extra serve python -m kev.serve --run jaredpalmer/kev-0.8b --port <legacy-port>`, with its Kev working directory and matching log paths. A matching name is not proof of ownership: `service_unowned` remains held until the owner reviews the file, arguments and its exact `plan.legacyRouter.hash`, then creates a new plan:

```sh
bosun upgrade plan --request-id upgrade-router-2 --router-url http://127.0.0.1:11434 --adopt-router-hash PLIST_SHA256 --output /absolute/review/upgrade-plan.json
```

`PLIST_SHA256` is the plist content hash, not the upgrade plan hash. Require `plan.legacyRouter.reason: "ready"` before applying. Unsupported templates, drift, links or another user's definition remain held. Apply privately backs up the plist, observes/stops only that router, confirms absence and archives its definition. Already stopped/absent services are not stopped. The Kev repository and original config remain. Ollama `clef-flash:9b` replaces Kev with the new default confidence threshold. This pulls no model and installs/starts no Clef/Ollama service; physical model/template checks and calibration still gate automatic routing.

Use the top-level `hash` from the saved upgrade file:

```sh
bosun upgrade apply /absolute/review/upgrade-plan.json --hash UPGRADE_HASH --clients-stopped
bosun upgrade status
bosun config show
bosun roles --json
```

`--clients-stopped` is the owner's attestation, not a verified drain. A changed source requires a fresh plan and review before an attempt begins. Apply uses a SQLite-aware backup before adding schema2 and the writer/privacy protections. It preserves memory IDs, versions, scope/private flags, source references and audit rows; it keeps the original `config.env` and historical telemetry bytes. The ready receipt in `upgrade.json` records `backup`, `sourceId`, `installationId` and the original plan hash. Keep the database backup and any `legacyRouter.backup` private. Ordinary file copying of an open SQLite database is not this backup procedure.

Continue only when receipt and manifest are `ready`. Completed duplicate apply returns its original receipt. An `applying`/`unknown` attempt, lost stop/archive receipt or failed status requires inspection with clients stopped; never overwrite or replay it. There is no `upgrade reconcile` or automatic upgrade undo. Retain the home, config, receipts and backups for manual recovery; `install undo` does not revert data cutover. Unsupported/damaged layouts require resolving the specific diagnostic manually with original files retained. Do not run `setup` over them, erase receipts or add an intermediate runtime to bypass a hold.

## Prepare a new home and choose settings

For a new home, follow step 3 above using the downloaded executable; after installation the command spellings are `bosun setup`, `bosun config show` and `bosun roles --json`. Do not repeat setup on the now-prepared home. Setup accepts an absent home with an existing canonical parent or an empty private home. It creates private runtime directories, `config.toml`, schema2 memory, a permitted hook view and a ready manifest. It installs no binary, host, model or service. Existing data/partial setup requires inspection.

Review `config.toml` before planning installation or profiles: `[hosts]` selects the primary host; each host has enabled/command settings; `[roles.<role>.<host>]` holds exact native model/effort choices. New configuration selects OMP, but no OMP/OpenCode model is invented or copied from another host; supply an exact native binding. Existing explicit primary/model choices survive. `[router]` selects Clef, while `[providers.default]` selects the separate summaries/extraction provider, `[local]` the direct local model, and `[graph.embedding]` embeddings. These selections download no models and move no native credentials. Environment overrides affect resolved settings; an enabled daemon uses its declared service environment, so save persistent choices in TOML.

After an owner edit, with daemon/clients stopped, run `bosun config validate`, then `bosun config show`. Validation republishes the hook configuration and writes that runtime file. Graphify/CodeGraph are optional user-installed sources, disabled when absent/unqualified; they are not installation prerequisites.

## Install an owned executable

Start from a ready setup/upgrade and settled clients, with the daemon stopped. In the extracted release folder, `BOSUN="$PWD/bosun"` selects the exact standalone executable:

```sh
"$BOSUN" install plan --binary "$BOSUN" --request-id install-1 --output "$PWD/install-plan.json"
plutil -p install-plan.json
```

After reviewing the plan:

```sh
INSTALL_HASH="$(plutil -extract planHash raw -o - install-plan.json)"
"$BOSUN" install apply "$PWD/install-plan.json" --hash "$INSTALL_HASH" --clients-stopped
"$HOME/.local/bin/bosun" install status
```

Review the generated file before apply: `binary.path`/`binary.hash`, `targetBinary`, user/runtime roots, `previous`, and the daemon definition/destinations. `INSTALL_HASH` is its `planHash`, not `binary.hash`. Planning writes only the exclusive private output file and starts no process or service. Apply requires a plan no more than five minutes old with unchanged roots, config, manifest and binary, and executes the selected binary's `--version` probe before installation effects. Choose a new request ID/output filename for a new plan; never overwrite an existing file or replay an unknown attempt.

The default destination is `~/.local/bin/bosun`. An existing user-owned executable/link holds planning until a new plan includes `--replace-existing`; review `previous`. Apply retains it under `BOSUN_HOME/installation/<id>/previous-binary` and prepares a dormant daemon definition without publishing/starting it. Data, native homes, shell configuration and global Ollama settings remain retained. For an already installed Homebrew binary, add `--homebrew` and select `/opt/homebrew/opt/bosun/bin/bosun` or `/usr/local/opt/bosun/bin/bosun`; Bosun references that stable opt path and leaves binary ownership with Homebrew. It installs no Homebrew package and publishes no formula.

Status returns `record.id`, the current numeric `record.version`, the original `record.planHash`, file-match status and `record.service.state`. It does not probe live service readiness. An unknown install/undo outcome or file drift stays held; status is for inspection, not replay.

## Select an optional native profile

Install and authenticate the native host separately using its own instructions.
Bosun accepts stable releases in these major families; this admission does not
qualify native trust/tool controls, live-model use or automatic handoff:

| Host | Supported major |
| --- | --- |
| OMP (primary) | `18.x` |
| OpenCode 2 (`opencode2`) | `2.x` |
| Codex | `0.x` |
| Claude | `2.x` |

Codex is pre-1.0 and minor releases can break protocols; structural validation
still fails closed. Malformed/prerelease/cross-major versions are rejected.
Run the selected native command's `--version` (for OMP, `omp --version`) and
use its **exact observed numeric version** for `--native-version`, not a patch
version copied from documentation. OMP reports `omp/X.Y.Z`; use just `X.Y.Z`.
Replace `OBSERVED_NATIVE_VERSION` below with that value. A prepared profile
remains bound to the exact reviewed version; a host update is not silently
accepted by that existing receipt.

Before planning, edit `BOSUN_HOME/config.toml` to enable/select the intended
host and supply explicit `[roles.<role>.omp]` `model`/`effort` bindings for
the roles you intend to use. OMP models use native `provider/model-id` and native
thinking levels; select values actually available in your authenticated host.
Do not copy another host's model name or expect Bosun to choose a provider,
download a model or move credentials. With clients/daemon stopped, run
`bosun config validate`, inspect `bosun config show` and `bosun roles --json`,
then review the profile's rendered bindings.

With clients and daemon stopped, bind the profile's MCP/hook commands to the installed `record.targetBinary` (the absolute executable path):

```sh
bosun host plan omp --native-version OBSERVED_NATIVE_VERSION --request-id profile-1 --binary "$HOME/.local/bin/bosun" --output "$PWD/host-plan.json"
```

Review the saved plan before applying, then use its own hash:

```sh
HOST_PLAN_HASH="$(plutil -extract planHash raw -o - host-plan.json)"
bosun host apply "$PWD/host-plan.json" --hash "$HOST_PLAN_HASH"
bosun host status
```

Review `planHash`, file changes, launch arguments/environment and exact role bindings. Planning starts no native host and trusts no hook/plugin. Apply creates an owned isolated profile under `BOSUN_HOME/host-profiles`; it does not authenticate or alter native account ownership. For Codex, also select `--workspace /absolute/repository`: review the planned `.agents/skills/bosun-*` links, which apply may create in that repository. Changed configuration, manifest, profile files or skill links hold later actions.

After the daemon is running, inspect `bosun onboard --host omp` and preview the manual native launch using the host receipt's own ID/version/hash (the receipt version is numeric and is not the native host's version):

```sh
bosun host launch HOST_PROFILE_ID --version HOST_RECEIPT_VERSION --hash "$HOST_PLAN_HASH" --preview
bosun host launch HOST_PROFILE_ID --version HOST_RECEIPT_VERSION --hash "$HOST_PLAN_HASH"
```

The preview performs no native call. Actual launch checks the selected native version and opens its UI; it does not establish managed-session or automatic-handoff readiness. Keep existing old client processes closed until the ready authority and reviewed profile are selected.

OMP ordinary input hooks and OpenCode2's Promise plugin require a leading per-input `#public` marker; private/unmarked/attachment inputs omit context. OMP binds native `provider/model-id` and thinking levels, and uses existing native account configuration. OpenCode2 profiles use the V2 schema and `--standalone` with a reviewed owned overlay, not an already running service or V1 compatibility config. These paths have guarded synthetic source evidence only; they do not qualify read-only tools, active-total occupancy, live MCP/hook delivery or automatic ownership transfer.


## Enable, stop, reconcile and undo

For every new installation service/undo action, read `install status` and use its current `record.id`, `record.version` and original `record.planHash`. Receipt versions advance during effects; do not reuse an earlier version. Use a distinct stable `--request-id` for each intended enable/disable operation. It identifies the operation, not its receipt ID or any hash.

```sh
bosun install enable INSTALL_ID --version CURRENT_VERSION --hash INSTALL_PLAN_HASH --request-id enable-1 --clients-stopped
bosun install status
```

Enable publishes the owned daemon plist and starts it through launchd. `enabled` requires the selected binary, authority identity, socket and actual PID to agree. Foreign destinations, unsafe directories, stale receipts and unconfirmed readiness hold. Foreground use is `bosun daemon run`; stop it with Control-C and let it settle before choosing the owned service. Reopen clients after the runtime and selected installation/profile receipts are ready and the chosen authority is running. CLI/MCP clients never start a daemon automatically.

Stop clients and settle their effects before disabling:

```sh
bosun install disable INSTALL_ID --version CURRENT_VERSION --hash INSTALL_PLAN_HASH --request-id disable-1 --clients-stopped
```

Disable verifies the original service, waits for absence and authority closure, and archives only the matching owned plist. A lost effect receipt retains `unknown` rather than repeating bootstrap/bootout. Inspect the current receipt and reconcile the original service operation:

```sh
bosun install reconcile INSTALL_ID --version CURRENT_VERSION --hash INSTALL_PLAN_HASH
```

Reconcile has no `--request-id` or `--clients-stopped` option. It observes readiness or absence/closure and updates the original operation without replay; it may archive a confirmed owned definition after absence. Unconfirmed ownership/observation stays held. A completed repeated request returns its original operation; an uncertain one stays held. Read `install status` after each action. History is finite (64 service operations per receipt; 64 retained installation bundles); capacity holds require owner inspection, not evidence deletion.

To undo, first disable the daemon, stop clients and undo every profile that uses the installed executable. Host undo uses the host receipt version and has no hash or stopped-client flag:

```sh
bosun host undo HOST_PROFILE_ID --version HOST_RECEIPT_VERSION
bosun install status
bosun install undo INSTALL_ID --version CURRENT_VERSION --hash INSTALL_PLAN_HASH --clients-stopped
```

Undo requires a `ready` installation with service `prepared` or `disabled`, no published service, and matching owned files/backups. It archives the managed executable, restores an explicitly retained previous binary/link, and removes only matching empty directories it created. It retains runtime data and receipts; Homebrew keeps its binary. Drift or an uncertain removal remains held.

Migration spellings `start <id>`/`stop <id>` take the same flags as `install enable`/`disable`; `uninstall <id>` takes the same flags as `install undo`. `restart <id> --version CURRENT_VERSION --hash INSTALL_PLAN_HASH --request-id restart-1 --clients-stopped` composes two durable original disable/enable operations and holds if the stop is uncertain. None of these commands adopts ownership from legacy `state.json` or manages arbitrary Kev/Ollama services.
