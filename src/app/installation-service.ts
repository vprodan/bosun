import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BosunError } from '../core/errors.ts';
import type { InstallationReceipt } from '../core/domain/installation.ts';
import { installationSelection } from '../core/domain/installation.ts';
import { readRuntimeManifest, updateInstallationManifest } from '../platform/manifest.ts';
import { DaemonOwner } from '../platform/daemon-owner.ts';
import { readPrivateFile } from '../platform/private-file.ts';
import {
  installationDirectory,
  installationHash,
  syncInstallationDirectory,
  readInstallationFile,
} from '../platform/installation-files.ts';
import { version } from '../platform/assets.ts';
import { callLocalRpc } from '../adapters/transport/local-rpc.ts';
import {
  createLaunchdControl,
  type LaunchdControl,
  type ServiceObservation,
} from '../adapters/services/launchd.ts';
import {
  validateInstallation,
  installationProcessEnv,
  type InstallationOptions,
} from './installation.ts';

type Options = InstallationOptions & { control?: LaunchdControl; timeoutMs?: number };
const conflict = (text: string) => new BosunError('conflict', text);
const present = (file: string) => {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return false;
    throw error;
  }
};
function receipt(options: Options, id: string, expectedVersion?: number, hash?: string) {
  const value = readRuntimeManifest(options.paths, { installationStatus: true }).installation;
  if (
    !value ||
    value.id !== id ||
    value.state !== 'ready' ||
    (expectedVersion !== undefined && value.version !== expectedVersion) ||
    (hash !== undefined && value.planHash !== hash)
  )
    throw conflict('Review the current installation receipt');
  validateInstallation(options, value, value.distribution === 'homebrew');
  return value;
}
function targetCurrent(value: InstallationReceipt, allowUnconfirmed = false) {
  if (!present(value.service.target)) {
    if (value.service.published) throw conflict('Published service definition missing');
    return false;
  }
  const stat = fs.lstatSync(value.service.target);
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o7777) !== 0o600 ||
    fs.realpathSync(value.service.target) !== value.service.target ||
    (process.getuid && stat.uid !== process.getuid()) ||
    stat.size > 16384 ||
    installationHash(readInstallationFile(value.service.target, 16384)) !== value.service.hash
  )
    throw conflict('Published service definition differs');
  if (
    (value.service.published &&
      (stat.dev !== value.service.published.dev || stat.ino !== value.service.published.ino)) ||
    (!value.service.published && !allowUnconfirmed)
  )
    throw conflict('Service definition ownership is unconfirmed');
  return true;
}
async function daemon(
  options: Options,
  value: InstallationReceipt,
  observed: ServiceObservation,
  signal: AbortSignal,
) {
  if (!observed.present || observed.pid === null) return false;
  try {
    const status = await callLocalRpc<any>({
      socket: options.paths.socket,
      timeoutMs: 200,
      signal,
      request: { version: 1, id: crypto.randomUUID(), method: 'daemon.status', params: {} },
    });
    return (
      status?.state === 'running' &&
      status.protocol === 1 &&
      status.version === version &&
      status.installationId === value.installationId &&
      status.deploymentId === value.id &&
      status.pid === observed.pid
    );
  } catch {
    return false;
  }
}
function closedOwner(options: Options) {
  try {
    return new DaemonOwner(options.paths.owner);
  } catch {
    throw new BosunError('unverified', 'Daemon has not released native ownership');
  }
}
export async function controlInstallationService(
  options: Options,
  input: {
    id: string;
    expectedVersion: number;
    hash: string;
    requestId: string;
    operation: 'enable' | 'disable';
    clientsStopped: boolean;
  },
  signal: AbortSignal = new AbortController().signal,
) {
  installationSelection(input.id, input.expectedVersion, input.hash);
  if (
    !/^[A-Za-z0-9_-]{1,100}$/.test(input.requestId) ||
    !['enable', 'disable'].includes(input.operation)
  )
    throw new BosunError('invalid', 'Stable service operation required');
  if (!input.clientsStopped)
    throw conflict('Stop native clients and settle their effects before service changes');
  let value = receipt(options, input.id),
    entered = false;
  const lock = new DaemonOwner(path.join(options.paths.run, 'service-owner.db'));
  const mutate = (change: (next: InstallationReceipt) => void) => {
    lock.assert();
    value = updateInstallationManifest(options.paths, value.id, value.version, (next) => {
      change(next);
      next.version++;
      next.updatedAt = Date.now();
      return next;
    });
    return value;
  };
  const last = () => value.service.operations.at(-1)!;
  const complete = (state: 'enabled' | 'disabled', pid: number | null) =>
    mutate((next) => {
      next.service.state = state;
      const op = next.service.operations.at(-1)!;
      op.state = 'succeeded';
      op.phase = 'complete';
      op.pid = pid;
      op.observedState = state;
      op.completedAt = Date.now();
    });
  try {
    const previous = value.service.operations.find((op) => op.requestId === input.requestId);
    if (previous) {
      if (previous.kind !== input.operation) throw conflict('Service request binding changed');
      if (!['succeeded', 'reconciled'].includes(previous.state))
        throw new BosunError('unverified', 'Reconcile the original service operation');
      return { record: value, operation: previous, duplicate: true };
    }
    if (
      value.version !== input.expectedVersion ||
      value.planHash !== input.hash ||
      !(
        ['prepared', 'disabled', 'enabled'].includes(value.service.state) ||
        (input.operation === 'disable' &&
          value.service.state === 'unknown' &&
          value.service.owned &&
          value.service.operations.at(-1)?.kind === 'enable')
      )
    )
      throw conflict('Service receipt changed or is uncertain');
    if (value.service.operations.length >= 64)
      throw new BosunError('unavailable', 'Service receipt capacity held');
    const control =
      options.control ??
      createLaunchdControl({ env: installationProcessEnv(options.env), cwd: options.paths.home });
    const observed = await control.observe(value.service.label, signal);
    receipt(options, value.id, value.version, value.planHash);
    if (input.operation === 'enable') {
      validateInstallation(options, value);
      if (
        !['prepared', 'disabled'].includes(value.service.state) ||
        observed.present ||
        present(value.service.target)
      )
        throw conflict('Service is already present or destination is unowned');
      const owner = closedOwner(options);
      try {
        const directories = [
          path.join(value.userHome, 'Library'),
          path.join(value.userHome, 'Library', 'LaunchAgents'),
        ];
        for (const directory of directories) {
          if (present(directory)) installationDirectory(directory);
        }
        entered = true;
        mutate((next) => {
          next.service.state = 'enabling';
          next.service.operations.push({
            requestId: input.requestId,
            kind: 'enable',
            state: 'pending',
            phase: 'publish',
            at: Date.now(),
            completedAt: null,
            pid: null,
            observedState: null,
          });
        });
        for (const directory of directories) {
          const created = !present(directory);
          if (created) fs.mkdirSync(directory, { mode: 0o755 });
          const info = installationDirectory(directory);
          const prior = value.service.directories.find((dir) => dir.path === directory);
          if (prior) {
            if (prior.dev !== info.dev || prior.ino !== info.ino || prior.mode !== info.mode)
              throw conflict('Service directory rebound');
          } else
            mutate((next) => {
              next.service.directories.push({ path: directory, ...info, created });
            });
        }
        // Native wx refuses a foreign leaf. Unknown publication remains tied to this original intent.
        const fd = fs.openSync(value.service.target, 'wx', 0o600);
        try {
          fs.writeFileSync(fd, readPrivateFile(value.service.file, 16384));
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        syncInstallationDirectory(path.dirname(value.service.target));
        const stat = fs.lstatSync(value.service.target);
        mutate((next) => {
          next.service.published = { dev: stat.dev, ino: stat.ino };
          next.service.operations.at(-1)!.phase = 'bootstrap';
        });
      } finally {
        owner.close();
      }
      targetCurrent(value);
      receipt(options, value.id, value.version, value.planHash);
      await control.bootstrap(value.service.target, signal);
      mutate((next) => {
        next.service.owned = true;
        next.service.operations.at(-1)!.phase = 'bootstrap-ack';
      });
      const deadline = performance.now() + (options.timeoutMs ?? 5000);
      for (;;) {
        const fresh = await control.observe(value.service.label, signal);
        if (await daemon(options, value, fresh, signal)) {
          validateInstallation(options, value);
          complete('enabled', fresh.pid);
          return { record: value, operation: last(), duplicate: false };
        }
        if (signal.aborted || performance.now() >= deadline)
          throw new BosunError('unverified', 'Owned daemon readiness is unconfirmed');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    if (!observed.present) {
      const owner = closedOwner(options);
      try {
        entered = true;
        mutate((next) => {
          next.service.state = 'disabling';
          next.service.operations.push({
            requestId: input.requestId,
            kind: 'disable',
            state: 'pending',
            phase: 'remove',
            at: Date.now(),
            completedAt: null,
            pid: null,
            observedState: null,
          });
        });
        removeTarget(value);
        mutate((next) => {
          next.service.published = null;
          next.service.owned = false;
        });
        complete('disabled', null);
        return { record: value, operation: last(), duplicate: false };
      } finally {
        owner.close();
      }
    }
    if (
      !value.service.owned ||
      !targetCurrent(value) ||
      (observed.pid !== null && !(await daemon(options, value, observed, signal)))
    )
      throw new BosunError('unverified', 'Native service identity is unconfirmed');
    entered = true;
    mutate((next) => {
      next.service.state = 'disabling';
      next.service.operations.push({
        requestId: input.requestId,
        kind: 'disable',
        state: 'pending',
        phase: 'bootout',
        at: Date.now(),
        completedAt: null,
        pid: observed.pid,
        observedState: null,
      });
    });
    await control.bootout(value.service.label, signal);
    const deadline = performance.now() + (options.timeoutMs ?? 5000);
    for (;;) {
      const fresh = await control.observe(value.service.label, signal);
      if (!fresh.present) {
        let owner: DaemonOwner | undefined;
        try {
          owner = closedOwner(options);
        } catch {}
        if (owner) {
          try {
            mutate((next) => {
              next.service.operations.at(-1)!.phase = 'remove';
            });
            removeTarget(value);
            mutate((next) => {
              next.service.published = null;
              next.service.owned = false;
            });
            complete('disabled', null);
            return { record: value, operation: last(), duplicate: false };
          } finally {
            owner.close();
          }
        }
      }
      if (signal.aborted || performance.now() >= deadline)
        throw new BosunError('unverified', 'Native service shutdown is unconfirmed');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } catch (error) {
    if (entered) {
      try {
        mutate((next) => {
          next.service.state = 'unknown';
          const op = next.service.operations.at(-1);
          if (op && op.state !== 'succeeded') op.state = 'unknown';
        });
      } catch {}
      throw new BosunError('unavailable', 'Service outcome requires reconciliation', {
        details: { outcome: 'unknown' },
      });
    }
    throw error;
  } finally {
    lock.close();
  }
}
function removeTarget(value: InstallationReceipt) {
  if (targetCurrent(value)) {
    const archive = path.join(
      path.dirname(value.service.file),
      `daemon-removed-${value.service.operations.length}.plist`,
    );
    if (present(archive)) throw conflict('Retained service archive already exists');
    fs.renameSync(value.service.target, archive);
    syncInstallationDirectory(path.dirname(value.service.target));
  }
}
export async function reconcileInstallationService(
  options: Options,
  id: string,
  expectedVersion: number,
  hash: string,
  signal: AbortSignal = new AbortController().signal,
) {
  const lock = new DaemonOwner(path.join(options.paths.run, 'service-owner.db'));
  try {
    let value = receipt(options, id, expectedVersion, hash);
    const original = value.service.operations.at(-1);
    if (!original || !['unknown', 'enabling', 'disabling'].includes(value.service.state))
      throw conflict('No uncertain service operation to reconcile');
    const control =
        options.control ??
        createLaunchdControl({ env: installationProcessEnv(options.env), cwd: options.paths.home }),
      observed = await control.observe(value.service.label, signal);
    if (observed.present) {
      if (!targetCurrent(value, true) || !(await daemon(options, value, observed, signal)))
        throw new BosunError('unverified', 'Original service is not qualified');
      const stat = fs.lstatSync(value.service.target);
      lock.assert();
      value = updateInstallationManifest(options.paths, id, expectedVersion, (next) => {
        next.service.state = 'enabled';
        next.service.owned = true;
        next.service.published = { dev: stat.dev, ino: stat.ino };
        const op = next.service.operations.at(-1)!;
        op.state = 'reconciled';
        op.phase = 'complete';
        op.observedState = 'enabled';
        op.pid = observed.pid;
        op.completedAt = Date.now();
        next.version++;
        next.updatedAt = Date.now();
        return next;
      });
      return { record: value, replayed: false };
    }
    const owner = closedOwner(options);
    try {
      if (present(value.service.target)) {
        if (!value.service.published)
          throw new BosunError('unverified', 'Service publication ownership is unconfirmed');
        removeTarget(value);
      }
      lock.assert();
      value = updateInstallationManifest(options.paths, id, expectedVersion, (next) => {
        next.service.state = 'disabled';
        next.service.owned = false;
        next.service.published = null;
        const op = next.service.operations.at(-1)!;
        op.state = 'reconciled';
        op.phase = 'complete';
        op.observedState = 'disabled';
        op.pid = null;
        op.completedAt = Date.now();
        next.version++;
        next.updatedAt = Date.now();
        return next;
      });
      return { record: value, replayed: false };
    } finally {
      owner.close();
    }
  } finally {
    lock.close();
  }
}
