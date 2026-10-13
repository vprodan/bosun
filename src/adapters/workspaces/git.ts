import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BosunError } from '../../core/errors.ts';
import type { Env } from '../../core/domain/inference.ts';
import type { Workspace } from '../../core/ports/workspace.ts';
import {
  workspaceText,
  workspaceRecord,
  type WorkspaceRecord,
  type WorkspaceInspection,
} from '../../core/domain/workspace.ts';
import { createOfflineGit, gitDirectory as directory } from '../../platform/git.ts';
import { privateDirectory } from '../../platform/private-file.ts';

const hash = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
const oid = (value: string) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const unavailable = () => new BosunError('unavailable', 'Git workspace inspection unavailable');
type Entry = {
  path: string;
  head: string | null;
  branch: string | null;
  locked: boolean;
  prunable: boolean;
  bare: boolean;
};
function entries(raw: string): Entry[] {
  if (!raw.endsWith('\0')) throw unavailable();
  const result: Entry[] = [];
  let entry: Entry | undefined;
  for (const field of raw.split('\0')) {
    if (!field) {
      if (entry) {
        result.push(entry);
        entry = undefined;
      }
      continue;
    }
    if (field.startsWith('worktree ')) {
      if (entry || result.length >= 128) throw unavailable();
      entry = {
        path: field.slice(9),
        head: null,
        branch: null,
        locked: false,
        prunable: false,
        bare: false,
      };
      continue;
    }
    if (!entry) throw unavailable();
    if (field.startsWith('HEAD ') && oid(field.slice(5)) && !entry.head)
      entry.head = field.slice(5);
    else if (field.startsWith('branch ') && !entry.branch) entry.branch = field.slice(7);
    else if (field === 'detached') entry.branch = 'HEAD';
    else if (field === 'bare') entry.bare = true;
    else if (field === 'locked' || field.startsWith('locked ')) entry.locked = true;
    else if (field === 'prunable' || field.startsWith('prunable ')) entry.prunable = true;
    else throw unavailable();
  }
  if (entry) throw unavailable();
  return result;
}

