export type Category = 'personal' | 'project' | 'session';
export type Status = 'active' | 'proposed' | 'archived';
export const CATEGORIES: Category[] = ['personal', 'project', 'session'];
export const STATUSES: Status[] = ['active', 'proposed', 'archived'];
// Caller scope comes from the environment, never model-facing arguments.
export type Ctx = { projectId: string | null; sessionId: string | null; linked: string[]; source?: string; audience?: 'owner' | 'model' };
export type Memory = {
  id: string; category: Category; projectId: string | null; sessionId: string | null;
  title: string; body: string; tags: string[]; status: Status; shared: boolean; private: boolean;
  source: string; sourceRef: string | null; hash: string;
  createdAt: number; updatedAt: number; expiresAt: number | null; accessedAt: number | null; accessCount: number; version: number;
};
export type MemoryEvent = { op: string; at: number; source: string; hashBefore: string | null; hashAfter: string | null };
export type StoreInput = {
  category: Category; title: string; body: string; tags?: string[]; private?: boolean; shared?: boolean; ttlDays?: number;
  status?: 'active' | 'proposed'; source?: string; sourceRef?: string;
};
export type Patch = { title?: string; body?: string; tags?: string[]; status?: 'active' | 'archived'; private?: boolean; shared?: boolean };
export type Query = { text?: string; category?: Category; status?: Status[]; tags?: string[]; limit?: number; includePrivate?: boolean; touch?: boolean };
export type Found = Memory & { rank: number; matched?: number };
