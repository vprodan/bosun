import type { Access } from '../domain/task.ts';
import type { Capability, Detect, Env, InputPrivacy } from '../domain/inference.ts';

export type RunSpec = {
  prompt: string; privacy: InputPrivacy; cwd: string; access: Access; model?: string; effort?: string; maxTurns?: number;
  mcp?: { name: string; command: string; args: string[] }[]; env?: Env; signal: AbortSignal;
};
export type RunEvent =
  | { t: 'text'; text: string } | { t: 'tool'; name: string; target?: string }
  | { t: 'file'; path: string; op: 'edit' | 'create' | 'delete' }
  | { t: 'permission'; tool: string; decision: 'allow' | 'deny' }
  | { t: 'usage'; tokensIn?: number; tokensOut?: number }
  | { t: 'done'; code: number; result: string };
export interface AgentRunner {
  readonly id: string;
  readonly caps: {
    vendor: string; readOnly: Capability; sandbox: 'os' | 'tool-allowlist' | 'none' | 'unverified';
    mcpInject: Capability; effort: Capability; localBackend: Capability; billing: 'subscription' | 'api' | 'local' | 'unknown';
  };
  detect(env: Env): Promise<Detect>;
  run(spec: RunSpec): AsyncIterable<RunEvent>;
}
