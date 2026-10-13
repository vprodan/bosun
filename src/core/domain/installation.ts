import { BosunError } from '../errors.ts';

export type BinaryIdentity = {
  path: string;
  dev: number;
  ino: number;
  size: number;
  mode: number;
  mtimeMs: number;
  ctimeMs: number;
  hash: string;
};
export type InstalledBefore =
  | { kind: 'file'; identity: BinaryIdentity }
  | { kind: 'link'; target: string; dev: number; ino: number };
export type InstallDirectory = {
  path: string;
  before: { dev: number; ino: number; mode: number } | null;
};
export type InstallationRoots = {
  user: { dev: number; ino: number; mode: number };
  runtime: { dev: number; ino: number; mode: number };
};
export type ServiceOperation = {
  requestId: string;
  kind: 'enable' | 'disable';
  state: 'pending' | 'succeeded' | 'unknown' | 'reconciled';
  phase: 'publish' | 'bootstrap' | 'bootstrap-ack' | 'bootout' | 'remove' | 'complete';
  at: number;
  completedAt: number | null;
  pid: number | null;
  observedState: 'enabled' | 'disabled' | null;
};
export type InstallationPlan = {
  schemaVersion: 1;
  privacy: 'public';
  id: string;
  requestId: string;
  installationId: string;
  runtimeHome: string;
  userHome: string;
  roots: InstallationRoots;
  distribution: 'managed' | 'homebrew';
  binary: BinaryIdentity;
  targetBinary: string;
  previous: InstalledBefore | null;
  directories: InstallDirectory[];
  manifestHash: string;
  configHash: string;
  version: string;
  createdAt: number;
  planHash: string;
  service: { label: string; file: string; target: string; text: string; hash: string };
};
export type InstallationReceipt = {
  id: string;
  requestId: string;
  planHash: string;
  installationId: string;
  runtimeHome: string;
  userHome: string;
  roots: InstallationRoots;
  distribution: 'managed' | 'homebrew';
  binary: BinaryIdentity;
  installed: BinaryIdentity | null;
  targetBinary: string;
  previous: InstalledBefore | null;
  directories: { path: string; dev: number; ino: number; mode: number; created: boolean }[];
  state: 'applying' | 'ready' | 'undoing' | 'undone' | 'unknown';
  version: number;
  createdAt: number;
  updatedAt: number;
  service: {
    label: string;
    file: string;
    target: string;
    hash: string;
    state: 'prepared' | 'enabling' | 'enabled' | 'disabling' | 'disabled' | 'unknown';
    owned: boolean;
    published: { dev: number; ino: number } | null;
    directories: { path: string; dev: number; ino: number; mode: number; created: boolean }[];
    operations: ServiceOperation[];
  };
};
const bad = () => new BosunError('invalid', 'Invalid installation metadata');
export function installationSelection(id: string, version: number, hash: string): void {
  if (
    !/^in_[a-f0-9]{32}$/.test(id) ||
    !Number.isSafeInteger(version) ||
    version < 1 ||
    !/^[a-f0-9]{64}$/.test(hash)
  )
    throw bad();
}
const object = (value: any, keys: string[]) => {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw bad();
};
const text = (value: unknown, max: number) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  // biome-ignore lint/suspicious/noControlCharactersInRegex: reject ASCII controls in persisted installation fields.
  !/[\x00-\x1f\x7f]/.test(value);
const absolute = (value: unknown) =>
  text(value, 4096) &&
  (value as string).startsWith('/') &&
  !(value as string)
    .split('/')
    .slice(1)
    .some((part) => !part || part === '.' || part === '..');
const int = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = (value: unknown) =>
  typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
