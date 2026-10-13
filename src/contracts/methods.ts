import { embeddingIndexRequest } from './embedding.ts';
import { z } from 'zod';
import { remoteViewAcquire, remoteViewRelease, remoteViewRefresh } from './remote-view.ts';
import { STORE, PATCH, QUERY } from './memory.ts';
import { memoryAutoStoreSchema } from './memory-suggestion.ts';
import { routerEvaluationRequest, routerCaptureRequest } from './router-evaluation.ts';
import type { Schema } from './schema.ts';
import type { StoreInput, Patch, Query } from '../core/domain/memory.ts';
import { BosunError } from '../core/errors.ts';
import { requirePublicInput } from '../core/policy.ts';
import type { RpcRequest } from './rpc.ts';
import { handoffCreateSchema, handoffBundleSchema, handoffSummarizeSchema } from './handoff.ts';
import { publicSummaryEvidence } from '../core/use-cases/summarize-evidence.ts';
import { GraphInputSchema, GraphQuerySchema } from './graph.ts';
import { consolidationSubmitSchema } from './consolidation.ts';
import { profileExportSchema, profileDocumentSchema, profilePreviewSchema } from './profile.ts';
import { workspaceCreateSchema, workspaceIdSchema } from './workspace.ts';
import { OPERATIONS } from '../core/dispatch-policy.ts';
import { HOSTS } from '../core/domain/config.ts';
import {
  managedStartSchema,
  managedTurnSchema,
  managedGetSchema,
  managedCaptureSchema,
  managedRetireSchema,
  managedAuthoritySchema,
  managedHandoffSchema,
} from './managed.ts';

type Options = {
  mutation?: boolean;
  ownerOnly?: boolean;
  inference?: boolean;
  tool?: string;
  description?: string;
  modelSchema?: z.ZodType;
};
function method<S extends z.ZodType>(schema: S, options: Options = {}) {
  return { schema, ...options };
}
const empty = z.strictObject({});
const id = z.string().min(1).max(64);
const jobId = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
// This reviewed subset is JSON Schema. Its readonly enum typing needs an adapter
// at Zod's mutable schema type; runtime conversion uses the real pinned library.
const memorySchema = <T>(schema: Schema): z.ZodType<T> =>
  z.fromJSONSchema(schema as z.core.JSONSchema.JSONSchema) as z.ZodType<T>;
const jsonStore = memorySchema<StoreInput>(STORE);
const jsonPatch = memorySchema<Patch>(PATCH);
const modelPatch = memorySchema<Patch>({
  ...PATCH,
  properties: { ...PATCH.properties, private: { type: 'boolean', enum: [true] } },
});
const queryProperties = Object.fromEntries(
  Object.entries(QUERY.properties!).filter(([key]) => key !== 'touch'),
);
const jsonQuery = memorySchema<Query>({ ...QUERY, properties: queryProperties });
const modelQuery = memorySchema<Query>({
  ...QUERY,
  properties: { ...queryProperties, includePrivate: { type: 'boolean', enum: [false] } },
});
const update = (patch: z.ZodType<Patch>) =>
  z.strictObject({ id, expectedVersion: z.number().int().min(1), patch });
