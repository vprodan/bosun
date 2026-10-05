// LLM router: generate() over local providers (Ollama, OpenAI-compatible), with timeout, retry, fallback, JSON validation
// and a usage log. Explicitly private input never reaches any provider, including local models.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { P, type Cfg } from './config.ts';
import { SUBSCRIPTION_ONLY } from './exec.ts';
import { record } from './metrics.ts';
import { validate, type Schema } from './util.ts';

export type Msg = { role: 'system' | 'user' | 'assistant'; content: string };
export type GenOpts = { task: string; messages: Msg[]; schema?: Schema; allowRemote?: boolean; private?: boolean };
export type GenResult = { ok: boolean; text: string; json?: any; provider: string; model: string; ms: number; tokensIn?: number; tokensOut?: number; error?: string };
type Raw = { text: string; tokensIn?: number; tokensOut?: number };
class Transient extends Error {}   // timeouts and connection errors: worth a retry
const tokenCount = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const tasks = new Set(['memory.add', 'consolidate']);

async function post(url: string, body: object, cfg: Cfg): Promise<any> {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(Number(cfg.LLM_TIMEOUT_S) * 1000) });
    if (!r.ok) throw new Error(`http ${r.status}`);
    return await r.json();
  } catch (e) {
    const name = (e as Error).name;
    if (name === 'TimeoutError' || name === 'AbortError') throw new Transient('timeout');
    if (e instanceof TypeError) throw new Transient('connection');   // fetch failed: refused, reset, DNS
    throw e;
  }
}

const flatten = (o: GenOpts) => [...o.messages.map((m) => `${m.role}:\n${m.content}`),
  ...(o.schema ? [`Reply with JSON only, matching this JSON Schema: ${JSON.stringify(o.schema)}`] : [])].join('\n\n');

function claudeCli(cfg: Cfg, o: GenOpts): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, BOSUN_DEPTH: '1' };
    for (const k of SUBSCRIPTION_ONLY) delete env[k];
    const p = spawn('claude', ['-p', '--restricted', '--strict-mcp-config', '--no-session-persistence', '--model', 'haiku', '--output-format', 'json'],
      { env, stdio: ['pipe', 'pipe', 'ignore'], timeout: Number(cfg.LLM_TIMEOUT_S) * 1000 });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => reject(new Transient('connection')));
    p.on('close', (code, signal) => {
      if (signal) return reject(new Transient('timeout'));
      if (code) return reject(new Error(`claude exited ${code}`));
      try {
        const j = JSON.parse(out);
        resolve({ text: String(j.result ?? ''), tokensIn: j.usage?.input_tokens, tokensOut: j.usage?.output_tokens });
      } catch { reject(new Error('claude output is not JSON')); }
    });
    p.stdin.end(flatten(o));
  });
}

const PROVIDERS: Record<string, (cfg: Cfg, o: GenOpts, model: string) => Promise<Raw>> = {
  async ollama(cfg, o, model) {
    const j = await post(`${cfg.OLLAMA_URL.replace(/\/$/, '')}/api/chat`, { model, messages: o.messages, stream: false, ...(o.schema ? { format: o.schema } : {}), options: { num_ctx: Number(cfg.CTX) } }, cfg);
    return { text: String(j.message?.content ?? ''), tokensIn: j.prompt_eval_count, tokensOut: j.eval_count };
  },
  async openai(cfg, o, model) {
    const j = await post(`${cfg.LLM_OPENAI_URL.replace(/\/$/, '')}/v1/chat/completions`, { model, messages: o.messages,
      ...(o.schema ? { response_format: { type: 'json_schema', json_schema: { name: 'out', schema: o.schema } } } : {}) }, cfg);
    return { text: String(j.choices?.[0]?.message?.content ?? ''), tokensIn: j.usage?.prompt_tokens, tokensOut: j.usage?.completion_tokens };
  },
  'claude-cli': (cfg, o) => claudeCli(cfg, o),
};

