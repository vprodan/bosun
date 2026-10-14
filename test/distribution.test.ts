import "./bootstrap.ts";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { sandbox, bosun, REPO } from "./helpers.ts";
import {
  buildDistribution,
  collectInputs,
  verifyDistribution,
  verifyMachO,
  homebrewFormula,
  binaryArchive,
} from "../scripts/distribution.mts";
import { parseBunLock, productionPackages } from "../scripts/bun-lock-inputs.mts";
import {
  INPUTS as NATIVE_INPUTS,
  PATCH,
  RUNTIME,
  verifyNativeBuild,
  NATIVE_OUTPUT_PATH,
  NATIVE_PROVENANCE_PATH,
  NATIVE_QUALIFICATION_PATH,
  NATIVE_QUALIFICATION_INPUTS,
  qualificationVerifierInputs,
  nativeQualificationHost,
  parseNativeProvenance,
  validateNativeQualification,
} from "../scripts/sqlite-native-inputs.mts";

import type { NativeQualificationReceipt } from "../scripts/sqlite-native-inputs.mts";
interface StaticDistributionFixture {
  root: string;
  output: string;
  compiler: string;
  build(): unknown;
}
const hash = (value: Buffer) =>
  crypto.createHash("sha256").update(value).digest("hex");
function machO() {
  const bytes = Buffer.alloc(128);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(0x0100000c, 4);
  bytes.writeUInt32LE(2, 12);
  bytes.writeUInt32LE(2, 16);
  bytes.writeUInt32LE(96, 20);
  bytes.writeUInt32LE(0x19, 32);
  bytes.writeUInt32LE(72, 36);
  bytes.writeUInt32LE(0x80000028, 104);
  bytes.writeUInt32LE(24, 108);
  return bytes;
}
function fixture() {
  const sb = sandbox();
  const root = path.join(sb.root, "public-source"),
    output = path.join(sb.root, "candidate");
  const write = (name: string, value: string | Buffer) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value);
  };
  fs.mkdirSync(root);
  const copy = (name: string) =>
    write(name, fs.readFileSync(path.join(REPO, name)));
  // Copy only public reviewed inputs. Never copy the tooling tree, owner state,
  // stock prebuilds or a synthetic native provenance record.
  const native = verifyNativeBuild(REPO);
  for (const name of ["package.json", "bun.lock", PATCH])
    copy(name);
  for (const input of NATIVE_INPUTS)
    copy(`.omp/tooling/sqlite-native-13.0.3/${input.filename}`);
  if (native.qualificationBytes) write(NATIVE_QUALIFICATION_PATH, native.qualificationBytes);
  const lock = parseBunLock(fs.readFileSync(path.join(root, "bun.lock")));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  function copyPackage(name: string) {
    const directory = path.join(REPO, name);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const child = `${name}/${entry.name}`;
      if (entry.isDirectory()) copyPackage(child);
      else if (entry.isFile()) copy(child);
      else throw new Error(`Nonregular public package fixture input: ${child}`);
    }
  }
  for (const entry of productionPackages(lock, pkg.dependencies)) {
    const name = `node_modules/${entry.name}`;
    if (entry.name === "better-sqlite3") {
      for (const [file, bytes] of native.selected) write(`${name}/${file}`, bytes);
      write(`${name}/LICENSE`, native.licenseBytes);
      write(`${name}/build/Release/bosun_sqlite.node`, native.bytes);
      write(`${name}/build/Release/bosun_sqlite.provenance.json`, native.provenanceBytes);
    } else copyPackage(name);
  }
  for (const name of [
    "tsconfig.json",
    "bin/bosun",
    "policy.md",
    "scripts/build.mts",
    "scripts/distribution.mts",
    "scripts/generate-assets.mts",
    "scripts/verify-distribution.mts",
    "scripts/generate-homebrew.mts",
  ])
    copy(name);
  for (const name of [
    "scripts/bun-check.sh",
    "scripts/build-sqlite-native.mts",
    "scripts/acquire-sqlite-native.mts",
    "scripts/prepare-sqlite-native.mts",
    "scripts/sqlite-native-inputs.mts",
    "scripts/bun-lock-inputs.mts",
    "src/platform/canonical-path.cjs",
    "src/platform/canonical-path.d.cts",
  ])
    copy(name);
  for (const name of NATIVE_QUALIFICATION_INPUTS)
    if (!fs.existsSync(path.join(root, name))) copy(name);
  write(
    "src/app/entry.ts",
    fs.readFileSync(path.join(REPO, "src/app/entry.ts"), "utf8"),
  );
  write("src/app/cli.ts", "export const main = () => 0;");
  write(
    "src/platform/generated-assets.ts",
    "stale generated source retained in checkout",
  );
  write("roles/worker.md", "public role");
  write("skills/worker/SKILL.md", "public skill");
  write(".env", "AMBIENT_SECRET=never copied");
  write(".omp/tooling/sqlite-native-13.0.3/acquisition.json", "unreviewed tooling receipt");
  write(".omp/tooling/sqlite-native-13.0.3/builds/owner.txt", "not a public build input");
  write("bunfig.toml", 'preload = ["owner-file"]');
  // Hosted evidence binds the real pinned runtime's bytes even when this
  // compilation adapter emits only synthetic framing and executes no compiler.
  const compiler = native.qualificationBytes ? fs.realpathSync(process.execPath) : path.join(sb.root, "synthetic-compiler");
  if (!native.qualificationBytes) fs.writeFileSync(compiler, "synthetic compiler fixture only", { mode: 0o755 });
  const calls: { args: string[]; cwd: string; env: Record<string, string> }[] =
    [];
  const invoke: NonNullable<
    NonNullable<Parameters<typeof buildDistribution>[1]>["invoke"]
  > = (command, args, options) => {
    assert.equal(command, compiler);
    calls.push({ args, cwd: options.cwd, env: options.env });
    // This adapter emits framing bytes only: it never compiles or executes a
    // product binary and supplies no compiled-runtime qualification evidence.
    if (args[0] === "--version") return { status: 0, stdout: `${RUNTIME}\n` };
    assert.equal(fs.existsSync(path.join(options.cwd, ".env")), false);
    assert.equal(fs.existsSync(path.join(options.cwd, "bunfig.toml")), false);
    assert.match(
      fs.readFileSync(
        path.join(options.cwd, "src/platform/generated-assets.ts"),
        "utf8",
      ),
      /public skill/,
    );
    const outputIndex = args.indexOf("--outfile");
    if (outputIndex < 0 || !args[outputIndex + 1])
      throw new Error("Synthetic archive fixture requires an output path");
    fs.writeFileSync(args[outputIndex + 1], machO(), { mode: 0o755 });
    return { status: 0, stdout: "synthetic compiler fixture\n" };
  };
  const build = (out = output) =>
    buildDistribution(
      { root, output: out, compiler },
      { invoke, platform: "darwin", arch: "arm64" },
    );
  return { sb, root, output, compiler, write, calls, invoke, build };
}
function sums(output: string) {
  const files = fs
    .readdirSync(output)
    .filter((name) => name !== "SHA256SUMS")
    .sort();
  fs.writeFileSync(
    path.join(output, "SHA256SUMS"),
    files
      .map(
        (name) =>
          `${hash(fs.readFileSync(path.join(output, name)))}  ${name}\n`,
      )
      .join(""),
  );
}

