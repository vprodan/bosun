// Consolidation: a local LLM turns this repo's recent claude-mem session summaries into proposed memories that wait for review.
import type { Cfg } from './config.ts';
import { generate } from './llm.ts';
import { log } from './log.ts';
import type { ClaudeMem, Summary } from './memory/claudemem.ts';
import { cleanTags } from './memory/service.ts';
import { jaccard, words } from './memory/sqlite.ts';
import { MemoryError, type Ctx, type Memory, type MemoryApi, type StoreInput } from './memory/types.ts';
import type { Schema } from './util.ts';

const schema = (ids: string[]): Schema => ({ type: 'object', required: ['candidates'], properties: { candidates: { type: 'array', maxItems: 20, items: {
  type: 'object', required: ['summary_id', 'category', 'title', 'body', 'tags'], properties: {
    summary_id: { type: 'string', enum: ids }, category: { type: 'string', enum: ['project', 'personal'] },
    title: { type: 'string', maxLength: 200 }, body: { type: 'string', maxLength: 4000 }, tags: { type: 'array', maxItems: 12, items: { type: 'string', maxLength: 40 } } } } } } });

const SYSTEM = `You turn coding-session summaries into durable memories for a developer's assistant.
Keep only facts that stay true after the session: decisions and why, conventions, gotchas, commands, where things live.
Skip progress reports, one-off tasks and anything obvious from the code. Each memory: a short title, a self-contained body
under 600 characters, 1-4 lowercase tags. Use category "personal" only for the developer's own preferences; everything else is "project".
Set summary_id to the id of the summary it came from. Return {"candidates": []} when nothing qualifies. Reply with JSON only.`;

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const userMsg = (project: string, rows: Summary[]) => `Project: ${project}\n\n${rows.map((s) => `[${s.id}] ${new Date(s.at).toISOString().slice(0, 10)}
request: ${cut(s.request, 400)}\nlearned: ${cut(s.learned, 800)}\ncompleted: ${cut(s.completed, 400)}\nnext steps: ${cut(s.nextSteps, 300)}`).join('\n\n')}`;

// Near-duplicate: same category and a word-set overlap of at least 0.8 with an active or proposed memory.
async function nearDuplicate(api: MemoryApi, ctx: Ctx, input: StoreInput): Promise<string | undefined> {
  const ws = words(`${input.title} ${input.body}`);
  const hits = await api.search({ text: `${input.title} ${input.body}`, status: ['active', 'proposed'], limit: 10, includePrivate: true, touch: false }, ctx);
  return hits.find((h) => h.category === input.category && jaccard(words(`${h.title} ${h.body}`), ws) >= 0.8)?.id;
}

export async function consolidate(cfg: Cfg, api: MemoryApi, ctx: Ctx, cm: ClaudeMem, o: { since: number; limit: number }) {
  const rows = cm.summaries(o.since, o.limit);
  const out = { summaries: rows.length, proposed: [] as Memory[], skipped: [] as { title: string; why: string }[], error: undefined as string | undefined };
  if (!rows.length) return out;
  const r = await generate(cfg, { task: 'consolidate', allowRemote: true, schema: schema(rows.map((s) => String(s.id))), messages: [
    { role: 'system', content: SYSTEM }, { role: 'user', content: userMsg(JSON.parse(cm.projects)[0] || '', rows) }] });
  if (!r.ok) return { ...out, error: `the LLM gave no usable output (${r.provider}: ${r.error}); nothing written` };
  for (const c of r.json.candidates as any[]) {
    const input: StoreInput = { category: c.category, title: String(c.title).trim().slice(0, 200), body: String(c.body).trim().slice(0, 4000),
      tags: cleanTags(c.tags), status: 'proposed', source: `consolidate:${r.provider}/${r.model}`, sourceRef: `claude-mem:summary:${c.summary_id}` };
    try {
      const near = await nearDuplicate(api, ctx, input);
      if (near) { out.skipped.push({ title: input.title, why: `near-duplicate of ${near}` }); continue; }
      const s = await api.store(input, ctx);
      if (s.duplicate) out.skipped.push({ title: input.title, why: `duplicate of ${s.memory.id}` });
      else out.proposed.push(s.memory);
    } catch (e) {
      if (e instanceof MemoryError && e.code === 'invalid') out.skipped.push({ title: input.title, why: e.message });
      else throw e;
    }
  }
  log('info', 'consolidate', { summaries: rows.length, proposed: out.proposed.length, skipped: out.skipped.length, provider: r.provider });
  return out;
}