export function binaryIdentity(value: unknown): BinaryIdentity {
  const v = value as any;
  object(v, ['path', 'dev', 'ino', 'size', 'mode', 'mtimeMs', 'ctimeMs', 'hash']);
  if (
    !absolute(v.path) ||
    !int(v.dev) ||
    !int(v.ino, 1) ||
    !int(v.size, 1, 268435456) ||
    !int(v.mode, 0, 65535) ||
    ![v.mtimeMs, v.ctimeMs].every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0) ||
    !hash(v.hash)
  )
    throw bad();
  return v;
}
function previous(value: any) {
  if (value === null) return;
  if (value?.kind === 'file') {
    object(value, ['kind', 'identity']);
    binaryIdentity(value.identity);
  } else {
    object(value, ['kind', 'target', 'dev', 'ino']);
    if (value.kind !== 'link' || !text(value.target, 4096) || !int(value.dev) || !int(value.ino, 1))
      throw bad();
  }
}
function common(v: any) {
  if (
    !/^in_[a-f0-9]{32}$/.test(v.id) ||
    !text(v.requestId, 100) ||
    !uuid(v.installationId) ||
    !absolute(v.runtimeHome) ||
    !absolute(v.userHome) ||
    !['managed', 'homebrew'].includes(v.distribution) ||
    !absolute(v.targetBinary) ||
    !hash(v.planHash) ||
    !int(v.createdAt, 0, 8640000000000000)
  )
    throw bad();
  binaryIdentity(v.binary);
  object(v.roots, ['user', 'runtime']);
  for (const root of [v.roots.user, v.roots.runtime]) {
    object(root, ['dev', 'ino', 'mode']);
    if (!int(root.dev) || !int(root.ino, 1) || !int(root.mode, 0, 65535)) throw bad();
  }
  previous(v.previous);
  if (
    !Array.isArray(v.directories) ||
    v.directories.length > 4 ||
    new Set(v.directories.map((dir: any) => dir.path)).size !== v.directories.length
  )
    throw bad();
}
function service(v: any, plan: boolean) {
  object(
    v,
    plan
      ? ['label', 'file', 'target', 'text', 'hash']
      : [
          'label',
          'file',
          'target',
          'hash',
          'state',
          'owned',
          'published',
          'directories',
          'operations',
        ],
  );
  if (
    !/^com\.bosun\.daemon\.[a-f0-9]{32}$/.test(v.label) ||
    !absolute(v.file) ||
    !absolute(v.target) ||
    !hash(v.hash)
  )
    throw bad();
  if (plan) {
    if (typeof v.text !== 'string' || v.text.length > 16384) throw bad();
  } else if (
    !['prepared', 'enabling', 'enabled', 'disabling', 'disabled', 'unknown'].includes(v.state)
  )
    throw bad();
  if (!plan) {
    if (
      typeof v.owned !== 'boolean' ||
      !Array.isArray(v.directories) ||
      v.directories.length > 2 ||
      new Set(v.directories.map((dir: any) => dir.path)).size !== v.directories.length ||
      !Array.isArray(v.operations) ||
      v.operations.length > 64 ||
      new Set(v.operations.map((op: any) => op.requestId)).size !== v.operations.length
    )
      throw bad();
    if (v.published !== null) {
      object(v.published, ['dev', 'ino']);
      if (!int(v.published.dev) || !int(v.published.ino, 1)) throw bad();
    }
    for (const dir of v.directories) {
      object(dir, ['path', 'dev', 'ino', 'mode', 'created']);
      if (
        !absolute(dir.path) ||
        !int(dir.dev) ||
        !int(dir.ino, 1) ||
        !int(dir.mode, 0, 65535) ||
        typeof dir.created !== 'boolean'
      )
        throw bad();
    }
    for (const op of v.operations) {
      object(op, [
        'requestId',
        'kind',
        'state',
        'phase',
        'at',
        'completedAt',
        'pid',
        'observedState',
      ]);
      if (
        !/^[A-Za-z0-9_-]{1,100}$/.test(op.requestId) ||
        !['enable', 'disable'].includes(op.kind) ||
        !['pending', 'succeeded', 'unknown', 'reconciled'].includes(op.state) ||
        !['publish', 'bootstrap', 'bootstrap-ack', 'bootout', 'remove', 'complete'].includes(
          op.phase,
        ) ||
        !int(op.at, 0, 8640000000000000) ||
        (op.completedAt !== null && !int(op.completedAt, op.at, 8640000000000000)) ||
        (op.pid !== null && !int(op.pid, 1, 2147483647)) ||
        (op.observedState !== null && !['enabled', 'disabled'].includes(op.observedState)) ||
        (['succeeded', 'reconciled'].includes(op.state) &&
          (op.phase !== 'complete' || op.completedAt === null || op.observedState === null))
      )
        throw bad();
    }
  }
}
export function installationPlan(value: unknown): InstallationPlan {
  const v = value as any;
  object(v, [
    'schemaVersion',
    'privacy',
    'id',
    'requestId',
    'installationId',
    'runtimeHome',
    'userHome',
    'roots',
    'distribution',
    'binary',
    'targetBinary',
    'previous',
    'directories',
    'manifestHash',
    'configHash',
    'version',
    'createdAt',
    'planHash',
    'service',
  ]);
  common(v);
  if (
    v.schemaVersion !== 1 ||
    v.privacy !== 'public' ||
    !hash(v.manifestHash) ||
    !hash(v.configHash) ||
    !/^\d+\.\d+\.\d+$/.test(v.version)
  )
    throw bad();
  for (const dir of v.directories) {
    object(dir, ['path', 'before']);
    if (!absolute(dir.path)) throw bad();
    if (dir.before !== null) {
      object(dir.before, ['dev', 'ino', 'mode']);
      if (!int(dir.before.dev) || !int(dir.before.ino, 1) || !int(dir.before.mode, 0, 65535))
        throw bad();
    }
  }
  service(v.service, true);
  return v;
}
export function installationReceipt(value: unknown): InstallationReceipt {
  const v = value as any;
  object(v, [
    'id',
    'requestId',
    'planHash',
    'installationId',
    'runtimeHome',
    'userHome',
    'roots',
    'distribution',
    'binary',
    'installed',
    'targetBinary',
    'previous',
    'directories',
    'state',
    'version',
    'createdAt',
    'updatedAt',
    'service',
  ]);
  common(v);
  if (v.installed !== null) binaryIdentity(v.installed);
  if (v.state === 'ready' && v.installed === null) throw bad();
  if (
    !['applying', 'ready', 'undoing', 'undone', 'unknown'].includes(v.state) ||
    !int(v.version, 1) ||
    !int(v.updatedAt, v.createdAt, 8640000000000000)
  )
    throw bad();
  for (const dir of v.directories) {
    object(dir, ['path', 'dev', 'ino', 'mode', 'created']);
    if (
      !absolute(dir.path) ||
      !int(dir.dev) ||
      !int(dir.ino, 1) ||
      typeof dir.created !== 'boolean' ||
      !int(dir.mode, 0, 65535)
    )
      throw bad();
  }
  service(v.service, false);
  return v;
}
