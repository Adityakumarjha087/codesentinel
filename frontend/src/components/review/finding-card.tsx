'use client';

import { Check, X, RotateCcw } from 'lucide-react';
import type { Finding, FindingStatus } from '@/lib/types';
import { cn } from '@/lib/utils';
import { CategoryBadge, FindingStatusBadge, SeverityBadge } from '../severity-badge';
import { Button } from '../ui/button';

export interface FindingCardProps {
  finding: Finding;
  canEdit: boolean;
  active?: boolean;
  pending?: boolean;
  onSelect?: (f: Finding) => void;
  onStatus?: (f: Finding, status: Exclude<FindingStatus, 'resolved'>) => void;
}

export function FindingCard({ finding: f, canEdit, active, pending, onSelect, onStatus }: FindingCardProps) {
  return (
    <article
      data-testid="finding"
      aria-label={f.title}
      className={cn('rounded-lg border bg-card p-4 transition-shadow', active && 'ring-2 ring-ring')}
    >
      <div className="flex flex-wrap items-center gap-2">
        <SeverityBadge severity={f.severity} />
        <CategoryBadge category={f.category} />
        <FindingStatusBadge status={f.status} />
        {!f.inDiff && <span className="text-xs text-muted-foreground">outside diff</span>}
      </div>
      <h3 className="mt-2 font-medium">{f.title}</h3>
      <button type="button" className="mt-0.5 font-mono text-xs text-primary hover:underline" onClick={() => onSelect?.(f)}>
        {f.filePath}:{f.line}
        {f.symbol ? ` · ${f.symbol}` : ''}
      </button>
      <p className="mt-2 text-sm text-muted-foreground">{f.explanation}</p>
      {f.suggestion !== null && (
        <div className="mt-3">
          <p className="mb-1 text-xs font-medium text-muted-foreground">Suggested change</p>
          <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">
            {f.codeSnippet && (
              <span className="block text-red-700 line-through decoration-red-400/60 dark:text-red-300">- {f.codeSnippet}</span>
            )}
            <span className="block text-emerald-700 dark:text-emerald-300">{f.suggestion === '' ? '(delete line)' : `+ ${f.suggestion}`}</span>
          </pre>
        </div>
      )}
      <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {f.ruleId} · {Math.round(f.confidence * 100)}% confidence
        </span>
        {canEdit && (
          <div className="flex gap-1">
            {f.status === 'open' ? (
              <>
                <Button size="sm" variant="outline" disabled={pending} onClick={() => onStatus?.(f, 'accepted')} aria-label={`Accept: ${f.title}`}>
                  <Check /> Accept
                </Button>
                <Button size="sm" variant="ghost" disabled={pending} onClick={() => onStatus?.(f, 'rejected')} aria-label={`Dismiss: ${f.title}`}>
                  <X /> Dismiss
                </Button>
              </>
            ) : (
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => onStatus?.(f, 'open')} aria-label={`Reopen: ${f.title}`}>
                <RotateCcw /> Reopen
              </Button>
            )}
          </div>
        )}
      </div>
    </article>
  );
}
