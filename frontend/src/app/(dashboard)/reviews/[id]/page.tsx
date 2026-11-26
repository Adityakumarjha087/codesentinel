'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ExternalLink, FileCode2, RotateCw } from 'lucide-react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { PageHeader } from '@/components/layout/app-shell';
import { ChatPanel } from '@/components/review/chat-panel';
import { FindingCard } from '@/components/review/finding-card';
import { ReviewStatusBadge } from '@/components/severity-badge';
import { EmptyState, ErrorState, LoadingState, Spinner } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/input';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { Category, Finding, FindingStatus, ReviewDetail, Severity } from '@/lib/types';
import { CATEGORIES, CATEGORY_LABEL, cn, formatDuration, formatNumber, formatUsd, hasRole, SEVERITIES, SEVERITY_LABEL, severityRank, timeAgo } from '@/lib/utils';

const DiffViewer = dynamic(() => import('@/components/review/diff-viewer').then((m) => m.DiffViewer), {
  ssr: false,
  loading: () => <Spinner label="Loading diff editor…" />,
});

export default function ReviewDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const router = useRouter();
  const qc = useQueryClient();
  const key = ['review', id];
  const review = useQuery({
    queryKey: key,
    queryFn: () => api.review(id),
    refetchInterval: (q) => (q.state.data && ['queued', 'running'].includes(q.state.data.review.status) ? 1500 : false),
  });
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [focusLine, setFocusLine] = useState<number | undefined>();
  const [severity, setSeverity] = useState<Severity | ''>('');
  const [category, setCategory] = useState<Category | ''>('');

  const update = useMutation({
    mutationFn: ({ f, status }: { f: Finding; status: Exclude<FindingStatus, 'resolved'> }) => api.updateFinding(f.id, status),
    onSuccess: (updated) => {
      qc.setQueryData<ReviewDetail>(key, (prev) => (prev ? { ...prev, findings: prev.findings.map((f) => (f.id === updated.id ? { ...f, status: updated.status } : f)) } : prev));
      void qc.invalidateQueries({ queryKey: ['overview'] });
    },
  });
  const rerun = useMutation({ mutationFn: () => api.rerunReview(id), onSuccess: ({ reviewId }) => router.push(`/reviews/${reviewId}`) });

  const data = review.data;
  const reviewedFiles = useMemo(() => data?.files.filter((f) => !f.skippedReason) ?? [], [data]);
  const activePath = selectedPath ?? reviewedFiles[0]?.path ?? null;
  const activeFile = reviewedFiles.find((f) => f.path === activePath);
  const findings = useMemo(
    () =>
      (data?.findings ?? [])
        .filter((f) => (!severity || f.severity === severity) && (!category || f.category === category))
        .sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || a.filePath.localeCompare(b.filePath) || a.line - b.line),
    [data, severity, category],
  );

  if (review.isLoading) return <LoadingState rows={6} label="Loading review" />;
  if (review.isError) return <ErrorState error={review.error} onRetry={() => review.refetch()} />;
  if (!data) return null;
  const { review: r, pullRequest: pr, repository } = data;
  const canEdit = hasRole(user?.role, 'maintainer');
  const select = (f: Finding) => {
    setSelectedPath(f.filePath);
    setFocusLine(f.line);
  };

  return (
    <>
      <Link href="/reviews" className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden /> All reviews
      </Link>
      <PageHeader
        title={`#${pr.number} ${pr.title}`}
        description={`${repository.fullName} · ${pr.headRef} → ${pr.baseRef} · by ${pr.author}`}
        actions={
          <>
            {pr.url && (
              <Button asChild variant="outline" size="sm">
                <a href={pr.url} target="_blank" rel="noreferrer">
                  <ExternalLink /> GitHub
                </a>
              </Button>
            )}
            {canEdit && (
              <Button size="sm" variant="outline" onClick={() => rerun.mutate()} disabled={rerun.isPending}>
                <RotateCw /> Re-run review
              </Button>
            )}
          </>
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm" data-testid="review-meta">
        <ReviewStatusBadge status={r.status} />
        <span>
          <span className="text-muted-foreground">Findings</span> <strong className="tabular-nums">{data.findings.length}</strong>
        </span>
        <span>
          <span className="text-muted-foreground">Files</span> {r.filesReviewed} reviewed, {r.filesSkipped.length} skipped
        </span>
        <span>
          <span className="text-muted-foreground">Tokens</span> {formatNumber(r.inputTokens + r.outputTokens)}
        </span>
        <span>
          <span className="text-muted-foreground">Cost</span> {formatUsd(r.costUsd)}
        </span>
        <span>
          <span className="text-muted-foreground">Duration</span> {formatDuration(r.durationMs)}
        </span>
        <span className="text-muted-foreground">
          {r.model} · {timeAgo(r.createdAt)}
        </span>
      </div>

      {(r.status === 'queued' || r.status === 'running') && (
        <Card className="mb-6 p-6">
          <Spinner label={`Review ${r.status}… passes: bugs, security, performance, readability`} />
        </Card>
      )}
      {r.status === 'skipped' && r.skipReason && (
        <div role="status" className="mb-6 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
          Review skipped: {r.skipReason}
        </div>
      )}
      {r.error && (
        <div role="alert" className="mb-6 rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-100">
          {r.error}
        </div>
      )}

      {reviewedFiles.length > 0 && (
        <Card className="mb-6">
          <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
            <CardTitle>Diff with AI comments</CardTitle>
            <div className="flex flex-wrap gap-1" role="tablist" aria-label="Changed files">
              {reviewedFiles.map((f) => {
                const count = data.findings.filter((x) => x.filePath === f.path).length;
                return (
                  <button
                    key={f.id}
                    role="tab"
                    aria-selected={f.path === activePath}
                    onClick={() => {
                      setSelectedPath(f.path);
                      setFocusLine(undefined);
                    }}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 font-mono text-xs',
                      f.path === activePath ? 'border-primary bg-secondary text-secondary-foreground' : 'hover:bg-accent',
                    )}
                  >
                    <FileCode2 className="size-3.5" aria-hidden />
                    {f.path}
                    <span className="text-emerald-600">+{f.additions}</span>
                    <span className="text-red-600">-{f.deletions}</span>
                    {count > 0 && <Badge variant="secondary">{count}</Badge>}
                  </button>
                );
              })}
            </div>
          </CardHeader>
          <CardContent>
            {activeFile && <DiffViewer file={activeFile} findings={data.findings.filter((f) => f.filePath === activeFile.path && f.inDiff)} focusLine={focusLine} />}
            {r.filesSkipped.length > 0 && (
              <details className="mt-3 text-sm">
                <summary className="cursor-pointer text-muted-foreground">{r.filesSkipped.length} skipped file(s)</summary>
                <ul className="mt-2 space-y-1">
                  {r.filesSkipped.map((s) => (
                    <li key={s.path}>
                      <code className="font-mono text-xs">{s.path}</code> <span className="text-muted-foreground">— {s.reason}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-5">
        <section className="space-y-3 lg:col-span-3" aria-labelledby="findings-heading">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="findings-heading" className="text-lg font-semibold">
              Findings
            </h2>
            <div className="flex gap-2">
              <Select aria-label="Filter by severity" value={severity} onChange={(e) => setSeverity(e.target.value as Severity | '')}>
                <option value="">All severities</option>
                {SEVERITIES.map((s) => (
                  <option key={s} value={s}>
                    {SEVERITY_LABEL[s]}
                  </option>
                ))}
              </Select>
              <Select aria-label="Filter by category" value={category} onChange={(e) => setCategory(e.target.value as Category | '')}>
                <option value="">All categories</option>
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_LABEL[c]}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          {findings.length === 0 ? (
            <EmptyState title={data.findings.length ? 'No findings match these filters' : 'No findings'} description={data.findings.length ? undefined : 'CodeSentinel did not report any issues for this pull request.'} />
          ) : (
            findings.map((f) => (
              <FindingCard
                key={f.id}
                finding={f}
                canEdit={canEdit}
                active={f.filePath === activePath && f.line === focusLine}
                pending={update.isPending && update.variables?.f.id === f.id}
                onSelect={select}
                onStatus={(finding, status) => update.mutate({ f: finding, status })}
              />
            ))
          )}
          {r.summary && (
            <Card>
              <CardHeader>
                <CardTitle>Summary comment posted to GitHub</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm [&_table]:my-2 [&_td]:px-2 [&_th]:px-2 [&_th]:text-left [&_ul]:list-disc [&_ul]:pl-5 [&_h2]:font-semibold">
                <ReactMarkdown>{r.summary}</ReactMarkdown>
              </CardContent>
            </Card>
          )}
        </section>
        <aside className="lg:col-span-2">
          <ChatPanel pullRequestId={pr.id} />
        </aside>
      </div>
    </>
  );
}
