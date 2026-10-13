import { z } from 'zod';
import { BosunError } from '../core/errors.ts';
import { requirePublicInput } from '../core/policy.ts';
import { screenPublicText } from '../core/secret-screen.ts';
import { HOSTS } from '../core/domain/config.ts';
import { hostLaunchPermitted } from '../core/domain/host-install.ts';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().regex(/^hp_[a-f0-9]{32}$/);
const relative = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.includes('\\') &&
      !/[\x00-\x1f\x7f]/.test(value) &&
      value.split('/').every((part) => !!part && part !== '.' && part !== '..'),
  );
const absolute = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => value.startsWith('/') && !/[\x00-\x1f\x7f]/.test(value));
const hostLaunchSchema = z.strictObject({
  args: z.array(z.string().max(32768)).max(128),
  env: z.record(z.string(), z.string().max(131072)),
});
const skillWorkspace = z.strictObject({
  root: absolute,
  rootDev: z.number().int().min(0),
  rootIno: z.number().int().min(1),
  directories: z
    .array(
      z.strictObject({
        path: z.enum(['.agents', '.agents/skills']),
        create: z.boolean(),
        dev: z.number().int().min(0).nullable(),
        ino: z.number().int().min(1).nullable(),
      }),
    )
    .length(2),
  links: z
    .array(
      z.strictObject({
        name: z.string().regex(/^bosun-[a-z][a-z0-9-]*$/),
        target: z.string().min(1).max(4096),
        hash: digest,
        create: z.boolean(),
      }),
    )
    .max(32),
});
const file = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('write'), path: relative, text: z.string().max(131072) }),
  z.strictObject({ op: z.literal('link'), path: relative, target: z.string().min(1).max(512) }),
]);
export const hostPlanSchema = z.strictObject({
  schemaVersion: z.literal(1),
  privacy: z.literal('public'),
  id,
  requestId: z.string().min(1).max(200),
  hostId: z.enum(HOSTS),
  nativeVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  runtimeHome: absolute,
  installationId: z.uuid(),
  manifestHash: digest,
  configHash: digest,
  binary: absolute,
  skillWorkspace: skillWorkspace.optional(),
  changes: z.array(file).min(1).max(64),
  launch: hostLaunchSchema,
  planHash: digest,
}).refine((value) => hostLaunchPermitted(value.hostId, value.nativeVersion, value.launch), {
  path: ['launch'], message: 'Invalid host launch',
});
export type HostInstallPlan = z.infer<typeof hostPlanSchema>;
export function hostPlan(value: unknown): HostInstallPlan {
  requirePublicInput(value as { privacy?: unknown });
  const result = hostPlanSchema.safeParse(value);
  if (!result.success) throw new BosunError('invalid', 'Invalid host installation plan');
  screenPublicText(JSON.stringify(result.data));
  return result.data;
}
