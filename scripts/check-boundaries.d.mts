export type BoundaryResult = { files: number; edges: number; violations: string[] };
export function checkBoundaries(options?: { root?: string }): BoundaryResult;
