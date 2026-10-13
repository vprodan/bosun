import type { SqliteDatabase } from '../platform/sqlite.ts';
import crypto from 'node:crypto';
import { BosunError, MemoryError } from '../core/errors.ts';
import type { ContextSource } from '../core/ports/context-source.ts';
import type { Ctx } from '../core/domain/memory.ts';
import { createCuratedSource } from '../core/memory-source.ts';
import {
  createRetrieveContext,
  type ContextDependencies,
  type ContextOptions,
} from '../core/use-cases/retrieve-context.ts';
import {
  CutoverWriter,
  publishMemoryView,
  type CutoverPaths,
  type PublicationReceipt,
} from '../adapters/memory/sqlite-cutover.ts';
import { SqliteMemoryStore, type MemoryDependencies } from '../adapters/memory/sqlite-store.ts';
import { SqliteDocs, type DocsScope } from '../adapters/memory/sqlite-docs.ts';
import {
  SqliteDocsIndex,
  type DocsIndexDependencies,
} from '../adapters/memory/sqlite-docs-index.ts';
import { checkDocsStorage, enumerateDocs, inspectDoc } from '../adapters/memory/docs-filesystem.ts';
import type { SqliteSession } from '../adapters/memory/sqlite-session.ts';
import { SqliteEmbeddings } from '../adapters/memory/sqlite-embedding.ts';
import { SqliteGraph } from '../adapters/memory/sqlite-graph.ts';
import { createLexicalSource } from '../core/lexical-source.ts';

type DocsTiming = Pick<DocsIndexDependencies, 'monotonic' | 'measure'>;
export type DaemonMemoryOptions = {
  paths: CutoverPaths;
  assertOwner(): void;
  memory: MemoryDependencies;
  context: ContextDependencies;
  docsIndex: DocsTiming;
  publicationId(): string;
  externalSources?: readonly ContextSource[];
  curatedSource?: ContextSource;
  beforeWrite?: () => void;
  graphEnabled?: boolean;
  graphContext?: { enabled: boolean; expand?: boolean; depth?: 1 | 2 };
};
const unavailable = (unknown = false) =>
  new BosunError(
    'unavailable',
    'Daemon memory unavailable',
    unknown ? { details: { outcome: 'unknown' } } : undefined,
  );
function unknownOutcome(error: unknown): boolean {
  try {
    return error instanceof BosunError && error.details?.outcome === 'unknown';
  } catch {
    return false;
  }
}

