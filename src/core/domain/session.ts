import type { Access } from './task.ts';
import type { SummaryEvidence } from './summary.ts';

// A terminal/worktree handle is not a native managed-session identity.
export type ManagedSession = {
  hostId: string;
  sessionId: string;
  ownerId: string;
  generation: number;
  model: string;
  access: Access;
};
export type ContextSample = {
  sessionId: string;
  turnId: string;
  modelId: string;
  usedTokens: number | null;
  windowTokens: number | null;
  scope: 'active-total' | 'body-only' | 'unknown';
  observedAt: number;
  generation: number;
  quality: 'observed' | 'estimated' | 'unknown';
  nativeAutoLimit?: number;
};
export type AdmissionFence = { sessionId: string; generation: number; token: string };
export type Quiescence = { sessionId: string; generation: number; pendingTools: 0; idle: true };
export type FreshReadiness = {
  sessionId: string;
  root: true;
  idle: true;
  seedHash: string;
  model: string;
  access: Access;
  generation: number;
};
// Content-free references; manifest/text live in immutable private artifacts.
export type HandoffPointer = {
  id: string;
  requestId: string;
  projectId: string;
  createdAt: number;
  manifestHash: string;
  markdownHash: string;
};
export type SessionEvidenceReference = Readonly<{
  evidenceId: string;
  messageId: string;
  partId: string;
  chunk: number;
  kind: 'user' | 'assistant' | 'tool-reference' | 'file-reference';
  sha256: string;
}>;
export type SessionEvidenceWindow = Readonly<{
  privacy: 'public';
  source: ManagedSession;
  coverage: 'admitted-public-text-and-native-references';
  afterCursor: string | null;
  completedEventCursor: string | null;
  snapshotHash: string;
  sourceBindingHash: string;
  totalEvents: number;
  complete: boolean;
  evidence: SummaryEvidence[];
  references: SessionEvidenceReference[];
}>;
