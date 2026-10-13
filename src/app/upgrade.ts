import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BosunError } from '../core/errors.ts';
import { importLegacyConfig } from '../core/legacy-config.ts';
import { upgradeReceipt } from '../core/domain/upgrade.ts';
import { screenPublicText } from '../core/secret-screen.ts';
import {
  upgradePlanSchema,
  legacyRouterUpgradeSchema,
  type UpgradePlan,
  type UpgradeEntry,
  type UpgradeReceipt,
} from '../contracts/upgrade.ts';
import type { RuntimePaths } from '../platform/paths.ts';
import { parseRuntimeConfig, renderRuntimeConfig, saveRuntimeConfig } from '../platform/config.ts';
import { writePrivateFile, readPrivateFile, privateDirectory } from '../platform/private-file.ts';
import { DaemonOwner } from '../platform/daemon-owner.ts';
import {
  readRuntimeManifest,
  writeRuntimeManifest,
  type RuntimeManifest,
} from '../platform/manifest.ts';
import {
  cutoverMemory,
  publishMemoryView,
  validateLegacyUpgradeSource,
} from '../adapters/memory/sqlite-cutover.ts';
import { initializeMemory } from '../adapters/memory/sqlite-initialize.ts';
import { publishHookConfig } from './config.ts';
import type { Env } from '../core/domain/inference.ts';
import type { LaunchdControl } from '../adapters/services/launchd.ts';
import { inspectLegacyRouter, assertLegacyRouter, retireLegacyRouter, assertRetiredRouter } from './upgrade-router.ts';

const fail = () =>
  new BosunError(
    'unavailable',
    'Upgrade source unavailable; retain files and inspect the supported layout',
  );
