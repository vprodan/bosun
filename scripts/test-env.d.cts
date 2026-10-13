export const PRELOAD: string;
export const DEFAULT_STUBS: readonly string[];
export const ROOT_KEYS: readonly string[];
export const GIT_REAL: string | undefined;
export function environment(root: string, runRoot: string, extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function cleanupRun(root: string): void;
