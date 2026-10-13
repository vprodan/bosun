import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BosunError } from '../../../core/errors.ts';
import { requirePublicInput } from '../../../core/policy.ts';
import { screenPublicText } from '../../../core/secret-screen.ts';
import { privateDirectory } from '../../../platform/private-file.ts';
import { CLAUDE_VERSION } from './runner.ts';

export const CLAUDE_TRANSCRIPT_LIMITS = Object.freeze({
  bytes: 1024 * 1024, rows: 128, lineBytes: 262144, textBytes: 65536,
});
export type ClaudeTranscriptBinding = Readonly<{
  file: string; home: string; cwd: string; id: string; projectKey: string;
  dev: bigint; ino: bigint;
}>;
export type ClaudeTranscriptMessage = Readonly<{
  uuid: string; parentUuid: string | null; role: 'user' | 'assistant';
  text: string; model?: string;
}>;
export type ClaudeTranscriptSnapshot = Readonly<{
  messages: readonly ClaudeTranscriptMessage[]; sha256: string; bytes: number;
}>;
type Identity = { path: string; dev: bigint; ino: bigint };
type Bound = { parents: Identity[]; cwd: Identity; prefix: Buffer };
const bindings = new WeakMap<ClaudeTranscriptBinding, Bound>();
const unavailable = () => new BosunError('unverified', 'Claude retained transcript unavailable');
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === 'string'
  && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const sha = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex');
const bounded = (value: unknown, max: number): value is string => typeof value === 'string'
  && !value.includes('\0') && Buffer.byteLength(value) <= max;
function finite(error: unknown): never {
  if (error instanceof BosunError && error.code === 'private_input') throw error;
  throw unavailable();
}
function canonical(directory: string): fs.BigIntStats {
  if (typeof directory !== 'string' || directory.includes('\0')
    || Buffer.byteLength(directory) > 4096 || !path.isAbsolute(directory)
    || path.resolve(directory) !== directory || fs.realpathSync(directory) !== directory) throw unavailable();
  const stat = fs.lstatSync(directory, { bigint: true });
  if (!stat.isDirectory() || process.getuid && stat.uid !== BigInt(process.getuid())) throw unavailable();
  return stat;
}
function directoryIdentity(directory: string, privateMode: boolean): Identity {
  if (privateMode) privateDirectory(directory);
  const stat = canonical(directory);
  return { path: directory, dev: stat.dev, ino: stat.ino };
}
function repeatDirectories(state: Bound): void {
  for (const identity of [...state.parents, state.cwd]) {
    const actual = directoryIdentity(identity.path, identity !== state.cwd);
    if (actual.dev !== identity.dev || actual.ino !== identity.ino) throw unavailable();
  }
}
function fileIdentity(file: string): fs.BigIntStats {
  const stat = fs.lstatSync(file, { bigint: true });
  if (!stat.isFile() || stat.nlink !== 1n || (stat.mode & 0o7777n) !== 0o600n
    || process.getuid && stat.uid !== BigInt(process.getuid())
    || fs.realpathSync(file) !== file || stat.size > BigInt(CLAUDE_TRANSCRIPT_LIMITS.bytes)) throw unavailable();
  return stat;
}
const unchanged = (a: fs.BigIntStats, b: fs.BigIntStats) =>
  a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid
  && a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
