import { BosunError } from './errors.ts';
import { screenPublicText } from './secret-screen.ts';
import type { RuntimeConfig } from './domain/config.ts';
import type { PortableProfile, ProfileCapabilities, ProfileChange } from './domain/profile.ts';
import type { Capability } from './domain/inference.ts';

const privateLocation = /(?:https?:\/\/|file:\/\/|(?:^|[\s(="'`:,[{>])(?:\/[^\s/]|~[^\s/\\]*[/\\]|[A-Za-z]:[/\\]|\\\\))/im;
const account = /(?:\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|\b(?:username|account|login|email|e-mail)\b|\b(?:home|workspace|socket|password|passwd|api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=])/i;
// Text is explicitly selected and reviewed, but source privacy never substitutes
// for export sanitization. Drop entire sensitive lines instead of guessing names.
export function sanitizeProfileText(text: string): { text: string; redactedLines: number } {
  screenPublicText(text); let redactedLines = 0;
  const lines = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n').map(line => {
    if (privateLocation.test(line) || account.test(line) || /\x1b|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(line)) {
      redactedLines++; return '[RECONFIGURE_LOCALLY]';
    }
    return line;
  });
  return { text: lines.join('\n').trim(), redactedLines };
}
export function portableIdentifier(value: string): string {
  screenPublicText(value);
  if (!value || value.length > 200 || !/^[a-zA-Z0-9][a-zA-Z0-9._:+/-]*$/.test(value)
    || value.startsWith('/') || value.includes('..') || value.includes('//') || value.includes(':/') || /^[a-z]:[\\/]/i.test(value)
    || /(?:^|\/)(?:Users|home|tmp|var|private|Volumes|mnt)\//i.test(value)) throw new BosunError('private_input', 'Nonportable model choice withheld');
  return value;
}
export function profileCapabilities(profile: Pick<PortableProfile, 'choices' | 'reviewed'>): PortableProfile['capabilities'] {
  return [...new Set<PortableProfile['capabilities'][number]>(['bosun.profile.1', `host.${profile.choices.primaryHost}`,
    ...profile.choices.roles.map(binding => `host.${binding.host}` as const),
    ...profile.choices.providers.map(provider => `provider.${provider.kind}` as const),
    ...(profile.choices.router ? ['provider.ollama' as const, 'router.systemone' as const] : []),
    ...(profile.choices.local ? ['provider.ollama' as const] : []), ...(profile.reviewed ? ['reviewed-profile.1' as const] : [])])].sort();
}
export function choiceChanges(profile: PortableProfile, config: RuntimeConfig): ProfileChange[] {
  const changes: ProfileChange[] = [];
  const add = (target: string, before: string | number | undefined, after: string | number) => changes.push({ target, before: before ?? null, after,
    operation: before === after ? 'unchanged' : before === undefined ? 'add' : 'replace', conflict: before !== undefined && before !== after });
  add('hosts.primary', config.hosts.primary, profile.choices.primaryHost);
  for (const binding of profile.choices.roles) for (const field of ['model', 'effort'] as const) if (binding[field] !== undefined) {
    add(`roles.${binding.role}.${binding.host}.${field}`, config.roles[binding.role]?.[binding.host]?.[field], binding[field]!);
  }
  for (const provider of profile.choices.providers) for (const field of ['kind', 'model', 'timeoutMs'] as const) add(`providers.${provider.id}.${field}`, config.providers[provider.id]?.[field], provider[field]);
  if (profile.choices.router) for (const field of ['model', 'timeoutMs', 'minConfidence', 'digest'] as const) if (profile.choices.router[field] !== undefined) add(`router.${field}`, config.router[field], profile.choices.router[field]!);
  if (profile.choices.local) for (const field of ['model', 'fallback', 'contextTokens', 'maxTurns', 'timeoutMs'] as const) add(`local.${field}`, config.local[field], profile.choices.local[field]);
  // Existing nonportable values are withheld from previews too.
  for (const change of changes) if (typeof change.before === 'string') {
    try { portableIdentifier(change.before); } catch { change.before = '[WITHHELD_CURRENT_VALUE]'; }
  }
  return changes;
}
export function ownProfileCapability(map: unknown, key: string): Capability {
  // Capability snapshots are optional projections, never authority from an
  // inherited property, an accessor or an unvalidated external status string.
  try {
    if (!map || typeof map !== 'object') return 'unverified';
    const value = Object.getOwnPropertyDescriptor(map, key);
    return value && Object.hasOwn(value, 'value') && ['verified', 'unverified', 'unsupported'].includes(value.value) ? value.value : 'unverified';
  } catch { return 'unverified'; }
}
export function profileRequirements(profile: PortableProfile, capabilities: ProfileCapabilities, skill: boolean) {
  const required: { capability: string; state: 'verified' | 'unverified' | 'unsupported' }[] = profile.capabilities.map(capability => ({ capability,
    state: capability === 'bosun.profile.1' || capability === 'reviewed-profile.1' ? 'verified' : ownProfileCapability(capabilities.features, capability) }));
  if (skill) required.push({ capability: 'agent-skills.1', state: ownProfileCapability(capabilities.features, 'agent-skills.1') });
  const models = [...profile.choices.roles.flatMap(role => role.model ? [role.model] : []), ...profile.choices.providers.map(provider => provider.model),
    ...(profile.choices.router ? [profile.choices.router.model] : []), ...(profile.choices.local ? [profile.choices.local.model, profile.choices.local.fallback] : [])];
  for (const model of [...new Set(models)].sort()) required.push({ capability: `model:${model}`, state: ownProfileCapability(capabilities.models, model) });
  return required;
}
