import type { Memory, Ctx } from './domain/memory.ts';
import { BosunError } from './errors.ts';

export type RemoteViewSnapshot = {
  schemaVersion: 1;
  id: string;
  clientId: string;
  authorityId: string;
  sourceId: string;
  projectId: string;
  sessionId: string | null;
  grantHash: string;
  createdAt: number;
  rows: Memory[];
};
export const remoteViewUuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const stamp = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 8640000000000000;
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;
const nullable = (value: unknown, max: number) => value === null || text(value, max);
const exact = (value: any, keys: string[]) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const denied = () => new BosunError('unavailable', 'Remote view unavailable');
export function remoteViewContains(
  row: Memory,
  ctx: Pick<Ctx, 'projectId' | 'sessionId'>,
): boolean {
  return (
    ((row.category === 'personal' && row.projectId === null) || row.projectId === ctx.projectId) &&
    (row.category !== 'session' || row.shared || row.sessionId === ctx.sessionId)
  );
}
// Shared pure validation also serves the lean hook, without loading Zod or any writer.
export function parseRemoteView(
  value: unknown,
  hash: (title: string, body: string) => string,
): RemoteViewSnapshot {
  const v = value as any;
  if (
    !exact(v, [
      'schemaVersion',
      'id',
      'clientId',
      'authorityId',
      'sourceId',
      'projectId',
      'sessionId',
      'grantHash',
      'createdAt',
      'rows',
    ]) ||
    v.schemaVersion !== 1 ||
    ![v.id, v.clientId, v.authorityId, v.sourceId].every(remoteViewUuid) ||
    !/^p_[a-f0-9]{16}$/.test(v.projectId) ||
    !nullable(v.sessionId, 200) ||
    !/^[a-f0-9]{64}$/.test(v.grantHash) ||
    !stamp(v.createdAt) ||
    !Array.isArray(v.rows) ||
    v.rows.length > 50
  )
    throw denied();
  const ids = new Set<string>();
  for (const row of v.rows) {
    if (
      !exact(row, [
        'private',
        'shared',
        'id',
        'category',
        'projectId',
        'sessionId',
        'title',
        'body',
        'tags',
        'status',
        'source',
        'sourceRef',
        'hash',
        'createdAt',
        'updatedAt',
        'expiresAt',
        'accessedAt',
        'accessCount',
        'version',
      ]) ||
      row.private !== false ||
      typeof row.shared !== 'boolean' ||
      !text(row.id, 64) ||
      ids.has(row.id) ||
      !['personal', 'project', 'session'].includes(row.category) ||
      !nullable(row.projectId, 64) ||
      !nullable(row.sessionId, 200) ||
      !text(row.title, 200) ||
      !text(row.body, 4000) ||
      !text(row.source, 200) ||
      !nullable(row.sourceRef, 200) ||
      !Array.isArray(row.tags) ||
      row.tags.length > 40 ||
      row.tags.some((tag: unknown) => !text(tag, 64)) ||
      row.status !== 'active' ||
      row.expiresAt !== null ||
      !stamp(row.createdAt) ||
      !stamp(row.updatedAt) ||
      (row.accessedAt !== null && !stamp(row.accessedAt)) ||
      !Number.isSafeInteger(row.accessCount) ||
      row.accessCount < 0 ||
      !Number.isSafeInteger(row.version) ||
      row.version < 1 ||
      !/^[a-f0-9]{32}$/.test(row.hash) ||
      hash(row.title, row.body) !== row.hash ||
      !remoteViewContains(row, v)
    )
      throw denied();
    ids.add(row.id);
  }
  return v;
}
