import { BosunError } from '../../../core/errors.ts';
import type { SupportedQuotaSource } from '../../../core/use-cases/quota.ts';
import { connectCodexAppServer, type CodexClientOptions } from './client.ts';
import { decodeCodexQuotaBatch } from './quota.ts';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

// The native binary owns auth and the backend validates account-bound included
// usage. No email/token is used as an account identifier, and no earned-reset,
// paid-overage, login or token-refresh operation is requested by this source.
export function createCodexQuotaSource(options: CodexClientOptions & { now(): number }): SupportedQuotaSource {
  return {
    async read(selection, signal) {
      if (selection.runnerId !== 'codex' || typeof selection.model !== 'string' || !selection.model
        || selection.model.length > 200 || /[\x00-\x20\x7f]/.test(selection.model)) throw new BosunError('invalid', 'Invalid Codex quota selection');
      let client: Awaited<ReturnType<typeof connectCodexAppServer>> | undefined;
      try {
        client = await connectCodexAppServer(options, signal);
        const account = await client.request('account/read', { refreshToken: false }, signal);
        if (!object(account) || account.requiresOpenaiAuth !== true || !object(account.account) || account.account.type !== 'chatgpt') return null;
        const limits = await client.request('account/rateLimits/read', {}, signal);
        if (!object(limits) || typeof limits.accountId !== 'string' || !limits.accountId || limits.accountId.length > 200
          || /[\x00-\x1f\x7f]/.test(limits.accountId)) return null;
        if (signal.aborted) throw new BosunError('cancelled', 'Codex quota refresh cancelled');
        return decodeCodexQuotaBatch(limits, { accountId: limits.accountId, model: selection.model }, options.now());
      } finally { await client?.close(); }
    },
  };
}
