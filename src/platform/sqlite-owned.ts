import fs from 'node:fs';
import { realpathWithoutOpen } from './canonical-path.cjs';
import path from 'node:path';
import { SqliteDatabase } from './sqlite.ts';
import { BosunError } from '../core/errors.ts';

// Explicit daemon state only; no HOME/config discovery, chmod/adoption or live DB copying.
export function openOwnedSqlite(file: string, { readOnly = false }: { readOnly?: boolean } = {}): SqliteDatabase {
  try {
    if (typeof file !== 'string' || !path.isAbsolute(file) || path.resolve(file) !== file || file.includes('\0')) throw 0;
    const parent = path.dirname(file); const directory = fs.lstatSync(parent);
    if (!directory.isDirectory() || (directory.mode & 0o7777) !== 0o700 || realpathWithoutOpen(parent) !== parent
      || process.getuid && directory.uid !== process.getuid()) throw 0;
    let fd: number | undefined;
    try { fd = fs.openSync(file, 'wx', 0o600); }
    catch (e) { if ((e as { code?: string }).code !== 'EEXIST') throw e; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o600 || realpathWithoutOpen(file) !== file
      || process.getuid && stat.uid !== process.getuid()) throw 0;
    return new SqliteDatabase(file, { readOnly, allowExtension: false, defensive: true });
  } catch { throw new BosunError('unavailable', 'Daemon state unavailable'); }
}
