import type { Ctx } from './memory.ts';

export type GraphLevel = 0 | 1 | 2 | 3 | 4;
export type GraphKind = 'source' | 'fact' | 'entity' | 'relation' | 'summary' | 'profile';
export type GraphStatus = 'proposed' | 'active' | 'dirty' | 'archived';
export type GraphSupport = { memoryId: string; version: number; hash: string; start?: number; end?: number };
export type GraphParent = { id: string; version: number };
export type GraphEntity = { type: 'project' | 'file' | 'symbol' | 'tool' | 'concept'; key: string; aliases?: string[] };
export type GraphRelation = { from: string; to: string; predicate: 'uses' | 'depends_on' | 'implements' | 'related_to' | 'supports' | 'supersedes' | 'contradicts'; weight: number };
export type GraphProducer = { kind: 'owner' | 'deterministic' | 'model'; model: string | null; version: string };
export type GraphInput = {
  kind: GraphKind; title: string; text?: string; supports: GraphSupport[]; parents?: GraphParent[];
  entity?: GraphEntity; relation?: GraphRelation; validFrom?: number | null; validTo?: number | null;
  producer?: GraphProducer;
};
export type GraphArtifact = {
  id: string; level: GraphLevel; kind: GraphKind; title: string; text: string; status: GraphStatus; version: number;
  projectId: string | null; private: boolean; shared: boolean; recordedAt: number; invalidatedAt: number | null;
  sessionId: string | null;
  validFrom: number | null; validTo: number | null; expiresAt: number | null; hash: string;
  supports: GraphSupport[]; parents: GraphParent[]; producer: GraphProducer;
  entity?: GraphEntity; relation?: GraphRelation;
};
export type GraphQuery = { text: string; limit?: number; expand?: boolean; depth?: 1 | 2; levels?: GraphLevel[] };
export type GraphExplanation = { id: string; version: number; level: GraphLevel; supports: GraphSupport[]; parents: GraphParent[]; paths: string[][] };
export type GraphSearch = { items: (GraphArtifact & { score: number; paths: string[][] })[]; visited: number; edges: number; truncated: boolean };
export type GraphLimits = { seeds: number; visited: number; edges: number; depth: number };
export const GRAPH_LIMITS: Readonly<GraphLimits> = Object.freeze({ seeds: 20, visited: 64, edges: 128, depth: 2 });
export type GraphCaller = Ctx;
