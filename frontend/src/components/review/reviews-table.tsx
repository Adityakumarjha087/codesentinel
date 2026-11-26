import Link from 'next/link';
import type { ReviewListItem, Severity } from '@/lib/types';
import { formatDuration, formatNumber, formatUsd, SEVERITIES, timeAgo } from '@/lib/utils';
import { ReviewStatusBadge, SeverityBadge } from '../severity-badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';

export function ReviewsTable({ items, showRepo = true }: { items: ReviewListItem[]; showRepo?: boolean }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Pull request</TableHead>
          {showRepo && <TableHead>Repository</TableHead>}
          <TableHead>Status</TableHead>
          <TableHead>Findings</TableHead>
          <TableHead className="text-right">Tokens</TableHead>
          <TableHead className="text-right">Cost</TableHead>
          <TableHead className="text-right">Duration</TableHead>
          <TableHead className="text-right">When</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((r) => (
          <TableRow key={r.id}>
            <TableCell className="max-w-xs">
              <Link href={`/reviews/${r.id}`} className="font-medium hover:underline">
                #{r.pullRequest.number} {r.pullRequest.title}
              </Link>
              <div className="text-xs text-muted-foreground">by {r.pullRequest.author}</div>
            </TableCell>
            {showRepo && <TableCell className="whitespace-nowrap text-muted-foreground">{r.repo.fullName}</TableCell>}
            <TableCell>
              <ReviewStatusBadge status={r.status} />
            </TableCell>
            <TableCell>
              <div className="flex flex-wrap gap-1">
                {r.findingsCount === 0 && <span className="text-xs text-muted-foreground">none</span>}
                {SEVERITIES.filter((s) => r.bySeverity[s]).map((s: Severity) => (
                  <span key={s} className="inline-flex items-center gap-1">
                    <SeverityBadge severity={s} />
                    <span className="text-xs tabular-nums">{r.bySeverity[s]}</span>
                  </span>
                ))}
              </div>
            </TableCell>
            <TableCell className="text-right tabular-nums">{formatNumber(r.inputTokens + r.outputTokens)}</TableCell>
            <TableCell className="text-right tabular-nums">{formatUsd(r.costUsd)}</TableCell>
            <TableCell className="text-right tabular-nums">{formatDuration(r.durationMs)}</TableCell>
            <TableCell className="whitespace-nowrap text-right text-muted-foreground">{timeAgo(r.createdAt)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
