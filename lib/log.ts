// Structured JSON-lines log (~/.bosun/bosun.log). Metadata only: content-bearing fields and error messages never reach it.
import fs from 'node:fs';
import path from 'node:path';
import { P } from './config.ts';

const CONTENT = /title|body|prompt|text|content|snippet|query|task|token|key|secret|password|auth/i;
const clean = (k: string, v: unknown): unknown => (v instanceof Error
  ? { name: v.name, code: (v as { code?: unknown }).code }   // a message can quote content ("… is not valid JSON")
  : CONTENT.test(k) ? '[redacted]' : v);

export function log(level: 'info' | 'warn' | 'error', event: string, fields: Record<string, unknown> = {}): void {
  try {
    fs.mkdirSync(P.BOSUN, { recursive: true });
    const safe = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, clean(k, v)]));
    fs.appendFileSync(path.join(P.BOSUN, 'bosun.log'), `${JSON.stringify({ ts: new Date().toISOString(), level, event, ...safe })}\n`);
  } catch { /* logging never breaks a caller */ }
}
