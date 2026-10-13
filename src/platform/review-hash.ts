import crypto from 'node:crypto';
import { BosunError } from '../core/errors.ts';
import {
  reviewSnapshot,
  reviewRecord,
  type ReviewSnapshot,
  type ReviewRecord,
} from '../core/domain/review.ts';

const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
export function reviewRevisionHash(input: ReviewSnapshot): string {
  const snapshot = reviewSnapshot(input);
  return hash(
    JSON.stringify({
      schema: snapshot.schema,
      projectId: snapshot.projectId,
      root: snapshot.root,
      repository: snapshot.repository,
      branch: snapshot.branch,
      base: snapshot.base,
      head: snapshot.head,
      indexHash: snapshot.indexHash,
      statusHash: snapshot.statusHash,
      contentHash: snapshot.contentHash,
      files: snapshot.files,
    }),
  );
}
export function assertReviewSnapshotHash(input: ReviewSnapshot): void {
  const snapshot = reviewSnapshot(input);
  if (
    snapshot.contentHash !== hash(JSON.stringify(snapshot.files)) ||
    snapshot.revision !== reviewRevisionHash(snapshot)
  )
    throw new BosunError('unavailable', 'Review snapshot integrity unavailable');
}
export function reviewRequestHash(input: ReviewRecord): string {
  const record = reviewRecord(input);
  return hash(
    JSON.stringify({
      id: record.id,
      requestId: record.requestId,
      projectId: record.projectId,
      createdAt: record.createdAt,
      baseRef: record.baseRef,
      paths: record.paths,
      runnerId: record.runnerId,
      model: record.model,
      effort: record.effort,
      sourceHost: record.sourceHost,
      revision: record.snapshot.revision,
    }),
  );
}
export function assertReviewRequestHash(input: ReviewRecord): void {
  assertReviewSnapshotHash(input.snapshot);
  if (input.requestHash !== reviewRequestHash(input))
    throw new BosunError('unavailable', 'Review request integrity unavailable');
}
