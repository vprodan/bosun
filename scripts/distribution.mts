// Build-time tooling only. Never import this file from the product runtime.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { gzipSync, gunzipSync } from "node:zlib";
import { renderAssets } from "./generate-assets.mts";
import { NATIVE_SQLITE_RUNTIME } from "../src/platform/sqlite-runtime.ts";
import { parseBunLock, productionPackages } from "./bun-lock-inputs.mts";
import { INPUTS as NATIVE_INPUTS, PATCH, PATCH_SHA256, RUNTIME, QUALIFIED_NATIVE_BUILD, verifyNativeBuild } from "./sqlite-native-inputs.mts";

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
export interface DistributionBuildOptions {
  root: string;
  output: string;
  compiler: string;
}
export interface CompilerInvocationOptions {
  cwd: string;
  env: Record<string, string>;
  encoding: 'utf8';
  timeout: number;
  maxBuffer: number;
  shell: boolean;
}
export interface CompilerInvocationResult {
  status: number | null;
  stdout?: string;
  stderr?: string;
  error?: Error & { code?: string };
}
export interface DistributionBuildDependencies {
  platform?: string;
  arch?: string;
  invoke?: (compiler: string, args: string[], options: CompilerInvocationOptions) => CompilerInvocationResult;
}
interface DistributionMetadata extends InputSnapshot {
  schema: 1;
  product: 'bosun';
  target: string;
  compiler: { version: string; sha256: string };
  flags: string[];
  binary: { bytes: number; sha256: string };
  developmentDebugger: 'disabled-before-imports';
  runtimeQualification: 'unverified';
}
interface DistributionPackage {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  patchedDependencies?: Record<string, string>;
  engines?: { bun?: string };
}

export const TARGET = "bun-darwin-arm64";
export const COMPILE_FLAGS = Object.freeze([
  "--compile",
  `--target=${TARGET}`,
  "--format=esm",
  "--splitting",
  "--bytecode",
  "--minify",
  "--no-compile-autoload-dotenv",
  "--no-compile-autoload-bunfig",
  "--no-compile-autoload-tsconfig",
  "--no-compile-autoload-package-json",
  // Ink's optional React DevTools path is excluded from the production artifact.
  "--define",
  'process.env.DEV="false"',
  // Ink resolves this optional peer before dead code elimination. The shared
  // compiled entry disables DEV before imports; the debugger branch stays idle.
  "--external",
  "react-devtools-core",
]);
const MAX_BINARY = 256 * 1024 * 1024;
const MAX_INPUTS = 20000;
const MAX_TOTAL = 256 * 1024 * 1024;
const MAX_METADATA = 4 * 1024 * 1024;
const GENERATED = "src/platform/generated-assets.ts";
const ROOT_INPUTS = [
  "package.json",
  "bun.lock",
  "patches/better-sqlite3@13.0.3.patch",
  "scripts/bun-check.sh",
  "scripts/build-sqlite-native.mts",
  "scripts/acquire-sqlite-native.mts",
  "scripts/prepare-sqlite-native.mts",
  "scripts/sqlite-native-inputs.mts",
  "scripts/bun-lock-inputs.mts",
  "tsconfig.json",
  "bin/bosun",
  "policy.md",
  "scripts/build.mts",
  "scripts/distribution.mts",
  "scripts/generate-assets.mts",
  "scripts/verify-distribution.mts",
  "scripts/generate-homebrew.mts",
];
const VERSION =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*)?$/;
const HASH = /^[0-9a-f]{64}$/;
const hash = (bytes: string | Uint8Array): string => crypto.createHash("sha256").update(bytes).digest("hex");
const sorted = (values: string[]): string[] => values.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
function relative(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name.length < 512 &&
    !/[\\\x00-\x1f\x7f]/.test(name) &&
    name.split("/").every((part) => part && part !== "." && part !== "..")
  );
}
function directory(file: string): void {
  const stat = fs.lstatSync(file);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    fs.realpathSync(file) !== file
  )
    throw new Error("A canonical regular directory is required");
}
function read(file: string, maximum: number): Buffer {
  const before = fs.lstatSync(file);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size > maximum ||
    fs.realpathSync(file) !== file
  )
    throw new Error("Invalid or oversized distribution input");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (
      before.dev !== opened.dev ||
      before.ino !== opened.ino ||
      before.size !== opened.size
    )
      throw new Error("Distribution input changed");
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (
      bytes.length > maximum ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error("Distribution input changed");
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}
function object(value: unknown, keys: readonly string[]): void {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    sorted(Object.keys(value)).join("\0") !== sorted([...keys]).join("\0")
  )
    throw new Error("Invalid distribution metadata");
}
function digest(inputs: readonly DistributionInput[]): string {
  return hash(JSON.stringify(inputs));
}
function dependencyMap(value: unknown = {}): string {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length > 256 ||
    Object.values(value).some((version) => typeof version !== "string")
  )
    throw new Error("Invalid package dependencies");
  return JSON.stringify(
    Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}
