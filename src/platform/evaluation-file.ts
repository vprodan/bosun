import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BosunError } from '../core/errors.ts';
import { reviewPath } from '../core/domain/review.ts';

const invalid = () => new BosunError('invalid', 'Evaluation source unavailable');
const fileStamp = (s: fs.BigIntStats) =>
  [s.dev, s.ino, s.mode, s.uid, s.nlink, s.size, s.mtimeNs, s.ctimeNs].join(':');
const directoryStamp = (s: fs.BigIntStats) => [s.dev, s.ino, s.mode, s.uid].join(':');
export function readEvaluationFile(workspace: string, relative: string, sha256?: string) {
  reviewPath(relative);
  if (!relative.endsWith('.json') || fs.realpathSync(workspace) !== workspace) throw invalid();
  const directories = [workspace];
  let parent = workspace;
  for (const part of relative.split('/').slice(0, -1)) {
    parent = path.join(parent, part);
    directories.push(parent);
  }
  const identities = directories.map((dir) => {
    const s = fs.lstatSync(dir, { bigint: true });
    if (!s.isDirectory() || s.isSymbolicLink()) throw invalid();
    return directoryStamp(s);
  });
  const file = path.join(workspace, relative),
    before = fs.lstatSync(file, { bigint: true });
  if (
    !before.isFile() ||
    before.nlink !== 1n ||
    before.size > 262144n ||
    (process.getuid && before.uid !== BigInt(process.getuid()))
  )
    throw invalid();
  const valid = () => {
    try {
      return (
        directories.every(
          (dir, i) => directoryStamp(fs.lstatSync(dir, { bigint: true })) === identities[i],
        ) && fileStamp(fs.lstatSync(file, { bigint: true })) === fileStamp(before)
      );
    } catch {
      return false;
    }
  };
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    if (fileStamp(fs.fstatSync(fd, { bigint: true })) !== fileStamp(before)) throw invalid();
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const n = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!n) throw invalid();
      offset += n;
    }
    if (!valid() || fileStamp(fs.fstatSync(fd, { bigint: true })) !== fileStamp(before))
      throw invalid();
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== undefined && digest !== sha256)
      throw new BosunError('conflict', 'Evaluation source changed');
    const text = new TextDecoder('utf8', { fatal: true }).decode(bytes);
    return { input: JSON.parse(text) as unknown, sha256: digest, valid };
  } catch (error) {
    if (error instanceof BosunError) throw error;
    throw invalid();
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
