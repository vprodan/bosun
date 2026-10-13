import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BosunError } from '../core/errors.ts';
import { screenPublicText } from '../core/secret-screen.ts';
import { sameNativeMajor } from '../core/domain/host-version.ts';
import type { Env, Detect } from '../core/domain/inference.ts';
import type {
  FileChange,
  HostBundle,
  HostSettings,
  Check,
  PromptEvent,
} from '../core/ports/host.ts';
import { executable } from './process.ts';
import { privateDirectory, readPrivateFile } from './private-file.ts';

export const HOST_FILES_LIMITS = Object.freeze({
  files: 64,
  fileBytes: 131072,
  totalBytes: 1048576,
  profiles: 16,
  manifestBytes: 131072,
});
export const hostHash = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
export const nativeRole = (id: string) => `bosun_${id.replaceAll('-', '_')}`;
export function hostSettings(input: HostSettings, versions: readonly string[]): HostSettings {
  if (
    !input ||
    typeof input.root !== 'string' ||
    !path.isAbsolute(input.root) ||
    path.resolve(input.root) !== input.root ||
    /[\x00-\x1f\x7f]/.test(input.root) ||
    !versions.some(version => sameNativeMajor(input.nativeVersion, version))
  )
    throw new BosunError('unsupported', 'Host profile version unavailable');
  screenPublicText(input.root);
  return Object.freeze({ root: input.root, nativeVersion: input.nativeVersion });
}
export function hostBundle(input: HostBundle): HostBundle {
  if (
    !input ||
    !Array.isArray(input.roles) ||
    input.roles.length > 16 ||
    !input.skills ||
    typeof input.skills !== 'object' ||
    Object.keys(input.skills).length > 32 ||
    typeof input.policy !== 'string' ||
    Buffer.byteLength(input.policy) > 32768
  )
    throw new BosunError('invalid', 'Invalid host bundle');
  const roles = input.roles.map((role) => {
    if (
      !/^[a-z][a-z0-9-]{0,39}$/.test(role.id) ||
      typeof role.description !== 'string' ||
      role.description.length > 1000 ||
      typeof role.instructions !== 'string' ||
      Buffer.byteLength(role.instructions) > 32768 ||
      !['read', 'run', 'edit', 'tests'].includes(role.access) ||
      (role.model !== undefined &&
        (typeof role.model !== 'string' ||
          !role.model ||
          role.model.length > 256 ||
          /[\x00-\x20\x7f]/.test(role.model))) ||
      (role.effort !== undefined &&
        (typeof role.effort !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(role.effort)))
    )
      throw new BosunError('invalid', 'Invalid host role');
    return Object.freeze({ ...role });
  });
  if (new Set(roles.map((role) => role.id)).size !== roles.length)
    throw new BosunError('invalid', 'Duplicate host role');
  const skills = Object.fromEntries(
    Object.entries(input.skills).map(([name, text]) => {
      if (
        !/^bosun-[a-z][a-z0-9-]*$/.test(name) ||
        typeof text !== 'string' ||
        Buffer.byteLength(text) > HOST_FILES_LIMITS.fileBytes
      )
        throw new BosunError('invalid', 'Invalid host skill');
      return [name, text];
    }),
  );
  for (const command of [input.mcp, input.hook]) {
    if (
      !command ||
      typeof command.command !== 'string' ||
      !path.isAbsolute(command.command) ||
      !Array.isArray(command.args) ||
      command.args.length > 32 ||
      command.args.some((arg) => typeof arg !== 'string' || arg.includes('\0')) ||
      !command.env ||
      Object.keys(command.env).some((key) => !/^BOSUN_[A-Z_]+$/.test(key)) ||
      Object.values(command.env).some((value) => typeof value !== 'string' || value.includes('\0'))
    )
      throw new BosunError('invalid', 'Invalid host launcher');
  }
  if (
    !Number.isSafeInteger(input.hook.timeoutS) ||
    input.hook.timeoutS < 1 ||
    input.hook.timeoutS > 10
  )
    throw new BosunError('invalid', 'Invalid hook deadline');
  screenPublicText(JSON.stringify(input));
  return Object.freeze({ ...input, roles, skills: Object.freeze(skills) });
}
export function sharedHostFiles(bundle: HostBundle): FileChange[] {
  return [
    { op: 'write', path: 'shared/policy.md', text: bundle.policy },
    ...Object.entries(bundle.skills).map(([name, text]) => ({
      op: 'write' as const,
      path: `shared/skills/${name}/SKILL.md`,
      text,
    })),
  ];
}
export function skillLinks(bundle: HostBundle, prefix = 'skills'): FileChange[] {
  return Object.keys(bundle.skills).map((name) => ({
    op: 'link',
    path: `${prefix}/${name}`,
    target: `${'../'.repeat(prefix.split('/').length)}shared/skills/${name}`,
  }));
}
export function rolePolicy(bundle: HostBundle, id: string): string {
  return `${bundle.policy}\n\n${bundle.roles.find((role) => role.id === id)!.instructions}\n\nDo not spawn additional agents or change your selected model or access. Report uncertain effects to the owner.\n`;
}
export async function installedHost(command: string, env: Env): Promise<Detect> {
  const file = executable(command, env);
  return file
    ? {
        installed: true,
        path: file,
        notes: ['version_unverified', 'profile_activation_requires_native_qualification'],
      }
    : { installed: false };
}
export async function profileDoctor(
  root: string,
  changes: readonly FileChange[],
): Promise<Check[]> {
  return changes.map((change) => {
    let ok = false;
    try {
      const file = path.join(root, change.path);
      privateDirectory(root);
      privateDirectory(path.dirname(file));
      const stat = fs.lstatSync(file);
      ok =
        change.op === 'write'
          ? stat.isFile() &&
            stat.nlink === 1 &&
            (stat.mode & 0o7777) === 0o600 &&
            readPrivateFile(file, HOST_FILES_LIMITS.fileBytes) === change.text
          : change.op === 'link'
            ? stat.isSymbolicLink() && fs.readlinkSync(file) === change.target
            : false;
    } catch {}
    return {
      ok,
      label: change.path,
      ...(!ok ? { fix: 'Inspect the owned host profile; changed files require review.' } : {}),
    };
  });
}
export function removeHostFiles(changes: readonly FileChange[]): FileChange[] {
  return changes.map((change) => ({ op: 'remove', path: change.path }));
}
export function nativePrompt(stdin: string, env: Env): PromptEvent | null {
  // Explicit classification belongs to the prompt, never an ambient "all prompts public" flag.
  try {
    if (Buffer.byteLength(stdin) > 32768) return null;
    const value = JSON.parse(stdin);
    const prompt = value?.prompt;
    if (typeof prompt !== 'string' || value.privacy !== 'public') return null;
    screenPublicText(prompt);
    const cwd = value.cwd ?? env.CLAUDE_PROJECT_DIR;
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null;
    return {
      text: prompt,
      privacy: 'public',
      cwd,
      sessionId: typeof value.session_id === 'string' ? value.session_id : null,
    };
  } catch {
    return null;
  }
}
