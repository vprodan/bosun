import { verifyDistribution } from "./distribution.mts";
import { createRequire } from 'node:module';
import type * as TestRuntime from './test-runtime.cjs';
try {
  const runtime = createRequire(import.meta.url)('./test-runtime.cjs') as typeof TestRuntime;
  runtime.assertRuntime();
  const [output, flag, root, ...extra] = process.argv.slice(2);
  if (!output || extra.length || (flag && (flag !== "--source" || !root)))
    throw new Error(
       "Usage: bun scripts/verify-distribution.mts artifact-directory [--source checkout]",
    );
  console.log(JSON.stringify(verifyDistribution(output, { root }), null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