// Only offline Git operations, with no inherited auth/config, hooks, fsmonitor,
// external filters, recursive submodules, force removal or branch deletion.
export function createGitWorkspace(options: {
  root: string;
  env: Env;
  command?: string;
}): Workspace & Required<Pick<Workspace, 'repository' | 'inspect'>> {
  const root = workspaceText(options.root);
  if (!path.isAbsolute(root) || path.resolve(root) !== root) throw unavailable();
  const { run: git, plainCheckout, repository } = createOfflineGit(options);
  async function inspect(
    input: WorkspaceRecord,
    signal?: AbortSignal,
  ): Promise<WorkspaceInspection> {
    const record = workspaceRecord(input);
    if (record.path !== path.join(root, record.id)) throw unavailable();
    const repo = await repository(record.from, undefined, signal);
    if (repo.common !== record.repository || repo.projectId !== record.projectId)
      throw unavailable();
    const listed = await git(record.from, ['worktree', 'list', '--porcelain', '-z'], signal);
    if (listed.code !== 0) throw unavailable();
    const all = entries(listed.text);
    const matches = all.filter((entry) => entry.path === record.path);
    if (matches.length > 1) throw unavailable();
    const entry = matches[0];
    const expected =
      !!entry &&
      !entry.bare &&
      entry.branch === `refs/heads/${record.branch}` &&
      entry.head !== null;
    const exists = fs.existsSync(record.path);
    const absent = {
      state: exists || entry ? ('changed' as const) : ('missing' as const),
      head: null,
      branch: null,
      dirty: true,
      locked: entry?.locked ?? false,
      prunable: entry?.prunable ?? false,
      merged: false,
      revision: hash(JSON.stringify([repo, entry ?? null, exists])),
    };
    if (!expected || !exists) return absent;
    try {
      directory(record.path);
      const marker = path.join(record.path, '.git');
      const stat = fs.lstatSync(marker);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > 4096 ||
        fs.realpathSync(marker) !== marker
      )
        return absent;
    } catch {
      return absent;
    }
    const current = await repository(record.path, undefined, signal);
    if (
      current.common !== record.repository ||
      current.projectId !== record.projectId ||
      current.root !== record.path ||
      current.head !== entry.head
    )
      return absent;
    await plainCheckout(record.path, signal);
    const status = await git(
      record.path,
      [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
        '--ignored=matching',
        '--ignore-submodules=none',
      ],
      signal,
    );
    if (status.code !== 0 || (status.text && !status.text.endsWith('\0'))) throw unavailable();
    const merged = await git(
      record.from,
      ['merge-base', '--is-ancestor', entry.head!, repo.head],
      signal,
    );
    if (merged.code !== 0 && merged.code !== 1) throw unavailable();
    // Re-read both checkout and main revision, plus the worktree lock/identity.
    const after = await repository(record.path, undefined, signal);
    const mainAfter = await repository(record.from, undefined, signal);
    const finalList = await git(record.from, ['worktree', 'list', '--porcelain', '-z'], signal);
    if (
      finalList.code !== 0 ||
      JSON.stringify(entries(finalList.text).find((value) => value.path === record.path)) !==
        JSON.stringify(entry) ||
      after.head !== current.head ||
      after.common !== current.common ||
      after.projectId !== current.projectId ||
      mainAfter.head !== repo.head ||
      mainAfter.common !== repo.common ||
      mainAfter.projectId !== repo.projectId
    )
      throw new BosunError('conflict', 'Workspace changed during inspection');
    await plainCheckout(record.path, signal);
    const finalStatus = await git(
      record.path,
      [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
        '--ignored=matching',
        '--ignore-submodules=none',
      ],
      signal,
    );
    if (finalStatus.code !== 0 || finalStatus.text !== status.text)
      throw new BosunError('conflict', 'Workspace changed during inspection');
    return {
      state: 'present',
      head: entry.head,
      branch: record.branch,
      dirty: !!status.text,
      locked: entry.locked,
      prunable: entry.prunable,
      merged: merged.code === 0,
      revision: hash(JSON.stringify([entry, repo.head, status.text])),
    };
  }
  return {
    id: 'git-worktree',
    caps: {
      pane: 'unsupported',
      status: 'unsupported',
      agentTerminal: 'unsupported',
    },
    async active() {
      return false;
    },
    repository,
    inspect,
    async create(input) {
      if (!/^w_[a-f0-9]{32}$/.test(input.name) || !input.baseBranch || !oid(input.baseBranch))
        throw new BosunError('invalid', 'Invalid managed workspace creation');
      const repo = await repository(input.from, input.baseBranch, input.signal);
      await plainCheckout(repo.root, input.signal);
      privateDirectory(path.dirname(root));
      try {
        fs.mkdirSync(root, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      privateDirectory(root);
      const target = path.join(root, input.name);
      const branch = `bosun/${input.name}`;
      try {
        fs.lstatSync(target);
        throw new BosunError('conflict', 'Workspace destination exists');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const created = await git(
        repo.root,
        ['worktree', 'add', '-b', branch, '--', target, repo.head],
        input.signal,
      );
      if (created.code !== 0)
        throw new BosunError('unavailable', 'Workspace creation receipt unavailable', {
          details: { outcome: 'unknown' },
        });
      const result = await repository(target, undefined, input.signal);
      const listed = await git(repo.root, ['worktree', 'list', '--porcelain', '-z'], input.signal);
      const entry =
        listed.code === 0 ? entries(listed.text).find((value) => value.path === target) : undefined;
      if (
        result.common !== repo.common ||
        result.projectId !== repo.projectId ||
        result.root !== target ||
        result.head !== repo.head ||
        entry?.branch !== `refs/heads/${branch}` ||
        entry.head !== repo.head
      )
        throw unavailable();
      return { id: input.name, path: target, branch };
    },
    async remove() {
      throw new BosunError('unsupported', 'Workspace pruning is preview only');
    },
  };
}
