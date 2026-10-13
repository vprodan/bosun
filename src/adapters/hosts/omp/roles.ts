import type { HostBundle } from '../../../core/ports/host.ts';
import { BosunError } from '../../../core/errors.ts';
import { nativeRole, rolePolicy } from '../../../platform/host-files.ts';

const THINKING: Record<string, true> = {
  off: true, minimal: true, low: true, medium: true, high: true, xhigh: true, max: true, auto: true,
};
export function ompRoleRef(id: string): string {
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(id))
    throw new BosunError('invalid', 'Invalid OMP role reference');
  return nativeRole(id);
}
export function ompRoleTools(access: HostBundle['roles'][number]['access']): string[] {
  return access === 'read'
    ? ['read', 'glob', 'grep']
    : access === 'run' || access === 'tests'
      ? ['read', 'glob', 'grep', 'bash']
      : ['read', 'glob', 'grep', 'bash', 'edit', 'write'];
}
export function renderOmpRole(bundle: HostBundle, role: HostBundle['roles'][number]): string {
  // OMP's model resolver accepts fuzzy patterns. Only explicit native provider/id
  // selectors or explicit @role references are emitted; no cross-host translation.
  if (role.model !== undefined &&
      !/^(?:@[a-z][a-z0-9_-]*|[a-z][a-z0-9_-]*\/[^\s,*?\[\]@]+)$/.test(role.model))
    throw new BosunError('unsupported', 'OMP roles require an explicit native model selector');
  if (role.effort !== undefined && THINKING[role.effort] !== true)
    throw new BosunError('unsupported', 'Unsupported OMP thinking level');
  return `---\nname: ${ompRoleRef(role.id)}\ndescription: ${JSON.stringify(role.description)}\ntools: ${JSON.stringify(ompRoleTools(role.access))}\nspawns: []\n${role.model === undefined ? '' : `model: ${JSON.stringify([role.model])}\n`}${role.effort === undefined ? '' : `thinkingLevel: ${JSON.stringify(role.effort)}\n`}prewalk: false\nadvisor: false\n---\n\n${rolePolicy(bundle, role.id)}`;
}
