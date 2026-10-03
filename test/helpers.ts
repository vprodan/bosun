// Test sandbox: temp HOME, stub CLIs that record their calls, a mock Kev/Ollama/Anthropic server.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const REPO = path.resolve(import.meta.dirname, '..');
export const BIN = path.join(REPO, 'bin', 'bosun');
const NODE_DIR = path.dirname(process.execPath);

// Stub CLI. Appends {bin, argv, env, stdin, cwd} to $STUB_OUT. Reply and exit code come from $STUB_MAP,
// keyed "<bin> <argv0> <argv1>", then "<bin> <argv0>", then "<bin>": { "out": string|object, "code": number }.
// `orca terminal split` also plays the pane: it runs the --command in a shell (STUB_SPLIT=dead fakes a closed
// pane, STUB_SPLIT=noop a pane that never starts, STUB_SPLIT=force a pane that opens although orca reports failure,
// STUB_SPLIT=emptyrc a pane that creates an empty exit-code file before writing 7). STUB_SLEEP_<BIN>=s sleeps before exiting.
// (CommonJS on purpose: it lives in the sandbox, outside this ESM package.)
const STUB = `#!/usr/bin/env node
const fs = require('fs'), path = require('path'), cp = require('child_process');
const name = path.basename(process.argv[1]); const argv = process.argv.slice(2);
let stdin = ''; try { stdin = fs.readFileSync(0, 'utf8'); } catch {}
const env = {}; for (const [k, v] of Object.entries(process.env)) if (/^(ANTHROPIC|CLAUDE|CODEX_|BOSUN_|ORCA_)/.test(k)) env[k] = v;
fs.appendFileSync(process.env.STUB_OUT, JSON.stringify({ bin: name, argv, env, stdin, cwd: process.cwd(), pid: process.pid }) + '\\n');
const map = JSON.parse(process.env.STUB_MAP || '{}');
const hit = map[[name, argv[0], argv[1]].join(' ')] || map[[name, argv[0]].join(' ')] || map[name] || {};
const split = process.env.STUB_SPLIT;
if (name === 'orca' && argv[0] === 'terminal' && argv[1] === 'split' && (!hit.code || split === 'force') && split !== 'noop') {
  const cmd = argv[argv.indexOf('--command') + 1];
  const runs = path.join(process.env.HOME, '.bosun', 'runs');
  if (split === 'emptyrc') {
    const id = cmd.trim().split(' ').pop();
    const b = path.join(runs, id);
    cp.spawn('/bin/sh', ['-c', "echo $$ > '" + b + ".pid'; : > '" + b + ".rc'; sleep 2; printf 7 > '" + b + ".rc'"], { detached: true, stdio: 'ignore' }).unref();
  } else if (split === 'dead') {
    const id = cmd.trim().split(' ').pop();
    const dead = cp.spawnSync('true').pid;
    fs.writeFileSync(path.join(process.env.HOME, '.bosun', 'runs', id + '.pid'), String(dead), { flag: 'wx' });
  } else cp.spawn('/bin/sh', ['-c', cmd], { detached: true, stdio: 'ignore' }).unref();
}
const nap = Number(process.env['STUB_SLEEP_' + name.toUpperCase()] || 0);
if (nap) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, nap * 1000);
if (hit.out !== undefined) process.stdout.write(typeof hit.out === 'string' ? hit.out : JSON.stringify(hit.out));
process.exit(hit.code || Number(process.env['STUB_EXIT_' + name.toUpperCase()] || 0));
`;

export type Call = { bin: string; argv: string[]; env: Record<string, string>; stdin: string; cwd: string; pid: number };
export type Sandbox = {
  root: string; home: string; bin: string; out: string;
  env: (extra?: Record<string, string>) => Record<string, string>;
  calls: () => Call[]; reset: () => void; cleanup: () => void;
};

