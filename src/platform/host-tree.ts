import fs from 'node:fs';
import path from 'node:path';
import { BosunError } from '../core/errors.ts';
import type { FileChange } from '../core/ports/host.ts';
import type { HostInstalledFile } from '../core/domain/host-install.ts';
import { privateDirectory, readPrivateFile } from './private-file.ts';
import { hostHash, HOST_FILES_LIMITS } from './host-files.ts';

export function hostFileReceipts(changes: readonly FileChange[]): HostInstalledFile[] {
  let bytes = 0;
  const paths = new Set<string>();
  const records = changes.map((change) => {
    if (
      paths.has(change.path) ||
      path.isAbsolute(change.path) ||
      change.path.split('/').some((part) => !part || part === '.' || part === '..') ||
      change.path.includes('\\') ||
      /[\x00-\x1f\x7f]/.test(change.path)
    )
      throw new BosunError('invalid', 'Invalid host file path');
    paths.add(change.path);
    if (change.op === 'write') {
      const size = Buffer.byteLength(change.text);
      bytes += size;
      if (size > HOST_FILES_LIMITS.fileBytes)
        throw new BosunError('invalid', 'Host file too large');
      return { op: 'write' as const, path: change.path, hash: hostHash(change.text) };
    }
    if (
      change.op !== 'link' ||
      path.isAbsolute(change.target) ||
      /[\x00-\x1f\x7f]/.test(change.target)
    )
      throw new BosunError('invalid', 'Invalid host file operation');
    const target = path.posix.normalize(
      path.posix.join(path.posix.dirname(change.path), change.target),
    );
    if (target === '..' || target.startsWith('../') || !target.startsWith('shared/skills/'))
      throw new BosunError('invalid', 'Host skill link escapes profile');
    return { op: 'link' as const, path: change.path, target: change.target };
  });
  if (
    !records.length ||
    records.length > HOST_FILES_LIMITS.files ||
    bytes > HOST_FILES_LIMITS.totalBytes
  )
    throw new BosunError('invalid', 'Host profile budget exceeded');
  return records;
}
export function hostTree(
  root: string,
  files: readonly HostInstalledFile[],
): { exists: boolean; complete: boolean; matches: boolean } {
  try {
    fs.lstatSync(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { exists: false, complete: false, matches: true };
    throw error;
  }
  try {
    privateDirectory(root);
    const expected = new Map(files.map((file) => [file.path, file]));
    const directories = new Set<string>();
    const seen = new Set<string>();
    for (const file of files)
      for (
        let current = path.posix.dirname(file.path);
        current !== '.';
        current = path.posix.dirname(current)
      )
        directories.add(current);
    let entries = 0;
    function walk(directory: string, prefix = '') {
      privateDirectory(directory);
      for (const name of fs.readdirSync(directory)) {
        if (++entries > 512) throw new BosunError('invalid', 'Host tree budget exceeded');
        const relative = prefix + name;
        const file = path.join(directory, name);
        const stat = fs.lstatSync(file);
        if (stat.isDirectory()) {
          if (!directories.has(relative))
            throw new BosunError('conflict', 'Unexpected host directory');
          walk(file, relative + '/');
          continue;
        }
        const record = expected.get(relative);
        if (!record) throw new BosunError('conflict', 'Unexpected host file');
        if (record.op === 'write') {
          if (
            !stat.isFile() ||
            stat.nlink !== 1 ||
            hostHash(readPrivateFile(file, HOST_FILES_LIMITS.fileBytes)) !== record.hash
          )
            throw new BosunError('conflict', 'Host file changed');
        } else {
          if (!stat.isSymbolicLink() || fs.readlinkSync(file) !== record.target)
            throw new BosunError('conflict', 'Host link changed');
          const target = path.resolve(path.dirname(file), record.target);
          if (
            !target.startsWith(root + path.sep) ||
            !target.startsWith(path.join(root, 'shared', 'skills') + path.sep)
          )
            throw new BosunError('conflict', 'Host link escapes profile');
        }
        seen.add(relative);
      }
    }
    walk(root);
    return { exists: true, complete: seen.size === files.length, matches: true };
  } catch {
    return { exists: true, complete: false, matches: false };
  }
}
export function syncHostDirectory(directory: string) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
export function makeHostDirectory(directory: string) {
  try {
    fs.lstatSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    privateDirectory(path.dirname(directory));
    fs.mkdirSync(directory, { mode: 0o700 });
    syncHostDirectory(path.dirname(directory));
  }
  privateDirectory(directory);
}
export function writeHostTree(
  root: string,
  changes: readonly FileChange[],
  assertOwner: () => void,
) {
  hostFileReceipts(changes);
  assertOwner();
  fs.mkdirSync(root, { mode: 0o700 });
  syncHostDirectory(path.dirname(root));
  for (const change of changes) {
    assertOwner();
    const target = path.join(root, change.path);
    let directory = root;
    for (const part of path
      .dirname(change.path)
      .split('/')
      .filter((part) => part !== '.')) {
      directory = path.join(directory, part);
      makeHostDirectory(directory);
    }
    if (change.op === 'write') {
      const fd = fs.openSync(target, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, change.text);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } else if (change.op === 'link') fs.symlinkSync(change.target, target);
    else throw new BosunError('invalid', 'Unexpected profile operation');
    syncHostDirectory(path.dirname(target));
  }
  syncHostDirectory(root);
  assertOwner();
}
