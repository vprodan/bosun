# 0002 · Offline native protocol prototypes

**Status:** Implemented; coordinator verification passed. **Date:** 2026-10-05.

## Context

The selected v1.0 design uses OpenCode first and replaces Kev with Ollama Clef, while native Codex/Claude remain first-class. Existing clients/model tools are not authorized to run or install. The next coherent step must exercise real published wire contracts through synthetic offline fixtures without claiming live qualification.

## Decision

Add one explicitly selected `ollama-clef` Router adapter and lazy factory. Use `/v1/systemone` choice questions, conservative option order, strict typed distributions/model equality, complete UTF-8 request bounds, bounded response/deadline and content-free coded failures. Trusted configured labels supply output metadata. Require own data-property public classification before input/config/HTTP. No ModelProvider conflation, retry/model substitution or hook inference is introduced.

Add OpenCode-native v1.18.34 metadata codecs and an explicitly selected GET-only loopback probe. Follow the pinned server's actual v1 route/schema chain; its older generated SDK misses current fields. Preserve model/provider/variant; keep latest completed-step input usage separate from session billing totals and unverified active occupancy. Emit unknown ContextSample values, not fabricated window/zero usage. Fresh-root and noReply recipes are pure objects and the probe cannot execute them.

Keep current Kev runtime/default/service intact. Calibration/live readiness markers are diagnostic data, not a new enforced dispatcher activation gate. No automatic Clef dispatch/controller or native HostAdapter is claimed. Existing managed-capability guards refuse all unverified OpenCode controls. Version mismatch, unsupported events or malformed metadata are held with finite errors.

## Sources and fixture provenance

[Pinned paths and synthetic fixture provenance](../../test/fixtures/native-protocol-provenance.md) were checked on this date. The OpenCode tag remained v1.18.34; no separate v2 example was mixed into v1 bodies/events. Global `message.updated` carries properties `{sessionID, info}`. Creation uses `model.id`; prompt uses `model.modelID` plus separate variant/noReply. These shapes and token candidates are not live ownership/readiness evidence.

Ollama's [API](https://docs.ollama.com/api/systemone) documents one response, model-name equality and the request byte bound. Its [decision guide](https://docs.ollama.com/capabilities/decision) and [Clef card](https://ollama.com/library/clef-flash) distinguish confidence concentration from correctness and specify tie ordering. The model-card context-size discrepancy is unresolved; no loaded window/model digest was inspected.

## Alternatives

Changing only the old Kev model string would leave service/config/readiness assumptions behind. A stub HostAdapter with empty install/control methods would misstate completion. An unpinned generated SDK or newer v2 snippets would blur protocol identity. Full native ownership/control is deferred until concrete fixture/live qualification supports it, within the same v1.0 scope.

## Consequences and limits

This slice proves bounded synthetic request/response behavior and shared Router acceptance, not quality, calibration, residency, native context semantics, tool isolation or automatic handoff. The metadata decoder validates fields it uses; it is not a complete upstream schema validator. Token/body/reset ambiguities retain unknown samples. Basic-auth and managed wiring are absent; HTTP 401 holds without credential discovery or retry. No native process/config/auth/controller mutation or model pull occurs. Codex/Claude parity, calibrated dispatcher gate, native runtime ownership, full Clef lifecycle migration and live qualification remain pending.

## Verification

Use guarded `node scripts/run-tests.mjs --runtime node --suite router,opencode,contracts`, isolated typecheck, boundary gate, then the full guarded `--suite all` and whitespace checks. Synthetic fixtures include malformed/foreign wire data, privacy/echo canaries, UTF-8 bounds, abort/stalled bodies, version/reset/usage distinctions and retained unverified controls. The coordinator records actual results in its ledger.

## Supersedes

Implements an initial subset of the OpenCode/Clef qualification work. It does not supersede the existing legacy runtime selection or complete the native adapter/controller/calibration roadmap.
