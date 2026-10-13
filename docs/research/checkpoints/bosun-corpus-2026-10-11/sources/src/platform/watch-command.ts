import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BosunError } from '../core/errors.ts';
import { jobId } from '../core/domain/job.ts';
import { workspaceText } from '../core/domain/workspace.ts';
import type { RuntimePaths } from './paths.ts';

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
// The source Node entry is explicit. Installed/compiled observers require their own qualification.
export function createNodeJobObserver(
  paths: RuntimePaths,
  files: { executable: string; entry: string } = {
    executable: process.execPath,
    entry: fileURLToPath(new URL('../../bin/bosun', import.meta.url)),
  },
) {
  const executable = fs.realpathSync(files.executable);
  const entry = fs.realpathSync(files.entry);
  function identity(file: string, content = false) {
    const stat = fs.lstatSync(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (!content && !(stat.mode & 0o111)) ||
      (content && stat.size > 65536)
    )
      throw new Error('entry');
    return JSON.stringify([
      stat.dev,
      stat.ino,
      stat.mode,
      stat.size,
      stat.mtimeMs,
      content ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null,
    ]);
  }
  const expected = [identity(executable), identity(entry, true)];
  return {
    qualification: 'source-node' as const,
    command(id: string, root: string, session: string | null) {
      try {
        if (
          process.versions.bun ||
          Number(process.versions.node.split('.')[0]) < 24 ||
          process.platform === 'win32' ||
          identity(executable) !== expected[0] ||
          identity(entry, true) !== expected[1]
        )
          throw new Error('identity');
        for (const file of [root, paths.home, paths.socket, executable, entry]) {
          workspaceText(file);
          if (!path.isAbsolute(file) || path.resolve(file) !== file) throw new Error('path');
        }
        if (session !== null) workspaceText(session, 200);
        return `cd ${quote(root)} && /usr/bin/env -u BOSUN_CALLER -u BOSUN_DEPTH ${quote(`BOSUN_HOME=${paths.home}`)} ${quote(`BOSUN_SOCKET=${paths.socket}`)} ${quote(`BOSUN_SESSION_ID=${session ?? ''}`)} ${quote(executable)} ${quote(entry)} job wait ${quote(jobId(id))} --timeout 300000 --progress`;
      } catch {
        throw new BosunError('unavailable', 'Job observer entry unavailable');
      }
    },
  };
}
