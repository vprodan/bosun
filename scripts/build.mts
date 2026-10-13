import fs from "node:fs";
import path from "node:path";
import { createRequire } from 'node:module';
import { buildDistribution } from "./distribution.mts";
import type * as TestRuntime from './test-runtime.cjs';
try {
  const runtime = createRequire(import.meta.url)('./test-runtime.cjs') as typeof TestRuntime;
  runtime.assertRuntime();
  const root = path.resolve(import.meta.dirname, "..");
  let output: string | undefined, compiler: string | undefined;
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 2) {
    if (
      !["--out", "--bun"].includes(args[index]) ||
      !args[index + 1] ||
      args[index + 1].startsWith("--")
    )
      throw new Error(
        "Usage: bun scripts/build.mts --bun /absolute/installed/bun [--out absent-directory]",
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
    const { version }: { version: string } = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf8"),
    ) as { version: string };
    output = path.join(root, "dist", `bosun-${version}-darwin-arm64`);
  }
  const report = buildDistribution({ root, output, compiler });
  console.log(JSON.stringify({ output, ...report }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
