import { MemoryError } from './errors.ts';
import { norm } from './text.ts';
import type { GraphArtifact, GraphEntity, GraphKind, GraphLevel } from './domain/graph.ts';

export const graphLevel = (kind: GraphKind): GraphLevel => ({ source: 0, fact: 1, entity: 2, relation: 2, summary: 3, profile: 4 })[kind] as GraphLevel;
export function graphKey(entity: GraphEntity): string {
  const key = entity.key;
  if (typeof key !== 'string' || !key.trim() || key.length > 400 || /[\x00-\x1f\x7f]/.test(key)) throw new MemoryError('invalid', 'invalid graph entity');
  if (entity.type === 'file' || entity.type === 'symbol') {
    if (key.startsWith('/') || key.includes('\\') || key.split('/').some((piece) => piece === '..' || piece === '.' || !piece)) throw new MemoryError('invalid', 'invalid graph entity');
    return key;
  }
  return norm(key);
}
// Eligible IDs only enter fusion. SQL/native policy owns eligibility and payload acquisition.
export function graphFusion(channels: readonly { weight: number; ids: readonly string[] }[]): Map<string, number> {
  const scores = new Map<string, number>();
  for (const channel of channels) {
    if (!Number.isFinite(channel.weight) || channel.weight < 0 || channel.ids.length > 64) throw new MemoryError('invalid', 'invalid graph ranking');
    for (const [index, id] of [...new Set(channel.ids)].entries()) scores.set(id, (scores.get(id) ?? 0) + channel.weight / (60 + index + 1));
  }
  return scores;
}
// Status/version are review lifecycle metadata. Content, source lineage, scope
// and producer identity have one deterministic hash representation.
export function graphHashText(artifact: Pick<GraphArtifact, 'kind' | 'text' | 'supports' | 'parents' | 'entity' | 'relation' | 'producer'
  | 'projectId' | 'sessionId' | 'shared' | 'recordedAt' | 'validFrom' | 'validTo' | 'expiresAt'>): string {
  const refs = artifact.supports.map((s) => ({ memoryId: s.memoryId, version: s.version, hash: s.hash,
    ...(s.start === undefined ? {} : { start: s.start, end: s.end }) })).sort((a, b) => a.memoryId < b.memoryId ? -1 : a.memoryId > b.memoryId ? 1 : 0);
  const parents = artifact.parents.map((p) => ({ id: p.id, version: p.version })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return JSON.stringify({ kind: artifact.kind, text: artifact.text, supports: refs, parents,
    entity: artifact.entity ? { type: artifact.entity.type, key: artifact.entity.key, aliases: [...new Set(artifact.entity.aliases ?? [])].sort() } : null,
    relation: artifact.relation ? { from: artifact.relation.from, to: artifact.relation.to, predicate: artifact.relation.predicate, weight: artifact.relation.weight } : null,
    producer: { kind: artifact.producer.kind, model: artifact.producer.model, version: artifact.producer.version },
    projectId: artifact.projectId, sessionId: artifact.sessionId, shared: artifact.shared, recordedAt: artifact.recordedAt,
    validFrom: artifact.validFrom, validTo: artifact.validTo, expiresAt: artifact.expiresAt });
}
