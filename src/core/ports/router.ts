import type { Decision } from '../domain/route.ts';
import type { InferenceInput } from '../domain/inference.ts';

// Decision inference is separate from generative ModelProvider; IDs do not choose implementations.
export interface Router {
  readonly id: string;
  // Trusted configured label/model, never a response field. Used in output/telemetry.
  readonly label: string;
  classify(input: InferenceInput, signal: AbortSignal): Promise<Omit<Decision, 'router'> | null>;
}
