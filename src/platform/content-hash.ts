import crypto from 'node:crypto';
import { norm } from '../core/text.ts';

// Compatible stored/content dedupe hash; this helper opens no storage or configuration.
export const contentHash = (title: string, body: string): string =>
  crypto.createHash('sha256').update(norm(`${title}\n${body}`)).digest('hex').slice(0, 32);
