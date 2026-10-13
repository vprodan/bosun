import { BosunError } from '../errors.ts';

export type UpgradeReceipt = {
  schemaVersion: 1;
  id: string;
  planHash: string;
  state: 'applying' | 'ready' | 'unknown';
  sourceId: string;
  installationId: string;
  createdAt: number;
  clientsStopped: true;
  backup: string | null;
  legacyRouter?: { file: string; hash: string; backup: string; adopted: true; state: 'stopping' | 'retired' };
};
export function upgradeReceipt(value: unknown): UpgradeReceipt {
  const bad = () =>
    new BosunError('unavailable', 'Upgrade receipt unavailable; retain original files');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw bad();
  const row = value as Record<string, unknown>;
  const uuid = (v: unknown) =>
    typeof v === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v);
  const keys = [
    'schemaVersion',
    'id',
    'planHash',
    'state',
    'sourceId',
    'installationId',
    'createdAt',
    'clientsStopped',
    'backup',
    ...(Object.hasOwn(row, 'legacyRouter') ? ['legacyRouter'] : []),
  ];
  if (
    Object.keys(row).length !== keys.length ||
    Object.keys(row).some((k) => !keys.includes(k)) ||
    row.schemaVersion !== 1 ||
    typeof row.id !== 'string' ||
    !/^up_[a-f0-9]{32}$/.test(row.id) ||
    typeof row.planHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(row.planHash) ||
    !['applying', 'ready', 'unknown'].includes(String(row.state)) ||
    !uuid(row.sourceId) ||
    !uuid(row.installationId) ||
    !Number.isSafeInteger(row.createdAt) ||
    Number(row.createdAt) < 0 ||
    Number(row.createdAt) > 8640000000000000 ||
    row.clientsStopped !== true ||
    (row.backup !== null &&
      (typeof row.backup !== 'string' ||
        !row.backup.startsWith('/') ||
        row.backup.length > 4096 ||
        /[\x00-\x1f\x7f]/.test(row.backup)))
  )
    throw bad();
  if (row.legacyRouter !== undefined) {
    const router = row.legacyRouter as UpgradeReceipt['legacyRouter'];
    if (!router || typeof router !== 'object' || Array.isArray(router) || Object.keys(router).length !== 5
      || Object.keys(router).some(key => !['file', 'hash', 'backup', 'adopted', 'state'].includes(key))
      || router.adopted !== true || !['stopping', 'retired'].includes(router.state)
      || !/^[a-f0-9]{64}$/.test(router.hash) || [router.file, router.backup].some(value => typeof value !== 'string'
        || !value.startsWith('/') || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value))) throw bad();
    if (row.state === 'ready' && router.state !== 'retired') throw bad();
  }
  return row as UpgradeReceipt;
}
