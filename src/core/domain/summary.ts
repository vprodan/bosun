import type { JsonSchema } from './inference.ts';

export type SummaryEvidence = { privacy: 'public'; id: string; cursor: string; text: string };
export type SummaryExcerpt = { id: string; cursor: string; sha256: string; quote: string };
export type EvidenceSummary = {
  text: string; evidenceIds: string[]; providerId: string; model: string; excerpts: SummaryExcerpt[];
  coverage: { events: number; chunks: number; lastCursor: string };
};
export const SUMMARY_LIMITS = Object.freeze({ events: 100, eventBytes: 8192, excerpts: 16, quoteChars: 400, textChars: 8000,
  chunkBytes: 24576, replyBytes: 32768, chunks: 32 });
// Selection is extractive: generated prose never supplies task authority or
// repository facts. Every returned quote must occur in its cited public source.
export const SUMMARY_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object', additionalProperties: false, required: ['items'], properties: {
    items: { type: 'array', maxItems: SUMMARY_LIMITS.excerpts, items: {
      type: 'object', additionalProperties: false, required: ['evidenceId', 'quote'], properties: {
        evidenceId: { type: 'string', minLength: 1, maxLength: 80 }, quote: { type: 'string', minLength: 1, maxLength: SUMMARY_LIMITS.quoteChars },
      },
    } },
  },
};
