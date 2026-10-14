// Trusted-workspace native-library smoke evidence only: no application admission,
// production runtime qualification, or protection against a hostile same-user process.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type * as TestRuntime from './test-runtime.cjs';
import type * as TestEnvironment from './test-env.cjs';
import type { NativeQualificationReceipt } from './sqlite-native-inputs.mts';
import {
  assertRuntime, inputsRoot, inside, inspectNativeBuild, nativeQualificationHost,
  nativeQualificationRuntime, NATIVE_QUALIFICATION_PATH, parseNativeProvenance,
  qualificationVerifierInputs, regularBytes, sha256, validateNativeLibraryReport,
  validateNativeQualification,
} from './sqlite-native-inputs.mts';

assertRuntime();
if (process.argv.length !== 2) throw new Error('Usage: bun scripts/qualify-sqlite-native.mts');
const require = createRequire(import.meta.url);
const { createRun, launch } = require('./test-runtime.cjs') as typeof TestRuntime;
const { cleanupRun } = require('./test-env.cjs') as typeof TestEnvironment;
const repo = fs.realpathSync(path.resolve(import.meta.dirname, '..'));
const receiptPath = path.join(repo, NATIVE_QUALIFICATION_PATH);
const tooling = inputsRoot(repo);
if (!inside(repo, fs.realpathSync(tooling))) throw new Error('Native qualification workspace escapes checkout');
// Failed requalification must never leave an earlier receipt active.
if (fs.existsSync(receiptPath)) fs.unlinkSync(receiptPath);
const native = inspectNativeBuild(repo);
const provenance = parseNativeProvenance(native.provenanceBytes.toString('utf8'));
if (provenance.buildMode !== 'hosted' || provenance.packageDir !== path.join(repo, 'node_modules/better-sqlite3'))
  throw new Error('Explicit fresh --hosted build of the installed binding is required');
const verifierInputs = qualificationVerifierInputs(repo);
const runtime = nativeQualificationRuntime();
const host = nativeQualificationHost();
const root = createRun('bosun-native-qualification');
try {
  // This is the existing OS barrier, with application preload deliberately disabled.
  // The probe itself loads the installed trusted binding only inside that barrier.
  const result = launch(root, [path.join(repo, 'scripts/check-sqlite-library.mts'), '--worker', root,
    path.join(repo, 'node_modules/better-sqlite3')], {
    guarded: false, encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024,
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const sandboxProfile = regularBytes(path.join(root, 'containment.sb'), 32 * 1024).toString('utf8');
  const attempt = {
    coverage: 'native-library-smoke', exitCode: result.status ?? null,
    signal: result.signal ?? null, error: result.error ? String(result.error) : null,
    stdout, stderr, stdoutSha256: sha256(stdout), stderrSha256: sha256(stderr),
    outputSha256: sha256(native.bytes), provenanceSha256: sha256(native.provenanceBytes),
  };
  const attempts = path.join(tooling, 'qualifications');
  fs.mkdirSync(attempts, { recursive: true, mode: 0o700 });
  if (!inside(repo, fs.realpathSync(attempts))) throw new Error('Native qualification log escapes checkout');
  const log = path.join(attempts, `${path.basename(root)}.json`);
  fs.writeFileSync(log, `${JSON.stringify(attempt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  if (result.error || result.status !== 0 || result.signal != null)
    throw new Error(`Native library probe failed; no receipt admitted (report: ${path.relative(repo, log)})`);
  validateNativeLibraryReport(stdout);
  // Re-read sources and output after execution; no blind hash refresh or report echo.
  const after = inspectNativeBuild(repo);
  if (!after.bytes.equals(native.bytes) || !after.provenanceBytes.equals(native.provenanceBytes) ||
      JSON.stringify(verifierInputs) !== JSON.stringify(qualificationVerifierInputs(repo)) ||
      JSON.stringify(runtime) !== JSON.stringify(nativeQualificationRuntime()) ||
      JSON.stringify(host) !== JSON.stringify(nativeQualificationHost()))
    throw new Error('Native qualification inputs changed during probe; no receipt admitted');
  const receipt: NativeQualificationReceipt = {
    schema: 1, coverage: 'native-library-smoke', trust: 'trusted-workspace-not-hostile-same-user',
    applicationAdmissionLifted: false, root: repo, host, runtime, verifierInputs,
    output: provenance.output!,
    provenance: { sha256: sha256(native.provenanceBytes), json: native.provenanceBytes.toString('utf8') },
    probe: { exitCode: 0, signal: null, stdout, stdoutSha256: sha256(stdout), stderr, stderrSha256: sha256(stderr),
      sandboxProfile, sandboxProfileSha256: sha256(sandboxProfile) },
  };
  const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  validateNativeQualification(receiptBytes, repo);
  const temporary = `${receiptPath}.${path.basename(root)}.tmp`;
  fs.writeFileSync(temporary, receiptBytes, { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, receiptPath);
  console.log(JSON.stringify({ coverage: receipt.coverage, applicationAdmissionLifted: false,
    receipt: NATIVE_QUALIFICATION_PATH, receiptSha256: sha256(receiptBytes), output: receipt.output,
    report: path.relative(repo, log) }, null, 2));
} finally {
  cleanupRun(root);
}
