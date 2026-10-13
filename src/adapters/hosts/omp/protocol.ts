import { BosunError } from '../../../core/errors.ts';

export const OMP_VERSION = '18.10.3';
export const OMP_SOURCE_COMMIT = '81e1d8927a3c16cfaff2e9456baa8c060e1e0e9b';
export const OMP_LIMITS = Object.freeze({
  frameBytes: 1048576, logicalBytes: 2097152, sourceBytes: 4194304,
  frames: 8192, requests: 1024, entries: 512, messages: 256,
  promptBytes: 32768, seedBytes: 16384, textBytes: 65536,
});
export type OmpMethod = 'negotiate_protocol' | 'get_state' | 'get_entries' | 'get_messages_page'
  | 'set_model' | 'set_thinking_level' | 'set_auto_compaction' | 'set_auto_retry'
  | 'set_cache_warming' | 'set_event_filter' | 'prompt' | 'abort_and_restore_queue';
export type OmpFrame = Record<string, unknown> & { type: string };
export type OmpSelection = { model: string; provider: string; modelId: string; effort: string; access: 'read' | 'edit'; tools: string[] };
export const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
export const own = (value: object, key: string): unknown => Object.getOwnPropertyDescriptor(value, key)?.value;
export const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
export const identifier = (value: unknown, max = 256): value is string =>
  typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= max && !/[\x00-\x20\x7f]/.test(value);
export const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && !value.includes('\0') && Buffer.byteLength(value) <= max;
export function ompFailure(code: 'invalid' | 'unverified' | 'unavailable' | 'timeout' | 'cancelled' = 'unavailable', unknown = false): BosunError {
  return new BosunError(code, code === 'invalid' ? 'Invalid OMP native request' : code === 'unverified'
    ? 'OMP native control unverified' : code === 'timeout' ? 'OMP native request timed out'
      : code === 'cancelled' ? 'OMP native request cancelled' : 'OMP native source unavailable',
  unknown ? { details: { outcome: 'unknown' } } : undefined);
}
export function selection(model: unknown, effort: unknown, access: unknown): OmpSelection {
  if (!identifier(model) || !/^[a-z][a-z0-9_-]*\/[^\s\x00-\x1f\x7f]+$/.test(model)
    || /[*,@?\[\]]/.test(model)
    || !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(String(effort))
    || (access !== 'read' && access !== 'edit')) throw ompFailure('invalid');
  const slash = model.indexOf('/');
  return { model, provider: model.slice(0, slash), modelId: model.slice(slash + 1), effort: effort as string,
    access, tools: access === 'read' ? ['glob', 'grep', 'read'] : ['edit', 'glob', 'grep', 'read', 'write'] };
}
export function sameTools(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) && value.length === expected.length && value.every((name) => typeof name === 'string')
    && new Set(value).size === value.length && [...value].sort().every((name, i) => name === expected[i]);
}
export function assertReadyFrame(frame: OmpFrame): void {
  if (frame.type !== 'ready' || frame.protocolVersion !== 1 || !Array.isArray(frame.supportedProtocolVersions)
    || !frame.supportedProtocolVersions.includes(2) || frame.maxFrameBytes !== 1048576
    || frame.maxReassembledFrameBytes !== 67108864) throw ompFailure('unverified');
}
// Pinned rpc-frame.ts: negotiate v2 before accepting evidence; v1 may elide
// content. Our lower logical/total ceilings are deliberate holds, not truncation.
export class OmpFrameDecoder {
  private pending = Buffer.alloc(0);
  private chunk?: { id: string; count: number; bytes: number; next: number; received: number; parts: Buffer[] };
  private frames = 0;
  private total = 0;
  private readonly utf8 = new TextDecoder('utf-8', { fatal: true });
  push(bytes: Uint8Array, emit: (frame: OmpFrame) => void): void {
    this.total += bytes.byteLength;
    if (this.total > OMP_LIMITS.sourceBytes) throw ompFailure('unavailable', true);
    this.pending = this.pending.length ? Buffer.concat([this.pending, bytes]) : Buffer.from(bytes);
    let start = 0;
    for (;;) {
      const end = this.pending.indexOf(10, start);
      if (end < 0) break;
      if (end - start + 1 > OMP_LIMITS.frameBytes || end === start) throw ompFailure('unavailable', true);
      const frame = this.parse(this.pending.subarray(start, end));
      start = end + 1;
      if (++this.frames > OMP_LIMITS.frames) throw ompFailure('unavailable', true);
      const logical = this.logical(frame);
      if (logical) emit(logical);
    }
    this.pending = this.pending.subarray(start);
    if (this.pending.length >= OMP_LIMITS.frameBytes) throw ompFailure('unavailable', true);
  }
  finish(): void { if (this.pending.length || this.chunk) throw ompFailure('unavailable', true); }
  private parse(bytes: Uint8Array): OmpFrame {
    let value: unknown;
    try { value = JSON.parse(this.utf8.decode(bytes)); } catch { throw ompFailure('unavailable', true); }
    if (!object(value) || !identifier(value.type, 128)) throw ompFailure('unavailable', true);
    return value as OmpFrame;
  }
  private logical(frame: OmpFrame): OmpFrame | null {
    if (frame.type !== 'rpc_chunk') {
      if (this.chunk || frame.type === 'rpc_frame_error' || frame.rpcFrameElidedKeys !== undefined)
        throw ompFailure('unavailable', true);
      return frame;
    }
    if (!identifier(frame.chunkId) || !integer(frame.index) || !integer(frame.count) || frame.count < 1 || frame.count > 64
      || !integer(frame.byteLength) || frame.byteLength < 1 || frame.byteLength > OMP_LIMITS.logicalBytes
      || typeof frame.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.data))
      throw ompFailure('unavailable', true);
    const bytes = Buffer.from(frame.data, 'base64');
    if (!bytes.length || bytes.toString('base64') !== frame.data) throw ompFailure('unavailable', true);
    if (!this.chunk) {
      if (frame.index !== 0) throw ompFailure('unavailable', true);
      this.chunk = { id: frame.chunkId, count: frame.count, bytes: frame.byteLength, next: 0, received: 0, parts: [] };
    }
    const chunk = this.chunk;
    if (chunk.id !== frame.chunkId || chunk.count !== frame.count || chunk.bytes !== frame.byteLength
      || chunk.next !== frame.index || (chunk.received += bytes.length) > chunk.bytes) throw ompFailure('unavailable', true);
    chunk.parts.push(bytes); chunk.next++;
    if (chunk.next !== chunk.count) return null;
    if (chunk.received !== chunk.bytes) throw ompFailure('unavailable', true);
    const value = this.parse(Buffer.concat(chunk.parts, chunk.bytes));
    this.chunk = undefined;
    if (value.type === 'rpc_chunk' || value.type === 'rpc_frame_error' || value.rpcFrameElidedKeys !== undefined)
      throw ompFailure('unavailable', true);
    return value;
  }
}
