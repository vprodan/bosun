// Structured metadata only. Each event selects finite fields; arbitrary objects/messages/causes never serialize.
import fs from 'node:fs';
import path from 'node:path';
import { isIP } from 'node:net';
import { P } from './config.ts';
import { BOSUN_ERROR_CODES } from '../src/core/errors.ts';

const EVENTS = new Set(['db.migrate', 'claude-mem.unavailable', 'hook.memory', 'mcp.tool', 'mcp.handle', 'serve.denied', 'serve.memory', 'consolidate']);
const PROVIDERS = new Set(['ollama', 'openai', 'claude-cli']);
const TOOLS = new Set(['memory_search', 'memory_get', 'memory_store', 'memory_update', 'memory_delete', 'context_retrieve', 'project_knowledge_search']);
const ERROR_NAMES = new Set(['Error', 'TypeError', 'SyntaxError', 'RangeError', 'TimeoutError', 'AbortError', 'MemoryError']);
const ERROR_CODES = new Set([...BOSUN_ERROR_CODES, 'ENOENT', 'EACCES', 'ECONNREFUSED', 'ERR_SQLITE_ERROR', 'SQLITE_BUSY', 'SQLITE_ERROR']);
const number = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const member = (values: Set<string>, value: unknown): string => typeof value === 'string' && values.has(value) ? value : 'unknown';

export function log(level: 'info' | 'warn' | 'error', event: string, fields: Record<string, unknown> = {}): void {
  try {
    const safe: Record<string, string | number | undefined> = {};
    switch (event) {
      case 'db.migrate': safe.version = number(fields.version); break;
      case 'claude-mem.unavailable': safe.what = fields.what === 'search' || fields.what === 'summaries' ? fields.what : 'unknown'; break;
      case 'mcp.tool': safe.tool = member(TOOLS, fields.tool); break;
      case 'serve.denied': safe.from = typeof fields.from === 'string' && isIP(fields.from) ? fields.from : 'unknown'; break;
      case 'consolidate':
        safe.summaries = number(fields.summaries); safe.proposed = number(fields.proposed); safe.skipped = number(fields.skipped);
        safe.provider = member(PROVIDERS, fields.provider); break;
    }
    if (fields.err !== undefined) {
      // Construct fresh primitive fields: even an Error's name/code may be untrusted.
      const err = fields.err;
      safe.error_name = err instanceof Error ? member(ERROR_NAMES, err.name) : 'unknown';
      safe.error_code = err instanceof Error ? member(ERROR_CODES, (err as { code?: unknown }).code) : 'unknown';
    }
    fs.mkdirSync(P.BOSUN, { recursive: true });
    fs.appendFileSync(path.join(P.BOSUN, 'bosun.log'), `${JSON.stringify({ ts: new Date().toISOString(),
      level: ['info', 'warn', 'error'].includes(level) ? level : 'warn', event: EVENTS.has(event) ? event : 'other', ...safe })}\n`);
  } catch { /* logging never breaks a caller */ }
}
