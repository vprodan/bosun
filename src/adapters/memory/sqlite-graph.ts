import type { SqliteDatabase } from '../../platform/sqlite.ts'
import { MemoryError } from '../../core/errors.ts';
import { graphFusion, graphHashText, graphKey, graphLevel } from '../../core/graph.ts';
import { ftsQuery, norm, terms } from '../../core/text.ts';
import { screenPublicText } from '../../core/secret-screen.ts';
import type { Ctx } from '../../core/domain/memory.ts';
import {
  GRAPH_LIMITS,
  type GraphLevel,
  type GraphArtifact,
  type GraphExplanation,
  type GraphInput,
  type GraphParent,
  type GraphQuery,
  type GraphSearch,
  type GraphSupport,
} from '../../core/domain/graph.ts';
import type { ContextSource } from '../../core/ports/context-source.ts';
import { checkGraphInput, checkGraphQuery } from '../../contracts/graph.ts';
import type { SqliteSession } from './sqlite-session.ts';
import {
  CONSOLIDATION_LIMITS,
  type ConsolidationClaim,
  type ConsolidationStorage,
  type ConsolidationWindow,
  type ConsolidationProposal,
} from '../../core/domain/consolidation.ts';
import { utf8Bytes } from '../../core/domain/job.ts';
import { checkConsolidationRequest } from '../../contracts/consolidation.ts';

type Row = Record<string, any>;
export type GraphDependencies = {
  now(): number;
  id(now: number): string;
  hash(title: string, text: string): string;
  artifactHash(text: string): string;
};
const unavailable = () => new MemoryError('unavailable', 'graph unavailable');
const missing = () => new MemoryError('not_found', 'graph artifact not found');
const invalid = () => new MemoryError('invalid', 'invalid graph artifact');
const MAX_DATE = 8640000000000000;
const SCOPE = `(a.project_id IS NULL OR a.project_id=:pid OR a.shared=1 OR a.project_id IN (SELECT value FROM json_each(:linked)))
  AND (a.session_id IS NULL OR a.session_id=:sid OR a.shared=1)`;
const MEMORY_SCOPE = `(m.project_id IS NULL OR m.project_id=:pid OR (typeof(m.shared)='integer' AND m.shared=1) OR m.project_id IN (SELECT value FROM json_each(:linked)))
  AND (m.category<>'session' OR m.session_id=:sid OR (typeof(m.shared)='integer' AND m.shared=1))`;
const VALID_MEMORY = `m.id IS NOT NULL AND m.status='active' AND typeof(m.private)='integer' AND m.private=0
  AND m.version=s.memory_version AND m.hash=s.memory_hash AND ${MEMORY_SCOPE}
  AND (m.expires_at IS NULL OR (typeof(m.expires_at)='integer' AND m.expires_at>:now AND m.expires_at<=${MAX_DATE}))`;
const ELIGIBLE = `${SCOPE} AND a.private=0 AND a.status IN (SELECT value FROM json_each(:statuses))
  AND (a.valid_from IS NULL OR a.valid_from<=:now) AND (a.valid_to IS NULL OR a.valid_to>:now)
  AND (a.expires_at IS NULL OR a.expires_at>:now)
  AND EXISTS(SELECT 1 FROM graph_supports s WHERE s.artifact_id=a.id)
  AND NOT EXISTS(SELECT 1 FROM graph_supports s LEFT JOIN memories m ON m.id=s.memory_id WHERE s.artifact_id=a.id AND NOT(${VALID_MEMORY}))
  AND NOT EXISTS(SELECT 1 FROM graph_parents p LEFT JOIN graph_artifacts parent ON parent.id=p.parent_id
    WHERE p.artifact_id=a.id AND (parent.id IS NULL OR parent.status<>'active' OR parent.version<>p.parent_version
      OR parent.valid_from>:now OR parent.valid_to<=:now OR parent.expires_at<=:now))`;