export const upgradeHash = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
const planText = (plan: UpgradePlan) => JSON.stringify(upgradePlanSchema.parse(plan));
const intent = (paths: RuntimePaths) => path.join(paths.home, 'upgrade.json');
const files = new Set([
  'config.env',
  'memory.db',
  'memory.db-wal',
  'memory.db-shm',
  'state.json',
  'metrics.jsonl',
  'log.jsonl',
  'bosun.log',
  'route-log.jsonl',
  'route-labels.jsonl',
  'llm-usage.jsonl',
]);
const directories = new Set(['runs', 'cache', 'logs', 'claude-local', 'specs', 'kev']);
const owns = (stat: fs.Stats) => !process.getuid || stat.uid === process.getuid();
function directory(home: string) {
  const stat = fs.lstatSync(home);
  if (
    !path.isAbsolute(home) ||
    path.resolve(home) !== home ||
    fs.realpathSync(home) !== home ||
    !stat.isDirectory() ||
    !owns(stat) ||
    ![0o700, 0o755].includes(stat.mode & 0o7777)
  )
    throw fail();
  return stat;
}
function entry(home: string, name: string, content = true, max = 64 * 1024 * 1024): UpgradeEntry {
  const file = path.join(home, name),
    stat = fs.lstatSync(file),
    mode = stat.mode & 0o7777;
  if (
    !owns(stat) ||
    fs.realpathSync(file) !== file ||
    stat.isSymbolicLink() ||
    (stat.isDirectory()
      ? ![0o700, 0o755].includes(mode)
      : !stat.isFile() || stat.nlink !== 1 || ![0o600, 0o644].includes(mode))
  )
    throw fail();
  let hash: string | null = null;
  if (stat.isFile() && content) {
    if (stat.size > max) throw fail();
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const opened = fs.fstatSync(fd);
      if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size)
        throw fail();
      const bytes = fs.readFileSync(fd),
        after = fs.fstatSync(fd);
      if (
        after.ctimeMs !== stat.ctimeMs ||
        after.mtimeMs !== stat.mtimeMs ||
        bytes.length !== stat.size
      )
        throw fail();
      hash = crypto.createHash('sha256').update(bytes).digest('hex');
    } finally {
      fs.closeSync(fd);
    }
  }
  return {
    name,
    kind: stat.isDirectory() ? 'directory' : 'file',
    dev: stat.dev,
    ino: stat.ino,
    mode,
    bytes: stat.size,
    mtime: stat.mtimeMs,
    ctime: stat.ctimeMs,
    hash,
  };
}
function source(paths: RuntimePaths): UpgradeEntry[] {
  directory(paths.home);
  const names = fs.readdirSync(paths.home).sort();
  if (
    names.length > 100 ||
    !names.includes('config.env') ||
    names.some((n) => !files.has(n) && !directories.has(n))
  )
    throw fail();
  const records = names.map((name) => {
    const row = entry(paths.home, name);
    if (files.has(name) ? row.kind !== 'file' : row.kind !== 'directory') throw fail();
    return row;
  });
  if (!names.includes('memory.db') && names.some((n) => n.startsWith('memory.db-'))) throw fail();
  const runs = path.join(paths.home, 'runs');
  if (names.includes('runs')) {
    const leaves = fs.readdirSync(runs).sort();
    if (leaves.length > 1000) throw fail();
    const ids = new Set<string>();
    for (const leaf of leaves) {
      const match = /^(\d+-[a-f0-9]{6})\.(json|pid|log|rc)$/.exec(leaf);
      if (!match)
        throw new BosunError(
          'conflict',
          'Unsettled legacy run files require manual reconciliation',
        );
      ids.add(match[1]);
      records.push(entry(paths.home, 'runs/' + leaf, match[2] === 'rc'));
    }
    for (const id of ids) {
      if (!leaves.includes(id + '.rc'))
        throw new BosunError('conflict', 'Unsettled legacy run receipt; never replay it');
      const rc = readUpgradeFile(path.join(runs, id + '.rc'), 32, false).trim();
      if (!/^(?:0|[1-9]\d{0,2})$/.test(rc) || Number(rc) > 255)
        throw new BosunError('conflict', 'Unsettled legacy run receipt; never replay it');
    }
  }
  return records;
}
export function readUpgradeFile(file: string, max: number, privateMode = true): string {
  if (!path.isAbsolute(file) || path.resolve(file) !== file || fs.realpathSync(file) !== file)
    throw fail();
  const row = entry(path.dirname(file), path.basename(file), true, max);
  if (row.kind !== 'file' || row.bytes > max || (privateMode && row.mode !== 0o600)) throw fail();
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const bytes = fs.readFileSync(fd);
    if (bytes.length > max || crypto.createHash('sha256').update(bytes).digest('hex') !== row.hash)
      throw fail();
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } finally {
    fs.closeSync(fd);
  }
}
function imported(paths: RuntimePaths, routerUrl?: string) {
  const migrated = importLegacyConfig(readUpgradeFile(paths.legacyConfig, 262144, false));
  if (routerUrl !== undefined) migrated.config.router.url = routerUrl;
  const config = renderRuntimeConfig(migrated.config);
  parseRuntimeConfig(config);
  screenPublicText(config);
  return { config, retainedConfigKeys: migrated.retained };
}
export function planUpgrade(
  paths: RuntimePaths,
  requestId: string,
  options: { env: Env; reviewedAdoptionHash?: string; routerUrl?: string },
): { plan: UpgradePlan; hash: string } {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(requestId))
    throw new BosunError('invalid', 'Invalid upgrade request');
  const root = directory(paths.home),
    inventory = source(paths),
    importedConfig = imported(paths, options.routerUrl);
  if (!options.env.HOME) throw fail();
  const legacy = importLegacyConfig(readUpgradeFile(paths.legacyConfig, 262144, false)).legacyRouter;
  const router = parseRuntimeConfig(importedConfig.config).router;
    if (legacy.explicitEndpoint && options.routerUrl === undefined)
      throw new BosunError('unverified', 'Select --router-url explicitly; the legacy Kev endpoint is retained, not rewritten');
  const legacyRouter = inspectLegacyRouter({ userHome: options.env.HOME, reviewedAdoptionHash: options.reviewedAdoptionHash,
      configHash: inventory.find(row => row.name === 'config.env')!.hash!,
      legacy: { ...legacy, routerUrl: legacy.explicitEndpoint ? 'retained-explicit-endpoint' : null }, router });
    if (legacyRouter.state === 'present' && options.routerUrl === undefined)
      throw new BosunError('unverified', 'Select --router-url explicitly before reviewing legacy router retirement');
  const plan = upgradePlanSchema.parse({
    schemaVersion: 1,
    id: 'up_' + upgradeHash(JSON.stringify([paths.home, requestId])).slice(0, 32),
    requestId,
    createdAt: Date.now(),
    home: paths.home,
    socket: paths.socket,
    homeDev: root.dev,
    homeIno: root.ino,
    homeMode: root.mode & 0o7777,
    sourceId: crypto.randomUUID(),
    installationId: crypto.randomUUID(),
    memory: inventory.some((r) => r.name === 'memory.db') ? 'schema-unverified' : 'absent',
    source: inventory,
    ...importedConfig,
    legacyRouter,
    ...(options.routerUrl === undefined ? {} : { routerUrl: options.routerUrl }),
  });
  return { plan, hash: upgradeHash(planText(plan)) };
}
export function saveUpgradePlan(file: string, value: ReturnType<typeof planUpgrade>): void {
  if (file === value.plan.home || file.startsWith(value.plan.home + path.sep))
    throw new BosunError('invalid', 'Save the reviewed plan outside the legacy source home');
  if (
    !path.isAbsolute(file) ||
    path.resolve(file) !== file ||
    fs.realpathSync(path.dirname(file)) !== path.dirname(file)
  )
    throw fail();
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
export function upgradeStatus(paths: RuntimePaths): UpgradeReceipt {
  const receipt = upgradeReceipt(JSON.parse(readPrivateFile(intent(paths), 262144)));
  assertRetiredRouter(paths, receipt);
  return receipt;
}
export async function applyUpgrade(
  paths: RuntimePaths,
  input: { plan: unknown; hash: string; clientsStopped: boolean; env: Env; control?: LaunchdControl },
): Promise<{ receipt: UpgradeReceipt; manifest: RuntimeManifest; duplicate: boolean }> {
  const plan = upgradePlanSchema.parse(input.plan),
    hash = upgradeHash(planText(plan));
  if (
    input.clientsStopped !== true ||
    hash !== input.hash ||
    plan.home !== paths.home ||
    plan.socket !== paths.socket
  )
    throw new BosunError('conflict', 'Upgrade requires exact plan hash and stopped legacy clients');
  if (fs.existsSync(intent(paths))) {
    const receipt = upgradeStatus(paths);
    if (receipt.planHash === hash && receipt.id === plan.id && receipt.state === 'ready')
      return { receipt, manifest: readRuntimeManifest(paths), duplicate: true };
    throw new BosunError(
      'unavailable',
      'Previous upgrade requires inspection; never replay or overwrite it',
      { details: { outcome: 'unknown' } },
    );
  }
  const root = directory(paths.home);
  if (
    root.dev !== plan.homeDev ||
    root.ino !== plan.homeIno ||
    (root.mode & 0o7777) !== plan.homeMode ||
    JSON.stringify(source(paths)) !== JSON.stringify(plan.source) ||
    JSON.stringify(imported(paths, plan.routerUrl)) !==
      JSON.stringify({ config: plan.config, retainedConfigKeys: plan.retainedConfigKeys })
  )
    throw new BosunError('conflict', 'Upgrade source changed; create and review a fresh plan');
  assertLegacyRouter(plan.legacyRouter, input.env, true);
  const config = parseRuntimeConfig(plan.config);
  const legacy = importLegacyConfig(readUpgradeFile(paths.legacyConfig, 262144, false)).legacyRouter;
  const observedRouter = inspectLegacyRouter({ userHome: input.env.HOME!,
    ...(plan.legacyRouter.state === 'present' && plan.legacyRouter.reviewedAdoptionHash
      ? { reviewedAdoptionHash: plan.legacyRouter.reviewedAdoptionHash } : {}),
    configHash: plan.source.find(row => row.name === 'config.env')!.hash!,
    legacy: { ...legacy, routerUrl: legacy.explicitEndpoint ? 'retained-explicit-endpoint' : null }, router: config.router });
  if (JSON.stringify(legacyRouterUpgradeSchema.parse(observedRouter)) !== JSON.stringify(plan.legacyRouter))
    throw new BosunError('conflict', 'Legacy router review changed; retain the original definition');
  if (plan.memory === 'schema-unverified') {
    validateLegacyUpgradeSource(paths.memory);
    if (JSON.stringify(source(paths)) !== JSON.stringify(plan.source))
      throw new BosunError('conflict', 'Legacy source changed during upgrade inspection');
  }
  let owner: DaemonOwner | undefined;
  let receipt: UpgradeReceipt = {
    schemaVersion: 1,
    id: plan.id,
    planHash: hash,
    state: 'applying',
    sourceId: plan.sourceId,
    installationId: plan.installationId,
    createdAt: plan.createdAt,
    clientsStopped: true,
    backup: null,
  };
  const manifest: RuntimeManifest = {
    schemaVersion: 1,
    state: 'preparing',
    installationId: plan.installationId,
    sourceId: plan.sourceId,
    createdAt: plan.createdAt,
    memorySchema: 2,
    upgrade: { id: plan.id, planHash: hash },
  };
  try {
    // Claim the reviewed attempt before permission changes or native opens.
    const fd = fs.openSync(intent(paths), 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(receipt) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (plan.homeMode !== 0o700) fs.chmodSync(paths.home, 0o700);
    privateDirectory(paths.home);
    for (const row of plan.source.filter((r) =>
      ['config.env', 'memory.db', 'memory.db-wal', 'memory.db-shm'].includes(r.name),
    ))
      if (row.mode !== 0o600) fs.chmodSync(path.join(paths.home, row.name), 0o600);
    for (const dir of [paths.run, path.dirname(paths.view), paths.backups, paths.artifacts])
      fs.mkdirSync(dir, { mode: 0o700 });
    owner = new DaemonOwner(paths.owner);
    writeRuntimeManifest(paths, manifest);
    if (plan.legacyRouter.state === 'present') await retireLegacyRouter({ plan: plan.legacyRouter, env: input.env, control: input.control,
      backup: path.join(paths.backups, plan.id + '.router.plist'), signal: new AbortController().signal,
      assertOwner() { owner!.assert(); }, record(value) {
        owner!.assert(); receipt = { ...receipt, legacyRouter: value };
        writePrivateFile(intent(paths), JSON.stringify(receipt) + '\n');
      } });
    if (plan.memory === 'absent')
      initializeMemory({ file: paths.memory, assertOwner: () => owner!.assert(), now: Date.now });
    let generated = 0;
    const memoryPaths = { primary: paths.memory, view: paths.view, backups: paths.backups };
    const cutover = await cutoverMemory({
      paths: memoryPaths,
      now: Date.now,
      id: () => (++generated === 2 ? plan.sourceId : crypto.randomUUID()),
      ...(plan.memory === 'schema-unverified' ? { upgradeSchema: true as const } : {}),
      expectation: {
        operation: 'apply',
        sourceId: plan.sourceId,
        validate: () => {
          owner!.assert();
          for (const original of plan.source.filter((r) =>
            ['config.env', 'memory.db', 'memory.db-wal'].includes(r.name),
          )) {
            const current = entry(paths.home, original.name);
            if (
              current.dev !== original.dev ||
              current.ino !== original.ino ||
              current.hash !== original.hash
            )
              throw fail();
          }
        },
      },
      checkpoint() {
        owner!.assert();
      },
    });
    receipt = { ...receipt, backup: path.join(paths.backups, cutover.attemptId + '.db') };
    writePrivateFile(intent(paths), JSON.stringify(receipt) + '\n');
    const originalConfig = plan.source.find((row) => row.name === 'config.env')!;
    const currentConfig = entry(paths.home, 'config.env');
    if (
      currentConfig.dev !== originalConfig.dev ||
      currentConfig.ino !== originalConfig.ino ||
      currentConfig.hash !== originalConfig.hash
    )
      throw fail();
    await publishMemoryView({
      paths: memoryPaths,
      now: () => {
        owner!.assert();
        return Date.now();
      },
      id: crypto.randomUUID,
    });
    if (plan.legacyRouter.state === 'absent') assertLegacyRouter(plan.legacyRouter, input.env, true);
    else assertRetiredRouter(paths, { ...receipt, state: 'ready' });
    saveRuntimeConfig(paths, config);
    publishHookConfig(config, paths, { sourceId: plan.sourceId, now: Date.now() });
    receipt = { ...receipt, state: 'ready' };
    writePrivateFile(intent(paths), JSON.stringify(receipt) + '\n');
    const ready = { ...manifest, state: 'ready' as const };
    writeRuntimeManifest(paths, ready);
    return { receipt, manifest: ready, duplicate: false };
  } catch {
    try {
      writePrivateFile(intent(paths), JSON.stringify({ ...receipt, state: 'unknown' }) + '\n');
    } catch {
      /* preserve original intent */
    }
    throw new BosunError(
      'unavailable',
      'Upgrade remains held; retain original files and the SQLite backup',
      { details: { outcome: 'unknown' } },
    );
  } finally {
    owner?.close();
  }
}
