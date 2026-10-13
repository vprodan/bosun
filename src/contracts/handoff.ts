import { z } from 'zod';
import { renderSummaryExcerpts } from '../core/use-cases/summarize-evidence.ts';
import { HOSTS } from '../core/domain/config.ts';

const text = z
  .string()
  .min(1)
  .max(2000)
  .refine((value) => !value.includes('\0'));
const list = z.array(text).max(40);
const id = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const relative = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.includes('\\') &&
      !value.includes('\0') &&
      value.split('/').every((part) => !!part && part !== '.' && part !== '..') &&
      !value.split('/').some((part) => ['.git', '.bosun', '.omp', '.claude', '.codex'].includes(part)),
  );
export const handoffFactsSchema = z.strictObject({
  objective: text,
  latestSteering: list,
  constraints: z.strictObject({ permissions: list, prohibitions: list, pendingApprovals: list }),
  decisions: z.array(z.strictObject({ fact: text, source: text })).max(40),
  questions: list,
  progress: z.strictObject({ completed: list, remaining: list, nextAction: text }),
  source: z.strictObject({
    hostId: z.enum(HOSTS),
    sessionId: text,
    model: text,
    effort: text.optional(),
    generation: z.number().int().min(0),
    access: z.enum(['read', 'edit']),
    completedEventCursor: text,
    uncertainEffects: list,
    evidenceHash: hash.optional(),
    bindingHash: hash.optional(),
  }),
  repository: z.strictObject({
    projectId: z.string().regex(/^p_[a-f0-9]{16}$/),
    branch: text,
    commit: revision,
    files: z
      .array(
        z.strictObject({
          path: relative,
          state: z.enum(['staged', 'unstaged', 'untracked']),
          sha256: hash,
        }),
      )
      .max(100),
    snapshot: z
      .strictObject({ revision: hash, indexHash: hash, statusHash: hash, contentHash: hash })
      .optional(),
  }),
  verification: z
    .array(
      z.strictObject({
        command: text,
        outcome: z.enum(['passed', 'failed', 'unverified']),
        revision,
        detail: text,
      }),
    )
    .max(40),
  runningJobs: z
    .array(
      z.strictObject({
        id,
        state: z.enum(['queued', 'held', 'running', 'unknown']),
        reconcile: text,
      }),
    )
    .max(40),
  parentId: id.nullable(),
});
export const evidenceSummarySchema = z
  .strictObject({
    text: z.string().min(1).max(8000),
    evidenceIds: z.array(id).max(16),
    providerId: text,
    model: text,
    excerpts: z
      .array(z.strictObject({ id, cursor: text.max(200), sha256: hash, quote: text.max(400) }))
      .min(1)
      .max(16),
    coverage: z.strictObject({
      events: z.number().int().min(1),
      chunks: z.number().int().min(1),
      lastCursor: text.max(200),
    }),
  })
  .refine(
    (value) =>
      value.text === renderSummaryExcerpts(value.excerpts) &&
      value.evidenceIds.join('\0') === value.excerpts.map((row) => row.id).join('\0') &&
      new Set(value.evidenceIds).size === value.evidenceIds.length,
  );
export const handoffManifestSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id,
    createdAt: z.number().int().min(0),
    privacy: z.literal('public'),
    facts: handoffFactsSchema,
    summary: evidenceSummarySchema.nullable(),
  })
  .refine(
    (value) =>
      !value.summary ||
      value.summary.coverage.lastCursor === value.facts.source.completedEventCursor,
  );
export const handoffBundleSchema = z.strictObject({
  manifest: handoffManifestSchema,
  manifestHash: hash,
  markdown: z.string().min(1).max(120000),
  markdownHash: hash,
});
export const handoffCreateSchema = z.strictObject({
  privacy: z.literal('public'),
  requestId: id,
  facts: handoffFactsSchema,
});
export const handoffSummarizeSchema = z.strictObject({
  privacy: z.literal('public'),
  requestId: id,
  facts: handoffFactsSchema,
  afterCursor: text.max(200).nullable(),
  evidence: z
    .array(
      z.strictObject({
        privacy: z.literal('public'),
        id,
        cursor: text.max(200),
        text: z.string().min(1).max(8192),
      }),
    )
    .min(1)
    .max(100),
});
export type HandoffFacts = z.infer<typeof handoffFactsSchema>;
export type HandoffManifest = z.infer<typeof handoffManifestSchema>;
export type HandoffBundle = z.infer<typeof handoffBundleSchema>;