function caller(ctx: Ctx): Ctx {
  const scope = (value: unknown) =>
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 200 &&
    !/[\x00-\x1f]/.test(value);
  if (
    !ctx ||
    !(ctx.projectId === null || scope(ctx.projectId)) ||
    !(ctx.sessionId === null || scope(ctx.sessionId)) ||
    !Array.isArray(ctx.linked) ||
    ctx.linked.length > 2000 ||
    ctx.linked.some((id) => !scope(id))
  )
    throw invalid();
  return {
    projectId: ctx.projectId,
    sessionId: ctx.sessionId,
    linked: [...ctx.linked],
    audience: ctx.audience,
  };
}
function graphId(id: string): void {
  if (typeof id !== 'string' || !/^g_[a-z0-9]{1,96}$/.test(id)) throw invalid();
}
function version(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw invalid();
}
function owner(ctx: Ctx): void {
  if (ctx.audience !== 'owner')
    throw new MemoryError('invalid', 'graph review requires owner access');
}
const bindings = (ctx: Ctx, now: number, statuses = ['active']) => ({
  pid: ctx.projectId,
  sid: ctx.sessionId,
  linked: JSON.stringify(ctx.linked),
  now,
  statuses: JSON.stringify(statuses),
});
function supports(db: SqliteDatabase, id: string): GraphSupport[] {
  return db
    .prepare(
      'SELECT memory_id,memory_version,memory_hash,start,end FROM graph_supports WHERE artifact_id=? ORDER BY memory_id LIMIT 9',
    )
    .all(id)
    .map((s: Row) => ({
      memoryId: s.memory_id,
      version: s.memory_version,
      hash: s.memory_hash,
      ...(s.start === null ? {} : { start: s.start }),
      ...(s.end === null ? {} : { end: s.end }),
    }));
}
function parents(db: SqliteDatabase, id: string): GraphParent[] {
  return db
    .prepare(
      'SELECT parent_id,parent_version FROM graph_parents WHERE artifact_id=? ORDER BY parent_id LIMIT 9',
    )
    .all(id)
    .map((p: Row) => ({ id: p.parent_id, version: p.parent_version }));
}
export class SqliteGraph {
  readonly enabled: boolean;
  #session: SqliteSession;
  #deps: Readonly<GraphDependencies>;
  constructor(
    session: SqliteSession,
    dependencies: GraphDependencies,
    schemaVersion: 1 | 2,
    enabled = true,
  ) {
    if (
      ![dependencies.now, dependencies.id, dependencies.hash, dependencies.artifactHash].every(
        (fn) => typeof fn === 'function',
      ) ||
      ![1, 2].includes(schemaVersion)
    )
      throw invalid();
    this.#session = session;
    this.#deps = Object.freeze({ ...dependencies });
    this.enabled = enabled && schemaVersion === 2;
  }
  close(): void {
    this.#session.close();
  }
  #now(): number {
    const now = this.#deps.now();
    if (!Number.isSafeInteger(now) || now < 0 || now > MAX_DATE) throw unavailable();
    return now;
  }
  #active(): void {
    if (!this.enabled) throw unavailable();
  }
  #hash(title: string, text: string): string {
    const hash = this.#deps.hash(title, text);
    if (!/^[a-f0-9]{32}$/.test(hash)) throw unavailable();
    return hash;
  }
  #artifactHash(title: string, text: string): string {
    const hash = this.#deps.artifactHash(JSON.stringify([title, text]));
    if (!/^[a-f0-9]{64}$/.test(hash)) throw unavailable();
    return hash;
  }
  // SQL scope/privacy/version eligibility precedes source payload access. Source
  // screening in turn precedes any derivative title/text/alias/predicate projection.
  #sourceRows(
    db: SqliteDatabase,
    refs: readonly GraphSupport[],
    ctx: Ctx,
    now: number,
  ): Row[] | null {
    if (!refs.length || refs.length > 8) return null;
    const found: Row[] = [];
    for (const ref of refs) {
      const s = { memory_version: ref.version, memory_hash: ref.hash };
      const row = db
        .prepare(`SELECT m.* FROM memories m JOIN (SELECT :memory_version memory_version,:memory_hash memory_hash) s
        WHERE m.id=:id AND ${VALID_MEMORY}`)
        .get({
          id: ref.memoryId,
          ...s,
          pid: ctx.projectId,
          sid: ctx.sessionId,
          linked: JSON.stringify(ctx.linked),
          now,
        }) as Row | undefined;
      if (!row) return null;
      try {
        for (const field of ['title', 'body', 'tags', 'source', 'source_ref'])
          if (typeof row[field] === 'string') screenPublicText(row[field]);
        if (this.#hash(row.title, row.body) !== row.hash) return null;
        if (
          (ref.start === undefined) !== (ref.end === undefined) ||
          (ref.start !== undefined && (!(ref.end! > ref.start) || ref.end! > row.body.length))
        )
          return null;
      } catch {
        return null;
      }
      found.push(row);
    }
    return found;
  }
  #eligible(db: SqliteDatabase, id: string, ctx: Ctx, now: number, statuses = ['active']): boolean {
    if (
      !db
        .prepare(`SELECT a.id FROM graph_artifacts a WHERE a.id=:id AND ${ELIGIBLE}`)
        .get({ id, ...bindings(ctx, now, statuses) })
    )
      return false;
    return this.#sourceRows(db, supports(db, id), ctx, now) !== null;
  }
  #artifact(db: SqliteDatabase, id: string): GraphArtifact {
    const row = db.prepare('SELECT * FROM graph_artifacts WHERE id=?').get(id) as Row;
    const artifact: GraphArtifact = {
      id: row.id,
      level: row.level,
      kind: row.kind,
      title: row.title,
      text: row.text,
      status: row.status,
      version: row.version,
      projectId: row.project_id,
      sessionId: row.session_id,
      private: false,
      shared: row.shared === 1,
      recordedAt: row.recorded_at,
      invalidatedAt: row.invalidated_at,
      validFrom: row.valid_from,
      validTo: row.valid_to,
      expiresAt: row.expires_at,
      hash: row.hash,
      supports: supports(db, id),
      parents: parents(db, id),
      producer: {
        kind: row.producer_kind,
        model: row.producer_model,
        version: row.producer_version,
      },
    };
    if (row.kind === 'entity')
      artifact.entity = {
        type: row.entity_type,
        key: row.entity_key,
        aliases: db
          .prepare('SELECT alias FROM graph_aliases WHERE artifact_id=? ORDER BY alias LIMIT 14')
          .all(id)
          .map((a) => String(a.alias)),
      };
    if (row.kind === 'relation') {
      const edge = db.prepare('SELECT * FROM graph_edges WHERE artifact_id=?').get(id) as Row;
      artifact.relation = {
        from: edge.from_id,
        to: edge.to_id,
        predicate: edge.predicate,
        weight: edge.weight,
      };
    }
    try {
      screenPublicText(JSON.stringify(artifact));
    } catch {
      throw missing();
    }
    if (
      artifact.supports.length > 8 ||
      artifact.parents.length > 8 ||
      (artifact.entity?.aliases?.length ?? 0) > 13 ||
      artifact.level !== graphLevel(artifact.kind) ||
      this.#artifactHash(artifact.title, graphHashText(artifact)) !== artifact.hash
    )
      throw missing();
    return artifact;
  }
  #create(
    db: SqliteDatabase,
    input: GraphInput,
    ctx: Ctx,
    now: number,
    active = false,
  ): GraphArtifact {
    checkGraphInput(input);
    screenPublicText(JSON.stringify(input));
    const sourceRows = this.#sourceRows(db, input.supports, ctx, now);
    if (!sourceRows) throw missing();
    if (new Set(input.supports.map((s) => s.memoryId)).size !== input.supports.length)
      throw invalid();
    if (sourceRows.some((m) => m.project_id !== null && m.project_id !== ctx.projectId))
      throw new MemoryError('invalid', 'graph sources belong to another project');
    const level = graphLevel(input.kind);
    const directParents = [...(input.parents ?? [])];
    if (
      (input.kind === 'entity') !== (input.entity !== undefined) ||
      (input.kind === 'relation') !== (input.relation !== undefined)
    )
      throw invalid();
    if (
      input.kind === 'source' &&
      (input.text || input.supports.length !== 1 || directParents.length)
    )
      throw invalid();
    if (input.kind !== 'source' && !input.text?.trim()) throw invalid();
    if (input.relation) {
      if (input.relation.from === input.relation.to) throw invalid();
      for (const id of [input.relation.from, input.relation.to]) {
        graphId(id);
        if (!this.#eligible(db, id, ctx, now)) throw missing();
        const node = this.#artifact(db, id);
        if (node.kind !== 'entity' || node.projectId !== ctx.projectId) throw invalid();
        if (!directParents.some((p) => p.id === id))
          directParents.push({ id, version: node.version });
      }
    }
    if (
      directParents.length > 8 ||
      new Set(directParents.map((p) => p.id)).size !== directParents.length
    )
      throw invalid();
    const parentDeadlines: number[] = [];
    for (const parent of directParents) {
      graphId(parent.id);
      if (!this.#eligible(db, parent.id, ctx, now)) throw missing();
      const ancestor = this.#artifact(db, parent.id);
      for (const deadline of [ancestor.validTo, ancestor.expiresAt])
        if (deadline !== null) parentDeadlines.push(deadline);
      if (
        ancestor.version !== parent.version ||
        ancestor.projectId !== ctx.projectId ||
        ancestor.level > level ||
        (ancestor.level === level && input.kind !== 'relation')
      )
        throw invalid();
      for (const ref of ancestor.supports)
        if (
          !input.supports.some(
            (s) =>
              s.memoryId === ref.memoryId &&
              s.version === ref.version &&
              s.hash === ref.hash &&
              (s.start === undefined ||
                (ref.start !== undefined && s.start <= ref.start && s.end! >= ref.end!)),
          )
        )
          throw new MemoryError('invalid', 'graph lineage is incomplete');
    }
    if (input.validFrom != null && input.validTo != null && input.validFrom >= input.validTo)
      throw invalid();
    const entity = input.entity
      ? {
          ...input.entity,
          key: graphKey(input.entity),
          aliases: [
            ...new Set([norm(graphKey(input.entity)), ...(input.entity.aliases ?? []).map(norm)]),
          ].sort(),
        }
      : undefined;
    const producer = input.producer ?? { kind: 'owner' as const, model: null, version: '1' };
    if (
      (producer.kind === 'model' && !producer.model) ||
      (producer.kind !== 'model' && producer.model !== null)
    )
      throw invalid();
    const id = this.#deps.id(now);
    graphId(id);
    const deadlines = [
      ...parentDeadlines,
      ...sourceRows.map((m) => m.expires_at).filter((t): t is number => t !== null),
    ];
    const expiresAt = deadlines.length ? Math.min(...deadlines) : null;
    const sessionSources = sourceRows.filter((m) => m.category === 'session');
    const sessionId = sessionSources.length ? ctx.sessionId : null;
    const title = input.title.trim();
    const text = input.text?.trim() ?? '';
    const shared = sourceRows.every((m) => m.project_id === null || m.shared === 1);
    const hash = this.#artifactHash(
      title,
      graphHashText({
        kind: input.kind,
        text,
        supports: input.supports,
        parents: directParents,
        entity,
        relation: input.relation,
        producer,
        projectId: ctx.projectId,
        sessionId,
        shared,
        recordedAt: now,
        validFrom: input.validFrom ?? null,
        validTo: input.validTo ?? null,
        expiresAt,
      }),
    );
    db.prepare(`INSERT INTO graph_artifacts(id,level,kind,title,text,status,version,project_id,session_id,private,shared,recorded_at,invalidated_at,valid_from,valid_to,expires_at,hash,
      producer_kind,producer_model,producer_version,entity_type,entity_key) VALUES(?,?,?,?,?,?,1,?,?,0,?,?,NULL,?,?,?,?,?,?,?,?,?)`).run(
      id,
      level,
      input.kind,
      title,
      text,
      active ? 'active' : 'proposed',
      ctx.projectId,
      sessionId,
      Number(shared),
      now,
      input.validFrom ?? null,
      input.validTo ?? null,
      expiresAt,
      hash,
      producer.kind,
      producer.model,
      producer.version,
      entity?.type ?? null,
      entity?.key ?? null,
    );
    for (const ref of input.supports)
      db.prepare('INSERT INTO graph_supports VALUES(?,?,?,?,?,?)').run(
        id,
        ref.memoryId,
        ref.version,
        ref.hash,
        ref.start ?? null,
        ref.end ?? null,
      );
    for (const parent of directParents)
      db.prepare('INSERT INTO graph_parents VALUES(?,?,?)').run(id, parent.id, parent.version);
    for (const alias of entity?.aliases ?? [])
      db.prepare('INSERT INTO graph_aliases VALUES(?,?)').run(id, alias);
    if (input.relation)
      db.prepare('INSERT INTO graph_edges VALUES(?,?,?,?,?)').run(
        id,
        input.relation.from,
        input.relation.to,
        input.relation.predicate,
        input.relation.weight,
      );
    db.prepare('INSERT INTO graph_events(artifact_id,op,at,version) VALUES(?,?,?,1)').run(
      id,
      active ? 'backfill' : 'propose',
      now,
    );
    return this.#artifact(db, id);
  }
  create(input: GraphInput, context: Ctx): GraphArtifact {
    this.#active();
    const ctx = caller(context);
    owner(ctx);
    const now = this.#now();
    checkGraphInput(input);
    screenPublicText(JSON.stringify(input));
    return this.#session.transaction((db) => this.#create(db, input, ctx, now));
  }
  get(id: string, context: Ctx): GraphArtifact {
    this.#active();
    graphId(id);
    const ctx = caller(context);
    const now = this.#now();
    return this.#session.read((db) => {
      if (
        !this.#eligible(
          db,
          id,
          ctx,
          now,
          ctx.audience === 'owner' ? ['active', 'proposed'] : ['active'],
        )
      )
        throw missing();
      return this.#artifact(db, id);
    });
  }
  review(
    id: string,
    expectedVersion: number,
    decision: 'accept' | 'reject',
    context: Ctx,
  ): GraphArtifact | { id: string; version: number; status: 'archived' } {
    this.#active();
    graphId(id);
    version(expectedVersion);
    const ctx = caller(context);
    owner(ctx);
    const now = this.#now();
    if (!['accept', 'reject'].includes(decision)) throw invalid();
    return this.#session.transaction((db) => {
      if (!this.#eligible(db, id, ctx, now, ['proposed'])) throw missing();
      const artifact = this.#artifact(db, id);
      if (artifact.projectId !== ctx.projectId) throw invalid();
      if (artifact.version !== expectedVersion)
        throw new MemoryError('conflict', 'graph version conflict', artifact.version);
      db.prepare(
        'UPDATE graph_artifacts SET status=?,version=version+1,invalidated_at=? WHERE id=?',
      ).run(decision === 'accept' ? 'active' : 'archived', decision === 'accept' ? null : now, id);
      db.prepare('INSERT INTO graph_events(artifact_id,op,at,version) VALUES(?,?,?,?)').run(
        id,
        decision,
        now,
        expectedVersion + 1,
      );
      return decision === 'accept'
        ? this.#artifact(db, id)
        : { id, version: expectedVersion + 1, status: 'archived' as const };
    });
  }
  revoke(
    id: string,
    expectedVersion: number,
    context: Ctx,
  ): { id: string; version: number; invalidated: number } {
    this.#active();
    graphId(id);
    version(expectedVersion);
    const ctx = caller(context);
    owner(ctx);
    const now = this.#now();
    return this.#session.transaction((db) => {
      const row = db
        .prepare(
          'SELECT id,version,project_id,status FROM graph_artifacts WHERE id=? AND (project_id IS NULL OR project_id=?)',
        )
        .get(id, ctx.projectId) as Row | undefined;
      if (!row || row.project_id !== ctx.projectId) throw missing();
      if (row.version !== expectedVersion)
        throw new MemoryError('conflict', 'graph version conflict', row.version);
      if (row.status === 'archived') return { id, version: row.version, invalidated: 0 };
      const affected = db
        .prepare(`WITH RECURSIVE descendants(id) AS (SELECT :id UNION SELECT p.artifact_id FROM graph_parents p JOIN descendants d ON p.parent_id=d.id)
        SELECT a.id,a.version FROM graph_artifacts a JOIN descendants d ON d.id=a.id WHERE a.status IN ('active','proposed','dirty') LIMIT 1001`)
        .all({ id }) as Row[];
      if (affected.length > 1000) throw unavailable();
      for (const item of affected) {
        db.prepare(
          'UPDATE graph_artifacts SET status=?,version=version+1,invalidated_at=? WHERE id=?',
        ).run(item.id === id ? 'archived' : 'dirty', now, item.id);
        db.prepare('INSERT INTO graph_events(artifact_id,op,at,version) VALUES(?,?,?,?)').run(
          item.id,
          item.id === id ? 'revoke' : 'parent_revoked',
          now,
          item.version + 1,
        );
      }
      return { id, version: row.version + 1, invalidated: affected.length };
    });
  }
  backfill(context: Ctx, limit = 100): { created: number; skipped: number } {
    this.#active();
    const ctx = caller(context);
    owner(ctx);
    const now = this.#now();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw invalid();
    return this.#session.transaction((db) => {
      const rows = db
        .prepare(`SELECT m.id,m.version,m.hash FROM memories m WHERE (m.project_id IS NULL OR m.project_id=:pid)
        AND m.status='active' AND typeof(m.private)='integer' AND m.private=0 AND (m.expires_at IS NULL OR m.expires_at>:now)
        AND (m.category<>'session' OR m.session_id=:sid) AND NOT EXISTS(SELECT 1 FROM graph_supports s JOIN graph_artifacts a ON a.id=s.artifact_id
          WHERE a.kind='source' AND a.project_id IS :pid AND a.status='active' AND s.memory_id=m.id AND s.memory_version=m.version AND s.memory_hash=m.hash)
        ORDER BY m.seq LIMIT :limit`)
        .all({ pid: ctx.projectId, sid: ctx.sessionId, now, limit }) as Row[];
      let created = 0;
      let skipped = 0;
      for (const row of rows) {
        const input: GraphInput = {
          kind: 'source',
          title: `Evidence ${row.id}`,
          supports: [{ memoryId: row.id, version: row.version, hash: row.hash }],
          producer: { kind: 'deterministic', model: null, version: '1' },
        };
        if (!this.#sourceRows(db, input.supports, ctx, now)) {
          skipped++;
          continue;
        }
        this.#create(db, input, ctx, now, true);
        created++;
      }
      return { created, skipped };
    });
  }
  explain(id: string, context: Ctx): GraphExplanation {
    const artifact = this.get(id, context);
    return {
      id,
      version: artifact.version,
      level: artifact.level,
      supports: artifact.supports,
      parents: artifact.parents,
      paths: artifact.supports.map((s) => [id, s.memoryId]),
    };
  }
  exportProfile(
    id: string,
    context: Ctx,
  ): { schema: 1; title: string; text: string; recordedAt: number; citations: GraphSupport[] } {
    owner(caller(context));
    const profile = this.get(id, context);
    if (profile.kind !== 'profile' || profile.status !== 'active') throw invalid();
    // No absolute checkout/session/account/producer metadata accompanies a portable profile.
    return {
      schema: 1,
      title: profile.title,
      text: profile.text,
      recordedAt: profile.recordedAt,
      citations: profile.supports,
    };
  }
  consolidation(): ConsolidationStorage {
    const scopeKey = (ctx: Ctx) => JSON.stringify([ctx.projectId, ctx.sessionId]);
    const context = (ctx: Ctx) => {
      this.#active();
      const result = caller(ctx);
      owner(result);
      if (!result.projectId) throw invalid();
      return result;
    };
    const pending = (db: SqliteDatabase) =>
      Number(
        db
          .prepare(
            `SELECT (SELECT COUNT(*) FROM memories WHERE status='proposed')+(SELECT COUNT(*) FROM graph_artifacts WHERE status='proposed') AS n`,
          )
          .get()!.n,
      );
    const cursorRow = (db: SqliteDatabase, ctx: Ctx): Row | undefined =>
      db.prepare('SELECT * FROM graph_consolidation_cursors WHERE scope_key=?').get(scopeKey(ctx));
    const claimValue = (row: Row | undefined): ConsolidationClaim | null => {
      if (!row?.claim_id) return null;
      try {
        const request = checkConsolidationRequest(JSON.parse(row.claim_payload));
        return {
          id: row.claim_id,
          cursor: row.cursor,
          through: request.through,
          version: row.version,
          sources: request.sources,
        };
      } catch {
        throw unavailable();
      }
    };
    const parentRows = (
      db: SqliteDatabase,
      ctx: Ctx,
      refs: readonly GraphSupport[],
      now: number,
    ): GraphArtifact[] => {
      const ids = db
        .prepare(`SELECT a.id FROM graph_artifacts a WHERE a.project_id IS :pid AND a.kind IN ('entity','fact','summary','profile') AND ${ELIGIBLE}
        AND NOT EXISTS(SELECT 1 FROM graph_supports s WHERE s.artifact_id=a.id AND NOT EXISTS(SELECT 1 FROM json_each(:refs) r
          WHERE json_extract(r.value,'$.memoryId')=s.memory_id AND json_extract(r.value,'$.version')=s.memory_version AND json_extract(r.value,'$.hash')=s.memory_hash))
        ORDER BY CASE WHEN a.kind='entity' THEN 0 ELSE 1 END,a.seq DESC LIMIT 8`)
        .all({ ...bindings(ctx, now), refs: JSON.stringify(refs) })
        .map((row) => String(row.id));
      return ids.flatMap((id) => {
        if (!this.#eligible(db, id, ctx, now)) return [];
        try {
          return [this.#artifact(db, id)];
        } catch (e) {
          if (e instanceof MemoryError && e.code === 'not_found') return [];
          throw e;
        }
      });
    };
    const revalidate = (db: SqliteDatabase, ctx: Ctx, refs: readonly GraphSupport[], now: number) => {
      if (refs.length > 8 || new Set(refs.map((s) => s.memoryId)).size !== refs.length)
        throw invalid();
      const rows = refs.length ? this.#sourceRows(db, refs, ctx, now) : [];
      if (!rows || rows.some((m) => m.project_id !== null && m.project_id !== ctx.projectId))
        throw new MemoryError('conflict', 'Consolidation sources changed');
      return rows;
    };
    const markSeen = (db: SqliteDatabase, ctx: Ctx, refs: readonly GraphSupport[]) => {
      if (
        Number(db.prepare('SELECT COUNT(*) AS n FROM graph_consolidation_seen').get()!.n) +
          refs.length >
        10000
      )
        throw unavailable();
      for (const ref of refs)
        db.prepare(`INSERT INTO graph_consolidation_seen VALUES(?,?,?,?) ON CONFLICT(scope_key,memory_id) DO UPDATE SET
        source_version=excluded.source_version,source_hash=excluded.source_hash WHERE excluded.source_version>=graph_consolidation_seen.source_version`).run(
          scopeKey(ctx),
          ref.memoryId,
          ref.version,
          ref.hash,
        );
    };
    const matching = (db: SqliteDatabase, ctx: Ctx, claim: ConsolidationClaim) => {
      const row = cursorRow(db, ctx);
      if (
        !row ||
        row.claim_id !== claim.id ||
        row.version !== claim.version ||
        row.cursor !== claim.cursor ||
        claimValue(row)?.through !== claim.through ||
        JSON.stringify(claimValue(row)?.sources) !== JSON.stringify(claim.sources)
      )
        throw new MemoryError('conflict', 'Consolidation reservation changed');
      return row;
    };
    return {
      window: (contextValue, limits) => {
        const ctx = context(contextValue);
        const now = this.#now();
        if (
          !Number.isSafeInteger(limits.maxSources) ||
          limits.maxSources < 1 ||
          limits.maxSources > 8 ||
          !Number.isSafeInteger(limits.maxInputBytes) ||
          limits.maxInputBytes < 4096 ||
          limits.maxInputBytes > 24576 ||
          !Number.isSafeInteger(limits.maxOutstanding) ||
          limits.maxOutstanding < 1 ||
          limits.maxOutstanding > 20
        )
          throw invalid();
        return this.#session.read((db) => {
          const row = cursorRow(db, ctx);
          const cursor = row?.cursor ?? 0;
          const outstanding = pending(db);
          const result: ConsolidationWindow = {
            cursor,
            through: cursor,
            sources: [],
            parents: [],
            outstanding,
            state: row?.claim_id
              ? 'held'
              : outstanding >= limits.maxOutstanding
                ? 'backpressure'
                : 'ready',
          };
          if (result.state !== 'ready') return result;
          const events = db
            .prepare('SELECT id,memory_id FROM memory_events WHERE id>? ORDER BY id LIMIT ?')
            .all(cursor, CONSOLIDATION_LIMITS.events);
          let bytes = 2048;
          const selected = new Set<string>();
          for (const event of events) {
            const memory = db
              .prepare(`SELECT m.id,m.version,m.hash FROM memories m WHERE m.id=:id AND (m.project_id IS NULL OR m.project_id=:pid)
              AND m.status='active' AND typeof(m.private)='integer' AND m.private=0 AND (m.expires_at IS NULL OR (typeof(m.expires_at)='integer' AND m.expires_at>:now AND m.expires_at<=${MAX_DATE}))
              AND (m.category<>'session' OR m.session_id=:sid) AND NOT EXISTS(SELECT 1 FROM graph_consolidation_seen seen WHERE seen.scope_key=:key AND seen.memory_id=m.id
                AND seen.source_version=m.version AND seen.source_hash=m.hash)`)
              .get({
                id: event.memory_id,
                pid: ctx.projectId,
                sid: ctx.sessionId,
                now,
                key: scopeKey(ctx),
              }) as Row | undefined;
            if (!memory || selected.has(memory.id)) {
              result.through = Number(event.id);
              continue;
            }
            const ref = { memoryId: memory.id, version: memory.version, hash: memory.hash };
            const sources = this.#sourceRows(db, [ref], ctx, now);
            if (!sources) {
              result.through = Number(event.id);
              continue;
            }
            const source = {
              privacy: 'public' as const,
              id: memory.id,
              version: memory.version,
              hash: memory.hash,
              title: sources[0].title,
              text: sources[0].body,
            };
            const size = utf8Bytes(JSON.stringify(source));
            if (result.sources.length >= limits.maxSources || bytes + size > limits.maxInputBytes) {
              if (!result.sources.length) result.state = 'held';
              break;
            }
            selected.add(source.id);
            result.sources.push(source);
            bytes += size;
            result.through = Number(event.id);
          }
          const refs = result.sources.map((s) => ({
            memoryId: s.id,
            version: s.version,
            hash: s.hash,
          }));
          for (const parent of parentRows(db, ctx, refs, now)) {
            const size = utf8Bytes(JSON.stringify(parent));
            if (bytes + size > limits.maxInputBytes) continue;
            bytes += size;
            result.parents.push(parent);
          }
          return result;
        });
      },
      claim: (contextValue, raw, maximumOutstanding = CONSOLIDATION_LIMITS.outstanding) => {
        const ctx = context(contextValue);
        const request = checkConsolidationRequest(raw);
        const now = this.#now();
        if (
          !Number.isSafeInteger(maximumOutstanding) ||
          maximumOutstanding < 1 ||
          maximumOutstanding > 20
        )
          throw invalid();
        if (request.projectId !== ctx.projectId || request.sessionId !== ctx.sessionId)
          throw invalid();
        return this.#session.transaction((db) => {
          const row = cursorRow(db, ctx);
          if (
            row?.claim_id ||
            (row?.cursor ?? 0) !== request.cursor ||
            request.through < request.cursor ||
            request.through >
              Number(db.prepare('SELECT COALESCE(MAX(id),0) AS n FROM memory_events').get()!.n)
          )
            throw new MemoryError('conflict', 'Consolidation cursor changed');
          if (pending(db) >= maximumOutstanding)
            throw new MemoryError('unavailable', 'Consolidation proposal queue full');
          const sources = revalidate(db, ctx, request.sources, now);
          const nextVersion = (row?.version ?? 0) + 1;
          if (
            !row &&
            Number(db.prepare('SELECT COUNT(*) AS n FROM graph_consolidation_cursors').get()!.n) >=
              64
          )
            throw unavailable();
          db.prepare(`INSERT INTO graph_consolidation_cursors VALUES(?,?,?,?,?,?) ON CONFLICT(scope_key) DO UPDATE SET
            version=excluded.version,claim_id=excluded.claim_id,claim_payload=excluded.claim_payload,updated_at=excluded.updated_at`).run(
            scopeKey(ctx),
            request.cursor,
            nextVersion,
            request.requestId,
            JSON.stringify(request),
            now,
          );
          return {
            claim: {
              id: request.requestId,
              cursor: request.cursor,
              through: request.through,
              version: nextVersion,
              sources: request.sources,
            },
            window: {
              cursor: request.cursor,
              through: request.through,
              sources: sources.map((m) => ({
                privacy: 'public',
                id: m.id,
                version: m.version,
                hash: m.hash,
                title: m.title,
                text: m.body,
              })),
              parents: parentRows(db, ctx, request.sources, now),
              outstanding: pending(db),
              state: 'ready',
            },
          };
        });
      },
      commit: (contextValue, claim, proposals, maximumOutstanding) => {
        const ctx = context(contextValue);
        const now = this.#now();
        if (
          !Array.isArray(proposals) ||
          proposals.length > 4 ||
          !Number.isSafeInteger(maximumOutstanding) ||
          maximumOutstanding < 1 ||
          maximumOutstanding > 20
        )
          throw invalid();
        for (const proposal of proposals) {
          checkGraphInput(proposal.input);
          screenPublicText(JSON.stringify(proposal));
        }
        return this.#session.transaction((db) => {
          const row = matching(db, ctx, claim);
          const expected = checkConsolidationRequest(JSON.parse(row.claim_payload));
          const sources = revalidate(db, ctx, claim.sources, now);
          if (pending(db) + proposals.length > maximumOutstanding)
            throw new MemoryError('unavailable', 'Consolidation proposal queue full');
          const ids: string[] = [];
          for (const proposal of proposals) {
            if (
              ![
                'fact',
                'duplicate',
                'merge',
                'contradiction',
                'entity',
                'relation',
                'summary',
                'profile',
              ].includes(proposal.kind) ||
              proposal.input.producer?.kind !== 'model' ||
              proposal.input.producer.model !== expected.model ||
              proposal.input.producer.version !==
                `consolidation-v1:${expected.providerId}:${proposal.kind}` ||
              proposal.input.supports.some(
                (ref: GraphSupport) =>
                  !claim.sources.some(
                    (s) =>
                      s.memoryId === ref.memoryId &&
                      s.version === ref.version &&
                      s.hash === ref.hash,
                  ),
              )
            )
              throw invalid();
            const kind = ['merge', 'duplicate'].includes(proposal.kind)
              ? 'fact'
              : proposal.kind === 'contradiction'
                ? 'relation'
                : proposal.kind;
            if (
              proposal.input.kind !== kind ||
              (['merge', 'duplicate'].includes(proposal.kind) &&
                proposal.input.supports.length < 2) ||
              (proposal.kind === 'contradiction' &&
                proposal.input.relation?.predicate !== 'contradicts') ||
              !Array.isArray(proposal.citations) ||
              proposal.citations.length !== proposal.input.supports.length
            )
              throw invalid();
            for (const citation of proposal.citations) {
              const source = sources.find((s) => s.id === citation.memoryId);
              if (
                !source ||
                !proposal.input.supports.some(
                  (s: GraphSupport) =>
                    s.memoryId === citation.memoryId &&
                    s.version === citation.version &&
                    s.hash === citation.hash,
                ) ||
                !Number.isSafeInteger(citation.start) ||
                !Number.isSafeInteger(citation.end) ||
                citation.start < 0 ||
                citation.end <= citation.start ||
                citation.end > source.body.length
              )
                throw invalid();
            }
            const artifact = this.#create(db, proposal.input, ctx, now);
            ids.push(artifact.id);
            db.prepare('INSERT INTO graph_consolidation_proposals VALUES(?,?,?,?,?)').run(
              artifact.id,
              proposal.kind,
              claim.id,
              claim.through,
              JSON.stringify(proposal.citations),
            );
          }
          markSeen(db, ctx, claim.sources);
          db.prepare(
            'UPDATE graph_consolidation_cursors SET cursor=?,version=version+1,claim_id=NULL,claim_payload=NULL,updated_at=? WHERE scope_key=?',
          ).run(claim.through, now, scopeKey(ctx));
          return { cursor: claim.through, ids, processed: claim.sources.length };
        });
      },
      capture: (contextValue, claim) => {
        const ctx = context(contextValue);
        const now = this.#now();
        return this.#session.read((db) => {
          matching(db, ctx, claim);
          const sources = revalidate(db, ctx, claim.sources, now);
          return {
            cursor: claim.cursor,
            through: claim.through,
            sources: sources.map((m) => ({
              privacy: 'public',
              id: m.id,
              version: m.version,
              hash: m.hash,
              title: m.title,
              text: m.body,
            })),
            parents: parentRows(db, ctx, claim.sources, now),
            outstanding: pending(db),
            state: 'ready',
          };
        });
      },
      status: (contextValue) => {
        const ctx = context(contextValue);
        return this.#session.read((db) => {
          const row = cursorRow(db, ctx);
          return { cursor: row?.cursor ?? 0, claim: claimValue(row), outstanding: pending(db) };
        });
      },
      abandon: (contextValue, id, expectedVersion) => {
        const ctx = context(contextValue);
        if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw invalid();
        version(expectedVersion);
        const now = this.#now();
        return this.#session.transaction((db) => {
          const row = cursorRow(db, ctx);
          const claim = claimValue(row);
          if (!claim || claim.id !== id || row!.version !== expectedVersion)
            throw new MemoryError('conflict', 'Consolidation reservation changed');
          markSeen(db, ctx, claim.sources);
          db.prepare(
            'UPDATE graph_consolidation_cursors SET cursor=?,version=version+1,claim_id=NULL,claim_payload=NULL,updated_at=? WHERE scope_key=?',
          ).run(claim.through, now, scopeKey(ctx));
          return { cursor: claim.through };
        });
      },
      proposals: (contextValue, limit) => {
        const ctx = context(contextValue);
        const now = this.#now();
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw invalid();
        return this.#session.read((db) =>
          db
            .prepare(`SELECT p.artifact_id,p.kind FROM graph_consolidation_proposals p JOIN graph_artifacts a ON a.id=p.artifact_id WHERE a.project_id IS :pid
          AND ${ELIGIBLE} ORDER BY a.seq LIMIT :limit`)
            .all({ ...bindings(ctx, now, ['proposed']), limit })
            .flatMap((row) => {
              const id = String(row.artifact_id);
              if (!this.#eligible(db, id, ctx, now, ['proposed'])) return [];
              try {
                return [
                  {
                    kind: row.kind as ConsolidationProposal['kind'],
                    artifact: this.#artifact(db, id),
                  },
                ];
              } catch (e) {
                if (e instanceof MemoryError && e.code === 'not_found') return [];
                throw e;
              }
            }),
        );
      },
    };
  }
  query(input: GraphQuery, context: Ctx): GraphSearch {
    checkGraphQuery(input);
    const ctx = caller(context);
    const now = this.#now();
    if (!this.enabled) return { items: [], visited: 0, edges: 0, truncated: false };
    const match = ftsQuery(input.text);
    if (!match) return { items: [], visited: 0, edges: 0, truncated: false };
    return this.#session.read((db) => {
      const levelFilter = 'AND a.level IN (SELECT value FROM json_each(:levels))';
      const levels = JSON.stringify(input.levels ?? [0, 1, 2, 3, 4]);
      const params = { ...bindings(ctx, now), match, levels, limit: GRAPH_LIMITS.seeds };
      const lexical = db
        .prepare(`SELECT a.id FROM graph_fts JOIN graph_artifacts a ON a.seq=graph_fts.rowid WHERE graph_fts MATCH :match AND ${ELIGIBLE} ${levelFilter}
        ORDER BY bm25(graph_fts),a.id LIMIT :limit`)
        .all(params)
        .map((r) => String(r.id))
        .filter((id) => this.#eligible(db, id, ctx, now));
      const alias = db
        .prepare(`SELECT DISTINCT a.id FROM graph_aliases n JOIN graph_artifacts a ON a.id=n.artifact_id WHERE n.alias IN (SELECT value FROM json_each(:aliases))
        AND ${ELIGIBLE} ${levelFilter} ORDER BY a.id LIMIT :limit`)
        .all({
          ...bindings(ctx, now),
          aliases: JSON.stringify([norm(input.text), ...terms(input.text)]),
          levels,
          limit: GRAPH_LIMITS.seeds,
        })
        .map((r) => String(r.id))
        .filter((id) => this.#eligible(db, id, ctx, now));
      const scores = graphFusion([
        { weight: 1, ids: lexical },
        { weight: 0.7, ids: alias },
      ]);
      const paths = new Map<string, string[][]>();
      const selected = new Set<string>();
      for (const [id] of [...scores]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, GRAPH_LIMITS.seeds)) {
        selected.add(id);
        paths.set(id, [[id]]);
      }
      let edges = 0;
      let truncated = false;
      let frontier = [...selected];
      const traversedEdges = new Set<string>();
      if (input.expand)
        for (let hop = 0; hop < (input.depth ?? 1) && frontier.length; hop++) {
          const edgeIds = db
            .prepare(`SELECT a.id FROM graph_edges e JOIN graph_artifacts a ON a.id=e.artifact_id
          WHERE (e.from_id IN (SELECT value FROM json_each(:frontier)) OR e.to_id IN (SELECT value FROM json_each(:frontier))) AND ${ELIGIBLE}
          ORDER BY a.id LIMIT :limit`)
            .all({
              ...bindings(ctx, now),
              frontier: JSON.stringify(frontier),
              limit: GRAPH_LIMITS.edges - edges + 1,
            })
            .map((r) => String(r.id));
          const next: string[] = [];
          for (const edgeId of edgeIds) {
            if (traversedEdges.has(edgeId)) continue;
            if (edges >= GRAPH_LIMITS.edges) {
              truncated = true;
              break;
            }
            if (!this.#eligible(db, edgeId, ctx, now)) continue;
            const edge = this.#artifact(db, edgeId).relation!;
            if (!this.#eligible(db, edge.from, ctx, now) || !this.#eligible(db, edge.to, ctx, now))
              continue;
            edges++;
            traversedEdges.add(edgeId);
            const origin = frontier.includes(edge.from) ? edge.from : edge.to;
            const destination = origin === edge.from ? edge.to : edge.from;
            for (const id of [edgeId, destination]) {
              if (!selected.has(id) && selected.size >= GRAPH_LIMITS.visited) {
                truncated = true;
                continue;
              }
              const path = [...(paths.get(origin)?.[0] ?? [origin]), edgeId, destination];
              if (!selected.has(id)) {
                selected.add(id);
                next.push(id);
                paths.set(id, [path]);
                scores.set(id, (scores.get(origin) ?? 1 / 61) * edge.weight * 0.7);
              }
            }
          }
          frontier = next;
        }
      const items = [...selected]
        .filter((id) => this.#eligible(db, id, ctx, now))
        .flatMap((id) => {
          try {
            return [
              {
                ...this.#artifact(db, id),
                score: scores.get(id) ?? 0,
                paths: paths.get(id) ?? [[id]],
              },
            ];
          } catch (error) {
            if (error instanceof MemoryError && error.code === 'not_found') return [];
            throw error;
          }
        })
        .filter((a) => !input.levels || input.levels.includes(a.level))
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
        .slice(0, input.limit ?? 10);
      return { items, visited: selected.size, edges, truncated };
    });
  }
  source({
    expand = false,
    depth = 1,
    levels,
  }: {
    expand?: boolean;
    depth?: 1 | 2;
    levels?: GraphLevel[];
  } = {}): ContextSource {
    return {
      id: 'graph',
      trust: this.enabled ? 'verified' : 'unsupported',
      weight: 0.7,
      halfLifeDays: 60,
      search: async (text, ctx, limit) =>
        this.query({ text, limit: Math.min(limit, 20), expand, depth, levels }, ctx).items.map(
          (a) => ({
            source: 'graph',
            id: a.id,
            title: a.title,
            text: a.text,
            category: `L${a.level} ${a.kind}`,
            rank: -a.score,
            at: a.recordedAt,
            accessCount: 0,
            hash: a.hash,
            // Reviewed aliases/paths establish semantic eligibility. Do not invent
            // a lexical match count; curated FTS retains its independent word gate.
          }),
        ),
    };
  }
}
