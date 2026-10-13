// One bounded current-source static candidate. Never execute the generated product binary.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { collectInputs, COMPILE_FLAGS } from "../../../scripts/distribution.mjs";

const root = fs.realpathSync(process.cwd());
const checkpoint = path.join(root, "docs/research/checkpoints");
const stem = "2026-10-12-compiled-benchmark-instrumented-build";
const recordFile = path.join(checkpoint, `${stem}-record.json`);
const toolCopyFile = path.join(checkpoint, `${stem}-tool.txt`);
const compiler = "/Users/edge/.bun/bin/bun";
const outputs = [
  "dist/bosun-0.2.0-darwin-arm64-benchmark-instrumented",
].map((name) => path.join(root, name));
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const hashFile = (file) => sha256(fs.readFileSync(file));
const originalToolFile = path.join(root, "scripts/distribution.mjs");
const protectedNames = [
  "scripts/distribution.mjs",
  "scripts/build.mjs",
  "scripts/check-claude-bootstrap.mjs",
  "scripts/check-compiled-runtime.mjs",
  "package.json",
  "package-lock.json",
  "bun.lock",
  "src/app/memory-benchmark.ts",
  "src/app/cli.ts",
];
const protectedHashes = () => Object.fromEntries(
  protectedNames.map((name) => [name, hashFile(path.join(root, name))]),
);
function git(args) {
  const result = spawnSync("/opt/homebrew/bin/git", args, {
    cwd: root,
    env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    encoding: "utf8", shell: false, timeout: 10000,
  });
  assert.equal(result.status, 0);
  return result.stdout.trim();
}
function rawDifferences(first, second) {
  const limit = Math.max(first.length, second.length);
  let changedBytes = 0, firstDifference = null, prior = -2;
  const spans = [];
  let totalSpans = 0;
  for (let offset = 0; offset < limit; offset++) {
    if (first[offset] === second[offset]) continue;
    changedBytes++;
    if (firstDifference === null) firstDifference = offset;
    if (offset !== prior + 1) {
      totalSpans++;
      if (spans.length < 512) spans.push({ start: offset, endExclusive: offset + 1 });
    } else if (totalSpans <= 512) spans.at(-1).endExclusive = offset + 1;
    prior = offset;
  }
  return {
    equal: first.equals(second), firstBytes: first.length, secondBytes: second.length,
    changedBytes, firstDifference, totalSpans, spansTruncated: totalSpans > spans.length,
    spans: spans.map((span) => ({
      ...span,
      firstHexPrefix: first.subarray(span.start, Math.min(span.endExclusive, span.start + 64)).toString("hex"),
      secondHexPrefix: second.subarray(span.start, Math.min(span.endExclusive, span.start + 64)).toString("hex"),
    })),
  };
}
function uuids(binary) {
  const values = [];
  let cursor = 32;
  for (let index = 0; index < binary.readUInt32LE(16); index++) {
    const command = binary.readUInt32LE(cursor), size = binary.readUInt32LE(cursor + 4);
    if (command === 0x1b) {
      assert.equal(size, 24);
      values.push(binary.subarray(cursor + 8, cursor + 24).toString("hex"));
    }
    cursor += size;
  }
  return values;
}
assert.equal(process.versions.bun, undefined);
assert.ok(Number(process.versions.node.split(".")[0]) >= 24);
assert.equal(process.platform, "darwin");
assert.equal(process.arch, "arm64");
assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"]), "main");
assert.equal(git(["rev-parse", "--short", "HEAD"]), "4adb3b4");
assert.equal(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version, "0.2.0");
for (const file of [recordFile, toolCopyFile, ...outputs]) assert.equal(fs.existsSync(file), false, file);

