# Source and relinking information

The bosun release contains the project MIT license, verbatim dependency notices,
Bun's upstream license declaration and library inventory, and LGPL 2.0/2.1 texts.
These are redistribution materials, not a statement that all dependencies are MIT
or a substitute for review of third-party obligations.

## Exact source mappings

`THIRD_PARTY.json`, `build.json`, `release.json` and `qualification.json` in the
release bundle identify the project commit, original compiled binary, dependency
versions, archive digests, native patch and exercised qualification. Project
source is available at the release tag in the same GitHub repository; recipients
of a private release need corresponding repository access.

Bun 1.4.3 source revision: https://github.com/oven-sh/bun/tree/c6da4a4d3
Upstream runtime notice: https://github.com/oven-sh/bun/blob/c6da4a4d3/LICENSE.md
Upstream relinking instructions:
https://github.com/oven-sh/bun/blob/c6da4a4d3/docs/project/license.mdx
Yoga 3.2.1 source and license: https://github.com/facebook/yoga/tree/v3.2.1

Bun's upstream notice states that it statically links JavaScriptCore/WebKit under
LGPL terms. Its corresponding patched WebKit source is
https://github.com/oven-sh/WebKit. Work from the exact Bun revision above, not
current main. Follow that revision's build prerequisites, clone the WebKit source
into `vendor/WebKit`, run `bun sync-webkit-source` to select the pinned WebKit
revision, apply your library changes, then run `bun run build:local`. The upstream
recipe builds JavaScriptCore and Bun's C++ binding objects and produces a new Bun
runtime for relinking. Preserve applicable library licenses and notices.

To rebuild the application against that modified runtime, obtain the exact bosun
tag and locked project dependencies. The SQLite archive URLs/digests and maintained
patch are in `scripts/sqlite-native-inputs.mts` and `patches/`; explicit native
preparation/build scripts materialize and compile those reviewed sources. No
stock prebuilt SQLite library is substituted. Review and qualify modified native
inputs rather than removing integrity assertions.

Use the existing project build driver with the absolute rebuilt Bun executable
and an absent output directory:

```sh
sh scripts/bun-check.sh build --bun /absolute/path/to/rebuilt-bun --out /absolute/path/to/new-output
```

Its entry is `src/app/entry.ts`; exact compiler flags, source inventory and native
provenance are retained in the release's build metadata. A custom runtime or
library may require explicit changes/requalification of runtime admission; the
original release's safety receipt never qualifies modified binaries. Original
bosun/host/privacy/audit/unknown-nonreplay guarantees must not be claimed for an
unqualified rebuild. Rebuilding does not require publishing or activating models.

For additional linked-runtime library and polyfill source references, see the
bundled verbatim `bun-LICENSE.md`. LGPL text permits the described library changes
subject to its terms; review the full texts rather than treating this guide as
legal advice.
