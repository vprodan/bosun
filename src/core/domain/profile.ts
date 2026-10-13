import type { HostId, ProviderSettings } from './config.ts';
import type { Capability } from './inference.ts';

export const PROFILE_LIMITS = Object.freeze({ bytes: 65536, instructions: 8000, roles: 32, providers: 16 });
export const PROFILE_CAPABILITIES = ['bosun.profile.1', 'host.omp', 'host.opencode', 'host.codex', 'host.claude', 'provider.ollama',
  'provider.openai-compatible', 'provider.codex-cli', 'provider.claude-cli', 'router.systemone', 'reviewed-profile.1', 'agent-skills.1'] as const;
export type ProfileCapability = typeof PROFILE_CAPABILITIES[number];
export type PortableProvider = { id: string; kind: ProviderSettings['kind']; model: string; timeoutMs: number;
  endpoint?: 'RECONFIGURE_LOCALLY'; credential: 'RECONFIGURE_LOCALLY' | 'NATIVE_AUTH_OUTSIDE_PROFILE' };
export type PortableProfile = {
  schemaVersion: 1; kind: 'bosun-portable-profile'; name: string; description: string; capabilities: ProfileCapability[];
  choices: {
    primaryHost: HostId;
    roles: { role: string; host: HostId; model?: string; effort?: string }[];
    providers: PortableProvider[];
    router?: { model: string; timeoutMs: number; minConfidence: number; digest?: string; endpoint: 'RECONFIGURE_LOCALLY' };
    local?: { model: string; fallback: string; contextTokens: number; maxTurns: number; timeoutMs: number };
  };
  reviewed?: { origin: 'owner-reviewed-current-L4'; instructions: string };
};
export type ProfileSelection = { name: string; description: string; roles: string[]; providers: string[]; router?: boolean; local?: boolean;
  reviewedProfile?: { id: string; version: number } };
export type ProfileDocument = { format: 'toml' | 'skill'; content: string };
export type ProfileCapabilities = { features?: Partial<Record<ProfileCapability, Capability>>; models?: Readonly<Record<string, Capability>> };
export type ProfileChange = { target: string; operation: 'add' | 'replace' | 'unchanged'; before: string | number | null; after: string | number; conflict: boolean };
export type ProfilePreview = {
  schemaVersion: 1; state: 'held' | 'reviewable'; dryRun: true; applies: false; targetHost: HostId;
  changes: ProfileChange[]; conflicts: string[];
  requirements: { capability: string; state: Capability }[];
  reconfigure: { target: string; placeholder: 'RECONFIGURE_LOCALLY' | 'NATIVE_AUTH_OUTSIDE_PROFILE' }[];
  skill: { path: string; operation: 'create-or-review-existing'; content: string };
};
