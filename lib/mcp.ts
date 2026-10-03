// MCP server (`bosun mcp`): stdio, newline-delimited JSON-RPC 2.0, protocol 2025-11-25 (it echoes older supported versions).
// stdout carries protocol messages only; console output goes to stderr.
import path from 'node:path';
import readline from 'node:readline';
import { P, VERSION, type Cfg } from './config.ts';
import { curated, retrieve } from './context.ts';
import { log } from './log.ts';
import { ClaudeMem } from './memory/claudemem.ts';
import { Docs } from './memory/docs.ts';
import { makeCtx, project, projectDir } from './memory/project.ts';
import { FIELDS, PATCH, openMemory } from './memory/service.ts';
import { openDb } from './memory/sqlite.ts';
import { MemoryError, STATUSES, type Memory, type MemoryApi, type MemoryProvider, type StoreInput } from './memory/types.ts';
import { validate, type Schema } from './util.ts';

export const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const INSTRUCTIONS = 'bosun memory: curated notes about this user and project. Before assuming how this repo works, try memory_search or '
  + 'context_retrieve; project_knowledge_search covers the repo\'s docs and past sessions. Use memory_store only for durable facts the user '
  + 'agrees to keep (decisions, conventions, gotchas), never secrets, and mark sensitive ones private. Ids work with memory_get, memory_update and memory_delete.';
type Args = Record<string, any>;
export type Tool = { name: string; description: string; inputSchema: Schema; annotations: Record<string, boolean>; run: (a: Args) => Promise<object> };
const obj = (properties: Record<string, Schema>, required: string[] = []): Schema => ({ type: 'object', additionalProperties: false, properties, required });
const hint = (readOnly: boolean, destructive: boolean, idempotent: boolean) => ({ readOnlyHint: readOnly, destructiveHint: destructive, idempotentHint: idempotent, openWorldHint: false });
const ID: Schema = { type: 'string', minLength: 1, maxLength: 64, description: 'a memory id (m_…)' };
const QUERY: Schema = { type: 'string', minLength: 1, maxLength: 2000 };
const SOURCES = ['curated', 'docs', 'claude-mem'];
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const redact = (m: Memory) => (m.private ? { ...m, body: '[private]' } : m);

export function tools(cfg: Cfg, dir: string): { list: Tool[]; close: () => void } {
  const proj = project(dir);
  const ctx = makeCtx(cfg, proj, null, 'mcp');
  let api: MemoryApi | null = null;
  let docs: Docs | null = null;
  const mem = () => (api ??= openMemory(cfg));
  const providers = (names: string[]): MemoryProvider[] => [
    ...(names.includes('curated') ? [curated(mem())] : []),
    ...(names.includes('docs') ? [(docs ??= new Docs(openDb(P.DB), dir, proj.id))] : []),
    ...(names.includes('claude-mem') ? [new ClaudeMem(cfg, [proj.name, path.basename(dir)])] : []),
  ];
  const list: Tool[] = [
    { name: 'memory_search', annotations: hint(true, false, true),
      description: 'Search curated memory (the user\'s personal notes and this project\'s) by keywords. Returns ids, titles and snippets; private memories are left out.',
      inputSchema: obj({ query: QUERY, category: FIELDS.category, status: { type: 'string', enum: STATUSES }, tags: FIELDS.tags, limit: { type: 'integer', minimum: 1, maximum: 50 } }, ['query']),
      run: async (a) => ({ hits: (await mem().search({ text: a.query, category: a.category, status: a.status ? [a.status] : undefined, tags: a.tags, limit: a.limit }, ctx))
        .map((m) => ({ id: m.id, category: m.category, status: m.status, title: m.title, snippet: m.body.slice(0, 300), tags: m.tags, updated: day(m.updatedAt) })) }) },
    { name: 'memory_get', annotations: hint(true, false, true),
      description: 'Read one memory by id: body, tags, status and version. A private memory comes back with its body hidden.',
      inputSchema: obj({ id: ID }, ['id']), run: async (a) => ({ memory: redact(await mem().get(a.id, ctx)) }) },
    { name: 'memory_store', annotations: hint(false, false, false),
      description: 'Save a durable fact worth remembering across sessions: a decision and why, a convention, a gotcha, a preference. Only with the user\'s agreement; never secrets. An existing duplicate is returned instead.',
      inputSchema: obj(FIELDS, ['category', 'title', 'body']),
      run: async (a) => { const r = await mem().store(a as StoreInput, ctx); return { memory: redact(r.memory), duplicate: r.duplicate }; } },
    { name: 'memory_update', annotations: hint(false, true, true),
      description: 'Change a memory\'s title, body, tags or flags, or set status active (accept a proposal) or archived. Pass the version you read as expectedVersion; a newer one returns a conflict.',
      // private: true only. Making a memory public again is CLI-only: the reply would carry the body to the host.
      inputSchema: obj({ id: ID, expectedVersion: { type: 'integer', minimum: 1 }, ...PATCH.properties,
        private: { type: 'boolean', enum: [true], description: 'true marks it private; making it public again is CLI-only' } }, ['id', 'expectedVersion']),
      run: async ({ id, expectedVersion, ...patch }) => ({ memory: redact(await mem().update(id, patch, expectedVersion, ctx)) }) },
    { name: 'memory_delete', annotations: hint(false, true, true),
      description: 'Archive a memory (a soft delete: the user can restore or purge it).',
      inputSchema: obj({ id: ID }, ['id']), run: async (a) => { const m = await mem().delete(a.id, ctx); return { id: m.id, status: m.status }; } },
    { name: 'context_retrieve', annotations: hint(true, false, true),
      description: 'Ranked, deduplicated context for a task from curated memory, this repo\'s docs and claude-mem history, fitted to a token budget (default ~1000).',
      inputSchema: obj({ task: { type: 'string', minLength: 1, maxLength: 8000 }, budgetTokens: { type: 'integer', minimum: 50, maximum: 4000 },
        sources: { type: 'array', maxItems: 3, items: { type: 'string', enum: SOURCES } } }, ['task']),
      run: async (a) => {
        const r = await retrieve(a.task, providers(a.sources || SOURCES), ctx, { budgetTokens: a.budgetTokens ?? 1000, minScore: 0, itemChars: Number(cfg.CONTEXT_ITEM_CHARS) });
        return { text: r.text, estTokens: r.estTokens, ids: r.items.map((i) => i.id), sources: r.sources, ms: Math.round(r.ms) };
      } },
    { name: 'project_knowledge_search', annotations: hint(true, false, true),
      description: 'Search this repo\'s Markdown docs and claude-mem\'s session history for this project.',
      inputSchema: obj({ query: QUERY, limit: { type: 'integer', minimum: 1, maximum: 20 } }, ['query']),
      run: async (a) => {
        const r = await retrieve(a.query, providers(['docs', 'claude-mem']), ctx, { budgetTokens: 4000, minScore: 0, itemChars: 600 });
        return { hits: r.items.slice(0, a.limit ?? 10).map((i) => ({ id: i.id, source: i.source, title: i.title, snippet: i.text.slice(0, 500), date: day(i.at) })) };
      } },
  ];
  return { list, close: () => { api?.close(); docs?.db.close(); } };
}

