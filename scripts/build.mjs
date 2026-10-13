import fs from "node:fs";
import path from "node:path";
import { createRequire } from 'node:module';
import { buildDistribution } from "./distribution.mjs";
try {
  createRequire(import.meta.url)('./test-runtime.cjs').assertRuntime();
  const root = path.resolve(import.meta.dirname, "..");
  let output, compiler;
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 2) {
    if (
      !["--out", "--bun"].includes(args[index]) ||
      !args[index + 1] ||
      args[index + 1].startsWith("--")
    )
      throw new Error(
        "Usage: bun scripts/build.mjs --bun /absolute/installed/bun [--out absent-directory]",
      );
    if (args[index] === "--out") {
      if (output) throw new Error("Duplicate --out");
      output = path.resolve(args[index + 1]);
    } else {
      if (compiler) throw new Error("Duplicate --bun");
      compiler = args[index + 1];
    }
  }
  if (!compiler)
    throw new Error(
      "Provide --bun /absolute/installed/bun; this command never installs a compiler",
    );
  if (!output) {
    fs.mkdirSync(path.join(root, "dist"), { recursive: true });
    const { version } = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf8"),
    );
    output = path.join(root, "dist", `bosun-${version}-darwin-arm64`);
  }
  const report = buildDistribution({ root, output, compiler });
  console.log(JSON.stringify({ output, ...report }, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
