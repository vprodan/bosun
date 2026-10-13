import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BosunError } from '../core/errors.ts';

export function privateDirectory(directory: string): void {
  const stat = fs.lstatSync(directory);
  if (
    !path.isAbsolute(directory) ||
    path.resolve(directory) !== directory ||
    fs.realpathSync(directory) !== directory ||
    !stat.isDirectory() ||
    (stat.mode & 0o7777) !== 0o700 ||
    (process.getuid && stat.uid !== process.getuid())
  ) {
    throw new BosunError('unavailable', 'Private directory unavailable');
  }
}
function identity(file: string): fs.Stats {
  privateDirectory(path.dirname(file));
  const stat = fs.lstatSync(file);
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o7777) !== 0o600 ||
    fs.realpathSync(file) !== file ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new BosunError('unavailable', 'Private file unavailable');
  return stat;
}
export function readPrivateFile(file: string, maxBytes: number): string {
  const stat = identity(file);
  if (stat.size > maxBytes) throw new BosunError('invalid', 'Configuration file too large');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino)
      throw new BosunError('unavailable', 'Private file changed');
    const buffer = Buffer.alloc(maxBytes + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const n = fs.readSync(fd, buffer, bytes, buffer.length - bytes, null);
      if (!n) break;
      bytes += n;
    }
    if (bytes > maxBytes) throw new BosunError('invalid', 'Configuration file too large');
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes));
    } catch {
      throw new BosunError('invalid', 'Configuration encoding invalid');
    }
  } finally {
    fs.closeSync(fd);
  }
}
// Administrative writes only; readers never create directories or change permissions.
export function writePrivateFile(file: string, text: string): void {
  privateDirectory(path.dirname(file));
  try {
    identity(file);
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') throw error;
  }
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  let crossedRename = false;
  let fd: number | undefined;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    // A lost native return can follow the actual rename. Entering that boundary
    // is already uncertain; a JS assignment afterward cannot establish rollback.
    crossedRename = true;
    fs.renameSync(temp, file);
    fd = fs.openSync(path.dirname(file), fs.constants.O_RDONLY);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
  } catch {
    if (fd !== undefined)
      try {
        fs.closeSync(fd);
      } catch {}
    if (!crossedRename)
      try {
        fs.unlinkSync(temp);
      } catch {}
    throw new BosunError(
      'unavailable',
      'Configuration write unavailable',
      crossedRename ? { details: { outcome: 'unknown' } } : undefined,
    );
  }
}
