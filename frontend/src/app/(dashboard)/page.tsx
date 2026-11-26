'use client';

import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Coins, GitPullRequest, ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { CategoryChart, CostByRepoChart, FindingsTimelineChart } from '@/components/dashboard/charts';
import { StatCard } from '@/components/dashboard/stat-card';
import { PageHeader } from '@/components/layout/app-shell';
import { ReviewsTable } from '@/components/review/reviews-table';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/input';
import { api } from '@/lib/api';
import { CATEGORY_LABEL, formatNumber, formatPercent, formatUsd } from '@/lib/utils';

export default function OverviewPage() {
  const [days, setDays] = useState(30);
  const stats = useQuery({ queryKey: ['overview', days], queryFn: () => api.overview(days) });
  const recent = useQuery({ queryKey: ['reviews', 'recent'], queryFn: () => api.reviews({ pageSize: 6 }) });

  return (
    <>
      <PageHeader
        title="Overview"
        description="Review activity, finding trends and LLM spend across connected repositories."
        actions={
          <Select aria-label="Time range" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </Select>
        }
      />
      {stats.isLoading && <LoadingState rows={4} label="Loading analytics" />}
      {stats.isError && <ErrorState error={stats.error} onRetry={() => stats.refetch()} />}
      {stats.data && (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Reviews" value={formatNumber(stats.data.reviews.total)} hint={`${stats.data.reviews.completed} completed · ${stats.data.reviews.skipped} skipped`} icon={GitPullRequest} />
            <StatCard
              label="Findings"
              value={formatNumber(stats.data.findings.total)}
              hint={`${stats.data.bySeverity.filter((s) => s.severity === 'critical' || s.severity === 'high').reduce((a, s) => a + s.count, 0)} high or critical`}
              icon={ShieldAlert}
            />
            <StatCard
              label="Acceptance rate"
              value={formatPercent(stats.data.acceptanceRate)}
              hint={`${stats.data.findings.accepted} accepted · ${stats.data.findings.rejected} dismissed`}
              icon={CheckCircle2}
            />
            <StatCard label="LLM cost" value={formatUsd(stats.data.usage.costUsd)} hint={`${formatNumber(stats.data.usage.tokens)} tokens`} icon={Coins} />
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Findings over time</CardTitle>
              <CardDescription>Daily findings stacked by severity.</CardDescription>
            </CardHeader>
            <CardContent>
              {stats.data.findings.total === 0 ? <EmptyState title="No findings in this period" /> : <FindingsTimelineChart data={stats.data.timeline} />}
            </CardContent>
          </Card>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>By category</CardTitle>
                <CardDescription>Which review pass finds the most issues.</CardDescription>
              </CardHeader>
              <CardContent>
                <CategoryChart data={stats.data.byCategory} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Cost by repository</CardTitle>
                <CardDescription>LLM spend in the selected period.</CardDescription>
              </CardHeader>
              <CardContent>
                {stats.data.usage.byRepo.length ? <CostByRepoChart data={stats.data.usage.byRepo} /> : <EmptyState title="No usage yet" />}
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-6 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader className="flex-row items-center justify-between">
                <CardTitle>Recent reviews</CardTitle>
                <Link href="/reviews" className="text-sm text-primary hover:underline">
                  View all
                </Link>
              </CardHeader>
              <CardContent>
                {recent.isLoading && <LoadingState rows={3} />}
                {recent.isError && <ErrorState error={recent.error} onRetry={() => recent.refetch()} />}
                {recent.data && (recent.data.items.length ? <ReviewsTable items={recent.data.items} /> : <EmptyState title="No reviews yet" description="Open a pull request on a connected repository." />)}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Top rules</CardTitle>
                <CardDescription>Most frequent finding types.</CardDescription>
              </CardHeader>
              <CardContent>
                <ol className="space-y-2 text-sm">
                  {stats.data.topRules.map((r) => (
                    <li key={r.ruleId} className="flex items-center justify-between gap-2">
                      <span className="truncate font-mono text-xs" title={r.ruleId}>
                        {r.ruleId}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {CATEGORY_LABEL[r.category]} · <span className="tabular-nums">{r.count}</span>
                      </span>
                    </li>
                  ))}
                </ol>
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </>
  );
}
