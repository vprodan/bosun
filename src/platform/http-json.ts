import { BosunError } from '../core/errors.ts';

// Bounded, single-attempt JSON exchange. Never serialize response/error text or follow redirects.
export async function httpJson(url: string, init: RequestInit & { signal: AbortSignal }, timeoutMs: number, maxBytes: number): Promise<unknown> {
  const signal = AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    signal.throwIfAborted();
    const response = await fetch(url, { ...init, signal, redirect: 'error' });
    if (!response.ok) { await response.body?.cancel(); throw new BosunError('unavailable', 'Protocol endpoint unavailable'); }
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
      await response.body?.cancel(); throw new BosunError('invalid', 'Expected JSON protocol response');
    }
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
      await response.body?.cancel(); throw new BosunError('invalid', 'Protocol response exceeds byte limit');
    }
    reader = response.body?.getReader();
    if (!reader) throw new BosunError('invalid', 'Missing protocol response');
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0;
    let text = '';
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new BosunError('invalid', 'Protocol response exceeds byte limit');
      try { text += decoder.decode(chunk.value, { stream: true }); } catch { throw new BosunError('invalid', 'Malformed UTF-8 protocol response'); }
    }
    try { text += decoder.decode(); } catch { throw new BosunError('invalid', 'Malformed UTF-8 protocol response'); }
    try { return JSON.parse(text); } catch { throw new BosunError('invalid', 'Malformed JSON protocol response'); }
  } catch (error) {
    if (signal.aborted) throw new BosunError(signal.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled', 'Protocol request interrupted');
    if (error instanceof BosunError) throw error;
    throw new BosunError('unavailable', 'Protocol endpoint unavailable');
  } finally {
    try { await reader?.cancel(); } catch { /* aborted reader */ }
    reader?.releaseLock();
  }
}

export function protocolBase(value: unknown, loopbackOnly = false): string {
  try {
    if (typeof value !== 'string' || value.length > 2048) throw Error();
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw Error();
    if (loopbackOnly && !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) throw Error();
    return url.origin;
  } catch { throw new BosunError('invalid', 'Invalid protocol endpoint configuration'); }
}
