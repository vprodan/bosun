import { BosunError } from '../core/errors.ts';
import { parseRoleDefinition, type RoleDefinition } from '../core/roles.ts';
import { BUILD_VERSION, TEXT_ASSETS } from './generated-assets.ts';

export const version = BUILD_VERSION;
export function asset(name: string): string {
  if (!Object.hasOwn(TEXT_ASSETS, name)) throw new BosunError('not_found', 'Asset not found');
  return TEXT_ASSETS[name];
}
export function roleDefinitions(): RoleDefinition[] {
  return Object.keys(TEXT_ASSETS).filter(name => /^roles\/[a-z][a-z0-9-]*\.md$/.test(name)).sort()
    .map(name => parseRoleDefinition(name.slice(6, -3), asset(name)));
}
export function skillAssets(): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(Object.entries(TEXT_ASSETS).filter(([name]) => name.startsWith('skills/'))));
}
