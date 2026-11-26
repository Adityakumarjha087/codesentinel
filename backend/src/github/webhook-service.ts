import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../db/client.js';
import { installations, pullRequests, repositories, reviews, webhookDeliveries } from '../db/schema.js';
import type { Logger } from '../lib/logger.js';
import type { JobQueue } from '../queue/index.js';

const repoSchema = z.object({
  id: z.number(),
  name: z.string(),
  full_name: z.string(),
  private: z.boolean().optional().default(false),
  default_branch: z.string().optional().default('main'),
  owner: z.object({ login: z.string() }).optional(),
});

const installationSchema = z.object({
  id: z.number(),
  account: z.object({ login: z.string(), type: z.string().optional() }).optional(),
});

export const pullRequestEventSchema = z.object({
  action: z.string(),
  number: z.number().optional(),
  pull_request: z.object({
    number: z.number(),
    title: z.string(),
    html_url: z.string().optional(),
    state: z.string().optional().default('open'),
    draft: z.boolean().optional().default(false),
    user: z.object({ login: z.string() }),
    head: z.object({ sha: z.string(), ref: z.string() }),
    base: z.object({ sha: z.string(), ref: z.string() }),
  }),
  repository: repoSchema,
  installation: z.object({ id: z.number() }).optional(),
});

const installationEventSchema = z.object({
  action: z.string(),
  installation: installationSchema,
  repositories: z.array(z.object({ id: z.number(), name: z.string(), full_name: z.string(), private: z.boolean().optional() })).optional(),
  repositories_added: z.array(z.object({ id: z.number(), name: z.string(), full_name: z.string(), private: z.boolean().optional() })).optional(),
  repositories_removed: z.array(z.object({ id: z.number(), full_name: z.string() })).optional(),
});

export interface WebhookResult {
  status: 'queued' | 'ignored' | 'duplicate' | 'processed';
  reason?: string;
  reviewId?: string;
}

const REVIEW_ACTIONS = new Set(['opened', 'synchronize', 'reopened', 'ready_for_review']);

export class WebhookService {
  constructor(
    private readonly db: Database,
    private readonly queue: JobQueue,
    private readonly logger: Logger,
    private readonly defaultBudget: number,
  ) {}

  async handle(event: string, deliveryId: string | undefined, payload: unknown): Promise<WebhookResult> {
    const action = (payload as { action?: string } | null)?.action ?? null;
    if (deliveryId) {
      const inserted = await this.db
        .insert(webhookDeliveries)
        .values({ id: deliveryId, event, action, status: 'received' })
        .onConflictDoNothing()
        .returning({ id: webhookDeliveries.id });
      if (!inserted.length) return { status: 'duplicate', reason: `delivery ${deliveryId} already processed` };
    }
    let result: WebhookResult;
    try {
      switch (event) {
        case 'ping':
          result = { status: 'processed', reason: 'pong' };
          break;
        case 'pull_request':
          result = await this.onPullRequest(payload);
          break;
        case 'installation':
        case 'installation_repositories':
          result = await this.onInstallation(payload);
          break;
        default:
          result = { status: 'ignored', reason: `event ${event} is not handled` };
      }
    } catch (err) {
      if (deliveryId) await this.db.update(webhookDeliveries).set({ status: 'error', error: (err as Error).message }).where(eq(webhookDeliveries.id, deliveryId));
      throw err;
    }
    if (deliveryId) await this.db.update(webhookDeliveries).set({ status: result.status }).where(eq(webhookDeliveries.id, deliveryId));
    return result;
  }

  private async upsertInstallation(id: number, accountLogin: string, accountType = 'Organization') {
    await this.db
      .insert(installations)
      .values({ id, accountLogin, accountType })
      .onConflictDoUpdate({ target: installations.id, set: { accountLogin, suspendedAt: null } });
  }

  private async upsertRepository(repo: z.infer<typeof repoSchema>, installationId: number | null) {
    const [owner, name] = repo.full_name.split('/') as [string, string];
    const [row] = await this.db
      .insert(repositories)
      .values({
        githubId: repo.id,
        installationId,
        owner: repo.owner?.login ?? owner,
        name: repo.name ?? name,
        fullName: repo.full_name,
        private: repo.private,
        defaultBranch: repo.default_branch,
        monthlyTokenBudget: this.defaultBudget,
      })
      .onConflictDoUpdate({
        target: repositories.githubId,
        set: { fullName: repo.full_name, name: repo.name, installationId, private: repo.private, defaultBranch: repo.default_branch },
      })
      .returning();
    return row!;
  }

