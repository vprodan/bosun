import fs from 'node:fs';
import path from 'node:path';
import { BosunError } from '../core/errors.ts';

export function socketPath(file: string): void {
  if (!path.isAbsolute(file) || path.resolve(file) !== file || file.includes('\0') || Buffer.byteLength(file) > 100) throw new BosunError('invalid', 'Invalid local socket path');
  try {
    const parent = path.dirname(file); const stat = fs.lstatSync(parent);
    if (!stat.isDirectory() || fs.realpathSync(parent) !== parent || (stat.mode & 0o7777) !== 0o700
      || process.getuid && stat.uid !== process.getuid()) throw 0;
  } catch { throw new BosunError('unavailable', 'Local socket unavailable'); }
}
export function socketIdentity(file: string): fs.Stats {
  const stat = fs.lstatSync(file);
  if (!stat.isSocket() || (stat.mode & 0o7777) !== 0o600 || process.getuid && stat.uid !== process.getuid()) throw new BosunError('unavailable', 'Local socket unavailable');
  return stat;
}
export async function readBody(stream: AsyncIterable<Buffer | string>, max: number): Promise<string> {
  const parts: Buffer[] = []; let bytes = 0;
  for await (const part of stream) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part); bytes += chunk.length;
    if (bytes > max) throw new BosunError('invalid', 'Request too large'); parts.push(chunk);
  }
  return new TextDecoder('utf8', { fatal: true }).decode(Buffer.concat(parts));
}
