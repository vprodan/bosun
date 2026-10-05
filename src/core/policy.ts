import { BosunError } from './errors.ts';
import type { Capability, InferenceInput } from './domain/inference.ts';

export function requirePublicInput(input: { privacy?: unknown } | null | undefined): void {
  let classification: PropertyDescriptor | undefined;
  try { classification = input && typeof input === 'object' ? Object.getOwnPropertyDescriptor(input, 'privacy') : undefined; }
  catch { /* revoked/throwing proxies are unclassified input */ }
  if (!classification || !Object.hasOwn(classification, 'value') || classification.value !== 'public') {
    throw new BosunError('private_input', 'Inference requires explicitly public input');
  }
}
export function requireCapability(state: Capability | undefined, action: string): void {
  if (state !== 'verified') throw new BosunError(state === 'unverified' ? 'unverified' : 'unsupported', `Capability unavailable: ${action}`);
}
// Use at new inference boundaries before reading text/messages or selecting an adapter.
export function publicInput(input: InferenceInput): InferenceInput {
  requirePublicInput(input);
  if (typeof input.text !== 'string') throw new BosunError('invalid', 'Expected input text');
  return input;
}
