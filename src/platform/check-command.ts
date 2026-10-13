import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Env } from '../core/domain/inference.ts';
import { BosunError } from '../core/errors.ts';
import {
  CHECK_LIMITS,
  checkExecutable,
  checkRecord,
  type CheckExecutable,
  type CheckRecord,
} from '../core/domain/check.ts';
import { workspaceText } from '../core/domain/workspace.ts';
import { executable } from './process.ts';

const hash = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
export function checkEnvironment(environment: Env): Env {
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'LANG', 'LC_ALL']) {
    const descriptor = Object.getOwnPropertyDescriptor(environment, key);
    if (descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string')
      env[key] = descriptor.value;
  }
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: '/dev/null',
    GIT_CONFIG_KEY_1: 'core.fsmonitor',
    GIT_CONFIG_VALUE_1: 'false',
  });
  return Object.freeze(env);
}
export const checkEnvironmentHash = (env: Env) => hash(JSON.stringify(checkEnvironment(env)));
export function captureCheckExecutable(command: string, environment: Env): CheckExecutable {
  workspaceText(command);
  const found = executable(command, checkEnvironment(environment));
  if (!found) throw new BosunError('unavailable', 'Check executable unavailable');
  const file = fs.realpathSync(found);
  if (/^bunx(?:\.[a-z]+)?$/i.test(path.basename(command)) ||
    /^bunx(?:\.[a-z]+)?$/i.test(path.basename(file)))
    throw new BosunError('unsupported', 'Automatic package runner checks are unsupported');
  if (
    file
      .split(path.sep)
      .some((part) =>
        /^\.(?:ssh|aws|codex|claude|env|npmrc|netrc)$|^(?:credentials|secrets)\.(?:json|ya?ml|toml)$/.test(
          part,
        ),
      )
  )
    throw new BosunError('private_input', 'Check executable withheld');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (
      !before.isFile() ||
      before.size < 1n ||
      before.size > BigInt(CHECK_LIMITS.executableBytes) ||
      !(before.mode & 0o111n)
    )
      throw new BosunError('unavailable', 'Check executable identity unavailable');
    const digest = crypto.createHash('sha256');
    const buffer = Buffer.alloc(65536);
    let bytes = 0;
    for (;;) {
      const n = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!n) break;
      bytes += n;
      if (bytes > Number(before.size)) throw Error();
      digest.update(buffer.subarray(0, n));
    }
    const after = fs.fstatSync(fd, { bigint: true });
    if (
      bytes !== Number(before.size) ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mode !== after.mode ||
      before.ctimeNs !== after.ctimeNs ||
      before.mtimeNs !== after.mtimeNs ||
      fs.realpathSync(found) !== file
    )
      throw Error();
    return checkExecutable({
      path: file,
      sha256: digest.digest('hex'),
      bytes,
      mode: Number(before.mode & 0o7777n),
    });
  } catch (error) {
    if (error instanceof BosunError) throw error;
    throw new BosunError('unavailable', 'Check executable changed');
  } finally {
    fs.closeSync(fd);
  }
}
export function checkCommandHash(
  record: Pick<CheckRecord, 'executable' | 'args' | 'environmentHash' | 'timeoutMs'>,
): string {
  return hash(
    JSON.stringify({
      executable: record.executable,
      args: record.args,
      environmentHash: record.environmentHash,
      timeoutMs: record.timeoutMs,
    }),
  );
}
export function checkRequestHash(input: CheckRecord): string {
  const record = checkRecord(input);
  return hash(
    JSON.stringify({
      id: record.id,
      projectId: record.projectId,
      requestId: record.requestId,
      reviewId: record.reviewId,
      createdAt: record.createdAt,
      root: record.root,
      revision: record.revision,
      commandHash: record.commandHash,
    }),
  );
}
export function assertCheckHash(record: CheckRecord): void {
  if (
    record.commandHash !== checkCommandHash(record) ||
    record.requestHash !== checkRequestHash(record)
  )
    throw new BosunError('unavailable', 'Check evidence integrity unavailable');
}
