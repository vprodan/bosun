// Unknown includes unscreened/unclassified input; local inference does not relax this boundary.
export type InputPrivacy = 'public' | 'private' | 'unknown';
export type InferenceInput = { text: string; privacy: InputPrivacy };
export type JsonSchema = Readonly<Record<string, unknown>>;
export type Capability = 'verified' | 'unsupported' | 'unverified';
export type Env = Readonly<Record<string, string | undefined>>;
export type Detect = { installed: boolean; version?: string; path?: string; notes?: string[] };
