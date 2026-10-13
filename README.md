<p align="center">
  <img src="docs/assets/bosun.svg" alt="Bosun anchor logo" width="80" height="80">
</p>

# bosun

**Scoped memory, bounded coding jobs and reviewed handoffs for your native AI tools.**

[![CI](https://github.com/vprodan/bosun/actions/workflows/ci.yml/badge.svg)](https://github.com/vprodan/bosun/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Bun 1.4.3](https://img.shields.io/badge/Bun-1.4.3-555555.svg)](https://bun.sh/)
[![Local release 1.0.0](https://img.shields.io/badge/Local_release-1.0.0-555555.svg)](docs/maintenance.md#latest-maintained-artifact)

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

## Start with the local artifact

**Version 1.0.0 is a local macOS arm64 release, not a published download or package
installation.** The latest maintained artifact is
`dist/bosun-1.0.0-darwin-arm64-host-major/` in the prepared checkout. Its standalone
executable needs no external Node runtime or `node_modules`.

```sh
dist/bosun-1.0.0-darwin-arm64-host-major/bosun --version
shasum -a 256 dist/bosun-1.0.0-darwin-arm64-host-major/bosun-1.0.0-darwin-arm64.tar.gz
```

Use that artifact's `build.json`, `SHA256SUMS` and matching qualification receipt.
The [maintenance guide](docs/maintenance.md#native-major-compatibility-and-ci-correction-2026-10-14) records its
hashes and candidate-bound evidence. A later rebuild needs its own receipts;
prior results do not qualify changed source or tooling.

For an existing runtime, follow the
[upgrade, installation and onboarding guide](docs/upgrade-and-install.md).
Installation is a reviewed plan/apply flow, not copying a binary over a running
authority. There is no npm or Homebrew installation shortcut here.

### Basic source usage

Source usage requires **Bun 1.4.3 on macOS arm64**, existing project dependencies
and the reviewed native SQLite inputs. There is no Node fallback. These examples
use the established checkout entry; they do not install dependencies, hosts or
models. Use storage and lifecycle commands only after runtime qualification and
owner review.

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

The [GitHub CI workflow](https://github.com/vprodan/bosun/actions/workflows/ci.yml)
automatically checks changed-path whitespace hygiene on hosted runners. Qualified
Bun/native checks are owner-requested and require an approved environment. The
badge reflects workflow status, not a manually asserted passing result or
production qualification.

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
