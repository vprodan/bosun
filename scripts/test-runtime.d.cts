import type { SpawnSyncOptions, SpawnSyncReturns } from 'node:child_process';
export const BUN_TEST_VERSION: '1.4.3';
export interface LaunchOptions extends SpawnSyncOptions {
  guarded?: boolean;
}
export function assertRuntime(): void;
export function createRun(prefix: string): string;
export function writeSandbox(root: string): string;
export function runtimeArgs(args: string[], guarded?: boolean): string[];
export function launch(root: string, args: string[], options: LaunchOptions & { encoding: BufferEncoding }): SpawnSyncReturns<string>;
export function launch(root: string, args: string[], options?: LaunchOptions): SpawnSyncReturns<string | Buffer>;
