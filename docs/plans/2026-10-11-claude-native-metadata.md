# Review proposal: disposable Claude native metadata

The owner approved this exact proposal; its one-run check is fulfilled. The verified disposable native binary ran only version/help, both processes joined and the entire temporary tree was removed. No permanent Claude installation, SDK, model, authentication or personal configuration change occurred. See the execution receipt below. [RESUME.md](../../RESUME.md) requires “No installs without an explicit ask.” The completed project dependency permission does not authorize a native host download. This proposal requests one disposable download and two metadata invocations; it does not install a supported host or qualify automatic handoff.

Exact review driver: [scripts/check-claude-metadata.mjs](../../scripts/check-claude-metadata.mjs), SHA256 `2a36c41932db73c7b396b21f188f3288bab50d1d2b01df3358ae104d6453e059`.

Proposed one-run command:

```sh
node scripts/check-claude-metadata.mjs --approved-claude-metadata-only
```

The driver downloads only the publisher's exact [darwin-arm64 2.1.292 package](https://registry.npmjs.org/@anthropic-ai/claude-code-darwin-arm64/2.1.292), through its pinned npm registry archive URL, with redirects refused and a 120-second/250 MB compressed bound. It verifies registry archive SHA512 before decompression and parses only the four known regular-file members; links, extra paths, PAX headers and unexpected sizes fail closed. No tar, package manager, install script, SDK or global installation is run.

Pins:

- Archive SHA512 base64: `SBkmDQOPbQ9bqkGrzshn92ByyqQy2P7pSs/11NdMLq2VXbcQc93z+yd8Dtx4+jeAX22G7GSvQpKDyKev70Vn8Q==`.
- Exact executable: 235,017,328 bytes; SHA256 `97a01e5bc74a199e67189435d0331ea3a24eac2e07db4b76d9148c5b0386138f`; Mach-O ARM64 checked before execution.
- Package uncompressed payload: 235,017,905 bytes. Individual file size/hash metadata was independently inspected through [the versioned registry mirror metadata](https://unpkg.com/@anthropic-ai/claude-code-darwin-arm64@2.1.292/?meta). No executable bytes were fetched during preparation.

The executable is written mode0700 inside one fresh canonical private `/tmp/bosun-claude-metadata-*` tree. Each native invocation gets a literal temporary HOME, Claude/XDG/cache/data/state/temp directories and empty PATH; no developer environment or auth variables are inherited. Automatic updates and nonessential traffic are disabled through documented client environment switches. Invoke only `claude --version`, then `claude --help`, once each, without stdin. No prompt, initialize/control channel, model, login, credential export, native user configuration, owned service or other installed host is selected. This uses a trusted pinned client, not an OS filesystem/network sandbox; these invocations alone cannot establish broader offline behavior.

Each child has a 10-second deadline and combined1 MiB output bound. Failure terminates its owned process group with a500 ms kill backstop. Join the original process and surviving ordinary group members before cleanup. If group termination remains uncertain, preserve the private temporary tree and report the held path rather than cleaning while native producers survive. Otherwise remove the entire disposable tree. Retain only public CLI help and finite version/hash/flag/terminal metadata in the redirected review log; raw stderr is hashed, not printed. No retries.

Node syntax validation, wrong-archive rejection before decompression and guarded synthetic Node success/nonzero-original-group preflight passed. Evidence: docs/research/checkpoints/2026-10-11-claude-metadata-driver-preflight-node.log. The new candidate stream transport passed12/12 guarded fixtures; combined native/bootstrap integration passed274/274 plus19 containment. Those fixtures qualify the implementation recipe, not the native client's behavior.

The purpose is to replace guessed executable/flag assumptions with exact version/help evidence for the next protocol proposal. Publisher SDK0.3.292 declares `shouldQuery:false` input insertion, but retention/readiness, effective settings, ingress/background control and current occupancy still need independent native qualification. No production capability is marked verified by this proposal. Model/credential/installed-host qualification requires a separate concrete scope later. All Bosun application tests remain on guarded Node; pending compiled-storage and offline corpus approvals remain separate and unchanged.

Owner explicitly approved “Allow disposable metadata check” on2026-10-11. Driver hash rechecked before the one-run invocation; no broader native/model or install permission is inferred. Execution result will be recorded after original-process joins.

The approved one-run check is fulfilled: publisher archive/executable size and hashes verified; version/help2/2 exited0 without signal/stderr, both originalgroupsjoined, private tempremoved. Node driver session63040 exited0 and joined. Evidence: docs/research/checkpoints/2026-10-11-claude-native-metadata.log SHA25681d75d8d45a66537f51e9f9cc261441ed80de10ba76bb3c00b2cb4f2896bfe89. Native help established the explicit replay-user-messages flag; source transport was corrected. No repeat or broader native/model/install action is authorized.
