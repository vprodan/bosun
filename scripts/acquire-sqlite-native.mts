// The only network-enabled native workflow step. Fetches three reviewed immutable inputs only.
import fs from 'node:fs';
import path from 'node:path';
import { assertRuntime, inputsRoot, inside, INPUTS, PATCH, PATCH_SHA256, regularBytes, sha256, verifyArchive } from './sqlite-native-inputs.mts';
assertRuntime();
if (process.argv.length !== 2) throw new Error('Usage: sh scripts/bun-check.sh sqlite-native-acquire');
const repo = fs.realpathSync(path.resolve(import.meta.dirname, '..'));
const root = inputsRoot(repo);
// Refuse an escaping ancestor before making any acquisition directories.
for (let directory = root; directory !== repo; directory = path.dirname(directory)) {
  if (fs.existsSync(directory) && (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink() || !inside(repo, fs.realpathSync(directory))))
    throw new Error('Native input workspace must be a canonical checkout-local directory');
}
if (sha256(regularBytes(path.join(repo, PATCH))) !== PATCH_SHA256) throw new Error('Native patch pin mismatch');
fs.mkdirSync(root, { recursive: true, mode: 0o700 });
interface AcquisitionRecord {
  name: string;
  url: string;
  archiveSha256: string;
  integrity: string;
  files: number;
  acquired: boolean;
}
const records: AcquisitionRecord[] = [];
for (const input of INPUTS) {
  const target = path.join(root, input.filename);
  let bytes: Buffer;
  let acquired = false;
  if (fs.existsSync(target)) {
    bytes = regularBytes(target);
  } else {
    const response = await fetch(input.url, { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(120000) });
    if (!response.ok || !response.body) throw new Error(`Pinned native archive fetch failed: ${input.name} (${response.status})`);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      if ((size += chunk.length) > 32 * 1024 * 1024) throw new Error('Pinned native archive exceeds bounds');
      chunks.push(Buffer.from(chunk));
    }
    bytes = Buffer.concat(chunks, size);
    verifyArchive(input, bytes);
    fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
    acquired = true;
  }
  const files = verifyArchive(input, bytes);
  records.push({ name: input.name, url: input.url, archiveSha256: input.sha256, integrity: input.integrity ?? `sha256-${input.sha256}`, files: files.size, acquired });
}
// Preserve any original acquisition.json and all previous build provenance.
const record = { schema: 1, inputs: records, lifecycleScriptsRun: false, nodeRuntimeDownloadedOrExecuted: false };
const receipt = path.join(root, `acquisition-${Date.now()}-${process.pid}.json`);
fs.writeFileSync(receipt, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ inputs: records, receipt: path.relative(repo, receipt), next: 'sh scripts/bun-check.sh sqlite-native-prepare' }, null, 2));