function summaries(inputs: DistributionInput[]): Pick<InputSnapshot, 'sourceDigest' | 'dependenciesDigest' | 'assetsDigest'> {
  return {
    sourceDigest: digest(inputs),
    dependenciesDigest: digest(
      inputs.filter((input) => input.path.startsWith("node_modules/")),
    ),
    assetsDigest: digest(
      inputs.filter((input) =>
        /^(?:roles\/|skills\/|policy\.md$)/.test(input.path),
      ),
    ),
  };
}

// Freeze exactly the public source and installed locked production dependencies.
// Ambient .env/bunfig, Git state, test files and owner directories never enter the snapshot.
export function collectInputs(root: string, destination?: string): InputSnapshot {
  root = path.resolve(root);
  directory(root);
  if (destination) {
    destination = path.resolve(destination);
    directory(destination);
  }
  const inputs: DistributionInput[] = [];
  let total = 0;
  function add(name: string, bytes: Buffer): void {
    if (
      !relative(name) ||
      inputs.length >= MAX_INPUTS ||
      (total += bytes.length) > MAX_TOTAL
    )
      throw new Error("Distribution inputs exceed bounds");
    inputs.push({ path: name, bytes: bytes.length, sha256: hash(bytes) });
    if (destination) {
      const target = path.join(destination, name);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, bytes, {
        flag: "wx",
        mode: name === "bin/bosun" ? 0o755 : 0o644,
      });
    }
  }
  function walk(name: string, sourceOnly = false, depth = 0): void {
    if (depth > 32) throw new Error("Distribution input tree exceeds bounds");
    const current = path.join(root, name);
    directory(current);
    for (const entry of fs
      .readdirSync(current, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const child = name + "/" + entry.name;
      if (entry.isSymbolicLink())
        throw new Error("Distribution input symlinks are prohibited");
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" && name.startsWith("node_modules/"))
          continue; // Nested packages are copied from exact lock entries below.
        walk(child, sourceOnly, depth + 1);
      } else if (entry.isFile()) {
        if (child === GENERATED) continue; // Always regenerate from the current public assets.
        if (sourceOnly && !/\.(?:tsx?|cjs|d\.cts)$/.test(entry.name))
          throw new Error("Unexpected source input");
        add(child, read(path.join(root, child), 32 * 1024 * 1024));
      } else throw new Error("Unexpected distribution input");
    }
  }
  const packageBytes = read(path.join(root, "package.json"), 131072);
  const lockBytes = read(path.join(root, "bun.lock"), MAX_METADATA);
  const pkg: DistributionPackage = JSON.parse(packageBytes.toString('utf8')) as DistributionPackage;
  const lock = parseBunLock(lockBytes);
  if (pkg.name !== "bosun" || !VERSION.test(pkg.version) || lock.workspaces[""].name !== pkg.name)
    throw new Error("Package/Bun lock identity mismatch");
  const locked = lock.workspaces[""];
  if (dependencyMap(locked.dependencies) !== dependencyMap(pkg.dependencies) ||
      dependencyMap(locked.devDependencies) !== dependencyMap(pkg.devDependencies) ||
      dependencyMap(lock.patchedDependencies) !== dependencyMap(pkg.patchedDependencies))
    throw new Error("Package/Bun lock dependency mismatch");
  if (pkg.dependencies?.["better-sqlite3"] !== "13.0.3" ||
      pkg.patchedDependencies?.["better-sqlite3@13.0.3"] !== PATCH ||
      NATIVE_SQLITE_RUNTIME !== RUNTIME || pkg.engines?.bun !== RUNTIME)
    throw new Error("Native SQLite dependency/patch/runtime pins are not admitted");
  if (lock.packages["better-sqlite3"]?.[0] !== "better-sqlite3@13.0.3" ||
      lock.packages["better-sqlite3"]?.[3] !== NATIVE_INPUTS[0].integrity ||
      lock.packages["node-addon-api"]?.[0] !== "node-addon-api@8.0.0" ||
      lock.packages["node-addon-api"]?.[3] !== NATIVE_INPUTS[1].integrity)
    throw new Error("Native binding/header dependency differs from immutable registry pins");
  const native = verifyNativeBuild(root);
  for (const name of ROOT_INPUTS)
    add(
      name,
      name === "package.json"
        ? packageBytes
        : name === "bun.lock"
          ? lockBytes
          : read(path.join(root, name), MAX_METADATA),
    );
  walk("src", true);
  walk("roles");
  walk("skills");
  const assets = renderAssets(root);
  if (
    assets.version !== pkg.version ||
    Object.entries(assets.assets).some(
      ([name, text]) =>
        inputs.find((input) => input.path === name)?.sha256 !==
        hash(Buffer.from(text)),
    )
  )
    throw new Error("Build assets changed during snapshot");
  add(GENERATED, Buffer.from(assets.content));
  // Include only the reviewed input archives, never unrelated tooling/owner state.
  for (const input of NATIVE_INPUTS)
    add(`.omp/tooling/sqlite-native-13.0.3/${input.filename}`,
      read(path.join(root, ".omp/tooling/sqlite-native-13.0.3", input.filename), 32 * 1024 * 1024));
  for (const entry of productionPackages(lock, pkg.dependencies)) {
    const name = `node_modules/${entry.name}`;
    if (!relative(name) || !/^node_modules\/(?:@[^/]+\/)?[^/]+$/.test(name))
      throw new Error("Invalid locked production package");
    const installed: { name: string; version: string } = JSON.parse(read(path.join(root, name, "package.json"), 131072).toString('utf8')) as { name: string; version: string };
    if (installed.name !== entry.name || installed.version !== entry.version)
      throw new Error("Installed production package differs from Bun lock");
    if (entry.name === "better-sqlite3") {
      for (const [file, bytes] of native.selected) add(`${name}/${file}`, bytes);
      add(`${name}/build/Release/bosun_sqlite.node`, native.bytes);
      add(`${name}/build/Release/bosun_sqlite.provenance.json`, native.provenanceBytes);
    } else walk(name);
  }
  inputs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (new Set(inputs.map((input) => input.path)).size !== inputs.length)
    throw new Error("Duplicate distribution input");
  return { version: pkg.version, inputs, ...summaries(inputs) };
}

