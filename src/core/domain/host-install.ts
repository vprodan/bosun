import type { HostId } from './config.ts';
import { sameNativeMajor } from './host-version.ts';
export const OPENCODE2_VERSION = '2.0.27';

export function hostLaunchPermitted(
  hostId: string,
  nativeVersion: string,
  launch: Readonly<{ args: readonly string[]; env: Readonly<Record<string, string>> }>,
): boolean {
  if (hostId !== 'opencode' || !sameNativeMajor(nativeVersion, OPENCODE2_VERSION)) {
    for (const key in launch.env)
      if (Object.hasOwn(launch.env, key) && launch.env[key].length > 4096) return false;
    return true;
  }
  if (launch.args.length !== 1 || launch.args[0] !== '--standalone') return false;
  let count = 0;
  for (const key in launch.env) {
    if (!Object.hasOwn(launch.env, key)) continue;
    if (key !== 'OPENCODE_CONFIG' && key !== 'OPENCODE_CONFIG_CONTENT' && key !== 'BOSUN_CALLER') return false;
    count++;
  }
  if (count !== 3) return false;
  const file = launch.env.OPENCODE_CONFIG;
  const content = launch.env.OPENCODE_CONFIG_CONTENT;
  if (typeof file !== 'string' || !file.startsWith('/') || file.length > 4096 || /[\x00-\x1f\x7f]/.test(file)
    || typeof content !== 'string' || !content.length || content.length > 131072
    || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(content) || launch.env.BOSUN_CALLER !== 'model') return false;
  try {
    const config: unknown = JSON.parse(content);
    return config !== null && typeof config === 'object' && !Array.isArray(config);
  } catch { return false; }
}
export type HostInstalledFile =
  | Readonly<{ op: 'write'; path: string; hash: string }>
  | Readonly<{ op: 'link'; path: string; target: string }>;
export type HostSkillWorkspace = Readonly<{
  root: string;
  rootDev: number;
  rootIno: number;
  directories: Readonly<{
    path: '.agents' | '.agents/skills';
    create: boolean;
    dev: number | null;
    ino: number | null;
  }>[];
  links: Readonly<{ name: string; target: string; hash: string; create: boolean }>[];
}>;
export type HostInstallReceipt = Readonly<{
  id: string;
  requestId: string;
  hostId: HostId;
  nativeVersion: string;
  planHash: string;
  configHash: string;
  binary: string;
  state: 'applying' | 'ready' | 'undoing' | 'undone' | 'unknown';
  version: number;
  createdAt: number;
  updatedAt: number;
  files: HostInstalledFile[];
  launch: { args: string[]; env: Record<string, string> };
  skillWorkspace?: HostSkillWorkspace;
}>;
