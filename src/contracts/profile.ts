import { z } from 'zod';
import { HOSTS } from '../core/domain/config.ts';
import { PROFILE_CAPABILITIES, PROFILE_LIMITS, type PortableProfile } from '../core/domain/profile.ts';
import { BosunError } from '../core/errors.ts';
import { portableIdentifier, profileCapabilities, sanitizeProfileText } from '../core/profile.ts';
import { screenPublicText } from '../core/secret-screen.ts';

const key = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/).refine(value => !['constructor', 'prototype', '__proto__'].includes(value));
const name = z.string().min(1).max(63).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const choice = z.string().min(1).max(200);
const number = (min: number, max: number) => z.number().int().min(min).max(max);
const provider = z.strictObject({ id: key, kind: z.enum(['ollama', 'openai-compatible', 'claude-cli', 'codex-cli']), model: choice,
  timeoutMs: number(1, 300000), endpoint: z.literal('RECONFIGURE_LOCALLY').optional(), credential: z.enum(['RECONFIGURE_LOCALLY', 'NATIVE_AUTH_OUTSIDE_PROFILE']) });
export const portableProfileSchema = z.strictObject({ schemaVersion: z.literal(1), kind: z.literal('bosun-portable-profile'), name,
  description: z.string().min(1).max(512).refine(value => !/[<>\r\n]/.test(value)),
  capabilities: z.array(z.enum(PROFILE_CAPABILITIES)).min(1).max(PROFILE_CAPABILITIES.length),
  choices: z.strictObject({ primaryHost: z.enum(HOSTS),
    roles: z.array(z.strictObject({ role: key, host: z.enum(HOSTS), model: choice.optional(), effort: choice.optional() })).max(PROFILE_LIMITS.roles * HOSTS.length),
    providers: z.array(provider).max(PROFILE_LIMITS.providers),
    router: z.strictObject({ model: choice, timeoutMs: number(1, 30000), minConfidence: z.number().min(0).max(1),
      digest: z.string().regex(/^(?:sha256:)?[a-f0-9]{64}$/).optional(), endpoint: z.literal('RECONFIGURE_LOCALLY') }).optional(),
    local: z.strictObject({ model: choice, fallback: choice, contextTokens: number(1024, 1048576), maxTurns: number(1, 100), timeoutMs: number(1000, 86400000) }).optional() }),
  reviewed: z.strictObject({ origin: z.literal('owner-reviewed-current-L4'), instructions: z.string().min(1).max(PROFILE_LIMITS.instructions) }).optional(),
});
export const profileExportSchema = z.strictObject({ name, description: z.string().min(1).max(512), roles: z.array(key).max(PROFILE_LIMITS.roles),
  providers: z.array(key).max(PROFILE_LIMITS.providers), router: z.boolean().optional(), local: z.boolean().optional(),
  reviewedProfile: z.strictObject({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), version: number(1, Number.MAX_SAFE_INTEGER) }).optional() });
export const profileDocumentSchema = z.strictObject({ format: z.enum(['toml', 'skill']), content: z.string().min(1).max(PROFILE_LIMITS.bytes) });
export const profilePreviewSchema = profileDocumentSchema.extend({ targetHost: z.enum(HOSTS).optional() });

export function checkPortableProfile(input: unknown): PortableProfile {
  if (input && typeof input === 'object' && (input as { schemaVersion?: unknown }).schemaVersion !== 1) throw new BosunError('unverified', 'Profile schema unsupported');
  const capabilities = input && typeof input === 'object' ? (input as { capabilities?: unknown }).capabilities : undefined;
  if (Array.isArray(capabilities) && capabilities.some(capability => !PROFILE_CAPABILITIES.includes(capability))) throw new BosunError('unverified', 'Profile capabilities unsupported');
  const parsed = portableProfileSchema.safeParse(input); if (!parsed.success) throw new BosunError('invalid', 'Invalid portable profile');
  const value = parsed.data;
  screenPublicText(JSON.stringify(value));
  if (value.capabilities.join('|') !== profileCapabilities(value).join('|')) throw new BosunError('unverified', 'Profile capabilities unsupported');
  if (new Set(value.choices.roles.map(role => `${role.role}:${role.host}`)).size !== value.choices.roles.length
    || new Set(value.choices.providers.map(provider => provider.id)).size !== value.choices.providers.length) throw new BosunError('invalid', 'Duplicate profile choices');
  for (const binding of value.choices.roles) { if (!binding.model && !binding.effort) throw new BosunError('invalid', 'Empty profile binding'); if (binding.model) portableIdentifier(binding.model); if (binding.effort) portableIdentifier(binding.effort); }
  for (const settings of value.choices.providers) {
    portableIdentifier(settings.model); const native = settings.kind === 'codex-cli' || settings.kind === 'claude-cli';
    if (native ? settings.endpoint !== undefined || settings.credential !== 'NATIVE_AUTH_OUTSIDE_PROFILE'
      : settings.endpoint !== 'RECONFIGURE_LOCALLY' || settings.credential !== 'RECONFIGURE_LOCALLY') throw new BosunError('invalid', 'Invalid profile reconfiguration');
  }
  if (value.choices.router) portableIdentifier(value.choices.router.model);
  if (value.choices.local) { portableIdentifier(value.choices.local.model); portableIdentifier(value.choices.local.fallback); }
  for (const text of [value.description, ...(value.reviewed ? [value.reviewed.instructions] : [])]) if (sanitizeProfileText(text).text !== text) throw new BosunError('private_input', 'Nonportable profile text withheld');
  if (value.reviewed && /<!--|^[ \t]*(?:`{3,}|~{3,})/m.test(value.reviewed.instructions)) throw new BosunError('invalid', 'Unsupported reviewed instruction formatting');
  return value;
}