export function openDaemonMemory(options: DaemonMemoryOptions) {
  let writer: CutoverWriter | undefined;
  let closed = false;
  let closing = false;
  let fenced = false;
  let publication: Promise<PublicationReceipt> | null = null;
  let closePromise: Promise<void> | null = null;
  try {
    const paths = Object.freeze({ ...options.paths });
    const assertOwner = options.assertOwner;
    const memoryDeps = { ...options.memory, retention: { ...options.memory.retention } };
    const contextDeps = { ...options.context };
    const docsTiming = { ...options.docsIndex };
    const publicationId = options.publicationId;
    const suppliedSources = [...(options.externalSources ?? [])];
    function owned(): void {
      if (closed || fenced) throw unavailable(fenced);
      try {
        assertOwner();
      } catch {
        throw unavailable();
      }
    }
    function live(): void {
      owned();
      if (closing || publication) throw unavailable();
    }
    function error(e: unknown): never {
      if (unknownOutcome(e)) {
        fenced = true;
        try {
          writer?.close();
        } catch {}
        throw unavailable(true);
      }
      if (e instanceof MemoryError) throw e;
      throw unavailable();
    }
    live();
    writer = new CutoverWriter(paths);
    live();
    // Each facet is borrowed. Its close disables only that facet, never the shared registered native owner.
    function borrowed(): SqliteSession {
      let facetClosed = false;
      const active = () => {
        live();
        if (facetClosed) throw unavailable();
      };
      return {
        read<T>(fn: (db: SqliteDatabase) => T): T {
          active();
          try {
            return writer!.read((db) => {
              active();
              const result = fn(db);
              active();
              return result;
            });
          } catch (e) {
            return error(e);
          }
        },
        transaction<T>(fn: (db: SqliteDatabase) => T): T {
          active();
          try {
            return writer!.transaction((db) => {
              active();
              options.beforeWrite?.();
              const result = fn(db);
              active();
              return result;
            });
          } catch (e) {
            return error(e);
          }
        },
        close() {
          facetClosed = true;
        },
      };
    }
    const memory = new SqliteMemoryStore(borrowed(), memoryDeps);
    const embeddings = new SqliteEmbeddings(borrowed(), {
      ...memoryDeps,
      inputHash: (text) => crypto.createHash('sha256').update(text).digest('hex'),
    });
    const schemaVersion = writer.schemaVersion;
    const graph = new SqliteGraph(
      borrowed(),
      {
        now: memoryDeps.now,
        hash: memoryDeps.hash,
        artifactHash: (value) => crypto.createHash('sha256').update(value).digest('hex'),
        id(now) {
          const id = memoryDeps.id(now);
          return `g_${id.replace(/^m_/, '')}`;
        },
      },
      schemaVersion,
      options.graphEnabled ?? true,
    );
    // Automatic graph packing is enabled only after the caller's retrieval evaluation.
    const graphSources =
      options.graphContext?.enabled && graph.enabled ? [graph.source(options.graphContext)] : [];
    const curated = options.curatedSource ?? createCuratedSource(memory);
    const lexical = createLexicalSource(memory, graph);
    const externalSources: readonly ContextSource[] = Object.freeze(
      suppliedSources.flatMap((source) => {
        if (source.trust === 'unsupported' || source.trust === 'unverified') return [];
        let sourceClosed = false;
        return [
          Object.freeze({
            id: source.id,
            trust: source.trust,
            weight: source.weight,
            halfLifeDays: source.halfLifeDays,
            async search(text: string, caller: Ctx, limit: number) {
              live();
              if (sourceClosed) throw unavailable();
              const result = await source.search(text, caller, limit);
              live();
              return result;
            },
            close() {
              if (!sourceClosed) {
                sourceClosed = true;
                source.close?.();
              }
            },
          }),
        ];
      }),
    );
    const retrieveCurated = createRetrieveContext(
      [curated, ...graphSources, ...externalSources],
      contextDeps,
    );
    if (
      ![docsTiming.monotonic, docsTiming.measure, publicationId].every(
        (fn) => typeof fn === 'function',
      )
    )
      throw new MemoryError('invalid', 'invalid daemon memory dependencies');
    function project(scope: DocsScope) {
      live();
      const session = borrowed();
      let projectClosed = false;
      let query = new SqliteDocs(session, scope);
      const active = () => {
        live();
        if (projectClosed) throw unavailable();
      };
      const docs: ContextSource = {
        id: 'docs',
        trust: 'verified',
        weight: 0.8,
        halfLifeDays: 90,
        async search(text, ctx, limit) {
          active();
          const hits = await query.search(text, ctx, limit);
          active();
          // Repeat directory membership for persisted paths, including newly
          // opened facets with no indexing exclusions. This metadata-only probe
          // never opens document bodies or enumerates/indexes the source tree.
          return hits.filter((hit) => {
            const source = inspectDoc(query.scope.root, hit.id, undefined, false);
            return (source.state === 'file' || source.state === 'missing') && source.valid();
          });
        },
        close() {
          projectClosed = true;
          session.close();
        },
      };
      const retrieve = createRetrieveContext(
        [curated, docs, ...graphSources, ...externalSources],
        contextDeps,
      );
      return {
        docs,
        index() {
          active();
          const receipt = new SqliteDocsIndex(session, query.scope, {
            enumerate: enumerateDocs,
            inspect: inspectDoc,
            checkStorage: checkDocsStorage,
            ...docsTiming,
          }).index();
          if (receipt.state === 'indexed')
            query = new SqliteDocs(session, {
              ...query.scope,
              excludedRoots: receipt.excludedRoots,
            });
          return receipt;
        },
        async retrieve(task: string, caller: Ctx, settings: ContextOptions) {
          active();
          return retrieve(task, caller, settings);
        },
        close() {
          docs.close!();
        },
      };
    }
    function publish(): Promise<PublicationReceipt> {
      live();
      // Existing format1 publication fences this cached writer. Explicit restart, never silent refresh/replay.
      publication = publishMemoryView({
        paths,
        now() {
          owned();
          return memoryDeps.now();
        },
        id() {
          owned();
          return publicationId();
        },
        checkpoint() {
          owned();
        },
      })
        .catch((e) => error(e))
        .finally(() => {
          publication = null;
        });
      return publication;
    }
    function close(): Promise<void> {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = (async () => {
        let failure: unknown;
        try {
          await publication;
        } catch (e) {
          failure = e;
        }
        closed = true;
        for (const source of externalSources)
          try {
            source.close?.();
          } catch {
            failure ??= unavailable();
          }
        try {
          writer!.close();
        } catch (e) {
          failure ??= unavailable(unknownOutcome(e));
        }
        if (failure) throw failure;
      })();
      return closePromise;
    }
    return {
      memory,
      graph,
      embeddings,
      lexical,
      schemaVersion,
      project,
      publish,
      close,
      externalSources,
      async retrieve(task: string, caller: Ctx, settings: ContextOptions) {
        live();
        return retrieveCurated(task, caller, settings);
      },
      expire: (now?: number) => memory.expire(now),
      touch: (ids: string[], now?: number) => memory.touch(ids, now),
      prune: (now?: number) => memory.prune(now),
    };
  } catch (e) {
    try {
      writer?.close();
    } catch {}
    if (unknownOutcome(e)) throw unavailable(true);
    if (e instanceof MemoryError) throw e;
    throw unavailable();
  }
}
