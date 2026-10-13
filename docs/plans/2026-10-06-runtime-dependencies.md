# Final runtime dependency proposal

Prepared 2026-10-06 for direct v1.0 delivery. [Exact proposed package manifest](2026-10-06-package.proposed.json); the owner approved project-only installation. The first attempt exposed five unpublished pins, corrected after direct registry verification to MCP2.3.0 and LogTape2.3.11. Actual package.json now contains this same package set; installation completed successfully (70 packages added), with a project package-lock.json. Package version remains 0.2.0.

The saved owner instruction in [RESUME.md](../../RESUME.md) prohibits dependency installation without an explicit ask. The final shared contracts/TOML config/CLI/transport need these real libraries. No substitutes or temporary copies are proposed.

| Purpose | Exact dependencies |
|---|---|
| CLI and prompts | commander15.0.0, @commander-js/extra-typings15.0.0, @clack/prompts1.8.1 |
| Contracts and config | zod4.6.5, smol-toml1.9.0 |
| Daemon HTTP/SSE | hono4.13.13, @hono/node-server2.1.3 |
| MCP server and configured sources | @modelcontextprotocol/server2.3.0, @modelcontextprotocol/client2.3.0 |
| Logs | @logtape/logtape2.3.11, @logtape/file2.3.11, @logtape/redaction2.3.11 |
| Dashboard | ink7.1.1, react19.3.0, @types/react19.3.0 (development) |
| Lint | @biomejs/biome2.5.15 (development) |

Registry version/engine/peer metadata was read without downloading package code. Keep the approved Ink7 line rather than introducing the new major8 during this build. Installed TypeScript6 remains the checker/parser; no compiler migration is required for this flow.

The owner explicitly approved this project-only exception; package.json was updated and npm --ignore-scripts --no-audit --no-fund created package-lock.json. Strict TLS succeeded using the system certificate store; no certificate verification was disabled. Installation uses a temporary HOME/cache and explicit empty npm user/global config files; it must not read or change personal npm configuration or credentials. Only project dependencies and temporary install files are affected. Existing untracked bun.lock remains untouched. No global installs, host applications, Python packages, model pulls, services or personal host configuration. Tests remain guarded Node-only.

Lazy CLI/MCP/dashboard/logging modules own these imports. The hook remains built-ins plus lean internal code and generated JSON configuration; it imports none of these libraries. Final tests will use the installed libraries, not protocol stubs posing as implementations.

Primary metadata: [Commander](https://registry.npmjs.org/commander/15.0.0), [Zod](https://registry.npmjs.org/zod/4.6.5), [smol-toml](https://registry.npmjs.org/smol-toml/1.9.0), [Hono](https://registry.npmjs.org/hono/4.13.13), [MCP server](https://registry.npmjs.org/@modelcontextprotocol%2Fserver/2.3.0), [Ink7](https://registry.npmjs.org/ink/7.1.1), [LogTape](https://registry.npmjs.org/@logtape%2Flogtape/2.3.11), [Biome](https://registry.npmjs.org/@biomejs%2Fbiome/2.5.15).
