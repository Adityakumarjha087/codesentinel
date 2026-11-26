import { and, desc, eq, gte, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { findings, llmUsage, repositories, reviews } from '../db/schema.js';
import { notFound } from '../lib/errors.js';
import { startOfMonth } from '../review/engine.js';

const idParams = z.object({ id: z.uuid() });
const secured = [{ bearerAuth: [] }];

export const repoRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db, queue } = app.container;
  app.addHook('preHandler', app.authenticate);

  app.get('/repos', { schema: { tags: ['repositories'], summary: 'Connected repositories with usage', security: secured } }, async () => {
    const month = startOfMonth();
    const repos = await db.select().from(repositories).orderBy(repositories.fullName);
    const reviewStats = await db
      .select({
        repoId: reviews.repoId,
        total: sql<number>`count(*)`,
        lastReviewAt: sql<string | null>`max(${reviews.createdAt})`,
      })
      .from(reviews)
      .groupBy(reviews.repoId);
    const findingStats = await db
      .select({ repoId: findings.repoId, open: sql<number>`count(*) filter (where ${findings.status} = 'open')`, total: sql<number>`count(*)` })
      .from(findings)
      .groupBy(findings.repoId);
    const usage = await db
      .select({
        repoId: llmUsage.repoId,
        tokens: sql<number>`coalesce(sum(${llmUsage.inputTokens} + ${llmUsage.outputTokens}), 0)`,
        cost: sql<number>`coalesce(sum(${llmUsage.costUsd}), 0)`,
      })
      .from(llmUsage)
      .where(gte(llmUsage.createdAt, month))
      .groupBy(llmUsage.repoId);
    return repos.map((r) => {
      const rs = reviewStats.find((s) => s.repoId === r.id);
      const fs = findingStats.find((s) => s.repoId === r.id);
      const us = usage.find((s) => s.repoId === r.id);
      return {
        id: r.id,
        fullName: r.fullName,
        owner: r.owner,
        name: r.name,
        private: r.private,
        isActive: r.isActive,
        defaultBranch: r.defaultBranch,
        installationId: r.installationId,
        indexedAt: r.indexedAt,
        monthlyTokenBudget: r.monthlyTokenBudget,
        reviewCount: Number(rs?.total ?? 0),
        lastReviewAt: rs?.lastReviewAt ?? null,
        openFindings: Number(fs?.open ?? 0),
        totalFindings: Number(fs?.total ?? 0),
        tokensThisMonth: Number(us?.tokens ?? 0),
        costThisMonth: Number(Number(us?.cost ?? 0).toFixed(4)),
      };
    });
  });

  app.get('/repos/:id', { schema: { tags: ['repositories'], params: idParams, security: secured } }, async (req) => {
    const [repo] = await db.select().from(repositories).where(eq(repositories.id, req.params.id));
    if (!repo) throw notFound('Repository');
    const usageByMonth = await db
      .select({
        month: sql<string>`to_char(date_trunc('month', ${llmUsage.createdAt}), 'YYYY-MM')`,
        tokens: sql<number>`sum(${llmUsage.inputTokens} + ${llmUsage.outputTokens})`,
        cost: sql<number>`sum(${llmUsage.costUsd})`,
      })
      .from(llmUsage)
      .where(eq(llmUsage.repoId, repo.id))
      .groupBy(sql`1`)
      .orderBy(sql`1`);
    const usageByPurpose = await db
      .select({ purpose: llmUsage.purpose, tokens: sql<number>`sum(${llmUsage.inputTokens} + ${llmUsage.outputTokens})`, cost: sql<number>`sum(${llmUsage.costUsd})` })
      .from(llmUsage)
      .where(and(eq(llmUsage.repoId, repo.id), gte(llmUsage.createdAt, startOfMonth())))
      .groupBy(llmUsage.purpose);
    const recent = await db.select().from(reviews).where(eq(reviews.repoId, repo.id)).orderBy(desc(reviews.createdAt)).limit(10);
    return {
      ...repo,
      usageByMonth: usageByMonth.map((u) => ({ month: u.month, tokens: Number(u.tokens), cost: Number(Number(u.cost).toFixed(4)) })),
      usageByPurpose: usageByPurpose.map((u) => ({ purpose: u.purpose, tokens: Number(u.tokens), cost: Number(Number(u.cost).toFixed(4)) })),
      recentReviews: recent.map((r) => ({ id: r.id, status: r.status, createdAt: r.createdAt, costUsd: r.costUsd })),
    };
  });

  app.patch(
    '/repos/:id',
    {
      preHandler: app.requireRole('admin'),
      schema: {
        tags: ['repositories'],
        summary: 'Update budget / pause reviews (admin)',
        params: idParams,
        body: z.object({ monthlyTokenBudget: z.number().int().min(1000).max(1_000_000_000).optional(), isActive: z.boolean().optional() }).strict(),
        security: secured,
      },
    },
    async (req) => {
      const [repo] = await db.update(repositories).set(req.body).where(eq(repositories.id, req.params.id)).returning();
      if (!repo) throw notFound('Repository');
      return repo;
    },
  );

  app.post(
    '/repos/:id/reindex',
    { preHandler: app.requireRole('maintainer'), schema: { tags: ['repositories'], summary: 'Rebuild the code embedding index', params: idParams, security: secured } },
    async (req, reply) => {
      const [repo] = await db.select({ id: repositories.id, defaultBranch: repositories.defaultBranch }).from(repositories).where(eq(repositories.id, req.params.id));
      if (!repo) throw notFound('Repository');
      const jobId = await queue.enqueue({ type: 'index', repoId: repo.id, ref: repo.defaultBranch });
      return reply.status(202).send({ status: 'queued', jobId });
    },
  );
};
