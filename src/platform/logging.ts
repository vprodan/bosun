// Explicit daemon composition only. Closed projections are the primary privacy boundary; redaction is a backstop.
import fs from 'node:fs';
import path from 'node:path';
import { configureSync, getConfig, getLogger, resetSync, type LogRecord, type Sink } from '@logtape/logtape';
import { getFileSink } from '@logtape/file';
import { redactByField } from '@logtape/redaction';
import { BosunError } from '../core/errors.ts';
import type { JobMetadataEvent } from '../core/domain/usage.ts';
import { privateDirectory } from './private-file.ts';

export type RuntimeLogEvent = JobMetadataEvent | { event: 'daemon.start' | 'daemon.stop' | 'daemon.hold' | 'log.open'; state?: 'running' | 'held' | 'draining' | 'stopped'; outcome?: 'unknown' };
const EVENTS = ['daemon.start', 'daemon.stop', 'daemon.hold', 'log.open', 'job.state', 'job.usage', 'job.storage_hold'];
const STATES = ['queued', 'held', 'running', 'succeeded', 'failed', 'cancelled', 'unknown', 'draining', 'stopped'];
const REASONS = ['quota', 'approval', 'admission_unavailable', 'runner_unavailable', 'unsupported', 'cancel_requested', 'interrupted', 'runner_lost', 'output_limit', 'event_limit', 'runner_failed'];
const LIMIT = 1024 * 1024;
const own = (value: unknown, key: string): unknown => {
  const descriptor = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, key) : undefined;
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
};
function projection(value: unknown): Record<string, unknown> | null {
  try {
    const event = own(value, 'event'); if (!EVENTS.includes(event as string)) return null;
    const result: Record<string, unknown> = { event };
    const state = own(value, 'state'); if (state !== undefined) { if (!STATES.includes(state as string)) return null; result.state = state; }
    const reason = own(value, 'reason'); if (reason !== undefined) { if (reason !== null && !REASONS.includes(reason as string)) return null; result.reason = reason; }
    const outcome = own(value, 'outcome'); if (outcome !== undefined) { if (outcome !== 'unknown') return null; result.outcome = outcome; }
    for (const key of ['generation', 'tokensIn', 'tokensOut']) {
      const count = own(value, key);
      if (count !== undefined) { if (count !== null && (!Number.isSafeInteger(count) || Number(count) < 0)) return null; result[key] = count; }
    }
    return result;
  } catch { return null; }
}
function line(record: LogRecord): string {
  const projected = projection(record.properties);
  if (!projected || !Number.isSafeInteger(record.timestamp) || record.timestamp < 0 || record.timestamp > 8_640_000_000_000_000) return '';
  return JSON.stringify({ schema: 1, at: record.timestamp, ...projected }) + '\n';
}
const unavailable = () => new BosunError('unavailable', 'Runtime logging unavailable');

