import { and, inArray, lt } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { reviews } from '../db/schema.js';
import type { Logger } from '../lib/logger.js';
import type { JobQueue } from '../queue/index.js';

/**
 * Crash recovery: reviews left in queued/running (worker died, Redis flushed, deploy mid-job)
 * longer than `staleMinutes` are reset to queued and enqueued again. Engine runs are idempotent.
 */
export async function recoverStaleReviews(db: Database, queue: JobQueue, logger: Logger, staleMinutes: number, now = new Date()): Promise<string[]> {
  const cutoff = new Date(now.getTime() - staleMinutes * 60_000);
  const stale = await db
    .update(reviews)
    .set({ status: 'queued', startedAt: null })
    .where(and(inArray(reviews.status, ['queued', 'running']), lt(reviews.createdAt, cutoff)))
    .returning({ id: reviews.id });
  for (const r of stale) await queue.enqueue({ type: 'review', reviewId: r.id, attempt: Date.now() });
  if (stale.length) logger.warn({ count: stale.length }, 're-enqueued stale reviews');
  return stale.map((r) => r.id);
}
