// bosun memory …: store, search, review and audit curated memory from the terminal. The CLI shows everything, private included.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { P, state, saveState, type Cfg } from '../config.ts';
import { consolidate } from '../consolidate.ts';
import { suggest } from '../llm.ts';
import { report } from '../metrics.ts';
import { die } from '../util.ts';
import { makeCtx, project, projectDir } from './project.ts';
import { bench, evaluate } from './bench.ts';
import { ClaudeMem } from './claudemem.ts';
import { MemoryService, cleanTags, openMemory } from './service.ts';
import { publishLocalMemory, planLocalMemoryCutover, applyLocalMemoryCutover } from './sqlite.ts';
import type { Category, Ctx, Memory, MemoryApi, Status } from './types.ts';

export const USAGE = `usage: bosun memory <verb>
  add [-c project|personal|session] [-t title] [--tags a,b] [--private] [--shared] [--ttl-days N] [--auto] "text" | -f file | -f -
  search ["words"] [-c category] [--status active|proposed|archived] [--tags a,b] [--limit N] [--json]
  get <id> [--json]   update <id> [-t title] [-b text] [--tags a,b] [--private|--public] [--shared] [--version N]
  delete <id>   purge <id>   review   accept <id>   reject <id>   prune
  consolidate [--since 7d] [--limit 20]   stats   bench [--n 10000]   eval <queries.jsonl>
  cutover plan [--json]
  cutover apply --plan TOKEN --clients-stopped [--json]
  cutover reconcile --plan TOKEN --source-id UUID --clients-stopped [--json]   (revokes READY to HOLD)
  publish [--json]   (already-applied local floor only)`;

const CUTOVER_USAGE = 'usage: bosun memory cutover plan [--json] | apply --plan TOKEN --clients-stopped [--json] | reconcile --plan TOKEN --source-id UUID --clients-stopped [--json]';
async function ownerCutover(argv: string[], cfg: Cfg): Promise<number> {
  const [operation, ...rest] = argv;
  if (!['plan', 'apply', 'reconcile'].includes(operation)) return die(CUTOVER_USAGE, 2);
  let parsed;
  try {
    parsed = parseArgs({ args: rest, options: { json: { type: 'boolean' }, plan: { type: 'string' },
      'source-id': { type: 'string' }, 'clients-stopped': { type: 'boolean' } }, allowPositionals: false, tokens: true });
    const names = parsed.tokens.filter((t) => t.kind === 'option').map((t) => t.name);
    if (names.length !== parsed.tokens.length || new Set(names).size !== names.length
      || names.some((name) => !(operation === 'plan' ? ['json'] : operation === 'apply' ? ['json', 'plan', 'clients-stopped'] : ['json', 'plan', 'source-id', 'clients-stopped']).includes(name))) return die(CUTOVER_USAGE, 2);
  } catch { return die(CUTOVER_USAGE, 2); }
  const v = parsed.values;
  if (operation === 'plan') {
    const result = planLocalMemoryCutover(cfg);
    if (v.json) console.log(JSON.stringify(result));
    else {
      console.log(`${result.state}${result.operation ? ` ${result.operation}` : ''}; schema, floor and clients unverified`);
      for (const b of result.blockers) console.log(`${b.target}: ${b.reason}${b.requiredMode ? ` (current ${b.currentMode}, required ${b.requiredMode})` : ''}`);
      if (result.sourceId) console.log(`save sourceId independently: ${result.sourceId}`);
      if (result.plan) console.log(`plan: ${result.plan}\nexpires: ${new Date(result.expiresAt!).toISOString()}`);
      for (const requirement of result.requirements) console.log(requirement);
      if (result.operation === 'reconcile') console.log('Explicit reconcile requires your independently saved source ID and revokes READY to HOLD.');
    }
    return result.state === 'PLANNED' ? 0 : 1;
  }
  if (!v.plan || v['clients-stopped'] !== true || operation === 'reconcile' && !v['source-id']) return die(CUTOVER_USAGE, 2);
  try {
    const result = await applyLocalMemoryCutover(cfg, { operation: operation as 'apply' | 'reconcile', plan: v.plan,
      sourceId: v['source-id'], clientsStopped: v['clients-stopped'] });
    console.log(v.json ? JSON.stringify(result) : `${operation} ${result.state}; sourceId ${result.sourceId}\nClients stopped: operator attestation. Reopen every authority. Save/set MEMORY_SOURCE_ID yourself; explicitly publish separately.`);
    return 0;
  } catch (e) {
    // A floor may have committed before a native cleanup/receipt error. Never advertise rollback or blind retry.
    console.error('bosun: cutover failed; outcome may be unknown. Save the planned source ID; inspect storage and use a fresh explicit plan before reconciliation.');
    throw e;
  }
}