export function sandbox({ stubs = ['claude', 'codex', 'orca'] }: { stubs?: string[] } = {}): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bosun-test-'));
  const home = path.join(root, 'home');
  const bin = path.join(root, 'stubs');
  const out = path.join(root, 'stub.jsonl');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(bin);
  for (const name of stubs) fs.writeFileSync(path.join(bin, name), STUB, { mode: 0o755 });
  const env = (extra: Record<string, string> = {}) => ({
    PATH: `${bin}:${NODE_DIR}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, TMPDIR: root, STUB_OUT: out,
    BOSUN_TAILSCALE_APP: path.join(root, 'no-tailscale'), ...extra,
  });
  const calls = (): Call[] => (fs.existsSync(out) ? fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const reset = () => fs.rmSync(out, { force: true });
  return { root, home, bin, out, env, calls, reset, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

// Point this process at a sandbox: HOME, PATH and stub output. Paths are getters, so nothing needs reloading.
export function fresh(sb: Sandbox, env: Record<string, string> = {}): void {
  Object.assign(process.env, { HOME: sb.home, PATH: sb.env().PATH, STUB_OUT: sb.out });
  for (const k of ['BOSUN_HOME', 'CODEX_HOME', 'ORCA_CODEX_HOME', 'ORCA_PANE_KEY', 'CLAUDECODE', 'CODEX_THREAD_ID', 'BOSUN_DEPTH',
    'BOSUN_OLLAMA_APP', 'STUB_MAP', 'CLAUDE_PROJECT_DIR', 'MEMORY_URL', 'OLLAMA_URL', 'ROUTER_URL', 'CLAUDE_MEM', 'CLAUDE_MEM_DB',
    'LLM_REMOTE', 'LLM_PROVIDERS', 'SERVE_BIND', 'SERVE_ALLOW']) delete process.env[k];
  Object.assign(process.env, { BOSUN_TAILSCALE_APP: path.join(sb.root, 'no-tailscale') }, env);
}

// A git repo under the sandbox with one commit, and an origin remote when given.
export function gitRepo(sb: Sandbox, name: string, origin?: string): string {
  const dir = path.join(sb.root, name);
  fs.mkdirSync(dir, { recursive: true });
  const git = (...a: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir });
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  if (origin) git('remote', 'add', 'origin', origin);
  return dir;
}

export type Run = { code: number | null; out: string; err: string };
export function bosun(args: string[], { env, cwd, input }: { env?: NodeJS.ProcessEnv; cwd?: string; input?: string } = {}): Promise<Run> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [BIN, ...args], { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out, err }));
    p.stdin.end(input === undefined ? '' : input);
  });
}

export type Req = { method?: string; path: string; headers: http.IncomingHttpHeaders; body: any };
export type Mock = { url: string; requests: Req[]; close: () => Promise<void> };

// A handler's reply: JSON, raw text (served as HTML), a delay, or a dropped connection.
export type Reply = { status?: number; json?: unknown; text?: string; delayMs?: number; destroy?: boolean };
export type Route = (body: any, req: http.IncomingMessage) => Reply | Promise<Reply>;

// Mock server: Ollama GET /api/tags, Kev POST /v1/systemone, Anthropic POST /v1/messages (SSE). Records requests.
// routes: per-path handlers that win over those defaults.
export function mock(routes: Record<string, Route> = {}): Promise<Mock> {
  const requests: Req[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      let json: any = null;
      try { json = body ? JSON.parse(body) : null; } catch { json = body; }
      requests.push({ method: req.method, path: req.url || '', headers: req.headers, body: json });
      const route = routes[(req.url || '').split('?')[0]];
      if (route) {
        const r = await route(json, req);
        if (r.destroy) { req.socket.destroy(); return; }
        if (r.delayMs) await new Promise((res) => setTimeout(res, r.delayMs));
        if (res.destroyed || res.writableEnded) return;
        res.writeHead(r.status ?? 200, { 'content-type': r.text !== undefined ? 'text/html' : 'application/json' });
        res.end(r.text ?? JSON.stringify(r.json ?? {}));
        return;
      }
      const send = (o: unknown) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
      if (req.method === 'GET') return send({ models: [] });
      if ((req.url || '').startsWith('/v1/systemone')) {
        const t = json.state.request;
        const [lane, conf] = /rename/.test(t) ? ['local', 0.9] : /implement/.test(t) ? ['worker', 0.8] : ['scout', 0.1];
        return send({ model: 'kev-latest', latency_ms: 12, answers: {
          lane: { type: 'choice', choice: lane, confidence: conf },
          risk: { type: 'choice', choice: /payment/.test(t) ? 'high' : 'low', confidence: 0.3 } } });
      }
      if ((req.url || '').startsWith('/v1/messages')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const msg = { id: 'm1', type: 'message', role: 'assistant', model: json.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
        for (const e of [
          { type: 'message_start', message: msg },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'MOCK-OK' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
          { type: 'message_stop' },
        ]) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
        return res.end();
      }
      res.statusCode = 404;
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    requests,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
  })));
}


// A claude-mem-like database: the columns bosun reads, and FTS tables shaped like claude-mem's schema v40.
export function claudeMemDb(file: string, rows: { obs?: { project: string; title: string; narrative: string; at?: number }[]; sums?: { project: string; request: string; learned: string; completed?: string; at?: number }[] }): void {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE observations (id INTEGER PRIMARY KEY AUTOINCREMENT, memory_session_id TEXT, project TEXT NOT NULL, text TEXT, type TEXT, title TEXT, subtitle TEXT, facts TEXT, narrative TEXT, concepts TEXT, created_at TEXT, created_at_epoch INTEGER NOT NULL);
    CREATE VIRTUAL TABLE observations_fts USING fts5(title, subtitle, narrative, text, facts, concepts, content='observations', content_rowid='id');
    CREATE TABLE session_summaries (id INTEGER PRIMARY KEY AUTOINCREMENT, memory_session_id TEXT, project TEXT NOT NULL, request TEXT, investigated TEXT, learned TEXT, completed TEXT, next_steps TEXT, notes TEXT, created_at TEXT, created_at_epoch INTEGER NOT NULL);
    CREATE VIRTUAL TABLE session_summaries_fts USING fts5(request, investigated, learned, completed, next_steps, notes, content='session_summaries', content_rowid='id');`);
  for (const o of rows.obs || []) {
    const r = db.prepare('INSERT INTO observations (project, type, title, narrative, created_at_epoch) VALUES (?, ?, ?, ?, ?)').run(o.project, 'discovery', o.title, o.narrative, o.at ?? Date.now());
    db.prepare('INSERT INTO observations_fts (rowid, title, narrative) VALUES (?, ?, ?)').run(r.lastInsertRowid, o.title, o.narrative);
  }
  for (const x of rows.sums || []) {
    const r = db.prepare('INSERT INTO session_summaries (project, request, learned, completed, created_at_epoch) VALUES (?, ?, ?, ?, ?)').run(x.project, x.request, x.learned, x.completed ?? '', x.at ?? Date.now());
    db.prepare('INSERT INTO session_summaries_fts (rowid, request, learned, completed) VALUES (?, ?, ?, ?)').run(r.lastInsertRowid, x.request, x.learned, x.completed ?? '');
  }
  db.close();
}

// A real `bosun mcp` stdio session: one JSON line out per request, in order.
export function mcpSession(env: NodeJS.ProcessEnv, cwd: string) {
  const p = spawn(process.execPath, [BIN, 'mcp'], { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines: string[] = [];
  const waiting: ((v: any) => void)[] = [];
  let buf = '';
  p.stdout.on('data', (d) => {
    buf += d;
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const l = buf.slice(0, i);
      buf = buf.slice(i + 1);
      lines.push(l);
      waiting.shift()?.(JSON.parse(l));
    }
  });
  const send = (m: object | string) => p.stdin.write(`${typeof m === 'string' ? m : JSON.stringify(m)}\n`);
  const next = () => new Promise<any>((res) => waiting.push(res));
  let n = 100;
  return {
    send, next,
    rpc: (id: unknown, method: string, params?: object) => { send({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }); return next(); },
    call: (name: string, args: object) => { send({ jsonrpc: '2.0', id: n++, method: 'tools/call', params: { name, arguments: args } }); return next(); },
    close: () => new Promise<{ code: number | null; lines: string[] }>((res) => { p.on('close', (code) => res({ code, lines })); p.stdin.end(); }),
  };
}
