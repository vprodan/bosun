import { z } from 'zod';
export const workspaceCreateSchema = z.strictObject({
  requestId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/),
  base: z.string().min(1).max(200).optional(),
});
export const workspaceIdSchema = z.strictObject({
  id: z.string().regex(/^w_[a-f0-9]{32}$/),
});
