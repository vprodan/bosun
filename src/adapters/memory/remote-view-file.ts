import fs from 'node:fs';
import { realpathWithoutOpen } from '../../platform/canonical-path.cjs';
import path from 'node:path';
import { BosunError } from '../../core/errors.ts';

// Fixed private rollback databases only. Reject sidecars before opening; hooks never recover journals.
export function checkRemoteViewFile(file: string): { dev: number; ino: number } {
  try {
    if (!path.isAbsolute(file) || path.resolve(file) !== file || realpathWithoutOpen(file) !== file)
      throw 0;
    const stat = fs.lstatSync(file),
      parent = fs.lstatSync(path.dirname(file));
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o7777) !== 0o600 ||
      stat.size < 512 ||
      stat.size > 4 * 1024 * 1024 ||
      !parent.isDirectory() ||
      (parent.mode & 0o7777) !== 0o700 ||
      realpathWithoutOpen(path.dirname(file)) !== path.dirname(file) ||
      (process.getuid && (stat.uid !== process.getuid() || parent.uid !== process.getuid()))
    )
      throw 0;
    for (const suffix of ['-wal', '-shm', '-journal']) {
      try {
        fs.lstatSync(file + suffix);
      } catch (error) {
        if ((error as { code?: string }).code === 'ENOENT') continue;
        throw error;
      }
      throw 0;
    }
    const fd = fs.openSync(file, 'r'),
      header = Buffer.alloc(100);
    try {
      if (fs.readSync(fd, header, 0, 100, 0) !== 100) throw 0;
    } finally {
      fs.closeSync(fd);
    }
    if (
      header.toString('ascii', 0, 16) !== 'SQLite format 3\0' ||
      header[18] !== 1 ||
      header[19] !== 1
    )
      throw 0;
    return { dev: stat.dev, ino: stat.ino };
  } catch {
    throw new BosunError('unavailable', 'Remote view storage unavailable');
  }
}