// One line per attempt, without content: {ts, task, provider, model, ms, ok, tokensIn, tokensOut, error_kind}
function usage(task: string, r: GenResult): void {
  try {
    fs.mkdirSync(P.BOSUN, { recursive: true });
    fs.appendFileSync(path.join(P.BOSUN, 'llm-usage.jsonl'), `${JSON.stringify({ ts: Date.now(), task: tasks.has(task) ? task : 'other',
      provider: r.provider, model: r.model, ms: Math.round(r.ms), ok: r.ok,
      tokensIn: tokenCount(r.tokensIn) ?? null, tokensOut: tokenCount(r.tokensOut) ?? null, error_kind: r.error ?? null })}\n`);
  } catch { /* never breaks a caller */ }
  record({ op: 'llm', ms: r.ms, provider: r.provider, ok: r.ok });
}

export async function generate(cfg: Cfg, o: GenOpts): Promise<GenResult> {
  // Before config/provider selection, retries, fallback, schema serialization or reading any message.
  if (o.private !== undefined && o.private !== false) return { ok: false, text: '', provider: 'none', model: '', ms: 0, error: 'private' };
  const chain = cfg.LLM_PROVIDERS.split(',').map((s) => s.trim()).filter((p) => p && p !== 'claude-cli');
  if (cfg.LLM_REMOTE === 'claude' && o.allowRemote && !o.private) chain.push('claude-cli');
  let last: GenResult = { ok: false, text: '', provider: 'none', model: '', ms: 0, error: 'no provider' };
  for (const name of chain) {
    const fn = Object.hasOwn(PROVIDERS, name) ? PROVIDERS[name] : undefined;
    const model = name === 'claude-cli' ? 'haiku' : cfg.LLM_MODEL || cfg.LOCAL_MODEL;
    if (!fn) { last = { ...last, provider: 'unknown', error: 'unknown provider' }; continue; }
    for (let attempt = 0; ; attempt++) {
      const t = performance.now();
      let r: GenResult;
      try {
        const raw = await fn(cfg, o, model);
        let json: any;
        let error: string | undefined;
        if (o.schema) {
          try { json = JSON.parse(raw.text); } catch { error = 'bad_json'; }
          if (!error && validate(o.schema, json)) error = 'invalid';
        }
        r = { ok: !error, text: raw.text, ...(o.schema && !error ? { json } : {}), provider: name, model, ms: performance.now() - t,
          tokensIn: tokenCount(raw.tokensIn), tokensOut: tokenCount(raw.tokensOut), ...(error ? { error } : {}) };
      } catch (e) {
        r = { ok: false, text: '', provider: name, model, ms: performance.now() - t,
          error: e instanceof Transient && e.message === 'timeout' ? 'timeout' : e instanceof Transient && e.message === 'connection' ? 'connection' : 'error' };
      }
      usage(o.task, r);
      if (r.ok) return r;
      last = r;
      if (!(r.error === 'timeout' || r.error === 'connection') || attempt >= Number(cfg.LLM_RETRIES)) break;
      await new Promise((res) => setTimeout(res, 500 * 2 ** attempt));
    }
  }
  return last;
}

const SUGGEST: Schema = { type: 'object', required: ['title', 'tags'], properties: { title: { type: 'string', maxLength: 200 }, tags: { type: 'array', maxItems: 12, items: { type: 'string', maxLength: 40 } } } };
// memory add --auto: a suggested title and tags, which explicit flags override.
export async function suggest(cfg: Cfg, text: string, priv: boolean): Promise<{ title: string; tags: unknown[] } | null> {
  if (priv !== false) return { title: text.trim().split('\n')[0].slice(0, 80), tags: [] };
  const r = await generate(cfg, { task: 'memory.add', schema: SUGGEST, allowRemote: true, private: priv, messages: [
    { role: 'user', content: `Suggest a short title (under 80 characters) and 1-4 lowercase tags (a-z, 0-9, hyphens) for this note. Reply with JSON only: {"title": "...", "tags": ["..."]}\n\n${text.slice(0, 4000)}` }] });
  return r.ok ? { title: String(r.json.title).trim().slice(0, 200), tags: r.json.tags } : null;
}
