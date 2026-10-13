import fs from 'node:fs';
import path from 'node:path';
import { BosunError } from '../../../core/errors.ts';
import { privateDirectory, readPrivateFile } from '../../../platform/private-file.ts';
import { CODEX_VERSION } from './runner.ts';

const failure = () => new BosunError('unverified', 'Codex seed readback unavailable');
export type RolloutBinding = {
  file: string;
  home: string;
  cwd: string;
  id: string;
  dev: number;
  ino: number;
};
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

// Only the path returned for a newly created root. No discovery, other-session
// reads, permission repair, compressed/paginated ancestry or native writes.
export function bindRollout(input: {
  file: unknown;
  home: string;
  cwd: string;
  id: string;
}): RolloutBinding {
  try {
    const { file, home, cwd, id } = input;
    if (
      typeof file !== 'string' ||
      !path.isAbsolute(file) ||
      path.resolve(file) !== file ||
      !path.isAbsolute(home) ||
      path.resolve(home) !== home ||
      fs.realpathSync(home) !== home
    )
      throw failure();
    const root = path.join(home, 'sessions');
    const relative = path.relative(root, file);
    if (
      !relative ||
      relative.startsWith('..') ||
      path.isAbsolute(relative) ||
      relative.split(path.sep).length > 5 ||
      !path.basename(file).endsWith(`-${id}.jsonl`)
    )
      throw failure();
    for (let directory = path.dirname(file); ; directory = path.dirname(directory)) {
      privateDirectory(directory);
      if (directory === home) break;
      if (path.dirname(directory) === directory) throw failure();
    }
    const stat = fs.lstatSync(file);
    readPrivateFile(file, 1024 * 1024);
    return { file, home, cwd, id, dev: stat.dev, ino: stat.ino };
  } catch {
    throw failure();
  }
}
export function readRolloutSeed(binding: RolloutBinding, expected?: string): void {
  try {
    const before = fs.lstatSync(binding.file);
    if (before.dev !== binding.dev || before.ino !== binding.ino) throw failure();
    // Recheck every parent on each read; readPrivateFile also checks the opened
    // inode, no-follow, owner, link count, private mode, UTF-8 and byte bound.
    bindRollout(binding);
    const text = readPrivateFile(binding.file, 1024 * 1024);
    if (!text.endsWith('\n')) throw failure();
    const lines = text.slice(0, -1).split('\n');
    if (
      !lines.length ||
      lines.length > 128 ||
      lines.some((line) => !line || Buffer.byteLength(line) > 262144)
    )
      throw failure();
    let messages = 0;
    for (let index = 0; index < lines.length; index++) {
      const row: unknown = JSON.parse(lines[index]);
      if (
        !object(row) ||
        typeof row.timestamp !== 'string' ||
        !Number.isFinite(Date.parse(row.timestamp)) ||
        !object(row.payload)
      )
        throw failure();
      const payload = row.payload;
      if (index === 0) {
        if (
          row.type !== 'session_meta' ||
          payload.id !== binding.id ||
          payload.session_id !== binding.id ||
          payload.cwd !== binding.cwd ||
          payload.cli_version !== CODEX_VERSION ||
          payload.source !== 'mcp' ||
          [
            'forked_from_id',
            'parent_thread_id',
            'history_base',
            'subagent_history_start_ordinal',
          ].some((key) => payload[key] != null) ||
          payload.history_mode !== 'legacy'
        )
          throw failure();
      } else if (row.type === 'response_item') {
        if (
          expected === undefined ||
          ++messages !== 1 ||
          payload.type !== 'message' ||
          payload.role !== 'assistant' ||
          !Array.isArray(payload.content) ||
          payload.content.length !== 1 ||
          !object(payload.content[0]) ||
          payload.content[0].type !== 'output_text' ||
          payload.content[0].text !== expected ||
          row.metadata !== undefined
        )
          throw failure();
      } else throw failure(); // Any turn/history/compaction is incompatible with idle fresh seeding.
    }
    if (messages !== (expected === undefined ? 0 : 1)) throw failure();
    const after = fs.lstatSync(binding.file);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw failure();
  } catch {
    throw failure();
  }
}
