import type { Ctx } from './memory.ts';
import type { GraphArtifact, GraphInput, GraphSupport } from './graph.ts';
import type { JsonSchema } from './inference.ts';

export const CONSOLIDATION_LIMITS = Object.freeze({ outstanding: 20, sources: 8, events: 100, proposals: 4, inputBytes: 24576, outputBytes: 32768,
  quoteChars: 400, timeoutMs: 60000, minPollMs: 60000 });
export type ConsolidationKind = 'fact' | 'duplicate' | 'merge' | 'contradiction' | 'entity' | 'relation' | 'summary' | 'profile';
export type ConsolidationSource = { privacy: 'public'; id: string; version: number; hash: string; title: string; text: string };
export type ConsolidationWindow = { cursor: number; through: number; sources: ConsolidationSource[]; parents: GraphArtifact[]; outstanding: number; state: 'ready' | 'backpressure' | 'held' };
export type ConsolidationCitation = GraphSupport & { start: number; end: number };
export type ConsolidationProposal = { kind: ConsolidationKind; input: GraphInput; citations: ConsolidationCitation[] };
export type ConsolidationRequest = { requestId: string; projectId: string; sessionId: string | null; cursor: number; through: number; sources: GraphSupport[]; providerId: string; model: string };
// A sticky source reservation complements the job executor; it does not track job lifecycle or perform recovery/replay.
export type ConsolidationClaim = { id: string; cursor: number; through: number; version: number; sources: GraphSupport[] };
export type ConsolidationReceipt = { cursor: number; ids: string[]; processed: number };
export interface ConsolidationStorage {
  window(ctx: Ctx, input: { maxSources: number; maxInputBytes: number; maxOutstanding: number }): ConsolidationWindow;
  claim(ctx: Ctx, request: ConsolidationRequest, maximumOutstanding?: number): { claim: ConsolidationClaim; window: ConsolidationWindow };
  capture(ctx: Ctx, claim: ConsolidationClaim): ConsolidationWindow;
  commit(ctx: Ctx, claim: ConsolidationClaim, proposals: readonly ConsolidationProposal[], maximumOutstanding: number): ConsolidationReceipt;
  status(ctx: Ctx): { cursor: number; claim: ConsolidationClaim | null; outstanding: number };
  abandon(ctx: Ctx, id: string, version: number): { cursor: number };
  proposals(ctx: Ctx, limit: number): { kind: ConsolidationKind; artifact: GraphArtifact }[];
}
const text = (max: number): JsonSchema => ({ type: 'string', minLength: 1, maxLength: max });
export const CONSOLIDATION_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object', additionalProperties: false, required: ['items'], properties: { items: { type: 'array', maxItems: CONSOLIDATION_LIMITS.proposals,
    items: { type: 'object', additionalProperties: false, required: ['kind', 'title', 'text', 'citations', 'parents', 'entity', 'relation'], properties: {
      kind: { type: 'string', enum: ['fact', 'duplicate', 'merge', 'contradiction', 'entity', 'relation', 'summary', 'profile'] }, title: text(200), text: text(2000),
      citations: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'object', additionalProperties: false, required: ['evidenceId', 'quote'], properties: { evidenceId: text(100), quote: text(400) } } },
      parents: { type: 'array', maxItems: 8, items: text(100) },
      entity: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, required: ['type', 'key', 'aliases'], properties: {
        type: { type: 'string', enum: ['project', 'file', 'symbol', 'tool', 'concept'] }, key: text(400), aliases: { type: 'array', maxItems: 12, items: text(200) } } }] },
      relation: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, required: ['from', 'to', 'predicate', 'weight'], properties: {
        from: text(100), to: text(100), predicate: { type: 'string', enum: ['uses', 'depends_on', 'implements', 'related_to', 'supports', 'supersedes', 'contradicts'] }, weight: { type: 'number', minimum: 0, maximum: 1 } } }] },
    } } } },
};
