export const TARGET: string;
export const COMPILE_FLAGS: readonly string[];
export interface DistributionInput {
  path: string;
  bytes: number;
  sha256: string;
}
export interface InputSnapshot {
  version: string;
  inputs: DistributionInput[];
  sourceDigest: string;
  dependenciesDigest: string;
  assetsDigest: string;
}
export interface DistributionReport {
  coverage: "static-artifact";
  version: string;
  target: string;
  binarySha256: string;
  archive: string;
  archiveSha256: string;
  sourceDigest: string;
  runtimeQualification: "unverified";
  inputs: number;
}
export function collectInputs(
  root: string,
  destination?: string,
): InputSnapshot;
export function compilerEnvironment(
  root: string,
  compiler: string,
): Record<string, string>;
export function verifyMachO(binary: Buffer): void;
export function binaryArchive(binary: Buffer): Buffer;
export function buildDistribution(
  options: { root: string; output: string; compiler: string },
  dependencies?: {
    platform?: string;
    arch?: string;
    invoke?: (
      compiler: string,
      args: string[],
      options: {
        cwd: string;
        env: Record<string, string>;
        encoding: string;
        timeout: number;
        maxBuffer: number;
        shell: boolean;
      },
    ) => {
      status: number | null;
      stdout?: string;
      stderr?: string;
      error?: Error & { code?: string };
    };
  },
): DistributionReport;
export function verifyDistribution(
  output: string,
  options?: { root?: string },
): DistributionReport;
export function homebrewFormula(output: string): string;
