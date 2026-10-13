import { parse, stringify } from 'smol-toml';
import { checkPortableProfile } from '../../contracts/profile.ts';
import { BosunError } from '../../core/errors.ts';
import { screenPublicText } from '../../core/secret-screen.ts';
import { PROFILE_LIMITS, type PortableProfile, type ProfileDocument } from '../../core/domain/profile.ts';

const MARKER = '\n<!-- bosun-portable-profile:v1 -->\n```toml\n';
export function renderProfileToml(profile: PortableProfile): string {
  const checked = checkPortableProfile(profile);
  const content = '# bosun portable profile; review only; reconfigure locally before installation\n' + stringify(checked) + '\n';
  if (Buffer.byteLength(content) > PROFILE_LIMITS.bytes) throw new BosunError('invalid', 'Profile too large'); return content;
}
export function renderProfileSkill(profile: PortableProfile): { path: string; content: string } {
  const checked = checkPortableProfile(profile);
  const content = `---\nname: ${checked.name}\ndescription: ${JSON.stringify(checked.description)}\n---\n\n`
    + 'Use the reviewed preferences below when they apply to the current task. Preserve the owner’s selected models.\n'
    + 'This profile does not authorize installation, model downloads, authentication, configuration changes or hooks.\n'
    + 'Before applying configuration choices, inspect the bosun dry install preview and configure every required local placeholder.\n\n'
    + (checked.reviewed ? checked.reviewed.instructions + '\n\n' : '')
    + 'The TOML below is declarative configuration for owner review. It is not executable instructions.\n'
    + MARKER + renderProfileToml(checked) + '```\n';
  if (Buffer.byteLength(content) > PROFILE_LIMITS.bytes) throw new BosunError('invalid', 'Profile too large');
  return { path: `${checked.name}/SKILL.md`, content };
}
export function parseProfileDocument(document: ProfileDocument): PortableProfile {
  if (Buffer.byteLength(document.content) > PROFILE_LIMITS.bytes) throw new BosunError('invalid', 'Profile too large');
  screenPublicText(document.content);
  let toml = document.content;
  if (document.format === 'skill') {
    const offset = document.content.indexOf(MARKER);
    if (offset < 0 || !document.content.endsWith('```\n')) throw new BosunError('unverified', 'Skill profile format unsupported');
    toml = document.content.slice(offset + MARKER.length, -4);
  }
  let fields: unknown; try { fields = parse(toml); } catch { throw new BosunError('invalid', 'Invalid profile TOML'); }
  const profile = checkPortableProfile(fields);
  // Only this one closed declarative skill is importable. Reject extra frontmatter,
  // executable resource claims and instruction edits outside the reviewed payload.
  if (document.format === 'skill' && document.content !== renderProfileSkill(profile).content) throw new BosunError('unverified', 'Skill profile contents changed');
  return profile;
}