const dispatchPolicySchema = z.strictObject({
  operation: z.enum(OPERATIONS),
  files: z.array(z.string().min(1).max(512)).max(64),
  noDelegation: z.boolean().optional(),
  exactModel: z.string().min(1).max(200).optional(),
});
const jobFields = {
  privacy: z.literal('public'),
  requestId: jobId,
  taskId: jobId,
  runnerId: jobId,
  prompt: z.string().min(1).max(32768),
  access: z.enum(['read', 'edit']),
  model: z.string().min(1).max(200),
  effort: z.string().min(1).max(80).optional(),
  maxTurns: z.number().int().min(1).max(100).optional(),
  policy: dispatchPolicySchema.optional(),
};
const quotaSelection = z.strictObject({ runnerId: jobId, model: z.string().min(1).max(200) });
const routeObservationId = z
  .string()
  .regex(/^(?:[a-f0-9]{10}|[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/);

export const METHODS = {
  'remote.vectors.search': method(
    z.strictObject({
      privacy: z.literal('public'),
      text: z.string().min(1).max(4000),
      limit: z.number().int().min(1).max(20),
    }),
    { inference: true },
  ),
  'remote.graph.search': method(
    z.strictObject({
      privacy: z.literal('public'),
      text: z.string().max(2000),
      limit: z.number().int().min(1).max(20),
      levels: z
        .array(z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]))
        .min(1)
        .max(4)
        .optional(),
    }),
  ),
  'remote.lexical.search': method(
    z.strictObject({
      privacy: z.literal('public'),
      text: z.string().max(2000),
      limit: z.number().int().min(1).max(20),
    }),
  ),
  'remote.view.acquire': method(remoteViewAcquire, { ownerOnly: true, mutation: true }),
  'remote.view.release': method(remoteViewRelease, { ownerOnly: true, mutation: true }),
  'remote.view.get': method(remoteViewRelease, { ownerOnly: true }),
  'remote.view.refresh': method(remoteViewRefresh, { ownerOnly: true, mutation: true }),
  'remote.view.invalidate': method(empty, { ownerOnly: true, mutation: true }),
  'remote.view.reconcile': method(empty, { ownerOnly: true, mutation: true }),
  'remote.view.status': method(empty, { ownerOnly: true }),
  'daemon.status': method(empty),
  'managed.start': method(managedStartSchema, { ownerOnly: true, mutation: true, inference: true }),
  'managed.turn': method(managedTurnSchema, { ownerOnly: true, mutation: true, inference: true }),
  'managed.get': method(managedGetSchema, { ownerOnly: true }),
  'managed.capture': method(managedCaptureSchema, { ownerOnly: true, inference: true }),
  'managed.retire': method(managedRetireSchema, { ownerOnly: true, mutation: true }),
  'managed.authorize': method(managedAuthoritySchema, {
    ownerOnly: true,
    mutation: true,
    inference: true,
  }),
  'managed.handoff': method(managedHandoffSchema, {
    ownerOnly: true,
    mutation: true,
    inference: true,
  }),
  'route.classify': method(
    z.strictObject({ privacy: z.literal('public'), text: z.string().min(1).max(24000) }),
    { inference: true },
  ),
  'route.status': method(empty, { ownerOnly: true }),
  'route.observations': method(
    z.strictObject({
      legacy: z.boolean().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    { ownerOnly: true },
  ),
  'route.label': method(
    z.strictObject({
      id: routeObservationId,
      label: z.enum(['scout', 'local', 'worker', 'main']),
      expectedVersion: z.number().int().min(0),
      legacy: z.boolean().optional(),
    }),
    { ownerOnly: true, mutation: true },
  ),
  'route.stats': method(z.strictObject({ legacy: z.boolean().optional() }), { ownerOnly: true }),
  'route.evaluate': method(routerEvaluationRequest, { ownerOnly: true, inference: true }),
  'route.capture': method(routerCaptureRequest, {
    ownerOnly: true,
    inference: true,
    mutation: true,
  }),
  'route.frozen': method(z.strictObject({ id: jobId }), { ownerOnly: true }),
  'hook.candidates': method(z.strictObject({ task: z.string().min(1).max(8000) })),
  'memory.store': method(jsonStore, {
    mutation: true,
    tool: 'memory_store',
    description:
      'Save a durable fact with the user’s agreement; never secrets. Private replies are opaque.',
  }),
  'memory.embed': method(embeddingIndexRequest, {
    ownerOnly: true,
    inference: true,
    mutation: true,
  }),
  'memory.autoStore': method(memoryAutoStoreSchema, {
    ownerOnly: true,
    mutation: true,
    inference: true,
  }),
  'memory.search': method(jsonQuery, {
    modelSchema: modelQuery,
    tool: 'memory_search',
    description: 'Search public curated memory in this project and configured linked projects.',
  }),
  'memory.get': method(z.strictObject({ id, events: z.boolean().optional() }), {
    modelSchema: z.strictObject({ id }),
    tool: 'memory_get',
    description: 'Read a memory by id. Private or unclassified records have opaque replies.',
  }),
  'memory.update': method(update(jsonPatch), {
    modelSchema: update(modelPatch),
    mutation: true,
    tool: 'memory_update',
    description:
      'Update a public memory at its expected version. Making a note public requires the owner CLI.',
  }),
  'memory.delete': method(z.strictObject({ id }), {
    mutation: true,
    tool: 'memory_delete',
    description: 'Archive a public memory.',
  }),
  'memory.accept': method(z.strictObject({ id }), { mutation: true, ownerOnly: true }),
  'memory.reject': method(z.strictObject({ id }), { mutation: true, ownerOnly: true }),
  'memory.purge': method(z.strictObject({ id }), { mutation: true, ownerOnly: true }),
  'memory.stats': method(empty, { ownerOnly: true }),
  'memory.maintain': method(
    z.strictObject({
      action: z.enum(['expire', 'prune', 'touch']),
      ids: z.array(id).max(100).optional(),
    }),
    { mutation: true, ownerOnly: true },
  ),
  'memory.publish': method(empty, { mutation: true, ownerOnly: true }),
  'graph.create': method(GraphInputSchema, { mutation: true, ownerOnly: true }),
  'graph.get': method(z.strictObject({ id }), {
    tool: 'graph_get',
    description: 'Read a reviewed scoped graph artifact with current public evidence.',
  }),
  'graph.query': method(GraphQuerySchema, {
    tool: 'graph_query',
    description:
      'Search reviewed graph memory; optional expansion is bounded and retains current source lineage.',
  }),
  'graph.explain': method(z.strictObject({ id }), {
    tool: 'graph_explain',
    description: 'Inspect current source versions and lineage for an eligible graph artifact.',
  }),
  'graph.review': method(
    z.strictObject({
      id,
      expectedVersion: z.number().int().min(1),
      action: z.enum(['accept', 'reject']),
    }),
    { mutation: true, ownerOnly: true },
  ),
  'graph.revoke': method(z.strictObject({ id, expectedVersion: z.number().int().min(1) }), {
    mutation: true,
    ownerOnly: true,
  }),
  'graph.backfill': method(z.strictObject({ limit: z.number().int().min(1).max(200).optional() }), {
    mutation: true,
    ownerOnly: true,
  }),
  'graph.exportProfile': method(z.strictObject({ id }), { ownerOnly: true }),
  'consolidation.run': method(consolidationSubmitSchema, { mutation: true, ownerOnly: true }),
  'consolidation.status': method(empty, { ownerOnly: true }),
  'consolidation.proposals': method(
    z.strictObject({ limit: z.number().int().min(1).max(20).optional() }),
    { ownerOnly: true },
  ),
  'consolidation.abandon': method(
    z.strictObject({ id: jobId, expectedVersion: z.number().int().min(1) }),
    { mutation: true, ownerOnly: true },
  ),
  'profile.export': method(profileExportSchema, { ownerOnly: true }),
  'profile.inspect': method(profileDocumentSchema, { ownerOnly: true }),
  'profile.preview': method(profilePreviewSchema, { ownerOnly: true }),
  'context.retrieve': method(
    z.strictObject({
      task: z.string().min(1).max(8000),
      budgetTokens: z.number().int().min(50).max(4000).optional(),
      includeCandidates: z.boolean().optional(),
      privacy: z.enum(['public', 'private', 'unknown']).optional(),
      sources: z
        .array(z.enum(['curated', 'lexical', 'docs', 'claude-mem', 'graph', 'overview', 'vectors']))
        .max(7)
        .optional(),
    }),
    {
      tool: 'context_retrieve',
      description:
        'Retrieve ranked public notes, indexed documentation and reviewed external observations. Graph and vectors are explicit opt-ins; vectors require privacy:"public".',
    },
  ),
  'docs.index': method(empty, { mutation: true, ownerOnly: true }),
  'job.submit': method(
    z.strictObject({ ...jobFields, allowUnknownQuota: z.boolean().optional() }),
    {
      modelSchema: z.strictObject(jobFields),
      mutation: true,
      inference: true,
      tool: 'job_submit',
      description:
        'Submit an explicitly public bounded task with a pinned native runner/model and a stable request id. Unverified quota holds by default.',
    },
  ),
  'job.watch': method(z.strictObject({ id: jobId, near: z.string().regex(/^term_[a-zA-Z0-9_-]+$/).max(200).optional() }), { ownerOnly: true, mutation: true }),
  'job.watchGet': method(z.strictObject({ id: jobId }), { ownerOnly: true }),
  'job.watchReconcile': method(z.strictObject({ id: jobId }), { ownerOnly: true }),
  'job.get': method(z.strictObject({ id: jobId }), {
    tool: 'job_get',
    description: 'Inspect scoped job metadata.',
  }),
  'job.result': method(z.strictObject({ id: jobId }), {
    tool: 'job_result',
    description: 'Read a scoped completed job’s bounded result.',
  }),
  'job.list': method(z.strictObject({ limit: z.number().int().min(1).max(100).optional() })),
  'job.events': method(
    z.strictObject({
      after: z.number().int().min(0),
      limit: z.number().int().min(1).max(100).optional(),
    }),
  ),
  'job.cancel': method(z.strictObject({ id: jobId }), {
    mutation: true,
    tool: 'job_cancel',
    description: 'Request cancellation; running effects may remain unknown.',
  }),
  'job.release': method(z.strictObject({ id: jobId }), { mutation: true, ownerOnly: true }),
  'job.retention': method(empty, { ownerOnly: true }),
  'job.policy': method(z.strictObject({ id: jobId }), { ownerOnly: true }),
  'job.prune': method(z.strictObject({ limit: z.number().int().min(1).max(100).optional() }), {
    mutation: true,
    ownerOnly: true,
  }),
  'quota.status': method(empty, { ownerOnly: true }),
  'usage.list': method(z.strictObject({ limit: z.number().int().min(1).max(100).optional() }), {
    ownerOnly: true,
  }),
  'usage.daily': method(z.strictObject({ limit: z.number().int().min(1).max(100).optional() }), {
    ownerOnly: true,
  }),
  'notification.status': method(empty, { ownerOnly: true }),
  'workspace.create': method(workspaceCreateSchema, { mutation: true, ownerOnly: true }),
  'workspace.get': method(workspaceIdSchema, { ownerOnly: true }),
  'workspace.list': method(empty, { ownerOnly: true }),
  'workspace.reconcile': method(workspaceIdSchema, { ownerOnly: true }),
  'workspace.prunePreview': method(workspaceIdSchema, { ownerOnly: true }),
  'workspace.submit': method(
    z.strictObject({
      ...jobFields,
      id: z.string().regex(/^w_[a-f0-9]{32}$/),
      expectedVersion: z.number().int().min(1),
      allowUnknownQuota: z.boolean().optional(),
    }),
    { ownerOnly: true, mutation: true, inference: true },
  ),
  'spin.submit': method(
    z.strictObject({
      ...jobFields,
      name: workspaceCreateSchema.shape.name,
      base: workspaceCreateSchema.shape.base,
      allowUnknownQuota: z.boolean().optional(),
    }),
    { ownerOnly: true, mutation: true, inference: true },
  ),
  'review.submit': method(
    z.strictObject({
      privacy: z.literal('public'),
      requestId: jobId,
      runnerId: z.enum(HOSTS),
      model: z.string().min(1).max(200),
      effort: z.string().min(1).max(80).optional(),
      base: z.string().min(1).max(200).optional(),
      paths: z.array(z.string().min(1).max(512)).min(1).max(64).optional(),
      sourceHost: z.enum(HOSTS).optional(),
      allowUnknownQuota: z.boolean().optional(),
    }),
    { ownerOnly: true, mutation: true, inference: true },
  ),
  'review.get': method(z.strictObject({ id: z.string().regex(/^rev_[a-f0-9]{32}$/) }), {
    ownerOnly: true,
  }),
  'check.submit': method(
    z.strictObject({
      privacy: z.literal('public'),
      requestId: jobId,
      reviewId: z.string().regex(/^rev_[a-f0-9]{32}$/),
      command: z.string().min(1).max(4096),
      args: z.array(z.string().max(8192)).max(64),
      timeoutMs: z.number().int().min(1).max(300000).optional(),
    }),
    { ownerOnly: true, mutation: true, inference: true },
  ),
  'check.get': method(z.strictObject({ id: z.string().regex(/^chk_[a-f0-9]{32}$/) }), {
    ownerOnly: true,
  }),
  'card.submit': method(
    z.strictObject({
      privacy: z.literal('public'),
      requestId: jobId,
      status: z.enum(['todo', 'in-progress', 'in-review', 'completed']),
      comment: z.string().min(1).max(1024).optional(),
    }),
    { ownerOnly: true, mutation: true, inference: true },
  ),
  'card.get': method(z.strictObject({ id: z.string().regex(/^card_[a-f0-9]{32}$/) }), {
    ownerOnly: true,
  }),
  'card.reconcile': method(z.strictObject({ id: z.string().regex(/^card_[a-f0-9]{32}$/) }), {
    ownerOnly: true,
  }),
  'card.acknowledge': method(
    z.strictObject({
      id: z.string().regex(/^card_[a-f0-9]{32}$/),
      expectedVersion: z.number().int().min(1),
      observationHash: z.string().regex(/^[a-f0-9]{64}$/),
    }),
    { ownerOnly: true, mutation: true },
  ),
  'quota.refresh': method(quotaSelection, { mutation: true, ownerOnly: true }),
  'handoff.create': method(handoffCreateSchema, {
    mutation: true,
    ownerOnly: true,
    inference: true,
  }),
  'handoff.summarize': method(handoffSummarizeSchema, {
    mutation: true,
    ownerOnly: true,
    inference: true,
  }),
  'handoff.get': method(z.strictObject({ id: jobId }), { ownerOnly: true }),
  'handoff.list': method(z.strictObject({ limit: z.number().int().min(1).max(100).optional() }), {
    ownerOnly: true,
  }),
  'handoff.import': method(
    z.strictObject({ privacy: z.literal('public'), requestId: jobId, bundle: handoffBundleSchema }),
    { mutation: true, ownerOnly: true, inference: true },
  ),
} as const;
export type MethodName = keyof typeof METHODS;
export type MethodParams<K extends MethodName> = z.infer<(typeof METHODS)[K]['schema']>;
export function methodDefinition(name: string): (typeof METHODS)[MethodName] {
  if (!Object.hasOwn(METHODS, name)) throw new BosunError('unsupported', 'Method unavailable');
  return METHODS[name as MethodName];
}
export function methodParams(request: RpcRequest): unknown {
  const definition: Options & { schema: z.ZodType } = methodDefinition(request.method);
  if (definition.ownerOnly && request.scope?.audience !== 'owner')
    throw new BosunError('unsupported', 'Owner operation required');
  if (definition.inference) requirePublicInput(request.params);
  if (request.method === 'context.retrieve') {
    const sources = Object.getOwnPropertyDescriptor(request.params, 'sources');
    if (
      sources &&
      Object.hasOwn(sources, 'value') &&
      Array.isArray(sources.value) &&
      sources.value.includes('vectors')
    )
      requirePublicInput(request.params);
  }
  if (request.method === 'handoff.summarize') {
    const raw = Object.getOwnPropertyDescriptor(request.params, 'evidence');
    if (!raw || !Object.hasOwn(raw, 'value') || !Array.isArray(raw.value) || raw.value.length > 100)
      throw new BosunError('invalid', 'Invalid summary evidence');
    for (const row of raw.value) publicSummaryEvidence(row);
  }
  if (
    request.method === 'job.submit' &&
    request.scope?.audience !== 'owner' &&
    Object.getOwnPropertyDescriptor(request.params, 'allowUnknownQuota') !== undefined
  )
    throw new BosunError('unsupported', 'Owner quota permission required');
  const result = (
    request.scope?.audience === 'model' && definition.modelSchema
      ? definition.modelSchema
      : definition.schema
  ).safeParse(request.params);
  if (!result.success) throw new BosunError('invalid', 'Invalid method parameters');
  return result.data;
}
