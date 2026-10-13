import type { Capability, Env } from '../domain/inference.ts';
import type { WorkspaceRef } from '../domain/task.ts';
import type { ManagedSession } from '../domain/session.ts';
import type { WorkspaceRepository, WorkspaceRecord, WorkspaceInspection } from '../domain/workspace.ts';
import type { CardBinding, CardObservation, CardStatus } from '../domain/card.ts';

export type WorkspaceWatch = {
  prepare(root: string, near: string | null, signal: AbortSignal): Promise<CardBinding>;
  open(binding: CardBinding, near: string | null, command: string, signal: AbortSignal, entered: () => void): Promise<string>;
  observe(binding: CardBinding, handle: string, signal: AbortSignal): Promise<'connected' | 'closed'>;
};

export type WorkspaceCard = {
  current(from: string, signal: AbortSignal): Promise<CardObservation>;
  observe(binding: CardBinding, signal: AbortSignal): Promise<CardObservation>;
  update(binding: CardBinding, status: CardStatus, comment: string | undefined, signal: AbortSignal): Promise<CardObservation>;
};

export interface Workspace {
  readonly id: string;
  readonly caps: { pane: Capability; status: Capability; agentTerminal: Capability };
  active(env: Env): Promise<boolean>;
  create(options: { name: string; from: string; baseBranch?: string; signal?: AbortSignal }): Promise<WorkspaceRef>;
  remove(id: string): Promise<void>;
  repository?(from: string, base?: string, signal?: AbortSignal): Promise<WorkspaceRepository>;
  inspect?(record: WorkspaceRecord, signal?: AbortSignal): Promise<WorkspaceInspection>;
  pane?(options: { command: string[]; title: string; near?: string }): Promise<{ handle: string } | null>;
  status?(worktree: string, status: string, comment?: string): Promise<void>;
  // An agent terminal alone does not qualify fresh-session handoff; return actual native identity when known.
  startAgent?(worktree: string, options: { host: string; prompt: string; model?: string; effort?: string }): Promise<{ handle: string; session?: ManagedSession }>;
}
