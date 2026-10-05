import type { Capability, Env } from '../domain/inference.ts';
import type { WorkspaceRef } from '../domain/task.ts';
import type { ManagedSession } from '../domain/session.ts';

export interface Workspace {
  readonly id: string;
  readonly caps: { pane: Capability; status: Capability; agentTerminal: Capability };
  active(env: Env): Promise<boolean>;
  create(options: { name: string; from: string; baseBranch?: string }): Promise<WorkspaceRef>;
  remove(id: string): Promise<void>;
  pane?(options: { command: string[]; title: string; near?: string }): Promise<{ handle: string } | null>;
  status?(worktree: string, status: string, comment?: string): Promise<void>;
  // An agent terminal alone does not qualify fresh-session handoff; return actual native identity when known.
  startAgent?(worktree: string, options: { host: string; prompt: string; model?: string; effort?: string }): Promise<{ handle: string; session?: ManagedSession }>;
}
