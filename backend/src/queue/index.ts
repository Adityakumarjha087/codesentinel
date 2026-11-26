import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import type { Logger } from '../lib/logger.js';

export type Job = { type: 'review'; reviewId: string; attempt?: number } | { type: 'index'; repoId: string; ref?: string };
export type JobHandler = (job: Job) => Promise<void>;

export interface JobQueue {
  readonly kind: 'bullmq' | 'inline';
  enqueue(job: Job): Promise<string>;
  /** Start consuming jobs with `handler` (no-op for producers that never consume). */
  startWorker(handler: JobHandler, concurrency?: number): Promise<void>;
  /** Wait for in-flight inline jobs (tests). */
  drain(): Promise<void>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export const QUEUE_NAME = 'codesentinel-jobs';

const jobId = (job: Job) => (job.type === 'review' ? `review-${job.reviewId}${job.attempt ? `-${job.attempt}` : ''}` : `index-${job.repoId}-${job.ref ?? 'default'}-${Date.now()}`);

/** In-process queue: jobs run asynchronously on the event loop. Used for tests and single-process dev. */
export class InlineQueue implements JobQueue {
  readonly kind = 'inline' as const;
  private handler: JobHandler | null = null;
  private readonly pending = new Set<Promise<void>>();
  private readonly backlog: Job[] = [];

  constructor(private readonly logger: Logger) {}

  async enqueue(job: Job): Promise<string> {
    if (!this.handler) this.backlog.push(job);
    else this.run(job);
    return jobId(job);
  }

  private run(job: Job) {
    const p = (async () => {
      await new Promise((r) => setImmediate(r));
      try {
        await this.handler!(job);
      } catch (err) {
        this.logger.error({ err, job }, 'inline job failed');
      }
    })();
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
  }

  async startWorker(handler: JobHandler): Promise<void> {
    this.handler = handler;
    for (const job of this.backlog.splice(0)) this.run(job);
  }

  async drain(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  async ping(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    await this.drain();
  }
}

export function redisConnection(url: string): ConnectionOptions {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    username: u.username || undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    db: u.pathname.length > 1 ? Number(u.pathname.slice(1)) : 0,
    maxRetriesPerRequest: null,
  };
}

/** Durable Redis-backed queue with retries and exponential backoff. */
export class BullMqQueue implements JobQueue {
  readonly kind = 'bullmq' as const;
  private readonly queue: Queue;
  private worker: Worker | null = null;

  constructor(
    private readonly connection: ConnectionOptions,
    private readonly logger: Logger,
  ) {
    this.queue = new Queue(QUEUE_NAME, {
      connection,
      defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 5_000 }, removeOnComplete: 1000, removeOnFail: 5000 },
    });
  }

  async enqueue(job: Job): Promise<string> {
    const id = jobId(job);
    await this.queue.add(job.type, job, { jobId: id });
    return id;
  }

  async startWorker(handler: JobHandler, concurrency = 2): Promise<void> {
    this.worker = new Worker(QUEUE_NAME, async (j) => handler(j.data as Job), { connection: this.connection, concurrency });
    this.worker.on('failed', (j, err) => this.logger.error({ err, jobId: j?.id, attempts: j?.attemptsMade }, 'job failed'));
    this.worker.on('completed', (j) => this.logger.info({ jobId: j.id }, 'job completed'));
    await this.worker.waitUntilReady();
  }

  async drain(): Promise<void> {}

  async ping(): Promise<boolean> {
    try {
      await this.queue.getJobCounts('waiting');
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
  }
}
