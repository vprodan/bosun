# Static reproducibility experiment: ESM without bytecode

Two independent builds of the frozen current input snapshot produced identical raw files after removing only `--bytecode` from a private copy of the distribution tool. The binary, compressed archive, metadata and checksum file each have zero differing bytes. This bounded pair supplies static evidence for a candidate build configuration; neither generated executable was run, and compiled runtime and hook performance remain unqualified. The production build flags remain unchanged.

The exact [experiment driver](2026-10-11-distribution-no-bytecode-experiment.mjs), [execution log](2026-10-11-distribution-no-bytecode-experiment.log), [machine-readable record](2026-10-11-distribution-no-bytecode-record.json) and [copied variant tool](2026-10-11-distribution-no-bytecode-tool.txt) preserve the actual commands, complete input inventories, flags, compiler identity, private environments, terminal statuses, cleanup and raw comparisons. These are experimental artifacts, without release selection or publication.

## Inputs and commands

The Node 24.16.0 driver ran from `/Users/edge/Developer/bosun`, with `main` at `4adb3b4` and package 0.2.0. It first copied the public source, generated public assets, package/lock manifests and installed locked production dependencies into one private canonical source snapshot. It excluded ambient configuration, Git state, owner directories and tests. That snapshot contained 7,282 files. Its original source digest was `6284ca8d128993ccf63b967e772704ca3d41d907bfec5b63db212d85cf6eacca`.

The private snapshot’s `scripts/distribution.mjs` differed by exactly one removed line, `  "--bytecode",` followed by a newline. No other input changed. The production tool SHA256 stayed `100998a07b1bd76bc31734a1ac834ce0b1e74e1a32e4bc3746d89f958c2a4b18`; the archived variant SHA256 is `bb7bd6da321e5107a82fb728532cfff4069feb488f40e1cf8a6d697447e674ae`. Both output metadata inventories include the variant tool and record its actual flags. Their shared source digest is `d6840d5a7a410bd7b3a4b71d16d1f2ea1dcfa780b1c1aba53071c89e96fc68b9`.

The unchanged builder in that private tool created a separate fresh source snapshot and environment for each compile. Its observer passed command arguments and options to `spawnSync` unchanged. No flag was stripped or rewritten during invocation. Each build invoked only the explicitly installed compiler `/Users/edge/.bun/bin/bun`, first with `--version`, then with:

```text
--no-install build src/app/entry.ts
--compile --target=bun-darwin-arm64 --format=esm --splitting --minify
--no-compile-autoload-dotenv --no-compile-autoload-bunfig
--no-compile-autoload-tsconfig --no-compile-autoload-package-json
--define process.env.DEV="false" --external react-devtools-core
--outfile <that build's private temporary directory>/bosun
```

The compiler reported 1.4.2; both metadata records verify SHA256 `35d20dd0263e5c950194434b925454fdfa9ba6e4467da960410fa05b08a7a5b5`. All four compiler invocations returned status 0, no signal and no error. The build environment supplied only the existing builder’s explicit PATH, locale, UTC and private HOME/XDG/cache/temporary locations; it did not inherit owner credentials or configuration. The complete literal paths and values are in the record.

## Results

The driver ran once successfully with the command below, after the pre-compiler guard correction documented below. Original execution session 69779 is terminal, exit 0. The two experimental output directories remain available for static review:

```text
node docs/research/checkpoints/2026-10-11-distribution-no-bytecode-experiment.mjs > docs/research/checkpoints/2026-10-11-distribution-no-bytecode-experiment.log 2>&1
dist/bosun-0.2.0-darwin-arm64-no-bytecode-experiment-a
dist/bosun-0.2.0-darwin-arm64-no-bytecode-experiment-b
```

| File in each output | Bytes | Shared SHA256 | Raw differing bytes |
|---|---:|---|---:|
| `bosun` |64,522,098|`c7ccc89b709c7bd0d5cf9f692ab49d900705adea4bb5a54e3487ecab11cf089b`|0|
| `bosun-0.2.0-darwin-arm64.tar.gz` |27,191,946|`8bc683b69def5f63535d1e6ab79398591e37a0087aa33de7aab164c59db0bd6d`|0|
| `build.json` |1,323,998|`92079c97440d11d3fdd305a22ffff650666b98232e3016a41e5563d4c603ecbc`|0|
| `SHA256SUMS` |247|`872e00da00b7613781875831c0040a12d61d82b836a85a6c9a1b80876009c437`|0|

Both binaries pass the copied builder’s static Mach-O arm64 executable verification and have UUID `4c4c447c55553144a138dbd9c49417a3`. Both archives pass exact deterministic tar framing/content verification. Input inventory, compiler and actual flags match between builds. Raw comparisons have no difference spans. No post-build byte normalization or patching, private compiler seed or binary timestamp changes were performed; the existing archive builder retains its fixed tar framing.

The master source snapshot and each independent build snapshot were removed. The record checks their exact paths for absence after cleanup. It also verifies that protected production scripts, both pinned native-check drivers, package manifests and `bun.lock` retain their pre-experiment hashes, and that collecting the original source again produces the original digest. No product source, build flag, proposal, package version or Git history was changed. No produced binary, Bun application test, host, model, service, install or download command was invoked.

## Guard correction and limits

The initial wrapper attempt failed its first read-only branch guard because `/usr/bin/git` returned 69 under the scrubbed environment. It created no source snapshot and invoked no Bun compiler. The [initial exact driver](2026-10-11-distribution-no-bytecode-experiment-preflight-driver.txt) and [failure log](2026-10-11-distribution-no-bytecode-experiment-preflight.log) are retained. Read-only shell checks identified `/opt/homebrew/bin/git` as the existing Git and confirmed `main`/`4adb3b4`. Changing only the experiment wrapper’s Git executable allowed the bounded pair above to run; it did not change compiler flags or production tooling.

The earlier bytecode-enabled mismatch used an older source inventory. This experiment proves byte equality for this pair with one frozen current inventory; it does not compare bytecode-on/off builds of that same current inventory, establish a universal compiler guarantee or measure runtime performance. Production verification intentionally expects its existing bytecode flags; experimental metadata must be reviewed through the archived variant tool. Selecting a release configuration still requires the permitted compiled runtime, native integration and hook performance checks against a final frozen source tree.
