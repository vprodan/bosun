import type { SqliteSession } from './sqlite-session.ts';
import type { Ctx } from '../../core/domain/memory.ts';
import type {
  EmbeddingSource,
  EmbeddingSpace,
  EmbeddingRecord,
  VectorCandidate,
} from '../../core/domain/embedding.ts';
import { MemoryError } from '../../core/errors.ts';
import {
  embeddingText,
  normalizedVector,
  vectorBytes,
  readVector,
  cosine,
} from '../../core/embeddings.ts';
import { screenPublicText } from '../../core/secret-screen.ts';

const MAX_DATE = 8640000000000000,
  MAX_ROWS = 10000;
const visible = `m.status='active' AND typeof(m.private)='integer' AND m.private=0
  AND (m.project_id IS NULL OR m.project_id=:pid OR (typeof(m.shared)='integer' AND m.shared=1) OR m.project_id IN(SELECT value FROM json_each(:linked)))
  AND (m.category<>'session' OR m.session_id=:sid OR (typeof(m.shared)='integer' AND m.shared=1))
  AND (m.expires_at IS NULL OR (typeof(m.expires_at)='integer' AND m.expires_at>:now AND m.expires_at<=${MAX_DATE}))`;
const missing = () => new MemoryError('not_found', 'embedding source not found');
const invalid = () => new MemoryError('invalid', 'invalid embedding request');
function space(value: EmbeddingSpace) {
  if (
    !value ||
    typeof value.model !== 'string' ||
    !value.model ||
    value.model.length > 200 ||
    !/^[a-f0-9]{64}$/.test(value.digest) ||
    !Number.isSafeInteger(value.dimensions) ||
    value.dimensions < 1 ||
    value.dimensions > 4096 ||
    !['embeddinggemma-v1', 'plain-v1'].includes(value.transform)
  )
    throw invalid();
}
export class SqliteEmbeddings {
  #session: SqliteSession;
  #now: () => number;
  #hash: (title: string, body: string) => string;
  #inputHash: (text: string) => string;
  constructor(
    session: SqliteSession,
    deps: {
      now(): number;
      hash(title: string, body: string): string;
      inputHash(text: string): string;
    },
  ) {
    this.#session = session;
    this.#now = deps.now;
    this.#hash = deps.hash;
    this.#inputHash = deps.inputHash;
  }
  #bindings(ctx: Ctx) {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0 || now > MAX_DATE) throw invalid();
    return { pid: ctx.projectId, sid: ctx.sessionId, linked: JSON.stringify(ctx.linked), now };
  }
  #source(row: Record<string, unknown>): EmbeddingSource {
    for (const field of ['title', 'body', 'tags', 'source', 'source_ref'])
      if (typeof row[field] === 'string') screenPublicText(row[field] as string);
    if (
      typeof row.title !== 'string' ||
      typeof row.body !== 'string' ||
      this.#hash(row.title, row.body) !== row.hash
    )
      throw missing();
    return {
      memoryId: String(row.id),
      version: Number(row.version),
      hash: String(row.hash),
      title: row.title,
      body: row.body,
    };
  }
  capture(ids: readonly string[], ctx: Ctx): EmbeddingSource[] {
    if (
      ctx.audience !== 'owner' ||
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > 8 ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => typeof id !== 'string' || !id || id.length > 64)
    )
      throw invalid();
    return this.#session.read((db) =>
      ids.map((id) => {
        const row = db
          .prepare(`SELECT m.* FROM memories m WHERE m.id=:id AND ${visible}
        AND (m.project_id IS NULL OR m.project_id=:pid)`)
          .get({ id, ...this.#bindings({ ...ctx, linked: [] }) });
        if (!row) throw missing();
        return this.#source(row);
      }),
    );
  }
  store(records: readonly EmbeddingRecord[], ctx: Ctx) {
    if (ctx.audience !== 'owner' || !records.length || records.length > 64) throw invalid();
    const projected = records.map((record) => {
      space(record.space);
      if (
        !/^v_[a-z0-9_-]{1,96}$/.test(record.id) ||
        !record.memoryId ||
        record.memoryId.length > 64 ||
        !Number.isSafeInteger(record.version) ||
        record.version < 1 ||
        !/^([a-f0-9]{32})$/.test(record.hash) ||
        !Number.isSafeInteger(record.chunk) ||
        record.chunk < 0 ||
        record.chunk > 7 ||
        !Number.isSafeInteger(record.start) ||
        record.start < 0 ||
        !Number.isSafeInteger(record.end) ||
        record.end <= record.start ||
        record.end > 4000 ||
        !/^([a-f0-9]{64})$/.test(record.inputHash)
      )
        throw invalid();
      return {
        ...record,
        space: { ...record.space },
        vector: vectorBytes(normalizedVector(record.vector, record.space.dimensions)),
      };
    });
    return this.#session.transaction((db) => {
      const bindings = this.#bindings({ ...ctx, linked: [] });
      for (const record of projected) {
        const row = db
          .prepare(`SELECT m.* FROM memories m WHERE m.id=:id AND m.version=:version AND m.hash=:hash AND ${visible}
          AND (m.project_id IS NULL OR m.project_id=:pid)`)
          .get({ id: record.memoryId, version: record.version, hash: record.hash, ...bindings });
        if (!row) throw missing();
        const source = this.#source(row);
        if (
          record.end > source.body.length ||
          record.inputHash !==
            this.#inputHash(
              embeddingText(
                'document',
                record.space.transform,
                source.body.slice(record.start, record.end),
                source.title,
              ),
            )
        )
          throw invalid();
      }
      const count = Number(db.prepare('SELECT COUNT(*) n FROM memory_embeddings').get()?.n);
      if (!Number.isSafeInteger(count) || count < 0 || count + projected.length > MAX_ROWS)
        throw new MemoryError('unavailable', 'embedding capacity reached');
      for (const r of projected)
        db.prepare(`INSERT INTO memory_embeddings(id,memory_id,memory_version,memory_hash,chunk,start,end,model,model_digest,dimensions,transform,input_hash,vector,recorded_at,private)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`).run(
          r.id,
          r.memoryId,
          r.version,
          r.hash,
          r.chunk,
          r.start,
          r.end,
          r.space.model,
          r.space.digest,
          r.space.dimensions,
          r.space.transform,
          r.inputHash,
          r.vector,
          bindings.now,
        );
      return { stored: projected.length };
    });
  }
  // Exact scoped reference ranking; optional sqlite-vec backend qualification
  // remains separate. Scope/policy filters precede every vector distance call.
  spaces(
    selected: Omit<EmbeddingSpace, 'digest'> & { digest?: string },
    ctx: Ctx,
  ): EmbeddingSpace[] {
    return this.#session.read((db) =>
      db
        .prepare(`SELECT DISTINCT e.model,e.model_digest,e.dimensions,e.transform
      FROM memory_embeddings e JOIN memories m ON m.id=e.memory_id WHERE typeof(e.private)='integer' AND e.private=0
      AND e.model=:model AND e.dimensions=:dimensions AND e.transform=:transform
      AND (:digest IS NULL OR e.model_digest=:digest) AND e.memory_version=m.version AND e.memory_hash=m.hash
      AND ${visible} ORDER BY e.model_digest LIMIT 2`)
        .all({
          ...this.#bindings(ctx),
          model: selected.model,
          dimensions: selected.dimensions,
          transform: selected.transform,
          digest: selected.digest ?? null,
        })
        .map((row) => ({
          model: String(row.model),
          digest: String(row.model_digest),
          dimensions: Number(row.dimensions),
          transform: String(row.transform) as EmbeddingSpace['transform'],
        })),
    );
  }
  generation(selected: EmbeddingSpace, ctx: Ctx): string {
    space(selected);
    return this.#session.read((db) => {
      // Metadata only. Current privacy/scope/session/expiry eligibility is part
      // of the snapshot, so a cached public query cannot bypass revocation.
      const rows = db
        .prepare(`SELECT e.id,e.memory_version,e.memory_hash,e.input_hash,e.recorded_at
        FROM memory_embeddings e JOIN memories m ON m.id=e.memory_id
        WHERE typeof(e.private)='integer' AND e.private=0 AND e.model=:model AND e.model_digest=:digest
          AND e.dimensions=:dimensions AND e.transform=:transform
          AND e.memory_version=m.version AND e.memory_hash=m.hash AND ${visible}
        ORDER BY e.id LIMIT :limit`)
        .all({
          ...this.#bindings(ctx),
          model: selected.model,
          digest: selected.digest,
          dimensions: selected.dimensions,
          transform: selected.transform,
          limit: MAX_ROWS + 1,
        });
      if (rows.length > MAX_ROWS)
        throw new MemoryError('unavailable', 'embedding query capacity reached');
      return this.#inputHash(JSON.stringify(rows));
    });
  }
  search(
    query: readonly number[],
    selected: EmbeddingSpace,
    ctx: Ctx,
    options: { limit: number; minCosine: number; score?: (query: readonly number[], candidate: readonly number[]) => number },
  ): VectorCandidate[] {
    space(selected);
    if (
      !Number.isSafeInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > 20 ||
      !Number.isFinite(options.minCosine) ||
      options.minCosine < 0 ||
      options.minCosine > 1
    )
      throw invalid();
    const vector = normalizedVector(query, selected.dimensions);
    return this.#session.read((db) => {
      const rows = db
        .prepare(`SELECT m.*,e.chunk,e.start,e.end,e.vector FROM memory_embeddings e JOIN memories m ON m.id=e.memory_id
        WHERE typeof(e.private)='integer' AND e.private=0 AND e.model=:model AND e.model_digest=:digest AND e.dimensions=:dimensions AND e.transform=:transform
          AND e.memory_version=m.version AND e.memory_hash=m.hash AND ${visible} ORDER BY e.id LIMIT :limit`)
        .all({
          ...this.#bindings(ctx),
          model: selected.model,
          digest: selected.digest,
          dimensions: selected.dimensions,
          transform: selected.transform,
          limit: MAX_ROWS + 1,
        });
      if (rows.length > MAX_ROWS)
        throw new MemoryError('unavailable', 'embedding query capacity reached');
      const candidates: VectorCandidate[] = [];
      for (const row of rows) {
        const source = this.#source(row),
          start = Number(row.start),
          end = Number(row.end);
        if (
          !Number.isSafeInteger(start) ||
          start < 0 ||
          !Number.isSafeInteger(end) ||
          end <= start ||
          end > source.body.length
        )
          throw missing();
        const score = (options.score ?? cosine)(vector, readVector(row.vector as Uint8Array, selected.dimensions));
        if (!Number.isFinite(score) || score < -1 || score > 1) throw invalid();
        if (score >= options.minCosine)
          candidates.push({
            memoryId: source.memoryId,
            chunk: Number(row.chunk),
            start,
            end,
            cosine: score,
            title: source.title,
            text: source.body.slice(start, end),
            category: String(row.category),
            at: Number(row.updated_at),
            hash: source.hash,
          });
      }
      return candidates
        .sort(
          (a, b) =>
            b.cosine - a.cosine || a.memoryId.localeCompare(b.memoryId) || a.chunk - b.chunk,
        )
        .slice(0, options.limit);
    });
  }
  close() {
    this.#session.close();
  }
}
