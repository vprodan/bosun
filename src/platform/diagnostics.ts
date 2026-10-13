import fs from 'node:fs';
import path from 'node:path';
import { privateDirectory } from './private-file.ts';

export type FileDiagnostic = Readonly<{
  state: 'missing' | 'safe' | 'unsafe';
  kind: 'directory' | 'file' | 'socket';
  bytes: number | null;
}>;
export function diagnoseFile(file: string, kind: FileDiagnostic['kind']): FileDiagnostic {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    return {
      state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unsafe',
      kind,
      bytes: null,
    };
  }
  try {
    if (
      !path.isAbsolute(file) ||
      path.resolve(file) !== file ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw Error();
    if (kind === 'directory') privateDirectory(file);
    else {
      privateDirectory(path.dirname(file));
      if (
        (stat.mode & 0o7777) !== 0o600 ||
        (kind === 'file'
          ? !stat.isFile() || stat.nlink !== 1 || fs.realpathSync(file) !== file
          : !stat.isSocket())
      )
        throw Error();
    }
    return { state: 'safe', kind, bytes: kind === 'file' ? stat.size : null };
  } catch {
    return { state: 'unsafe', kind, bytes: null };
  }
}
export type SqliteDiagnostic = Readonly<{
  state:
    | 'missing'
    | 'unsafe'
    | 'header_invalid'
    | 'header_only'
    | 'wal_present'
    | 'journal_present';
  schema: number | null;
  schemaQualification: 'unverified';
}>;
// No SQLite open, pragma, journal recovery, shared-memory construction or maintenance.
// A journal-backed header is not authoritative about pending schema/data changes.
export function diagnoseSqlite(file: string): SqliteDiagnostic {
  const shape = diagnoseFile(file, 'file');
  const unknown = { schema: null, schemaQualification: 'unverified' as const };
  if (shape.state !== 'safe') return { state: shape.state, ...unknown };
  let fd: number | undefined;
  try {
    const before = fs.lstatSync(file);
    if (before.size < 100) throw Error();
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw Error();
    const header = Buffer.alloc(100);
    if (
      fs.readSync(fd, header, 0, 100, 0) !== 100 ||
      header.subarray(0, 16).toString('ascii') !== 'SQLite format 3\0'
    )
      throw Error();
    const size = header.readUInt16BE(16);
    if (size !== 1 && (size < 512 || size > 32768 || (size & (size - 1)) !== 0)) throw Error();
    if (![1, 2].includes(header[18]) || header[18] !== header[19]) throw Error();
    const after = fs.fstatSync(fd);
    if (
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    )
      throw Error();
    let wal = false;
    let journal = false;
    for (const suffix of ['-wal', '-shm', '-journal']) {
      const sidecar = diagnoseFile(file + suffix, 'file');
      if (sidecar.state === 'unsafe') return { state: 'unsafe', ...unknown };
      if (suffix === '-wal' && sidecar.state === 'safe') wal = true;
      if (suffix === '-journal' && sidecar.state === 'safe') journal = true;
    }
    const named = fs.lstatSync(file);
    if (
      named.dev !== opened.dev ||
      named.ino !== opened.ino ||
      !named.isFile() ||
      named.nlink !== 1 ||
      (named.mode & 0o7777) !== 0o600 ||
      fs.realpathSync(file) !== file
    )
      return { state: 'unsafe', ...unknown };
    if (journal) return { state: 'journal_present', ...unknown };
    return {
      state: wal || header[18] === 2 ? 'wal_present' : 'header_only',
      schema: wal || header[18] === 2 ? null : header.readUInt32BE(60),
      schemaQualification: 'unverified',
    };
  } catch {
    return { state: 'header_invalid', ...unknown };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
