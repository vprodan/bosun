import { BosunError } from '../core/errors.ts';
import type { RuntimePaths } from './paths.ts';
import { readPrivateFile, writePrivateFile } from './private-file.ts';
import type { HostInstallReceipt } from '../core/domain/host-install.ts';
import { z } from 'zod';
import { HOSTS } from '../core/domain/config.ts';
import { upgradeReceipt } from '../core/domain/upgrade.ts';
import path from 'node:path';
import { installationReceipt, type InstallationReceipt } from '../core/domain/installation.ts';
import fs from 'node:fs';
import { DaemonOwner } from './daemon-owner.ts';
import { hostLaunchPermitted } from '../core/domain/host-install.ts';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const relative = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.includes('\\') &&
      !/[\x00-\x1f\x7f]/.test(value) &&
      value.split('/').every((part) => !!part && part !== '.' && part !== '..'),
  );
const hostLaunchSchema = z.strictObject({
  args: z.array(z.string().max(32768)).max(128),
  env: z.record(z.string(), z.string().max(131072)),
});
const hostReceiptSchema = z.strictObject({
  id: z.string().regex(/^hp_[a-f0-9]{32}$/),
  requestId: z.string().min(1).max(200),
  hostId: z.enum(HOSTS),
  nativeVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  planHash: digest,
  configHash: digest,
  binary: z
    .string()
    .min(1)
    .max(4096)
    .refine((value) => value.startsWith('/') && !/[\x00-\x1f\x7f]/.test(value)),
  skillWorkspace: z
    .strictObject({
      root: z.string().min(1).max(4096),
      rootDev: z.number().int().min(0),
      rootIno: z.number().int().min(1),
      directories: z
        .array(
          z.strictObject({
            path: z.enum(['.agents', '.agents/skills']),
            create: z.boolean(),
            dev: z.number().int().min(0).nullable(),
            ino: z.number().int().min(1).nullable(),
          }),
        )
        .length(2),
      links: z
        .array(
          z.strictObject({
            name: z.string().regex(/^bosun-[a-z][a-z0-9-]*$/),
            target: z.string().min(1).max(4096),
            hash: digest,
            create: z.boolean(),
          }),
        )
        .max(32),
    })
    .optional(),
  state: z.enum(['applying', 'ready', 'undoing', 'undone', 'unknown']),
  version: z.number().int().min(1),
  createdAt: z.number().int().min(0),
  updatedAt: z.number().int().min(0),
  files: z
    .array(
      z.discriminatedUnion('op', [
        z.strictObject({ op: z.literal('write'), path: relative, hash: digest }),
        z.strictObject({
          op: z.literal('link'),
          path: relative,
          target: z.string().min(1).max(512),
        }),
      ]),
    )
    .min(1)
    .max(64),
  launch: hostLaunchSchema,
}).refine((value) => hostLaunchPermitted(value.hostId, value.nativeVersion, value.launch), {
  path: ['launch'], message: 'Invalid host launch',
});

