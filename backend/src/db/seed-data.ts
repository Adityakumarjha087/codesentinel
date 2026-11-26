import { eq, inArray, sql } from 'drizzle-orm';
import type { Container } from '../container.js';
import { buildPullRequestEvent, FIXTURE_REPOSITORIES, SMOKE_TEST_PR } from '../fixtures/repos.js';
import { InlineQueue } from '../queue/index.js';
import { WebhookService } from '../github/webhook-service.js';
import { chatMessages, findings, llmUsage, pullRequests, repositories, reviews, users } from './schema.js';

export interface SeedOptions {
  reset?: boolean;
  now?: Date;
  /** Include the smoke-test PR (normally left for the webhook demo). */
  includeSmokePr?: boolean;
}

export interface SeedSummary {
  skipped: boolean;
  users: number;
  repositories: number;
  reviews: number;
  findings: number;
}

/** Small deterministic PRNG (mulberry32) so seeded demo data is stable across runs. */
export function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Seed demo data by running the real pipeline (signed-webhook equivalent -> queue -> review engine
 * with the mock GitHub gateway + offline LLM), then backdating history across the last 4 weeks.
 */
export async function seedDatabase(container: Container, opts: SeedOptions = {}): Promise<SeedSummary> {
  const { db, logger } = container;
  const now = opts.now ?? new Date();

  if (opts.reset) {
    await db.execute(
      sql`TRUNCATE chat_messages, llm_usage, findings, review_files, reviews, pull_requests, code_chunks, repositories, installations, refresh_tokens, users, webhook_deliveries CASCADE`,
    );
  }
  const [existing] = await db.select({ n: sql<number>`count(*)` }).from(repositories);
  if (Number(existing?.n ?? 0) > 0) {
    logger.info('database already seeded; skipping (use --reset to reseed)');
    return { skipped: true, users: 0, repositories: 0, reviews: 0, findings: 0 };
  }

  for (const [login, role, name] of [
    ['demo-admin', 'admin', 'Demo Admin'],
    ['maria-maint', 'maintainer', 'Maria Maintainer'],
    ['victor-view', 'viewer', 'Victor Viewer'],
  ] as const) {
    await db.insert(users).values({ login, role, name }).onConflictDoNothing();
  }

  // Run jobs in-process regardless of QUEUE_MODE so backdating happens after completion.
  const queue = new InlineQueue(logger);
  await queue.startWorker((job) => container.handleJob(job));
  const webhooks = new WebhookService(db, queue, logger, container.env.DEFAULT_MONTHLY_TOKEN_BUDGET);

  for (const repo of FIXTURE_REPOSITORIES) {
    await webhooks.handle('installation', undefined, {
      action: 'created',
      installation: { id: repo.installationId, account: { login: repo.owner, type: 'Organization' } },
      repositories: [{ id: repo.githubId, name: repo.name, full_name: `${repo.owner}/${repo.name}`, private: repo.private }],
    });
  }
  await queue.drain();

  const rand = prng(42);
  const reviewIds: { id: string; historical: boolean; index: number }[] = [];
  let index = 0;
  for (const repo of FIXTURE_REPOSITORIES) {
    const fullName = `${repo.owner}/${repo.name}`;
    for (const pr of repo.pullRequests) {
      if (!opts.includeSmokePr && fullName === SMOKE_TEST_PR.repo && pr.number === SMOKE_TEST_PR.number) continue;
      const result = await webhooks.handle('pull_request', undefined, buildPullRequestEvent(fullName, pr.number, 'opened'));
      if (result.reviewId) reviewIds.push({ id: result.reviewId, historical: Boolean(pr.historical), index: index++ });
    }
  }
  await queue.drain();

  // Spread reviews over the last 28 days: historical PRs older, open PRs within the last few days.
  for (const r of reviewIds) {
    const daysAgo = r.historical ? 4 + Math.floor(rand() * 24) : Math.floor(rand() * 3);
    const at = new Date(now.getTime() - daysAgo * 86_400_000 - Math.floor(rand() * 8 * 3_600_000));
    await db.update(reviews).set({ createdAt: at, startedAt: at, completedAt: new Date(at.getTime() + 4000), postedAt: at }).where(eq(reviews.id, r.id));
    await db.update(findings).set({ createdAt: at }).where(eq(findings.reviewId, r.id));
    await db.update(llmUsage).set({ createdAt: at }).where(eq(llmUsage.reviewId, r.id));
    if (r.historical) {
      const [review] = await db.select({ prId: reviews.pullRequestId }).from(reviews).where(eq(reviews.id, r.id));
      await db.update(pullRequests).set({ state: 'closed', createdAt: at, updatedAt: at }).where(eq(pullRequests.id, review!.prId));
      // Simulated developer feedback on merged PRs.
      const items = await db.select({ id: findings.id, suggestion: findings.suggestion }).from(findings).where(eq(findings.reviewId, r.id));
      for (const f of items) {
        const roll = rand();
        const status = f.suggestion !== null ? (roll < 0.62 ? 'accepted' : roll < 0.82 ? 'rejected' : 'open') : roll < 0.45 ? 'resolved' : roll < 0.6 ? 'rejected' : 'open';
        if (status !== 'open') await db.update(findings).set({ status, resolvedAt: at }).where(eq(findings.id, f.id));
      }
    }
  }

  // A sample PR chat conversation.
  const [chatPr] = await db
    .select({ id: pullRequests.id })
    .from(pullRequests)
    .innerJoin(repositories, eq(pullRequests.repoId, repositories.id))
    .where(sql`${repositories.fullName} = 'acme/payments-api' and ${pullRequests.number} = 101`);
  const [admin] = await db.select({ id: users.id }).from(users).where(eq(users.login, 'demo-admin'));
  if (chatPr) {
    const existingChat = await db.select({ id: chatMessages.id }).from(chatMessages).where(inArray(chatMessages.pullRequestId, [chatPr.id]));
    if (!existingChat.length) await container.chat.ask(chatPr.id, admin?.id ?? null, 'What are the most important security issues to fix first?');
  }

  const [counts] = await db
    .select({
      users: sql<number>`(select count(*) from users)`,
      repositories: sql<number>`(select count(*) from repositories)`,
      reviews: sql<number>`(select count(*) from reviews)`,
      findings: sql<number>`(select count(*) from findings)`,
    })
    .from(sql`(select 1) as one`);
  const summary = {
    skipped: false,
    users: Number(counts?.users ?? 0),
    repositories: Number(counts?.repositories ?? 0),
    reviews: Number(counts?.reviews ?? 0),
    findings: Number(counts?.findings ?? 0),
  };
  logger.info(summary, 'seed complete');
  return summary;
}
