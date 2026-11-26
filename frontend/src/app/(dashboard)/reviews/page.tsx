'use client';

import { useQuery } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { PageHeader } from '@/components/layout/app-shell';
import { ReviewsTable } from '@/components/review/reviews-table';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Select } from '@/components/ui/input';
import { api } from '@/lib/api';

const PAGE_SIZE = 15;

function ReviewsList() {
  const params = useSearchParams();
  const router = useRouter();
  const repoId = params.get('repoId') ?? '';
  const status = params.get('status') ?? '';
  const page = Number(params.get('page') ?? 1);
  const repos = useQuery({ queryKey: ['repos'], queryFn: () => api.repos() });
  const reviews = useQuery({
    queryKey: ['reviews', repoId, status, page],
    queryFn: () => api.reviews({ repoId: repoId || undefined, status: status || undefined, page, pageSize: PAGE_SIZE }),
    refetchInterval: (q) => (q.state.data?.items.some((r) => r.status === 'queued' || r.status === 'running') ? 2000 : false),
  });
  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== 'page') next.delete('page');
    router.push(`/reviews${next.size ? `?${next}` : ''}`);
  };
  const totalPages = reviews.data ? Math.max(1, Math.ceil(reviews.data.total / PAGE_SIZE)) : 1;

  return (
    <>
      <PageHeader
        title="Review history"
        description="Every pull request review CodeSentinel has run."
        actions={
          <>
            <Select aria-label="Filter by repository" value={repoId} onChange={(e) => setParam('repoId', e.target.value)}>
              <option value="">All repositories</option>
              {repos.data?.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.fullName}
                </option>
              ))}
            </Select>
            <Select aria-label="Filter by status" value={status} onChange={(e) => setParam('status', e.target.value)}>
              <option value="">All statuses</option>
              {['completed', 'skipped', 'failed', 'running', 'queued'].map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </>
        }
      />
      {reviews.isLoading && <LoadingState rows={6} label="Loading reviews" />}
      {reviews.isError && <ErrorState error={reviews.error} onRetry={() => reviews.refetch()} />}
      {reviews.data?.items.length === 0 && <EmptyState title="No reviews match these filters" />}
      {reviews.data && reviews.data.items.length > 0 && (
        <Card>
          <ReviewsTable items={reviews.data.items} />
          <div className="flex items-center justify-between border-t p-3 text-sm">
            <span className="text-muted-foreground">
              {reviews.data.total} reviews · page {page} of {totalPages}
            </span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setParam('page', String(page - 1))}>
                Previous
              </Button>
              <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setParam('page', String(page + 1))}>
                Next
              </Button>
            </div>
          </div>
        </Card>
      )}
    </>
  );
}

export default function ReviewsPage() {
  return (
    <Suspense fallback={<LoadingState rows={6} />}>
      <ReviewsList />
    </Suspense>
  );
}
