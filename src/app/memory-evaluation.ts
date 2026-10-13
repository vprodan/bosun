import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import type { Env } from '../core/domain/inference.ts';
import { defaultConfig } from '../core/domain/config.ts';
import { BosunError } from '../core/errors.ts';
import {
  evaluateMemoryComparisons,
  type MemoryEvalArm,
  type MemoryEvalArms,
} from '../core/use-cases/evaluate-memory.ts';
import { createRetrieveContext } from '../core/use-cases/retrieve-context.ts';
import { createCuratedSource } from '../core/memory-source.ts';
import { memoryEvaluationDataset } from '../contracts/memory-evaluation.ts';
import { benchmarkDistribution } from '../core/memory-benchmark.ts';
import { graphFusion } from '../core/graph.ts';
import type { Memory, Ctx } from '../core/domain/memory.ts';
import type { ContextSource } from '../core/ports/context-source.ts';
import type { GraphArtifact } from '../core/domain/graph.ts';
import { contentHash } from '../platform/content-hash.ts';
import { runtimePaths } from '../platform/paths.ts';
import { DaemonOwner } from '../platform/daemon-owner.ts';
import { project } from '../platform/project.ts';
import { startDaemon } from './daemon.ts';
import { evaluationMcp } from './memory-evaluation-mcp.ts';
import { evaluationEmbeddings } from './memory-evaluation-embeddings.ts';
import { setupRuntime } from './setup.ts';
import { openDaemonMemory } from './memory.ts';

