import { z } from 'zod';
import { CATEGORIES } from '../core/domain/memory.ts';

export const memoryAutoStoreSchema = z.strictObject({
  privacy: z.literal('public'),
  requestId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  category: z.enum(CATEGORIES),
  body: z.string().min(1).max(4000),
  title: z.string().min(1).max(200).optional(),
  tags: z
    .array(z.string().regex(/^[a-z0-9-]{1,40}$/))
    .max(12)
    .optional(),
  shared: z.boolean().optional(),
  status: z.enum(['active', 'proposed']).optional(),
  providerId: z.string().min(1).max(100).default('default'),
  allowRemoteApi: z.boolean().default(false),
});