const error = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });
const fail = (text: string) => ({ content: [{ type: 'text', text }], isError: true });
function result(data: any, max: number): object {
  let text = JSON.stringify(data);
  const hits: unknown[] | null = Array.isArray(data.hits) ? data.hits : null;
  while (text.length > max && hits?.length) { hits.pop(); data.truncated = true; text = JSON.stringify(data); }
  if (text.length > max) return fail(`the result is larger than MCP_MAX_CHARS (${max})`);
  return { content: [{ type: 'text', text }], structuredContent: data };
}

export async function handle(line: string, list: Tool[], cfg: Cfg, send: (m: object) => void): Promise<void> {
  if (!line.trim()) return;
  let msg: any;
  try { msg = JSON.parse(line); } catch { return send(error(null, -32700, 'Parse error')); }
  if (Array.isArray(msg)) return send(error(null, -32600, 'Batches are not supported'));
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return send(error(msg?.id ?? null, -32600, 'Invalid Request'));
  if (msg.method === undefined) return;          // a response to a request we never sent
  if (typeof msg.method !== 'string') return send(error(msg.id ?? null, -32600, 'Invalid Request'));
  if (!('id' in msg)) return;                    // notifications need no answer
  const ok = (res: object) => send({ jsonrpc: '2.0', id: msg.id, result: res });
  switch (msg.method) {
    case 'initialize': {
      const want = msg.params?.protocolVersion;
      return ok({ protocolVersion: VERSIONS.includes(want) ? want : VERSIONS[0], capabilities: { tools: {} },
        serverInfo: { name: 'bosun', title: 'bosun memory', version: VERSION }, instructions: INSTRUCTIONS });
    }
    case 'ping': return ok({});
    case 'tools/list': return ok({ tools: list.map(({ run: _run, ...t }) => t) });
    case 'tools/call': {
      const name = msg.params?.name;
      const tool = list.find((t) => t.name === name);
      if (!tool) return send(error(msg.id, -32602, `Unknown tool: ${String(name).slice(0, 64)}`));
      const args = msg.params?.arguments ?? {};
      const bad = validate(tool.inputSchema, args);
      if (bad) return ok(fail(`invalid arguments: ${bad}`));
      try { return ok(result(await tool.run(args), Number(cfg.MCP_MAX_CHARS))); } catch (e) {
        if (e instanceof MemoryError) return ok(fail(e.message));
        log('error', 'mcp.tool', { tool: name, err: e });
        return ok(fail('internal error (details in ~/.bosun/bosun.log)'));
      }
    }
    default: return send(error(msg.id, -32601, 'Method not found'));
  }
}

export async function main(cfg: Cfg): Promise<number> {
  console.log = console.info = console.debug = console.error;   // stdout is the protocol channel
  const { list, close } = tools(cfg, projectDir());
  const send = (m: object) => { process.stdout.write(`${JSON.stringify(m)}\n`); };
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let chain = Promise.resolve();
  rl.on('line', (line) => { chain = chain.then(() => handle(line, list, cfg, send)).catch((e) => log('error', 'mcp.handle', { err: e })); });
  await new Promise((res) => rl.once('close', res));
  await chain;
  close();
  return 0;
}