export function compilerEnvironment(root: string, compiler: string): Record<string, string> {
  const env: Record<string, string> = {
    PATH: `${path.dirname(compiler)}:/usr/bin:/bin`,
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
  };
  for (const [key, name] of Object.entries({
    HOME: "home",
    XDG_CONFIG_HOME: "config",
    XDG_DATA_HOME: "data",
    XDG_STATE_HOME: "state",
    XDG_CACHE_HOME: "cache",
    TMPDIR: "tmp",
  })) {
    env[key] = path.join(root, name);
    fs.mkdirSync(env[key], { mode: 0o700 });
  }
  env.TMP = env.TEMP = env.TMPDIR;
  env.BUN_INSTALL_CACHE_DIR = env.XDG_CACHE_HOME;
  env.BUN_RUNTIME_TRANSPILER_CACHE_PATH = path.join(
    env.XDG_CACHE_HOME,
    "transpiler",
  );
  return env;
}

export function verifyMachO(binary: Buffer): void {
  if (
    binary.length < 32 ||
    binary.length > MAX_BINARY ||
    binary.readUInt32LE(0) !== 0xfeedfacf ||
    binary.readUInt32LE(4) !== 0x0100000c ||
    binary.readUInt32LE(12) !== 2
  )
    throw new Error("Expected one macOS arm64 Mach-O executable");
  const count = binary.readUInt32LE(16),
    size = binary.readUInt32LE(20);
  if (
    !count ||
    count > 4096 ||
    size > 16 * 1024 * 1024 ||
    32 + size > binary.length
  )
    throw new Error("Invalid Mach-O load commands");
  let cursor = 32;
  for (let index = 0; index < count; index++) {
    if (cursor + 8 > 32 + size) throw new Error("Invalid Mach-O load commands");
    const commandSize = binary.readUInt32LE(cursor + 4);
    if (commandSize < 8 || commandSize % 8 || cursor + commandSize > 32 + size)
      throw new Error("Invalid Mach-O load commands");
    cursor += commandSize;
  }
  if (cursor !== 32 + size) throw new Error("Invalid Mach-O load commands");
}

