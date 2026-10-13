import { z } from 'zod';
import { MemoryError } from '../core/errors.ts';
import type { GraphInput, GraphQuery } from '../core/domain/graph.ts';

const text = (max: number) => z.string().min(1).max(max).regex(/\S/);
const id = text(100); const positive = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const stamp = z.number().int().min(0).max(8640000000000000).nullable();
export const GraphInputSchema = z.strictObject({
  kind: z.enum(['source', 'fact', 'entity', 'relation', 'summary', 'profile']), title: text(200), text: z.string().max(4000).optional(),
  supports: z.array(z.strictObject({ memoryId: id, version: positive, hash: z.string().regex(/^[a-f0-9]{32}$/),
    start: z.number().int().min(0).max(4000).optional(), end: z.number().int().min(0).max(4000).optional() })).min(1).max(8),
  parents: z.array(z.strictObject({ id, version: positive })).max(8).optional(),
  entity: z.strictObject({ type: z.enum(['project', 'file', 'symbol', 'tool', 'concept']), key: text(400), aliases: z.array(text(200)).max(12).optional() }).optional(),
  relation: z.strictObject({ from: id, to: id, predicate: z.enum(['uses', 'depends_on', 'implements', 'related_to', 'supports', 'supersedes', 'contradicts']),
    weight: z.number().min(0).max(1) }).optional(),
  validFrom: stamp.optional(), validTo: stamp.optional(),
  producer: z.strictObject({ kind: z.enum(['owner', 'deterministic', 'model']), model: text(400).nullable(), version: text(100) }).optional(),
});
export const GraphQuerySchema = z.strictObject({ text: z.string().max(2000), limit: z.number().int().min(1).max(50).optional(), expand: z.boolean().optional(),
  depth: z.union([z.literal(1), z.literal(2)]).optional(), levels: z.array(z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)])).min(1).max(5).optional() });
export const GRAPH_INPUT = z.toJSONSchema(GraphInputSchema);
export const GRAPH_QUERY = z.toJSONSchema(GraphQuerySchema);
export function checkGraphInput(input: GraphInput): void { if (!GraphInputSchema.safeParse(input).success) throw new MemoryError('invalid', 'invalid graph artifact'); }
export function checkGraphQuery(input: GraphQuery): void { if (!GraphQuerySchema.safeParse(input).success) throw new MemoryError('invalid', 'invalid graph query'); }
