import type { Capability, InputPrivacy, JsonSchema } from '../domain/inference.ts';

export type Msg = { role: 'system' | 'user' | 'assistant'; content: string };
export type GenRequest = { task: string; privacy: InputPrivacy; messages: Msg[]; schema?: JsonSchema; model?: string; signal: AbortSignal };
export type GenResult = { text: string; json?: unknown; model: string; tokensIn?: number; tokensOut?: number };
export interface ModelProvider {
  readonly id: string;
  readonly caps: { structured: Capability; local: Capability; numCtx: Capability; toolFree: Capability };
  // Only screened public inputs, including local providers. Policy enforcement precedes adapter calls.
  generate(request: GenRequest): Promise<GenResult>;
  health(signal: AbortSignal): Promise<boolean>;
}
