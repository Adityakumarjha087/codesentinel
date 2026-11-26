'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { BudgetMeter } from '@/components/dashboard/budget-meter';
import { PageHeader } from '@/components/layout/app-shell';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { Repo } from '@/lib/types';
import { formatUsd, hasRole, timeAgo } from '@/lib/utils';

function BudgetEditor({ repo }: { repo: Repo }) {
  const qc = useQueryClient();
  const [value, setValue] = useState(String(repo.monthlyTokenBudget));
  const save = useMutation({
    mutationFn: () => api.updateRepo(repo.id, { monthlyTokenBudget: Number(value) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['repos'] }),
  });
  return (
    <form
      className="flex items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <label className="sr-only" htmlFor={`budget-${repo.id}`}>
        Monthly token budget for {repo.fullName}
      </label>
      <Input id={`budget-${repo.id}`} type="number" min={1000} step={1000} className="h-8 w-32" value={value} onChange={(e) => setValue(e.target.value)} />
      <Button size="sm" variant="outline" type="submit" disabled={save.isPending || Number(value) === repo.monthlyTokenBudget}>
        Save
      </Button>
      {save.isError && <span className="text-xs text-red-600">{(save.error as Error).message}</span>}
    </form>
  );
}

export default function ReposPage() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const repos = useQuery({ queryKey: ['repos'], queryFn: () => api.repos() });
  const toggle = useMutation({
    mutationFn: (r: Repo) => api.updateRepo(r.id, { isActive: !r.isActive }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['repos'] }),
  });
  const reindex = useMutation({ mutationFn: (r: Repo) => api.reindexRepo(r.id), onSuccess: () => qc.invalidateQueries({ queryKey: ['repos'] }) });
  const isAdmin = hasRole(user?.role, 'admin');

  return (
    <>
      <PageHeader title="Repositories" description="Repositories where the CodeSentinel GitHub App is installed, with token budgets and cost this month." />
      {repos.isLoading && <LoadingState rows={3} label="Loading repositories" />}
      {repos.isError && <ErrorState error={repos.error} onRetry={() => repos.refetch()} />}
      {repos.data?.length === 0 && <EmptyState title="No repositories connected" description="Install the GitHub App on a repository to start reviewing pull requests." />}
      {repos.data && repos.data.length > 0 && (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Repository</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Reviews</TableHead>
                <TableHead className="text-right">Open findings</TableHead>
                <TableHead>Token budget (month)</TableHead>
                <TableHead className="text-right">Cost (month)</TableHead>
                <TableHead>Index</TableHead>
                {isAdmin && <TableHead>Budget</TableHead>}
                <TableHead className="sr-only">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {repos.data.map((r) => (
                <TableRow key={r.id} data-testid="repo-row">
                  <TableCell>
                    <Link href={`/reviews?repoId=${r.id}`} className="inline-flex items-center gap-1 font-medium hover:underline">
                      {r.fullName}
                      {r.private && <Lock className="size-3 text-muted-foreground" aria-label="private" />}
                    </Link>
                    <div className="text-xs text-muted-foreground">last review {timeAgo(r.lastReviewAt)}</div>
                  </TableCell>
                  <TableCell>{r.isActive ? <Badge variant="success">active</Badge> : <Badge variant="warning">paused</Badge>}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.reviewCount}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.openFindings}</TableCell>
                  <TableCell>
                    <BudgetMeter used={r.tokensThisMonth} budget={r.monthlyTokenBudget} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatUsd(r.costThisMonth)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{r.indexedAt ? `indexed ${timeAgo(r.indexedAt)}` : 'not indexed'}</TableCell>
                  {isAdmin && (
                    <TableCell>
                      <BudgetEditor repo={r} />
                    </TableCell>
                  )}
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      {hasRole(user?.role, 'maintainer') && (
                        <Button size="sm" variant="ghost" onClick={() => reindex.mutate(r)} disabled={reindex.isPending} aria-label={`Re-index ${r.fullName}`}>
                          <RefreshCw /> Re-index
                        </Button>
                      )}
                      {isAdmin && (
                        <Button size="sm" variant="ghost" onClick={() => toggle.mutate(r)} disabled={toggle.isPending}>
                          {r.isActive ? 'Pause' : 'Resume'}
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </>
  );
}
