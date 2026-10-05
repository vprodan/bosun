import { BosunError } from '../../../core/errors.ts';
import { requirePublicInput } from '../../../core/policy.ts';
import { httpJson, protocolBase } from '../../../platform/http-json.ts';
import { contextCandidate, decodeHealth, decodeMessages, decodeSession, probeParameters, OPENCODE_MANAGED_CAPS, type ModelSelection, type PublicContext } from './protocol.ts';

export type OpenCodeProbeSettings = { url: string; timeoutMs?: number; now?: () => number };
// Explicit read-only loopback client, not a HostAdapter/detector/process owner. Construction does no IO/config discovery.
export function createOpenCodeProbe(settings: OpenCodeProbeSettings) {
  return {
    hostId: 'opencode' as const,
    managedCapabilities: OPENCODE_MANAGED_CAPS,
    async readSession(input: PublicContext & { sessionID: string; selection: ModelSelection; generation: number; resetAfter?: number }, signal: AbortSignal) {
      requirePublicInput(input); // before URL/config reads, health checks or session retrieval
      const params = probeParameters(input);
      const url = protocolBase(settings.url, true);
      const timeoutMs = settings.timeoutMs ?? 1000;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new BosunError('invalid', 'Invalid OpenCode probe deadline');
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
      const get = (path: string) => httpJson(url + path, { method: 'GET', signal: deadline }, timeoutMs, 256 * 1024);
      const health = decodeHealth(await get('/global/health'));
      const session = decodeSession(await get(`/session/${params.sessionID}`), input);
      if (session.id !== params.sessionID) throw new BosunError('invalid', 'OpenCode session identity mismatch');
      const messages = decodeMessages(await get(`/session/${params.sessionID}/message?limit=32`), params.sessionID, input);
      const observation = contextCandidate(session, messages, { now: (settings.now ?? Date.now)(), generation: params.generation,
        selection: params.selection, resetAfter: params.resetAfter });
      return { ...health, sessionID: session.id, observation, managedCapabilities: OPENCODE_MANAGED_CAPS };
    },
  };
}
