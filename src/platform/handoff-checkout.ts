import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BosunError } from '../core/errors.ts';
import { project } from './project.ts';

// Bounded read-only checkout inspection; no Git process, hooks, auth, patch,
// index mutation or filesystem repair. A staged blob requires explicit review.
function read(file: string, max: number): string {
  if (fs.realpathSync(file) !== file) throw Error();
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd); if (!stat.isFile() || stat.size > max) throw Error();
    const buffer = Buffer.alloc(max + 1); let count = 0;
    while (count < buffer.length) { const n = fs.readSync(fd, buffer, count, buffer.length - count, null); if (!n) break; count += n; }
    if (count > max) throw Error(); return buffer.subarray(0, count).toString('utf8');
  }
  finally { fs.closeSync(fd); }
}
function metadata(workspace: string): { commit: string; branch: string } {
  let gitDir: string | undefined;
  for (let current = workspace; ; current = path.dirname(current)) {
    const marker = path.join(current, '.git');
    try {
      const stat = fs.lstatSync(marker);
      if (stat.isDirectory() && !stat.isSymbolicLink()) gitDir = marker;
      else if (stat.isFile()) {
        const match = read(marker, 4096).match(/^gitdir: ([^\r\n\0]+)\r?\n?$/); if (!match) throw Error(); gitDir = path.resolve(current, match[1]);
      } else throw Error();
      break;
    } catch (error) { if ((error as { code?: string }).code !== 'ENOENT') throw error; }
    if (path.dirname(current) === current) throw Error();
  }
  if (!gitDir || fs.realpathSync(gitDir) !== gitDir) throw Error();
  const head = read(path.join(gitDir, 'HEAD'), 4096).trim(); const hash = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
  if (hash.test(head)) return { commit: head, branch: 'HEAD' };
  const reference = head.match(/^ref: (refs\/(?:heads|tags)\/[A-Za-z0-9_./-]+)$/)?.[1];
  if (!reference || reference.split('/').some(part => !part || part === '.' || part === '..')) throw Error();
  let common = gitDir;
  try { common = path.resolve(gitDir, read(path.join(gitDir, 'commondir'), 4096).trim()); } catch (error) { if ((error as { code?: string }).code !== 'ENOENT') throw error; }
  if (fs.realpathSync(common) !== common) throw Error();
  let commit: string;
  try { commit = read(path.join(common, reference), 4096).trim(); }
  catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') throw error;
    const packed = read(path.join(common, 'packed-refs'), 1048576);
    commit = packed.split('\n').find(line => line.split(' ')[1] === reference)?.split(' ')[0] ?? '';
  }
  if (!hash.test(commit)) throw Error();
  return { commit, branch: reference.startsWith('refs/heads/') ? reference.slice(11) : reference };
}
export function inspectHandoffCheckout(workspace: string, facts: { repository: { projectId: string; commit: string; branch: string; files: readonly { path: string; state: 'staged' | 'unstaged' | 'untracked'; sha256: string }[] } }) {
  if (project(workspace).id !== facts.repository.projectId) throw new BosunError('conflict', 'Handoff project mismatch');
  let base: 'matches' | 'mismatch' | 'unverified' = 'unverified'; let branch: 'matches' | 'mismatch' | 'unverified' = 'unverified';
  let before: ReturnType<typeof metadata> | undefined;
  try { before = metadata(workspace); base = before.commit === facts.repository.commit ? 'matches' : 'mismatch'; branch = before.branch === facts.repository.branch ? 'matches' : 'mismatch'; } catch { /* manual review */ }
  const root = fs.realpathSync(workspace); let bytes = 0;
  const files = facts.repository.files.map(file => {
    let state: 'matches' | 'mismatch' | 'unavailable' | 'requires-index-validation' = 'unavailable';
    if (file.state === 'staged') return { path: file.path, state: 'requires-index-validation' as const };
    let fd: number | undefined;
    try {
      const target = path.join(root, file.path);
      if (!target.startsWith(root + path.sep) || fs.realpathSync(target) !== target) throw Error();
      fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); const original = fs.fstatSync(fd, { bigint: true });
      if (!original.isFile() || original.size > 1048576n || bytes + Number(original.size) > 16777216) throw Error();
      bytes += Number(original.size); const digest = crypto.createHash('sha256'); const buffer = Buffer.alloc(65536); let count = 0;
      for (;;) { const n = fs.readSync(fd, buffer, 0, buffer.length, null); if (!n) break; count += n; if (count > Number(original.size)) throw Error(); digest.update(buffer.subarray(0, n)); }
      const final = fs.fstatSync(fd, { bigint: true });
      if (count !== Number(original.size) || original.dev !== final.dev || original.ino !== final.ino || original.size !== final.size || original.mtimeNs !== final.mtimeNs || original.ctimeNs !== final.ctimeNs) throw Error();
      state = digest.digest('hex') === file.sha256 ? 'matches' : 'mismatch';
    } catch { state = 'unavailable'; } finally { if (fd !== undefined) fs.closeSync(fd); }
    return { path: file.path, state };
  });
  try { const after = metadata(workspace); if (!before || before.commit !== after.commit || before.branch !== after.branch) base = branch = 'unverified'; }
  catch { base = branch = 'unverified'; }
  return { base, branch, files, dirtyFilesIncluded: false, continuation: 'manual-review-required' as const };
}
