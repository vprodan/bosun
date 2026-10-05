// bosun serve memory|kev: the /v1 memory API, or an allowlisting Kev forwarder, bound to a private interface.
// No tokens in v1: safety is the bind address plus a source-IP allowlist. authorize() is the one place auth goes later.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import { P, VERSION, type Cfg } from './config.ts';
import { curated, retrieve } from './context.ts';
import { log } from './log.ts';
import { openLocalMemory } from './memory/service.ts';
import { MIGRATIONS } from './memory/sqlite.ts';
import { MemoryError, type Ctx, type ErrorCode, type MemoryApi } from './memory/types.ts';
import { die, sh, validate, type Schema } from './util.ts';
import { modelMemoryError } from '../src/core/errors.ts';

export const DEFAULT_ALLOW = ['127.0.0.1/32', '100.64.0.0/10'];
const MAX_BODY = 64 * 1024;
const STATUS: Record<ErrorCode, number> = { not_found: 404, conflict: 409, invalid: 400, unavailable: 503 };
const CTX: Schema = { type: 'object', required: ['projectId'], properties: {
  projectId: { type: 'string', maxLength: 64 }, sessionId: { type: 'string', maxLength: 200 },
  linked: { type: 'array', maxItems: 50, items: { type: 'string', maxLength: 64 } }, source: { type: 'string', maxLength: 64 } } };

export function tailscaleIp(): string {
  for (const bin of ['tailscale', P.TAILSCALE_APP]) {
    if (bin !== 'tailscale' && !fs.existsSync(bin)) continue;
    const ip = sh(bin, ['ip', '-4']).out.split('\n')[0].trim();
    if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip;
  }
  return '';
}
export function bindAddress(cfg: Cfg): string {
  return cfg.SERVE_BIND || tailscaleIp()
    || die('no private interface to bind: Tailscale not found, so set SERVE_BIND to this Mac\'s LAN IP (bosun never binds 0.0.0.0 unless you set it)');
}
// SERVE_ALLOW, else loopback + Tailscale + the subnet of the bind address (from the interface's own netmask)
export function allowList(cfg: Cfg, bind: string): string[] {
  if (cfg.SERVE_ALLOW) return cfg.SERVE_ALLOW.split(',').map((s) => s.trim()).filter(Boolean);
  const net = Object.values(os.networkInterfaces()).flat().find((a) => a?.address === bind)?.cidr;
  return [...DEFAULT_ALLOW, ...(net ? [net] : [])];
}
const ip4 = (s: string) => s.split('.').reduce((n, o) => n * 256 + Number(o), 0);
export function allowed(addr: string | undefined, list: string[]): boolean {
  const a = String(addr || '').replace(/^::ffff:/, '').replace(/^::1$/, '127.0.0.1');
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(a)) return false;
  return list.some((c) => {
    const [net, bits = '32'] = c.split('/');
    const size = 2 ** (32 - Number(bits));
    return Math.floor(ip4(a) / size) === Math.floor(ip4(net) / size);
  });
}
// The auth middleware point. v1 has no tokens (clients already send MEMORY_TOKEN as a Bearer header; it is not checked yet).
export function authorize(_req: http.IncomingMessage): boolean { return true; }

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    // ponytail: an oversized body is drained, not cut off, so the 413 still reaches the client; fine on a private network
    req.on('data', (c: Buffer) => { size += c.length; if (size <= MAX_BODY) chunks.push(c); });
    req.on('end', () => {
      if (size > MAX_BODY) return reject(new HttpError(413, 'request body over 64 KB'));
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new HttpError(400, 'invalid JSON')); }
    });
    req.on('error', reject);
  });
}

const ROUTES: Record<string, (s: MemoryApi, b: any, c: Ctx) => Promise<unknown>> = {
  '/v1/memory/store': (s, b, c) => s.store(b.input, c),
  '/v1/memory/search': (s, b, c) => s.search(b.query ?? {}, c),
  '/v1/memory/get': (s, b, c) => s.get(b.id, c, { events: b.events === true }),
  '/v1/memory/update': (s, b, c) => s.update(b.id, b.patch ?? {}, b.expectedVersion, c),
  '/v1/memory/delete': (s, b, c) => s.delete(b.id, c),
  '/v1/memory/accept': (s, b, c) => s.accept(b.id, c),
  '/v1/memory/reject': (s, b, c) => s.reject(b.id, c),
  '/v1/context/retrieve': (s, b, c) => retrieve(String(b.task ?? ''), [curated(s)], c, { budgetTokens: Number(b.budgetTokens) || 400, minScore: Number(b.minScore) || 0, itemChars: 400 }),
};

