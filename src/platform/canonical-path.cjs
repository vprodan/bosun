// Metadata-only canonicalization. Bun's realpath opens/closes the final inode,
// which releases this process's POSIX SQLite locks even while a transaction lives.
// This leaf is also used before the test guard is installed; no application imports.
const fs = require('node:fs');
const path = require('node:path');
function realpathWithoutOpen(file, operations) {
  const lstat = operations?.lstat ?? fs.lstatSync;
  const readlink = operations?.readlink ?? fs.readlinkSync;
  const absolute = path.isAbsolute(file) ? file : `${process.cwd()}${path.sep}${file}`;
  let parts = absolute.split(path.sep);
  let resolved = path.parse(absolute).root;
  let index = 0;
  let links = 0;
  let directory = true;
  const failure = (code) => Object.assign(new Error(`Canonical path unavailable (${code})`), { code, syscall: 'realpath', path: file });
  while (index < parts.length) {
    const part = parts[index++];
    if (!directory) throw failure('ENOTDIR');
    if (!part || part === '.') continue;
    if (part === '..') { resolved = path.dirname(resolved); continue; }
    const next = path.join(resolved, part);
    const stat = lstat(next);
    if (stat.isSymbolicLink()) {
      if (++links > 40) throw failure('ELOOP');
      const target = readlink(next);
      parts = [...target.split(path.sep), ...parts.slice(index)];
      index = 0;
      if (path.isAbsolute(target)) resolved = path.parse(target).root;
    } else {
      resolved = next;
      directory = stat.isDirectory();
    }
  }
  return resolved;
}
module.exports = { realpathWithoutOpen };
