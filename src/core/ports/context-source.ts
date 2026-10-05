import type { Hit, Source, Summary } from '../domain/context.ts';
import type { Ctx } from '../domain/memory.ts';
import type { Capability } from '../domain/inference.ts';

export interface ContextSource {
  readonly id: Source;
  readonly trust: Capability;
  readonly weight: number;
  readonly halfLifeDays: number;
  search(text: string, ctx: Ctx, limit: number): Promise<Hit[]>;
  summaries?(since: number, limit: number): Summary[];
  close?(): void;
}
// Compatibility only: old sources use name and fixed, explicitly allowlisted metadata in lib/context.
export interface MemoryProvider { name: Source; search(text: string, ctx: Ctx, limit: number): Promise<Hit[]> }
