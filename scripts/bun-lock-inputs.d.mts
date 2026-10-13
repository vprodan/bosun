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
export type BunRegistryPackage = [
  identity: string,
  registry: string,
  metadata: BunRegistryMetadata,
  integrity: string,
];
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
export function parseBunLock(bytes: Buffer): BunLock;
export function productionPackages(
  lock: BunLock,
  dependencies?: Record<string, string>,
): ProductionPackage[];
