import { z } from 'zod';
import { BosunError } from '../core/errors.ts';
import { screenPublicText } from '../core/secret-screen.ts';
import { norm } from '../core/text.ts';
import {
  MEMORY_EVAL_CATEGORIES,
  memoryEvaluationPrivacy,
  type MemoryEvalDataset,
} from '../core/domain/memory-evaluation.ts';

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const memoryId = z.string().regex(/^m_[a-z0-9]{1,62}$/);
const graphId = z.string().regex(/^g_[a-z0-9]{1,62}$/);
const scope = z.strictObject({
  projectId: z
    .string()
    .regex(/^p_[a-f0-9]{16}$/)
    .nullable(),
  sessionId: identifier.nullable(),
});
const group = { sourceGroup: identifier, sessionGroup: identifier, scope };
const schema = z.strictObject({
  schema: z.literal(1),
  privacy: z.literal('public'),
  evidence: z.enum(['synthetic', 'owner-reviewed']),
  capturedAt: z.number().int().min(0).max(8640000000000000),
  notes: z
    .array(
      z.strictObject({
        privacy: z.literal('public'),
        id: memoryId,
        ...group,
        category: z.enum(['personal', 'project', 'session']),
        title: z.string().min(1).max(200),
        body: z.string().min(1).max(4000),
        tags: z.array(z.string().regex(/^[a-z0-9-]{1,40}$/)).max(12),
      }),
    )
    .min(1)
    .max(200),
  graph: z
    .array(
      z.strictObject({
        privacy: z.literal('public'),
        reviewed: z.literal(true),
        id: graphId,
        ...group,
        kind: z.enum(['fact', 'entity', 'relation', 'summary', 'profile']),
        title: z.string().min(1).max(200),
        text: z.string().min(1).max(4000),
        supports: z
          .array(z.strictObject({ id: memoryId, quote: z.string().min(1).max(1000) }))
          .min(1)
          .max(8),
        entity: z
          .strictObject({
            type: z.enum(['project', 'file', 'symbol', 'tool', 'concept']),
            key: z.string().min(1).max(400),
            aliases: z.array(z.string().min(1).max(200)).max(12).optional(),
          })
          .optional(),
        relation: z
          .strictObject({
            from: graphId,
            to: graphId,
            predicate: z.enum([
              'uses',
              'depends_on',
              'implements',
              'related_to',
              'supports',
              'supersedes',
              'contradicts',
            ]),
            weight: z.number().min(0).max(1),
          })
          .optional(),
        parents: z.array(graphId).max(8).optional(),
      }),
    )
    .max(100)
    .optional(),
  cases: z
    .array(
      z.strictObject({
        privacy: z.literal('public'),
        id: identifier,
        ...group,
        split: z.enum(['development', 'heldout']),
        category: z.enum(MEMORY_EVAL_CATEGORIES),
        query: z.string().min(1).max(2000),
        supports: z
          .array(
            z.strictObject({
              id: memoryId,
              grade: z.number().int().min(1).max(3),
              quote: z.string().min(1).max(1000),
              alternatives: z
                .array(z.strictObject({ id: graphId, quote: z.string().min(1).max(1000) }))
                .max(8)
                .optional(),
            }),
          )
          .max(8),
      }),
    )
    .length(100),
});
const invalid = () => new BosunError('invalid', 'Invalid memory evaluation dataset');
export function memoryEvaluationDataset(input: unknown): MemoryEvalDataset {
  memoryEvaluationPrivacy(input);
  const result = schema.safeParse(input);
  if (!result.success) throw invalid();
  const dataset = result.data;
  const notes = new Map(dataset.notes.map((note) => [note.id, note]));
  if (notes.size !== dataset.notes.length) throw invalid();
  for (const note of dataset.notes) {
    if (
      !note.title.trim() ||
      !note.body.trim() ||
      (note.category === 'personal') !== (note.scope.projectId === null) ||
      (note.category === 'session' && note.scope.sessionId === null)
    )
      throw invalid();
    screenPublicText(JSON.stringify(note));
  }
  const graph = new Map<string, NonNullable<MemoryEvalDataset['graph']>[number]>();
  for (const artifact of dataset.graph ?? []) {
    if (
      graph.has(artifact.id) ||
      !artifact.title.trim() ||
      !artifact.text.trim() ||
      (artifact.kind === 'entity') !== !!artifact.entity ||
      (artifact.kind === 'relation') !== !!artifact.relation ||
      new Set(artifact.supports.map((ref) => ref.id)).size !== artifact.supports.length
    )
      throw invalid();
    for (const ref of artifact.supports) {
      const note = notes.get(ref.id);
      if (
        !note ||
        note.sourceGroup !== artifact.sourceGroup ||
        note.sessionGroup !== artifact.sessionGroup ||
        (note.scope.projectId !== null && note.scope.projectId !== artifact.scope.projectId) ||
        !ref.quote.trim() ||
        !norm(`${note.title} ${note.body}`).includes(norm(ref.quote))
      )
        throw invalid();
    }
    if (artifact.relation) {
      if (artifact.relation.from === artifact.relation.to) throw invalid();
      for (const id of [artifact.relation.from, artifact.relation.to]) {
        const parent = graph.get(id);
        if (
          parent?.kind !== 'entity' ||
          parent.sourceGroup !== artifact.sourceGroup ||
          parent.sessionGroup !== artifact.sessionGroup ||
          parent.scope.projectId !== artifact.scope.projectId
        )
          throw invalid();
      }
    }
    if (new Set(artifact.parents ?? []).size !== (artifact.parents ?? []).length) throw invalid();
    for (const id of artifact.parents ?? []) {
      const parent = graph.get(id);
      if (
        !parent ||
        parent.sourceGroup !== artifact.sourceGroup ||
        parent.sessionGroup !== artifact.sessionGroup ||
        parent.scope.projectId !== artifact.scope.projectId ||
        parent.supports.some(
          (ref) =>
            !artifact.supports.some(
              (s) => s.id === ref.id && norm(s.quote).includes(norm(ref.quote)),
            ),
        )
      )
        throw invalid();
    }
    screenPublicText(JSON.stringify(artifact));
    graph.set(artifact.id, artifact);
  }
  const ids = new Set<string>(),
    queries = new Set<string>();
  const groups = {
    development: {
      sources: new Set<string>(),
      sessions: new Set<string>(),
      categories: new Set<string>(),
    },
    heldout: {
      sources: new Set<string>(),
      sessions: new Set<string>(),
      categories: new Set<string>(),
    },
  };
  for (const task of dataset.cases) {
    if (
      !task.query.trim() ||
      ids.has(task.id) ||
      queries.has(norm(task.query)) ||
      (task.category === 'negative') !== (task.supports.length === 0) ||
      new Set(task.supports.map((s) => s.id)).size !== task.supports.length
    )
      throw invalid();
    ids.add(task.id);
    queries.add(norm(task.query));
    groups[task.split].sources.add(task.sourceGroup);
    groups[task.split].sessions.add(task.sessionGroup);
    groups[task.split].categories.add(task.category);
    for (const support of task.supports) {
      const note = notes.get(support.id);
      if (
        !note ||
        note.sourceGroup !== task.sourceGroup ||
        note.sessionGroup !== task.sessionGroup ||
        (note.scope.projectId !== null && note.scope.projectId !== task.scope.projectId) ||
        !norm(`${note.title} ${note.body}`).includes(norm(support.quote)) ||
        !support.quote.trim()
      )
        throw invalid();
      const alternatives = support.alternatives ?? [];
      if (new Set(alternatives.map((ref) => ref.id)).size !== alternatives.length) throw invalid();
      for (const ref of alternatives) {
        const artifact = graph.get(ref.id);
        if (
          !artifact ||
          artifact.sourceGroup !== task.sourceGroup ||
          artifact.sessionGroup !== task.sessionGroup ||
          artifact.scope.projectId !== task.scope.projectId ||
          !artifact.supports.some(
            (s) => s.id === support.id && norm(s.quote).includes(norm(support.quote)),
          ) ||
          !ref.quote.trim() ||
          !norm(`${artifact.title} ${artifact.text}`).includes(norm(ref.quote))
        )
          throw invalid();
      }
    }
    screenPublicText(JSON.stringify(task));
  }
  if (
    dataset.cases.filter((task) => task.split === 'development').length !== 20 ||
    dataset.cases.filter((task) => task.split === 'heldout').length !== 80 ||
    dataset.cases.filter((task) => task.category === 'negative').length < 20 ||
    [...groups.development.sources].some((id) => groups.heldout.sources.has(id)) ||
    [...groups.development.sessions].some((id) => groups.heldout.sessions.has(id)) ||
    MEMORY_EVAL_CATEGORIES.some(
      (category) =>
        !groups.development.categories.has(category) || !groups.heldout.categories.has(category),
    )
  )
    throw invalid();
  return dataset;
}
