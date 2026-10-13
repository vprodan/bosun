export type RouterStatusReason = 'ready' | 'model_unloaded' | 'endpoint_unavailable' | 'unsupported_version' | 'version_unverified'
  | 'model_missing' | 'metadata_invalid' | 'unsupported_model' | 'capability_missing' | 'digest_mismatch' | 'digest_changed' | 'loaded_identity_mismatch'
  | 'residency_unknown' | 'cancelled' | 'timeout';
export type RouterLoaded = { state: 'loaded' | 'unloaded' | 'unknown'; digest: string | null; runner: 'mlx' | 'ggml' | 'llamacpp' | null;
  contextTokens: number | null; sizeBytes: number | null; vramBytes: number | null; expiresAt: number | null };
export type RouterStatus = {
  provider: 'ollama'; protocol: 'systemone'; endpoint: string; model: string; resolvedModel: string | null;
  state: 'ready' | 'cold' | 'held' | 'unavailable'; reason: RouterStatusReason; observedAt: number;
  version: string | null; requiresVersion: string | null; inspectedVersion: boolean; available: boolean | null; digest: string | null; tagDigest: string | null; expectedDigest: string | null;
  decisionCapability: 'reported' | 'absent' | 'unknown'; format: 'gguf' | 'safetensors' | null; runner: RouterLoaded['runner'];
  catalogContextTokens: number | null; loaded: RouterLoaded;
  qualification: { calibration: 'unverified'; liveReadiness: 'unverified'; autonomousDelegation: 'unsupported' };
  automaticDispatch: false;
};
