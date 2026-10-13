import fs from 'node:fs';
import path from 'node:path';
import { BosunError } from '../core/errors.ts';
import { privateDirectory } from './private-file.ts';
import { finite, isLane, isRisk } from '../core/domain/route.ts';
import {
  observationId,
  ROUTE_REASONS,
  ROUTE_OBSERVATION_LIMITS,
  type RouteMetadata,
  type RouteLabel,
} from '../core/domain/route-observation.ts';

const unavailable = () => new BosunError('unavailable', 'Historical observations unavailable');
const absent = (error: unknown) =>
  error &&
  typeof error === 'object' &&
  Object.getOwnPropertyDescriptor(error, 'code')?.value === 'ENOENT';
const stamp = (stat: fs.BigIntStats) =>
  [stat.dev, stat.ino, stat.size, stat.mode, stat.uid, stat.nlink, stat.mtimeNs, stat.ctimeNs].join(
    ':',
  );
function readOwnedLines(
  home: string,
  name: 'route-log.jsonl' | 'route-labels.jsonl',
  maxLines: number,
) {
  privateDirectory(home);
  const file = path.join(home, name);
  let before: fs.BigIntStats;
  try {
    before = fs.lstatSync(file, { bigint: true });
  } catch (error) {
    if (absent(error))
      return {
        lines: [] as string[],
        valid: () => {
          try {
            fs.lstatSync(file);
            return false;
          } catch (later) {
            return !!absent(later);
          }
        },
      };
    throw unavailable();
  }
  if (
    !before.isFile() ||
    before.nlink !== 1n ||
    before.size > 1048576n ||
    (before.mode & 0o022n) !== 0n ||
    (process.getuid && before.uid !== BigInt(process.getuid()))
  )
    throw unavailable();
  const valid = () => {
    try {
      privateDirectory(home);
      return stamp(fs.lstatSync(file, { bigint: true })) === stamp(before);
    } catch {
      return false;
    }
  };
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    if (stamp(fs.fstatSync(fd, { bigint: true })) !== stamp(before)) throw unavailable();
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const n = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!n) throw unavailable();
      offset += n;
    }
    if (!valid() || stamp(fs.fstatSync(fd, { bigint: true })) !== stamp(before))
      throw unavailable();
    const lines = new TextDecoder('utf8', { fatal: true }).decode(bytes).split('\n');
    if (lines.length > maxLines + 1 || lines.some((line) => line.length > 16384))
      throw unavailable();
    return { lines, valid };
  } catch {
    throw unavailable();
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
function parse(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
// Explicit owner-only inspection. Original logs and labels are never copied,
// chmodded or rewritten, and remain unscoped, unverified calibration evidence.
export function readLegacyRouteLog(home: string): {
  rows: RouteMetadata[];
  labels: Map<string, RouteLabel>;
  valid(): boolean;
} {
  const log = readOwnedLines(home, 'route-log.jsonl', ROUTE_OBSERVATION_LIMITS.records);
  const feedback = readOwnedLines(home, 'route-labels.jsonl', ROUTE_OBSERVATION_LIMITS.labelEvents);
  const rows: RouteMetadata[] = [],
    labels = new Map<string, RouteLabel>();
  const seen = new Set<string>(),
    duplicates = new Set<string>();
  for (const line of log.lines) {
    const raw = parse(line);
    if (!raw) continue;
    let id: string;
    try {
      id = observationId(raw.id, true);
    } catch {
      continue;
    }
    if (seen.has(id)) {
      duplicates.add(id);
      continue;
    }
    seen.add(id);
    if (
      !isLane(raw.lane) ||
      !isRisk(raw.risk) ||
      !finite(raw.conf, 1) ||
      !finite(raw.risk_conf, 1) ||
      !finite(raw.ms, 3600000)
    )
      continue;
    rows.push({
      id,
      at: finite(raw.ts, 8640000000000) ? Math.round(raw.ts * 1000) : null,
      router: 'legacy',
      lane: raw.lane,
      conf: raw.conf,
      risk: raw.risk,
      risk_conf: raw.risk_conf,
      ms: raw.ms,
      final: isLane(raw.final) ? raw.final : null,
      why: typeof raw.why === 'string' && ROUTE_REASONS.includes(raw.why as never) ? raw.why : '',
    });
  }
  for (const line of feedback.lines) {
    const raw = parse(line);
    if (!raw || !isLane(raw.label)) continue;
    let id: string;
    try {
      id = observationId(raw.id, true);
    } catch {
      continue;
    }
    if (labels.size >= ROUTE_OBSERVATION_LIMITS.labels && !labels.has(id)) throw unavailable();
    // Old append-only corrections selected the last valid label. Version zero
    // and unknown time distinguish this read-only reference from daemon feedback.
    labels.set(id, { id, source: 'legacy', label: raw.label, version: 0, at: null });
  }
  const valid = () => log.valid() && feedback.valid();
  if (!valid()) throw unavailable();
  return { rows: rows.filter((row) => !duplicates.has(row.id)), labels, valid };
}
