import { and, eq, gte, sql, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Database } from '../db/client.js';
import { findings, llmUsage, repositories, reviews } from '../db/schema.js';

export async function overviewStats(db: Database, opts: { days: number; repoId?: string; now?: Date }) {
  const since = new Date((opts.now ?? new Date()).getTime() - opts.days * 86_400_000);
  const fWhere: SQL[] = [gte(findings.createdAt, since)];
  const rWhere: SQL[] = [gte(reviews.createdAt, since)];
  const uWhere: SQL[] = [gte(llmUsage.createdAt, since)];
  if (opts.repoId) {
    fWhere.push(eq(findings.repoId, opts.repoId));
    rWhere.push(eq(reviews.repoId, opts.repoId));
    uWhere.push(eq(llmUsage.repoId, opts.repoId));
  }

  const [reviewTotals] = await db
    .select({
      total: sql<number>`count(*)`,
      completed: sql<number>`count(*) filter (where ${reviews.status} = 'completed')`,
      skipped: sql<number>`count(*) filter (where ${reviews.status} = 'skipped')`,
      failed: sql<number>`count(*) filter (where ${reviews.status} = 'failed')`,
      avgDurationMs: sql<number>`coalesce(avg(${reviews.durationMs}), 0)`,
    })
    .from(reviews)
    .where(and(...rWhere));

  const [findingTotals] = await db
    .select({
      total: sql<number>`count(*)`,
      withSuggestion: sql<number>`count(*) filter (where ${findings.suggestion} is not null)`,
      accepted: sql<number>`count(*) filter (where ${findings.status} = 'accepted')`,
      rejected: sql<number>`count(*) filter (where ${findings.status} = 'rejected')`,
      resolved: sql<number>`count(*) filter (where ${findings.status} = 'resolved')`,
      open: sql<number>`count(*) filter (where ${findings.status} = 'open')`,
      acceptedSuggestions: sql<number>`count(*) filter (where ${findings.status} = 'accepted' and ${findings.suggestion} is not null)`,
      decidedSuggestions: sql<number>`count(*) filter (where ${findings.status} in ('accepted', 'rejected') and ${findings.suggestion} is not null)`,
    })
    .from(findings)
    .where(and(...fWhere));

  const byCategory = await db
    .select({ category: findings.category, count: sql<number>`count(*)` })
    .from(findings)
    .where(and(...fWhere))
    .groupBy(findings.category);
  const bySeverity = await db
    .select({ severity: findings.severity, count: sql<number>`count(*)` })
    .from(findings)
    .where(and(...fWhere))
    .groupBy(findings.severity);

  const day = sql<string>`to_char(date_trunc('day', ${findings.createdAt}), 'YYYY-MM-DD')`;
  const timelineRows = await db
    .select({ day, severity: findings.severity, category: findings.category, count: sql<number>`count(*)` })
    .from(findings)
    .where(and(...fWhere))
    .groupBy(sql`1`, findings.severity, findings.category);

  const topRules = await db
    .select({ ruleId: findings.ruleId, category: findings.category, count: sql<number>`count(*)` })
    .from(findings)
    .where(and(...fWhere))
    .groupBy(findings.ruleId, findings.category)
    .orderBy(sql`count(*) desc`)
    .limit(8);

  const costByRepo = await db
    .select({
      repoId: llmUsage.repoId,
      repo: repositories.fullName,
      tokens: sql<number>`sum(${llmUsage.inputTokens} + ${llmUsage.outputTokens})`,
      cost: sql<number>`sum(${llmUsage.costUsd})`,
    })
    .from(llmUsage)
    .innerJoin(repositories, eq(llmUsage.repoId, repositories.id))
    .where(and(...uWhere))
    .groupBy(llmUsage.repoId, repositories.fullName);

  // Dense daily timeline so charts have no gaps.
  const timeline: { date: string; total: number; critical: number; high: number; medium: number; low: number; info: number; bug: number; security: number; performance: number; readability: number }[] = [];
  for (let i = opts.days - 1; i >= 0; i--) {
    const d = new Date((opts.now ?? new Date()).getTime() - i * 86_400_000).toISOString().slice(0, 10);
    timeline.push({ date: d, total: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0, bug: 0, security: 0, performance: 0, readability: 0 });
  }
  for (const r of timelineRows) {
    const point = timeline.find((t) => t.date === r.day);
    if (!point) continue;
    const n = Number(r.count);
    point.total += n;
    point[r.severity] += n;
    point[r.category] += n;
  }

  const n = (v: unknown) => Number(v ?? 0);
  const decided = n(findingTotals?.decidedSuggestions);
  const tokens = costByRepo.reduce((s, r) => s + n(r.tokens), 0);
  const cost = costByRepo.reduce((s, r) => s + n(r.cost), 0);
  return {
    days: opts.days,
    reviews: {
      total: n(reviewTotals?.total),
      completed: n(reviewTotals?.completed),
      skipped: n(reviewTotals?.skipped),
      failed: n(reviewTotals?.failed),
      avgDurationMs: Math.round(n(reviewTotals?.avgDurationMs)),
    },
    findings: {
      total: n(findingTotals?.total),
      withSuggestion: n(findingTotals?.withSuggestion),
      open: n(findingTotals?.open),
      accepted: n(findingTotals?.accepted),
      rejected: n(findingTotals?.rejected),
      resolved: n(findingTotals?.resolved),
    },
    acceptanceRate: decided ? Number((n(findingTotals?.acceptedSuggestions) / decided).toFixed(4)) : null,
    byCategory: byCategory.map((r) => ({ category: r.category, count: n(r.count) })),
    bySeverity: bySeverity.map((r) => ({ severity: r.severity, count: n(r.count) })),
    timeline,
    topRules: topRules.map((r) => ({ ruleId: r.ruleId ?? 'general', category: r.category, count: n(r.count) })),
    usage: {
      tokens,
      costUsd: Number(cost.toFixed(4)),
      byRepo: costByRepo.map((r) => ({ repoId: r.repoId, repo: r.repo, tokens: n(r.tokens), costUsd: Number(n(r.cost).toFixed(4)) })),
    },
  };
}

export const statsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/stats/overview',
    {
      preHandler: app.authenticate,
      schema: {
        tags: ['stats'],
        summary: 'Dashboard analytics: findings over time, acceptance rate, cost',
        security: [{ bearerAuth: [] }],
        querystring: z.object({ days: z.coerce.number().int().min(1).max(365).default(30), repoId: z.uuid().optional() }),
      },
    },
    async (req) => overviewStats(app.container.db, req.query),
  );
};
