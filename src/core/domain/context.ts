export type Source = string;
export type Hit = {
  source: Source; id: string; title: string; text: string; category: string; rank: number; at: number;
  accessCount: number; hash?: string; matched?: number;
};
export type ContextBundle = { items: (Hit & { score: number })[]; text: string; estTokens: number; sources: Record<string, number>; ms: number };
export type Summary = { id: string; project: string; request: string; learned: string; completed: string; at: number };
