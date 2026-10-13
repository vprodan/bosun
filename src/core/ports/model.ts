import type { Capability, InputPrivacy, JsonSchema } from '../domain/inference.ts';

export type Msg = { role: 'system' | 'user' | 'assistant'; content: string };
export type GenRequest = {
  task: string;
  privacy: InputPrivacy;
  messages: Msg[];
  schema?: JsonSchema;
  model?: string;
  signal: AbortSignal;
};
export type GenResult = {
  text: string;
  json?: unknown;
  model: string;
  tokensIn?: number;
  tokensOut?: number;
};
export type EmbedInput = { privacy: InputPrivacy; text: string; title?: string };
export type EmbedRequest = {
  privacy: InputPrivacy;
  inputs: EmbedInput[];
  purpose: 'query' | 'document';
  model?: string;
  digest?: string;
  dimensions: number;
  transform: 'embeddinggemma-v1' | 'plain-v1';
  signal: AbortSignal;
  verifySource?(): void;
};
export type EmbedResult = {
  model: string;
  digest: string;
  dimensions: number;
  transform: string;
  vectors: number[][];
  tokensIn?: number;
  totalNs?: number;
  loadNs?: number;
};
export interface ModelProvider {
  readonly id: string;
  readonly caps: {
    structured: Capability;
    local: Capability;
    numCtx: Capability;
    toolFree: Capability;
    embeddings?: Capability;
  };
  // Only screened public inputs, including local providers. Policy enforcement precedes adapter calls.
  generate(request: GenRequest): Promise<GenResult>;
  health(signal: AbortSignal): Promise<boolean>;
  embed?(request: EmbedRequest): Promise<EmbedResult>;
}