  private async onPullRequest(payload: unknown): Promise<WebhookResult> {
    const parsed = pullRequestEventSchema.safeParse(payload);
    if (!parsed.success) return { status: 'ignored', reason: 'malformed pull_request payload' };
    const { action, pull_request: pr, repository, installation } = parsed.data;

    if (installation) await this.upsertInstallation(installation.id, repository.owner?.login ?? repository.full_name.split('/')[0]!);
    const repo = await this.upsertRepository(repository, installation?.id ?? null);

    const prValues = {
      title: pr.title,
      author: pr.user.login,
      url: pr.html_url ?? null,
      state: action === 'closed' ? 'closed' : pr.state,
      headSha: pr.head.sha,
      baseSha: pr.base.sha,
      headRef: pr.head.ref,
      baseRef: pr.base.ref,
      updatedAt: new Date(),
    };
    const [prRow] = await this.db
      .insert(pullRequests)
      .values({ repoId: repo.id, number: pr.number, ...prValues })
      .onConflictDoUpdate({ target: [pullRequests.repoId, pullRequests.number], set: prValues })
      .returning();

    if (!REVIEW_ACTIONS.has(action)) return { status: 'ignored', reason: `action ${action} does not trigger a review` };
    if (pr.draft) return { status: 'ignored', reason: 'draft pull request' };
    if (!repo.isActive) return { status: 'ignored', reason: 'repository is paused in CodeSentinel' };

    // De-duplicate atomically: one automatic review per head commit (unique dedupe_key), safe under concurrent deliveries.
    const dedupeKey = `${prRow!.id}:${pr.head.sha}`;
    const [review] = await this.db
      .insert(reviews)
      .values({ repoId: repo.id, pullRequestId: prRow!.id, headSha: pr.head.sha, trigger: action, status: 'queued', dedupeKey })
      .onConflictDoNothing({ target: reviews.dedupeKey })
      .returning({ id: reviews.id });
    if (!review) {
      const [existing] = await this.db.select({ id: reviews.id, status: reviews.status }).from(reviews).where(eq(reviews.dedupeKey, dedupeKey));
      if (existing && existing.status === 'failed') {
        // A failed review of this commit is retried when GitHub re-delivers the event.
        await this.db.update(reviews).set({ status: 'queued', error: null }).where(and(eq(reviews.id, existing.id), eq(reviews.status, 'failed')));
        await this.queue.enqueue({ type: 'review', reviewId: existing.id });
        return { status: 'queued', reason: 'retrying failed review', reviewId: existing.id };
      }
      return { status: 'duplicate', reason: 'commit already reviewed', reviewId: existing?.id };
    }
    await this.queue.enqueue({ type: 'review', reviewId: review.id });
    this.logger.info({ repo: repo.fullName, pr: pr.number, reviewId: review.id }, 'review queued');
    return { status: 'queued', reviewId: review.id };
  }

  private async onInstallation(payload: unknown): Promise<WebhookResult> {
    const parsed = installationEventSchema.safeParse(payload);
    if (!parsed.success) return { status: 'ignored', reason: 'malformed installation payload' };
    const { action, installation } = parsed.data;
    const login = installation.account?.login ?? `installation-${installation.id}`;
    if (action === 'deleted' || action === 'suspend') {
      await this.db.update(installations).set({ suspendedAt: new Date() }).where(eq(installations.id, installation.id));
      await this.db.update(repositories).set({ isActive: false }).where(eq(repositories.installationId, installation.id));
      return { status: 'processed', reason: `installation ${action}` };
    }
    await this.upsertInstallation(installation.id, login, installation.account?.type);
    const added = [...(parsed.data.repositories ?? []), ...(parsed.data.repositories_added ?? [])];
    for (const r of added) {
      const repo = await this.upsertRepository({ ...r, private: r.private ?? false, default_branch: 'main', owner: { login: r.full_name.split('/')[0]! } }, installation.id);
      await this.queue.enqueue({ type: 'index', repoId: repo.id });
    }
    const removed = parsed.data.repositories_removed ?? [];
    if (removed.length) {
      await this.db
        .update(repositories)
        .set({ isActive: false })
        .where(inArray(repositories.githubId, removed.map((r) => r.id)));
    }
    return { status: 'processed', reason: `${added.length} repositories connected, ${removed.length} removed` };
  }
}