const OPTIONS = {
  category: { type: 'string', short: 'c' }, title: { type: 'string', short: 't' }, body: { type: 'string', short: 'b' },
  file: { type: 'string', short: 'f' }, tags: { type: 'string' }, private: { type: 'boolean' }, public: { type: 'boolean' },
  shared: { type: 'boolean' }, 'ttl-days': { type: 'string' }, auto: { type: 'boolean' }, status: { type: 'string' },
  limit: { type: 'string' }, json: { type: 'boolean' }, version: { type: 'string' }, since: { type: 'string' }, n: { type: 'string' },
} as const;

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const list = (s?: string) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : undefined);
const line = (m: Memory) => `${m.id}  ${day(m.updatedAt)}  ${m.status.padEnd(8)} ${m.category.padEnd(8)} ${m.private ? '(private) ' : ''}${m.title}`;

export async function main(argv: string[], cfg: Cfg): Promise<number> {
  const [verb = 'help', ...rest] = argv;
  if (verb === 'help' || verb === '-h' || verb === '--help') { console.log(USAGE); return 0; }
  if (verb === 'cutover') return ownerCutover(rest, cfg);
  let parsed;
  try { parsed = parseArgs({ args: rest, options: OPTIONS, allowPositionals: true }); } catch (e) { return die(`${(e as Error).message}\n${USAGE}`, 2); }
  const { values: v, positionals: pos } = parsed;
  if (verb === 'publish') {
    if (pos.length || Object.keys(v).some((key) => key !== 'json')) return die('usage: bosun memory publish [--json]', 2);
    if (cfg.MEMORY_URL) return die('local publication unavailable', 1);
    const result = await publishLocalMemory(cfg, P.DB);
    console.log(v.json ? JSON.stringify(result) : `published ${result.publicationId} (${result.state})`);
    return 0;
  }
  const num = (s: string | undefined, name: string): number | undefined => {
    if (s === undefined) return undefined;
    if (!/^\d+$/.test(s)) die(`--${name} needs a whole number`, 2);
    return Number(s);
  };
  const need = (what: string): string => pos[0] || die(`usage: bosun memory ${verb} <${what}>`, 2);
  const read = (f: string) => fs.readFileSync(f === '-' ? 0 : f, 'utf8');
  const dir = projectDir();
  const proj = project(dir);
  const ctx = makeCtx(cfg, proj, null, 'cli');
  let api: MemoryApi | null = null;
  const mem = (): MemoryApi => (api ??= openMemory(cfg));
  const local = (): MemoryService => {
    if (cfg.MEMORY_URL) die(`bosun memory ${verb} runs on the memory server (${cfg.MEMORY_URL}): run it there`);
    return mem() as MemoryService;
  };
  try {
    switch (verb) {
      case 'add': {
        const body = (v.file ? read(v.file) : pos.join(' ')).trim();
        if (!body) return die(USAGE, 2);
        let title = v.title;
        let tags = list(v.tags);
        if (v.auto && !v.private && (!title || !tags)) {   // private notes use deterministic defaults; explicit flags always win
          const s = await suggest(cfg, body, !!v.private);
          if (s) { title ??= s.title; tags ??= cleanTags(s.tags); }
          else console.error('bosun: --auto: no usable suggestion from the LLM; using the first line');
        }
        title ??= body.split('\n')[0].slice(0, 80);
        const r = await mem().store({ category: (v.category ?? 'project') as Category, title, body, tags,
          private: v.private, shared: v.shared, ttlDays: num(v['ttl-days'], 'ttl-days') }, ctx);
        console.log(r.duplicate ? `duplicate of ${r.memory.id} (nothing stored)` : `stored ${r.memory.id} (${r.memory.category}${r.memory.private ? ', private' : ''})`);
        return 0;
      }
      case 'search': {
        const hits = await mem().search({ text: pos.join(' ') || undefined, category: v.category as Category | undefined,
          status: v.status ? [v.status as Status] : undefined, tags: list(v.tags), limit: num(v.limit, 'limit'), includePrivate: true, touch: false }, ctx);
        if (v.json) console.log(JSON.stringify(hits, null, 2));
        else console.log(hits.length ? hits.map(line).join('\n') : 'no memories');
        return 0;
      }
      case 'get': {
        const m = await mem().get(need('id'), ctx, { events: true });
        if (v.json) { console.log(JSON.stringify(m, null, 2)); return 0; }
        console.log(`${m.title}\n${m.id}  ${m.category}  ${m.status}  v${m.version}${m.private ? '  private' : ''}${m.shared ? '  shared' : ''}  tags: ${m.tags.join(', ') || '-'}`);
        console.log(`source ${m.source}${m.sourceRef ? ` (${m.sourceRef})` : ''}  created ${day(m.createdAt)}  updated ${day(m.updatedAt)}${m.expiresAt ? `  expires ${day(m.expiresAt)}` : ''}  used ${m.accessCount}x\n\n${m.body}\n`);
        for (const e of m.events || []) console.log(`  ${new Date(e.at).toISOString()}  ${e.op.padEnd(8)} ${e.source}`);
        return 0;
      }
      case 'update': {
        const id = need('id');
        const patch = { title: v.title, body: v.body ?? (v.file ? read(v.file).trim() : undefined), tags: list(v.tags),
          private: v.private ? true : v.public ? false : undefined, shared: v.shared };
        if (Object.values(patch).every((x) => x === undefined)) return die('nothing to change: pass -t, -b, -f, --tags, --private, --public or --shared', 2);
        const m = await mem().update(id, patch, num(v.version, 'version') ?? (await mem().get(id, ctx)).version, ctx);
        console.log(`updated ${m.id} to version ${m.version}`);
        return 0;
      }
      case 'delete': { const m = await mem().delete(need('id'), ctx); console.log(`${m.id} archived (bosun memory purge ${m.id} deletes it for good)`); return 0; }
      case 'accept': { console.log(`${(await mem().accept(need('id'), ctx)).id} accepted`); return 0; }
      case 'reject': { console.log(`${(await mem().reject(need('id'), ctx)).id} rejected (archived)`); return 0; }
      case 'purge': { await local().purge(need('id'), ctx); console.log(`purged ${pos[0]}`); return 0; }
      case 'prune': {
        const r = local().prune();
        console.log(`archived ${r.archived} expired, purged ${r.purged} archived for over ${cfg.MEMORY_PURGE_AFTER_DAYS} days`);
        return 0;
      }
      case 'review': return await review(mem(), ctx);
      case 'bench': return await bench(cfg, num(v.n, 'n') ?? 10000);   // a temp database: nothing of yours is opened
      case 'eval': return await evaluate(need('queries.jsonl'), mem(), ctx);
      case 'consolidate': {
        const days = Number(String(v.since ?? '7d').replace(/d$/, ''));
        if (!(days > 0)) return die('--since takes days, like 7d', 2);
        const last = state().consolidatedAt?.[ctx.projectId!] ?? 0;   // since the last run, within the --since window
        const cm = new ClaudeMem(cfg, [proj.name, path.basename(dir)]);
        const r = await consolidate(cfg, mem(), ctx, cm, { since: Math.max(Date.now() - days * 86400000, last), limit: num(v.limit, 'limit') ?? 20 });
        if (r.error) { console.error(`bosun: ${r.error}`); return 1; }
        const st = state();
        saveState({ ...st, consolidatedAt: { ...(st.consolidatedAt || {}), [ctx.projectId!]: Date.now() } });
        console.log(`${r.summaries} session summaries → ${r.proposed.length} proposals${r.skipped.length ? `, ${r.skipped.length} skipped` : ''}`);
        for (const m of r.proposed) console.log(`  + ${m.id} ${m.title}`);
        for (const x of r.skipped) console.log(`  - ${x.title}: ${x.why}`);
        if (r.proposed.length) console.log('review them: bosun memory review');
        return 0;
      }
      case 'stats': {
        console.log(`project ${ctx.projectId} (${proj.name})   store ${cfg.MEMORY_URL || P.DB}`);
        if (!cfg.MEMORY_URL) console.log(`memories by status: ${JSON.stringify(local().counts())}`);
        for (const l of report()) console.log(l);
        return 0;
      }
      default: console.error(USAGE); return 2;
    }
  } finally { (api as MemoryApi | null)?.close(); }
}

