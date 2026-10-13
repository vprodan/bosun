# Embedding interface references (2026-10-10)

Read-only primary-source refresh; no model/extension install or live provider request.

- [Ollama `/api/embed`](https://docs.ollama.com/api/embed): batched input, dimensions, truncatefalse rejection rather than silent clipping, explicit keep-alive; response model/vector arrays and input-token/total/load nanosecond counters. Adapter checks these finite declared fields and retains original units.
- [Google EmbeddingGemma model card](https://huggingface.co/google/embeddinggemma-300m): retrieval uses different query/document prompts; core versions its exact transformation. The published full dimension is768 with reduced options; no runtime template, actual weights or Apple latency was qualified here.
- [sqlite-vec vec0 documentation](https://alexgarcia.xyz/sqlite-vec/features/vec0.html): metadata filters/partition keys constrain KNN before top-k; auxiliary columns cannot filter it. The current reference ranks already permitted/scoped candidates and does not qualify that optional extension backend.

Remaining: validate actual local template behavior, digest/loaded model identity, optional native extension loading/engine and build, whole-model/host token budget, cold/warm/residency/performance and incremental MCP D quality.
