import fs from "node:fs";
import { createRequire } from 'node:module';
import { homebrewFormula } from "./distribution.mts";
import type * as TestRuntime from './test-runtime.cjs';
try {
  const runtime = createRequire(import.meta.url)('./test-runtime.cjs') as typeof TestRuntime;
  runtime.assertRuntime();
  const [output, flag, formula, ...extra] = process.argv.slice(2);
  if (!output || extra.length || (flag && (flag !== "--out" || !formula)))
    throw new Error(
       "Usage: bun scripts/generate-homebrew.mts artifact-directory [--out absent-formula.rb]",
    );
  const text = homebrewFormula(output);
  if (formula) fs.writeFileSync(formula, text, { flag: "wx", mode: 0o644 });
  else process.stdout.write(text);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
