import { HOSTS } from '../core/domain/config.ts';
import type { RuntimeConfig } from '../core/domain/config.ts';
import type { Ctx } from '../core/domain/memory.ts';
import type { GraphArtifact } from '../core/domain/graph.ts';
import type { PortableProfile, ProfileCapabilities, ProfilePreview } from '../core/domain/profile.ts';
import { PROFILE_LIMITS } from '../core/domain/profile.ts';
import { BosunError } from '../core/errors.ts';
import { choiceChanges, ownProfileCapability, portableIdentifier, profileCapabilities, profileRequirements, sanitizeProfileText } from '../core/profile.ts';
import { checkPortableProfile, profileDocumentSchema, profileExportSchema, profilePreviewSchema } from '../contracts/profile.ts';
import { parseProfileDocument, renderProfileSkill, renderProfileToml } from '../adapters/profiles/portable.ts';

export function createProfileService(options: { config: RuntimeConfig; assertOwner(): void;
  loadReviewedProfile?(id: string, context: Ctx): GraphArtifact; capabilities?: ProfileCapabilities }) {
  function owner(context: Ctx) { if (context.audience !== 'owner') throw new BosunError('unsupported', 'Owner operation required'); options.assertOwner(); }
  function inspect(input: unknown, context: Ctx) {
    owner(context); const parsed = profileDocumentSchema.safeParse(input); if (!parsed.success) throw new BosunError('invalid', 'Invalid profile document');
    const profile = parseProfileDocument(parsed.data); return { profile, reviewOnly: true as const, applies: false as const, importedProvenance: 'unverified' as const };
  }
  return {
    export(input: unknown, context: Ctx) {
      owner(context); const parsed = profileExportSchema.safeParse(input); if (!parsed.success) throw new BosunError('invalid', 'Invalid profile selection');
      const selection = parsed.data; const config = options.config;
      if (new Set(selection.roles).size !== selection.roles.length || new Set(selection.providers).size !== selection.providers.length) throw new BosunError('invalid', 'Duplicate profile selection');
      if (!selection.roles.length && !selection.providers.length && !selection.router && !selection.local && !selection.reviewedProfile) throw new BosunError('invalid', 'Empty profile selection');
      const description = sanitizeProfileText(selection.description.replace(/[<>]/g, '')); let redactedLines = description.redactedLines;
      if (description.text.includes('\n') || !description.text) throw new BosunError('invalid', 'Invalid profile description');
      const profile: PortableProfile = { schemaVersion: 1, kind: 'bosun-portable-profile', name: selection.name, description: description.text, capabilities: [],
        choices: { primaryHost: config.hosts.primary, roles: [], providers: [] } };
      for (const role of [...selection.roles].sort()) {
        if (!Object.hasOwn(config.roles, role)) throw new BosunError('not_found', 'Selected role unavailable');
        for (const host of HOSTS) {
          const binding = config.roles[role][host]; if (!binding || !binding.model && !binding.effort) continue;
          profile.choices.roles.push({ role, host, ...(binding.model ? { model: portableIdentifier(binding.model) } : {}), ...(binding.effort ? { effort: portableIdentifier(binding.effort) } : {}) });
        }
      }
      for (const id of [...selection.providers].sort()) {
        if (!Object.hasOwn(config.providers, id)) throw new BosunError('not_found', 'Selected provider unavailable'); const settings = config.providers[id];
        const native = settings.kind === 'claude-cli' || settings.kind === 'codex-cli';
        profile.choices.providers.push({ id, kind: settings.kind, model: portableIdentifier(settings.model), timeoutMs: settings.timeoutMs,
          ...(native ? {} : { endpoint: 'RECONFIGURE_LOCALLY' as const }), credential: native ? 'NATIVE_AUTH_OUTSIDE_PROFILE' : 'RECONFIGURE_LOCALLY' });
      }
      if (selection.router) profile.choices.router = { model: portableIdentifier(config.router.model), timeoutMs: config.router.timeoutMs,
        minConfidence: config.router.minConfidence, ...(config.router.digest ? { digest: config.router.digest } : {}), endpoint: 'RECONFIGURE_LOCALLY' };
      if (selection.local) profile.choices.local = { model: portableIdentifier(config.local.model), fallback: portableIdentifier(config.local.fallback),
        contextTokens: config.local.contextTokens, maxTurns: config.local.maxTurns, timeoutMs: config.local.timeoutMs };
      if (selection.reviewedProfile) {
        if (!options.loadReviewedProfile) throw new BosunError('unavailable', 'Reviewed profile unavailable');
        // The injected graph facade authorizes fresh source lineage before payload
        // reads. Check classification/lifecycle again before touching instructions.
        const artifact = options.loadReviewedProfile(selection.reviewedProfile.id, context);
        if (artifact.private !== false || artifact.status !== 'active' || artifact.kind !== 'profile' || artifact.level !== 4) throw new BosunError('private_input', 'Reviewed profile withheld');
        if (artifact.projectId !== null && artifact.projectId !== context.projectId || artifact.sessionId !== null && artifact.sessionId !== context.sessionId) throw new BosunError('private_input', 'Reviewed profile scope withheld');
        if (artifact.version !== selection.reviewedProfile.version || artifact.id !== selection.reviewedProfile.id) throw new BosunError('conflict', 'Reviewed profile changed');
        const sanitized = sanitizeProfileText(artifact.text); redactedLines += sanitized.redactedLines;
        if (!sanitized.text || sanitized.text.length > PROFILE_LIMITS.instructions) throw new BosunError('invalid', 'Invalid reviewed instructions');
        profile.reviewed = { origin: 'owner-reviewed-current-L4', instructions: sanitized.text };
      }
      profile.capabilities = profileCapabilities(profile); const checked = checkPortableProfile(profile);
      return { profile: checked, toml: renderProfileToml(checked), skill: renderProfileSkill(checked), sanitization: { redactedLines,
        omitted: ['authentication', 'accounts', 'endpoints', 'commands', 'absolute-paths', 'storage-ownership', 'private-memory', 'source-identifiers'] } };
    },
    inspect,
    preview(input: unknown, context: Ctx): ProfilePreview {
      owner(context); const parsed = profilePreviewSchema.safeParse(input); if (!parsed.success) throw new BosunError('invalid', 'Invalid profile preview');
      const profile = parseProfileDocument(parsed.data); const targetHost = parsed.data.targetHost ?? options.config.hosts.primary;
      const changes = choiceChanges(profile, options.config); const requirements = profileRequirements(profile, options.capabilities ?? {}, parsed.data.format === 'skill');
      // A portable provenance label is a claim from the exporter, not local
      // acceptance or authorization to change the recipient's configuration.
      requirements.push({ capability: 'owner.profile-review', state: 'unverified' });
      if (!requirements.some(requirement => requirement.capability === `host.${targetHost}`)) requirements.push({ capability: `host.${targetHost}`, state: ownProfileCapability(options.capabilities?.features, `host.${targetHost}`) });
      const reconfigure: ProfilePreview['reconfigure'] = [];
      for (const provider of profile.choices.providers) { if (provider.endpoint) reconfigure.push({ target: `providers.${provider.id}.url`, placeholder: provider.endpoint });
        reconfigure.push({ target: `providers.${provider.id}.authentication`, placeholder: provider.credential }); }
      if (profile.choices.router) reconfigure.push({ target: 'router.url', placeholder: profile.choices.router.endpoint });
      const conflicts = changes.filter(change => change.conflict).map(change => change.target);
      if (targetHost !== profile.choices.primaryHost) conflicts.push('targetHost');
      return { schemaVersion: 1, state: requirements.some(requirement => requirement.state !== 'verified') || conflicts.length || reconfigure.length ? 'held' : 'reviewable',
        dryRun: true, applies: false, targetHost, changes, conflicts, requirements, reconfigure,
        skill: { ...renderProfileSkill(profile), operation: 'create-or-review-existing' } };
    },
  };
}
