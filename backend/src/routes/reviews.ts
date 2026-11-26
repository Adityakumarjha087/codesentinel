import { and, asc, count, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { findings, pullRequests, repositories, reviewFiles, reviews } from '../db/schema.js';
import { notFound } from '../lib/errors.js';

const secured = [{ bearerAuth: [] }];

export const reviewRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db, queue } = app.container;
  app.addHook('preHandler', app.authenticate);

  app.get(
    '/reviews',
    {
      schema: {
        tags: ['reviews'],
        summary: 'Review history',
        security: secured,
        querystring: z.object({
          repoId: z.uuid().optional(),
          pullRequestId: z.uuid().optional(),
          status: z.enum(['queued', 'running', 'completed', 'failed', 'skipped']).optional(),
          page: z.coerce.number().int().min(1).default(1),
          pageSize: z.coerce.number().int().min(1).max(100).default(20),
        }),
      },
    },
    async (req) => {
      const { repoId, pullRequestId, status, page, pageSize } = req.query;
      const conditions: SQL[] = [];
      if (repoId) conditions.push(eq(reviews.repoId, repoId));
      if (pullRequestId) conditions.push(eq(reviews.pullRequestId, pullRequestId));
      if (status) conditions.push(eq(reviews.status, status));
      const where = conditions.length ? and(...conditions) : undefined;
      const [totalRow] = await db.select({ n: count() }).from(reviews).where(where);
      const rows = await db
        .select({ review: reviews, pr: pullRequests, repoName: repositories.fullName })
        .from(reviews)
        .innerJoin(pullRequests, eq(reviews.pullRequestId, pullRequests.id))
        .innerJoin(repositories, eq(reviews.repoId, repositories.id))
        .where(where)
        .orderBy(desc(reviews.createdAt))
        .limit(pageSize)
        .offset((page - 1) * pageSize);
      const ids = rows.map((r) => r.review.id);
      const counts = ids.length
        ? await db
            .select({ reviewId: findings.reviewId, severity: findings.severity, n: sql<number>`count(*)` })
            .from(findings)
            .where(inArray(findings.reviewId, ids))
            .groupBy(findings.reviewId, findings.severity)
        : [];
      return {
        total: Number(totalRow?.n ?? 0),
        page,
        pageSize,
        items: rows.map(({ review, pr, repoName }) => {
          const bySeverity: Record<string, number> = {};
          for (const c of counts.filter((c) => c.reviewId === review.id)) bySeverity[c.severity] = Number(c.n);
          return {
            id: review.id,
            status: review.status,
            trigger: review.trigger,
            skipReason: review.skipReason,
            createdAt: review.createdAt,
            completedAt: review.completedAt,
            durationMs: review.durationMs,
            inputTokens: review.inputTokens,
            outputTokens: review.outputTokens,
            costUsd: review.costUsd,
            model: review.model,
            filesReviewed: review.filesReviewed,
            headSha: review.headSha,
            repo: { id: review.repoId, fullName: repoName },
            pullRequest: { id: pr.id, number: pr.number, title: pr.title, author: pr.author, url: pr.url },
            findingsCount: Object.values(bySeverity).reduce((s, n) => s + n, 0),
            bySeverity,
          };
        }),
      };
    },
  );

  app.get('/reviews/:id', { schema: { tags: ['reviews'], summary: 'Review detail with files and findings', params: z.object({ id: z.uuid() }), security: secured } }, async (req) => {
    const [row] = await db
      .select({ review: reviews, pr: pullRequests, repo: repositories })
      .from(reviews)
      .innerJoin(pullRequests, eq(reviews.pullRequestId, pullRequests.id))
      .innerJoin(repositories, eq(reviews.repoId, repositories.id))
      .where(eq(reviews.id, req.params.id));
    if (!row) throw notFound('Review');
    const files = await db.select().from(reviewFiles).where(eq(reviewFiles.reviewId, row.review.id)).orderBy(asc(reviewFiles.path));
    const items = await db.select().from(findings).where(eq(findings.reviewId, row.review.id));
    const otherReviews = await db
      .select({ id: reviews.id, status: reviews.status, createdAt: reviews.createdAt, headSha: reviews.headSha })
      .from(reviews)
      .where(eq(reviews.pullRequestId, row.pr.id))
      .orderBy(desc(reviews.createdAt));
    return {
      review: row.review,
      pullRequest: row.pr,
      repository: { id: row.repo.id, fullName: row.repo.fullName, config: row.repo.config },
      files,
      findings: items.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.line - b.line),
      history: otherReviews,
    };
  });

  app.post(
    '/reviews/:id/rerun',
    { preHandler: app.requireRole('maintainer'), schema: { tags: ['reviews'], summary: 'Re-run a review on the same commit', params: z.object({ id: z.uuid() }), security: secured } },
    async (req, reply) => {
      const [existing] = await db.select().from(reviews).where(eq(reviews.id, req.params.id));
      if (!existing) throw notFound('Review');
      const [created] = await db
        .insert(reviews)
        .values({ repoId: existing.repoId, pullRequestId: existing.pullRequestId, headSha: existing.headSha, trigger: 'manual', status: 'queued' })
        .returning({ id: reviews.id });
      await queue.enqueue({ type: 'review', reviewId: created!.id });
      return reply.status(202).send({ status: 'queued', reviewId: created!.id });
    },
  );
};
