import { z } from 'zod';
import { HOSTS } from '../core/domain/config.ts';
import { OPERATIONS } from '../core/dispatch-policy.ts';
import { handoffFactsSchema } from './handoff.ts';
const id = z.string().regex(/^ms_[a-f0-9]{32}$/);
const request = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const text = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => !/[\x00-\x1f\x7f]/.test(value));
export const managedStartSchema = z.strictObject({
  privacy: z.literal('public'),
  requestId: request,
  hostId: z.enum(HOSTS),
  model: text,
  effort: text.optional(),
  access: z.enum(['read', 'edit']),
  seed: z
    .string()
    .min(1)
    .max(12000)
    .refine((value) => !value.includes('\0')),
  allowUnknownQuota: z.boolean().optional(),
});
export const managedTurnSchema = z.strictObject({
  privacy: z.literal('public'),
  requestId: request,
  id,
  expectedVersion: z.number().int().min(1),
  text: z.string().min(1).max(24000),
  allowUnknownQuota: z.boolean().optional(),
  policy: z
    .strictObject({
      operation: z.enum(OPERATIONS),
      files: z.array(z.string().min(1).max(512)).max(64),
      noDelegation: z.boolean().optional(),
      exactModel: text.optional(),
    })
    .optional(),
});
export const managedGetSchema = z.strictObject({ id });
export const managedCaptureSchema = z.strictObject({
  privacy: z.literal('public'),
  id,
  afterCursor: z.string().max(200).nullable(),
});
export const managedRetireSchema = z.strictObject({ id, expectedVersion: z.number().int().min(1) });
export const managedAuthoritySchema = z.strictObject({
  privacy: z.literal('public'),
  requestId: request,
  id,
  expectedVersion: z.number().int().min(1),
  facts: handoffFactsSchema,
});
export const managedHandoffSchema = z.strictObject({
  privacy: z.literal('public'),
  requestId: request,
  id,
  expectedVersion: z.number().int().min(1),
  automatic: z.boolean(),
  latestTurnId: text.optional(),
  allowUnknownQuota: z.boolean().optional(),
});
export type ManagedStart = z.infer<typeof managedStartSchema>;
export type ManagedTurn = z.infer<typeof managedTurnSchema>;
