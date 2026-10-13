import fs from "node:fs";
import { createRequire } from 'node:module';
import { homebrewFormula } from "./distribution.mjs";
try {
  createRequire(import.meta.url)('./test-runtime.cjs').assertRuntime();
  const [output, flag, formula, ...extra] = process.argv.slice(2);
  if (!output || extra.length || (flag && (flag !== "--out" || !formula)))
    throw new Error(
       "Usage: bun scripts/generate-homebrew.mjs artifact-directory [--out absent-formula.rb]",
    );
  const text = homebrewFormula(output);
  if (formula) fs.writeFileSync(formula, text, { flag: "wx", mode: 0o644 });
  else process.stdout.write(text);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
