import { z } from 'zod';
import { BosunError } from '../core/errors.ts';
import type { ConsolidationRequest } from '../core/domain/consolidation.ts';
const id = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/);
const stamp = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const consolidationSubmitSchema = z.strictObject({ requestId: id });
const scope = z.string().min(1).max(200).refine((v) => !/[\x00-\x1f]/.test(v));
export const consolidationRequestSchema = z.strictObject({ requestId: id, projectId: scope, sessionId: scope.nullable(), cursor: stamp, through: stamp,
  sources: z.array(z.strictObject({ memoryId: id, version: stamp.min(1), hash: z.string().regex(/^[a-f0-9]{32}$/) })).max(8),
  providerId: z.string().min(1).max(40), model: z.string().min(1).max(200) });
export function checkConsolidationRequest(input: unknown): ConsolidationRequest {
  const value = consolidationRequestSchema.safeParse(input); if (!value.success || value.data.through < value.data.cursor) throw new BosunError('invalid', 'Invalid consolidation request');
  return value.data;
}