function readBounded(binding: ClaudeTranscriptBinding, state: Bound): Buffer {
  repeatDirectories(state);
  const before = fileIdentity(binding.file);
  if (before.dev !== binding.dev || before.ino !== binding.ino) throw unavailable();
  const fd = fs.openSync(binding.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    if (!unchanged(before, fs.fstatSync(fd, { bigint: true }))) throw unavailable();
    const buffer = Buffer.alloc(CLAUDE_TRANSCRIPT_LIMITS.bytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = fs.readSync(fd, buffer, size, buffer.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size !== Number(before.size) || size > CLAUDE_TRANSCRIPT_LIMITS.bytes
      || !unchanged(before, fs.fstatSync(fd, { bigint: true }))
      || !unchanged(before, fileIdentity(binding.file))) throw unavailable();
    repeatDirectories(state);
    const raw = buffer.subarray(0, size);
    // Previously admitted history cannot be truncated, edited or replaced.
    if (raw.length < state.prefix.length || !raw.subarray(0, state.prefix.length).equals(state.prefix)) throw unavailable();
    return raw;
  } finally { fs.closeSync(fd); }
}

// SDK 0.3.292 sdk.mjs uses CLAUDE_CONFIG_DIR/projects/<project key>/<UUID>.jsonl
// and honors CLAUDE_CODE_PROJECT_DIR_NAME with an explicit config home. Only a
// trusted creator's assigned bosun-<UUID> namespace is accepted here; no SDK
// discovery, other project/session reads, permission repair or native writes.
// https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.292/sdk.mjs
export function bindClaudeTranscript(input: {
  privacy: 'public'; home: string; cwd: string; id: string;
}): ClaudeTranscriptBinding {
  requirePublicInput(input);
  try {
    if (!uuid(input.id)) throw unavailable();
    const home = input.home, cwd = input.cwd, projectKey = 'bosun-' + input.id;
    const parents = [home, path.join(home, 'projects'), path.join(home, 'projects', projectKey)]
      .map(directory => directoryIdentity(directory, true));
    const state: Bound = { parents, cwd: directoryIdentity(cwd, false), prefix: Buffer.alloc(0) };
    const file = path.join(parents[2].path, input.id + '.jsonl'), stat = fileIdentity(file);
    const binding = Object.freeze({ file, home, cwd, id: input.id, projectKey, dev: stat.dev, ino: stat.ino });
    state.prefix = Buffer.from(readBounded(binding, state));
    bindings.set(binding, state);
    return binding;
  } catch (error) { return finite(error); }
}
function publicClassification(row: Record<string, unknown>): void {
  if (Object.hasOwn(row, 'privacy') && row.privacy !== 'public') throw unavailable();
}
function keys(row: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(row).some(key => !allowed.includes(key))) throw unavailable();
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value.includes('\0')
    || Buffer.byteLength(value) > CLAUDE_TRANSCRIPT_LIMITS.textBytes) throw unavailable();
  screenPublicText(value);
  return value;
}
function messageText(row: Record<string, unknown>, role: 'user' | 'assistant'): string {
  publicClassification(row);
  keys(row, role === 'user' ? ['role', 'content', 'privacy']
    : ['id', 'type', 'role', 'content', 'model', 'stop_reason', 'stop_sequence', 'usage', 'privacy']);
  if (row.role !== role) throw unavailable();
  if (role === 'user' && typeof row.content === 'string') return text(row.content);
  if (!Array.isArray(row.content) || !row.content.length || row.content.length > 64) throw unavailable();
  const parts: string[] = [];
  for (const block of row.content) {
    if (!object(block)) throw unavailable();
    publicClassification(block);
    if (block.type === 'text') {
      keys(block, ['type', 'text', 'privacy']); parts.push(text(block.text));
    } else if (role === 'assistant' && block.type === 'thinking') {
      keys(block, ['type', 'thinking', 'signature', 'privacy']);
      if (typeof block.thinking !== 'string' || typeof block.signature !== 'string') throw unavailable();
    } else if (role === 'assistant' && block.type === 'redacted_thinking') {
      keys(block, ['type', 'data', 'privacy']); if (typeof block.data !== 'string') throw unavailable();
    } else throw unavailable(); // Tool/file/media receipts need a qualified native driver.
  }
  if (role === 'user' && (row.content.length !== 1 || !parts.length)) throw unavailable();
  return text(parts.join('')); // Screen the complete text before later evidence chunking.
}