// Fixed one-file ustar: no shell/tar process, paths, links, timestamps or owner IDs.
export function binaryArchive(binary: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write("bosun", 0);
  const octal = (value: number, offset: number, length: number): number =>
    header.write(
      value.toString(8).padStart(length - 1, "0") + "\0",
      offset,
      length,
      "ascii",
    );
  octal(0o755, 100, 8);
  octal(0, 108, 8);
  octal(0, 116, 8);
  octal(binary.length, 124, 12);
  octal(0, 136, 12);
  header.fill(0x20, 148, 156);
  header.write("0", 156);
  header.write("ustar\0", 257);
  header.write("00", 263);
  const checksum = header.reduce((sum, value) => sum + value, 0);
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return Buffer.concat([
    header,
    binary,
    Buffer.alloc(((512 - (binary.length % 512)) % 512) + 1024),
  ]);
}
const archiveName = (version: string): string => `bosun-${version}-darwin-arm64.tar.gz`;

export function buildDistribution(
  { root, output, compiler }: DistributionBuildOptions,
  dependencies: DistributionBuildDependencies = {},
): DistributionReport {
  if (
    (dependencies.platform ?? process.platform) !== "darwin" ||
    (dependencies.arch ?? process.arch) !== "arm64"
  )
    throw new Error(
      "Build requires native macOS arm64; cross-target downloads are prohibited",
    );
  output = path.resolve(output);
  directory(path.dirname(output));
  if (fs.existsSync(output))
    throw new Error(
      "Build output already exists; choose a new absent directory",
    );
  if (!path.isAbsolute(compiler))
    throw new Error("An explicit already installed Bun executable is required");
  compiler = fs.realpathSync(compiler);
  const compilerBytes = read(compiler, MAX_BINARY);
  if (!(fs.statSync(compiler).mode & 0o111))
    throw new Error("Bun compiler is not executable");
  const temp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "bosun-build-")),
  );
  let outputCreated = false;
  try {
    const env = compilerEnvironment(temp, compiler);
    const work = path.join(temp, "source");
    fs.mkdirSync(work, { mode: 0o700 });
    const snapshot = collectInputs(root, work);
    const invoke: NonNullable<DistributionBuildDependencies['invoke']> = dependencies.invoke ?? spawnSync;
    const options: CompilerInvocationOptions = {
      cwd: work,
      env,
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 4 * 1024 * 1024,
      shell: false,
    };
    const versionResult = invoke(compiler, ["--version"], options);
    const bunVersion = versionResult.stdout?.trim();
    if (
      versionResult.error ||
      versionResult.status !== 0 ||
      !VERSION.test(bunVersion ?? "")
    )
      throw new Error("Installed Bun version is unavailable");
    if (bunVersion !== NATIVE_SQLITE_RUNTIME)
      throw new Error("Installed Bun version is outside the pinned native-library runtime");
    const binaryFile = path.join(temp, "bosun");
    const args = [
      "--no-install",
      "build",
      "src/app/entry.ts",
      ...COMPILE_FLAGS,
      "--outfile",
      binaryFile,
    ];
    const result = invoke(compiler, args, options);
    if (result.error || result.status !== 0) {
      if (typeof result.stderr === "string")
        process.stderr.write(result.stderr.slice(0, 32768));
      throw new Error(
        `Bun compilation failed (${result.status ?? result.error?.code ?? "unknown"})`,
      );
    }
    const binary = read(binaryFile, MAX_BINARY);
    verifyMachO(binary);
    if (hash(read(compiler, MAX_BINARY)) !== hash(compilerBytes))
      throw new Error("Compiler changed during build");
    const metadata: DistributionMetadata = {
      schema: 1,
      product: "bosun",
      target: TARGET,
      compiler: { version: bunVersion, sha256: hash(compilerBytes) },
      flags: [...COMPILE_FLAGS],
      ...snapshot,
      binary: { bytes: binary.length, sha256: hash(binary) },
      developmentDebugger: "disabled-before-imports",
      runtimeQualification: "unverified",
    };
    const metadataBytes = Buffer.from(JSON.stringify(metadata, null, 2) + "\n");
    if (metadataBytes.length > MAX_METADATA)
      throw new Error("Distribution metadata exceeds bounds");
    const archive = gzipSync(binaryArchive(binary), { level: 9 });
    archive[9] = 255;
    const files: Record<string, Buffer> = {
      bosun: binary,
      "build.json": metadataBytes,
      [archiveName(snapshot.version)]: archive,
    };
    fs.mkdirSync(output, { mode: 0o755 });
    outputCreated = true;
    for (const name of sorted(Object.keys(files)))
      fs.writeFileSync(path.join(output, name), files[name], {
        flag: "wx",
        mode: name === "bosun" ? 0o755 : 0o644,
      });
    fs.writeFileSync(
      path.join(output, "SHA256SUMS"),
      sorted(Object.keys(files))
        .map((name) => `${hash(files[name])}  ${name}\n`)
        .join(""),
      { flag: "wx", mode: 0o644 },
    );
    return verifyDistribution(output);
  } catch (error) {
    if (outputCreated) fs.rmSync(output, { recursive: true });
    throw error;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

export function verifyDistribution(output: string, { root }: { root?: string } = {}): DistributionReport {
  output = path.resolve(output);
  directory(output);
  const metadataBytes = read(path.join(output, "build.json"), MAX_METADATA);
  const metadata: DistributionMetadata = JSON.parse(metadataBytes.toString('utf8')) as DistributionMetadata;
  object(metadata, [
    "schema",
    "product",
    "version",
    "target",
    "compiler",
    "flags",
    "inputs",
    "sourceDigest",
    "dependenciesDigest",
    "assetsDigest",
    "binary",
    "developmentDebugger",
    "runtimeQualification",
  ]);
  object(metadata.compiler, ["version", "sha256"]);
  object(metadata.binary, ["bytes", "sha256"]);
  if (
    metadata.schema !== 1 ||
    metadata.product !== "bosun" ||
    !VERSION.test(metadata.version) ||
    metadata.target !== TARGET ||
    metadata.developmentDebugger !== "disabled-before-imports" ||
    metadata.runtimeQualification !== "unverified" ||
    metadata.compiler.version !== NATIVE_SQLITE_RUNTIME ||
    !HASH.test(metadata.compiler.sha256) ||
    JSON.stringify(metadata.flags) !== JSON.stringify(COMPILE_FLAGS) ||
    !Array.isArray(metadata.inputs) ||
    !metadata.inputs.length ||
    metadata.inputs.length > MAX_INPUTS
  )
    throw new Error("Invalid distribution metadata");
  let prior = "",
    total = 0;
  for (const input of metadata.inputs) {
    object(input, ["path", "bytes", "sha256"]);
    if (
      !relative(input.path) ||
      input.path <= prior ||
      !Number.isSafeInteger(input.bytes) ||
      input.bytes < 0 ||
      input.bytes > 32 * 1024 * 1024 ||
      !HASH.test(input.sha256) ||
      (total += input.bytes) > MAX_TOTAL
    )
      throw new Error("Invalid distribution input inventory");
    prior = input.path;
  }
  for (const [name, value] of Object.entries(summaries(metadata.inputs)))
    if (metadata[name as keyof Pick<InputSnapshot, 'sourceDigest' | 'dependenciesDigest' | 'assetsDigest'>] !== value)
      throw new Error("Distribution input inventory checksum mismatch");
  if (
    !ROOT_INPUTS.every((name) =>
      metadata.inputs.some((input) => input.path === name),
    ) ||
    !metadata.inputs.some((input) => input.path === GENERATED) ||
    !metadata.inputs.some((input) => input.path === "src/app/entry.ts")
  )
    throw new Error("Incomplete distribution input inventory");
  if (!QUALIFIED_NATIVE_BUILD || QUALIFIED_NATIVE_BUILD.patchSha256 !== PATCH_SHA256 ||
      QUALIFIED_NATIVE_BUILD.runtime !== NATIVE_SQLITE_RUNTIME ||
      !metadata.inputs.some((input) => input.path === PATCH && input.sha256 === PATCH_SHA256) ||
      !NATIVE_INPUTS.every((pin) => metadata.inputs.some((input) => input.path === `.omp/tooling/sqlite-native-13.0.3/${pin.filename}` && input.sha256 === pin.sha256)) ||
      !metadata.inputs.some((input) => input.path === "node_modules/better-sqlite3/build/Release/bosun_sqlite.node" && input.sha256 === QUALIFIED_NATIVE_BUILD.sha256) ||
      !metadata.inputs.some((input) => input.path === "node_modules/better-sqlite3/build/Release/bosun_sqlite.provenance.json"))
    throw new Error("Incomplete pinned native SQLite inventory");
  const names = sorted(["bosun", "build.json", archiveName(metadata.version)]);
  if (
    sorted(fs.readdirSync(output)).join("\0") !==
    sorted([...names, "SHA256SUMS"]).join("\0")
  )
    throw new Error("Unexpected distribution files");
  const files = Object.fromEntries(
    names.map((name) => [
      name,
      read(
        path.join(output, name),
        name === "build.json" ? MAX_METADATA : MAX_BINARY,
      ),
    ]),
  );
  const sums = read(path.join(output, "SHA256SUMS"), 1024).toString("utf8");
  if (sums !== names.map((name) => `${hash(files[name])}  ${name}\n`).join(""))
    throw new Error("Distribution checksum mismatch");
  const binary = files.bosun;
  if (
    metadata.binary.bytes !== binary.length ||
    metadata.binary.sha256 !== hash(binary)
  )
    throw new Error("Binary metadata checksum mismatch");
  if ((fs.statSync(path.join(output, "bosun")).mode & 0o777) !== 0o755)
    throw new Error("Distribution executable mode differs");
  verifyMachO(binary);
  const unpacked = gunzipSync(files[archiveName(metadata.version)], {
    maxOutputLength: MAX_BINARY + 2048,
  });
  if (!unpacked.equals(binaryArchive(binary)))
    throw new Error("Distribution archive framing/content mismatch");
  if (root) {
    const current = collectInputs(root);
    if (
      current.version !== metadata.version ||
      current.sourceDigest !== metadata.sourceDigest
    )
      throw new Error(
        "Distribution source/dependencies/assets differ from checkout",
      );
  }
  return {
    coverage: "static-artifact",
    version: metadata.version,
    target: TARGET,
    binarySha256: metadata.binary.sha256,
    archive: archiveName(metadata.version),
    archiveSha256: hash(files[archiveName(metadata.version)]),
    sourceDigest: metadata.sourceDigest,
    runtimeQualification: "unverified",
    inputs: metadata.inputs.length,
  };
}

export function homebrewFormula(output: string): string {
  const report = verifyDistribution(output);
  return `# Review candidate only: compiled runtime qualification and publication remain pending.\n# Expected release location; generation does not assert this URL is published.\nclass Bosun < Formula\n  desc "OpenCode-first agent orchestration with Codex, Claude Code and shared memory"\n  homepage "https://github.com/vprodan/bosun"\n  url "https://github.com/vprodan/bosun/releases/download/v${report.version}/${report.archive}"\n  version "${report.version}"\n  sha256 "${report.archiveSha256}"\n\n  depends_on :macos\n  depends_on arch: :arm64\n\n  def install\n    bin.install "bosun"\n  end\n\n  test do\n    assert_match version.to_s, shell_output("#{bin}/bosun --version")\n  end\nend\n`;
}
