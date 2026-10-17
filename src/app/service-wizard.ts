import crypto from 'node:crypto';
import type { LaunchdControl } from '../adapters/services/launchd.ts';
import type { InstallationReceipt } from '../core/domain/installation.ts';
import { BosunError } from '../core/errors.ts';
import { installationStatus, type InstallationOptions } from './installation.ts';
import { controlInstallationService, reconcileInstallationService } from './installation-service.ts';
import type { LifecycleOptions } from './installation-lifecycle.ts';

export type ServiceWizardOptions = InstallationOptions & {
  confirm: LifecycleOptions['confirm'];
  write(text: string): void;
  control?: LaunchdControl;
  signal?: AbortSignal;
};
export type ServiceWizardResult = { state: 'ready' | 'cancelled' | 'held'; message: string };
const uncertain = (record: InstallationReceipt) =>
  !['prepared', 'enabled', 'disabled'].includes(record.service.state) ||
  record.service.operations.some(operation => operation.state === 'pending' || operation.state === 'unknown');
const held = (message: string): ServiceWizardResult => ({ state: 'held', message });

/** Review a current owned receipt; carrying its CAS fields is not permission to replay it. */
export async function runServiceWizard(
  options: ServiceWizardOptions,
  operation: 'enable' | 'disable' | 'restart',
): Promise<ServiceWizardResult> {
  if (options.env.BOSUN_CALLER === 'model') return held('Service changes require an owner terminal. No operation was requested.');
  if (!['enable', 'disable', 'restart'].includes(operation)) return held('Select start, stop or restart. No operation was requested.');
  let stopped = false;
  try {
    if (options.signal?.aborted) throw new BosunError('cancelled', 'Service review cancelled');
    const status = installationStatus(options);
    let record = status.record;
    if (!record) return held('No owned background installation is prepared. Run bosun install first; existing data will not be reset.');
    if (record.state !== 'ready' || status.matches !== true)
      return held('Installation ownership or files changed. Run bosun install status and bosun doctor before changing the service.');
    options.write(`Owned executable: ${record.targetBinary}\nBackground service: ${record.service.state}\nData and models will be retained. Separately launched foreground/nohup daemons are not controlled here.\n`);
    if (uncertain(record)) {
      if (!await options.confirm({ kind: 'reconcile', message: 'Inspect and reconcile the ORIGINAL unconfirmed service operation without repeating start or stop?', initialValue: false }))
        return held('The original service outcome remains unconfirmed. Retain its receipt; do not repeat start or stop. Run bosun install status.');
      const result = await reconcileInstallationService(options, record.id, record.version, record.planHash, options.signal);
      record = result.record;
      if (uncertain(record)) return held('The original service outcome is still unconfirmed. No new service operation was requested. Run bosun install status.');
    }
    const steps: readonly ('enable' | 'disable')[] = operation === 'restart' ? ['disable', 'enable'] : [operation];
    for (const step of steps) {
      const fresh = installationStatus(options);
      if (!fresh.record || fresh.matches !== true || fresh.record.id !== record.id ||
          fresh.record.version !== record.version || fresh.record.planHash !== record.planHash)
        return held('The service receipt changed. Inspect bosun install status and review the current operation before continuing.');
      if (step === 'enable' && record.service.state === 'enabled') {
        options.write('The owned background service is already enabled. Use bosun status to check daemon availability.\n');
        continue;
      }
      if (step === 'disable' && ['prepared', 'disabled'].includes(record.service.state)) {
        options.write('The owned background service is already inactive. Any foreground/nohup daemon must be stopped in its original terminal.\n');
        continue;
      }
      const approved = await options.confirm({
        kind: step === 'enable' ? 'start' : 'stop',
        message: `${step === 'enable' ? 'Start' : 'Stop'} this owned background service? Confirm Bosun/native clients are closed and their effects settled.`,
        initialValue: false,
      });
      if (!approved) return {
        state: 'cancelled',
        message: stopped ? 'Restart stopped after the approved stop; the background service remains disabled. Run bosun start when ready.' : 'Service change declined; no further operation was requested.',
      };
      const result = await controlInstallationService(options, {
        id: record.id, expectedVersion: record.version, hash: record.planHash,
        requestId: 'guided_' + crypto.randomUUID(), operation: step, clientsStopped: true,
      }, options.signal);
      record = result.record;
      if (uncertain(record)) return held('The service outcome is unconfirmed. Retain its receipt and run bosun install status; do not repeat the operation.');
      if (step === 'disable') stopped = true;
    }
    return { state: 'ready', message: record.service.state === 'enabled'
      ? 'The owned background service is enabled. Run bosun status to inspect the daemon.'
      : 'The owned background service is inactive. Memory and configuration were retained; foreground/nohup processes are separate.' };
  } catch (error) {
    if (error instanceof BosunError && error.details?.outcome === 'unknown')
      return held('The original service operation has an unconfirmed outcome. No follow-up start was requested. Run bosun install status; do not repeat the operation.');
    if (error instanceof BosunError && error.code === 'cancelled') return { state: 'cancelled',
      message: stopped ? 'Service review cancelled after the approved stop; the background service remains disabled.' : 'Service review cancelled; no further operation was requested.' };
    const prefix = stopped ? 'The approved stop completed, but the next step could not be verified. ' : '';
    return held(prefix + 'Service ownership, receipt or native readiness could not be verified. Run bosun install status and bosun doctor; retain receipts and inspect any foreground/nohup daemon without replaying an unknown operation.');
  }
}
