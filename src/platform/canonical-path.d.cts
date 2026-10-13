import type { Stats } from 'node:fs';
export type CanonicalPathOperations = Readonly<{
  lstat: (file: string) => Pick<Stats, 'isDirectory' | 'isSymbolicLink'>;
  readlink: (file: string) => string;
}>;
export function realpathWithoutOpen(file: string, operations?: CanonicalPathOperations): string;
