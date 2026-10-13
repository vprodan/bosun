import { z } from 'zod';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().uuid();
const absolute = z
  .string()
  .min(1)
  .max(4096)
  .refine((s) => s.startsWith('/') && !/[\x00-\x1f\x7f]/.test(s));
export const upgradeEntrySchema = z.strictObject({
  name: z.string().regex(/^[a-zA-Z0-9_.-]{1,200}(?:\/[a-zA-Z0-9_.-]{1,200})?$/),
  kind: z.enum(['file', 'directory']),
  dev: z.number().int().min(0),
  ino: z.number().int().min(1),
  mode: z.number().int().min(0),
  bytes: z.number().int().min(0),
  mtime: z.number().min(0),
  ctime: z.number().min(0),
  hash: hash.nullable(),
});
export const legacyRouterUpgradeSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('absent'), userHome: absolute }),
  z.strictObject({ state: z.literal('present'), userHome: absolute, file: absolute,
    dev: z.number().int().min(0), ino: z.number().int().min(1), mode: z.union([z.literal(0o600), z.literal(0o644)]),
    hash, reviewedAdoptionHash: hash.nullable(), reason: z.enum(['ready', 'service_unowned', 'service_changed', 'service_shape_unknown']),
    argv: z.array(z.string().max(4096)).min(1).max(32) }),
]);
export type LegacyRouterUpgrade = z.infer<typeof legacyRouterUpgradeSchema>;
export const upgradePlanSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^up_[a-f0-9]{32}$/),
  requestId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
  createdAt: z.number().int().min(0),
  home: absolute,
  socket: absolute,
  homeDev: z.number().int().min(0),
  homeIno: z.number().int().min(1),
  homeMode: z.union([z.literal(0o700), z.literal(0o755)]),
  sourceId: uuid,
  installationId: uuid,
  memory: z.enum(['schema-unverified', 'absent']),
  source: z.array(upgradeEntrySchema).min(1).max(1100),
  config: z.string().min(1).max(262144),
  retainedConfigKeys: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).max(100),
  legacyRouter: legacyRouterUpgradeSchema,
  routerUrl: z.string().min(1).max(2048).optional(),
});
export type UpgradePlan = z.infer<typeof upgradePlanSchema>;
export type UpgradeEntry = z.infer<typeof upgradeEntrySchema>;
export type { UpgradeReceipt } from '../core/domain/upgrade.ts';
