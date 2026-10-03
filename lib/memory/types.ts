// The memory model shared by the store, the remote client, the context manager and MCP.
export type Category = 'personal' | 'project' | 'session';
export type Status = 'active' | 'proposed' | 'archived';
export const CATEGORIES: Category[] = ['personal', 'project', 'session'];
export const STATUSES: Status[] = ['active', 'proposed', 'archived'];

// Who is asking. Always built from the caller's environment (cwd, CLAUDE_PROJECT_DIR), never from tool arguments.
export type Ctx = { projectId: string | null; sessionId: string | null; linked: string[]; source?: string };

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
// rank = FTS5 bm25(): lower is better; 0 when listing without text. matched = distinct words of the query found in it (text searches).
export type Found = Memory & { rank: number; matched?: number };

export type ErrorCode = 'not_found' | 'conflict' | 'invalid' | 'unavailable';
// Messages never quote stored content: they reach hosts, HTTP clients and logs.
export class MemoryError extends Error {
  code: ErrorCode;
  current?: number;
  constructor(code: ErrorCode, message: string, current?: number) { super(message); this.code = code; this.current = current; }
}

// The operations that travel between a client and a memory server. MemoryService is local; RemoteStore is HTTP.
export interface MemoryApi {
  store(input: StoreInput, ctx: Ctx): Promise<{ memory: Memory; duplicate: boolean }>;
  search(q: Query, ctx: Ctx): Promise<Found[]>;
  get(id: string, ctx: Ctx, opts?: { events?: boolean }): Promise<Memory & { events?: MemoryEvent[] }>;
  update(id: string, patch: Patch, expectedVersion: number, ctx: Ctx): Promise<Memory>;
  delete(id: string, ctx: Ctx): Promise<Memory>;
  accept(id: string, ctx: Ctx): Promise<Memory>;
  reject(id: string, ctx: Ctx): Promise<Memory>;
  close(): void;
}

// What the context manager ranks: curated memory, project docs, claude-mem.
export type Source = 'curated' | 'docs' | 'claude-mem';
export type Hit = { source: Source; id: string; title: string; text: string; category: string; rank: number; at: number; accessCount: number; hash?: string; matched?: number };
export interface MemoryProvider { name: Source; search(text: string, ctx: Ctx, limit: number): Promise<Hit[]> }