export type RuntimeManifest = {
  schemaVersion: 1;
  state: 'preparing' | 'ready';
  installationId: string;
  sourceId: string;
  createdAt: number;
  memorySchema: 1 | 2;
  hostProfiles?: HostInstallReceipt[];
  upgrade?: { id: string; planHash: string };
  installation?: InstallationReceipt;
};
const uuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export function readRuntimeManifest(
  paths: RuntimePaths,
  options: { installationStatus?: boolean } = {},
): RuntimeManifest {
  try {
    const value = JSON.parse(readPrivateFile(paths.manifest, 131072));
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      value.schemaVersion !== 1 ||
      ![1, 2].includes(value.memorySchema) ||
      !['preparing', 'ready'].includes(value.state) ||
      !uuid(value.installationId) ||
      !uuid(value.sourceId) ||
      !Number.isSafeInteger(value.createdAt) ||
      value.createdAt < 0 ||
      value.createdAt > 8640000000000000 ||
      Object.keys(value).some(
        (key) =>
          ![
            'schemaVersion',
            'state',
            'installationId',
            'sourceId',
            'createdAt',
            'memorySchema',
            'hostProfiles',
            'upgrade',
            'installation',
          ].includes(key),
      )
    )
      throw 0;
    const installation =
      value.installation === undefined ? undefined : installationReceipt(value.installation);
    if (
      installation &&
      (installation.installationId !== value.installationId ||
        installation.runtimeHome !== paths.home ||
        (!options.installationStatus && !['ready', 'undone'].includes(installation.state)))
    )
      throw 0;
    let upgrade: RuntimeManifest['upgrade'];
    if (value.upgrade !== undefined) {
      upgrade = z
        .strictObject({ id: z.string().regex(/^up_[a-f0-9]{32}$/), planHash: digest })
        .parse(value.upgrade);
      const receipt = upgradeReceipt(
        JSON.parse(readPrivateFile(path.join(paths.home, 'upgrade.json'), 262144)),
      );
      if (
        receipt.id !== upgrade.id ||
        receipt.planHash !== upgrade.planHash ||
        receipt.sourceId !== value.sourceId ||
        receipt.installationId !== value.installationId ||
        (value.state === 'ready' && receipt.state !== 'ready')
      )
        throw 0;
    }
    let hostProfiles: HostInstallReceipt[] | undefined;
    if (value.hostProfiles !== undefined) {
      if (!Array.isArray(value.hostProfiles) || value.hostProfiles.length > 16) throw 0;
      hostProfiles = (value.hostProfiles as unknown[]).map((item) => hostReceiptSchema.parse(item));
      if (
        new Set(hostProfiles.map((item) => item.id)).size !== hostProfiles.length ||
        new Set(hostProfiles.map((item) => item.requestId)).size !== hostProfiles.length
      )
        throw 0;
    }
    return Object.freeze({
      schemaVersion: 1,
      state: value.state,
      installationId: value.installationId,
      sourceId: value.sourceId,
      createdAt: value.createdAt,
      memorySchema: value.memorySchema,
      ...(hostProfiles ? { hostProfiles } : {}),
      ...(upgrade ? { upgrade } : {}),
      ...(installation ? { installation } : {}),
    });
  } catch {
    throw new BosunError(
      'unavailable',
      'Runtime manifest unavailable; use setup or inspect the supported upgrade',
    );
  }
}
export function writeRuntimeManifest(paths: RuntimePaths, value: RuntimeManifest): void {
  const lease = new DaemonOwner(path.join(paths.run, 'manifest-owner.db'));
  try {
    lease.assert();
    if (fs.existsSync(paths.manifest)) {
      const current = JSON.parse(readPrivateFile(paths.manifest, 131072));
      if (current.installation) {
        const original = installationReceipt(current.installation),
          next = value.installation;
        if (
          !next ||
          (next.id === original.id &&
            (next.version < original.version ||
              (next.version === original.version &&
                JSON.stringify(next) !== JSON.stringify(original)))) ||
          (next.id !== original.id && (original.state !== 'undone' || next.version !== 1))
        )
          throw new BosunError('conflict', 'Installation manifest changed');
      }
    }
    writePrivateFile(paths.manifest, JSON.stringify(value) + '\n');
  } finally {
    lease.close();
  }
}
export function updateInstallationManifest(
  paths: RuntimePaths,
  id: string,
  expectedVersion: number,
  update: (value: InstallationReceipt) => InstallationReceipt,
): InstallationReceipt {
  const lease = new DaemonOwner(path.join(paths.run, 'manifest-owner.db'));
  try {
    lease.assert();
    const current = readRuntimeManifest(paths, { installationStatus: true }),
      original = current.installation;
    if (!original || original.id !== id || original.version !== expectedVersion)
      throw new BosunError('conflict', 'Installation receipt changed');
    const next = installationReceipt(update(structuredClone(original)));
    if (next.id !== id || next.version !== expectedVersion + 1)
      throw new BosunError('conflict', 'Installation update differs');
    lease.assert();
    writePrivateFile(paths.manifest, JSON.stringify({ ...current, installation: next }) + '\n');
    return next;
  } finally {
    lease.close();
  }
}
