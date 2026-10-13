import { BosunError } from '../../../core/errors.ts';
import { requirePublicInput } from '../../../core/policy.ts';
import { httpJson, protocolBase } from '../../../platform/http-json.ts';
import { contextCandidate, decodeServerInfo, decodeMessagePage, decodeActive, decodeSession, probeParameters, OPENCODE2_MANAGED_CAPS, type ModelSelection, type PublicContext } from './v2-protocol.ts';

export type OpenCodeProbeSettings = { url: string; timeoutMs?: number; now?: () => number };
// Explicit read-only loopback client, not a HostAdapter/detector/process owner. Construction does no IO/config discovery.
export function createOpenCodeProbe(settings: OpenCodeProbeSettings) {
  return {
    hostId: 'opencode' as const,
    managedCapabilities: OPENCODE2_MANAGED_CAPS,
    async readSession(input: PublicContext & { sessionID: string; selection: ModelSelection; generation: number; resetAfter?: number }, signal: AbortSignal) {
      requirePublicInput(input); // before URL/config reads, health checks or session retrieval
      const params = probeParameters(input);
      const url = protocolBase(settings.url, true);
      const timeoutMs = settings.timeoutMs ?? 1000;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new BosunError('invalid', 'Invalid OpenCode probe deadline');
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
      const get = (path: string) => httpJson(url + path, { method: 'GET', signal: deadline }, timeoutMs, 256 * 1024);
      const health = decodeServerInfo(await get('/api/info'));
      const session = decodeSession(await get(`/api/session/${params.sessionID}`), input);
      if (session.id !== params.sessionID) throw new BosunError('invalid', 'OpenCode session identity mismatch');
      const page = decodeMessagePage(await get(`/api/session/${params.sessionID}/message?limit=32&order=desc`), params.sessionID, input);
      if (page.messages.length > 32) throw new BosunError('invalid', 'OpenCode 2 probe page exceeds requested limit');
      const active = decodeActive(await get('/api/session/active'), params.sessionID, input);
      const repeated = decodeSession(await get(`/api/session/${params.sessionID}`), input);
      const server = decodeServerInfo(await get('/api/info'));
      if (session.bindingHash !== repeated.bindingHash || health.pid !== server.pid || health.version !== server.version)
        throw new BosunError('unverified', 'OpenCode 2 observation changed during probe');
      const observation = contextCandidate(session, page.messages, { now: (settings.now ?? Date.now)(), generation: params.generation,
        selection: params.selection, resetAfter: params.resetAfter, running: active.running });
      // A bounded first page is not a complete evidence window or a tool-settlement proof.
      return { ...health, sessionID: session.id, observation, managedCapabilities: OPENCODE2_MANAGED_CAPS };
    },
  };
}
