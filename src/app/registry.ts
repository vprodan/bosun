import { BosunError } from '../core/errors.ts';
import type { Router } from '../core/ports/router.ts';

export type RouterSettings = { url: string; model?: string; timeoutMs?: number };
const ROUTERS = {
  'ollama-clef': async (settings: RouterSettings): Promise<Router> =>
    (await import('../adapters/routers/ollama-clef.ts')).createClefRouter(settings),
} satisfies Record<string, (settings: RouterSettings) => Promise<Router>>;

// Static factories only: constructing this registry loads/probes no adapters and owns no service instances.
export function createAdapterRegistry() {
  return {
    async router(id: string, settings: RouterSettings): Promise<Router> {
      if (!Object.hasOwn(ROUTERS, id))
        throw new BosunError('unsupported', 'Router adapter unavailable');
      return ROUTERS[id as keyof typeof ROUTERS](settings);
    },
  };
}
