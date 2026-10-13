import { httpJson, protocolBase } from '../../platform/http-json.ts';

const object = (v: unknown): Record<string, unknown> | null => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
const remote = (v: Record<string, unknown>) => v.remote_host !== undefined && v.remote_host !== '' || v.remote_model !== undefined && v.remote_model !== '';
// Metadata only. The caller already screened its source window and captures it
// again after this await. No authentication discovery, model load or pull.
export async function localOllamaSelection(settings: { url?: string; model: string; timeoutMs: number }, signal: AbortSignal): Promise<boolean> {
  try {
    const base = protocolBase(settings.url); const deadline = AbortSignal.any([signal, AbortSignal.timeout(Math.min(settings.timeoutMs, 3000))]);
    const list = object(await httpJson(`${base}/api/tags`, { method: 'GET', signal: deadline }, 3000, 512 * 1024));
    if (!list || !Array.isArray(list.models) || list.models.length > 1024) return false;
    const matching = list.models.filter((v) => object(v)?.model === settings.model || object(v)?.name === settings.model).map(object);
    if (matching.length !== 1 || !matching[0] || remote(matching[0])) return false;
    const show = object(await httpJson(`${base}/api/show`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: settings.model, verbose: false }), signal: deadline }, 3000, 512 * 1024));
    return !!show && !remote(show) && Array.isArray(show.capabilities) && show.capabilities.includes('completion');
  } catch { return false; }
}
