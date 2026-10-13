// Qualified source binding runtime. Compiled product qualification remains separate.
// No node:sqlite or Node runtime fallback is admitted.
export const NATIVE_SQLITE_RUNTIME = '1.4.3';

export function memorySqliteRuntime(runtime: {
  node: string;
  bun?: string;
  platform: string;
  arch: string;
} = { node: process.versions.node, bun: process.versions.bun, platform: process.platform, arch: process.arch }): boolean {
  if (runtime.bun !== undefined)
    return runtime.bun === NATIVE_SQLITE_RUNTIME && runtime.platform === 'darwin' && runtime.arch === 'arm64';
  return false; // Bun-only product; Node's compatibility version is not admission.
}

// Preserve the patched SQLite branches required by the existing WAL protocol.
// A runtime's advertised/bundled version is not the loaded database version.
export function sqliteWalSafe(version: unknown): boolean {
  if (typeof version !== 'string' || !/^3\.\d+\.\d+$/.test(version)) return false;
  const [, minor, patch] = version.split('.').map(Number);
  return minor > 51 || minor === 51 && patch >= 3 || minor === 50 && patch >= 7 || minor === 44 && patch >= 6;
}
