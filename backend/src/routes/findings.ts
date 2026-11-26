import { and, count, desc, eq, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { findings, pullRequests, repositories } from '../db/schema.js';
import { notFound } from '../lib/errors.js';

const secured = [{ bearerAuth: [] }];

export const findingRoutes: FastifyPluginAsyncZod = async (app) => {
  const { db } = app.container;
  app.addHook('preHandler', app.authenticate);

  app.get(
    '/findings',
    {
      schema: {
        tags: ['findings'],
        summary: 'Search findings',
        security: secured,
        querystring: z.object({
          repoId: z.uuid().optional(),
          category: z.enum(['bug', 'security', 'performance', 'readability']).optional(),
          severity: z.enum(['info', 'low', 'medium', 'high', 'critical']).optional(),
          status: z.enum(['open', 'accepted', 'rejected', 'resolved']).optional(),
          page: z.coerce.number().int().min(1).default(1),
          pageSize: z.coerce.number().int().min(1).max(100).default(25),
        }),
      },
    },
    async (req) => {
      const { repoId, category, severity, status, page, pageSize } = req.query;
      const conditions: SQL[] = [];
      if (repoId) conditions.push(eq(findings.repoId, repoId));
      if (category) conditions.push(eq(findings.category, category));
      if (severity) conditions.push(eq(findings.severity, severity));
      if (status) conditions.push(eq(findings.status, status));
      const where = conditions.length ? and(...conditions) : undefined;
      const [total] = await db.select({ n: count() }).from(findings).where(where);
      const rows = await db
        .select({ finding: findings, repoName: repositories.fullName, prNumber: pullRequests.number, prTitle: pullRequests.title })
        .from(findings)
        .innerJoin(repositories, eq(findings.repoId, repositories.id))
        .innerJoin(pullRequests, eq(findings.pullRequestId, pullRequests.id))
        .where(where)
        .orderBy(desc(findings.createdAt))
        .limit(pageSize)
        .offset((page - 1) * pageSize);
      return { total: Number(total?.n ?? 0), page, pageSize, items: rows.map((r) => ({ ...r.finding, repoName: r.repoName, prNumber: r.prNumber, prTitle: r.prTitle })) };
    },
  );

  app.patch(
    '/findings/:id',
    {
      preHandler: app.requireRole('maintainer'),
      schema: {
        tags: ['findings'],
        summary: 'Record feedback on a finding (accept / reject / reopen)',
        security: secured,
        params: z.object({ id: z.uuid() }),
        body: z.object({ status: z.enum(['open', 'accepted', 'rejected']) }),
      },
    },
    async (req) => {
      const [updated] = await db
        .update(findings)
        .set({ status: req.body.status, resolvedAt: req.body.status === 'open' ? null : new Date() })
        .where(eq(findings.id, req.params.id))
        .returning();
      if (!updated) throw notFound('Finding');
      return updated;
    },
  );
};