// Proposals one by one: a accepts, r rejects, enter skips, q (or end of input) stops.
async function review(mem: MemoryApi, ctx: Ctx): Promise<number> {
  const todo = await mem.search({ status: ['proposed'], limit: 50, includePrivate: true }, ctx);
  if (!todo.length) { console.log('no proposals to review'); return 0; }
  console.log(`${todo.length} proposals.  a=accept  r=reject  enter=skip  q=quit\n`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let pending: ((s: string) => void) | null = null;
  let closed = false;
  rl.on('close', () => { closed = true; pending?.('q'); });
  const ask = (q: string) => new Promise<string>((res) => {
    if (closed) return res('q');
    pending = res;
    rl.question(q, (a) => { pending = null; res(a); });
  });
  try {
    for (const [i, m] of todo.entries()) {
      console.log(`[${i + 1}/${todo.length}] ${m.title}  (${m.category}, ${m.source}${m.sourceRef ? `, ${m.sourceRef}` : ''})\n${m.body}\n`);
      const k = (await ask('  > ')).trim().toLowerCase();
      if (k === 'q') break;
      if (k === 'a') console.log(`  accepted ${(await mem.accept(m.id, ctx)).id}`);
      else if (k === 'r') console.log(`  rejected ${(await mem.reject(m.id, ctx)).id}`);
    }
  } finally { rl.close(); }
  return 0;
}
