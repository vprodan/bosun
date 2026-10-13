import type { Env } from '../../core/domain/inference.ts';
import { notificationPayload, NOTIFICATION_LIMITS, type NotificationSink, type NotificationDelivery } from '../../core/domain/notifications.ts';
import { streamProcess, executable } from '../../platform/process.ts';
import { BosunError } from '../../core/errors.ts';

// Apple Standard Additions' supported display notification command. No applet,
// action handler, sound, prompt text, native authentication or executable body.
const SCRIPT = 'on run argv\ndisplay notification (item 1 of argv) with title "bosun"\nend run';
export function createMacNotificationSink(options: { enabled: boolean; env: Env; cwd: string; command?: string; platform?: string; timeoutMs?: number }): NotificationSink {
  const timeoutMs = options.timeoutMs ?? NOTIFICATION_LIMITS.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) throw new BosunError('invalid', 'Invalid notification deadline');
  const environment = (): Env => {
    const env: Record<string, string> = {};
    for (const key of ['HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL']) {
      const value = Object.getOwnPropertyDescriptor(options.env, key); if (value && Object.hasOwn(value, 'value') && typeof value.value === 'string') env[key] = value.value;
    }
    return env;
  };
  const availability = (): ReturnType<NotificationSink['availability']> => {
    if (!options.enabled || (options.platform ?? process.platform) !== 'darwin') return { available: false, reason: 'platform_unsupported' };
    return executable(options.command ?? 'osascript', environment()) ? { available: true } : { available: false, reason: 'command_missing' };
  };
  return { availability, async deliver(input, signal): Promise<NotificationDelivery> {
    const payload = notificationPayload(input); if (signal.aborted) return { phase: 'held', reason: 'cancelled', ui: 'unverified' };
    const available = availability(); if (!available.available) return { phase: 'held', reason: available.reason, ui: 'unverified' };
    try {
      let exit: number | null = null;
      const label = { ready: 'Job queued', held: 'Job held', failed: 'Job failed', done: 'Job done' }[payload.state];
      for await (const event of streamProcess({ command: options.command ?? 'osascript', args: ['-e', SCRIPT, `${payload.jobRef}: ${label}`],
        env: environment(), cwd: options.cwd, signal, timeoutMs, killGraceMs: 100, maxOutputBytes: 1024, maxLineBytes: 512 })) if (event.t === 'exit') exit = event.code;
      // Command completion acknowledges submission, never visibility or user receipt.
      return exit === 0 ? { phase: 'submitted', reason: null, ui: 'unverified' } : { phase: 'unknown', reason: 'delivery_unknown', ui: 'unverified' };
    } catch { return { phase: 'unknown', reason: signal.aborted ? 'cancelled' : 'delivery_unknown', ui: 'unverified' }; }
  } };
}
