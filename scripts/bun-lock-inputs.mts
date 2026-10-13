// Read the authoritative text lock without an install, resolver or registry request.
export interface BunWorkspace {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}
export interface BunRegistryMetadata {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalPeers?: string[];
  bin?: Record<string, string>;
  os?: string[];
  cpu?: string[];
}
export type BunRegistryPackage = [identity: string, registry: string, metadata: BunRegistryMetadata, integrity: string];
export interface BunLock {
  lockfileVersion: 1;
  configVersion: 1;
  workspaces: Record<string, BunWorkspace>;
  patchedDependencies?: Record<string, string>;
  packages: Record<string, BunRegistryPackage>;
}
export interface ProductionPackage {
  name: string;
  version: string;
}
export function parseBunLock(bytes: Buffer): BunLock {
  const source = bytes.toString('utf8');
  // Bun's text lock is JSON with trailing commas. Preserve quoted bytes exactly.
  let json = '';
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      json += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') { quoted = true; json += char; }
    else if (char !== ',' || !/^\s*[}\]]/.test(source.slice(i + 1))) json += char;
  }
  const lock: BunLock = JSON.parse(json) as BunLock;
  if (lock.lockfileVersion !== 1 || lock.configVersion !== 1 || !lock.workspaces?.[''] || !lock.packages)
    throw new Error('Unsupported authoritative Bun lock');
  return lock;
}
export function productionPackages(lock: BunLock, dependencies?: Record<string, string>): ProductionPackage[] {
  const selected = new Set<string>();
  function visit(name: string, optional = false): void {
    if (selected.has(name)) return;
    const tuple = lock.packages[name];
    if (!tuple) {
      if (optional) return;
      throw new Error(`Production dependency absent from authoritative Bun lock: ${name}`);
    }
    if (!Array.isArray(tuple) || tuple.length !== 4 || typeof tuple[0] !== 'string' || typeof tuple[1] !== 'string' || tuple[1] !== '' || !tuple[2] || typeof tuple[2] !== 'object' || !/^sha512-[a-zA-Z0-9+/]+=*$/.test(tuple[3]))
      throw new Error(`Invalid registry package in Bun lock: ${name}`);
    if (!tuple[0].startsWith(`${name}@`) || !tuple[0].slice(name.length + 1))
      throw new Error(`Unsupported nested/aliased Bun lock package: ${name}`);
    selected.add(name);
    const metadata = tuple[2];
    for (const child of Object.keys(metadata.dependencies ?? {})) visit(child);
    for (const child of Object.keys(metadata.optionalDependencies ?? {})) visit(child, true);
    for (const child of Object.keys(metadata.peerDependencies ?? {}))
      visit(child, metadata.optionalPeers?.includes(child) ?? false);
  }
  for (const name of Object.keys(dependencies ?? {})) visit(name);
  return [...selected].sort().map((name) => ({ name, version: lock.packages[name][0].slice(name.length + 1) }));
}