export function memoryServer(_cfg: Cfg, svc: MemoryApi, allow: string[]): http.Server {
  return http.createServer(async (req, res) => {
    const contextRequest = req.method === 'POST' && (req.url || '').split('?')[0] === '/v1/context/retrieve';
    const send = (status: number, body: object) => { if (!res.headersSent) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); } };
    const fail = (status: number, code: ErrorCode, message: string, current?: number) => send(status, { ok: false, error: { code, message, ...(current ? { current } : {}) } });
    try {
      if (!allowed(req.socket.remoteAddress, allow)) { log('warn', 'serve.denied', { from: req.socket.remoteAddress }); return fail(403, 'invalid', 'forbidden'); }
      if (!authorize(req)) return fail(401, 'invalid', 'unauthorized');
      const url = (req.url || '').split('?')[0];
      if (req.method === 'GET' && url === '/v1/health') return send(200, { ok: true, data: { version: VERSION, schema: MIGRATIONS.length, memory: true } });
      const route = ROUTES[url];
      if (req.method !== 'POST' || !route) return fail(404, 'not_found', 'no such route');
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) return fail(415, 'invalid', 'JSON only');
      const body = await readBody(req);
      const raw = Object.fromEntries(Object.entries(body.ctx && typeof body.ctx === 'object' ? body.ctx : {}).filter(([, v]) => v !== null));   // null = absent
      const bad = validate(CTX, raw);
      if (bad) return fail(400, 'invalid', bad);
      const c: Ctx = { projectId: raw.projectId as string, sessionId: (raw.sessionId as string) ?? null, linked: (raw.linked as string[]) ?? [], source: (raw.source as string) ?? 'remote' };
      return send(200, { ok: true, data: await route(svc, body, c) });
    } catch (e) {
      if (e instanceof MemoryError) {
        if (contextRequest) {
          const safe = modelMemoryError(e);
          return fail(STATUS[safe.code], safe.code, safe.message);
        }
        return fail(STATUS[e.code], e.code, e.message, e.current);
      }
      if (e instanceof HttpError) return fail(e.status, 'invalid', e.message);
      log('error', 'serve.memory', { err: e });
      return fail(500, 'unavailable', 'internal error');
    }
  });
}

// Kev keeps its own 127.0.0.1 port; this listens on the bind address and forwards allowed requests to it.
export function kevServer(cfg: Cfg, allow: string[]): http.Server {
  return http.createServer((req, res) => {
    if (!allowed(req.socket.remoteAddress, allow)) { log('warn', 'serve.denied', { from: req.socket.remoteAddress }); res.writeHead(403).end(); return; }
    const up = http.request({ host: '127.0.0.1', port: Number(cfg.ROUTER_PORT), method: req.method, path: req.url, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(up);
  });
}

export function listen(server: http.Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve((server.address() as { port: number }).port));
  });
}

export async function main(argv: string[], cfg: Cfg): Promise<number> {
  const kind = argv[0];
  if (kind !== 'memory' && kind !== 'kev') return die('usage: bosun serve memory|kev [--port N]', 2);
  const bind = bindAddress(cfg);
  const allow = allowList(cfg, bind);
  const pi = argv.indexOf('--port');
  const port = pi >= 0 ? Number(argv[pi + 1]) : Number(kind === 'memory' ? cfg.MEMORY_PORT : cfg.ROUTER_PORT);
  const svc = kind === 'memory' ? openLocalMemory(cfg) : null;
  const server = svc ? memoryServer(cfg, svc, allow) : kevServer(cfg, allow);
  try {
    const got = await listen(server, port, bind);
    console.log(`bosun serve ${kind} on http://${bind}:${got}  (allow ${allow.join(', ')})`);
    await new Promise((res) => { process.once('SIGTERM', res); process.once('SIGINT', res); });
    return 0;
  } finally { server.close(); svc?.close(); }
}