// The public SDK reader follows parentUuid and tolerates histories/sidechains.
// This candidate deliberately requires one fresh linear root and rejects
// unknown metadata, compaction, tool payloads and synthetic/subagent messages.
// https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.292/sdk.d.ts (getSessionMessages)
export function readClaudeTranscript(binding: ClaudeTranscriptBinding): ClaudeTranscriptSnapshot {
  try {
    const state = bindings.get(binding); if (!state) throw unavailable();
    const raw = readBounded(binding, state);
    const source = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    if (!source.endsWith('\n')) throw unavailable();
    const lines = source.slice(0, -1).split('\n');
    if (!lines.length || lines.length > CLAUDE_TRANSCRIPT_LIMITS.rows) throw unavailable();
    const ids = new Set<string>(), messages: ClaudeTranscriptMessage[] = [];
    let parent: string | null = null;
    for (const line of lines) {
      if (!line || Buffer.byteLength(line) > CLAUDE_TRANSCRIPT_LIMITS.lineBytes) throw unavailable();
      const row: unknown = JSON.parse(line);
      if (!object(row)) throw unavailable();
      publicClassification(row);
      keys(row, ['type', 'uuid', 'parentUuid', 'isSidechain', 'cwd', 'sessionId', 'version', 'message',
        'timestamp', 'userType', 'gitBranch', 'requestId', 'isMeta', 'isCompactSummary', 'isApiErrorMessage', 'privacy']);
      if (!['user', 'assistant'].includes(String(row.type)) || !uuid(row.uuid) || ids.has(row.uuid)
        || row.parentUuid !== parent || row.isSidechain !== false || row.cwd !== binding.cwd
        || row.sessionId !== binding.id || row.version !== CLAUDE_VERSION || !object(row.message)
        || ['isMeta', 'isCompactSummary', 'isApiErrorMessage'].some(key => row[key] !== undefined && row[key] !== false)
        || row.userType !== undefined && row.userType !== 'external'
        || row.gitBranch !== undefined && !bounded(row.gitBranch, 256)
        || row.requestId !== undefined && !bounded(row.requestId, 256)
        || typeof row.timestamp !== 'string' || !Number.isFinite(Date.parse(row.timestamp))
        || !messages.length && row.type !== 'user') throw unavailable();
      const role = row.type as 'user' | 'assistant', body = messageText(row.message, role);
      if (role === 'user' && !body.trim()) throw unavailable();
      let model: string | undefined;
      if (role === 'assistant') {
        if (!bounded(row.message.model, 256) || !row.message.model || /\s/.test(row.message.model)
          || !bounded(row.message.id, 256) || !row.message.id || row.message.type !== 'message'
          || row.message.stop_reason !== null && !['end_turn', 'max_tokens', 'stop_sequence', 'tool_use', 'pause_turn', 'refusal'].includes(String(row.message.stop_reason))
          || row.message.stop_sequence !== null && !bounded(row.message.stop_sequence, 256)
          || !object(row.message.usage)) throw unavailable();
        model = row.message.model;
      }
      messages.push(Object.freeze({ uuid: row.uuid, parentUuid: parent, role, text: body, ...(model ? { model } : {}) }));
      ids.add(row.uuid); parent = row.uuid;
    }
    state.prefix = Buffer.from(raw);
    return Object.freeze({ messages: Object.freeze(messages), sha256: sha(raw), bytes: raw.length });
  } catch (error) { return finite(error); }
}
export function readClaudeTranscriptSeed(binding: ClaudeTranscriptBinding, expected: {
  privacy: 'public'; uuid: string; text: string;
}): { seedHash: string; snapshotHash: string; bytes: number; nativeReadiness: 'unqualified' } {
  requirePublicInput(expected);
  try {
    if (!uuid(expected.uuid)) throw unavailable();
    const body = text(expected.text); if (!body.trim() || Buffer.byteLength(body) > 16384) throw unavailable();
    const snapshot = readClaudeTranscript(binding), [seed] = snapshot.messages;
    if (snapshot.messages.length !== 1 || seed.role !== 'user' || seed.uuid !== expected.uuid
      || seed.parentUuid !== null || seed.text !== body) throw unavailable();
    // Independent disk retention is not model, permissions, idle or root-control acknowledgement.
    return { seedHash: sha(body), snapshotHash: snapshot.sha256, bytes: snapshot.bytes, nativeReadiness: 'unqualified' };
  } catch (error) { return finite(error); }
}
