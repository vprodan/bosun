import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BosunError } from '../core/errors.ts';
import { privateDirectory, readPrivateFile } from '../platform/private-file.ts';
import { toolExists } from './install-tools-native.ts';

export type OptionalToolEffect = 'install' | 'start' | 'pull';
export type OptionalToolIntent = {
  schemaVersion: 1; id: string; kind: OptionalToolEffect; target: string; startedAt: string;
};
type OptionalToolReceipt = { schemaVersion: 1; id: string; observedAt: string; evidence: string };
export type OptionalToolHistory = { directory: string; count: number; pending: OptionalToolIntent | null };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Exclusive immutable intent names serialize competing invocations without a stale lock. */
export function optionalToolHistory(artifacts: string, kind: OptionalToolEffect, target: string): OptionalToolHistory {
  privateDirectory(artifacts);
  const digest = crypto.createHash('sha256').update(target).digest('hex');
  const directory = path.join(artifacts, `optional-${kind}-${digest}`);
  if (!toolExists(directory)) return { directory, count: 0, pending: null };
  privateDirectory(directory);
  const entries = fs.readdirSync(directory);
  if (entries.length > 512 || entries.some(name => !/^\d{4}\.(intent|receipt)\.json$/.test(name)))
    throw new BosunError('unavailable', 'Optional tool receipt directory needs review');
  const intents = entries.filter(name => name.endsWith('.intent.json')).sort();
  let pending: OptionalToolIntent | null = null;
  for (let index = 0; index < intents.length; index++) {
    const stem = String(index + 1).padStart(4, '0');
    if (intents[index] !== `${stem}.intent.json`) throw new BosunError('unavailable', 'Optional tool receipt sequence needs review');
    const value: unknown = JSON.parse(readPrivateFile(path.join(directory, intents[index]!), 16384));
    if (!object(value) || value.schemaVersion !== 1 || typeof value.id !== 'string' ||
        value.kind !== kind || value.target !== target || typeof value.startedAt !== 'string')
      throw new BosunError('unavailable', 'Optional tool intent needs review');
    const intent: OptionalToolIntent = { schemaVersion: 1, id: value.id, kind, target, startedAt: value.startedAt };
    const receiptFile = path.join(directory, `${stem}.receipt.json`);
    if (!toolExists(receiptFile)) {
      if (pending || index !== intents.length - 1) throw new BosunError('unavailable', 'Optional tool unresolved intents need review');
      pending = intent;
    } else {
      const receipt: unknown = JSON.parse(readPrivateFile(receiptFile, 16384));
      if (!object(receipt) || receipt.schemaVersion !== 1 || receipt.id !== intent.id ||
          typeof receipt.observedAt !== 'string' || typeof receipt.evidence !== 'string')
        throw new BosunError('unavailable', 'Optional tool receipt needs review');
    }
  }
  if (entries.length !== intents.length * 2 - (pending ? 1 : 0)) throw new BosunError('unavailable', 'Optional tool receipt has an orphan entry');
  return { directory, count: intents.length, pending };
}
/** Presence cannot prove that an original native process/group joined. */
export function assertOptionalToolEffectsSettled(artifacts: string): void {
  privateDirectory(artifacts);
  for (const name of fs.readdirSync(artifacts)) {
    if (!name.startsWith('optional-')) continue;
    if (!/^optional-(install|start|pull)-[a-f0-9]{64}$/.test(name))
      throw new BosunError('unavailable', 'Optional tool receipt directory needs review');
    const directory = path.join(artifacts, name);
    privateDirectory(directory);
    if (!toolExists(path.join(directory, '0001.intent.json'))) {
      if (fs.readdirSync(directory).length !== 0) throw new BosunError('unavailable', 'Optional tool receipt directory needs review');
      continue;
    }
    const value: unknown = JSON.parse(readPrivateFile(path.join(directory, '0001.intent.json'), 16384));
    if (!object(value) || !['install', 'start', 'pull'].includes(String(value.kind)) || typeof value.target !== 'string')
      throw new BosunError('unavailable', 'Optional tool intent needs review');
    const kind = value.kind as OptionalToolEffect;
    const history = optionalToolHistory(artifacts, kind, value.target);
    if (history.directory !== directory) throw new BosunError('unavailable', 'Optional tool intent identity needs review');
    if (history.pending) {
      const label = kind === 'install' ? 'Ollama install' : kind === 'start' ? 'Ollama start' : 'model-pull';
      throw new BosunError('unavailable', `An unresolved ${label} intent prevents all further optional tool mutations; observed presence cannot establish original native process/group completion`);
    }
  }
}
function appendRecord(file: string, value: OptionalToolIntent | OptionalToolReceipt): void {
  privateDirectory(path.dirname(file));
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  const parent = fs.openSync(path.dirname(file), fs.constants.O_RDONLY);
  try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
}
export function beginOptionalToolEffect(artifacts: string, kind: OptionalToolEffect, target: string): OptionalToolHistory {
  assertOptionalToolEffectsSettled(artifacts);
  const history = optionalToolHistory(artifacts, kind, target);
  if (history.pending) throw new BosunError('unavailable', 'An unresolved optional tool intent prevents replay');
  if (history.count >= 256) throw new BosunError('unavailable', 'Optional tool receipt limit reached; retain history for review');
  if (!toolExists(history.directory)) {
    fs.mkdirSync(history.directory, { mode: 0o700 });
    const parent = fs.openSync(artifacts, fs.constants.O_RDONLY);
    try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
  }
  const intent: OptionalToolIntent = { schemaVersion: 1, id: crypto.randomUUID(), kind, target, startedAt: new Date().toISOString() };
  appendRecord(path.join(history.directory, `${String(history.count + 1).padStart(4, '0')}.intent.json`), intent);
  return { directory: history.directory, count: history.count + 1, pending: intent };
}
export function completeOptionalToolEffect(history: OptionalToolHistory, evidence: string): void {
  if (!history.pending) return;
  appendRecord(path.join(history.directory, `${String(history.count).padStart(4, '0')}.receipt.json`), {
    schemaVersion: 1, id: history.pending.id, observedAt: new Date().toISOString(), evidence,
  });
}
