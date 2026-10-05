import { BosunError } from '../core/errors.ts';
import type { Router } from '../core/ports/router.ts';

export type LegacyRouterSettings = { url: string; model?: string; timeoutMs?: number };
const ROUTERS = {
  'legacy-kev': async (settings: LegacyRouterSettings): Promise<Router> =>
    (await import('../adapters/routers/legacy-kev.ts')).createLegacyRouter(settings),
} satisfies Record<string, (settings: LegacyRouterSettings) => Promise<Router>>;

// Static factories only: constructing this registry loads/probes no adapters and owns no service instances.
export function createAdapterRegistry() {
  return {
    async router(id: string, settings: LegacyRouterSettings): Promise<Router> {
      if (!Object.hasOwn(ROUTERS, id)) throw new BosunError('unsupported', 'Router adapter unavailable');
      return ROUTERS[id as keyof typeof ROUTERS](settings);
    },
  };
}
