import { BosunError } from './errors.ts';

export type RoleAccess = 'read' | 'run' | 'edit' | 'tests';
export type RoleDefinition = { id: string; description: string; access: RoleAccess; instructions: string };
export function parseRoleDefinition(id: string, source: string): RoleDefinition {
  const invalid = () => new BosunError('invalid', 'Invalid role definition');
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(id) || typeof source !== 'string' || source.length > 32768) throw invalid();
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) throw invalid();
  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^(description|access):\s*(.*)$/);
    if (!field || Object.hasOwn(fields, field[1])) throw invalid();
    fields[field[1]] = field[2].trim();
  }
  if (!fields.description || fields.description.length > 1000 || !['read', 'run', 'edit', 'tests'].includes(fields.access) || !match[2].trim()) throw invalid();
  return { id, description: fields.description, access: fields.access as RoleAccess, instructions: match[2].trim() };
}
