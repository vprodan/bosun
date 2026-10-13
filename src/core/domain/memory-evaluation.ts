import { requirePublicInput } from '../policy.ts';
import { data } from './job.ts';
import type { Category } from './memory.ts';
import type { GraphEntity, GraphRelation } from './graph.ts';

export const MEMORY_EVAL_CATEGORIES = [
  'identifier',
  'paraphrase',
  'rationale',
  'relationship',
  'current',
  'preference',
  'summary',
  'negative',
] as const;
export type MemoryEvalScope = { projectId: string | null; sessionId: string | null };
export type MemoryEvalNote = {
  privacy: 'public';
  id: string;
  sourceGroup: string;
  sessionGroup: string;
  scope: MemoryEvalScope;
  category: Category;
  title: string;
  body: string;
  tags: string[];
};
export type MemoryEvalCase = {
  privacy: 'public';
  id: string;
  split: 'development' | 'heldout';
  sourceGroup: string;
  sessionGroup: string;
  scope: MemoryEvalScope;
  category: (typeof MEMORY_EVAL_CATEGORIES)[number];
  query: string;
  supports: {
    id: string;
    grade: number;
    quote: string;
    alternatives?: { id: string; quote: string }[];
  }[];
};
export type MemoryEvalGraph = {
  privacy: 'public';
  reviewed: true;
  id: string;
  sourceGroup: string;
  sessionGroup: string;
  scope: MemoryEvalScope;
  kind: 'fact' | 'entity' | 'relation' | 'summary' | 'profile';
  title: string;
  text: string;
  supports: { id: string; quote: string }[];
  entity?: GraphEntity;
  relation?: GraphRelation;
  parents?: string[];
};
export type MemoryEvalDataset = {
  schema: 1;
  privacy: 'public';
  evidence: 'synthetic' | 'owner-reviewed';
  capturedAt: number;
  notes: MemoryEvalNote[];
  cases: MemoryEvalCase[];
  graph?: MemoryEvalGraph[];
};
export function memoryEvaluationPrivacy(input: unknown): void {
  requirePublicInput(input as { privacy?: unknown });
  // All classification must precede schema traversal, screening or payload access.
  for (const key of ['notes', 'cases', 'graph']) {
    if (key === 'graph' && input && typeof input === 'object' && !Object.hasOwn(input, key))
      continue;
    const rows = data(input, key);
    if (!Array.isArray(rows)) continue;
    for (let i = 0; i < rows.length; i++)
      requirePublicInput(data(rows, String(i)) as { privacy?: unknown });
  }
}

export type MemoryEvalObservation = {
  task: MemoryEvalCase;
  rawIds: string[];
  packedIds: string[];
  visibleSupportIds: string[];
  truncatedSupportIds: string[];
  zeroOverlapGraphIds?: string[];
  zeroOverlapVectorIds?: string[];
  estimatedTokens: number;
  searchMs: number;
  packingMs: number;
};
