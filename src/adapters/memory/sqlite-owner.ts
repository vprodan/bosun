// Explicit owner plan/apply/reconcile. Planning uses only filesystem metadata and minimal headers.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BosunError } from '../../core/errors.ts';
import { cutoverMemory, CutoverError, type CutoverPaths, type CutoverReceipt } from './sqlite-cutover.ts';

const TTL = 5 * 60 * 1000;
const MAX_BYTES = 64 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
type Operation = 'apply' | 'reconcile';
type Target = 'input' | 'runtime' | 'primary-directory' | 'view-directory' | 'backup-directory' | 'primary' | 'wal' | 'shm' | 'view' | 'backup' | 'plan';
type Reason = 'input' | 'runtime' | 'missing' | 'permissions' | 'path' | 'layout' | 'pending' | 'format' | 'size' | 'stale' | 'identity' | 'storage';
const TARGETS: Target[] = ['input', 'runtime', 'primary-directory', 'view-directory', 'backup-directory', 'primary', 'wal', 'shm', 'view', 'backup', 'plan'];
const REASONS: Reason[] = ['input', 'runtime', 'missing', 'permissions', 'path', 'layout', 'pending', 'format', 'size', 'stale', 'identity', 'storage'];
export type CutoverBlocker = { target: Target; reason: Reason; currentMode?: string; requiredMode?: string };
function safeBlocker(input: unknown): CutoverBlocker {
  try {
    if (!input || typeof input !== 'object') throw 0;
    const own = (name: string) => { const d = Object.getOwnPropertyDescriptor(input, name); return d && Object.hasOwn(d, 'value') ? d.value : undefined; };
    const target = own('target'); const reason = own('reason');
    if (!TARGETS.includes(target) || !REASONS.includes(reason)) throw 0;
    const result: CutoverBlocker = { target, reason };
    const currentMode = own('currentMode'); const requiredMode = own('requiredMode');
    if (typeof currentMode === 'string' && /^0[0-7]{3,4}$/.test(currentMode) && typeof requiredMode === 'string' && /^0[0-7]{3,4}$/.test(requiredMode)) {
      result.currentMode = currentMode; result.requiredMode = requiredMode;
    }
    return result;
  } catch { return { target: 'input', reason: 'storage' }; }
}
export class OwnerCutoverError extends BosunError {
  readonly blocker: CutoverBlocker;
  constructor(blocker: CutoverBlocker) {
    const safe = safeBlocker(blocker);
    super(safe.reason === 'input' ? 'invalid' : 'unavailable', `owner memory cutover unavailable (${safe.reason})`);
    this.blocker = safe;
  }
}
function fail(target: Target, reason: Reason, modes?: { currentMode: string; requiredMode: string }): never {
  throw new OwnerCutoverError({ target, reason, ...modes });
}
function mapped(error: unknown): never {
  // Never forward filesystem messages, callback errors, paths or database content.
  let blocker: CutoverBlocker | undefined; let cutover: CutoverError | undefined;
  try {
    if (error instanceof OwnerCutoverError) blocker = safeBlocker(Object.getOwnPropertyDescriptor(error, 'blocker')?.value);
    if (error instanceof CutoverError) cutover = new CutoverError(Object.getOwnPropertyDescriptor(error, 'reason')?.value);
  } catch {}
  if (blocker) throw new OwnerCutoverError(blocker);
  if (cutover) throw cutover;
  fail('input', 'storage');
}
function fields(input: unknown, names: string[]): Record<string, unknown> {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Reflect.ownKeys(input).some((key) => typeof key !== 'string' || !names.includes(key))) fail('input', 'input');
    const out: Record<string, unknown> = {};
    for (const name of names) {
      const d = Object.getOwnPropertyDescriptor(input, name);
      if (d && !Object.hasOwn(d, 'value')) fail('input', 'input');
      out[name] = d?.value;
    }
    return out;
  } catch { fail('input', 'input'); }
}
function stamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000 - TTL;
}
function time(now: unknown): number {
  if (typeof now !== 'function') fail('input', 'input');
  let value: unknown; try { value = now(); } catch { fail('input', 'input'); }
  if (!stamp(value)) fail('input', 'input'); return value;
}
function uuid(id: unknown): string {
  if (typeof id !== 'function') fail('input', 'input');
  let value: unknown; try { value = id(); } catch { fail('input', 'input'); }
  if (typeof value !== 'string' || !UUID.test(value)) fail('input', 'input'); return value;
}
function runtime(): void {
  if (process.versions.bun || process.platform === 'win32' || Number(process.versions.node.split('.')[0]) < 24 || !process.getuid) fail('runtime', 'runtime');
}
function configured(input: unknown): CutoverPaths {
  const p = fields(input, ['primary', 'view', 'backups']);
  for (const value of Object.values(p)) {
    if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value || value.includes('\0') || value.length > 4096) fail('input', 'path');
  }
  const result = p as CutoverPaths;
  if (result.primary === result.view || path.dirname(result.primary) === path.dirname(result.view)
    || result.backups === path.dirname(result.primary) || result.backups === path.dirname(result.view)) fail('input', 'layout');
  return result;
}
function present(file: string): boolean {
  try { fs.lstatSync(file); return true; }
  catch (e) { if ((e as { code?: unknown })?.code === 'ENOENT') return false; throw e; }
}
type Meta = { dev: string; ino: string; mode: string; uid: string; size?: string; mtime?: string; ctime?: string; header?: string };
function metadata(file: string, target: Target, directory = false, stable = true): Meta {
  let s: fs.BigIntStats;
  try { s = fs.lstatSync(file, { bigint: true }); }
  catch (e) { if ((e as { code?: unknown })?.code === 'ENOENT') fail(target, 'missing'); throw e; }
  if (s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile() || s.nlink !== 1n) || fs.realpathSync(file) !== file) fail(target, 'path');
  const required = directory ? 0o700 : 0o600;
  const current = Number(s.mode & 0o7777n);
  if (current !== required || Number(s.uid) !== process.getuid!()) fail(target, 'permissions', {
    currentMode: '0' + current.toString(8).padStart(3, '0'), requiredMode: '0' + required.toString(8),
  });
  const result: Meta = { dev: String(s.dev), ino: String(s.ino), mode: String(s.mode), uid: String(s.uid) };
  if (stable) Object.assign(result, { size: String(s.size), mtime: String(s.mtimeNs), ctime: String(s.ctimeNs) });
  return result;
}
function header(file: string, target: Target, meta: Meta, wal = false): Meta {
  const size = Number(meta.size);
  if (!Number.isSafeInteger(size) || size > MAX_BYTES || size < (wal ? 0 : 100)) fail(target, 'size');
  if (wal && size === 0) return { ...meta, header: '' };
  const count = wal ? 32 : 20;
  if (size < count) fail(target, 'format');
  const bytes = Buffer.alloc(count);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (String(opened.dev) !== meta.dev || String(opened.ino) !== meta.ino || fs.readSync(fd, bytes, 0, count, 0) !== count) fail(target, 'identity');
  } finally { fs.closeSync(fd); }
  if (JSON.stringify(metadata(file, target)) !== JSON.stringify(meta)) fail(target, 'identity');
  if (wal ? ![0x377f0682, 0x377f0683].includes(bytes.readUInt32BE(0))
    : bytes.toString('ascii', 0, 16) !== 'SQLite format 3\0' || bytes[18] !== (target === 'primary' ? 2 : 1) || bytes[19] !== (target === 'primary' ? 2 : 1)) fail(target, 'format');
  return { ...meta, header: bytes.toString('hex') };
}
type Snapshot = { paths: CutoverPaths; directories: Meta[]; primary: Meta; wal: Meta | null; shm: Meta | null; view: Meta | null; backups: { name: string; meta: Meta }[] };
function scan(p: CutoverPaths): Snapshot {
  runtime();
  // Source-directory times can change when native SQLite creates WAL/SHM; identity/mode stay bound.
  const directories = [metadata(path.dirname(p.primary), 'primary-directory', true, false),
    metadata(path.dirname(p.view), 'view-directory', true), metadata(p.backups, 'backup-directory', true)];
  if (present(p.primary + '-journal')) fail('primary', 'pending');
  const primary = header(p.primary, 'primary', metadata(p.primary, 'primary'));
  const wal = present(p.primary + '-wal') ? header(p.primary + '-wal', 'wal', metadata(p.primary + '-wal', 'wal'), true) : null;
  const shm = present(p.primary + '-shm') ? metadata(p.primary + '-shm', 'shm', false, false) : null;
  if (shm && fs.statSync(p.primary + '-shm').size > 4 * 1024 * 1024) fail('shm', 'size');
  if (Number(primary.size) + Number(wal?.size ?? 0) > MAX_BYTES) fail('primary', 'size');
  if (['-wal', '-shm', '-journal'].some((suffix) => present(p.view + suffix))) fail('view', 'pending');
  const view = present(p.view) ? header(p.view, 'view', metadata(p.view, 'view')) : null;
  const names = fs.readdirSync(p.backups).sort();
  // This first owner slice cannot independently establish ownership of orphan/multi-attempt artifacts.
  if (names.length !== (view ? 1 : 0)) fail('backup-directory', 'layout');
  const backups = names.map((name) => {
    if (!UUID.test(name.slice(0, -3)) || !name.endsWith('.db')) fail('backup', 'layout');
    const file = path.join(p.backups, name);
    if (['-wal', '-shm', '-journal'].some((suffix) => present(file + suffix))) fail('backup', 'pending');
    return { name, meta: header(file, 'backup', metadata(file, 'backup')) };
  });
  const identities = [primary, wal, shm, view, ...backups.map((b) => b.meta)].filter((m): m is Meta => !!m);
  if (new Set(identities.map((m) => `${m.dev}:${m.ino}`)).size !== identities.length) fail('input', 'path');
  return { paths: p, directories, primary, wal, shm, view, backups };
}
function fingerprint(snapshot: Snapshot): string { return crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'); }
type Token = { version: 1; operation: Operation; sourceId: string | null; issuedAt: number; expiresAt: number; fingerprint: string };
function token(input: unknown, now: number): Token {
  if (typeof input !== 'string' || input.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(input)) fail('plan', 'input');
  let parsed: Record<string, unknown>;
  try {
    const bytes = Buffer.from(input, 'base64url');
    if (bytes.toString('base64url') !== input) fail('plan', 'input');
    parsed = fields(JSON.parse(bytes.toString('utf8')), ['version', 'operation', 'sourceId', 'issuedAt', 'expiresAt', 'fingerprint']);
  } catch { fail('plan', 'input'); }
  if (parsed.version !== 1 || !['apply', 'reconcile'].includes(String(parsed.operation)) || !stamp(parsed.issuedAt) || parsed.expiresAt !== parsed.issuedAt + TTL
    || typeof parsed.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(parsed.fingerprint)
    || (parsed.operation === 'apply' ? typeof parsed.sourceId !== 'string' || !UUID.test(parsed.sourceId) : parsed.sourceId !== null)) fail('plan', 'input');
  if (now < parsed.issuedAt || now >= Number(parsed.expiresAt)) fail('plan', 'stale');
  return parsed as Token;
}
const REQUIREMENTS = ['Stop all owner memory, MCP, docs and server clients before a fresh plan; --clients-stopped is operator attestation, not verified drain.',
  'Reopen every authority after cutover; cached writers are fenced and restart is not automated.',
  'Save the initial sourceId independently; set MEMORY_SOURCE_ID yourself and explicitly publish separately for READY notes.',
  'Incomplete, rolled-back, multi-artifact, orphan and arbitrary restore recovery remain held.'] as const;
export type OwnerCutoverPlan = { state: 'PLANNED' | 'BLOCKED'; operation: Operation | null; sourceId: string | null; plan: string | null; expiresAt: number | null;
  schema: 'unverified'; floor: 'unverified'; clients: 'unverified'; blockers: CutoverBlocker[]; requirements: readonly string[] };
export function planOwnerCutover(input: { paths: CutoverPaths; now: () => number; id: () => string }): OwnerCutoverPlan {
  const base = { schema: 'unverified', floor: 'unverified', clients: 'unverified', requirements: REQUIREMENTS } as const;
  try {
    const o = fields(input, ['paths', 'now', 'id']); const issuedAt = time(o.now);
    if (typeof o.id !== 'function') fail('input', 'input');
    const snapshot = scan(configured(o.paths)); const operation = snapshot.view ? 'reconcile' : 'apply';
    const sourceId = operation === 'apply' ? uuid(o.id) : null; const expiresAt = issuedAt + TTL;
    const value: Token = { version: 1, operation, sourceId, issuedAt, expiresAt, fingerprint: fingerprint(snapshot) };
    return { ...base, state: 'PLANNED', operation, sourceId, plan: Buffer.from(JSON.stringify(value)).toString('base64url'), expiresAt, blockers: [] };
  } catch (error) {
    try { mapped(error); }
    catch (finite) {
      if (!(finite instanceof OwnerCutoverError)) throw finite;
      return { ...base, state: 'BLOCKED', operation: null, sourceId: null, plan: null, expiresAt: null, blockers: [finite.blocker] };
    }
  }
}
export type OwnerCutoverReceipt = CutoverReceipt & { operation: Operation; clientsStopped: 'attested'; restartRequired: true; publicationRequired: true; bindingRequired: true };
export async function applyOwnerCutover(input: { paths: CutoverPaths; plan: string; operation: Operation; sourceId?: string; clientsStopped: boolean;
  now: () => number; id: () => string }): Promise<OwnerCutoverReceipt> {
  try {
    const o = fields(input, ['paths', 'plan', 'operation', 'sourceId', 'clientsStopped', 'now', 'id']);
    const started = time(o.now); const approved = token(o.plan, started); const p = configured(o.paths);
    if (o.clientsStopped !== true || typeof o.id !== 'function' || o.operation !== approved.operation
      || (o.operation === 'apply' ? o.sourceId !== undefined : typeof o.sourceId !== 'string' || !UUID.test(o.sourceId))) fail('input', 'input');
    const before = scan(p); if (fingerprint(before) !== approved.fingerprint) fail('plan', 'stale');
    const sourceId = approved.operation === 'apply' ? approved.sourceId! : o.sourceId as string;
    let generated = 0;
    const result = await cutoverMemory({ paths: p, now: o.now as () => number,
      id: () => ++generated === 2 ? sourceId : uuid(o.id),
      expectation: { operation: approved.operation, sourceId, validate() {
        token(o.plan, time(o.now));
        const admitted = scan(p);
        // A closed WAL primary creates an empty WAL/SHM at native open. No source pages/frames changed.
        // Existing WAL/SHM identities remain exact; SHM content/time is SQLite lock housekeeping.
        if (!before.wal && !before.shm && admitted.wal?.size === '0' && admitted.wal.header === ''
          && admitted.shm && fs.statSync(p.primary + '-shm').size === 32768) { admitted.wal = null; admitted.shm = null; }
        if (fingerprint(admitted) !== approved.fingerprint) throw new CutoverError('identity');
      } },
    });
    return { ...result, operation: approved.operation, clientsStopped: 'attested', restartRequired: true, publicationRequired: true, bindingRequired: true };
  } catch (error) { return mapped(error); }
}
