import { verifyDistribution } from "./distribution.mjs";
import { createRequire } from 'node:module';
try {
  createRequire(import.meta.url)('./test-runtime.cjs').assertRuntime();
  const [output, flag, root, ...extra] = process.argv.slice(2);
  if (!output || extra.length || (flag && (flag !== "--source" || !root)))
    throw new Error(
       "Usage: bun scripts/verify-distribution.mjs artifact-directory [--source checkout]",
    );
  console.log(JSON.stringify(verifyDistribution(output, { root }), null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
