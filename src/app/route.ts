import { BosunError } from '../core/errors.ts';
import { requirePublicInput } from '../core/policy.ts';
import { ROUTER_MAX_COLD_START_MS, type RuntimeConfig } from '../core/domain/config.ts';
import type { InferenceInput } from '../core/domain/inference.ts';
import { createRoutePrompt } from '../core/use-cases/route-prompt.ts';
import type { createClefRouter } from '../adapters/routers/ollama-clef.ts';
import type { createClefReadiness } from '../adapters/routers/ollama-clef-status.ts';
import { screenPublicText } from '../core/secret-screen.ts';

// Decision inference belongs to the daemon/explicit client, never the prompt hook.
// Confidence is distribution concentration; it is not a correctness probability.
export function createRouteService(config: RuntimeConfig) {
  let selected: Promise<ReturnType<typeof createClefRouter>> | undefined;
  let readiness: Promise<ReturnType<typeof createClefReadiness>> | undefined;
  let settings: Readonly<RuntimeConfig['router']> | undefined;
  const configured = () => {
    if (settings) return settings;
    const { url, model, timeoutMs, coldStartTimeoutMs, minConfidence, digest } = config.router;
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 30000 ||
      !Number.isSafeInteger(coldStartTimeoutMs) ||
      coldStartTimeoutMs < 1 ||
      coldStartTimeoutMs > ROUTER_MAX_COLD_START_MS ||
      !Number.isFinite(minConfidence) ||
      minConfidence < 0 ||
      minConfidence > 1
    )
      throw new BosunError('invalid', 'Invalid router configuration');
    return (settings = Object.freeze({
      provider: 'ollama' as const,
      url,
      model,
      timeoutMs,
      coldStartTimeoutMs,
      minConfidence,
      ...(digest === undefined ? {} : { digest }),
    }));
  };
  const router = () =>
    (selected ??= import('../adapters/routers/ollama-clef.ts').then(({ createClefRouter }) => {
      const cfg = configured();
      return createClefRouter({ ...cfg, timeoutMs: Math.max(cfg.timeoutMs, cfg.coldStartTimeoutMs) });
    }));
  const status = () =>
    (readiness ??= import('../adapters/routers/ollama-clef-status.ts').then(
      ({ createClefReadiness }) => createClefReadiness(configured()),
    ));
  return {
    async status(signal: AbortSignal) {
      return (await status()).status(signal);
    },
    async classify(input: InferenceInput, signal: AbortSignal) {
      requirePublicInput(input);
      if (signal.aborted) throw new BosunError('cancelled', 'Routing cancelled');
      const text = input.text;
      if (typeof text !== 'string') throw new BosunError('invalid', 'Expected input text');
      screenPublicText(text);
      const permitted = Object.freeze({ privacy: 'public' as const, text });
      const adapter = await router();
      const body = adapter.prepare(permitted); // Size/privacy validation precedes every metadata request.
      const cfg = configured();
      const probe = await status();
      const started = performance.now();
      let budgetMs = cfg.timeoutMs;
      let deadline = AbortSignal.any([signal, AbortSignal.timeout(budgetMs)]);
      const before = await probe.status(deadline);
      if (signal.aborted) throw new BosunError('cancelled', 'Routing cancelled');
      const residencyBefore =
        before.state === 'cold'
          ? ('cold' as const)
          : before.state === 'ready'
            ? ('warm' as const)
            : ('unknown' as const);
      const fallback = (reason: string, observed = before) => ({
        route: null,
        reason,
        status: observed,
        residencyBefore,
        qualification: adapter.qualification,
        automaticDispatch: false as const,
      });
      if (!['ready', 'cold'].includes(before.state)) return fallback(before.reason);
      if (
        before.loaded.contextTokens !== null &&
        Buffer.byteLength(body) + 1024 > before.loaded.contextTokens
      )
        return fallback('input_context_unverified');
      try {
        if (deadline.aborted || performance.now() - started >= budgetMs) return fallback('timeout');
        if (before.state === 'cold') {
          budgetMs = cfg.coldStartTimeoutMs;
          const remaining = budgetMs - (performance.now() - started);
          if (remaining <= 0) return fallback('timeout');
          deadline = AbortSignal.any([signal, AbortSignal.timeout(Math.ceil(remaining))]);
        }
        if (deadline.aborted || performance.now() - started >= budgetMs) return fallback('timeout');
        const route = await createRoutePrompt({
          router: adapter,
          minConfidence: cfg.minConfidence,
        })(permitted, deadline);
        if (signal.aborted) throw new BosunError('cancelled', 'Routing cancelled');
        if (deadline.aborted || performance.now() - started >= budgetMs) return fallback('timeout');
        const after = await probe.status(deadline);
        if (signal.aborted) throw new BosunError('cancelled', 'Routing cancelled');
        if (deadline.aborted || performance.now() - started >= budgetMs) return fallback('timeout', after);
        if (
          after.state !== 'ready' ||
          after.digest !== before.digest ||
          after.tagDigest !== before.tagDigest
        )
          return fallback(after.state === 'ready' ? 'digest_changed' : after.reason, after);
        return {
          route,
          reason: null,
          status: after,
          residencyBefore,
          qualification: adapter.qualification,
          automaticDispatch: false as const,
        };
      } catch (error) {
        if (error instanceof BosunError && error.code === 'private_input') throw error;
        if (signal.aborted) throw new BosunError('cancelled', 'Routing cancelled');
        return fallback(
          (error instanceof BosunError && error.code === 'timeout') || deadline.aborted
            ? 'timeout'
            : 'classification_unavailable',
        );
      }
    },
  };
}