function hostedStaticFixture(f: StaticDistributionFixture) {
  f.build();
  const metadataFile = path.join(f.output, "build.json");
  const metadata = JSON.parse(fs.readFileSync(metadataFile, "utf8"));
  const original = parseNativeProvenance(fs.readFileSync(path.join(f.root, NATIVE_PROVENANCE_PATH), "utf8"));
  const developerDir = "/Applications/Xcode_StaticFixture.app/Contents/Developer";
  const toolchainRoot = `${developerDir}/Toolchains/XcodeDefault.xctoolchain`;
  const sdk = `${developerDir}/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk`;
  const toolchain = original.toolchain.map((tool, index) => ({
    ...tool, path: `${toolchainRoot}/usr/bin/${["clang", "clang++", "ld"][index]}`,
    realpath: `${toolchainRoot}/usr/bin/${index === 2 ? "ld" : "clang"}`,
  }));
  // Framing/integrity fixture only, never workspace admission or probe execution.
  // The report is a retained real installed-library report, not a mocked probe echo.
  const outputBytes = Buffer.concat([fs.readFileSync(path.join(f.root, NATIVE_OUTPUT_PATH)), Buffer.from("static-only variant")]);
  const provenance = {
    ...original, packageDir: path.join(f.root, "node_modules/better-sqlite3"),
    buildMode: "hosted", toolchain, sdk,
    environment: { ...original.environment, SDKROOT: sdk, PATH: `${toolchainRoot}/usr/bin:/usr/bin:/bin` },
    commands: original.commands.map(command => ({
      binary: toolchain[original.toolchain.findIndex(tool => tool.path === command.binary)].path,
      arguments: command.arguments.map(argument => argument === original.sdk ? sdk : argument),
    })),
    hostedToolchain: {
      developerDir, toolchainRoot,
      xcrun: { path: "/usr/bin/xcrun", realpath: "/usr/bin/xcrun", sha256: hash(Buffer.from("static xcrun fixture")) },
      sdkSettings: { path: `${sdk}/SDKSettings.json`, realpath: `${sdk}/SDKSettings.json`, sha256: hash(Buffer.from("static SDK identity fixture")) },
    },
    output: { path: NATIVE_OUTPUT_PATH, sha256: hash(outputBytes), bytes: outputBytes.length },
  };
  const provenanceJson = `${JSON.stringify(provenance, null, 2)}\n`;
  const stdout = fs.readFileSync(path.join(REPO, "docs/research/checkpoints/2026-10-13-sqlite-library-installed-final-probe.log"), "utf8");
  const sandboxProfile = "(version 1)\n; static receipt-schema fixture, not a runnable barrier\n";
  const receipt: NativeQualificationReceipt = {
    schema: 1, coverage: "native-library-smoke", trust: "trusted-workspace-not-hostile-same-user",
    applicationAdmissionLifted: false, root: f.root, host: nativeQualificationHost(),
    runtime: { version: RUNTIME, executable: { path: f.compiler, realpath: f.compiler, sha256: hash(fs.readFileSync(f.compiler)) } },
    verifierInputs: qualificationVerifierInputs(REPO), output: provenance.output,
    provenance: { sha256: hash(Buffer.from(provenanceJson)), json: provenanceJson },
    probe: { exitCode: 0, signal: null, stdout, stdoutSha256: hash(Buffer.from(stdout)),
      stderr: "", stderrSha256: hash(Buffer.alloc(0)), sandboxProfile, sandboxProfileSha256: hash(Buffer.from(sandboxProfile)) },
  };
  const update = () => {
    const receiptJson = `${JSON.stringify(receipt, null, 2)}\n`;
    metadata.nativeQualification = { sha256: hash(Buffer.from(receiptJson)), receiptJson };
    const setInput = (name: string, bytes: number, sha256: string) => {
      const existing = metadata.inputs.find((input: { path: string }) => input.path === name);
      if (existing) Object.assign(existing, { bytes, sha256 });
      else metadata.inputs.push({ path: name, bytes, sha256 });
    };
    setInput(NATIVE_OUTPUT_PATH, receipt.output.bytes, receipt.output.sha256);
    setInput(NATIVE_PROVENANCE_PATH, Buffer.byteLength(receipt.provenance.json), receipt.provenance.sha256);
    setInput(NATIVE_QUALIFICATION_PATH, Buffer.byteLength(receiptJson), metadata.nativeQualification.sha256);
    metadata.inputs.sort((a: { path: string }, b: { path: string }) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    metadata.sourceDigest = hash(Buffer.from(JSON.stringify(metadata.inputs)));
    metadata.dependenciesDigest = hash(Buffer.from(JSON.stringify(metadata.inputs.filter((input: { path: string }) => input.path.startsWith("node_modules/")))));
    fs.writeFileSync(metadataFile, `${JSON.stringify(metadata, null, 2)}\n`);
    sums(f.output);
  };
  update();
  return { metadata, receipt, update };
}

test("distribution hosted receipt schema admits a nonlocal inventory hash without changing full runtime qualification", () => {
  const f = fixture();
  try {
    const hosted = hostedStaticFixture(f);
    const report = verifyDistribution(f.output);
    assert.equal(report.coverage, "static-artifact");
    assert.equal(report.runtimeQualification, "unverified");
    assert.equal(report.inputs, hosted.metadata.inputs.length);
    assert.equal(validateNativeQualification(Buffer.from(hosted.metadata.nativeQualification.receiptJson)).coverage, "native-library-smoke");
    // Static fixture bytes are never eligible for workspace native admission.
    f.write(NATIVE_QUALIFICATION_PATH, hosted.metadata.nativeQualification.receiptJson);
    assert.throws(() => verifyNativeBuild(f.root));
    const qualification = hosted.metadata.nativeQualification;
    delete hosted.metadata.nativeQualification;
    fs.writeFileSync(path.join(f.output, "build.json"), JSON.stringify(hosted.metadata));
    sums(f.output);
    assert.throws(() => verifyDistribution(f.output));
    hosted.metadata.nativeQualification = qualification;
  } finally {
    f.sb.cleanup();
  }
});

test("distribution hosted receipts deny stale verifiers, failed checks and provenance/source/runtime tampering even with refreshed outer sums", () => {
  const f = fixture();
  try {
    const hosted = hostedStaticFixture(f);
    const original = JSON.stringify(hosted.receipt);
    const cases: { mutate(receipt: NativeQualificationReceipt): void }[] = [
      { mutate: receipt => { receipt.verifierInputs[0].sha256 = "0".repeat(64); } },
      { mutate: receipt => { receipt.probe.stdout += " "; } },
      { mutate: receipt => {
        const report: Record<string, unknown> = JSON.parse(receipt.probe.stdout);
        report.onlineBackup = false;
        receipt.probe.stdout = JSON.stringify(report);
        receipt.probe.stdoutSha256 = hash(Buffer.from(receipt.probe.stdout));
      } },
      { mutate: receipt => { receipt.runtime.executable = { ...receipt.runtime.executable, sha256: "0".repeat(64) }; } },
      { mutate: receipt => { receipt.provenance.sha256 = "0".repeat(64); } },
      { mutate: receipt => {
        const provenance = parseNativeProvenance(receipt.provenance.json);
        provenance.inputFiles[0].sha256 = "0".repeat(64);
        receipt.provenance.json = JSON.stringify(provenance);
        receipt.provenance.sha256 = hash(Buffer.from(receipt.provenance.json));
      } },
      { mutate: receipt => {
        const provenance = parseNativeProvenance(receipt.provenance.json);
        provenance.hostedToolchain!.toolchainRoot = "/uncontrolled/toolchain";
        receipt.provenance.json = JSON.stringify(provenance);
        receipt.provenance.sha256 = hash(Buffer.from(receipt.provenance.json));
      } },
    ];
    for (const item of cases) {
      Object.assign(hosted.receipt, JSON.parse(original));
      item.mutate(hosted.receipt);
      hosted.update();
      assert.throws(() => verifyDistribution(f.output));
    }
  } finally {
    f.sb.cleanup();
  }
});

test("native admission never ignores malformed explicit receipts in favor of an existing admission path", () => {
  const f = fixture();
  try {
    assert.ok(verifyNativeBuild(f.root).bytes.length > 32);
    const receiptPath = path.join(f.root, NATIVE_QUALIFICATION_PATH);
    const original = fs.existsSync(receiptPath) ? fs.readFileSync(receiptPath) : undefined;
    f.write(NATIVE_QUALIFICATION_PATH, "{}");
    assert.throws(() => verifyNativeBuild(f.root), /Malformed native qualification evidence/);
    f.write(NATIVE_QUALIFICATION_PATH, "not json");
    assert.throws(() => verifyNativeBuild(f.root), SyntaxError);
    fs.unlinkSync(receiptPath);
    fs.symlinkSync(path.join(f.root, "missing-receipt"), receiptPath);
    assert.throws(() => verifyNativeBuild(f.root), /Noncanonical or oversized native input/);
    fs.unlinkSync(receiptPath);
    if (original) f.write(NATIVE_QUALIFICATION_PATH, original);
    assert.ok(verifyNativeBuild(f.root).bytes.length > 32);
  } finally {
    f.sb.cleanup();
  }
});

test("distribution synthetic compiler: scrubbed environment, current embedded assets, locked inputs and static-only evidence", () => {
  const f = fixture();
  try {
    const report = f.build();
    assert.equal(report.coverage, "static-artifact");
    assert.equal(report.runtimeQualification, "unverified");
    for (const name of [
      "BUN_OPTIONS",
      "BUN_BE_BUN",
      "NODE_OPTIONS",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "CODEX_HOME",
    ])
      assert.equal(f.calls[0].env[name], undefined);
    for (const name of ["HOME", "TMPDIR", "XDG_CACHE_HOME"])
      assert.ok(
        f.calls[0].env[name].startsWith(
          process.env.BOSUN_TEST_RUN_ROOT! + path.sep,
        ),
      );
    assert.equal(
      fs.existsSync(f.calls[0].cwd),
      false,
      "snapshot removed after build",
    );
    assert.equal(
      fs.readFileSync(
        path.join(f.root, "src/platform/generated-assets.ts"),
        "utf8",
      ),
      "stale generated source retained in checkout",
    );
    const metadata = JSON.parse(
      fs.readFileSync(path.join(f.output, "build.json"), "utf8"),
    );
    const inventory = collectInputs(f.root);
    assert.deepEqual(metadata.inputs, inventory.inputs);
    for (const name of [
      "bun.lock",
      PATCH,
      ...NATIVE_INPUTS.map((input) => `.omp/tooling/sqlite-native-13.0.3/${input.filename}`),
      "node_modules/better-sqlite3/build/Release/bosun_sqlite.node",
      "node_modules/better-sqlite3/build/Release/bosun_sqlite.provenance.json",
      ...(metadata.nativeQualification ? [NATIVE_QUALIFICATION_PATH] : []),
      "src/platform/canonical-path.cjs",
      "src/platform/canonical-path.d.cts",
    ]) {
      const input = inventory.inputs.find((item: { path: string }) => item.path === name);
      assert.ok(input, name);
      assert.equal(input.sha256, hash(fs.readFileSync(path.join(REPO, name))), name);
    }
    assert.equal(
      metadata.inputs.some(
        (input: { path: string }) =>
          input.path === ".env" || input.path === "bunfig.toml",
      ),
      false,
    );
    assert.deepEqual(
      metadata.inputs
        .filter((input: { path: string }) => input.path.startsWith(".omp/"))
        .map((input: { path: string }) => input.path),
      [
        ...NATIVE_INPUTS.map((input) => `.omp/tooling/sqlite-native-13.0.3/${input.filename}`),
        ...(metadata.nativeQualification ? [NATIVE_QUALIFICATION_PATH] : []),
      ].sort(),
    );
    assert.equal(
      metadata.inputs.some(
        (input: { path: string }) =>
          input.path === "node_modules/node-addon-api/package.json",
      ),
      true,
    );
    assert.deepEqual(verifyDistribution(f.output, { root: f.root }), report);
    const formula = homebrewFormula(f.output);
    assert.match(formula, /Review candidate only/);
    assert.ok(formula.includes(`sha256 "${report.archiveSha256}"`));
    assert.match(formula, /depends_on arch: :arm64/);
    assert.doesNotMatch(formula, /service do|post_install|system /);
  } finally {
    f.sb.cleanup();
  }
});

test("distribution synthetic compiler: deterministic metadata/archive/checksums across temporary build paths", () => {
  const f = fixture();
  try {
    const first = f.build(),
      secondOutput = path.join(f.sb.root, "second-candidate"),
      second = f.build(secondOutput);
    assert.deepEqual(first, second);
    for (const name of fs.readdirSync(f.output))
      assert.ok(
        fs
          .readFileSync(path.join(f.output, name))
          .equals(fs.readFileSync(path.join(secondOutput, name))),
        name,
      );
  } finally {
    f.sb.cleanup();
  }
});

test("distribution static verification rejects binary/checksum and metadata/inventory tampering", () => {
  const f = fixture();
  try {
    f.build();
    const binary = path.join(f.output, "bosun"),
      original = fs.readFileSync(binary);
    fs.appendFileSync(binary, "changed");
    assert.throws(() => verifyDistribution(f.output), /checksum mismatch/);
    fs.writeFileSync(binary, original);
    const file = path.join(f.output, "build.json"),
      metadata = JSON.parse(fs.readFileSync(file, "utf8"));
    metadata.inputs[0].sha256 = "0".repeat(64);
    fs.writeFileSync(file, JSON.stringify(metadata));
    sums(f.output);
    assert.throws(
      () => verifyDistribution(f.output),
      /inventory checksum mismatch/,
    );
  } finally {
    f.sb.cleanup();
  }
});

test("distribution static verification rejects changed current assets or installed dependency bytes", () => {
  const f = fixture();
  try {
    f.build();
    f.write("skills/worker/SKILL.md", "changed public skill");
    assert.throws(
      () => verifyDistribution(f.output, { root: f.root }),
      /differ from checkout/,
    );
    f.write("skills/worker/SKILL.md", "public skill");
    f.write("node_modules/node-addon-api/README.md", "changed public dependency");
    assert.throws(
      () => verifyDistribution(f.output, { root: f.root }),
      /differ from checkout/,
    );
  } finally {
    f.sb.cleanup();
  }
});

test("distribution static verification rejects archives with changed executable modes, extra files and malformed Mach-O commands", () => {
  const f = fixture();
  try {
    const report = f.build();
    const tar = binaryArchive(machO());
    tar.write("0000644\0", 100, 8);
    fs.writeFileSync(path.join(f.output, report.archive), gzipSync(tar));
    sums(f.output);
    assert.throws(() => verifyDistribution(f.output), /archive framing/);
    fs.writeFileSync(path.join(f.output, "unreviewed"), "extra");
    assert.throws(
      () => verifyDistribution(f.output),
      /Unexpected distribution files/,
    );
    const wrong = machO();
    wrong.writeUInt32LE(7, 36);
    assert.throws(() => verifyMachO(wrong), /load commands/);
    wrong.writeUInt32LE(0x01000007, 4);
    assert.throws(() => verifyMachO(wrong), /macOS arm64/);
  } finally {
    f.sb.cleanup();
  }
});

test("distribution build refuses existing outputs, cross compilation and symlink/dependency drift before compiler calls", () => {
  const f = fixture();
  try {
    fs.mkdirSync(f.output);
    fs.writeFileSync(path.join(f.output, "owner"), "unchanged");
    assert.throws(() => f.build(), /already exists/);
    assert.equal(f.calls.length, 0);
    assert.equal(
      fs.readFileSync(path.join(f.output, "owner"), "utf8"),
      "unchanged",
    );
    fs.rmSync(f.output, { recursive: true });
    assert.throws(
      () =>
        buildDistribution(
          { root: f.root, output: f.output, compiler: f.compiler },
          { invoke: f.invoke, platform: "linux", arch: "arm64" },
        ),
      /native macOS/,
    );
    const dependencyManifest = "node_modules/node-addon-api/package.json";
    const originalManifest = fs.readFileSync(path.join(f.root, dependencyManifest));
    f.write(dependencyManifest, '{"name":"node-addon-api","version":"0.0.0"}');
    assert.throws(() => f.build(), /differs from Bun lock/);
    f.write(dependencyManifest, originalManifest);
    fs.symlinkSync(
      path.join(f.root, "policy.md"),
      path.join(f.root, "src/linked.ts"),
    );
    assert.throws(() => collectInputs(f.root), /symlinks/);
    assert.equal(f.calls.length, 0);
    assert.equal(fs.existsSync(f.output), false);
  } finally {
    f.sb.cleanup();
  }
});

test("distribution source admission rejects native and authoritative Bun lock tampering without synthetic trust", () => {
  const f = fixture();
  try {
    const release = "node_modules/better-sqlite3/build/Release/";
    const provenanceFile = `${release}bosun_sqlite.provenance.json`;
    const provenance = JSON.parse(fs.readFileSync(path.join(f.root, provenanceFile), "utf8"));
    const lock = parseBunLock(fs.readFileSync(path.join(f.root, "bun.lock")));
    const cases = [
      {
        name: PATCH,
        bytes: Buffer.concat([fs.readFileSync(path.join(f.root, PATCH)), Buffer.from("\n")]),
        error: /qualified exact patch/,
      },
      {
        name: `.omp/tooling/sqlite-native-13.0.3/${NATIVE_INPUTS[0].filename}`,
        bytes: Buffer.concat([
          fs.readFileSync(path.join(f.root, ".omp/tooling/sqlite-native-13.0.3", NATIVE_INPUTS[0].filename)),
          Buffer.from("changed archive"),
        ]),
        error: /Native archive integrity mismatch/,
      },
      {
        name: "node_modules/better-sqlite3/binding.gyp",
        bytes: Buffer.from("changed native source"),
        error: /exact patched source/,
      },
      {
        name: `${release}bosun_sqlite.node`,
        bytes: Buffer.concat([
          fs.readFileSync(path.join(f.root, release, "bosun_sqlite.node")),
          Buffer.from("changed binary"),
        ]),
        error: /binary\/provenance differs from pinned build inputs/,
      },
      {
        name: provenanceFile,
        bytes: Buffer.from(JSON.stringify({ ...provenance, qualification: "self-asserted" })),
        error: /binary\/provenance differs from pinned build inputs/,
      },
      {
        name: provenanceFile,
        bytes: Buffer.from(JSON.stringify({ ...provenance, toolchain: [] })),
        error: /binary\/provenance differs from pinned build inputs/,
      },
      {
        name: "bun.lock",
        bytes: Buffer.from(JSON.stringify({
          ...lock,
          workspaces: { ...lock.workspaces, "": { ...lock.workspaces[""], name: "not-bosun" } },
        })),
        error: /identity mismatch/,
      },
      {
        name: "bun.lock",
        bytes: Buffer.from(JSON.stringify({
          ...lock,
          workspaces: {
            ...lock.workspaces,
            "": { ...lock.workspaces[""], dependencies: {} },
          },
        })),
        error: /dependency mismatch/,
      },
      {
        name: "bun.lock",
        bytes: Buffer.from(JSON.stringify({
          ...lock,
          patchedDependencies: {},
        })),
        error: /dependency mismatch/,
      },
      {
        name: "bun.lock",
        bytes: Buffer.from(JSON.stringify({
          ...lock,
          packages: {
            ...lock.packages,
            "better-sqlite3": [
              ...lock.packages["better-sqlite3"].slice(0, 3),
              "sha512-" + Buffer.alloc(64).toString("base64"),
            ],
          },
        })),
        error: /immutable registry pins/,
      },
    ];
    const originalInventory = collectInputs(f.root);
    for (const item of cases) {
      const original = fs.readFileSync(path.join(f.root, item.name));
      f.write(item.name, item.bytes);
      assert.throws(() => collectInputs(f.root), item.error, item.name);
      f.write(item.name, original);
    }
    assert.deepEqual(collectInputs(f.root), originalInventory);
  } finally {
    f.sb.cleanup();
  }
});

test("distribution build/compiler failure removes temporary source and leaves no candidate output", () => {
  const f = fixture();
  let cwd = "";
  try {
    assert.throws(
      () =>
        buildDistribution(
          { root: f.root, output: f.output, compiler: f.compiler },
          {
            platform: "darwin",
            arch: "arm64",
            invoke: (_command, args, options) => {
              cwd = options.cwd;
              return args[0] === "--version"
                ? { status: 0, stdout: `${RUNTIME}\n` }
                : { status: 1, stderr: "synthetic compilation failure\n" };
            },
          },
        ),
      /compilation failed/,
    );
    assert.equal(fs.existsSync(cwd), false);
    assert.equal(fs.existsSync(f.output), false);
  } finally {
    f.sb.cleanup();
  }
});

test("distribution Bun CLIs verify without execution and refuse to overwrite a formula", () => {
  const f = fixture();
  try {
    f.build();
    const run = (name: string, args: string[]) =>
      spawnSync(process.execPath, [path.join(REPO, "scripts", name), ...args], {
        cwd: f.sb.root,
        env: f.sb.env(),
        encoding: "utf8",
      });
    const verify = run("verify-distribution.mts", [
      f.output,
      "--source",
      f.root,
    ]);
    assert.equal(verify.status, 0, verify.stderr);
    assert.equal(JSON.parse(verify.stdout).runtimeQualification, "unverified");
    const formula = path.join(f.sb.root, "bosun.rb");
    assert.equal(
      run("generate-homebrew.mts", [f.output, "--out", formula]).status,
      0,
    );
    const original = fs.readFileSync(formula);
    assert.equal(
      run("generate-homebrew.mts", [f.output, "--out", formula]).status,
      1,
    );
    assert.ok(fs.readFileSync(formula).equals(original));
    assert.equal(run("build.mts", []).status, 1);
    assert.equal(run("verify-distribution.mts", [f.output, "--bad"]).status, 1);
  } finally {
    f.sb.cleanup();
  }
});

test("shared source entry admits a private hook before configuration or malformed input", async () => {
  const sb = sandbox();
  try {
    const config = path.join(sb.home, ".bosun", "run", "hook-config.json");
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, "invalid private configuration");
    for (const args of [
      ["hook", "--private"],
      ["route", "--hook", "--private"],
    ]) {
      const result = await bosun(args, {
        env: sb.env(),
        input: "{malformed private input",
      });
      assert.equal(result.code, 0);
      assert.equal(result.out, "");
      assert.equal(result.err, "");
    }
    assert.equal(
      fs.readFileSync(config, "utf8"),
      "invalid private configuration",
    );
  } finally {
    sb.cleanup();
  }
});
