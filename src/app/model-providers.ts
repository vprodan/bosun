import { BosunError } from '../core/errors.ts';
import { requirePublicInput } from '../core/policy.ts';
import type { RuntimeConfig } from '../core/domain/config.ts';
import type { Env } from '../core/domain/inference.ts';
import type { ModelProvider } from '../core/ports/model.ts';

// Configured identity selects the transport. Native CLI own-inference remains
// unavailable until tools/plugins/managed hooks are qualified as tool-free.
// It is never quietly replaced by an API or a different continuing model.
export function modelProviders(config: RuntimeConfig, environment: Env): Readonly<Record<string, ModelProvider>> {
  const providers: Record<string, ModelProvider> = {};
  for (const [name, settings] of Object.entries(config.providers)) {
    let implementation: Promise<ModelProvider> | undefined;
    const load = () => implementation ??= (async () => {
      if (settings.kind === 'ollama') {
        const { createOllamaModelProvider } = await import('../adapters/models/ollama.ts');
        if (!settings.url) throw new BosunError('invalid', 'Configured model endpoint required');
        return createOllamaModelProvider({ ...settings, url: settings.url, contextTokens: config.local.contextTokens,
          maxOutputTokens: Math.min(config.handoff.maxSummaryTokens, 16384) });
      }
      if (settings.kind === 'openai-compatible') {
        const { createCompatibleModelProvider } = await import('../adapters/models/openai-compatible.ts');
        if (!settings.url) throw new BosunError('invalid', 'Configured model endpoint required');
        return createCompatibleModelProvider({ ...settings, url: settings.url, env: environment, maxOutputTokens: Math.min(config.handoff.maxSummaryTokens, 16384) });
      }
      throw new BosunError('unverified', 'Native CLI summary isolation unverified');
    })();
    const native = settings.kind === 'claude-cli' || settings.kind === 'codex-cli';
    providers[name] = Object.freeze({ id: name, caps: Object.freeze({ structured: native ? 'unverified' : 'verified', local: 'unverified',
      numCtx: settings.kind === 'ollama' ? 'verified' : 'unsupported', toolFree: native ? 'unverified' : 'verified' }),
      async generate(request) { requirePublicInput(request); return (await load()).generate(request); },
      async health(signal) { if (native || signal.aborted) return false; try { return (await load()).health(signal); } catch { return false; } },
    } satisfies ModelProvider);
  }
  return Object.freeze(providers);
}
