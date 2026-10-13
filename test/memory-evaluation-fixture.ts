import type { MemoryEvalDataset } from '../src/core/domain/memory-evaluation.ts';

// Invented public evidence, never an owner-authored or real quality corpus.
export function memoryEvaluationFixture(): MemoryEvalDataset {
  const graph: NonNullable<MemoryEvalDataset['graph']> = [];
  const notes: MemoryEvalDataset['notes'] = [],
    cases: MemoryEvalDataset['cases'] = [];
  const categories = [
    'identifier',
    'paraphrase',
    'rationale',
    'relationship',
    'current',
    'preference',
    'summary',
    'identifier',
    'negative',
    'negative',
  ] as const;
  for (let group = 0; group < 10; group++) {
    const id = `m_eval${group}`,
      word = `synthproject${group}`,
      scope = { projectId: `p_${group.toString(16).padStart(16, '0')}`, sessionId: `s_${group}` },
      sourceGroup = `source_${group}`,
      sessionGroup = `session_${group}`;
    notes.push({
      privacy: 'public',
      id,
      scope,
      sourceGroup,
      sessionGroup,
      category: 'project',
      title: `${word} build guidelines`,
      body: `${word} uses pnpm for reproducible builds. Reviewed synthetic project decisions.`,
      tags: ['tooling'],
    });
    graph.push({
      privacy: 'public',
      reviewed: true,
      id: `g_eval${group}`,
      sourceGroup,
      sessionGroup,
      scope,
      kind: 'entity',
      title: `${word} operations`,
      text: 'Reviewed operations uses pnpm for reproducible builds.',
      supports: [{ id, quote: 'uses pnpm for reproducible builds' }],
      entity: { type: 'concept', key: `${word} operations`, aliases: [`launchtool${group}`] },
    });
    for (let index = 0; index < 10; index++)
      cases.push({
        privacy: 'public',
        id: `q_${group}_${index}`,
        split: group < 2 ? 'development' : 'heldout',
        sourceGroup,
        sessionGroup,
        scope,
        category: categories[index],
        query:
          index < 8
            ? `${word} pnpm ${categories[index]} question ${index}`
            : `unrelated nebula${group} absent${index}`,
        supports:
          index < 8
            ? [
                {
                  id,
                  grade: 3,
                  quote: 'uses pnpm for reproducible builds',
                  alternatives: [
                    { id: `g_eval${group}`, quote: 'uses pnpm for reproducible builds' },
                  ],
                },
              ]
            : [],
      });
  }
  return {
    schema: 1,
    privacy: 'public',
    evidence: 'synthetic',
    capturedAt: 1800000000000,
    notes,
    cases,
    graph,
  };
}
