// Explicit writer operations. Callers schedule these separately from query/projection work.
import type { DatabaseSync } from 'node:sqlite';
import type { SqliteSession } from './sqlite-session.ts';
export const DAY = 86400000;
export type RetentionPolicy = { readonly sessionTtlDays: number; readonly purgeAfterDays: number };

export function event(db: DatabaseSync, id: string, op: string, source: string, before: string | null, after: string | null, at: number): void {
  db.prepare('INSERT INTO memory_events (memory_id, op, at, source, hash_before, hash_after) VALUES (?, ?, ?, ?, ?, ?)').run(id, op, at, source, before, after);
}
export function expire(session: SqliteSession, now: number): number {
  if (!session.read((db) => db.prepare("SELECT 1 FROM memories WHERE expires_at <= ? AND status <> 'archived' LIMIT 1").get(now))) return 0;
  return session.transaction((db) => {
    db.prepare(`INSERT INTO memory_events (memory_id, op, at, source, hash_before, hash_after)
      SELECT id, 'expire', ?, 'retention', hash, hash FROM memories WHERE expires_at <= ? AND status <> 'archived'`).run(now, now);
    return Number(db.prepare("UPDATE memories SET status = 'archived', updated_at = ?, version = version + 1 WHERE expires_at <= ? AND status <> 'archived'").run(now, now).changes);
  });
}
export function touch(session: SqliteSession, ids: string[], now: number): void {
  session.transaction((db) => db.prepare('UPDATE memories SET accessed_at = ?, access_count = access_count + 1 WHERE id IN (SELECT value FROM json_each(?))').run(now, JSON.stringify(ids)));
}
export function prune(session: SqliteSession, now: number, policy: RetentionPolicy): { archived: number; purged: number } {
  const archived = expire(session, now);
  const cutoff = now - policy.purgeAfterDays * DAY;
  const purged = session.transaction((db) => {
    db.prepare("INSERT INTO memory_events (memory_id, op, at, source, hash_before, hash_after) SELECT id, 'purge', ?, 'retention', hash, NULL FROM memories WHERE status = 'archived' AND updated_at < ?").run(now, cutoff);
    return Number(db.prepare("DELETE FROM memories WHERE status = 'archived' AND updated_at < ?").run(cutoff).changes);
  });
  return { archived, purged };
}
