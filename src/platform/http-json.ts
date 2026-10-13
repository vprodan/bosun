import { BosunError } from '../core/errors.ts';

// Bounded, single-attempt JSON exchange. Never serialize response/error text or follow redirects.
export async function httpJson(
  url: string,
  init: RequestInit & { signal: AbortSignal },
  timeoutMs: number,
  maxBytes: number,
): Promise<unknown> {
  return (await httpJsonWithHeaders(url, init, timeoutMs, maxBytes, [])).data;
}
// Selected pagination metadata only; never follow a server-supplied Link URL.
export async function httpJsonWithHeaders(
  url: string,
  init: RequestInit & { signal: AbortSignal },
  timeoutMs: number,
  maxBytes: number,
  headerNames: readonly string[],
): Promise<{ data: unknown; headers: Readonly<Record<string, string | null>> }> {
  if (headerNames.length > 16 || headerNames.some((name) => !/^[a-z][a-z0-9-]{0,79}$/.test(name)))
    throw new BosunError('invalid', 'Invalid protocol header selection');
  const signal = AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    signal.throwIfAborted();
    const response = await fetch(url, { ...init, signal, redirect: 'error' });
    if (!response.ok) {
      await response.body?.cancel();
      throw new BosunError('unavailable', 'Protocol endpoint unavailable');
    }
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
      await response.body?.cancel();
      throw new BosunError('invalid', 'Expected JSON protocol response');
    }
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
      await response.body?.cancel();
      throw new BosunError('invalid', 'Protocol response exceeds byte limit');
    }
    reader = response.body?.getReader();
    if (!reader) throw new BosunError('invalid', 'Missing protocol response');
    const headers: Record<string, string | null> = {};
    for (const name of headerNames) {
      const value = response.headers.get(name);
      if (value !== null && (value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)))
        throw new BosunError('invalid', 'Invalid protocol response header');
      headers[name] = value;
    }
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0;
    let text = '';
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new BosunError('invalid', 'Protocol response exceeds byte limit');
      try {
        text += decoder.decode(chunk.value, { stream: true });
      } catch {
        throw new BosunError('invalid', 'Malformed UTF-8 protocol response');
      }
    }
    try {
      text += decoder.decode();
    } catch {
      throw new BosunError('invalid', 'Malformed UTF-8 protocol response');
    }
    try {
      return { data: JSON.parse(text), headers: Object.freeze(headers) };
    } catch {
      throw new BosunError('invalid', 'Malformed JSON protocol response');
    }
  } catch (error) {
    if (signal.aborted)
      throw new BosunError(
        signal.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled',
        'Protocol request interrupted',
      );
    if (error instanceof BosunError) throw error;
    throw new BosunError('unavailable', 'Protocol endpoint unavailable');
  } finally {
    try {
      await reader?.cancel();
    } catch {
      /* aborted reader */
    }
    reader?.releaseLock();
  }
}

export function protocolBase(value: unknown, loopbackOnly = false): string {
  try {
    if (typeof value !== 'string' || value.length > 2048) throw Error();
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    )
      throw Error();
    if (loopbackOnly && !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) throw Error();
    return url.origin;
  } catch {
    throw new BosunError('invalid', 'Invalid protocol endpoint configuration');
  }
}

// Single-attempt acknowledgement for native 204 operations. Acknowledgement is
// not proof of the effect: callers must read back exact independently bound state.
export async function httpNoContent(url: string, init: RequestInit & { signal: AbortSignal }, timeoutMs: number): Promise<void> {
  const signal = AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]);
  try {
    signal.throwIfAborted();
    const response = await fetch(url, { ...init, signal, redirect: 'error' });
    await response.body?.cancel();
    if (!response.ok) throw new BosunError('unavailable', 'Protocol endpoint unavailable');
    if (response.status !== 204) throw new BosunError('invalid', 'Expected empty protocol acknowledgement');
  } catch (error) {
    if (signal.aborted) throw new BosunError(signal.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled', 'Protocol request interrupted');
    if (error instanceof BosunError) throw error;
    throw new BosunError('unavailable', 'Protocol endpoint unavailable');
  }
}