// Approved exports are loaded into new temporary final-runtime storage. This
// command opens no owner memory. Explicit embedding evaluation uses only the
// pinned public provider in its disposable replica; ordinary/hook arms infer nothing.
export async function runMemoryEvaluation(options: {
  input: unknown;
  env: Env;
  valid?(): boolean;
  surface?: 'hook-packing' | 'mcp';
  budgetTokens?: number;
  temporaryRoot?: string;
  embedding?: unknown;
}) {
  const dataset = memoryEvaluationDataset(options.input);
  const valid = options.valid ?? (() => true);
  const live = () => {
    if (!valid()) throw new BosunError('conflict', 'Memory evaluation source changed');
  };
  live();
  const surface = options.surface ?? 'hook-packing';
  const budget = options.budgetTokens ?? (surface === 'mcp' ? 1000 : 400);
  if (
    !['hook-packing', 'mcp'].includes(surface) ||
    !Number.isSafeInteger(budget) ||
    budget < 50 ||
    budget > 4000 ||
    (surface === 'hook-packing' && budget !== 400)
  )
    throw new BosunError('invalid', 'Invalid memory evaluation surface/budget');
  if (options.embedding !== undefined && surface !== 'mcp')
    throw new BosunError('unsupported', 'Vector evaluation requires the MCP surface');
  const embedding =
    options.embedding === undefined ? undefined : evaluationEmbeddings(options.embedding, live);
  const root = fs.realpathSync(options.temporaryRoot ?? os.tmpdir());
  if (!fs.statSync(root).isDirectory())
    throw new BosunError('invalid', 'Evaluation temporary root unavailable');
  if (surface === 'mcp' && Buffer.byteLength(path.join(root, 'be-XXXXXX', 's')) > 100)
    throw new BosunError(
      'invalid',
      'MCP evaluation temporary path is too long; use a shorter TMPDIR',
    );
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(root, surface === 'mcp' ? 'be-' : 'bosun-memory-eval-')),
  );
  fs.chmodSync(dir, 0o700);
  const env = {
    ...options.env,
    BOSUN_HOME: dir,
    BOSUN_SOCKET: path.join(dir, 's'),
    BOSUN_INSTALLATION_ID: '',
    NODE_DISABLE_COMPILE_CACHE: '1',
  };
  const paths = runtimePaths(env);
  const workspaces = new Map<string | null, { workspace: string; projectId: string }>();
  const contexts = [...dataset.notes, ...dataset.cases, ...(dataset.graph ?? [])];
  const createWorkspaces = () => {
    if (surface === 'mcp')
      for (const entry of contexts)
        if (!workspaces.has(entry.scope.projectId)) {
          const workspace = path.join(dir, `p${workspaces.size}`);
          fs.mkdirSync(path.join(workspace, '.git'), { recursive: true, mode: 0o700 });
          fs.chmodSync(workspace, 0o700);
          fs.writeFileSync(
            path.join(workspace, '.git', 'config'),
            `[remote "origin"]\nurl = https://example.invalid/bosun-evaluation/${workspaces.size}.git\n`,
            { flag: 'wx', mode: 0o600 },
          );
          workspaces.set(entry.scope.projectId, { workspace, projectId: project(workspace).id });
        }
  };
  const physical = (ctx: Ctx): Ctx => {
    if (surface !== 'mcp' || ctx.projectId === null) return ctx;
    const binding = workspaces.get(ctx.projectId);
    if (!binding) throw new BosunError('invalid', 'Evaluation scope mapping missing');
    return { ...ctx, projectId: binding.projectId };
  };
  const config = defaultConfig();
  config.memory.claudeMem = false;
  if (embedding) {
    config.graph.vectors = true;
    config.graph.embedding = embedding.settings;
  }
  let owner: DaemonOwner | undefined, memory: ReturnType<typeof openDaemonMemory> | undefined;
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined,
    mcp: ReturnType<typeof evaluationMcp> | undefined;
  const clock = {
    now: () => dataset.capturedAt,
    monotonic: () => performance.now(),
    hash: contentHash,
    dateLabel: (at: number) => new Date(at).toISOString().slice(0, 10),
    measure() {},
  };
  try {
    await setupRuntime(paths, config);
    live();
    createWorkspaces();
    if (embedding) {
      const file = path.join(dir, 'embedding-selection.json');
      const text = JSON.stringify({
        ...embedding.selection,
        datasetSha256: crypto.createHash('sha256').update(JSON.stringify(dataset)).digest('hex'),
      });
      const fd = fs.openSync(file, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, text);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      if (fs.readFileSync(file, 'utf8') !== text)
        throw new BosunError('unavailable', 'Embedding selection confirmation failed');
      live();
    }
    owner = new DaemonOwner(paths.owner);
    const authority = owner;
    let nextId = '';
    memory = openDaemonMemory({
      paths: { primary: paths.memory, view: paths.view, backups: paths.backups },
      assertOwner: () => {
        authority.assert();
        live();
      },
      memory: { ...clock, id: () => nextId, retention: { sessionTtlDays: 7, purgeAfterDays: 90 } },
      context: clock,
      docsIndex: { monotonic: clock.monotonic, measure() {} },
      publicationId: crypto.randomUUID,
    });
    const notes = new Map<string, Memory>();
    for (const note of dataset.notes) {
      live();
      nextId = note.id;
      const result = await memory.memory.store(
        {
          category: note.category,
          title: note.title,
          body: note.body,
          tags: note.tags,
          private: false,
          shared: false,
        },
        physical({ ...note.scope, linked: [], audience: 'owner' }),
      );
      live();
      notes.set(note.id, result.memory);
      if (result.duplicate || result.memory.id !== note.id)
        throw new BosunError('invalid', 'Memory evaluation contains duplicate source content');
    }
    const graphArtifacts = new Map<string, GraphArtifact>();
    for (const artifact of dataset.graph ?? []) {
      live();
      nextId = artifact.id.replace(/^g_/, 'm_');
      const ctx: Ctx = physical({ ...artifact.scope, linked: [], audience: 'owner' });
      const supports = artifact.supports.map((ref) => {
        const note = notes.get(ref.id);
        if (!note) throw new BosunError('invalid', 'Memory evaluation support missing');
        const start = note.body.indexOf(ref.quote);
        return {
          memoryId: note.id,
          version: note.version,
          hash: note.hash,
          ...(start < 0 ? {} : { start, end: start + ref.quote.length }),
        };
      });
      const proposal = memory.graph.create(
        {
          kind: artifact.kind,
          title: artifact.title,
          text: artifact.text,
          supports,
          entity: artifact.entity,
          relation: artifact.relation,
          parents: (artifact.parents ?? []).map((id) => {
            const parent = graphArtifacts.get(id);
            if (!parent) throw new BosunError('invalid', 'Memory evaluation parent missing');
            return { id, version: parent.version };
          }),
        },
        ctx,
      );
      const reviewed = memory.graph.review(
        proposal.id,
        proposal.version,
        'accept',
        ctx,
      ) as GraphArtifact;
      if (reviewed.id !== artifact.id || reviewed.status !== 'active')
        throw new BosunError('unavailable', 'Memory evaluation graph identity mismatch');
      graphArtifacts.set(reviewed.id, reviewed);
      live();
    }
    const graphTimes: number[] = [];
    const graphSource = memory.graph.source({ expand: true, depth: 1, levels: [1, 2] });
    const measuredGraph: ContextSource = {
      ...graphSource,
      async search(text, ctx, limit) {
        const started = performance.now();
        try {
          return await graphSource.search(text, ctx, limit);
        } finally {
          graphTimes.push(performance.now() - started);
        }
      },
    };
    const curated = createCuratedSource(memory.memory),
      lexical = memory.lexical;
    const arm = (sources: ContextSource[]): MemoryEvalArm => ({
      raw: async (text, ctx) => {
        const lists = await Promise.all(sources.map((source) => source.search(text, ctx, 20)));
        const hits = new Map(lists.flat().map((hit) => [hit.id, hit]));
        const scores = graphFusion(
          sources.map((source, index) => ({
            weight: source.weight,
            ids: lists[index].map((hit) => hit.id),
          })),
        );
        return [...scores]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, 20)
          .map(([id]) => {
            const hit = hits.get(id);
            if (!hit) throw new BosunError('unavailable', 'Memory evaluation identity missing');
            return hit;
          });
      },
      retrieve: createRetrieveContext(sources, clock),
    });
    const arms: MemoryEvalArms = {
      A: arm([curated]),
      B: arm([lexical]),
      ...(graphArtifacts.size || embedding ? { C: arm([lexical, measuredGraph]) } : {}),
      ...((dataset.graph ?? []).some((artifact) => ['summary', 'profile'].includes(artifact.kind))
        ? {
            E: arm([
              lexical,
              memory.graph.source({ expand: true, depth: 1, levels: [1, 2, 3, 4] }),
            ]),
          }
        : {}),
    };
    if (surface === 'mcp') {
      await memory.close();
      memory = undefined;
      owner.close();
      owner = undefined;
      live();
      daemon = await startDaemon({
        paths,
        config,
        runners: {},
        quotaSources: {},
        externalSources: [],
        providers: {},
        environment: env,
        memoryNow: clock.now,
        embeddingProvider: embedding?.provider,
      });
      live();
      if (embedding) {
        await embedding.index({ socket: paths.socket, notes: dataset.notes, workspaces });
        live();
      }
      mcp = evaluationMcp({ env, workspaces, valid });
      arms.A = mcp.arm(['curated']);
      arms.B = mcp.arm(['lexical']);
      if (arms.C) arms.C = mcp.arm(['lexical', 'graph']);
      if (embedding) arms.D = mcp.arm(['lexical', 'graph', 'vectors']);
      if (arms.E)
        arms.E = mcp.arm(['lexical', 'graph', 'overview', ...(embedding ? ['vectors'] : [])]);
    }
    const report = await evaluateMemoryComparisons(dataset, arms, clock.monotonic, valid, {
      surface,
      budgetTokens: budget,
    });
    live();
    return {
      ...report,
      ...(embedding ? { embedding: embedding.report() } : {}),
      ...(mcp
        ? {
            mcp: mcp.report(),
            scopeProjection: {
              mode: 'isolated-workspaces',
              bindings: [...workspaces].map(([logicalProjectId, { projectId }]) => ({
                logicalProjectId,
                replicaProjectId: projectId,
              })),
            },
          }
        : {}),
      graphStage: {
        latency: benchmarkDistribution(graphTimes),
        budgetMs: 2,
        scope: 'explicit-graph-source',
        includesAliasLookup: false,
        compiledQualification: 'unverified',
      },
      runtime: { node: process.versions.node, sqlite: process.versions.sqlite },
      ownerStorageOpened: false,
      modelsCalled: embedding !== undefined,
    };
  } finally {
    try {
      await mcp?.close();
    } finally {
      try {
        await daemon?.close();
      } finally {
        try {
          await memory?.close();
        } finally {
          try {
            owner?.close();
          } finally {
            fs.rmSync(dir, { recursive: true, force: true });
          }
        }
      }
    }
  }
}
