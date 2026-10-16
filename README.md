<p align="center">
  <img src="docs/assets/bosun.svg" alt="Bosun anchor logo" width="80" height="80">
</p>

# bosun

**Scoped memory, bounded coding jobs and reviewed handoffs for your native AI tools.**

[![CI](https://github.com/vprodan/bosun/actions/workflows/ci.yml/badge.svg)](https://github.com/vprodan/bosun/actions/workflows/ci.yml)
[![CD](https://github.com/vprodan/bosun/actions/workflows/cd.yml/badge.svg)](https://github.com/vprodan/bosun/actions/workflows/cd.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Bun 1.4.3](https://img.shields.io/badge/Bun-1.4.3-555555.svg)](https://bun.sh/)
[![Version 1.1.2](https://img.shields.io/badge/Version-1.1.2-555555.svg)](https://github.com/vprodan/bosun/releases)

Bosun pairs with **OMP, OpenCode 2, Codex and Claude Code** without taking over
native accounts or silently changing models. One local daemon owns the runtime;
the CLI, MCP and dashboard share its jobs, memory and review contracts.
**OMP is the primary host for new configuration.** Existing explicit selections
remain unchanged.

## What it does

- **Scoped memory:** curate notes, retrieve lexical context and retain original
  IDs, versions and audit. Privacy, scope, expiry and purge apply to derived
  context too.
- **Bounded jobs:** pin the runner, model, effort, working directory and access;
  track job state through durable request IDs and effect receipts.
- **Native roles:** share architect, scout, worker, tester, debugger and reviewer
  policy across host profiles while leaving authentication with each host.
- **Reviewed work:** bind reviews and explicit checks to repository revisions;
  use owned Git worktrees rather than copying dirty contents.
- **Handoffs:** transfer reviewed, checksum-bound public artifacts without
  moving credentials or assuming control of arbitrary running sessions.
- **Optional integrations:** public routing advice, graph/vector retrieval,
  read-only external memory and remote authority have explicit configuration
  and qualification gates; they are not automatic installation prerequisites.

### Host integrations

Native release admission uses **supported major versions**. Actual detected
versions remain in receipts and owned-session bindings; compatibility admission
does not qualify live tools or automatic controls.

| Host | Supported major | Selection |
| --- | --- | --- |
| OMP | `18.x` | Primary for new configuration |
| OpenCode 2 | `2.x` | Native `opencode2` profiles |
| Codex | `0.x` | Native Codex profiles |
| Claude Code | `2.x` | Native Claude profiles |

Codex is pre-1.0: minor releases may break protocol compatibility. Structural
validation still fails closed. Prereleases, malformed versions and other majors
are rejected; an existing prepared profile still binds its exact reviewed version.

An independent ACP v1 runner can use an already installed agent with an exact
pinned identity and acknowledged selectors. No live ACP agent is qualified yet.
See [native profiles](docs/upgrade-and-install.md#select-an-optional-native-profile),
[runner architecture](ARCHITECTURE.md#durable-jobs-and-native-execution) and
[native protocol provenance](test/fixtures/native-protocol-provenance.md).

## Releases

Download **`bosun-1.1.2-darwin-arm64.zip`** from
[GitHub Releases](https://github.com/vprodan/bosun/releases), then extract it in
Finder. **The ZIP contains the application.** `release.json`, `SHA256SUMS` and
release notes are supplementary metadata, checksums and tested-scope information,
not programs to open. You do not need to unpack the inner distribution tar archive.

This release is for **macOS Apple Silicon (arm64)** only. The repository is
private, so downloads require appropriate GitHub access. The executable is
**not notarized**; see the guide below if macOS blocks it.

### Start with the downloaded ZIP

Bosun is a **terminal CLI, not a GUI app**. Open Terminal and change into the
extracted folder containing `bosun` (replace the example path with yours):

```sh
cd "$HOME/Downloads/bosun-1.1.2-darwin-arm64"
shasum -a 256 -c SHA256SUMS && ./bosun install
```

Use **v1.1.0 or later** for guided reinstall, update and uninstall. Older binaries
need the new ZIP once; they cannot acquire commands added after their release.
For Ollama0.40.x single-manifest MLX Clef models, use **v1.1.1 or later**;
it fixes a false `unsupported_model` result without changing the selected model.

The installer walks through explicit approvals: prepare a new data home,
review executable replacement, optionally start Bosun in the background, and
optionally set up Ollama and pull your exact configured router model
(`clef-flash:9b` by default). Every tool download, app launch and model pull needs
its own approval. Declining optional tools makes no tool or endpoint calls.

An existing ready installation offers reinstall without resetting memory,
configuration or model selections. It uses the original installed executable
to retire its receipt safely across versions, rather than asking you to copy
hashes. Unknown operations, drift, active foreground daemons and unsafe
nonempty homes are held, never erased or replayed. An empty owned directory
with loose permissions can be restricted to0700 after a separate approval.

The installer prints your absolute installed executable path. If you decline
background start, run it in the foreground and leave that terminal open:

```sh
"$HOME/.local/bin/bosun" daemon run
```

Open a second terminal (with the same `BOSUN_HOME`, if customized):

```sh
"$HOME/.local/bin/bosun" memory add --category project --title "First note" --body "Bosun is running locally."
"$HOME/.local/bin/bosun" memory search Bosun
```

Use the explicit installed path or `export PATH="$HOME/.local/bin:$PATH"` for
the current shell session. Bosun never edits your shell configuration. Data
lives in `~/.bosun` by default (`BOSUN_HOME` selects another absolute path).
Existing data must never be reset to bypass an installation hold.

### Reinstall, update or uninstall

After adding `~/.local/bin` to your shell's PATH:

```sh
bosun install    # guided reinstall; retain data and settings
bosun update     # download, verify and install the latest stable GitHub release
bosun uninstall  # remove owned executable/service; retain memory and settings
```

Updates verify GitHub asset digests, release/tag/commit identity, archive contents
and compiled safety provenance before opening the new installer. Downgrades are
refused. This private repository requires existing authorized `gh` access for
automatic updates; Bosun does not install `gh` or change your authentication.
Without it, download the new ZIP in GitHub and run its `./bosun install`.

Only the receipt-owned Bosun service can be stopped automatically after approval.
Stop separately launched foreground/nohup daemons yourself. Uninstall retains
Ollama, models, configuration, memory, backups and receipts; a reviewed previous
executable is restored when the installation replaced one. It is not a data purge.


**[Complete installation guide](docs/upgrade-and-install.md)** covers expected
prompts, Gatekeeper limits and the secondary advanced plan/apply interface.

The release **bundles Bun**: initial installation and memory need no separate
Bun, Node, npm, `gh` or `jq`. Clients do not start the daemon implicitly.
Memory operations never call models. Optional router setup downloads tools/model
files only after approval, not inference; live model quality and automatic
dispatch remain independently gated. Native host accounts and explicit
provider/model bindings remain yours.

Keep license notices and provenance with redistributed copies. The bundle
retains the original compiled distribution, safety receipt, project/dependency/
runtime licenses and source/relink information. Release notes describe the exact
candidate's tested scope; no other platform or live-model qualification is implied.
Local candidates and historical receipts remain in
[maintenance guidance](docs/maintenance.md), not substitutes for release assets.

### Developer source usage (not needed for the ZIP)

The commands below are for developers running a source checkout, **not the
downloaded application**. Source usage requires **Bun 1.4.3 on macOS arm64**,
existing project dependencies and the reviewed native SQLite inputs. There is
no Node fallback. These examples use the established checkout entry; they do
not install dependencies, hosts or models. Use storage and lifecycle commands
only after runtime qualification and owner review.

Inspect the selected home first:

```sh
bun bin/bosun doctor
bun bin/bosun onboard --host omp
```

`doctor` inspects filesystem metadata without opening databases, probing native
services or repairing files. `onboard` reports the next reviewed action. The home
defaults to `~/.bosun`; `BOSUN_HOME` selects another absolute path.

For a **new** private home, after qualification:

```sh
bun bin/bosun setup
bun bin/bosun config show
bun bin/bosun roles --json
bun bin/bosun daemon run
```

`setup` initializes a new runtime; it is not an upgrade or installation command.
Review `config.toml` and exact native model/effort bindings before using a host.
Keep the daemon running in its own terminal; clients never start it implicitly.
See [new-home setup](docs/upgrade-and-install.md#prepare-a-new-home-and-choose-settings)
for the supported layout and configuration boundaries.

With a qualified daemon running, another terminal can use local memory and
inspect existing jobs:

```sh
bun bin/bosun memory add --category project --title "Runtime" --body "Use Bun 1.4.3 for this checkout."
bun bin/bosun memory search Bun
bun bin/bosun context "Which runtime?" --sources lexical
bun bin/bosun job list
```

The CLI's `--help` describes command options. Detailed behavior lives in the
[memory and hook architecture](ARCHITECTURE.md#memory-publication-and-hook-delivery)
and [job architecture](ARCHITECTURE.md#durable-jobs-and-native-execution).

## Safety by design

- **One authority:** a daemon owns each prepared home. Reads and startup do not
  initialize, migrate or repair unknown layouts.
- **Explicit selections:** models, effort, cwd and access are preserved; native
  accounts remain host-owned. No credential borrowing or silent model fallback.
- **Public-only inference:** private or unclassified content is excluded from
  model projection. Ordinary OMP/OpenCode prompt hooks require a leading
  per-input `#public` token; they do not rewrite native text.
- **Lean hooks:** context delivery is bounded and read-only, with no model calls,
  indexing or remote network dependency on the hook path.
- **No uncertain replay:** lost native or commit confirmations remain durable
  `unknown` outcomes for inspection, not permission to retry an effect.
- **Reviewed changes:** installation, profiles, service control and handoff use
  exact plans, hashes and receipts. Unverified automatic controls stay held.

These are trusted-application boundaries, not a universal sandbox or a claim of
hostile-same-user isolation. See [shared policy](policy.md) and
[qualification requirements](docs/maintenance.md#qualification-review-requirements).

### What is qualified—and what is not

The latest maintained artifact passed its exercised **contained minimum-safety**
scope after the typed-tooling migration: compiled entry/MCP behavior,
storage/privacy, shutdown and owner-lock reacquisition, and 10,000-note public
hook delivery. Strict tooling/source typecheck and 1,188 tests across 94 guarded
files passed after the typed cutover; 50 affected tests passed after final
lock/template cleanup. These checks do not establish production readiness.

Real-model quality and Clef calibration, physical vector support, live native
tool/plugin controls and automatic handoffs, live Orca controls, personal
installation/launchd/TCC, second-machine deployment and broader compiled
reproducibility remain separate gates. Synthetic fixtures and a green CI badge
do not qualify them. Current evidence and limits are maintained in
[maintenance guidance](docs/maintenance.md#deferred-gates-and-safety-boundaries).

## Development

Use the maintained **typed `.mts` drivers through the Bun wrapper**. The wrapper
starts with fresh HOME/cache and disables automatic installs and env-file
loading. Application tests require the guarded launcher/preloads and inherited
OS containment; do not run direct `bun test` or substitute Node.

```sh
sh scripts/bun-check.sh tests --runtime bun --suite omp,opencode,managedcontrols,nativerunners,claudeclient,claudetranscript,core,boundaries,lint
sh scripts/bun-check.sh typecheck
sh scripts/bun-check.sh boundaries
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for extension seams, suite selection,
canonical assets and native preparation. Builds use already installed Bun 1.4.3
on macOS arm64 and **fixed reviewed native bytes/toolchain inputs**; another
machine or toolchain is not automatically admitted. Build outputs must be new.
Static distribution verification establishes integrity, not origin, live-host
support or runtime qualification. See the
[build and verification architecture](ARCHITECTURE.md#verification-and-remaining-work)
and [native admission guidance](docs/maintenance.md#native-sqlite-library-admission-2026-10-13).

The [CI workflow](https://github.com/vprodan/bosun/actions/workflows/ci.yml)
automatically runs source hygiene and fresh hosted macOS arm64 qualification,
typecheck, boundaries and all guarded tests. The
[CD workflow](https://github.com/vprodan/bosun/actions/workflows/cd.yml) builds
and publishes matching version tags only after full pipeline success, with
publishing permissions confined to a separate asset-verification job.
Badges report workflow state, not complete production/model qualification.

## Documentation

| Guide | Covers |
| --- | --- |
| [Upgrade, installation and onboarding](docs/upgrade-and-install.md) | New homes, legacy cutover, reviewed profiles and owned service lifecycle |
| [Architecture](ARCHITECTURE.md) | Seven ports, shared authority, jobs, memory, integrations and handoff |
| [Contributing](CONTRIBUTING.md) | Extension patterns, guarded development and native inputs |
| [Maintenance and recovery](docs/maintenance.md) | Current scope, candidate receipts, deferred gates and historical recovery |
| [Shared policy](policy.md), [roles](roles), [skills](skills) | Canonical policy and native role assets |

Historical research, checkpoints and archived guides remain evidence, not
current executable plans or installation instructions. Recovery of retired
plans/specs and root handoff/resume histories is centralized in the
[maintenance guide](docs/maintenance.md#preserved-history).

## License

[MIT](LICENSE) for project-owned work. Dependencies retain their own licenses;
AI-assisted authorship does not remove provenance or third-party obligations.
