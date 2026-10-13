// Materialize only the exact reviewed fork from previously acquired inputs; no install or package scripts.
import fs from 'node:fs';
import path from 'node:path';
import { assertRuntime, inputsRoot, inside, loadInputs, regularBytes, verifyPackage } from './sqlite-native-inputs.mjs';
assertRuntime();
const repo = fs.realpathSync(path.resolve(import.meta.dirname, '..'));
const candidate = path.join(inputsRoot(repo), 'candidate/better-sqlite3');
const installed = path.join(repo, 'node_modules/better-sqlite3');
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--package-dir'))
  throw new Error('Usage: sh scripts/bun-check.sh sqlite-native-prepare [--package-dir <candidate or node_modules/better-sqlite3>]');
const target = args.length ? path.resolve(repo, args[1]) : installed;
if (![candidate, installed].includes(target)) throw new Error('Only the candidate and installed native package targets are admitted');
const { archives, packageFiles, selected } = loadInputs(repo);
for (let directory = target; directory !== repo; directory = path.dirname(directory)) {
  if (fs.existsSync(directory) && (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink() || !inside(repo, fs.realpathSync(directory))))
    throw new Error('Native package target must be canonical and checkout-local');
}
if (fs.existsSync(target)) {
  // Never replace mismatched installed/prior source or erase prior build artifacts.
  verifyPackage(target, selected);
} else {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const staging = fs.mkdtempSync(path.join(path.dirname(target), '.bosun-sqlite-prepare-'));
  try {
    for (const [name, bytes] of packageFiles) {
      // Stock prebuilds never enter this workflow; the fork loads bosun_sqlite.node only.
      if (name.startsWith('prebuilds/')) continue;
      const file = path.join(staging, name);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
    }
    verifyPackage(staging, selected);
    fs.renameSync(staging, target);
  } finally { if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true }); }
}
// The sole native dependency is an immutable header library, materialized without its scripts.
const addonTarget = path.join(path.dirname(target), 'node-addon-api');
const addonFiles = archives.find(({ name }) => name === 'node-addon-api').files;
if (fs.existsSync(addonTarget)) {
  for (const [name, bytes] of addonFiles)
    if (!regularBytes(path.join(addonTarget, name)).equals(bytes)) throw new Error(`Pinned node-addon-api source mismatch: ${name}`);
} else {
  const staging = fs.mkdtempSync(path.join(path.dirname(addonTarget), '.bosun-addon-api-prepare-'));
  try {
    for (const [name, bytes] of addonFiles) {
      const file = path.join(staging, name);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
    }
    fs.renameSync(staging, addonTarget);
  } finally { if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true }); }
}
console.log(JSON.stringify({ packageDir: path.relative(repo, target), scriptsRun: false, network: false, next: `sh scripts/bun-check.sh sqlite-native-build --package-dir ${path.relative(repo, target)}` }, null, 2));
