import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BosunError } from '../core/errors.ts';
import type { Ctx } from '../core/domain/memory.ts';

export type Project = { id: string; name: string };
const hashId = (key: string) => `p_${crypto.createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
// Keep the established normalization/hash so clones and worktrees retain memory IDs.
export function normalizeOrigin(url: string): string {
  let value = url.trim().toLowerCase().replace(/\/+$/, '').replace(/\.git$/, '');
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//;
  const scp = scheme.test(value) ? null : value.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/);
  value = scp ? `${scp[1]}/${scp[2]}` : value.replace(scheme, '').replace(/^[^@/]+@/, '').replace(/^([^/:]+):\d+\//, '$1/');
  return value.replace(/\/+/g, '/');
}
function read(file: string): string {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 262144) throw new BosunError('unavailable', 'Project metadata unavailable');
  return fs.readFileSync(file, 'utf8');
}
function commonDir(dir: string): string | null {
  for (let current = dir; ; current = path.dirname(current)) {
    const marker = path.join(current, '.git');
    let stat: fs.Stats | undefined;
    try { stat = fs.statSync(marker); } catch { /* continue to parent */ }
    if (stat) {
      let gitDir = marker;
      if (stat.isFile()) {
        const match = read(marker).match(/^gitdir:\s*(.+)$/m);
        if (!match) throw new BosunError('unavailable', 'Project metadata unavailable');
        gitDir = path.resolve(current, match[1].trim());
      } else if (!stat.isDirectory()) throw new BosunError('unavailable', 'Project metadata unavailable');
      try { return path.resolve(gitDir, read(path.join(gitDir, 'commondir')).trim()); }
      catch (error) { if ((error as { code?: string }).code !== 'ENOENT') throw error; }
      return gitDir;
    }
    if (path.dirname(current) === current) return null;
  }
}
function originUrl(common: string): string {
  let text: string;
  try { text = read(path.join(common, 'config')); }
  catch (error) { if ((error as { code?: string }).code === 'ENOENT') return ''; throw error; }
  let inOrigin = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim(); const section = line.match(/^\[\s*([A-Za-z0-9.-]+)(?:\s+"([^"]*)")?\s*\]/);
    if (section) { inOrigin = section[1].toLowerCase() === 'remote' && section[2] === 'origin'; continue; }
    const field = inOrigin && line.match(/^url\s*=\s*(.*)$/i);
    if (field) return field[1].trim().replace(/^"(.*)"$/, '$1');
  }
  return '';
}
export function project(directory: string): Project {
  try {
    if (!path.isAbsolute(directory) || path.resolve(directory) !== directory || directory.includes('\0') || !fs.statSync(directory).isDirectory()) throw 0;
    const common = commonDir(directory); const origin = common ? originUrl(common) : '';
    if (origin) { const normalized = normalizeOrigin(origin); return { id: hashId(`origin:${normalized}`), name: path.basename(normalized) }; }
    const base = fs.realpathSync(common ?? directory);
    const root = path.basename(base) === '.git' ? path.dirname(base) : base;
    return { id: hashId(`path:${base}`), name: path.basename(root).replace(/\.git$/, '') };
  } catch { throw new BosunError('unavailable', 'Project identity unavailable'); }
}
export function memoryScope(identity: Project, linked: readonly string[], sessionId: string | null = null, source?: string): Ctx {
  if (!/^p_[a-f0-9]{16}$/.test(identity.id) || linked.length > 100 || linked.some(id => !/^p_[a-f0-9]{16}$/.test(id))
    || sessionId !== null && (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200 || sessionId.includes('\0'))) {
    throw new BosunError('invalid', 'Invalid project scope');
  }
  return { projectId: identity.id, sessionId, linked: [...new Set(linked)], ...(source ? { source } : {}) };
}
