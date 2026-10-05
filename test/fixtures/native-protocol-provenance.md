# Native protocol fixture provenance

Checked 2026-10-05. JSON fixtures are compact **invented public test data**, not captured model runs, sessions, owner transcripts or databases. Field names/shapes follow the primary sources below. No dependency, host binary or model was installed or run.

## Ollama Clef

[Decision guide](https://docs.ollama.com/capabilities/decision), [System One API](https://docs.ollama.com/api/systemone), [Clef-Flash card](https://ollama.com/library/clef-flash).

The API specifies one JSON response, named typed answers/probabilities/confidence, response model equal to request, and a 64 KiB non-image request bound. Clef requires Ollama 0.35.1+. Option order resolves ties. Confidence is concentration, not measured accuracy. Our numeric fixture is synthetic; it is not calibration evidence. The adapter's rounding tolerance, timeout, text cap and response cap are bosun policy. Catalog/readme context sizes disagree; this slice establishes no loaded-window, residency, latency or quality claim.

## OpenCode native v1.18.34

Pinned release sources were available. The legacy `packages/sdk/js/src/gen/types.gen.ts` omits fields present in the actual server schema; **it is not this fixture's authority**. We follow v1 route groups and their v1 schema reexports within the same release. Internal core modules named V2 do not justify using a separate v2 HTTP/SDK example.

- [Global routes](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/server/routes/instance/httpapi/groups/global.ts) and [handlers](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts): GET `/global/health`; `/global/event` SSE `event: message` with JSON envelope/payload.
- [Session routes](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/server/routes/instance/httpapi/groups/session.ts): GET `/session/:sessionID` and `/session/:sessionID/message`; POST creation and prompt payloads.
- [v1 session schema](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/schema/src/v1/session.ts), through [core v1 reexport](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/core/src/v1/session.ts): SessionInfo, WithParts, Assistant, step-finish tokens, and `message.updated` properties **`{sessionID, info}`**. The global payload also has an event ID; unknown fields are not projected.
- [Session implementation](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/session/session.ts): creation model uses `id/providerID/variant`. `getUsage` removes cached input from the separate input count. Session usage accumulates and is not active occupancy.
- [Prompt](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/session/prompt.ts): prompt model uses `modelID/providerID`, separate `variant`, and `noReply`; the noReply branch returns the user message before the generation loop.
- [Processor](https://github.com/anomalyco/opencode/blob/v1.18.34/packages/opencode/src/session/processor.ts): step-finish overwrites assistant usage with the current step and records step-finish usage. The candidate uses the latest completed assistant's last step input + cache read/write once, not accumulated session/older-step totals, output or `total`.

Codecs validate a deliberately bounded **metadata subset**, not every upstream text/tool/file schema or complete native support. Prototype version mismatch is held rather than silently upgraded. Latest input usage is only a candidate: effective window, prefix/body scope and live occupancy/reset semantics remain unverified. ContextSample stays unknown, with no fabricated zero/window. Read-only HTTP fixture success, a root creation response, and noReply serialization prove no prompt fence, tool quiescence, seed acknowledgement, ownership transfer or safe automatic handoff. Every managed capability remains unverified; Codex/Claude parity is still pending.
