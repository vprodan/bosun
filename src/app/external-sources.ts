import path from 'node:path';
import { z } from 'zod';
import { BosunError } from '../core/errors.ts';
import type { RuntimeConfig } from '../core/domain/config.ts';
import type { Ctx } from '../core/domain/memory.ts';
import type { Env } from '../core/domain/inference.ts';
import type { ContextSource } from '../core/ports/context-source.ts';
import type { RuntimePaths } from '../platform/paths.ts';
import { readPrivateFile, writePrivateFile } from '../platform/private-file.ts';
import { ClaudeMemSource, claudeMemRevision, type ClaudeMemReviewedRef } from '../adapters/memory/claude-mem.ts';

const text = z.string().min(1).max(200).refine(value => !value.includes('\0'));
const ref = z.strictObject({ kind: z.enum(['observation', 'summary']), id: z.number().int().min(1), projectId: z.string().regex(/^p_[a-f0-9]{16}$/),
  nativeProject: text, nativeSessionId: text, createdAt: z.number().int().min(0).max(8640000000000000), privacy: z.literal('public'), scope: z.enum(['project', 'session']), callerSessionId: text.optional() });
const reviewSchema = z.strictObject({ schemaVersion: z.literal(1), revision: z.string().regex(/^\d+:\d+:\d+:\d+:\d+$/), records: z.array(ref).max(200) });
const REVIEW_FILE = 'claude-mem-review.json';
export function claudeMemFile(config: RuntimeConfig, env: Env): string | undefined {
  return config.memory.claudeMemDb ?? (env.HOME && path.isAbsolute(env.HOME) ? path.join(env.HOME, '.claude-mem', 'claude-mem.db') : undefined);
}
export function approveClaudeMemReview(input: unknown, projectId: string, paths: RuntimePaths, config: RuntimeConfig, env: Env): { records: number } {
  const checked = reviewSchema.safeParse(input);
  if (!checked.success || checked.data.records.some(record => record.projectId !== projectId || record.scope === 'session' && !record.callerSessionId)) throw new BosunError('invalid', 'Invalid external memory review');
  const file = claudeMemFile(config, env);
  if (!config.memory.claudeMem || !file || claudeMemRevision(file) !== checked.data.revision) throw new BosunError('unverified', 'External memory revision changed or unavailable');
  let records = checked.data.records;
  try {
    const existing = reviewSchema.safeParse(JSON.parse(readPrivateFile(path.join(paths.home, REVIEW_FILE), 65536)));
    if (!existing.success) throw new BosunError('unavailable', 'External memory review unavailable');
    if (existing.data.revision === checked.data.revision) records = [...existing.data.records.filter(record => record.projectId !== projectId), ...records];
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') throw new BosunError('unavailable', 'External memory review unavailable');
  }
  const encoded = JSON.stringify({ ...checked.data, records }) + '\n';
  if (records.length > 200 || Buffer.byteLength(encoded) > 65536) throw new BosunError('invalid', 'External memory review exceeds bounds');
  writePrivateFile(path.join(paths.home, REVIEW_FILE), encoded);
  return { records: checked.data.records.length };
}

// No file discovery/import effects on construction. Ordinary context requests
// select only reviewed refs; unknown original observations are never inferred public.
export function externalSources(config: RuntimeConfig, paths: RuntimePaths, env: Env): readonly ContextSource[] {
  if (!config.memory.claudeMem) return Object.freeze([]);
  let closed = false;
  const source: ContextSource = {
    id: 'claude-mem', trust: 'verified', weight: 0.6, halfLifeDays: 30,
    async search(text: string, caller: Ctx, limit: number) {
      if (closed) return [];
      try {
        const parsed = reviewSchema.safeParse(JSON.parse(readPrivateFile(path.join(paths.home, REVIEW_FILE), 65536)));
        if (!parsed.success || parsed.data.records.some(record => record.scope === 'session' && !record.callerSessionId)) return [];
        const records: ClaudeMemReviewedRef[] = parsed.data.records;
        const projects = new Map<string, Set<string>>();
        for (const record of records) { if (!projects.has(record.projectId)) projects.set(record.projectId, new Set()); projects.get(record.projectId)!.add(record.nativeProject); }
        const adapter = new ClaudeMemSource({ file: claudeMemFile(config, env), projects: [...projects].map(([projectId, nativeProjects]) => ({ projectId, nativeProjects: [...nativeProjects] })), review: () => parsed.data });
        try { return await adapter.search(text, caller, limit); } finally { adapter.close(); }
      } catch { return []; }
    },
    close() { closed = true; },
  };
  return Object.freeze([source]);
}
