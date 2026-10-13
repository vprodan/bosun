import type { BinaryLike } from "node:crypto";

export const RUNTIME: string;
export const PATCH: string;
export const PATCH_SHA256: string;
export interface NativeArchiveInput {
  readonly name: string;
  readonly filename: string;
  readonly url: string;
  readonly sha256: string;
  readonly integrity?: string;
  readonly prefix: string;
}
export interface NativeToolchainInput {
  readonly path: string;
  readonly realpath: string;
  readonly sha256: string;
}
export interface QualifiedNativeBuild {
  readonly sha256: string;
  readonly patchSha256: string;
  readonly runtime: string;
  readonly toolchain: readonly NativeToolchainInput[];
}
export const INPUTS: readonly NativeArchiveInput[];
export const QUALIFIED_NATIVE_BUILD: QualifiedNativeBuild;
export interface NativeArchiveFiles {
  name: string;
  archiveSha256: string;
  files: Map<string, Buffer>;
}
export type NativeSelectedFiles = [name: string, bytes: Buffer][];
export interface NativeSourceInputs {
  archives: NativeArchiveFiles[];
  patch: string;
  packageFiles: Map<string, Buffer>;
  selected: NativeSelectedFiles;
}
export interface VerifiedNativeBuild {
  bytes: Buffer;
  provenanceBytes: Buffer;
  selected: NativeSelectedFiles;
}
export function sha256(data: BinaryLike): string;
export function assertRuntime(): void;
export function inputsRoot(repo: string): string;
export function inside(parent: string, child: string): boolean;
export function regularBytes(file: string, maximum?: number): Buffer;
export function verifyArchive(
  input: NativeArchiveInput,
  archive: Buffer,
): Map<string, Buffer>;
export function loadInputs(repo: string): NativeSourceInputs;
export function verifyPackage(
  packageDir: string,
  selected: NativeSelectedFiles,
): void;
export function verifyNativeBuild(repo: string): VerifiedNativeBuild;
