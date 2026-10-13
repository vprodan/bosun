import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SqliteDatabase } from '../../platform/sqlite.ts'
import { memorySqliteRuntime } from '../../platform/sqlite-runtime.ts';
import { realpathWithoutOpen } from '../../platform/canonical-path.cjs';
import { BosunError } from '../../core/errors.ts';
import { vectorBytes, normalizedVector } from '../../core/embeddings.ts';

export type SqliteVecSelection = { file: string; sha256: string; version: '0.1.9' };
export type SqliteVecDistance = {
  score(query: readonly number[], candidate: readonly number[]): number;
  close(): void;
};
type NativeDistanceDatabase = Pick<
  SqliteDatabase,
  'loadExtension' | 'enableLoadExtension' | 'prepare' | 'close'
>;
// Trusted fixture composition can supply the native protocol without loading a
// library. No configuration/RPC method can override this constructor or runtime.
export type SqliteVecOpen = () => NativeDistanceDatabase;
const unavailable = () => new BosunError('unverified', 'Selected sqlite-vec distance unavailable');
function identity(selected: SqliteVecSelection) {
  const file = selected.file;
  if (
    !path.isAbsolute(file) ||
    path.resolve(file) !== file ||
    path.basename(file) !== 'vec0.dylib' ||
    realpathWithoutOpen(file) !== file ||
    selected.version !== '0.1.9' ||
    !/^[a-f0-9]{64}$/.test(selected.sha256)
  )
    throw unavailable();
  const parent = fs.lstatSync(path.dirname(file)),
    stat = fs.lstatSync(file),
    uid = process.getuid?.();
  if (
    !parent.isDirectory() ||
    realpathWithoutOpen(path.dirname(file)) !== path.dirname(file) ||
    (parent.mode & 0o022) !== 0 ||
    !stat.isFile() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o6022) !== 0 ||
    stat.size < 32 ||
    stat.size > 16 * 1024 * 1024 ||
    (uid !== undefined &&
      ((stat.uid !== 0 && stat.uid !== uid) || (parent.uid !== 0 && parent.uid !== uid)))
  )
    throw unavailable();
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino) throw unavailable();
    const bytes = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const n = fs.readSync(fd, bytes, size, bytes.length - size, null);
      if (!n) break;
      size += n;
    }
    const after = fs.fstatSync(fd);
    if (
      size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs ||
      bytes.readUInt32LE(0) !== 0xfeedfacf ||
      bytes.readUInt32LE(4) !== 0x0100000c ||
      bytes.readUInt32LE(12) !== 6 ||
      crypto.createHash('sha256').update(bytes.subarray(0, size)).digest('hex') !== selected.sha256
    )
      throw unavailable();
    return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs];
  } finally {
    fs.closeSync(fd);
  }
}
// One disposable in-memory connection contains only eligible float32 vectors.
// No authority DB, virtual index, hook connection, installation or file writes.
// null is explicit lexical degradation; it never selects reference ranking.
export function openSqliteVecDistance(
  selected: SqliteVecSelection,
  open?: SqliteVecOpen,
): SqliteVecDistance | null {
  if (!memorySqliteRuntime()) return null;
  let db: NativeDistanceDatabase | undefined,
    closed = false;
  try {
    const captured = { file: selected.file, sha256: selected.sha256, version: selected.version };
    const before = identity(captured);
    db = open ? open() : new SqliteDatabase(':memory:', { allowExtension: true, defensive: true });
    db.loadExtension(captured.file);
    db.enableLoadExtension(false);
    if (
      JSON.stringify(identity(captured)) !== JSON.stringify(before) ||
      db.prepare('SELECT vec_version() AS version').get()?.version !== 'v0.1.9'
    )
      throw unavailable();
    const distance = db.prepare('SELECT vec_distance_cosine(?, ?) AS distance');
    function score(query: readonly number[], candidate: readonly number[]) {
      try {
        if (closed || query.length !== candidate.length) throw unavailable();
        const a = normalizedVector(query, query.length),
          b = normalizedVector(candidate, query.length);
        const value = distance.get(vectorBytes(a), vectorBytes(b))?.distance;
        if (
          typeof value !== 'number' ||
          !Number.isFinite(value) ||
          value < -1e-6 ||
          value > 2 + 1e-6
        )
          throw unavailable();
        return Math.max(-1, Math.min(1, 1 - value));
      } catch {
        throw unavailable();
      }
    }
    if (
      Math.abs(score([1, 0], [1, 0]) - 1) > 1e-6 ||
      Math.abs(score([1, 0], [0, 1])) > 1e-6 ||
      Math.abs(score([1, 0], [-1, 0]) + 1) > 1e-6
    )
      throw unavailable();
    return {
      score,
      close() {
        if (!closed) {
          closed = true;
          try {
            db!.close();
          } catch {
            throw unavailable();
          }
        }
      },
    };
  } catch {
    try {
      db?.close();
    } catch {
      throw unavailable();
    }
    return null;
  }
}
