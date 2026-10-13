import type { Capability, Detect, Env, InferenceInput } from '../domain/inference.ts';
import type { RoleDefinition } from '../roles.ts';
import type { RunEvent } from './runner.ts';
import type {
  AdmissionFence,
  ContextSample,
  FreshReadiness,
  ManagedSession,
  Quiescence,
  SessionEvidenceWindow,
} from '../domain/session.ts';

export type Check = { ok: boolean; label: string; fix?: string };
export type FileChange =
  | Readonly<{ op: 'write'; path: string; text: string }>
  | Readonly<{ op: 'link'; path: string; target: string }>
  | Readonly<{ op: 'remove'; path: string }>;
export type HostBundle = {
  roles: (RoleDefinition & { model?: string; effort?: string })[];
  skills: Readonly<Record<string, string>>;
  policy: string;
  mcp: { command: string; args: string[]; env: Record<string, string> };
  hook: { command: string; args: string[]; timeoutS: number; env: Record<string, string> };
};
export type HostSettings = Readonly<{ root: string; nativeVersion: string }>;
export type HostLaunch = Readonly<{
  args: readonly string[];
  env: Readonly<Record<string, string>>;
}>;
export type PromptEvent = InferenceInput & { sessionId: string | null; cwd: string };
export type ManagedCapability =
  | 'contextTelemetry'
  | 'promptAdmission'
  | 'toolQuiescence'
  | 'freshSession'
  | 'seedWithoutInference'
  | 'freshReadiness';
// Native controls are contracts only. No current host is declared qualified by these definitions.
export interface ManagedSessionControl {
  readonly caps: Partial<Record<ManagedCapability, Capability>>;
  observeContext(session: ManagedSession, signal: AbortSignal): Promise<ContextSample>;
  fenceAdmission(session: ManagedSession, signal: AbortSignal): Promise<AdmissionFence>;
  quiesce(session: ManagedSession, fence: AdmissionFence, signal: AbortSignal): Promise<Quiescence>;
  startFresh(source: ManagedSession, signal: AbortSignal): Promise<ManagedSession>;
  seed(
    session: ManagedSession,
    input: InferenceInput & { hash: string },
    signal: AbortSignal,
  ): Promise<void>;
  ready(
    session: ManagedSession,
    expected: { seedHash: string; model: string; access: 'read' | 'edit' },
    signal: AbortSignal,
  ): Promise<FreshReadiness>;
  capture?(
    session: ManagedSession,
    input: { privacy: 'public'; afterCursor: string | null },
    signal: AbortSignal,
  ): Promise<SessionEvidenceWindow>;
}
// Native lifecycle facets remain part of HostAdapter, not another executor port.
export type ManagedSessionCreate = {
  privacy: 'public';
  ownerId: string;
  generation: number;
  requestId: string;
  cwd: string;
  model: string;
  effort?: string;
  access: 'read' | 'edit';
};
export interface ManagedSessionDriver extends ManagedSessionControl {
  // Persistent native processes must join before daemon ownership is released.
  close?(): Promise<void>;
  create(input: ManagedSessionCreate, signal: AbortSignal): Promise<ManagedSession>;
  run(
    session: ManagedSession,
    input: { privacy: 'public'; text: string; turnId: string },
    signal: AbortSignal,
  ): Promise<RunEvent[]>;
}
export interface HostAdapter {
  readonly id: string;
  readonly caps: {
    subagents: Capability;
    plugins: Capability;
    promptHook: Capability;
    hookTrust: Capability;
    mcpStdio: Capability;
    readsAgentsMd: Capability;
    skillsDirs: string[];
  };
  detect(env: Env): Promise<Detect>;
  plan(bundle: HostBundle, settings: HostSettings): Promise<FileChange[]>;
  planUninstall(ownedChanges: readonly FileChange[]): Promise<FileChange[]>;
  doctor(bundle: HostBundle, settings: HostSettings): Promise<Check[]>;
  launch(bundle: HostBundle, settings: HostSettings): HostLaunch;
  roleRef(role: string): string;
  session(env: Env): { active: boolean; projectDir?: string; sessionId?: string };
  hook: { parse(stdin: string, env: Env): PromptEvent | null; format(context: string): string };
  readonly control?: ManagedSessionControl;
}
