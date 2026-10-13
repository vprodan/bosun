import { z } from 'zod';
import { remoteViewUuid } from '../core/remote-view.ts';
const uuid = z.string().refine(remoteViewUuid);
export const remoteViewAcquire = z.strictObject({
  privacy: z.literal('public'),
  id: uuid,
  clientId: uuid,
});
export const remoteViewRelease = z.strictObject({
  id: uuid,
  clientId: uuid,
});
export const remoteViewRefresh = z.strictObject({
  privacy: z.literal('public'),
  ttlMs: z.number().int().min(1000).max(3600000).default(300000),
});
