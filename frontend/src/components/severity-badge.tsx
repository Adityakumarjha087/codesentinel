import { Badge } from './ui/badge';
import type { Category, FindingStatus, ReviewStatus, Severity } from '@/lib/types';
import { CATEGORY_LABEL, SEVERITY_LABEL } from '@/lib/utils';

export function SeverityBadge({ severity }: { severity: Severity }) {
  return <Badge variant={severity}>{SEVERITY_LABEL[severity]}</Badge>;
}

export function CategoryBadge({ category }: { category: Category }) {
  return <Badge variant="outline">{CATEGORY_LABEL[category]}</Badge>;
}

const STATUS_VARIANT: Record<ReviewStatus, 'success' | 'danger' | 'warning' | 'secondary' | 'info'> = {
  completed: 'success',
  failed: 'danger',
  skipped: 'warning',
  running: 'secondary',
  queued: 'info',
};

export function ReviewStatusBadge({ status }: { status: ReviewStatus }) {
  return <Badge variant={STATUS_VARIANT[status]}>{status}</Badge>;
}

const FINDING_VARIANT: Record<FindingStatus, 'success' | 'danger' | 'secondary' | 'info'> = {
  accepted: 'success',
  rejected: 'danger',
  resolved: 'secondary',
  open: 'info',
};

export function FindingStatusBadge({ status }: { status: FindingStatus }) {
  return <Badge variant={FINDING_VARIANT[status]}>{status}</Badge>;
}