const record = {
  coverage: "static-one-current-source-no-bytecode-candidate",
  startedAt: new Date().toISOString(),
  root, branch: "main", head: "4adb3b4", packageVersion: "0.2.0",
  node: { version: process.versions.node, executable: process.execPath },
  driver: { path: path.relative(root, import.meta.filename), sha256: hashFile(import.meta.filename) },
  runtimeExecuted: false, testsExecuted: false, downloadsOrInstallsRequested: false,
  productBuildFlagsModified: false,
  exactVariant: "Private snapshot scripts/distribution.mjs has only the --bytecode line removed; all other flags and builder logic are unchanged.",
  protectedBefore: protectedHashes(),
  builds: [],
};
let master;
try {
  master = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bosun-benchmark-instrumented-candidate-")));
  const source = path.join(master, "source");
  fs.mkdirSync(source, { mode: 0o700 });
  record.masterSnapshot = { directory: master, mode: fs.statSync(master).mode & 0o777 };
  const originalSnapshot = collectInputs(root, source);
  record.originalSnapshot = originalSnapshot;
  const originalTool = fs.readFileSync(path.join(source, "scripts/distribution.mjs"), "utf8");
  assert.equal(sha256(originalTool), hashFile(originalToolFile));
  const flagLine = '  "--bytecode",\n';
  assert.equal(originalTool.split(flagLine).length, 2);
  const variantTool = originalTool.replace(flagLine, "");
  assert.equal(variantTool + "", originalTool.replace(flagLine, ""));
  fs.writeFileSync(path.join(source, "scripts/distribution.mjs"), variantTool);
  fs.writeFileSync(toolCopyFile, variantTool, { flag: "wx", mode: 0o644 });
  record.variantTool = {
    archivePath: path.relative(root, toolCopyFile),
    originalSha256: sha256(originalTool), variantSha256: sha256(variantTool),
    removedExactLine: flagLine,
  };
  const variant = await import(pathToFileURL(path.join(source, "scripts/distribution.mjs")).href);
  assert.deepEqual(variant.COMPILE_FLAGS, COMPILE_FLAGS.filter((flag) => flag !== "--bytecode"));
  assert.equal(variant.COMPILE_FLAGS.includes("--bytecode"), false);
  assert.ok(variant.COMPILE_FLAGS.includes("--format=esm"));
  assert.ok(variant.COMPILE_FLAGS.includes("--splitting"));
  record.actualFlags = [...variant.COMPILE_FLAGS];
  record.variantSnapshot = variant.collectInputs(source);
  const changedInputs = originalSnapshot.inputs.filter((input, index) =>
    JSON.stringify(input) !== JSON.stringify(record.variantSnapshot.inputs[index]),
  );
  assert.equal(originalSnapshot.inputs.length, record.variantSnapshot.inputs.length);
  assert.deepEqual(changedInputs.map((input) => input.path), ["scripts/distribution.mjs"]);
  record.changedInputPaths = changedInputs.map((input) => input.path);
  for (const output of outputs) {
    const build = { output: path.relative(root, output), invocations: [], startedAt: new Date().toISOString() };
    record.builds.push(build);
    try {
      build.staticReport = variant.buildDistribution({ root: source, output, compiler }, {
        invoke(command, args, options) {
          const call = {
            command, args: [...args], cwd: options.cwd, env: { ...options.env },
            shell: options.shell, timeoutMs: options.timeout, maxBuffer: options.maxBuffer,
            startedAt: new Date().toISOString(),
          };
          build.invocations.push(call);
          assert.equal(command, fs.realpathSync(compiler));
          if (args[0] !== "--version") {
            assert.deepEqual(args.slice(3, -2), record.actualFlags);
            assert.equal(args.includes("--bytecode"), false);
            assert.equal(args[0], "--no-install");
            assert.equal(args[1], "build");
            assert.equal(args[2], "src/app/entry.ts");
          }
          // Observe only. Actual arguments and environment pass through unchanged.
          const result = spawnSync(command, args, options);
          Object.assign(call, {
            finishedAt: new Date().toISOString(), status: result.status, signal: result.signal,
            errorCode: result.error?.code ?? null, stdout: result.stdout ?? "", stderr: result.stderr ?? "",
          });
          return result;
        },
      });
      build.metadata = JSON.parse(fs.readFileSync(path.join(output, "build.json"), "utf8"));
      assert.deepEqual(build.metadata.flags, record.actualFlags);
      assert.equal(build.metadata.sourceDigest, record.variantSnapshot.sourceDigest);
      build.files = Object.fromEntries(fs.readdirSync(output).sort().map((name) => {
        const bytes = fs.readFileSync(path.join(output, name));
        return [name, { bytes: bytes.length, sha256: sha256(bytes) }];
      }));
      build.machOUuids = uuids(fs.readFileSync(path.join(output, "bosun")));
      build.finishedAt = new Date().toISOString();
      build.outcome = "static-build-and-verification-passed";
      process.stdout.write(JSON.stringify({ output: build.output, ...build.staticReport }) + "\n");
    } finally {
      build.privateBuildDirectories = [...new Set(build.invocations.map((call) => path.dirname(call.cwd)))].map((directory) => ({
        directory, removed: !fs.existsSync(directory),
      }));
      assert.ok(build.privateBuildDirectories.every((item) => item.removed));
    }
  }
  assert.equal(record.builds.length, 1);
  record.outcome = "bounded-static-current-candidate-completed";
  record.interpretation = "One current-source no-bytecode candidate. This artifact has not executed, is not a reproducibility pair, and has no compiled runtime/performance qualification or release selection.";
} catch (error) {
  record.outcome = "bounded-static-experiment-failed";
  record.error = { name: error.name, message: error.message };
  process.exitCode = 1;
} finally {
  if (master) fs.rmSync(master, { recursive: true, force: true });
  record.masterSnapshotRemoved = master ? !fs.existsSync(master) : true;
  record.protectedAfter = protectedHashes();
  record.protectedFilesUnchanged = JSON.stringify(record.protectedBefore) === JSON.stringify(record.protectedAfter);
  record.currentOriginalSourceDigest = collectInputs(root).sourceDigest;
  record.originalInputsStillMatch = !record.originalSnapshot || record.originalSnapshot.sourceDigest === record.currentOriginalSourceDigest;
  record.finishedAt = new Date().toISOString();
  if (!record.masterSnapshotRemoved || !record.protectedFilesUnchanged || !record.originalInputsStillMatch) process.exitCode = 1;
  fs.writeFileSync(recordFile, JSON.stringify(record, null, 2) + "\n", { flag: "wx", mode: 0o644 });
  process.stdout.write(JSON.stringify({ outcome: record.outcome, record: path.relative(root, recordFile), recordSha256: hashFile(recordFile), masterSnapshotRemoved: record.masterSnapshotRemoved, protectedFilesUnchanged: record.protectedFilesUnchanged, originalInputsStillMatch: record.originalInputsStillMatch }) + "\n");
}
