import { z } from 'zod';
export const embeddingIndexRequest = z.strictObject({
  privacy: z.literal('public'),
  requestId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  ids: z.array(z.string().min(1).max(64)).min(1).max(8),
});

export const embeddingSettingsSchema = z.strictObject({
  model: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine((value) => !value.includes('\0')),
  url: z
    .string()
    .max(2048)
    .url()
    .refine((value) => {
      const url = new URL(value);
      return (
        ['http:', 'https:'].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    }),
  dimensions: z.number().int().min(1).max(4096),
  transform: z.enum(['embeddinggemma-v1', 'plain-v1']),
  digest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  timeoutMs: z.number().int().min(1).max(60000),
  keepAlive: z.string().regex(/^(?:0|[1-9][0-9]{0,4}(?:ms|s|m))$/),
  minCosine: z.number().min(0).max(1),
  backend: z.enum(['disabled', 'reference', 'sqlite-vec']),
  queryCacheSize: z.number().int().min(0).max(64),
  queryCacheTtlMs: z.number().int().min(1).max(30000),
});
export const embeddingEvaluationRequest = z.strictObject({
  privacy: z.literal('public'),
  settings: embeddingSettingsSchema.extend({
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    backend: z.literal('reference'),
  }),
});
