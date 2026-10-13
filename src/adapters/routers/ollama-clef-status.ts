import { BosunError } from '../../core/errors.ts';
import type { RouterLoaded, RouterStatus, RouterStatusReason } from '../../core/domain/router-status.ts';
import { httpJson, protocolBase } from '../../platform/http-json.ts';
import { CLEF_DEFAULT_MODEL, CLEF_QUALIFICATION, type ClefSettings } from './ollama-clef.ts';

// Source-inspected protocol pairs, not live model/calibration qualifications.
export const CLEF_INSPECTED_VERSIONS = Object.freeze(['0.35.1', '0.40.0']);
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const nonnegative = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const context = (value: unknown): number | null => nonnegative(value) && Number(value) >= 1 && Number(value) <= 1048576 ? Number(value) : null;
const bytes = (value: unknown): number | null => nonnegative(value) ? Number(value) : null;
const digest = (value: unknown): string | null => typeof value === 'string' && /^(?:sha256:)?[a-f0-9]{64}$/.test(value) ? value.replace(/^sha256:/, '') : null;
const runner = (value: unknown): RouterLoaded['runner'] => ['mlx', 'ggml', 'llamacpp'].includes(String(value)) ? value as RouterLoaded['runner'] : null;
const remote = (value: Record<string, unknown>) => value.remote_host !== undefined && value.remote_host !== '' || value.remote_model !== undefined && value.remote_model !== '';
const unknownLoaded = (): RouterLoaded => ({ state: 'unknown', digest: null, runner: null, contextTokens: null, sizeBytes: null, vramBytes: null, expiresAt: null });
// Native display names add the documented default latest tag and omit the default registry/library prefix.
function identity(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 100 || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(value)) return null;
  let name = value.toLowerCase().replace(/^registry\.ollama\.ai\/library\//, '').replace(/^library\//, '');
  if (name.lastIndexOf(':') <= name.lastIndexOf('/')) name += ':latest';
  return name;
}
function models(value: unknown): Record<string, unknown>[] {
  const rows = object(value)?.models;
  if (!Array.isArray(rows) || rows.length > 1024 || rows.some((row) => !object(row))) throw new BosunError('invalid', 'Invalid router metadata');
  return rows as Record<string, unknown>[];
}
function selected(rows: Record<string, unknown>[], expected: string): Record<string, unknown> | null {
  const matching = rows.filter((row) => identity(row.model) === expected || identity(row.name) === expected);
  if (matching.length > 1 || matching.some((row) => identity(row.model) !== expected || identity(row.name) !== expected)) throw new BosunError('invalid', 'Invalid router metadata');
  return matching[0] ?? null;
}
function catalogContext(info: unknown): number | null {
  const fields = object(info); const architecture = fields?.['general.architecture'];
  if (!fields || typeof architecture !== 'string' || !/^[a-z0-9_]{1,64}$/.test(architecture)) return null;
  return context(fields[`${architecture}.context_length`]);
}
function expiry(value: unknown): number | null {
  if (typeof value !== 'string' || value.length > 64 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const stamp = Date.parse(value); return Number.isSafeInteger(stamp) && stamp >= 0 && stamp <= 8640000000000000 ? stamp : null;
}
function older(version: string): boolean { const [major, minor, patch] = version.split('.').map(Number); return major === 0 && (minor < 35 || minor === 35 && patch < 1); }
function requiresNewer(required: string, current: string): boolean {
  const minimum = required.split('.').map(Number); const have = current.split('.').map(Number);
  for (let index = 0; index < 3; index++) if (minimum[index] !== have[index]) return minimum[index] > have[index];
  return false;
}
export function createClefReadiness(settings: ClefSettings, { now = () => Date.now() }: { now?: () => number } = {}) {
  let configuration: { url: string; model: string; identity: string; timeoutMs: number; digest: string | null } | undefined;
  let pinned: { tag: string; digest: string; runner: RouterLoaded['runner'] } | undefined;
  function configured() {
    if (configuration) return configuration;
    const model = settings.model ?? CLEF_DEFAULT_MODEL; const key = identity(model); const timeoutMs = settings.timeoutMs ?? 1000;
    if (!key || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000 || settings.digest !== undefined && !digest(settings.digest)) throw new BosunError('invalid', 'Invalid router readiness configuration');
    return configuration = Object.freeze({ url: protocolBase(settings.url), model, identity: key, timeoutMs, digest: settings.digest === undefined ? null : digest(settings.digest) });
  }
  return { async status(signal: AbortSignal): Promise<RouterStatus> {
    const cfg = configured(); const at = now(); if (!Number.isSafeInteger(at) || at < 0 || at > 8640000000000000) throw new BosunError('unavailable', 'Router clock unavailable');
    const result: RouterStatus = { provider: 'ollama', protocol: 'systemone', endpoint: cfg.url, model: cfg.model, resolvedModel: null,
      state: 'unavailable', reason: 'endpoint_unavailable', observedAt: at, version: null, requiresVersion: null, inspectedVersion: false, available: null,
      digest: null, tagDigest: null, expectedDigest: cfg.digest ?? pinned?.digest ?? null, decisionCapability: 'unknown', format: null, runner: null,
      catalogContextTokens: null, loaded: unknownLoaded(), qualification: CLEF_QUALIFICATION, automaticDispatch: false };
    const finish = (state: RouterStatus['state'], reason: RouterStatusReason) => ({ ...result, state, reason });
    let stage: 'version' | 'metadata' = 'version';
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(cfg.timeoutMs)]);
    const read = (suffix: string, body?: object) => httpJson(cfg.url + suffix, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: deadline }, cfg.timeoutMs, 512 * 1024);
    try {
      deadline.throwIfAborted(); const version = object(await read('/api/version'))?.version;
      if (typeof version !== 'string' || !/^\d{1,3}\.\d{1,3}\.\d{1,3}(?:[-+][a-zA-Z0-9.-]{1,32})?$/.test(version)) return finish('held', 'metadata_invalid');
      result.version = version;
      if (!CLEF_INSPECTED_VERSIONS.includes(version)) return finish('held', older(version) ? 'unsupported_version' : 'version_unverified');
      result.inspectedVersion = true; stage = 'metadata';
      const tag = selected(models(await read('/api/tags')), cfg.identity);
      if (!tag) { result.available = false; return finish('held', 'model_missing'); }
      result.available = true; result.resolvedModel = String(tag.model); result.tagDigest = digest(tag.digest);
      if (!result.tagDigest) return finish('held', 'metadata_invalid'); if (remote(tag)) return finish('held', 'unsupported_model');
      if (pinned && pinned.tag !== result.tagDigest) return finish('held', 'digest_changed');
      const info = object(await read('/api/show', { model: cfg.model, verbose: false }));
      if (!info) return finish('held', 'metadata_invalid'); if (remote(info)) return finish('held', 'unsupported_model');
      if (info.requires !== undefined && info.requires !== '') {
        if (typeof info.requires !== 'string' || !/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(info.requires)) return finish('held', 'metadata_invalid');
        result.requiresVersion = info.requires; if (requiresNewer(info.requires, version)) return finish('held', 'unsupported_version');
      }
      if (!Array.isArray(info.capabilities) || info.capabilities.length > 32 || info.capabilities.some((v) => typeof v !== 'string')) return finish('held', 'metadata_invalid');
      result.decisionCapability = info.capabilities.includes('decision') ? 'reported' : 'absent';
      if (result.decisionCapability === 'absent') return finish('held', 'capability_missing');
      let format = object(info.details)?.format; result.digest = result.tagDigest;
      if (info.manifests !== undefined) {
        if (version !== '0.40.0' || !Array.isArray(info.manifests) || info.manifests.length < 1 || info.manifests.length > 16 || info.manifests.some((v) => !object(v))) return finish('held', 'metadata_invalid');
        const choices = info.manifests.map(object).filter((v) => v?.selected === true);
        if (choices.length !== 1) return finish('held', 'metadata_invalid');
        const choice = choices[0]!; result.digest = digest(choice.digest); result.runner = runner(choice.runner); format = choice.format;
        if (!result.digest || !result.runner) return finish('held', 'metadata_invalid');
      }
      result.format = format === 'gguf' || format === 'safetensors' ? format : null;
      if (!result.format || result.format === 'safetensors' && (version !== '0.40.0' || result.runner !== 'mlx')) return finish('held', 'unsupported_model');
      result.catalogContextTokens = catalogContext(info.model_info);
      if (cfg.digest && cfg.digest !== result.digest) return finish('held', 'digest_mismatch');
      if (pinned && (pinned.digest !== result.digest || pinned.runner !== result.runner)) return finish('held', 'digest_changed');
      const loadedRows = models(await read('/api/ps')).filter((row) => identity(row.model) === cfg.identity || identity(row.name) === cfg.identity);
      if (loadedRows.some((row) => identity(row.model) !== cfg.identity || identity(row.name) !== cfg.identity)) return finish('held', 'metadata_invalid');
      const exactLoaded = loadedRows.filter((row) => digest(row.digest) === result.digest && (result.runner === null || runner(row.runner) === result.runner));
      if (exactLoaded.length > 1) return finish('held', 'metadata_invalid');
      if (loadedRows.length && !exactLoaded.length) return finish('held', 'loaded_identity_mismatch');
      const loaded = exactLoaded[0] ?? null;
      if (!loaded) {
        result.loaded = { ...unknownLoaded(), state: 'unloaded' };
        pinned ??= { tag: result.tagDigest, digest: result.digest!, runner: result.runner }; result.expectedDigest = cfg.digest ?? pinned.digest;
        return finish('cold', 'model_unloaded');
      }
      const loadedDigest = digest(loaded.digest); const loadedRunner = runner(loaded.runner);
      result.loaded = { state: 'loaded', digest: loadedDigest, runner: loadedRunner, contextTokens: context(loaded.context_length), sizeBytes: bytes(loaded.size),
        vramBytes: bytes(loaded.size_vram), expiresAt: expiry(loaded.expires_at) };
      if (loadedDigest !== result.digest || result.runner !== null && loadedRunner !== result.runner) return finish('held', 'loaded_identity_mismatch');
      if (!result.loaded.contextTokens || result.loaded.sizeBytes === null || result.loaded.vramBytes === null || !result.loaded.expiresAt || result.loaded.expiresAt <= at) return finish('held', 'residency_unknown');
      pinned ??= { tag: result.tagDigest, digest: result.digest!, runner: result.runner }; result.expectedDigest = cfg.digest ?? pinned.digest;
      return finish('ready', 'ready');
    } catch (error) {
      if (deadline.aborted) return finish('unavailable', signal.aborted && signal.reason?.name !== 'TimeoutError' ? 'cancelled' : 'timeout');
      if (error instanceof BosunError && error.code === 'invalid') return finish('held', 'metadata_invalid');
      return finish('unavailable', stage === 'version' ? 'endpoint_unavailable' : 'metadata_invalid');
    }
  } };
}
