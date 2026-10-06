// Shared legacy JSON Schema limits; selected external validation libraries remain a later gate.
import { validate, type Schema } from './schema.ts';
import { CATEGORIES, STATUSES } from '../core/domain/memory.ts';
import { MemoryError } from '../core/errors.ts';

const text = (max: number): Schema => ({ type: 'string', minLength: 1, maxLength: max, pattern: '\\S' });
// Shared with MCP: the tool schemas are built from these, so every entry point enforces the same limits.
export const FIELDS: Record<string, Schema> = {
  category: { type: 'string', enum: CATEGORIES, description: 'personal (you, in every project), project (this repo), session (expires after a week)' },
  title: text(200),
  body: text(4000),
  tags: { type: 'array', maxItems: 12, items: { type: 'string', pattern: '^[a-z0-9-]{1,40}$' } },
  private: { type: 'boolean', description: 'never shown to the model or sent to a remote LLM' },
  shared: { type: 'boolean', description: 'readable from every project' },
  ttlDays: { type: 'integer', minimum: 1, maximum: 3650 },
};
export const STORE: Schema = { type: 'object', additionalProperties: false, required: ['category', 'title', 'body'], properties: {
  ...FIELDS, status: { type: 'string', enum: ['active', 'proposed'] }, source: { type: 'string', maxLength: 200 }, sourceRef: { type: 'string', maxLength: 200 } } };
export const PATCH: Schema = { type: 'object', additionalProperties: false, properties: {
  title: FIELDS.title, body: FIELDS.body, tags: FIELDS.tags, private: FIELDS.private, shared: FIELDS.shared,
  status: { type: 'string', enum: ['active', 'archived'], description: 'active accepts a proposal or restores; archived deletes softly' } } };
export const QUERY: Schema = { type: 'object', additionalProperties: false, properties: {
  text: { type: 'string', maxLength: 20000 }, category: FIELDS.category, tags: FIELDS.tags,
  status: { type: 'array', maxItems: 3, items: { type: 'string', enum: STATUSES } },
  limit: { type: 'integer', minimum: 1, maximum: 50 }, includePrivate: { type: 'boolean' }, touch: { type: 'boolean' } } };
export const ID: Schema = { type: 'string', minLength: 1, maxLength: 64 };
export const VERSION_NO: Schema = { type: 'integer', minimum: 1 };

export function check(schema: Schema, v: unknown): void {
  const e = validate(schema, v);
  if (e) throw new MemoryError('invalid', e);
}
// LLM-suggested tags → valid ones: lowercase, [a-z0-9-], deduped, at most 12.
export const cleanTags = (tags: unknown): string[] => (Array.isArray(tags)
  ? [...new Set(tags.map((t) => String(t).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)).filter(Boolean))].slice(0, 12)
  : []);
