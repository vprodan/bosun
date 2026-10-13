import fs from 'node:fs';
import path from 'node:path';
import { BosunError } from '../core/errors.ts';
import type { HostSkillWorkspace } from '../core/domain/host-install.ts';
import { hostHash, HOST_FILES_LIMITS } from './host-files.ts';
import { syncHostDirectory } from './host-tree.ts';

function directory(root: string) {
  const stat = fs.lstatSync(root);
  if (
    !path.isAbsolute(root) ||
    path.resolve(root) !== root ||
    fs.realpathSync(root) !== root ||
    !stat.isDirectory() ||
    (stat.mode & 0o022) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new BosunError('conflict', 'Skill workspace directory unavailable');
  return stat;
}
function skillHash(root: string) {
  const file = path.join(root, 'SKILL.md');
  const stat = fs.lstatSync(file);
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    stat.size > HOST_FILES_LIMITS.fileBytes ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new BosunError('conflict', 'Existing skill requires review');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino)
      throw new BosunError('conflict', 'Skill changed');
    return hostHash(fs.readFileSync(fd, 'utf8'));
  } finally {
    fs.closeSync(fd);
  }
}
export function planWorkspaceSkills(
  root: string,
  profile: string,
  skills: Readonly<Record<string, string>>,
): HostSkillWorkspace {
  const source = directory(root);
  const directories = (['.agents', '.agents/skills'] as const).map((relative) => {
    let stat: fs.Stats | undefined;
    try {
      stat = directory(path.join(root, relative));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return { path: relative, create: !stat, dev: stat?.dev ?? null, ino: stat?.ino ?? null };
  });
  const links = Object.entries(skills).map(([name, text]) => {
    const file = path.join(root, '.agents', 'skills', name);
    const target = path.relative(path.dirname(file), path.join(profile, 'shared', 'skills', name));
    const hash = hostHash(text);
    let exists = false;
    try {
      fs.lstatSync(file);
      exists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (exists) {
      const actual = fs.realpathSync(file);
      if (actual.startsWith(path.dirname(profile) + path.sep))
        throw new BosunError('conflict', 'Project skills belong to an existing managed profile');
      if (skillHash(actual) !== hash)
        throw new BosunError('conflict', 'Existing project skill differs from shipped skill');
    }
    return { name, target, hash, create: !exists };
  });
  return { root, rootDev: source.dev, rootIno: source.ino, directories, links };
}
export function inspectWorkspaceSkills(
  binding: HostSkillWorkspace,
  profile: string,
): { complete: boolean; matches: boolean } {
  try {
    const root = directory(binding.root);
    if (root.dev !== binding.rootDev || root.ino !== binding.rootIno)
      throw new BosunError('conflict', 'Skill workspace changed');
    let complete = true;
    for (const item of binding.directories) {
      try {
        const stat = directory(path.join(binding.root, item.path));
        if (item.dev !== null && (stat.dev !== item.dev || stat.ino !== item.ino))
          throw new BosunError('conflict', 'Skill parent changed');
        if (item.create && item.ino === null)
          throw new BosunError('conflict', 'Skill directory ownership unknown');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !item.create) throw error;
        complete = false;
      }
    }
    for (const item of binding.links) {
      const file = path.join(binding.root, '.agents', 'skills', item.name);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !item.create) throw error;
        complete = false;
        continue;
      }
      if (item.create) {
        if (
          !stat.isSymbolicLink() ||
          fs.readlinkSync(file) !== item.target ||
          path.resolve(path.dirname(file), item.target) !==
            path.join(profile, 'shared', 'skills', item.name)
        )
          throw new BosunError('conflict', 'Installed skill link changed');
      } else if (skillHash(fs.realpathSync(file)) !== item.hash)
        throw new BosunError('conflict', 'Observed skill changed');
    }
    return { complete, matches: true };
  } catch {
    return { complete: false, matches: false };
  }
}
export function installWorkspaceSkills(
  input: HostSkillWorkspace,
  profile: string,
  assertOwner: () => void,
  checkpoint: (binding: HostSkillWorkspace) => void,
): HostSkillWorkspace {
  const root = directory(input.root);
  if (root.dev !== input.rootDev || root.ino !== input.rootIno)
    throw new BosunError('conflict', 'Skill workspace changed');
  let binding = input;
  for (let i = 0; i < binding.directories.length; i++) {
    const item = binding.directories[i];
    assertOwner();
    const target = path.join(binding.root, item.path);
    if (item.create) {
      directory(path.dirname(target));
      fs.mkdirSync(target, { mode: 0o700 });
      syncHostDirectory(path.dirname(target));
      const stat = directory(target);
      const directories = [...binding.directories];
      directories[i] = { ...item, dev: stat.dev, ino: stat.ino };
      binding = { ...binding, directories };
      checkpoint(binding);
    } else {
      const stat = directory(target);
      if (stat.dev !== item.dev || stat.ino !== item.ino)
        throw new BosunError('conflict', 'Skill parent changed');
    }
  }
  for (const item of binding.links) {
    assertOwner();
    const target = path.join(binding.root, '.agents', 'skills', item.name);
    directory(path.dirname(target));
    if (item.create) {
      if (
        path.resolve(path.dirname(target), item.target) !==
        path.join(profile, 'shared', 'skills', item.name)
      )
        throw new BosunError('conflict', 'Skill target changed');
      fs.symlinkSync(item.target, target);
      syncHostDirectory(path.dirname(target));
    } else if (skillHash(fs.realpathSync(target)) !== item.hash)
      throw new BosunError('conflict', 'Existing skill changed');
  }
  return binding;
}
export function undoWorkspaceSkills(
  binding: HostSkillWorkspace,
  profile: string,
  assertOwner: () => void,
) {
  const state = inspectWorkspaceSkills(binding, profile);
  if (!state.matches)
    throw new BosunError('conflict', 'Project skills changed; undo requires review');
  for (const item of binding.links.filter((item) => item.create)) {
    assertOwner();
    const file = path.join(binding.root, '.agents', 'skills', item.name);
    try {
      fs.lstatSync(file);
      fs.unlinkSync(file);
      syncHostDirectory(path.dirname(file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  for (const item of [...binding.directories]
    .reverse()
    .filter((item) => item.create && item.ino !== null)) {
    const file = path.join(binding.root, item.path);
    try {
      const stat = directory(file);
      if (stat.dev !== item.dev || stat.ino !== item.ino)
        throw new BosunError('conflict', 'Skill directory changed');
      if (fs.readdirSync(file).length === 0) {
        assertOwner();
        fs.rmdirSync(file);
        syncHostDirectory(path.dirname(file));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