export function openRuntimeLog(options: { file: string; maxBytes?: number; archives?: number }) {
  let active: (Sink & Disposable) | undefined; let closed = false; let held = false;
  const { file, maxBytes = LIMIT, archives = 3 } = options;
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.resolve(file) !== file || file.includes('\0')
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > LIMIT || !Number.isSafeInteger(archives) || archives < 1 || archives > 3) throw unavailable();
  const files = Array.from({ length: archives + 1 }, (_, index) => file + (index ? '.' + index : ''));
  const stat = (target: string): fs.Stats | null => {
    try {
      const value = fs.lstatSync(target);
      if (!value.isFile() || value.nlink !== 1 || (value.mode & 0o7777) !== 0o600 || fs.realpathSync(target) !== target
        || process.getuid && value.uid !== process.getuid() || value.size > maxBytes) throw unavailable();
      return value;
    } catch (error) { if (error && typeof error === 'object' && Object.getOwnPropertyDescriptor(error, 'code')?.value === 'ENOENT') return null; throw unavailable(); }
  };
  const validate = (target: string): void => {
    const prior = stat(target); if (!prior) return;
    const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const opened = fs.fstatSync(fd); if (opened.dev !== prior.dev || opened.ino !== prior.ino) throw unavailable();
      const bytes = Buffer.alloc(prior.size); let at = 0;
      while (at < bytes.length) { const n = fs.readSync(fd, bytes, at, bytes.length - at, at); if (!n) throw unavailable(); at += n; }
      const text = new TextDecoder('utf8', { fatal: true }).decode(bytes);
      if (!text.endsWith('\n') || !text.length) throw unavailable();
      const rows = text.slice(0, -1).split('\n');
      for (const [index, encoded] of rows.entries()) {
        if (encoded.length > 512) throw unavailable();
        const record = JSON.parse(encoded); const projected = projection(record);
        if (!projected || record.schema !== 1 || !Number.isSafeInteger(record.at) || record.at < 0 || record.at > 8_640_000_000_000_000
          || index === 0 && record.event !== 'log.open' || Object.keys(record).length !== Object.keys(projected).length + 2) throw unavailable();
      }
      const after = stat(target); if (!after || after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw unavailable();
    } finally { fs.closeSync(fd); }
  };
  const create = (): void => {
    const at = Date.now(); if (!Number.isSafeInteger(at) || at < 0 || at > 8_640_000_000_000_000) throw unavailable();
    const fd = fs.openSync(file, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ schema: 1, at, event: 'log.open' }) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  };
  let identity: fs.Stats;
  const reopen = () => { identity = stat(file)!; active = getFileSink(file, { formatter: line, bufferSize: 0, flushInterval: 0 }); };
  const rotate = (): void => {
    for (const target of files) validate(target);
    active![Symbol.dispose](); active = undefined;
    if (stat(files.at(-1)!)) fs.unlinkSync(files.at(-1)!);
    for (let index = archives - 1; index >= 1; index--) if (stat(files[index])) fs.renameSync(files[index], files[index + 1]);
    fs.renameSync(file, files[1]); create(); reopen();
  };
  // Installed @logtape/file opens new files using ambient modes. This explicit wrapper creates each owned leaf at0600 before opening its actual file sink.
  const guarded: Sink = (record) => {
    if (closed || held) return;
    try {
      const encoded = line(record); if (!encoded) return;
      privateDirectory(path.dirname(file)); const current = stat(file);
      if (!current || current.dev !== identity.dev || current.ino !== identity.ino || current.size !== identity.size
        || current.mtimeMs !== identity.mtimeMs || current.ctimeMs !== identity.ctimeMs) throw unavailable();
      if (current.size + Buffer.byteLength(encoded) > maxBytes) rotate();
      active!(record); identity = stat(file)!;
    } catch { held = true; }
  };
  const redacted = redactByField(guarded, { fieldPatterns: [/prompt|body|title|result|tool|file|path|account|auth|token(?!sIn|sOut)|password|secret|error/i], action: 'delete', maxDepth: 4, maxProperties: 32 });
  const config = { sinks: { private: redacted }, loggers: [
    { category: ['bosun', 'runtime'], sinks: ['private'], lowestLevel: 'info' as const, parentSinks: 'override' as const },
    { category: ['logtape', 'meta'], lowestLevel: null, sinks: [] },
  ] };
  try {
    if (getConfig() !== null) throw unavailable();
    privateDirectory(path.dirname(file)); for (const target of files) validate(target);
    if (!stat(file)) create(); reopen(); configureSync(config);
  } catch { try { active?.[Symbol.dispose](); } catch {} throw unavailable(); }
  const logger = getLogger(['bosun', 'runtime']);
  return {
    record(event: RuntimeLogEvent): boolean {
      if (closed || held) return false;
      const projected = projection(event); if (!projected) return false;
      try { logger.info('runtime event', projected); return !held; } catch { held = true; return false; }
    },
    state(): 'ready' | 'held' | 'closed' { return closed ? 'closed' : held ? 'held' : 'ready'; },
    close(): void {
      if (closed) return; closed = true;
      if (getConfig() === config) try { resetSync(); } catch {}
      try { active?.[Symbol.dispose](); } catch { held = true; } active = undefined;
    },
  };
}
