import type { Access } from './task.ts';

// A terminal/worktree handle is not a native managed-session identity.
export type ManagedSession = { hostId: string; sessionId: string; ownerId: string; generation: number; model: string; access: Access };
export type ContextSample = {
  sessionId: string; turnId: string; modelId: string; usedTokens: number | null; windowTokens: number | null;
  scope: 'active-total' | 'body-only' | 'unknown'; observedAt: number; generation: number;
  quality: 'observed' | 'estimated' | 'unknown'; nativeAutoLimit?: number;
};
export type AdmissionFence = { sessionId: string; generation: number; token: string };
export type Quiescence = { sessionId: string; generation: number; pendingTools: 0; idle: true };
export type FreshReadiness = {
  sessionId: string; root: true; idle: true; seedHash: string; model: string; access: Access; generation: number;
};
