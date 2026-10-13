import crypto from 'node:crypto';
import { BosunError } from '../core/errors.ts';
import { cardRecord, cardBinding, type CardRecord } from '../core/domain/card.ts';

export const cardTextHash = (text: string) =>
  crypto.createHash('sha256').update(text).digest('hex');
export function cardRequestHash(
  record: Pick<CardRecord, 'id' | 'requestId' | 'projectId' | 'binding' | 'status' | 'commentHash'>,
): string {
  return cardTextHash(
    JSON.stringify([
      record.id,
      record.requestId,
      record.projectId,
      cardBinding(record.binding),
      record.status,
      record.commentHash,
    ]),
  );
}
export function assertCardHash(input: CardRecord) {
  const record = cardRecord(input);
  if (cardRequestHash(record) !== record.requestHash)
    throw new BosunError('conflict', 'Card intent fingerprint changed');
}
