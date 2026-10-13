# Compiled artifact reproducibility: narrowed cause

Static inspection of the two earlier same-input builds identifies changing module keys. Neither executable was run, normalized or patched. This does not qualify the current source or prove a reproducible replacement build.

The original [comparison](2026-10-11-distribution-build-comparison.log) has identical input inventory, compiler and flags, identical binary length and Mach-O UUID, but262 changed bytes. The new [difference-span record](2026-10-11-distribution-difference-spans.json) resolves these into12 regions. Repeated strings change from prefix `0afe8e13538bc7eb` to `08265292fc661009`, followed by the same `C000000nn` chunk suffixes and virtual chunk paths. Associated nearby binary fields also change. Both original binary hashes were rechecked against that comparison.

Pinned [Bun1.4.2 bundle source](https://github.com/oven-sh/bun/blob/bun-v1.4.2/src/bundler/bundle_v2.rs#L7964) generates the bundler unique key from `fast_random`, with its high nibble masked off. Its [chunk wire formatter](https://github.com/oven-sh/bun/blob/bun-v1.4.2/src/bundler/Chunk.rs#L1290) uses16 lowercase hexadecimal digits, a kind letter and an eight-digit index; chunk kind is `C`. This matches the changed strings exactly. The publisher source and selected excerpt hashes are recorded in bun-module-id-source.json and bun-chunk-key-format-source.json.

The evidence therefore strongly implicates retained random bundler chunk keys in this ESM/bytecode configuration. It does not establish that every changed byte has that cause, that fixed working directories would help, or that another flag combination is reproducible. The failed lowercase chunk.rs source lookup was404 and supplied no evidence; the actual file is uppercase Chunk.rs.

The next bounded build experiment can compare the current ESM/splitting configuration with bytecode disabled, recording the actual flags and frozen inputs for each artifact and comparing independent builds. No compiler-private seed, binary rewriting, hash normalization or new compiler installation is justified. A flag change would still need compiled runtime and hook performance qualification; a smaller static difference alone is insufficient to select it for release.

Current state: source/dependency/archive integrity is checked; byte-for-byte compiler reproducibility remains unproved. No native runtime/performance claim or release decision follows from this diagnosis.
