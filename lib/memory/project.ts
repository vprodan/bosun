// Project identity: a hash of the normalized git origin URL, so every clone and every worktree of a repo is one project.
// No origin: git's common dir (shared by worktrees). Not a repo: the directory itself.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Cfg } from '../config.ts';
import type { Ctx } from './types.ts';

export type Project = { id: string; name: string };
const hashId = (key: string) => `p_${crypto.createHash('sha256').update(key).digest('hex').slice(0, 16)}`;

// git@github.com:Org/Repo.git, https://user@github.com/org/repo, ssh://git@github.com:22/org/repo → github.com/org/repo
export function normalizeOrigin(url: string): string {
  let u = url.trim().toLowerCase().replace(/\/+$/, '').replace(/\.git$/, '');
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//;
  const scp = scheme.test(u) ? null : u.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/);
  u = scp ? `${scp[1]}/${scp[2]}` : u.replace(scheme, '').replace(/^[^@/]+@/, '').replace(/^([^/:]+):\d+\//, '$1/');
  return u.replace(/\/+/g, '/');
}

// git's common dir for dir, found like git does (walk up to .git; a worktree's .git file points at its gitdir, whose
// commondir file points at the shared one). Read directly: spawning git twice cost the hook ~17 ms of its 30 ms budget.
function commonDir(dir: string): string | null {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    const dotgit = path.join(d, '.git');
    let st: fs.Stats | null = null;
    try { st = fs.statSync(dotgit); } catch { /* keep walking */ }
    if (st) {
      let gitDir = dotgit;
      if (st.isFile()) {
        const m = fs.readFileSync(dotgit, 'utf8').match(/^gitdir:\s*(.+)$/m);
        if (!m) return null;
        gitDir = path.resolve(d, m[1].trim());
      }
      let common = gitDir;
      try { common = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim()); } catch { /* not a worktree */ }
      return common;
    }
    if (path.dirname(d) === d) return null;
  }
}
// remote.origin.url from a git config file: section names are case-insensitive, the subsection "origin" is not.
function originUrl(common: string): string {
  let text = '';
  try { text = fs.readFileSync(path.join(common, 'config'), 'utf8'); } catch { return ''; }
  let inOrigin = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const sec = line.match(/^\[\s*([A-Za-z0-9.-]+)(?:\s+"([^"]*)")?\s*\]/);
    if (sec) { inOrigin = sec[1].toLowerCase() === 'remote' && sec[2] === 'origin'; continue; }
    const kv = inOrigin && line.match(/^url\s*=\s*(.*)$/i);
    if (kv) return kv[1].trim().replace(/^"(.*)"$/, '$1');
  }
  return '';
}

export function project(dir: string): Project {
  const common = commonDir(dir);
  const origin = common ? originUrl(common) : '';
  if (origin) {
    const n = normalizeOrigin(origin);
    return { id: hashId(`origin:${n}`), name: path.basename(n) };
  }
  let base = dir;
  try { base = fs.realpathSync(common ?? dir); } catch { /* keep dir */ }
  const root = path.basename(base) === '.git' ? path.dirname(base) : base;
  return { id: hashId(`path:${base}`), name: path.basename(root).replace(/\.git$/, '') };
}

// The directory whose project we serve: the host's project dir when it tells us, else our cwd.
export const projectDir = (env: NodeJS.ProcessEnv = process.env): string => env.CLAUDE_PROJECT_DIR || process.cwd();

export const makeCtx = (cfg: Cfg, p: Project, sessionId: string | null = null, source?: string): Ctx => ({
  projectId: p.id, sessionId, source,
  linked: (cfg.MEMORY_LINKED_PROJECTS || '').split(',').map((s) => s.trim()).filter(Boolean),
});
