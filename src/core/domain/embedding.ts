export type EmbeddingSpace = {
  model: string;
  digest: string;
  dimensions: number;
  transform: 'embeddinggemma-v1' | 'plain-v1';
};
export type EmbeddingSource = {
  memoryId: string;
  version: number;
  hash: string;
  title: string;
  body: string;
};
export type EmbeddingRecord = {
  id: string;
  memoryId: string;
  version: number;
  hash: string;
  chunk: number;
  start: number;
  end: number;
  space: EmbeddingSpace;
  inputHash: string;
  vector: number[];
};
export type VectorCandidate = {
  memoryId: string;
  chunk: number;
  start: number;
  end: number;
  cosine: number;
  title: string;
  text: string;
  category: string;
  at: number;
  hash: string;
};
