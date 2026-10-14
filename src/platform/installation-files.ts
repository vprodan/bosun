import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BosunError } from '../core/errors.ts';
import type {
  BinaryIdentity,
  InstalledBefore,
  InstallDirectory,
} from '../core/domain/installation.ts';

export const installationHash = (value: string | Uint8Array) =>
  crypto.createHash('sha256').update(value).digest('hex');
export function readInstallationFile(file: string, maxBytes: number) {
  installationDirectory(path.dirname(file));
  const stat = fs.lstatSync(file);
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o7777) !== 0o600 ||
    fs.realpathSync(file) !== file ||
    stat.size > maxBytes ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new BosunError('unavailable', 'Reviewed installation file unavailable');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino) throw 0;
    const data = Buffer.alloc(maxBytes + 1);
    let count = 0;
    while (count < data.length) {
      const n = fs.readSync(fd, data, count, data.length - count, null);
      if (!n) break;
      count += n;
    }
    if (count > maxBytes) throw 0;
    return new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, count));
  } catch {
    throw new BosunError('unavailable', 'Reviewed installation file changed');
  } finally {
    fs.closeSync(fd);
  }
}
export function installationDirectory(directory: string) {
  const stat = fs.lstatSync(directory);
  if (
    !path.isAbsolute(directory) ||
    path.resolve(directory) !== directory ||
    fs.realpathSync(directory) !== directory ||
    !stat.isDirectory() ||
    (stat.mode & 0o022) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new BosunError('unavailable', 'Installation directory unavailable');
  return { dev: stat.dev, ino: stat.ino, mode: stat.mode };
}
export function inspectBinary(file: string): BinaryIdentity {
  if (!path.isAbsolute(file) || path.resolve(file) !== file || /[\x00-\x1f\x7f]/.test(file))
    throw new BosunError('invalid', 'Select an absolute executable');
  const canonical = fs.realpathSync(file),
    stat = fs.lstatSync(canonical);
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o111) === 0 ||
    (stat.mode & 0o6022) !== 0 ||
    stat.size < 1 ||
    stat.size > 268435456 ||
    (process.getuid && stat.uid !== 0 && stat.uid !== process.getuid())
  )
    throw new BosunError('unavailable', 'Installation binary unavailable');
  const fd = fs.openSync(canonical, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW),
    digest = crypto.createHash('sha256'),
    buffer = Buffer.alloc(1048576);
  let bytes = 0;
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino) throw 0;
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      bytes += count;
      if (bytes > 268435456) throw 0;
      digest.update(buffer.subarray(0, count));
    }
    const after = fs.fstatSync(fd);
    if (
      after.size !== stat.size ||
      bytes !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs ||
      fs.realpathSync(file) !== canonical
    )
      throw 0;
    return {
      path: canonical,
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mode: stat.mode,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      hash: digest.digest('hex'),
    };
  } catch {
    throw new BosunError('conflict', 'Installation binary changed');
  } finally {
    fs.closeSync(fd);
  }
}
export function previousBinary(file: string): InstalledBefore | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return null;
    throw error;
  }
  if ((process.getuid && stat.uid !== process.getuid()) || stat.nlink !== 1)
    throw new BosunError('unavailable', 'Existing binary ownership unavailable');
  if (stat.isSymbolicLink())
    return { kind: 'link', target: fs.readlinkSync(file), dev: stat.dev, ino: stat.ino };
  if (!stat.isFile()) throw new BosunError('conflict', 'Existing binary is not a replaceable file');
  return { kind: 'file', identity: inspectBinary(file) };
}
export function planInstallationDirectories(
  userHome: string,
  managed: boolean,
): InstallDirectory[] {
  installationDirectory(userHome);
  const directories = managed
    ? [path.join(userHome, '.local'), path.join(userHome, '.local', 'bin')]
    : [];
  return directories.map((directory) => {
    try {
      return { path: directory, before: installationDirectory(directory) };
    } catch (error) {
      try {
        fs.lstatSync(directory);
      } catch (missing) {
        if ((missing as { code?: string }).code === 'ENOENT')
          return { path: directory, before: null };
      }
      throw error;
    }
  });
}
export function copyInstallationBinary(source: BinaryIdentity, destination: string) {
  const input = fs.openSync(source.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW),
    digest = crypto.createHash('sha256'),
    buffer = Buffer.alloc(1048576);
  let bytes = 0,
    output: number | undefined;
  try {
    output = fs.openSync(destination, 'wx', 0o755);
    const stat = fs.fstatSync(input);
    if (stat.dev !== source.dev || stat.ino !== source.ino) throw 0;
    for (;;) {
      const count = fs.readSync(input, buffer, 0, buffer.length, null);
      if (!count) break;
      bytes += count;
      if (bytes > source.size) throw 0;
      digest.update(buffer.subarray(0, count));
      let written = 0;
      while (written < count)
        written += fs.writeSync(output, buffer, written, count - written, null);
    }
    if (bytes !== source.size || digest.digest('hex') !== source.hash) throw 0;
    fs.fchmodSync(output, 0o755);
    fs.fsyncSync(output);
  } catch {
    throw new BosunError('unavailable', 'Binary copy receipt unavailable', {
      details: { outcome: 'unknown' },
    });
  } finally {
    if (output !== undefined) fs.closeSync(output);
    fs.closeSync(input);
  }
}
export function syncInstallationDirectory(directory: string) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
const xml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
export function installationPlist(input: {
  label: string;
  binary: string;
  runtimeHome: string;
  userHome: string;
  id: string;
  path: string;
  socket: string;
}) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${xml(input.label)}</string>\n<key>ProgramArguments</key><array><string>${xml(input.binary)}</string><string>daemon</string><string>run</string></array>\n<key>WorkingDirectory</key><string>${xml(input.runtimeHome)}</string>\n<key>EnvironmentVariables</key><dict><key>HOME</key><string>${xml(input.userHome)}</string><key>BOSUN_HOME</key><string>${xml(input.runtimeHome)}</string><key>BOSUN_SOCKET</key><string>${xml(input.socket)}</string><key>BOSUN_INSTALLATION_ID</key><string>${xml(input.id)}</string><key>PATH</key><string>${xml(input.path)}</string></dict>\n<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>ExitTimeOut</key><integer>30</integer><key>Umask</key><integer>63</integer>\n</dict></plist>\n`;
}
