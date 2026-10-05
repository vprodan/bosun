import type { Capability, Detect, Env, InferenceInput } from '../domain/inference.ts';
import type { Role } from '../domain/task.ts';
import type { AdmissionFence, ContextSample, FreshReadiness, ManagedSession, Quiescence } from '../domain/session.ts';

export type Check = { ok: boolean; label: string; fix?: string };
export type FileChange =
  | { op: 'write'; path: string; text: string; owned: boolean }
  | { op: 'link'; path: string; target: string }
  | { op: 'block'; path: string; text: string }
  | { op: 'json'; path: string; patch: (json: unknown) => unknown }
  | { op: 'run'; cmd: string; args: string[]; env?: Env; undo?: { cmd: string; args: string[] } };
export type HostBundle = {
  roles: Role[]; skillsDir: string; policy: string; permissions: string[];
  mcp: { command: string; args: string[] }; hook: { command: string; timeoutS: number };
};
export type PromptEvent = InferenceInput & { sessionId: string | null; cwd: string };
export type ManagedCapability = 'contextTelemetry' | 'promptAdmission' | 'toolQuiescence' | 'freshSession' | 'seedWithoutInference' | 'freshReadiness';
// Native controls are contracts only. No current host is declared qualified by these definitions.
export interface ManagedSessionControl {
  readonly caps: Partial<Record<ManagedCapability, Capability>>;
  observeContext(session: ManagedSession, signal: AbortSignal): Promise<ContextSample>;
  fenceAdmission(session: ManagedSession, signal: AbortSignal): Promise<AdmissionFence>;
  quiesce(session: ManagedSession, fence: AdmissionFence, signal: AbortSignal): Promise<Quiescence>;
  startFresh(source: ManagedSession, signal: AbortSignal): Promise<ManagedSession>;
  seed(session: ManagedSession, input: InferenceInput & { hash: string }, signal: AbortSignal): Promise<void>;
  ready(session: ManagedSession, expected: { seedHash: string; model: string; access: 'read' | 'edit' }, signal: AbortSignal): Promise<FreshReadiness>;
}
export interface HostAdapter {
  readonly id: string;
  readonly caps: { subagents: Capability; plugins: Capability; promptHook: Capability; hookTrust: Capability; mcpStdio: Capability; readsAgentsMd: Capability; skillsDirs: string[] };
  detect(env: Env): Promise<Detect>;
  plan(bundle: HostBundle, settings: Readonly<Record<string, unknown>>): Promise<FileChange[]>;
  planUninstall(ownedChanges: readonly FileChange[]): Promise<FileChange[]>;
  doctor(bundle: HostBundle): Promise<Check[]>;
  roleRef(role: string): string;
  session(env: Env): { active: boolean; projectDir?: string; sessionId?: string };
  hook: { parse(stdin: string, env: Env): PromptEvent | null; format(context: string): string };
  readonly control?: ManagedSessionControl;
}
