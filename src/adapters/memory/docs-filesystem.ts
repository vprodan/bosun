// Effectful native source helper. Only explicit index composition imports this module.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { DatabaseSync } from 'node:sqlite';
import { docsRelative } from './sqlite-docs.ts';
import { DOCS_MAX_BYTES, DOCS_MAX_FILES, DOCS_MAX_LIST_BYTES, type DocsEnumeration, type DocsFile } from './sqlite-docs-index.ts';

function git(args: string[], maxBuffer: number): Buffer | null {
  try {
    const result = spawnSync('git', args, { maxBuffer, timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
    return result.status === 0 && !result.error && !result.signal && result.stdout.length <= maxBuffer ? result.stdout : null;
  } catch { return null; }
}
export function resolveDocsRoot(dir: string): string | null {
  try {
    const current = fs.realpathSync(dir);
    if (!fs.lstatSync(current).isDirectory()) return null;
    const output = git(['-C', current, 'rev-parse', '--show-toplevel'], 8192);
    if (output === null) return null;
    const reported = new TextDecoder('utf8', { fatal: true }).decode(output).replace(/\n$/, '');
    const root = fs.realpathSync(reported);
    if (root === '/' || !fs.lstatSync(root).isDirectory() || current !== root && !current.startsWith(root + path.sep)) return null;
    return root;
  } catch { return null; }
}
export function enumerateDocs(root: string): DocsEnumeration {
  const held = { complete: false } as const;
  try {
    if (fs.realpathSync(root) !== root || !fs.lstatSync(root).isDirectory()) return held;
    const before = stamp(fs.lstatSync(root, { bigint: true }));
    const output = git(['-C', root, 'ls-files', '-z', '-co', '--exclude-standard', '--', '*.md'], DOCS_MAX_LIST_BYTES);
    if (output === null || output.length && output[output.length - 1] !== 0) return held;
    const text = new TextDecoder('utf8', { fatal: true }).decode(output);
    const files = text ? text.slice(0, -1).split('\0') : [];
    if (files.length > DOCS_MAX_FILES || files.some((relative) => Buffer.byteLength(relative) > 4096
      || !relative.endsWith('.md') || docsRelative(root, root + '/' + relative) !== relative)) return held;
    const valid = (): boolean => { try { return fs.realpathSync(root) === root && stamp(fs.lstatSync(root, { bigint: true })) === before; } catch { return false; } };
    return valid() ? { complete: true, files: [...new Set(files)], valid } : held;
  } catch { return held; }
}
type Probe = { state: 'file' | 'missing' | 'rejected' | 'foreign'; stamp: string; stat?: fs.BigIntStats; root?: string };
const stamp = (stat: fs.BigIntStats): string => [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
function absent(error: unknown): boolean {
  try { return !!error && typeof error === 'object' && Object.getOwnPropertyDescriptor(error, 'code')?.value === 'ENOENT'; }
  catch { return false; }
}
function optionalStat(file: string): fs.BigIntStats | undefined {
  try { return fs.lstatSync(file, { bigint: true }); } catch (error) { if (absent(error)) return undefined; throw error; }
}
// Resolve every ancestor without following symlinks, and inspect .git presence only (never its payload).
function probe(root: string, relative: string): Probe {
  if (docsRelative(root, root + '/' + relative) !== relative || fs.realpathSync(root) !== root) throw Error('source');
  const rootStat = fs.lstatSync(root, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw Error('source');
  const stamps = [stamp(rootStat)]; let current = root; const parts = relative.split('/');
  for (let i = 0; i < parts.length; i++) {
    current += '/' + parts[i];
    const stat = optionalStat(current);
    if (!stat) return { state: 'missing', stamp: stamps.join('|') + '|absent:' + current };
    stamps.push(stamp(stat));
    if (stat.isSymbolicLink()) return { state: 'rejected', stamp: stamps.join('|') };
    if (i < parts.length - 1) {
      if (!stat.isDirectory()) return { state: 'rejected', stamp: stamps.join('|') };
      const dotgit = optionalStat(current + '/.git');
      if (dotgit) return { state: 'foreign', root: current, stamp: stamps.join('|') + '|' + stamp(dotgit) };
    } else {
      return { state: stat.isFile() && stat.nlink === 1n && stat.size <= BigInt(DOCS_MAX_BYTES) ? 'file' : 'rejected',
        stamp: stamps.join('|'), stat };
    }
  }
  throw Error('source');
}
export function inspectDoc(root: string, relative: string, _knownMtime?: number, readBody = true): DocsFile {
  let fd: number | undefined; let opened: fs.BigIntStats | undefined;
  try {
    const before = probe(root, relative);
    const valid = (): boolean => { try { const after = probe(root, relative); return after.state === before.state && after.stamp === before.stamp; } catch { return false; } };
    if (before.state === 'foreign') return { state: 'foreign', root: before.root!, valid };
    if (before.state !== 'file') return { state: before.state, valid };
    const stat = before.stat!; const mtime = Number(stat.mtimeMs); const bytes = Number(stat.size);
    if (!Number.isSafeInteger(mtime) || mtime < 0) return { state: 'held' };
    // A timestamp can survive a content edit. Listed files are read within the
    // finite source budget; the index compares content before deciding to write.
    if (!readBody) return { state: 'file', mtime, bytes, valid };
    fd = fs.openSync(root + '/' + relative, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || stamp(opened) !== stamp(stat) || !valid()) return { state: 'held' };
    const buffer = Buffer.alloc(bytes); let offset = 0;
    while (offset < bytes) {
      const count = fs.readSync(fd, buffer, offset, bytes - offset, offset);
      if (!count) return { state: 'held' }; offset += count;
    }
    if (stamp(fs.fstatSync(fd, { bigint: true })) !== stamp(opened) || !valid()) return { state: 'held' };
    const body = buffer.toString('utf8');
    return { state: 'file', mtime, bytes, title: (body.match(/^#\s+(.+)$/m)?.[1] ?? relative).trim().slice(0, 200), body, valid };
  } catch { return { state: 'held' }; }
  finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {
      // Do not admit data after uncertain cleanup. Retry only a descriptor
      // still bound to the source inode, without promising release on failure.
      if (opened) try {
        const current = fs.fstatSync(fd, { bigint: true });
        if (current.dev === opened.dev && current.ino === opened.ino) fs.closeSync(fd);
      } catch {}
      return { state: 'held' };
    }
  }
}

// Native handle and source path stay callback-local. Never inspect unknown storage artifacts or change modes.
export function checkDocsStorage(db: DatabaseSync, reservedBytes: number): boolean {
  try {
    if (!Number.isSafeInteger(reservedBytes) || reservedBytes < 0) return false;
    const file = db.location(); if (file === null) return true;
    let bytes = 0;
    for (const source of [file, file + '-wal']) {
      const stat = optionalStat(source);
      if (!stat) { if (source === file) return false; continue; }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || fs.realpathSync(source) !== source) return false;
      bytes += Number(stat.size);
    }
    return bytes >= 100 && bytes + reservedBytes <= 64 * 1024 * 1024;
  } catch { return false; }
}
