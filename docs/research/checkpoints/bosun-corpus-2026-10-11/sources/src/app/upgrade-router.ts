import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BosunError } from '../core/errors.ts';
import { planRouterMigration, type RouterMigrationInput } from '../core/router-migration.ts';
import type { LegacyRouterUpgrade } from '../contracts/upgrade.ts';
import type { Env } from '../core/domain/inference.ts';
import type { UpgradeReceipt } from '../core/domain/upgrade.ts';
import { installationDirectory } from '../platform/installation-files.ts';
import { readPrivateFile } from '../platform/private-file.ts';
import { createLaunchdControl, type LaunchdControl } from '../adapters/services/launchd.ts';
import { installationProcessEnv } from './installation.ts';

const fail = () =>
  new BosunError('unverified', 'Legacy router retirement requires exact reviewed ownership');
const hash = (value: string | Uint8Array) =>
  crypto.createHash('sha256').update(value).digest('hex');
const target = (home: string) =>
  path.join(home, 'Library', 'LaunchAgents', 'com.bosun.router.plist');
function exists(file: string) {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw fail();
  }
}
function homeDirectory(home: string) {
  if (!path.isAbsolute(home) || path.resolve(home) !== home || fs.realpathSync(home) !== home)
    throw fail();
  installationDirectory(home);
  for (const directory of [
    path.join(home, 'Library'),
    path.join(home, 'Library', 'LaunchAgents'),
  ]) {
    if (exists(directory)) installationDirectory(directory);
  }
}
function read(file: string) {
  installationDirectory(path.dirname(file));
  const stat = fs.lstatSync(file);
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    ![0o600, 0o644].includes(stat.mode & 0o7777) ||
    fs.realpathSync(file) !== file ||
    (process.getuid && stat.uid !== process.getuid()) ||
    stat.size > 32768
  )
    throw fail();
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino) throw fail();
    const buffer = Buffer.alloc(32769);
    let bytes = 0;
    while (bytes < buffer.length) {
      const n = fs.readSync(fd, buffer, bytes, buffer.length - bytes, null);
      if (!n) break;
      bytes += n;
    }
    const after = fs.fstatSync(fd);
    if (
      bytes > 32768 ||
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs
    )
      throw fail();
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes));
    return { text, hash: hash(text), dev: stat.dev, ino: stat.ino, mode: stat.mode & 0o7777 };
  } catch {
    throw fail();
  } finally {
    fs.closeSync(fd);
  }
}
// The one template emitted by the supported legacy services.ts. This is a
// closed parser, not an XML engine: no DTD resolution, entities or plutil call.
function argumentsFromPlist(text: string): string[] {
  const clean = text.replace(/>\s+</g, '><').trim();
  if (
    !/^<\?xml version="1\.0" encoding="UTF-8"\?><!DOCTYPE plist PUBLIC "-\/\/Apple\/\/DTD PLIST 1\.0\/\/EN" "http:\/\/www\.apple\.com\/DTDs\/PropertyList-1\.0\.dtd"><plist version="1\.0"><dict>/.test(
      clean,
    ) ||
    !clean.endsWith('</dict></plist>')
  )
    throw fail();
  const match =
    /^<\?xml[^>]+><!DOCTYPE[^>]+><plist version="1\.0"><dict><key>Label<\/key><string>com\.bosun\.router<\/string><key>ProgramArguments<\/key><array>(.*?)<\/array><key>WorkingDirectory<\/key><string>([^<]*)<\/string><key>EnvironmentVariables<\/key><dict><key>PATH<\/key><string>[^<]*<\/string><\/dict><key>RunAtLoad<\/key><true\/><key>KeepAlive<\/key><true\/><key>StandardOutPath<\/key><string>([^<]*)<\/string><key>StandardErrorPath<\/key><string>([^<]*)<\/string><\/dict><\/plist>$/.exec(
      clean,
    );
  if (!match || match[3] !== match[4] || !match[2].endsWith('/kev')) throw fail();
  const pieces = [...match[1].matchAll(/<string>([^<]*)<\/string>/g)];
  if (!pieces.length || pieces.length > 32 || pieces.map((piece) => piece[0]).join('') !== match[1])
    throw fail();
  return pieces.map((piece) => {
    const value = piece[1];
    if (/&(?!amp;|lt;|gt;)/.test(value)) throw fail();
    return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  });
}
export function inspectLegacyRouter(input: {
  userHome: string;
  reviewedAdoptionHash?: string;
  configHash: string;
  legacy: RouterMigrationInput['legacy'];
  router: RouterMigrationInput['target'];
}): LegacyRouterUpgrade {
  homeDirectory(input.userHome);
  const file = target(input.userHome);
  if (!exists(file)) return { state: 'absent', userHome: input.userHome };
  const current = read(file);
  let argv: string[];
  try {
    argv = argumentsFromPlist(current.text);
  } catch {
    argv = ['unsupported-template'];
  }
  const migration = planRouterMigration({
    configHash: input.configHash,
    legacy: input.legacy,
    target: input.router,
    service: {
      state: 'present',
      label: 'com.bosun.router',
      file,
      hash: current.hash,
      argv,
      ownership: null,
      ...(input.reviewedAdoptionHash ? { reviewedAdoptionHash: input.reviewedAdoptionHash } : {}),
    },
  });
  return {
    state: 'present',
    userHome: input.userHome,
    file,
    dev: current.dev,
    ino: current.ino,
    mode: current.mode as 0o600 | 0o644,
    hash: current.hash,
    argv,
    reviewedAdoptionHash: input.reviewedAdoptionHash ?? null,
    reason: migration.reason,
  };
}
export function assertLegacyRouter(plan: LegacyRouterUpgrade, env: Env, requireReview: boolean) {
  if (env.HOME !== plan.userHome) throw fail();
  homeDirectory(plan.userHome);
  const file = target(plan.userHome);
  if (plan.state === 'absent') {
    if (exists(file)) throw fail();
    return;
  }
  if (
    file !== plan.file ||
    (requireReview && (plan.reason !== 'ready' || plan.reviewedAdoptionHash !== plan.hash))
  )
    throw fail();
  const current = read(file);
  if (
    current.dev !== plan.dev ||
    current.ino !== plan.ino ||
    current.hash !== plan.hash ||
    current.mode !== plan.mode ||
    JSON.stringify(argumentsFromPlist(current.text)) !== JSON.stringify(plan.argv)
  )
    throw fail();
}
export async function retireLegacyRouter(input: {
  plan: LegacyRouterUpgrade;
  env: Env;
  backup: string;
  control?: LaunchdControl;
  signal: AbortSignal;
  assertOwner(): void;
  record(value: NonNullable<UpgradeReceipt['legacyRouter']>): void;
}): Promise<void> {
  assertLegacyRouter(input.plan, input.env, true);
  if (input.plan.state === 'absent') return;
  const plan = input.plan,
    current = read(plan.file);
  const record = { file: plan.file, hash: plan.hash, backup: input.backup, adopted: true as const };
  input.record({ ...record, state: 'stopping' }); // Durable original retirement intent precedes backup/native effects.
  const fd = fs.openSync(input.backup, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, current.text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const parent = fs.openSync(path.dirname(input.backup), 'r');
  try {
    fs.fsyncSync(parent);
  } finally {
    fs.closeSync(parent);
  }
  if (hash(readPrivateFile(input.backup, 32768)) !== plan.hash) throw fail();
  input.assertOwner();
  assertLegacyRouter(plan, input.env, true);
  const control =
    input.control ??
    createLaunchdControl({ env: installationProcessEnv(input.env), cwd: plan.userHome });
  const before = await control.observe('com.bosun.router', input.signal);
  input.assertOwner();
  assertLegacyRouter(plan, input.env, true);
  if (before.present) await control.bootout('com.bosun.router', input.signal);
  const after = await control.observe('com.bosun.router', input.signal);
  if (after.present || input.signal.aborted) throw fail();
  input.assertOwner();
  assertLegacyRouter(plan, input.env, true);
  fs.unlinkSync(plan.file);
  const directory = fs.openSync(path.dirname(plan.file), 'r');
  try {
    fs.fsyncSync(directory);
  } finally {
    fs.closeSync(directory);
  }
  input.record({ ...record, state: 'retired' });
}
export function assertRetiredRouter(paths: { backups: string }, receipt: UpgradeReceipt) {
  const record = receipt.legacyRouter;
  if (!record || receipt.state !== 'ready') return;
  if (
    record.state !== 'retired' ||
    record.backup !== path.join(paths.backups, receipt.id + '.router.plist') ||
    exists(record.file) ||
    hash(readPrivateFile(record.backup, 32768)) !== record.hash
  )
    throw fail();
}
